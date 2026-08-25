import type { EventEmitter } from 'eventemitter3';
import type { DigitalRadioEngineEvents, ModeDescriptor } from '@tx5dr/contracts';
import type { ClockSourceSystem } from '@tx5dr/core';
import type { AudioStreamManager } from '../audio/AudioStreamManager.js';
import type { AudioMixer, MixedAudio } from '../audio/AudioMixer.js';
import type { SpectrumScheduler } from '../audio/SpectrumScheduler.js';
import { TransmissionTracker, TransmissionPhase } from '../transmission/TransmissionTracker.js';
import type { WSJTXEncodeWorkQueue, EncodeRequest } from '../decode/WSJTXEncodeWorkQueue.js';
import type { RadioOperatorManager } from '../operator/RadioOperatorManager.js';
import type { DigitalFrameCoordinator } from '../transmission/DigitalFrameCoordinator.js';
import {
  PhysicalTxBusyError,
  PhysicalTxPreparationError,
  type PhysicalTxCoordinator,
} from '../transmission/PhysicalTxCoordinator.js';
import type { PhysicalTxSnapshot } from '../transmission/TransmissionIntent.js';
import type { OperatorIntentCoordinator } from '../transmission/OperatorIntentCoordinator.js';
import { ListenerManager } from './ListenerManager.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('TransmissionPipeline');
const DIGITAL_TAIL_HOLD_MS = 500;

class CompleteFrameBudgetExceededError extends Error {
  constructor(message = 'complete frame no longer fits before PTT start') {
    super(message);
    this.name = 'CompleteFrameBudgetExceededError';
  }
}

export interface TransmissionPipelineDeps {
  engineEmitter: EventEmitter<DigitalRadioEngineEvents>;
  audioMixer: AudioMixer;
  audioStreamManager: AudioStreamManager;
  spectrumScheduler: SpectrumScheduler;
  transmissionTracker: TransmissionTracker;
  encodeQueue: WSJTXEncodeWorkQueue;
  operatorManager: RadioOperatorManager;
  digitalFrameCoordinator: DigitalFrameCoordinator;
  physicalTxCoordinator: PhysicalTxCoordinator;
  intentCoordinator: OperatorIntentCoordinator;
  clockSource: ClockSourceSystem;
  getCurrentMode: () => ModeDescriptor;
  getCompensationMs: () => number;
  onBeforeStartPTT?: () => Promise<void>;
  validateDigitalFrameStart?: (operatorIds: readonly string[]) => void;
}

/**
 * Adapts existing encode and mixer events to the digital-frame and physical-TX
 * lifecycle owners. It does not own PTT state or decide whether to truncate RF.
 */
export class TransmissionPipeline {
  private readonly lm = new ListenerManager();
  private readonly terminalOperatorsByFrame = new Map<string, Set<string>>();
  private readonly onAirTransmissionKeys = new Set<string>();
  private operatorRemovalTransition: Promise<void> = Promise.resolve();

  constructor(private readonly deps: TransmissionPipelineDeps) {}

  getIsPTTActive(): boolean {
    return this.deps.physicalTxCoordinator.getSnapshot().phase !== 'idle';
  }

  setup(): void {
    const { encodeQueue, audioMixer, physicalTxCoordinator } = this.deps;

    this.lm.listen(encodeQueue, 'encodeComplete', async (result: {
      operatorId: string;
      streamId?: string;
      trackId?: string;
      audioData: Float32Array;
      sampleRate: number;
      duration: number;
      request?: EncodeRequest;
    }) => {
      await this.handleEncodeComplete(result);
    });
    this.lm.listen(encodeQueue, 'encodeError', (error: Error, request: EncodeRequest) => {
      this.handleEncodeError(error, request);
    });
    this.lm.listen(audioMixer, 'mixedAudioReady', async (mixedAudio: MixedAudio) => {
      await this.handleMixedAudioReady(mixedAudio);
    });
    this.lm.listen(physicalTxCoordinator, 'phaseChanged', (snapshot: PhysicalTxSnapshot) => {
      this.handlePhysicalPhaseChanged(snapshot);
    });
    this.lm.listen(this.deps.digitalFrameCoordinator, 'frameChanged', (frame) => {
      if (frame.phase === 'committed' || frame.phase === 'on_air' || frame.phase === 'draining') {
        this.deps.audioMixer.retainFrame(frame.frameId, frame.revision);
      }
      if (frame.phase === 'cancelled') {
        this.deps.audioMixer.clearFrame(frame.frameId, frame.revision);
      } else if (frame.phase === 'terminal') {
        this.deps.audioMixer.releaseFrame(frame.frameId, frame.revision);
        this.deps.audioMixer.clearFrame(frame.frameId, frame.revision);
      }
    });

    logger.info(`event listeners registered (${this.lm.count})`);
  }

  teardown(): void {
    this.lm.disposeAll();
    logger.info('event listeners cleaned up');
  }

