import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'eventemitter3';
import type { PlaybackKind, PlayAudioOptions } from '../audio/AudioStreamManager.js';
import type {
  PhysicalTxPhase,
  PhysicalTxSnapshot,
  PhysicalTxSource,
} from './TransmissionIntent.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('PhysicalTxCoordinator');

export interface PhysicalTxCoordinatorEvents {
  phaseChanged: (snapshot: PhysicalTxSnapshot) => void;
  terminal: (result: PhysicalTxResult) => void;
  staleCallbackDiscarded: (data: { leaseId: string; epoch: number; callback: string }) => void;
}

export interface PhysicalTxCoordinatorDeps {
  isRadioConnected: () => boolean;
  setPTT: (active: boolean) => Promise<void>;
  playAudio: (audioData: Float32Array, sampleRate: number, options?: PlayAudioOptions) => Promise<void>;
  stopCurrentPlayback: (options?: { kind?: PlaybackKind }) => Promise<number>;
  prepareAudioPlayback?: (kind: PlaybackKind) => Promise<boolean>;
  isAudioPlaying?: (kind?: PlaybackKind) => boolean;
  setTxDialOffset?: (shiftHz: number) => Promise<unknown>;
  clearTxDialOffset?: () => Promise<unknown>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface PhysicalTxLeaseRequest {
  source: PhysicalTxSource;
  operatorIds?: string[];
  frameId?: string;
  frameRevision?: number;
  reason: string;
  txDialShiftHz?: number;
  deferActiveUntilAudio?: boolean;
  playbackKind?: PlaybackKind;
  beforeStart?: () => Promise<void>;
  afterAudioDrain?: () => Promise<void>;
  validateStart?: () => void | Promise<void>;
  assertPtt?: boolean;
  interrupt?: () => Promise<void>;
}

export interface PhysicalAudioTransmissionRequest extends PhysicalTxLeaseRequest {
  audioData: Float32Array;
  sampleRate: number;
  playbackKind: PlaybackKind;
  playbackOptions?: Omit<PlayAudioOptions, 'playbackKind'>;
  tailHoldMs?: number;
}

export interface PhysicalAudioPlaybackRequest {
  audioData: Float32Array;
  sampleRate: number;
  playbackKind: PlaybackKind;
  frameId?: string;
  operatorIds?: string[];
  reason?: string;
  playbackOptions?: Omit<PlayAudioOptions, 'playbackKind'>;
  tailHoldMs?: number;
  frameRevision?: number;
}

export interface PhysicalAudioReplacementRequest {
  frameId: string;
  frameRevision?: number;
  operatorIds: string[];
  reason: string;
  playbackKind: PlaybackKind;
  audioData: Float32Array;
  sampleRate: number;
  playbackOptions?: Omit<PlayAudioOptions, 'playbackKind'>;
  tailHoldMs?: number;
  /** Wall-clock instant represented by the first sample in audioData. */
  waveformStartMs: number;
  /** No replacement may begin if its complete remaining waveform cannot fit. */
  slotEndMs?: number;
  expectedLeaseEpoch: number;
  expectedPlaybackGeneration: number;
  expectedFrameId?: string;
  onHandoverCommitted?: () => PhysicalAudioHandoverCommitResult;
  onPlaybackStarted?: () => void;
}

export type PhysicalAudioHandoverCommitResult =
  | { status: 'committed' }
  | { status: 'superseded'; reason: string };

export interface PhysicalTxResult {
  leaseId: string;
  frameId?: string;
  frameRevision?: number;
  source: PhysicalTxSource;
  operatorIds: string[];
  success: boolean;
  reason: string;
  error?: string;
  physicalConfirmed: boolean;
  /** A newer audio generation owns the same physical PTT lease. */
  leaseContinues?: boolean;
}

export interface PhysicalTxMaintenanceRequest {
  reason: string;
  /** Scheduled/background work never interrupts an existing physical lease. */
  busyPolicy?: 'reject';
}

interface MutablePhysicalPlayback {
  generation: number;
  frameId?: string;
  frameRevision?: number;
  operatorIds: string[];
  playbackKind: PlaybackKind;
  completion: Promise<void>;
}

interface PhysicalPlaybackIdentity {
  frameId?: string;
  frameRevision?: number;
  operatorIds?: string[];
  playbackKind: PlaybackKind;
  reason?: string;
}

interface MutablePhysicalLease {
  leaseId: string;
  frameId?: string;
  frameRevision?: number;
  source: PhysicalTxSource;
  operatorIds: string[];
  reason: string;
  epoch: number;
  phase: PhysicalTxPhase;
  startedAt: number;
  pttConfirmed: boolean;
  everPttConfirmed: boolean;
  stopRequested: boolean;
  terminalEmitted: boolean;
  playbackKind?: PlaybackKind;
  pttStartPromise?: Promise<void>;
  pttStartSettlementPromise?: Promise<void>;
  dialOffsetStartPromise?: Promise<unknown>;
  dialOffsetSettlementPromise?: Promise<void>;
  dialOffsetApplied: boolean;
  releasePromise?: Promise<PhysicalTxResult>;
  assertPtt: boolean;
  interrupt?: () => Promise<void>;
  playbackGeneration: number;
  drainingGeneration?: number;
  playbackTransition: Promise<void>;
  activePlayback?: MutablePhysicalPlayback;
  activationPromise: Promise<void>;
  resolveActivation: () => void;
  rejectActivation: (error: unknown) => void;
  activationSettled: boolean;
}

export class PhysicalTxBusyError extends Error {
  constructor(message = 'physical transmitter is busy') {
    super(message);
    this.name = 'PhysicalTxBusyError';
  }
}

export class PhysicalTxInterruptedError extends Error {
  constructor(message = 'physical transmission interrupted') {
    super(message);
    this.name = 'PhysicalTxInterruptedError';
  }
}

export class PhysicalTxPreparationError extends Error {
  constructor(message: string, public readonly preparationCause?: unknown) {
    super(message);
    this.name = 'PhysicalTxPreparationError';
  }
}

export class PhysicalTxCoordinator extends EventEmitter<PhysicalTxCoordinatorEvents> {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly idFactory: () => string;
  private readonly operationTimeoutMs: number;
  private readonly audioStartTimeoutMs: number;
  private readonly cleanupTimeoutMs: number;
  private activeLease: MutablePhysicalLease | null = null;
  private epoch = 0;
  private staleCallbackDiscardCount = 0;
  private readonly pendingOperationFences = new Set<Promise<void>>();
  private maintenanceReason: string | null = null;

