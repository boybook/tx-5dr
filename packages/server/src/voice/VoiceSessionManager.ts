import { EventEmitter } from 'eventemitter3';
import type { VoicePTTLock } from '@tx5dr/contracts';
import { VoicePTTLockManager } from './VoicePTTLockManager.js';
import type { PhysicalRadioManager } from '../radio/PhysicalRadioManager.js';
import type { AudioStreamManager } from '../audio/AudioStreamManager.js';
import { createLogger } from '../utils/logger.js';
import {
  VoiceTxDiagnostics,
  type VoiceTxFrameMeta,
} from './VoiceTxDiagnostics.js';

const logger = createLogger('VoiceSessionManager');

export interface VoiceSessionManagerEvents {
  voicePttLockChanged: (lock: VoicePTTLock) => void;
  pttStatusChanged: (data: { isTransmitting: boolean; operatorIds: string[]; source: 'manual' | 'voice-keyer' }) => void;
  voiceRadioModeChanged: (data: { radioMode: string }) => void;
}

export interface VoiceSessionManagerDeps {
  radioManager: PhysicalRadioManager;
  audioStreamManager: AudioStreamManager;
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

  constructor(deps: VoiceSessionManagerDeps) {
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
      this.audioStreamManager.clearVoicePlaybackQueue();
      this.audioStreamManager.setVoiceTxOutputEnabled(false);
      this.diagnostics.startSession(clientId, label);

      // 2. Activate radio PTT
      await this.radioManager.setPTT(true);
      this.audioStreamManager.setVoiceTxOutputEnabled(true);

      // 3. Broadcast PTT status (frontend handles monitor muting via gain node)
      this.emit('pttStatusChanged', { isTransmitting: true, operatorIds: [], source: this.getPttSource(clientId) });

      logger.info('Voice transmission started', { clientId, label });
      return { success: true };
    } catch (err) {
      // Rollback on failure
      logger.error('Failed to start voice transmission, rolling back', err);
      try { await this.radioManager.setPTT(false); } catch { /* best effort */ }
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
    await this.radioManager.setMode(mode, undefined, { intent: 'voice' });
    this.emit('voiceRadioModeChanged', { radioMode: mode });
    logger.info('Radio mode changed', { mode });
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

  destroy(): void {
    this.audioStreamManager.setVoiceOutputObserver(null);
    this.pttLockManager.destroy();
    this.removeAllListeners();
  }

  // ---- Private helpers ----

  private async stopTransmitInternal(reason: string): Promise<void> {
    // 1. Deactivate radio PTT
    try {
      await this.radioManager.setPTT(false);
    } catch (err) {
      logger.error('Failed to deactivate radio PTT', err);
    }

    this.audioStreamManager.setVoiceTxOutputEnabled(false);
    this.audioStreamManager.clearVoicePlaybackQueue();
    this.diagnostics.endSession();

    // 2. Broadcast PTT status (frontend handles monitor unmuting via gain node)
    this.emit('pttStatusChanged', {
      isTransmitting: false,
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