  async onSlotStart(slotInfo?: { id: string }): Promise<void> {
    if (slotInfo) {
      this.deps.digitalFrameCoordinator.cancelPreCommitFramesOutsideSlot(
        slotInfo.id,
        'pre-commit frame expired at slot boundary',
      );
    }
    const physical = this.deps.physicalTxCoordinator.getSnapshot();
    if (physical.phase === 'idle') {
      this.deps.audioMixer.clearSlotCache();
      return;
    }
    logger.debug('preserving in-flight physical frame across slot boundary', {
      leaseId: physical.leaseId,
      frameId: physical.frameId,
      phase: physical.phase,
    });
  }

  onEncodeStart(slotInfo: { id: string; startMs?: number }): void {
    this.deps.operatorManager.processPendingTransmissions(slotInfo);
  }

  onTransmitStart(slotInfo: { id: string }): void {
    logger.debug('nominal transmit boundary reached', { slotId: slotInfo.id });
  }

  async forceStopPTT(): Promise<void> {
    await this.deps.physicalTxCoordinator.forceInterrupt('force stop PTT');
  }

  async forceStopTransmission(): Promise<void> {
    await this.deps.physicalTxCoordinator.forceInterrupt('manual force stop transmission');
    this.deps.audioMixer.clearSlotCache();
  }

  async removeOperatorFromTransmission(
    operatorId: string,
    options: {
      commandAlreadyAllocated?: boolean;
      signal?: AbortSignal;
      commandToken?: import('../transmission/OperatorIntentCoordinator.js').OperatorCommandToken;
    } = {},
  ): Promise<void> {
    if (!options.commandAlreadyAllocated) {
      const outcome = await this.deps.intentCoordinator.submit(
        operatorId,
        'manual',
        async (token, signal) => {
          if (signal.aborted || !this.deps.intentCoordinator.isCurrent(token)) return;
          this.deps.operatorManager.getOperatorById(operatorId)?.stop();
          this.deps.operatorManager.releaseTargetReservation(operatorId);
          await this.removeOperatorFromTransmission(operatorId, {
            commandAlreadyAllocated: true,
            signal,
            commandToken: token,
          });
        },
      );
      if (outcome.status === 'superseded') {
        logger.info('operator removal superseded by a newer command', { operatorId });
      }
      return;
    }

    const previous = this.operatorRemovalTransition;
    let releaseTransition!: () => void;
    const current = new Promise<void>((resolve) => { releaseTransition = resolve; });
    this.operatorRemovalTransition = previous.then(() => current, () => current);
    await previous.catch(() => undefined);
    if (!this.isRemovalCommandCurrent(options)) {
      releaseTransition();
      return;
    }
    let released = false;
    const releaseOnce = () => {
      if (released) return;
      released = true;
      releaseTransition();
    };
    try {
      await this.performOperatorRemoval(operatorId, releaseOnce, options);
    } finally {
      releaseOnce();
    }
  }

  private async performOperatorRemoval(
    operatorId: string,
    onTransitionCommitted: () => void,
    command: {
      signal?: AbortSignal;
      commandToken?: import('../transmission/OperatorIntentCoordinator.js').OperatorCommandToken;
    },
  ): Promise<void> {
    if (!this.isRemovalCommandCurrent(command)) return;
    const physical = this.deps.physicalTxCoordinator.getSnapshot();
    if (physical.source !== 'digital'
      || !physical.frameId
      || !physical.leaseId
      || !physical.operatorIds.includes(operatorId)) {
      const outcome = this.deps.operatorManager.requestStrategyStop(
        operatorId,
        'operator removed from transmission',
      );
      logger.info('operator transmission stop requested', { operatorId, outcome });
      return;
    }

    const removal = this.deps.digitalFrameCoordinator.prepareParticipantRemoval(
      physical.frameId,
      operatorId,
      'operator explicitly removed from active transmission',
    );
    if (!this.isRemovalCommandCurrent(command)) {
      if (removal.frame) {
        this.deps.digitalFrameCoordinator.cancelFrame(
          removal.frame.frameId,
          'participant removal superseded before physical handover',
        );
      }
      return;
    }
    if (removal.action === 'stop-physical') {
      await this.deps.physicalTxCoordinator.forceInterruptLease(
        physical.leaseId,
        'last operator explicitly removed from transmission',
      );
      logger.info('last digital frame participant removed; physical PTT stopped', {
        operatorId,
        frameId: physical.frameId,
      });
      return;
    }
    if (removal.action !== 'replace-current' || !removal.frame || !removal.replacedFrame) {
      logger.info('operator removal did not replace active audio', {
        operatorId,
        frameId: physical.frameId,
        outcome: removal.action,
        reason: removal.reason,
      });
      return;
    }

    const replacementSnapshot = this.deps.audioMixer.cloneFrameTracks(
      {
        frameId: removal.replacedFrame.frameId,
        frameRevision: removal.replacedFrame.revision,
      },
      {
        frameId: removal.frame.frameId,
        frameRevision: removal.frame.revision,
        slotId: removal.frame.slotId,
      },
      removal.remainingTrackIds,
    );
    const expected = [...removal.remainingTrackIds].sort();
    const actual = replacementSnapshot
      ? Array.from(replacementSnapshot.tracks.keys()).sort()
      : [];
    if (actual.length !== expected.length
      || actual.some((id, index) => id !== expected[index])) {
      const reason = 'retained operator audio is unavailable for active-frame removal';
      this.deps.operatorManager.deferPreparedFrameToNextSlot(removal.frame.frameId, reason);
      logger.warn(reason, {
        operatorId,
        frameId: physical.frameId,
        expected,
        actual,
      });
      return;
    }

    const offsetMs = this.deps.digitalFrameCoordinator.getPlaybackOffsetMs(
      removal.frame.frameId,
      this.deps.clockSource.now(),
    );
    const remixed = replacementSnapshot
      ? await this.deps.audioMixer.mixFrame(replacementSnapshot, offsetMs)
      : null;
    if (!this.isRemovalCommandCurrent(command)) {
      this.deps.digitalFrameCoordinator.cancelFrame(
        removal.frame.frameId,
        'participant removal superseded after remix',
      );
      return;
    }
    if (!remixed) {
      const reason = 'no retained operator waveform remains after participant removal';
      this.deps.operatorManager.deferPreparedFrameToNextSlot(removal.frame.frameId, reason);
      logger.info(reason, { operatorId, frameId: physical.frameId });
      return;
    }
    await this.handleMixedAudioReady(remixed, onTransitionCommitted);
  }