  constructor(
    private readonly deps: PhysicalTxCoordinatorDeps,
    options: {
      idFactory?: () => string;
      operationTimeoutMs?: number;
      audioStartTimeoutMs?: number;
      cleanupTimeoutMs?: number;
    } = {},
  ) {
    super();
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.idFactory = options.idFactory ?? randomUUID;
    this.operationTimeoutMs = options.operationTimeoutMs ?? 15_000;
    this.audioStartTimeoutMs = options.audioStartTimeoutMs ?? this.operationTimeoutMs;
    this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? 2_000;
  }

  getSnapshot(): PhysicalTxSnapshot {
    return this.snapshot(this.activeLease);
  }

  getStaleCallbackDiscardCount(): number {
    return this.staleCallbackDiscardCount;
  }

  /**
   * Runs a hardware mutation while the transmitter is confirmed idle. The
   * fence is installed synchronously, before user code runs, so digital,
   * voice, CW, tune and manual sources all observe the same exclusion point.
   */
  async runIdleMaintenance<T>(
    request: PhysicalTxMaintenanceRequest,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    if (this.activeLease || this.maintenanceReason || this.pendingOperationFences.size > 0) {
      throw new PhysicalTxBusyError(
        this.activeLease
          ? `physical transmitter is ${this.activeLease.phase}`
          : this.maintenanceReason
            ? `physical transmitter maintenance is active: ${this.maintenanceReason}`
            : 'physical transmitter cleanup is still settling',
      );
    }

    this.maintenanceReason = request.reason;
    let operationSettled = false;
    let operationPromise: Promise<T>;
    try {
      operationPromise = Promise.resolve(operation());
    } catch (error) {
      operationPromise = Promise.reject(error);
    }
    void operationPromise.then(
      () => { operationSettled = true; },
      () => { operationSettled = true; },
    );

    try {
      return await this.withTimeout(operationPromise, request.reason);
    } catch (error) {
      // A timed-out CAT/network command may still reach the radio later. Keep
      // all new leases fenced until the actual backend promise settles.
      if (!operationSettled) this.trackPendingOperation(operationPromise);
      throw error;
    } finally {
      this.maintenanceReason = null;
    }
  }

