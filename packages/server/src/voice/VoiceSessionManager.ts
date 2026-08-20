import { EventEmitter } from 'eventemitter3';
import type { VoicePTTLock } from '@tx5dr/contracts';
import { VoicePTTLockManager } from './VoicePTTLockManager.js';
import type { PhysicalRadioManager } from '../radio/PhysicalRadioManager.js';
import type { AudioStreamManager } from '../audio/AudioStreamManager.js';
import type { PhysicalTxCoordinator } from '../transmission/PhysicalTxCoordinator.js';
import { ConfigManager } from '../config/config-manager.js';
import { createLogger } from '../utils/logger.js';
import {
  VoiceTxDiagnostics,
  type VoiceTxFrameMeta,
} from './VoiceTxDiagnostics.js';

const logger = createLogger('VoiceSessionManager');
const LEGACY_VOICE_RADIO_MODES = new Set(['USB', 'LSB', 'FM', 'AM']);
const EXPLICIT_SUPPORT_REQUIRED_MODES = new Set(['WFM']);

export interface VoiceSessionManagerEvents {
  voicePttLockChanged: (lock: VoicePTTLock) => void;
  pttStatusChanged: (data: { isTransmitting: boolean; operatorIds: string[]; source: 'manual' | 'voice-keyer' }) => void;
  voiceRadioModeChanged: (data: { radioMode: string }) => void;
}

export interface VoiceSessionManagerDeps {
  radioManager: PhysicalRadioManager;
  audioStreamManager: AudioStreamManager;
  onBeforeStartPTT?: () => Promise<void>;
  physicalTxCoordinator: PhysicalTxCoordinator;
}

/**
 * Voice session orchestrator.
 * Coordinates PTT locking, audio receiving, and radio PTT.
 */
export class VoiceSessionManager extends EventEmitter<VoiceSessionManagerEvents> {
  private pttLockManager: VoicePTTLockManager;
  private radioManager: PhysicalRadioManager;
  private audioStreamManager: AudioStreamManager;
  private isStarted = false;
  private diagnostics = new VoiceTxDiagnostics();
  private physicalLeaseId: string | null = null;
  private transmitGeneration = 0;

  constructor(private readonly deps: VoiceSessionManagerDeps) {
    super();
    this.radioManager = deps.radioManager;
    this.audioStreamManager = deps.audioStreamManager;
    this.pttLockManager = new VoicePTTLockManager();

    // Forward lock change events
    this.pttLockManager.on('lockChanged', (lock) => {
      this.emit('voicePttLockChanged', lock);
    });

    this.audioStreamManager.setVoiceOutputObserver({
      onFrameEnqueued: ({ queueDepthFrames, queuedAudioMs }) => {
        this.diagnostics.noteQueueState(queueDepthFrames, queuedAudioMs);
      },
      onFrameDropped: ({ queueDepthFrames, queuedAudioMs, reason }) => {
        this.diagnostics.noteDropped(queueDepthFrames, queuedAudioMs, reason);
      },
      onFrameProcessed: (stats) => {
        this.diagnostics.noteProcessed(stats);
      },
      onWriteFailure: () => {
        this.diagnostics.noteWriteFailure();
      },
    });
  }

  async initialize(): Promise<void> {
    logger.info('Voice session manager initialized');
  }

  async start(): Promise<void> {
    if (this.isStarted) return;
    this.isStarted = true;
    logger.info('Voice session manager started');
  }

  async stop(): Promise<void> {
    if (!this.isStarted) return;

    // If PTT is active, force release
    if (this.pttLockManager.isLocked()) {
      const holder = this.pttLockManager.getLockHolder();
      if (holder) {
        await this.stopTransmitInternal('engine stopped');
      }
    }

    this.isStarted = false;
    logger.info('Voice session manager stopped');
  }