  private isRemovalCommandCurrent(command: {
    signal?: AbortSignal;
    commandToken?: import('../transmission/OperatorIntentCoordinator.js').OperatorCommandToken;
  }): boolean {
    return !command.signal?.aborted
      && (!command.commandToken || this.deps.intentCoordinator.isCurrent(command.commandToken));
  }

  private handleEncodeError(error: Error, request: EncodeRequest): void {
    logger.error('frame encode failed', {
      frameId: request.frameId,
      operatorId: request.operatorId,
      streamId: request.streamId,
      error: error.message,
    });
    if (!request.frameId || request.frameRevision === undefined || request.decisionEpoch === undefined) return;
    const failedFrame = this.deps.digitalFrameCoordinator.failEncodeResult({
      frameId: request.frameId,
      operatorId: request.operatorId,
      streamId: request.streamId,
      decisionEpoch: request.decisionEpoch,
      revision: request.frameRevision,
    }, 'encode failed');
    if (!failedFrame) return;
    this.emitFrameTerminal(failedFrame.frameId, failedFrame.participantOperatorIds, {
      physicalConfirmed: false,
      terminalReason: 'encode failed',
      success: false,
      error: error.message,
    });
  }

  private async handleEncodeComplete(result: {
    operatorId: string;
    streamId?: string;
    trackId?: string;
    audioData: Float32Array;
    sampleRate: number;
    duration: number;
    request?: EncodeRequest;
  }): Promise<void> {
    const request = result.request;
    if (!request?.frameId || request.frameRevision === undefined || request.decisionEpoch === undefined) {
      logger.warn('discarding encode callback without frame identity', { operatorId: result.operatorId });
      return;
    }

    const accepted = this.deps.digitalFrameCoordinator.acceptEncodeResult({
      frameId: request.frameId,
      operatorId: result.operatorId,
      streamId: result.streamId,
      decisionEpoch: request.decisionEpoch,
      revision: request.frameRevision,
    });
    if (!accepted) return;

    this.deps.transmissionTracker.updatePhase(result.operatorId, TransmissionPhase.MIXING, {});
    this.deps.transmissionTracker.updatePhase(result.operatorId, TransmissionPhase.READY, {
      audioData: result.audioData,
      sampleRate: result.sampleRate,
      duration: result.duration,
    });

    const mode = this.deps.getCurrentMode();
    const now = this.deps.clockSource.now();
    const currentSlotStartMs = Math.floor(now / mode.slotMs) * mode.slotMs;
    const slotStartMs = request.slotStartMs ?? currentSlotStartMs;
    this.deps.audioMixer.addOperatorAudio(
      result.operatorId,
      result.audioData,
      result.sampleRate,
      slotStartMs,
      request.requestId,
      request.txDialShiftHz ?? 0,
      {
        frameId: request.frameId,
        frameRevision: request.frameRevision,
        slotId: `slot-${slotStartMs}`,
        streamId: request.streamId,
        audioFrequencyHz: request.frequency,
      },
    );
    this.deps.transmissionTracker.recordAudioAddedToMixer(result.operatorId);

    const frame = this.deps.digitalFrameCoordinator.getFrame(request.frameId);
    if (frame?.phase !== 'ready') return;

    const playbackOffsetMs = this.deps.digitalFrameCoordinator.getPlaybackOffsetMs(
      request.frameId,
      now,
    );

    if (this.deps.digitalFrameCoordinator.getPreparationAction(request.frameId) === 'restart-current') {
      const replacement = await this.deps.audioMixer.mixFrameById(
        request.frameId,
        request.frameRevision,
        playbackOffsetMs,
      );
      if (replacement) await this.handleMixedAudioReady(replacement);
      return;
    }

    const transmitStartMs = Math.max(0, (mode.transmitTiming || 0) - this.deps.getCompensationMs());
    const targetPlaybackTime = currentSlotStartMs + transmitStartMs;
    if (now >= targetPlaybackTime) {
      const mixedAudio = await this.deps.audioMixer.mixFrameById(
        request.frameId,
        request.frameRevision,
        playbackOffsetMs,
      );
      if (mixedAudio) await this.handleMixedAudioReady(mixedAudio);
    } else {
      this.deps.audioMixer.scheduleFrameMixing(
        { frameId: request.frameId, revision: request.frameRevision },
        targetPlaybackTime,
        targetPlaybackTime,
      );
    }
  }