  async acquireLease(request: PhysicalTxLeaseRequest): Promise<string> {
    if (this.activeLease || this.maintenanceReason || this.pendingOperationFences.size > 0) {
      throw new PhysicalTxBusyError(
        this.activeLease
          ? 'physical transmitter is busy'
          : this.maintenanceReason
            ? `physical transmitter maintenance is active: ${this.maintenanceReason}`
            : 'physical transmitter cleanup is still settling',
      );
    }

    let resolveActivation!: () => void;
    let rejectActivation!: (error: unknown) => void;
    const activationPromise = new Promise<void>((resolve, reject) => {
      resolveActivation = resolve;
      rejectActivation = reject;
    });
    void activationPromise.catch(() => undefined);
    const lease: MutablePhysicalLease = {
      leaseId: this.idFactory(),
      frameId: request.frameId,
      frameRevision: request.frameRevision,
      source: request.source,
      operatorIds: [...new Set(request.operatorIds ?? [])],
      reason: request.reason,
      epoch: ++this.epoch,
      phase: 'starting',
      startedAt: this.now(),
      pttConfirmed: false,
      everPttConfirmed: false,
      stopRequested: false,
      terminalEmitted: false,
      playbackKind: request.playbackKind,
      dialOffsetApplied: false,
      assertPtt: request.assertPtt !== false,
      interrupt: request.interrupt,
      playbackGeneration: 0,
      playbackTransition: Promise.resolve(),
      activationPromise,
      resolveActivation,
      rejectActivation,
      activationSettled: false,
    };
    this.activeLease = lease;
    this.emitPhase(lease);

    try {
      if (request.beforeStart) {
        let beforeStartSettled = false;
        const beforeStartPromise = Promise.resolve().then(request.beforeStart);
        void beforeStartPromise.then(
          () => { beforeStartSettled = true; },
          () => { beforeStartSettled = true; },
        );
        try {
          await this.withTimeout(beforeStartPromise, 'pre-start cleanup');
        } catch (error) {
          // A timed-out cleanup may still be running in a native/audio
          // backend. Keep its fence so a new lease cannot race the late
          // callback into the next frame.
          if (!beforeStartSettled) this.trackPendingOperation(beforeStartPromise);
          throw error;
        }
      }
      this.assertLeaseCanContinue(lease, 'interrupted during pre-start cleanup');

      if (request.playbackKind) {
        await this.preparePlaybackOutput(lease, request.playbackKind, request.afterAudioDrain);
      }

      await request.validateStart?.();
      this.assertLeaseCanContinue(lease, 'interrupted after start validation');
      if (lease.assertPtt && !this.deps.isRadioConnected()) {
        throw new Error('radio not connected');
      }
      if (request.txDialShiftHz) {
        const rawDialOffsetStart = Promise.resolve().then(
          () => this.deps.setTxDialOffset?.(request.txDialShiftHz!),
        );
        lease.dialOffsetStartPromise = rawDialOffsetStart;
        lease.dialOffsetSettlementPromise = rawDialOffsetStart.then(async (applied) => {
          lease.dialOffsetApplied = applied !== false;
          if (!this.isCurrent(lease) || lease.stopRequested) {
            await this.deps.clearTxDialOffset?.();
            lease.dialOffsetApplied = false;
          }
        }, () => undefined);
        const applied = await this.withTimeout(rawDialOffsetStart, 'TX dial offset');
        if (applied === false) {
          throw new Error('TX dial offset was not applied');
        }
        this.assertLeaseCanContinue(lease, 'interrupted while setting TX dial offset');
        await request.validateStart?.();
        this.assertLeaseCanContinue(lease, 'interrupted after TX dial offset validation');
      }

      if (lease.assertPtt) {
        const rawStart = this.deps.setPTT(true);
        lease.pttStartPromise = rawStart;
        lease.pttStartSettlementPromise = rawStart.then(
          () => this.handleLatePttStart(lease),
          () => undefined,
        );
        await this.withTimeout(rawStart, 'PTT start');
        await request.validateStart?.();
      }

      if (!this.isCurrent(lease) || lease.stopRequested) {
        await this.ensureReleased(lease, 'interrupted while PTT was starting', false);
        throw new PhysicalTxInterruptedError();
      }

      lease.pttConfirmed = lease.assertPtt;
      lease.everPttConfirmed = lease.assertPtt;
      this.resolveLeaseActivation(lease);
      if (!request.deferActiveUntilAudio) {
        lease.phase = 'active';
        this.emitPhase(lease);
      }
      return lease.leaseId;
    } catch (error) {
      this.rejectLeaseActivation(lease, error);
      if (this.isCurrent(lease) && lease.phase !== 'unknown') {
        await this.ensureReleased(lease, 'PTT start failed', false, error);
      }
      throw error;
    }
  }

  async transmitAudio(request: PhysicalAudioTransmissionRequest): Promise<PhysicalTxResult> {
    const leaseId = await this.acquireLease({
      ...request,
      playbackKind: request.playbackKind,
      deferActiveUntilAudio: true,
    });
    return this.playAudioOnLease(leaseId, request);
  }

  async playAudioOnLease(
    leaseId: string,
    request: PhysicalAudioPlaybackRequest,
  ): Promise<PhysicalTxResult> {
    const lease = this.requireCurrentLease(leaseId);
    const started = await this.runPlaybackTransition(lease, async () => {
      if (request.frameId && lease.frameId && request.frameId !== lease.frameId) {
        return {
          started: false,
          completion: Promise.resolve(this.toPlaybackResult(
            lease,
            request,
            false,
            'audio generation superseded before start',
            undefined,
            true,
          )),
        };
      }
      if (lease.activePlayback) {
        throw new PhysicalTxBusyError('physical lease already has an active audio generation');
      }
      return this.startPlaybackGenerationLocked(lease, request, ++lease.playbackGeneration);
    });
    return started.completion;
  }