  /**
   * Start voice transmission for a client.
   * Acquires PTT lock → activates radio PTT → starts audio receiving.
   * @param voiceAudioClientId - Voice audio WS client ID to associate with this PTT session
   */
  async startTransmit(clientId: string, label: string, voiceAudioClientId?: string): Promise<{ success: boolean; reason?: string }> {
    if (!this.isStarted) {
      return { success: false, reason: 'Voice mode not active' };
    }

    // 1. Acquire PTT lock (with associated voice audio client ID)
    const lockResult = this.pttLockManager.requestLock(clientId, label, voiceAudioClientId);
    if (!lockResult.success) {
      return lockResult;
    }

    try {
      const transmitGeneration = ++this.transmitGeneration;
      this.audioStreamManager.clearVoicePlaybackQueue();
      this.audioStreamManager.setVoiceTxOutputEnabled(false);
      this.diagnostics.startSession(clientId, label);

      // 2. Acquire the single physical PTT lease.
      const leaseId = await this.deps.physicalTxCoordinator.acquireLease({
        source: this.getPttSource(clientId),
        reason: `voice transmit: ${label}`,
        beforeStart: this.deps.onBeforeStartPTT,
        deferActiveUntilAudio: true,
        interrupt: async () => {
          this.audioStreamManager.setVoiceTxOutputEnabled(false);
          this.audioStreamManager.clearVoicePlaybackQueue();
          if (this.getPttSource(clientId) === 'voice-keyer') {
            await this.audioStreamManager.stopCurrentPlayback({ kind: 'voice-keyer' });
          }
        },
      });
      if (this.transmitGeneration !== transmitGeneration
        || this.pttLockManager.getLockHolder() !== clientId) {
        await this.deps.physicalTxCoordinator.forceInterruptLease(
          leaseId,
          'voice transmission cancelled while starting',
        );
        return { success: false, reason: 'Voice transmission was cancelled while starting' };
      }
      this.physicalLeaseId = leaseId;
      this.audioStreamManager.setVoiceTxOutputEnabled(true);
      this.deps.physicalTxCoordinator.markStreamingLeaseActive(leaseId);

      // 3. Broadcast PTT status (frontend handles monitor muting via gain node)
      this.emit('pttStatusChanged', { isTransmitting: true, operatorIds: [], source: this.getPttSource(clientId) });

      logger.info('Voice transmission started', { clientId, label });
      return { success: true };
    } catch (err) {
      // Rollback on failure
      logger.error('Failed to start voice transmission, rolling back', err);
      if (this.physicalLeaseId) {
        await this.deps.physicalTxCoordinator.forceInterruptLease(
          this.physicalLeaseId,
          'voice start rollback',
        ).catch(() => undefined);
        this.physicalLeaseId = null;
      }
      this.pttLockManager.releaseLock(clientId);
      this.audioStreamManager.setVoiceTxOutputEnabled(false);
      this.audioStreamManager.clearVoicePlaybackQueue();
      this.diagnostics.endSession();
      return { success: false, reason: 'Failed to activate PTT' };
    }
  }

  /**
   * Stop voice transmission for a client.
   */
  async stopTransmit(clientId: string): Promise<boolean> {
    if (!this.pttLockManager.isLocked()) return true;
    if (this.pttLockManager.getLockHolder() !== clientId) return false;

    await this.stopTransmitInternal('released by client');
    this.pttLockManager.releaseLock(clientId);
    return true;
  }

  /**
   * Handle client disconnect - auto-release PTT if held.
   */
  async handleClientDisconnect(clientId: string): Promise<void> {
    if (this.pttLockManager.isLocked() && this.pttLockManager.getLockHolder() === clientId) {
      logger.info('Client disconnected while holding PTT, auto-releasing', { clientId });
      await this.stopTransmitInternal('client disconnected');
      this.pttLockManager.handleClientDisconnect(clientId);
    }
  }

  /**
   * Set the radio modulation mode (USB/LSB/FM/AM).
   */
  async setRadioMode(mode: string): Promise<void> {
    const normalizedMode = mode.trim().toUpperCase();
    if (!normalizedMode) {
      throw new Error('radio mode is required');
    }

    const supportedModes = this.radioManager.getSupportedRadioModeOptions?.() ?? [];
    const hasCapabilityModeList = supportedModes.length > 0;
    const isSupported = hasCapabilityModeList
      ? supportedModes.includes(normalizedMode)
      : LEGACY_VOICE_RADIO_MODES.has(normalizedMode);
    if (!isSupported || (!hasCapabilityModeList && EXPLICIT_SUPPORT_REQUIRED_MODES.has(normalizedMode))) {
      throw new Error(`Radio mode '${normalizedMode}' is not supported by the current radio`);
    }

    await this.radioManager.setMode(normalizedMode, undefined, { intent: 'voice' });
    if (normalizedMode !== 'FM') {
      try {
        await this.radioManager.applyRepeaterDuplexConfig({ repeaterShift: 'none' });
        await this.radioManager.applyToneSquelchConfig({ toneMode: 'none' });
      } catch (error) {
        logger.warn('Failed to clear FM-only voice settings after radio mode change', error);
      }
    }

    const configManager = ConfigManager.getInstance();
    const lastVoice = configManager.getLastVoiceFrequency();
    if (lastVoice?.frequency) {
      await configManager.updateLastVoiceFrequency({
        frequency: lastVoice.frequency,
        radioMode: normalizedMode,
        band: lastVoice.band,
        description: lastVoice.description,
        ...(normalizedMode === 'FM'
          ? {
            repeaterShift: lastVoice.repeaterShift,
            repeaterOffsetHz: lastVoice.repeaterOffsetHz,
            toneMode: lastVoice.toneMode,
            ctcssToneTenthsHz: lastVoice.ctcssToneTenthsHz,
            dcsCode: lastVoice.dcsCode,
          }
          : {
            repeaterShift: 'none',
            toneMode: 'none',
          }),
      });
    }
    this.emit('voiceRadioModeChanged', { radioMode: normalizedMode });
    logger.info('Radio mode changed', { mode: normalizedMode });
  }