  private async handleMixedAudioReady(
    mixedAudio: MixedAudio,
    onReplacementStarted?: () => void,
  ): Promise<void> {
    if (!mixedAudio.frameId) {
      logger.warn('discarding mixed audio without frame identity');
      return;
    }

    const readyFrame = this.deps.digitalFrameCoordinator.getFrame(mixedAudio.frameId);
    if (readyFrame?.phase !== 'ready') return;
    const expectedTracks = [...readyFrame.participantTrackIds].sort();
    const mixedTracks = [...(mixedAudio.trackIds ?? readyFrame.participantTrackIds)].sort();
    if (expectedTracks.length !== mixedTracks.length
      || expectedTracks.some((trackId, index) => trackId !== mixedTracks[index])) {
      this.failCommittedFrame(readyFrame.frameId, mixedAudio, 'mixed frame participants are incomplete');
      return;
    }
    if (!this.deps.digitalFrameCoordinator.hasCompleteFrameBudget(
      readyFrame.frameId,
      this.deps.clockSource.now(),
      mixedAudio.duration * 1_000,
    )) {
      const reason = 'complete frame no longer fits current slot after encode/mix';
      this.deps.operatorManager.deferPreparedFrameToNextSlot(readyFrame.frameId, reason);
      logger.info('Deferring ready digital frame before physical commit', {
        frameId: readyFrame.frameId,
        operatorIds: mixedAudio.operatorIds,
        reason,
      });
      return;
    }
    const action = this.deps.digitalFrameCoordinator.getPreparationAction(readyFrame.frameId);
    const physicalBefore = this.deps.physicalTxCoordinator.getSnapshot();
    const replacedFrameId = this.deps.digitalFrameCoordinator.getReplacedFrameId(readyFrame.frameId);
    if (physicalBefore.phase !== 'idle'
      && (action !== 'restart-current'
        || physicalBefore.source !== 'digital'
        || physicalBefore.frameId !== replacedFrameId)) {
      const reason = `physical transmitter busy (${physicalBefore.phase})`;
      this.deps.operatorManager.deferPreparedFrameToNextSlot(readyFrame.frameId, reason);
      logger.info('Deferring digital frame until the physical transmitter is idle', {
        frameId: readyFrame.frameId,
        physicalLeaseId: physicalBefore.leaseId,
        physicalPhase: physicalBefore.phase,
      });
      return;
    }

    const prepared = this.deps.digitalFrameCoordinator.prepareFrameForHandover(
      mixedAudio.frameId,
      mixedAudio.operatorIds,
      mixedAudio.trackIds ?? readyFrame.participantTrackIds,
    );
    if (!prepared || prepared.phase !== 'prepared') return;

    let audioForTransmission = mixedAudio;
    let activeLeaseId: string | null = null;

    try {
      if (physicalBefore.phase !== 'idle') {
        await this.replaceCommittedFrameAudio(
          prepared.frameId,
          prepared.participantOperatorIds,
          prepared.participantTrackIds,
          physicalBefore,
          audioForTransmission,
          onReplacementStarted,
        );
        return;
      }

      const committed = this.deps.digitalFrameCoordinator.commitFrame(prepared.frameId);
      if (!committed || committed.phase !== 'committed') return;

      activeLeaseId = await this.deps.physicalTxCoordinator.acquireLease({
        source: 'digital',
        frameId: committed.frameId,
        frameRevision: committed.revision,
        operatorIds: audioForTransmission.operatorIds,
        reason: action === 'restart-current' ? 'late correction restart' : 'digital slot frame',
        beforeStart: this.deps.onBeforeStartPTT,
        playbackKind: 'digital',
        afterAudioDrain: async () => {
          const refreshedOffsetMs = this.deps.digitalFrameCoordinator.getPlaybackOffsetMs(
            committed.frameId,
            this.deps.clockSource.now(),
          );
          const refreshedMix = await this.deps.audioMixer.mixFrameById(
            committed.frameId,
            committed.revision,
            refreshedOffsetMs,
          );
          const refreshedAudio = refreshedMix
            ? this.alignMixedAudioToCurrentCursor(committed.frameId, refreshedMix, refreshedOffsetMs)
            : null;
          if (!refreshedAudio) {
            throw new CompleteFrameBudgetExceededError(
              'digital waveform fully consumed while previous audio drained',
            );
          }
          const refreshedTracks = [...(refreshedAudio.trackIds ?? committed.participantTrackIds)].sort();
          const committedTracks = [...committed.participantTrackIds].sort();
          if (refreshedTracks.length !== committedTracks.length
            || refreshedTracks.some((trackId, index) => trackId !== committedTracks[index])) {
            throw new Error('digital frame tracks changed while previous audio drained');
          }
          audioForTransmission = refreshedAudio;
          logger.info('Refreshed digital frame after previous audio drained', {
            frameId: prepared.frameId,
            playbackOffsetMs: refreshedOffsetMs,
            durationMs: Math.round(refreshedAudio.duration * 1_000),
          });
        },
        deferActiveUntilAudio: true,
        validateStart: () => {
          this.deps.validateDigitalFrameStart?.(audioForTransmission.operatorIds);
          const nowMs = this.deps.clockSource.now();
          if (!this.deps.digitalFrameCoordinator.hasCompleteFrameBudget(
            committed.frameId,
            nowMs,
            this.getRemainingAudioDurationMs(committed.frameId, audioForTransmission, nowMs),
          )) {
            throw new CompleteFrameBudgetExceededError();
          }
        },
        txDialShiftHz: audioForTransmission.txDialShiftHz,
      });

      const physicalAfterAcquire = this.deps.physicalTxCoordinator.getSnapshot();
      if (physicalAfterAcquire.leaseId === activeLeaseId
        && physicalAfterAcquire.frameId
        && physicalAfterAcquire.frameId !== committed.frameId) {
        const supersededResult = await this.deps.physicalTxCoordinator.playAudioOnLease(activeLeaseId, {
          audioData: audioForTransmission.audioData,
          sampleRate: audioForTransmission.sampleRate,
          playbackKind: 'digital',
          frameId: committed.frameId,
          operatorIds: audioForTransmission.operatorIds,
          reason: 'superseded before initial audio start',
        });
        activeLeaseId = null;
        this.finishDigitalFramePlayback(committed.frameId, audioForTransmission, supersededResult);
        return;
      }

      // PTT acknowledgement can itself be delayed. Freeze the actual playback
      // bytes only after it succeeds, so a mid-slot start or correction begins
      // at the waveform position visible to the operator at that moment.
      const finalPlaybackOffsetMs = this.deps.digitalFrameCoordinator.getPlaybackOffsetMs(
        committed.frameId,
        this.deps.clockSource.now(),
      );
      const mixedAtPtt = await this.deps.audioMixer.mixFrameById(
        committed.frameId,
        committed.revision,
        finalPlaybackOffsetMs,
      );
      const finalAudio = mixedAtPtt
        ? this.alignMixedAudioToCurrentCursor(committed.frameId, mixedAtPtt, finalPlaybackOffsetMs)
        : null;
      if (!finalAudio) {
        await this.deps.physicalTxCoordinator.forceInterruptLease(
          activeLeaseId,
          'digital waveform fully consumed before audio start',
        );
        activeLeaseId = null;
        const reason = 'digital waveform fully consumed before audio start';
        this.deps.operatorManager.deferPreparedFrameToNextSlot(committed.frameId, reason);
        return;
      }
      const finalTracks = [...(finalAudio.trackIds ?? committed.participantTrackIds)].sort();
      const committedTracks = [...committed.participantTrackIds].sort();
      if (finalTracks.length !== committedTracks.length
        || finalTracks.some((trackId, index) => trackId !== committedTracks[index])) {
        await this.deps.physicalTxCoordinator.forceInterruptLease(
          activeLeaseId,
          'digital frame participants changed before audio start',
        );
        activeLeaseId = null;
        this.failCommittedFrame(committed.frameId, finalAudio, 'digital frame participants changed before audio start');
        return;
      }
      audioForTransmission = finalAudio;
      if (!this.deps.digitalFrameCoordinator.hasCompleteFrameBudget(
        committed.frameId,
        this.deps.clockSource.now(),
        audioForTransmission.duration * 1_000,
      )) {
        await this.deps.physicalTxCoordinator.forceInterruptLease(
          activeLeaseId,
          'complete frame no longer fits after PTT acknowledgement',
        );
        activeLeaseId = null;
        const reason = 'complete frame no longer fits after PTT acknowledgement';
        this.deps.operatorManager.deferPreparedFrameToNextSlot(committed.frameId, reason);
        return;
      }

      const result = await this.deps.physicalTxCoordinator.playAudioOnLease(activeLeaseId, {
        audioData: audioForTransmission.audioData,
        sampleRate: audioForTransmission.sampleRate,
        playbackKind: 'digital',
        frameId: committed.frameId,
        operatorIds: audioForTransmission.operatorIds,
        reason: 'digital slot frame audio',
        playbackOptions: {
          diagnosticContext: {
            frameId: prepared.frameId,
            operatorIds: audioForTransmission.operatorIds,
            mixMetrics: audioForTransmission.mixMetrics,
          },
        },
        tailHoldMs: DIGITAL_TAIL_HOLD_MS,
      });
      activeLeaseId = null;
      this.finishDigitalFramePlayback(committed.frameId, audioForTransmission, result);
    } catch (error) {
      if (activeLeaseId) {
        await this.deps.physicalTxCoordinator.forceInterruptLease(
          activeLeaseId,
          'digital frame start failed',
        ).catch((cleanupError) => {
          logger.warn('Failed to clean up digital physical lease after start failure', {
            frameId: prepared.frameId,
            cleanupError: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          });
        });
        activeLeaseId = null;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof CompleteFrameBudgetExceededError) {
        this.deps.operatorManager.deferPreparedFrameToNextSlot(prepared.frameId, message);
        logger.info('Deferring committed frame after pre-PTT work exceeded slot budget', {
          frameId: prepared.frameId,
        });
        return;
      }
      if (error instanceof PhysicalTxPreparationError) {
        this.deps.operatorManager.deferPreparedFrameToNextSlot(prepared.frameId, message);
        logger.warn('Deferring committed frame because physical audio output is not ready', {
          frameId: prepared.frameId,
          error: message,
        });
        return;
      }
      if (error instanceof PhysicalTxBusyError) {
        this.deps.operatorManager.deferPreparedFrameToNextSlot(prepared.frameId, message);
        logger.info('Deferring committed frame while physical cleanup is fenced', {
          frameId: prepared.frameId,
        });
        return;
      }
      logger.error('physical digital transmission failed', {
        frameId: prepared.frameId,
        error: message,
      });
      this.failCommittedFrame(prepared.frameId, audioForTransmission, message);
    }
  }