  /**
   * Replaces digital audio while retaining the existing physical PTT lease.
   * The old playback generation is fenced before it is stopped, so its late
   * completion cannot release PTT or overwrite the replacement frame state.
   */
  async replaceAudioOnLease(
    leaseId: string,
    request: PhysicalAudioReplacementRequest,
  ): Promise<PhysicalTxResult> {
    const lease = this.requireCurrentLease(leaseId);
    try {
      const started = await this.runPlaybackTransition(lease, async () => {
        this.assertLeaseCanContinue(lease, 'interrupted before audio replacement');
        if (lease.epoch !== request.expectedLeaseEpoch
          || lease.playbackGeneration !== request.expectedPlaybackGeneration
          || (request.expectedFrameId !== undefined && lease.frameId !== request.expectedFrameId)) {
          return {
            started: false,
            completion: Promise.resolve(this.toPlaybackResult(
              lease,
              request,
              false,
              'audio replacement precondition changed',
              undefined,
              true,
            )),
          };
        }

        if (!lease.activationSettled || (lease.assertPtt && !lease.pttConfirmed)) {
          // The candidate is not the physical owner until its audio-start
          // acknowledgement. Keep the starting lease identity immutable while
          // waiting so UI and competing transitions still see the predecessor.
          await this.withTimeout(lease.activationPromise, 'pending physical activation');
          this.assertLeaseCanContinue(lease, 'interrupted while waiting to replace audio');
          if (lease.assertPtt && !lease.pttConfirmed) {
            throw new PhysicalTxInterruptedError('PTT start is not yet confirmed');
          }
        }

        const preparedAudio = this.resynchronizeReplacementAudio(request, this.now());
        const remainingDurationMs = (preparedAudio.length / request.sampleRate) * 1_000;
        if (preparedAudio.length === 0
          || (request.slotEndMs !== undefined
            && this.now() + remainingDurationMs + (request.tailHoldMs ?? 0) > request.slotEndMs)) {
          return {
            started: false,
            completion: Promise.resolve(this.toPlaybackResult(
              lease,
              request,
              false,
              'complete replacement no longer fits before handover commit',
              undefined,
              true,
            )),
          };
        }

        const previousPlayback = lease.activePlayback;
        const handover = request.onHandoverCommitted?.();
        if (handover?.status === 'superseded') {
          return {
            started: false,
            completion: Promise.resolve(this.toPlaybackResult(
              lease,
              request,
              false,
              handover.reason,
              undefined,
              true,
            )),
          };
        }
        const generation = ++lease.playbackGeneration;
        lease.drainingGeneration = undefined;
        if (previousPlayback) {
          const stopPromise = Promise.resolve().then(
            () => this.deps.stopCurrentPlayback({ kind: previousPlayback.playbackKind }),
          );
          try {
            await this.withTimeout(stopPromise, 'audio replacement stop', this.cleanupTimeoutMs);
          } catch (error) {
            this.trackPendingOperation(stopPromise);
            throw error;
          }
        }
        this.assertLeaseCanContinue(lease, 'interrupted after stopping replaced audio');
        lease.activePlayback = undefined;

        // stopCurrentPlayback only fences the producer. The native backend may
        // still own submitted samples, so the same output-preparation contract
        // used by a new lease must run before this lease starts a generation.
        await this.preparePlaybackOutput(lease, request.playbackKind);
        this.assertLeaseCanContinue(lease, 'interrupted while draining replaced audio');

        const handoverStartMs = this.now();
        const resynchronizedAudio = this.resynchronizeReplacementAudio(request, handoverStartMs);
        const resynchronizedDurationMs = (resynchronizedAudio.length / request.sampleRate) * 1_000;
        if (resynchronizedAudio.length === 0
          || (request.slotEndMs !== undefined
            && handoverStartMs + resynchronizedDurationMs + (request.tailHoldMs ?? 0) > request.slotEndMs)) {
          throw new PhysicalTxPreparationError(
            'complete replacement no longer fits after audio output drain',
          );
        }

        const started = await this.startPlaybackGenerationLocked(lease, {
          audioData: resynchronizedAudio,
          sampleRate: request.sampleRate,
          playbackKind: request.playbackKind,
          playbackOptions: request.playbackOptions,
          tailHoldMs: request.tailHoldMs,
          frameId: request.frameId,
          frameRevision: request.frameRevision,
          operatorIds: request.operatorIds,
          reason: request.reason,
        }, generation);
        if (started.started) request.onPlaybackStarted?.();
        return started;
      });
      return started.completion;
    } catch (error) {
      if (this.isCurrent(lease)) {
        return this.ensureReleased(lease, 'audio replacement failed', false, error);
      }
      return this.toPlaybackResult(
        lease,
        { playbackKind: request.playbackKind, frameId: request.frameId, operatorIds: request.operatorIds },
        false,
        'audio replacement failed',
        error,
      );
    }
  }

  private async preparePlaybackOutput(
    lease: MutablePhysicalLease,
    playbackKind: PlaybackKind,
    afterAudioDrain?: () => Promise<void>,
  ): Promise<boolean> {
    if (!this.deps.prepareAudioPlayback) return false;

    let preparationSettled = false;
    const preparationPromise = Promise.resolve()
      .then(() => this.deps.prepareAudioPlayback!(playbackKind));
    void preparationPromise.then(
      () => { preparationSettled = true; },
      () => { preparationSettled = true; },
    );

    let waitedForDrain: boolean;
    try {
      waitedForDrain = await this.withTimeout(preparationPromise, 'audio output preparation');
    } catch (error) {
      if (!preparationSettled) this.trackPendingOperation(preparationPromise);
      const message = error instanceof Error ? error.message : String(error);
      throw new PhysicalTxPreparationError(`audio output preparation failed: ${message}`, error);
    }
    this.assertLeaseCanContinue(lease, 'interrupted during audio output preparation');

    if (waitedForDrain && afterAudioDrain) {
      let refreshSettled = false;
      const refreshPromise = Promise.resolve()
        .then(afterAudioDrain)
        .finally(() => { refreshSettled = true; });
      try {
        await this.withTimeout(refreshPromise, 'post-drain audio refresh');
      } catch (error) {
        if (!refreshSettled) this.trackPendingOperation(refreshPromise);
        throw error;
      }
      this.assertLeaseCanContinue(lease, 'interrupted during post-drain audio refresh');
    }

    return waitedForDrain;
  }