  async handleParticipantAudioFrame(meta: VoiceTxFrameMeta, pcmData: Float32Array): Promise<void> {
    if (!this.pttLockManager.isLocked()) {
      return;
    }

    const associatedParticipantIdentity = this.pttLockManager.getVoiceAudioClientId();
    if (!associatedParticipantIdentity || meta.participantIdentity !== associatedParticipantIdentity) {
      return;
    }

    this.diagnostics.noteIngress(meta);
    await this.audioStreamManager.playVoiceAudio(pcmData, meta.sampleRate, meta);
  }

  recordParticipantTimingProbe(data: {
    participantIdentity: string;
    transport: VoiceTxFrameMeta['transport'];
    codec?: VoiceTxFrameMeta['codec'];
    sequence: number;
    sentAtMs: number;
    receivedAtMs: number;
    intervalMs: number;
    voiceTxBufferPolicy?: VoiceTxFrameMeta['voiceTxBufferPolicy'];
  }): void {
    const activeParticipantIdentity = this.pttLockManager.getVoiceAudioClientId();
    const probeAction = this.pttLockManager.isLocked()
      ? (data.participantIdentity === activeParticipantIdentity ? 'active' : 'seed-only')
      : 'seed-only';
    if (process.env.TX5DR_DEBUG_REALTIME_JITTER === '1') {
      logger.debug('Voice TX timing probe routed', {
        probeAction,
        activeParticipantIdentity,
        incomingParticipantIdentity: data.participantIdentity,
        transport: data.transport,
        codec: data.codec,
      });
    }
    this.audioStreamManager.recordVoiceTxTimingProbe(data);
  }

  getTxDiagnosticsSnapshot() {
    return this.diagnostics.getSnapshot();
  }

  getPTTLockState(): VoicePTTLock {
    return this.pttLockManager.getLockState();
  }

  getIsTransmitting(): boolean {
    return this.pttLockManager.isLocked();
  }

  getActiveVoiceAudioClientId(): string | null {
    return this.pttLockManager.getVoiceAudioClientId();
  }

  destroy(): void {
    this.audioStreamManager.setVoiceOutputObserver(null);
    this.pttLockManager.destroy();
    this.removeAllListeners();
  }

  // ---- Private helpers ----

  private async stopTransmitInternal(reason: string): Promise<void> {
    ++this.transmitGeneration;
    // 1. Release only the lease owned by this voice session.
    let pttStillUncertain = false;
    if (this.physicalLeaseId) {
      try {
        const result = await this.deps.physicalTxCoordinator.releaseLease(this.physicalLeaseId, reason);
        pttStillUncertain = !result.success
          && this.deps.physicalTxCoordinator.getSnapshot().phase === 'unknown';
        if (!pttStillUncertain) this.physicalLeaseId = null;
      } catch (err) {
        pttStillUncertain = this.deps.physicalTxCoordinator.getSnapshot().phase === 'unknown';
        logger.error('Failed to release voice PTT lease', err);
      }
    }

    this.audioStreamManager.setVoiceTxOutputEnabled(false);
    this.audioStreamManager.clearVoicePlaybackQueue();
    this.diagnostics.endSession();

    // 2. Broadcast PTT status (frontend handles monitor unmuting via gain node)
    this.emit('pttStatusChanged', {
      isTransmitting: pttStillUncertain,
      operatorIds: [],
      source: this.getPttSource(this.pttLockManager.getLockHolder()),
    });

    logger.info('Voice transmission stopped', { reason });
  }

  private getPttSource(clientId: string | null | undefined): 'manual' | 'voice-keyer' {
    return typeof clientId === 'string' && clientId.startsWith('voice-keyer:')
      ? 'voice-keyer'
      : 'manual';
  }
}