  private async replaceCommittedFrameAudio(
    frameId: string,
    participantOperatorIds: string[],
    participantTrackIds: string[],
    physical: PhysicalTxSnapshot,
    initialAudio: MixedAudio,
    onReplacementStarted?: () => void,
  ): Promise<void> {
    if (!physical.leaseId) {
      this.failCommittedFrame(frameId, initialAudio, 'physical lease disappeared before audio replacement');
      return;
    }

    const mixStartedAtMs = this.deps.clockSource.now();
    const replacementOffsetMs = this.deps.digitalFrameCoordinator.getPlaybackOffsetMs(
      frameId,
      mixStartedAtMs,
    );
    const frame = this.deps.digitalFrameCoordinator.getFrame(frameId);
    const remixed = frame
      ? await this.deps.audioMixer.mixFrameById(frame.frameId, frame.revision, replacementOffsetMs)
      : null;
    const waveformStartMs = this.deps.clockSource.now();
    const aligned = remixed
      ? this.alignMixedAudioToCurrentCursor(frameId, remixed, replacementOffsetMs, waveformStartMs)
      : null;
    if (!aligned) {
      const reason = 'replacement audio was fully consumed before handover preparation';
      this.deps.operatorManager.deferPreparedFrameToNextSlot(frameId, reason);
      return;
    }
    const actualTracks = [...(aligned.trackIds ?? participantTrackIds)].sort();
    const expectedTracks = [...participantTrackIds].sort();
    if (actualTracks.length !== expectedTracks.length
      || actualTracks.some((trackId, index) => trackId !== expectedTracks[index])) {
      this.failCommittedFrame(frameId, aligned, 'replacement mix lost one or more frame tracks');
      return;
    }
    if (!this.deps.digitalFrameCoordinator.hasCompleteFrameBudget(
      frameId,
      waveformStartMs,
      aligned.duration * 1_000,
    )) {
      const reason = 'complete replacement no longer fits before handover preparation';
      this.deps.operatorManager.deferPreparedFrameToNextSlot(frameId, reason);
      return;
    }

    const currentPhysical = this.deps.physicalTxCoordinator.getSnapshot();
    if (currentPhysical.leaseId !== physical.leaseId
      || currentPhysical.epoch !== physical.epoch
      || currentPhysical.playbackGeneration !== physical.playbackGeneration) {
      this.deps.operatorManager.deferPreparedFrameToNextSlot(
        frameId,
        'physical replacement precondition changed before handover',
      );
      return;
    }

    this.deps.validateDigitalFrameStart?.(participantOperatorIds);

    const audioForTransmission = aligned;
    const result = await this.deps.physicalTxCoordinator.replaceAudioOnLease(physical.leaseId, {
      frameId,
      frameRevision: this.deps.digitalFrameCoordinator.getFrame(frameId)?.revision,
      operatorIds: participantOperatorIds,
      reason: 'digital frame audio replacement',
      playbackKind: 'digital',
      audioData: aligned.audioData,
      sampleRate: aligned.sampleRate,
      playbackOptions: {
        diagnosticContext: { frameId, operatorIds: aligned.operatorIds, mixMetrics: aligned.mixMetrics },
      },
      tailHoldMs: DIGITAL_TAIL_HOLD_MS,
      waveformStartMs,
      slotEndMs: this.deps.digitalFrameCoordinator.getSlotEndMs(frameId),
      expectedLeaseEpoch: physical.epoch,
      expectedPlaybackGeneration: physical.playbackGeneration,
      expectedFrameId: physical.frameId,
      validateStart: () => {
        this.deps.validateDigitalFrameStart?.(participantOperatorIds);
      },
      onHandoverCommitted: () => {
        const committed = this.deps.digitalFrameCoordinator.commitFrame(frameId);
        if (committed?.phase !== 'committed') {
          return {
            status: 'superseded' as const,
            reason: 'digital replacement candidate is no longer prepared',
          };
        }
        return { status: 'committed' as const };
      },
      onPlaybackStarted: onReplacementStarted,
    });

    if (!result.success && result.leaseContinues) {
      this.deps.operatorManager.deferPreparedFrameToNextSlot(frameId, result.reason);
    }
    this.finishDigitalFramePlayback(frameId, audioForTransmission, result);
  }