  private resynchronizeReplacementAudio(
    request: PhysicalAudioReplacementRequest,
    nowMs: number,
  ): Float32Array {
    const elapsedSincePreparationMs = Math.max(0, nowMs - request.waveformStartMs);
    const additionalSamples = Math.min(
      request.audioData.length,
      Math.floor((elapsedSincePreparationMs / 1_000) * request.sampleRate),
    );
    return additionalSamples > 0
      ? request.audioData.subarray(additionalSamples)
      : request.audioData;
  }

  private async runPlaybackTransition<T>(
    lease: MutablePhysicalLease,
    transition: () => Promise<T>,
  ): Promise<T> {
    const previous = lease.playbackTransition;
    let releaseTransition!: () => void;
    const current = new Promise<void>((resolve) => { releaseTransition = resolve; });
    lease.playbackTransition = previous.then(() => current, () => current);
    await previous.catch(() => undefined);
    try {
      this.assertLeaseCanContinue(lease, 'physical lease ended before audio transition');
      return await transition();
    } finally {
      releaseTransition();
    }
  }

  private async startPlaybackGenerationLocked(
    lease: MutablePhysicalLease,
    request: PhysicalAudioPlaybackRequest,
    generation: number,
  ): Promise<{ started: boolean; completion: Promise<PhysicalTxResult> }> {
    this.assertLeaseCanContinue(lease, 'interrupted before starting audio generation');
    lease.playbackKind = request.playbackKind;
    let audioStarted = false;
    let resolveAudioStarted!: () => void;
    let rejectAudioStarted!: (error: unknown) => void;
    const audioStartPromise = new Promise<void>((resolve, reject) => {
      resolveAudioStarted = resolve;
      rejectAudioStarted = reject;
    });
    const audioPromise = Promise.resolve().then(() => this.deps.playAudio(
      request.audioData,
      request.sampleRate,
      {
        ...request.playbackOptions,
        playbackKind: request.playbackKind,
        onPlaybackStarted: () => {
          audioStarted = true;
          resolveAudioStarted();
        },
      },
    ));
    void audioPromise.then(() => {
      if (!audioStarted) {
        rejectAudioStarted(new Error('audio playback completed without hardware start acknowledgement'));
      }
    }, rejectAudioStarted);

    try {
      await this.withTimeout(audioStartPromise, 'audio start', this.audioStartTimeoutMs);
      this.assertLeaseCanContinue(lease, 'interrupted before audio start');
      if (lease.playbackGeneration !== generation) {
        return {
          started: false,
          completion: Promise.resolve(this.toPlaybackResult(
            lease,
            request,
            false,
            'audio generation superseded during start',
            undefined,
            true,
          )),
        };
      }
      if (this.deps.isAudioPlaying && !this.deps.isAudioPlaying(request.playbackKind)) {
        throw new Error('audio playback did not enter playing state');
      }

      if (request.frameId) lease.frameId = request.frameId;
      if (request.frameRevision !== undefined) lease.frameRevision = request.frameRevision;
      if (request.operatorIds) lease.operatorIds = [...new Set(request.operatorIds)];
      if (request.reason) lease.reason = request.reason;
      const playback: MutablePhysicalPlayback = {
        generation,
        frameId: request.frameId ?? lease.frameId,
        frameRevision: request.frameRevision ?? lease.frameRevision,
        operatorIds: [...(request.operatorIds ?? lease.operatorIds)],
        playbackKind: request.playbackKind,
        completion: audioPromise,
      };
      lease.activePlayback = playback;
      lease.phase = 'active';
      this.emitPhase(lease);
      return {
        started: true,
        completion: this.observePlaybackGeneration(lease, playback, request),
      };
    } catch (error) {
      this.trackPendingOperation(audioPromise);
      if (!lease.stopRequested) {
        const stopPromise = Promise.resolve().then(
          () => this.deps.stopCurrentPlayback({ kind: request.playbackKind }),
        );
        try {
          await this.withTimeout(stopPromise, 'audio cleanup', this.cleanupTimeoutMs);
        } catch {
          this.trackPendingOperation(stopPromise);
        }
      }
      return {
        started: false,
        completion: this.ensureReleased(lease, 'audio transmission failed', false, error),
      };
    }
  }

  private async observePlaybackGeneration(
    lease: MutablePhysicalLease,
    playback: MutablePhysicalPlayback,
    request: PhysicalAudioPlaybackRequest,
  ): Promise<PhysicalTxResult> {
    try {
      await playback.completion;
    } catch (error) {
      if (!this.isPlaybackCurrent(lease, playback)) {
        this.discardStale(lease, `audio-generation-${playback.generation}-error`);
        return this.toPlaybackResult(
          lease,
          playback,
          false,
          'audio generation replaced',
          error,
          true,
        );
      }
      if (lease.stopRequested) {
        return this.ensureReleased(lease, lease.reason || 'interrupted during playback', false, error);
      }
      if (!lease.stopRequested) {
        const stopPromise = Promise.resolve().then(
          () => this.deps.stopCurrentPlayback({ kind: playback.playbackKind }),
        );
        try {
          await this.withTimeout(stopPromise, 'audio cleanup', this.cleanupTimeoutMs);
        } catch {
          this.trackPendingOperation(stopPromise);
        }
      }
      return this.ensureReleased(lease, 'audio transmission failed', false, error);
    }

    if (!this.isPlaybackCurrent(lease, playback)) {
      this.discardStale(lease, `audio-generation-${playback.generation}-complete`);
      return this.toPlaybackResult(
        lease,
        playback,
        false,
        'audio generation replaced',
        undefined,
        true,
      );
    }
    if (lease.stopRequested) {
      return this.ensureReleased(lease, 'interrupted during playback', false);
    }

    lease.activePlayback = undefined;
    lease.drainingGeneration = playback.generation;
    lease.phase = 'draining';
    this.emitPhase(lease);
    if ((request.tailHoldMs ?? 0) > 0) {
      await this.sleep(request.tailHoldMs!);
    }
    if (!this.isCurrent(lease)
      || lease.playbackGeneration !== playback.generation
      || lease.drainingGeneration !== playback.generation
      || lease.activePlayback) {
      this.discardStale(lease, `audio-generation-${playback.generation}-tail`);
      return this.toPlaybackResult(
        lease,
        playback,
        false,
        'audio generation replaced during tail hold',
        undefined,
        true,
      );
    }
    lease.drainingGeneration = undefined;
    return this.ensureReleased(lease, 'audio completed', true);
  }

  private isPlaybackCurrent(lease: MutablePhysicalLease, playback: MutablePhysicalPlayback): boolean {
    return this.isCurrent(lease)
      && lease.playbackGeneration === playback.generation
      && lease.activePlayback?.generation === playback.generation;
  }

  private toPlaybackResult(
    lease: MutablePhysicalLease,
    playback: PhysicalPlaybackIdentity,
    success: boolean,
    reason: string,
    error?: unknown,
    leaseContinues = false,
  ): PhysicalTxResult {
    return {
      leaseId: lease.leaseId,
      frameId: playback.frameId,
      frameRevision: playback.frameRevision,
      source: lease.source,
      operatorIds: [...(playback.operatorIds ?? lease.operatorIds)],
      success,
      reason,
      error: error instanceof Error ? error.message : error === undefined ? undefined : String(error),
      physicalConfirmed: lease.everPttConfirmed,
      leaseContinues: leaseContinues || undefined,
    };
  }

  async releaseLease(leaseId: string, reason: string): Promise<PhysicalTxResult> {
    const lease = this.requireCurrentLease(leaseId);
    return this.ensureReleased(lease, reason, true);
  }

  markSelfKeyedLeaseActive(leaseId: string): void {
    const lease = this.requireCurrentLease(leaseId);
    if (lease.assertPtt) {
      throw new Error('only self-keyed leases can be confirmed by their source');
    }
    if (lease.stopRequested) throw new PhysicalTxInterruptedError();
    lease.pttConfirmed = true;
    lease.everPttConfirmed = true;
    lease.phase = 'active';
    this.emitPhase(lease);
  }

  markStreamingLeaseActive(leaseId: string): void {
    const lease = this.requireCurrentLease(leaseId);
    if (!lease.assertPtt || !lease.pttConfirmed) {
      throw new Error('streaming lease cannot become active before PTT is confirmed');
    }
    if (lease.stopRequested) throw new PhysicalTxInterruptedError();
    lease.phase = 'active';
    this.emitPhase(lease);
  }

  requestNormalStop(reason: string): 'idle' | 'deferred' {
    const lease = this.activeLease;
    if (!lease) return 'idle';
    lease.reason = reason;
    return 'deferred';
  }

  async forceInterrupt(reason: string): Promise<PhysicalTxResult | null> {
    const lease = this.activeLease;
    if (!lease) return null;
    if (lease.releasePromise) return lease.releasePromise;

    lease.stopRequested = true;
    lease.reason = reason;
    lease.phase = 'stopping';
    this.emitPhase(lease);

    const cleanupTasks: Promise<unknown>[] = [];
    if (lease.interrupt) cleanupTasks.push(Promise.resolve().then(() => lease.interrupt!()));
    if (lease.playbackKind) {
      cleanupTasks.push(Promise.resolve().then(() => this.deps.stopCurrentPlayback({ kind: lease.playbackKind })));
    }
    let interruptError: unknown;
    if (cleanupTasks.length > 0) {
      let cleanupSettled = false;
      const cleanupPromise = Promise.allSettled(cleanupTasks).then((results) => {
        const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (rejected) throw rejected.reason;
      }).finally(() => {
        cleanupSettled = true;
      });
      try {
        await this.withTimeout(
          cleanupPromise,
          'source cleanup',
          this.cleanupTimeoutMs,
        );
      } catch (error) {
        interruptError = error;
        if (!cleanupSettled) this.trackPendingOperation(cleanupPromise);
      }
    }
    return this.ensureReleased(lease, reason, false, interruptError);
  }