  private finishDigitalFramePlayback(
    frameId: string,
    audio: MixedAudio,
    result: {
      success: boolean;
      reason: string;
      error?: string;
      physicalConfirmed: boolean;
      leaseContinues?: boolean;
      retryDisposition?: 'none' | 'next-transmit-cycle';
      audioIssue?: {
        issueId: string;
        streamGeneration: number;
        kind: string;
      };
    },
  ): void {
    if (result.leaseContinues) {
      logger.info('Digital frame audio was superseded within the active PTT lease', {
        frameId,
        reason: result.reason,
        physicalConfirmed: result.physicalConfirmed,
      });
    } else if (!result.success) {
      logger.warn('Physical digital playback completed unsuccessfully', {
        frameId,
        reason: result.reason,
        error: result.error,
        physicalConfirmed: result.physicalConfirmed,
        leaseContinues: result.leaseContinues,
        issueId: result.audioIssue?.issueId,
        streamGeneration: result.audioIssue?.streamGeneration,
        audioIssueKind: result.audioIssue?.kind,
      });
    }
    if (!result.success
      && !result.leaseContinues
      && result.retryDisposition === 'next-transmit-cycle') {
      const requeuedOperatorIds = this.deps.operatorManager.requeuePhysicalFrameAfterOutputFailure(
        frameId,
        result.reason,
      );
      logger.warn('Deferred valid transmission intents after severe audio output failure', {
        frameId,
        issueId: result.audioIssue?.issueId,
        streamGeneration: result.audioIssue?.streamGeneration,
        operatorIds: requeuedOperatorIds,
      });
    }
    const frame = this.deps.digitalFrameCoordinator.getFrame(frameId);
    const intents = this.deps.digitalFrameCoordinator.getIntentRequests(frameId);
    this.deps.digitalFrameCoordinator.completeFrame(frameId, result.reason);
    if (result.success) {
      const receiptsByOperator = new Map<string, import('@tx5dr/plugin-api').StreamPhysicalReceipt[]>();
      const completedTracks = audio.tracks ?? intents.map((intent) => ({
        operatorId: intent.operatorId,
        streamId: intent.streamId ?? 'default',
        trackId: `${intent.operatorId}\u0000${intent.streamId ?? 'default'}`,
        audioFrequencyHz: intent.audioFrequencyHz ?? 0,
      }));
      for (const track of completedTracks) {
        const intent = intents.find((candidate) => (
          candidate.operatorId === track.operatorId && (candidate.streamId ?? 'default') === track.streamId
        ));
        if (!intent?.text || !frame) continue;
        const receipts = receiptsByOperator.get(track.operatorId) ?? [];
        receipts.push({
          streamId: track.streamId,
          text: intent.text,
          audioFrequencyHz: intent.audioFrequencyHz ?? 0,
          frameId,
          revision: frame.revision,
          physicalConfirmed: true,
        });
        receiptsByOperator.set(track.operatorId, receipts);
      }
      for (const [operatorId, receipts] of receiptsByOperator) {
        const manager = this.deps.operatorManager as RadioOperatorManager & {
          notifyPhysicalTransmissionsComplete?: RadioOperatorManager['notifyPhysicalTransmissionsComplete'];
        };
        if (typeof manager.notifyPhysicalTransmissionsComplete === 'function') {
          manager.notifyPhysicalTransmissionsComplete(operatorId, receipts);
        } else {
          for (const receipt of receipts) manager.notifyPhysicalTransmissionComplete(operatorId, receipt.text);
        }
      }
    }
    this.emitFrameTerminal(frameId, audio.operatorIds, {
      physicalConfirmed: result.physicalConfirmed,
      terminalReason: result.reason,
      success: result.success,
      duration: audio.duration,
      error: result.error,
    });
  }