  async forceInterruptLease(leaseId: string, reason: string): Promise<PhysicalTxResult | null> {
    if (this.activeLease?.leaseId !== leaseId) {
      return null;
    }
    return this.forceInterrupt(reason);
  }

  async retryUnknownStop(reason: string): Promise<PhysicalTxResult | null> {
    const lease = this.activeLease;
    if (!lease || lease.phase !== 'unknown') return null;
    lease.releasePromise = undefined;
    lease.stopRequested = true;
    return this.ensureReleased(lease, reason, false);
  }

  private ensureReleased(
    lease: MutablePhysicalLease,
    reason: string,
    success: boolean,
    cause?: unknown,
  ): Promise<PhysicalTxResult> {
    if (lease.releasePromise) return lease.releasePromise;
    lease.releasePromise = this.releaseInternal(lease, reason, success, cause);
    return lease.releasePromise;
  }

  private async releaseInternal(
    lease: MutablePhysicalLease,
    reason: string,
    success: boolean,
    cause?: unknown,
  ): Promise<PhysicalTxResult> {
    lease.stopRequested = true;
    this.rejectLeaseActivation(lease, new PhysicalTxInterruptedError(reason));
    lease.phase = 'stopping';
    this.emitPhaseIfCurrent(lease);

    let pttReleaseError: unknown;
    try {
      if (lease.assertPtt && lease.pttStartPromise && !lease.pttConfirmed) {
        try {
          await this.withTimeout(lease.pttStartPromise, 'pending PTT start');
          lease.pttConfirmed = true;
          lease.everPttConfirmed = true;
        } catch {
          // A rejected start is safe once the explicit stop below succeeds. A
          // timed-out start remains unsafe because its late completion is still
          // fenced by pttStartSettlementPromise.
        }
      }
      if (lease.assertPtt && (lease.pttStartPromise || lease.pttConfirmed)) {
        let stopSettled = false;
        const stopPromise = Promise.resolve().then(() => this.deps.setPTT(false));
        void stopPromise.then(
          () => { stopSettled = true; },
          () => { stopSettled = true; },
        );
        try {
          await this.withTimeout(stopPromise, 'PTT stop');
        } catch (error) {
          if (!stopSettled) this.trackPendingOperation(stopPromise);
          throw error;
        }
      }
      if (lease.pttStartSettlementPromise) {
        await this.withTimeout(lease.pttStartSettlementPromise, 'pending PTT compensation');
      }
    } catch (error) {
      pttReleaseError = error;
    }

    if (pttReleaseError) {
      lease.phase = 'unknown';
      lease.reason = `${reason}: PTT release unconfirmed`;
      this.emitPhaseIfCurrent(lease);
      const result = this.toResult(lease, false, lease.reason, pttReleaseError);
      this.emitTerminalOnce(lease, result);
      return result;
    }

    if (lease.dialOffsetSettlementPromise) {
      const settlementPromise = lease.dialOffsetSettlementPromise;
      try {
        await this.withTimeout(settlementPromise, 'pending TX dial offset compensation');
      } catch (error) {
        // Do not immediately issue a second clear while the late native
        // compensation is still settling. Expose unknown and require the
        // explicit recovery path; otherwise a retry can race the old clear
        // and make the dial state of a newer frame ambiguous.
        lease.dialOffsetSettlementPromise = undefined;
        this.trackPendingOperation(settlementPromise);
        logger.warn('Deferred TX dial offset compensation did not settle cleanly', {
          leaseId: lease.leaseId,
          error: error instanceof Error ? error.message : String(error),
        });
        lease.phase = 'unknown';
        lease.reason = `${reason}: TX dial offset cleanup unconfirmed`;
        this.emitPhaseIfCurrent(lease);
        const result = this.toResult(lease, false, lease.reason, error);
        this.emitTerminalOnce(lease, result);
        return result;
      }
    }

    let dialCleanupError: unknown;
    try {
      let dialCleanupSettled = false;
      const dialCleanupPromise = Promise.resolve().then(() => this.deps.clearTxDialOffset?.());
      void dialCleanupPromise.then(
        () => { dialCleanupSettled = true; },
        () => { dialCleanupSettled = true; },
      );
      try {
        await this.withTimeout(dialCleanupPromise, 'TX dial offset cleanup');
      } catch (error) {
        if (!dialCleanupSettled) this.trackPendingOperation(dialCleanupPromise);
        throw error;
      }
      lease.dialOffsetApplied = false;
    } catch (error) {
      dialCleanupError = error;
      logger.warn('Failed to clear TX dial offset after PTT release', {
        leaseId: lease.leaseId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (dialCleanupError) {
      lease.phase = 'unknown';
      lease.reason = `${reason}: TX dial offset cleanup unconfirmed`;
      this.emitPhaseIfCurrent(lease);
      const result = this.toResult(lease, false, lease.reason, dialCleanupError);
      this.emitTerminalOnce(lease, result);
      return result;
    }

    lease.pttConfirmed = false;
    lease.reason = reason;
    const result = this.toResult(lease, success && !cause, reason, cause);
    this.emitTerminalOnce(lease, result);
    if (this.isCurrent(lease)) {
      this.activeLease = null;
      this.emit('phaseChanged', this.snapshot(null, reason));
    }
    return result;
  }

  private async handleLatePttStart(lease: MutablePhysicalLease): Promise<void> {
    if (this.isCurrent(lease) && !lease.stopRequested) return;
    this.discardStale(lease, 'ptt-start');
    if (this.activeLease && !this.isCurrent(lease)) {
      logger.error('Refusing stale PTT compensation while a newer lease is active', {
        staleLeaseId: lease.leaseId,
        activeLeaseId: this.activeLease.leaseId,
      });
      return;
    }
    try {
      // Do not abandon the underlying stop after a timeout. A late hardware
      // completion could otherwise turn off the next lease. The release path
      // remains bounded and exposes unknown until this promise really settles.
      await this.deps.setPTT(false);
      if (this.isCurrent(lease) && lease.phase === 'unknown') {
        lease.pttConfirmed = false;
        const result = this.toResult(lease, false, 'late PTT start compensated');
        this.emitTerminalOnce(lease, result);
        this.activeLease = null;
        this.emit('phaseChanged', this.snapshot(null, 'late PTT start compensated'));
      }
    } catch {
      // Keep the lease unknown. A user/device recovery must retry the stop.
    }
  }

  private requireCurrentLease(leaseId: string): MutablePhysicalLease {
    const lease = this.activeLease;
    if (!lease || lease.leaseId !== leaseId) {
      throw new PhysicalTxInterruptedError('physical transmission lease is no longer current');
    }
    return lease;
  }

  private assertLeaseCanContinue(lease: MutablePhysicalLease, message: string): void {
    if (!this.isCurrent(lease) || lease.stopRequested) {
      throw new PhysicalTxInterruptedError(message);
    }
  }

  private resolveLeaseActivation(lease: MutablePhysicalLease): void {
    if (lease.activationSettled) return;
    lease.activationSettled = true;
    lease.resolveActivation();
  }

  private rejectLeaseActivation(lease: MutablePhysicalLease, error: unknown): void {
    if (lease.activationSettled) return;
    lease.activationSettled = true;
    lease.rejectActivation(error);
  }

  private findLease(leaseId: string): MutablePhysicalLease | null {
    return this.activeLease?.leaseId === leaseId ? this.activeLease : null;
  }

  private isCurrent(lease: MutablePhysicalLease): boolean {
    return this.activeLease === lease && this.activeLease.epoch === lease.epoch;
  }

  private trackPendingOperation(operation: Promise<unknown>): void {
    const fence = operation.then(() => undefined, () => undefined);
    this.pendingOperationFences.add(fence);
    void fence.finally(() => {
      this.pendingOperationFences.delete(fence);
    });
  }

  private emitPhase(lease: MutablePhysicalLease): void {
    this.emit('phaseChanged', this.snapshot(lease));
  }

  private emitPhaseIfCurrent(lease: MutablePhysicalLease): void {
    if (this.isCurrent(lease)) this.emitPhase(lease);
  }

  private emitTerminalOnce(lease: MutablePhysicalLease, result: PhysicalTxResult): void {
    if (lease.terminalEmitted) return;
    lease.terminalEmitted = true;
    this.emit('terminal', result);
  }

  private discardStale(lease: MutablePhysicalLease, callback: string): void {
    this.staleCallbackDiscardCount += 1;
    this.emit('staleCallbackDiscarded', { leaseId: lease.leaseId, epoch: lease.epoch, callback });
  }

  private snapshot(lease: MutablePhysicalLease | null, reason?: string): PhysicalTxSnapshot {
    if (!lease) {
      return {
        leaseId: null,
        operatorIds: [],
        phase: 'idle',
        epoch: this.epoch,
        playbackGeneration: 0,
        pttConfirmed: false,
        reason,
      };
    }
    return {
      leaseId: lease.leaseId,
      frameId: lease.frameId,
      frameRevision: lease.frameRevision,
      source: lease.source,
      operatorIds: [...lease.operatorIds],
      phase: lease.phase,
      epoch: lease.epoch,
      playbackGeneration: lease.playbackGeneration,
      pttConfirmed: lease.pttConfirmed,
      startedAt: lease.startedAt,
      reason: lease.reason,
    };
  }

  private toResult(
    lease: MutablePhysicalLease,
    success: boolean,
    reason: string,
    error?: unknown,
  ): PhysicalTxResult {
    return {
      leaseId: lease.leaseId,
      frameId: lease.frameId,
      frameRevision: lease.frameRevision,
      source: lease.source,
      operatorIds: [...lease.operatorIds],
      success,
      reason,
      error: error instanceof Error ? error.message : error === undefined ? undefined : String(error),
      physicalConfirmed: lease.everPttConfirmed,
    };
  }

  private async withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = this.operationTimeoutMs): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