  private alignMixedAudioToCurrentCursor(
    frameId: string,
    mixedAudio: MixedAudio,
    mixedAtOffsetMs: number,
    currentTimeMs = this.deps.clockSource.now(),
  ): MixedAudio | null {
    const currentOffsetMs = this.deps.digitalFrameCoordinator.getPlaybackOffsetMs(
      frameId,
      currentTimeMs,
    );
    const additionalOffsetMs = Math.max(0, currentOffsetMs - mixedAtOffsetMs);
    if (additionalOffsetMs === 0) {
      return { ...mixedAudio, playbackOffsetMs: currentOffsetMs };
    }

    const skipSamples = Math.floor((additionalOffsetMs / 1_000) * mixedAudio.sampleRate);
    if (skipSamples >= mixedAudio.audioData.length) return null;
    const audioData = mixedAudio.audioData.subarray(skipSamples);
    return {
      ...mixedAudio,
      audioData,
      duration: audioData.length / mixedAudio.sampleRate,
      playbackOffsetMs: currentOffsetMs,
    };
  }

  private getRemainingAudioDurationMs(
    frameId: string,
    mixedAudio: MixedAudio,
    currentTimeMs: number,
  ): number {
    const currentOffsetMs = this.deps.digitalFrameCoordinator.getPlaybackOffsetMs(
      frameId,
      currentTimeMs,
    );
    const additionalOffsetMs = Math.max(
      0,
      currentOffsetMs - (mixedAudio.playbackOffsetMs ?? 0),
    );
    return Math.max(0, (mixedAudio.duration * 1_000) - additionalOffsetMs);
  }

  private failCommittedFrame(frameId: string, mixedAudio: MixedAudio, reason: string): void {
    const frame = this.deps.digitalFrameCoordinator.completeFrame(frameId, reason);
    this.emitFrameTerminal(frameId, frame?.participantOperatorIds ?? mixedAudio.operatorIds, {
      physicalConfirmed: false,
      terminalReason: reason,
      success: false,
      error: reason,
    });
  }

  private emitFrameTerminal(
    frameId: string,
    operatorIds: string[],
    result: {
      physicalConfirmed: boolean;
      terminalReason: string;
      success: boolean;
      duration?: number;
      error?: string;
    },
  ): void {
    let emitted = this.terminalOperatorsByFrame.get(frameId);
    if (!emitted) {
      emitted = new Set();
      this.terminalOperatorsByFrame.set(frameId, emitted);
    }
    const intents = this.deps.digitalFrameCoordinator.getIntentRequests(frameId);
    const terminalTracks = intents.length > 0
      ? intents.filter((intent) => operatorIds.includes(intent.operatorId))
      : operatorIds.map((operatorId) => ({ operatorId, streamId: 'default' }));
    for (const intent of terminalTracks) {
      const streamId = intent.streamId ?? 'default';
      const trackId = `${intent.operatorId}\u0000${streamId}`;
      if (emitted.has(trackId)) continue;
      emitted.add(trackId);
      this.deps.engineEmitter.emit('transmissionComplete', {
        operatorId: intent.operatorId,
        streamId,
        trackId,
        frameId,
        ...result,
        mixedWith: operatorIds.filter((id) => id !== intent.operatorId),
      });
    }
    if (this.terminalOperatorsByFrame.size > 256) {
      const oldestFrameId = this.terminalOperatorsByFrame.keys().next().value as string | undefined;
      if (oldestFrameId) this.terminalOperatorsByFrame.delete(oldestFrameId);
    }
  }

  private handlePhysicalPhaseChanged(snapshot: PhysicalTxSnapshot): void {
    if (snapshot.source && snapshot.source !== 'digital') return;
    if (snapshot.frameId) {
      if (snapshot.phase === 'active') {
        const frame = this.deps.digitalFrameCoordinator.markOnAir(snapshot.frameId);
        if (frame) this.emitPhysicalTransmissionFacts(frame, snapshot);
      } else if (snapshot.phase === 'draining') {
        this.deps.digitalFrameCoordinator.markDraining(snapshot.frameId);
      }
    }

  }

  private emitPhysicalTransmissionFacts(
    frame: import('../transmission/TransmissionIntent.js').FrameLease,
    snapshot: PhysicalTxSnapshot,
  ): void {
    const slotStartMs = Number(frame.slotId.replace(/^slot-/, ''));
    if (!Number.isFinite(slotStartMs)) {
      logger.warn('Cannot publish physical transmission fact for an unparseable slot id', {
        frameId: frame.frameId,
        slotId: frame.slotId,
      });
      return;
    }
    for (const intent of this.deps.digitalFrameCoordinator.getIntentRequests(frame.frameId)) {
      const streamId = intent.streamId ?? 'default';
      const key = `${frame.frameId}:${snapshot.playbackGeneration}:${intent.operatorId}:${streamId}`;
      if (this.onAirTransmissionKeys.has(key)) continue;
      const message = intent.text;
      const context = this.deps.operatorManager.getTransmissionFactContext(intent.operatorId);
      if (!message || !context) continue;
      this.onAirTransmissionKeys.add(key);
      this.deps.engineEmitter.emit('transmissionLog', {
        operatorId: intent.operatorId,
        streamId,
        frameId: frame.frameId,
        revision: frame.revision,
        playbackGeneration: snapshot.playbackGeneration,
        phase: 'on_air',
        physicalConfirmed: true,
        time: new Date(slotStartMs).toISOString().slice(11, 19).replace(/:/g, ''),
        message,
        frequency: intent.audioFrequencyHz ?? context.frequency,
        slotStartMs,
        replaceExisting: this.deps.digitalFrameCoordinator.getReplacedFrameId(frame.frameId) !== undefined,
        frequencyContext: context.frequencyContext,
      });
    }
    if (this.onAirTransmissionKeys.size > 1_024) {
      this.onAirTransmissionKeys.clear();
    }
  }
}
