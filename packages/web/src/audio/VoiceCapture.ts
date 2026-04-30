import {
  createRealtimeTimingProbe,
  REALTIME_TIMING_PROBE_INTERVAL_MS,
} from '@tx5dr/core';
import {
  resolveVoiceTxBufferPolicy,
  type RealtimeConnectivityHints,
  type RealtimeTransportOffer,
  type RealtimeTransportKind,
  type RealtimeAudioCodecPreference,
  type ResolvedRealtimeAudioCodecPolicy,
  type ResolvedVoiceTxBufferPolicy,
  type VoiceTxBufferPreference,
} from '@tx5dr/contracts';
import { createLogger } from '../utils/logger';
import { normalizeWsUrl } from '../utils/config';
import {
  createCompatCaptureBackend,
  type CompatCaptureBackend,
} from './compatAudioBackends';
import {
  ensureInteractiveAudioContext,
  requestInteractiveMicrophone,
  closeAudioContext,
  stopMediaStream,
} from './audioRuntime';
import { executeRealtimeSessionFlow } from '../realtime/realtimeSessionFlow';
import { showRealtimeTransportFallbackToast } from '../realtime/realtimeConnectivity';
import { RtcDataAudioClient } from '../realtime/RtcDataAudioClient';
import {
  VoiceTxLocalStatsCollector,
  type VoiceTxLocalDiagnostics,
} from './voiceTxDiagnostics';
import { RealtimeClockSync, type RealtimeClockConfidence } from '../realtime/RealtimeClockSync';
import { VoiceTxUplinkSender, type VoiceTxUplinkSendResult } from './VoiceTxUplinkSender';
import {
  getRealtimeAudioCodecCapabilities,
  loadRealtimeAudioCodecPreference,
} from './realtimeAudioCodec';

const logger = createLogger('VoiceCapture');
const COMPAT_CAPTURE_CONNECT_TIMEOUT_MS = 5000;
const VOICE_TX_CLOCK_SYNC_INTERVAL_MS = 1000;
const VOICE_TX_CAPTURE_DIAGNOSTIC_INTERVAL_MS = 1000;
const VOICE_TX_PRE_PTT_STALE_GRACE_MS = 30;
const VOICE_TX_PTT_FLUSH_GUARD_MS = 40;
type AudioTrackConstraints = {
  sampleRate?: number;
  channelCount?: number;
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
};

interface VoiceTxCaptureDiagnosticsWindow {
  startedAt: number;
  frames: number;
  sent: number;
  skipped: number;
  dropped: number;
  degraded: number;
  intervalSumMs: number;
  intervalMaxMs: number;
  sendDurationSumMs: number;
  sendDurationMaxMs: number;
  bufferedAudioMaxMs: number;
  bufferedAmountMaxBytes: number;
  pendingOpusMax: number;
  sampleRate: number | null;
  samplesPerChannel: number | null;
  codec: 'opus' | 'pcm-s16le' | null;
  lastSequence: number | null;
  skipReasons: Record<string, number>;
}

export interface VoiceCaptureOptions {
  onStateChange?: (state: VoiceCaptureState) => void;
  onError?: (error: Error) => void;
}

interface VoiceCaptureStartOptions {
  transportOverride?: RealtimeTransportKind;
  voiceTxBufferPreference?: VoiceTxBufferPreference;
  audioCodecPreference?: RealtimeAudioCodecPreference;
}

interface VoiceCaptureCleanupOptions {
  preserveInteractiveRuntime?: boolean;
}

export type VoiceCaptureState = 'idle' | 'starting' | 'capturing' | 'error';

const AUDIO_CONSTRAINTS: AudioTrackConstraints = {
  sampleRate: 16000,
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

export class VoiceCapture {
  private options: VoiceCaptureOptions;
  private state: VoiceCaptureState = 'idle';
  private compatSocket: WebSocket | null = null;
  private rtcDataAudioClient: RtcDataAudioClient | null = null;
  private mediaStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private mediaSource: MediaStreamAudioSourceNode | null = null;
  private levelAnalyser: AnalyserNode | null = null;
  private levelAnalyserBuffer: Float32Array | null = null;
  private levelMonitorTimer: number | null = null;
  private captureBackend: CompatCaptureBackend | null = null;
  private captureBackendSourceConnected = false;
  private startPromise: Promise<void> | null = null;
  private pttActive = false;
  private _participantIdentity: string | null = null;
  private transportKind: RealtimeTransportKind | null = null;
  private _inputLevel = 0;
  private readonly localTxStats = new VoiceTxLocalStatsCollector();
  private readonly clockSync = new RealtimeClockSync();
  private clockSyncTimer: number | null = null;
  private timingProbeTimer: number | null = null;
  private timingProbeSequence = 0;
  private uplinkSender: VoiceTxUplinkSender | null = null;
  private activeTxBufferPolicy: ResolvedVoiceTxBufferPolicy | null = null;
  private activeAudioCodecPolicy: ResolvedRealtimeAudioCodecPolicy | null = null;
  private lastCaptureFrameAtMs: number | null = null;
  private lastCaptureDiagnosticsLogAtMs = 0;
  private captureDiagnosticsWindow: VoiceTxCaptureDiagnosticsWindow = this.createCaptureDiagnosticsWindow();
  private pttStartedAtMs: number | null = null;

  constructor(options: VoiceCaptureOptions) {
    this.options = options;
  }

  get captureState(): VoiceCaptureState {
    return this.state;
  }

  get isPTTActive(): boolean {
    return this.pttActive;
  }

  get participantIdentity(): string | null {
    return this._participantIdentity;
  }

  get currentTransportKind(): RealtimeTransportKind | null {
    return this.transportKind;
  }

  get inputLevel(): number {
    return this._inputLevel;
  }

  get diagnostics(): VoiceTxLocalDiagnostics {
    return this.localTxStats.getSnapshot();
  }

  get currentTxBufferPolicy(): ResolvedVoiceTxBufferPolicy | null {
    return this.activeTxBufferPolicy;
  }

  get currentAudioCodecPolicy(): ResolvedRealtimeAudioCodecPolicy | null {
    return this.activeAudioCodecPolicy;
  }

  async prepareCaptureFromGesture(): Promise<void> {
    await this.ensureCompatCaptureRuntime();
  }

  async ensureStartedFromGesture(options?: VoiceCaptureStartOptions): Promise<void> {
    await this.startFromGesture(options);
  }

  async startFromGesture(options?: VoiceCaptureStartOptions): Promise<void> {
    await this.prepareCaptureFromGesture();
    await this.start(options);
  }

  async switchTransportFromGesture(
    transport: RealtimeTransportKind,
    options?: Omit<VoiceCaptureStartOptions, 'transportOverride'>,
  ): Promise<void> {
    await this.prepareCaptureFromGesture();
    if (this.state === 'capturing') {
      this.cleanup({ preserveInteractiveRuntime: true });
      this.setState('idle');
    }
    await this.start({ ...options, transportOverride: transport });
  }

  async start(options?: VoiceCaptureStartOptions): Promise<void> {
    if (this.startPromise) {
      return this.startPromise;
    }

    this.setState('starting');

    this.startPromise = (async () => {
      try {
        const result = await executeRealtimeSessionFlow({
          scope: 'radio',
          direction: 'send',
          transportOverride: options?.transportOverride,
          voiceTxBufferPreference: options?.voiceTxBufferPreference,
          audioCodecPreference: options?.audioCodecPreference ?? loadRealtimeAudioCodecPreference(),
          audioCodecCapabilities: await getRealtimeAudioCodecCapabilities(),
          connectStage: 'connect',
          startCompat: (offer, txBufferPolicy, audioCodecPolicy) => this.startCompatCapture(offer, txBufferPolicy, audioCodecPolicy),
          startRtcDataAudio: (offer, hints, txBufferPolicy, audioCodecPolicy) => this.startRtcDataAudioCapture(offer, hints, txBufferPolicy, audioCodecPolicy),
          cleanupFailedAttempt: () => {
            this.cleanupTransportOnly({ preserveCaptureBackend: true });
          },
        });
        this.activeTxBufferPolicy = result.voiceTxBufferPolicy
          ?? resolveVoiceTxBufferPolicy(options?.voiceTxBufferPreference);
        this.activeAudioCodecPolicy = result.audioCodecPolicy;
        if (result.fallbackUsed) {
          showRealtimeTransportFallbackToast('radio');
        }
        this.transportKind = result.transport;
        this.setState('capturing');
      } catch (error) {
        logger.error('Failed to start voice capture', error);
        this.setState('error');
        this.options.onError?.(error as Error);
        this.cleanup();
        throw error;
      }
    })();

    try {
      await this.startPromise;
    } finally {
      if (this.state !== 'capturing') {
        this.startPromise = null;
      }
    }
  }

  stop(): void {
    if (this.state === 'idle') return;

    this.pttActive = false;
    this.cleanup();
    this.setState('idle');
  }

  setPTTActive(active: boolean): void {
    const changed = this.pttActive !== active;
    if (!active && changed) {
      this.maybeLogCaptureDiagnostics('ptt-stop', true);
    }
    this.pttActive = active;
    if (this.isVoiceTxDebugEnabled()) {
      logger.info('Voice TX PTT state changed', {
        active,
        transport: this.transportKind,
        participantIdentity: this._participantIdentity,
        txBufferPolicy: this.activeTxBufferPolicy,
        audioCodecPolicy: this.activeAudioCodecPolicy,
        clockSync: this.clockSync.getSnapshot(),
      });
    }

    if (active) {
      if (changed) {
        this.flushTxBoundary('ptt-start');
        this.pttStartedAtMs = Date.now();
        this.captureDiagnosticsWindow = this.createCaptureDiagnosticsWindow(this.pttStartedAtMs);
        this.lastCaptureFrameAtMs = null;
        this.lastCaptureDiagnosticsLogAtMs = 0;
      }
      this.stopTimingProbe();
      this.localTxStats.notePTTActivated();
    } else {
      if (changed) {
        this.pttStartedAtMs = null;
        this.flushTxBoundary('ptt-stop');
      }
      this.startTimingProbe();
    }
  }

  private flushTxBoundary(reason: string): void {
    try {
      this.uplinkSender?.reset();
    } catch (error) {
      logger.debug('Failed to reset voice TX uplink sender', { reason, error });
    }
    try {
      this.captureBackend?.reset();
    } catch (error) {
      logger.debug('Failed to reset voice TX capture backend', { reason, error });
    }
  }

  private shouldSendActivePttFrame(frame: CompatCaptureFrame): boolean {
    if (!this.pttActive) {
      return false;
    }
    const pttStartedAtMs = this.pttStartedAtMs;
    if (pttStartedAtMs !== null && (Date.now() - pttStartedAtMs) < VOICE_TX_PTT_FLUSH_GUARD_MS) {
      this.recordCaptureDiagnostics(frame, null, 'ptt-flush-guard');
      this.localTxStats.noteFrameSkipped(true);
      return false;
    }
    if (
      pttStartedAtMs !== null
      && typeof frame.capturedAtMs === 'number'
      && frame.capturedAtMs < (pttStartedAtMs - VOICE_TX_PRE_PTT_STALE_GRACE_MS)
    ) {
      this.recordCaptureDiagnostics(frame, null, 'pre-ptt-stale');
      this.localTxStats.noteFrameSkipped(true);
      if (this.isVoiceTxDebugEnabled()) {
        logger.info('Dropped stale pre-PTT voice TX capture frame', {
          capturedAtMs: frame.capturedAtMs,
          pttStartedAtMs,
          staleByMs: pttStartedAtMs - frame.capturedAtMs,
          transport: this.transportKind,
        });
      }
      return false;
    }
    return true;
  }

  private estimateServerTimeMs(clientTimeMs: number): number | null {
    const snapshot = this.clockSync.getSnapshot();
    if (
      snapshot.offsetMs === null
      || (snapshot.confidence !== 'medium' && snapshot.confidence !== 'high')
    ) {
      return null;
    }
    return clientTimeMs + snapshot.offsetMs;
  }

  private getClockConfidence(): RealtimeClockConfidence {
    return this.clockSync.getSnapshot().confidence;
  }

  private startClockSync(sendControl: (payload: object) => boolean | void): void {
    this.stopClockSync();
    this.clockSync.reset();

    const sendPing = () => {
      try {
        sendControl(this.clockSync.createPing(Date.now()));
      } catch (error) {
        logger.debug('Failed to send voice TX clock sync ping', error);
      }
    };

    sendPing();
    this.clockSyncTimer = window.setInterval(sendPing, VOICE_TX_CLOCK_SYNC_INTERVAL_MS);
  }

  private stopClockSync(): void {
    if (this.clockSyncTimer !== null) {
      window.clearInterval(this.clockSyncTimer);
      this.clockSyncTimer = null;
    }
    this.clockSync.reset();
  }

  private handleClockSyncControlMessage(message: unknown): void {
    this.clockSync.handlePong(message);
  }

  private startTimingProbe(): void {
    this.stopTimingProbe();
    const sendProbe = () => {
      if (this.pttActive) {
        return;
      }
      const probe = createRealtimeTimingProbe('voice-uplink', this.timingProbeSequence++);
      if (this.compatSocket?.readyState === WebSocket.OPEN) {
        this.compatSocket.send(JSON.stringify(probe));
      } else if (this.rtcDataAudioClient?.isOpen) {
        this.rtcDataAudioClient.sendJson(probe as unknown as Record<string, unknown>);
      }
    };
    sendProbe();
    this.timingProbeTimer = window.setInterval(sendProbe, REALTIME_TIMING_PROBE_INTERVAL_MS);
  }

  private stopTimingProbe(): void {
    if (this.timingProbeTimer !== null) {
      window.clearInterval(this.timingProbeTimer);
      this.timingProbeTimer = null;
    }
  }

  private async ensureCompatCaptureRuntime(): Promise<{
    mediaStream: MediaStream;
    audioContext: AudioContext;
    mediaSource: MediaStreamAudioSourceNode;
    captureBackend: CompatCaptureBackend;
  }> {
    const mediaStream = await requestInteractiveMicrophone(AUDIO_CONSTRAINTS, this.mediaStream);
    const audioContext = await ensureInteractiveAudioContext(this.audioContext);
    const mediaSource = this.mediaSource ?? audioContext.createMediaStreamSource(mediaStream);

    this.mediaStream = mediaStream;
    this.audioContext = audioContext;
    this.mediaSource = mediaSource;

    if (!this.captureBackend) {
      this.captureBackend = await createCompatCaptureBackend(audioContext);
      this.captureBackendSourceConnected = false;
    }

    if (!this.captureBackendSourceConnected) {
      mediaSource.connect(this.captureBackend.inputNode);
      this.captureBackendSourceConnected = true;
    }

    this.ensureInputLevelMonitor();
    return {
      mediaStream,
      audioContext,
      mediaSource,
      captureBackend: this.captureBackend,
    };
  }

  private async startCompatCapture(
    offer: RealtimeTransportOffer,
    txBufferPolicy?: ResolvedVoiceTxBufferPolicy,
    audioCodecPolicy?: ResolvedRealtimeAudioCodecPolicy,
  ): Promise<void> {
    const {
      mediaStream,
      audioContext,
      mediaSource,
      captureBackend,
    } = await this.ensureCompatCaptureRuntime();
    captureBackend.setFrameHandler(null);

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`${normalizeWsUrl(offer.url)}?token=${encodeURIComponent(offer.token)}`);
      ws.binaryType = 'arraybuffer';
      let resolved = false;
      const timer = window.setTimeout(() => {
        if (resolved) {
          return;
        }
        reject(new Error('Realtime compatibility uplink timed out before ready'));
      }, COMPAT_CAPTURE_CONNECT_TIMEOUT_MS);

      ws.onopen = () => {
        resolved = true;
        window.clearTimeout(timer);
        this.compatSocket = ws;
        resolve();
      };

      ws.onerror = () => {
        window.clearTimeout(timer);
        reject(new Error('Realtime compatibility uplink WebSocket failed'));
      };

      ws.onclose = () => {
        if (!resolved) {
          window.clearTimeout(timer);
          reject(new Error('Realtime compatibility uplink closed before ready'));
        }
      };
    });

    if (this.compatSocket) {
      this.compatSocket.onclose = () => {
        logger.warn('Realtime compatibility uplink closed unexpectedly');
      };
    }

    let hasLoggedFirstCompatFrame = false;
    const sender = new VoiceTxUplinkSender({
      transport: 'ws-compat',
      sendBinary: (payload) => {
        if (!this.compatSocket || this.compatSocket.readyState !== WebSocket.OPEN) {
          return false;
        }
        this.compatSocket.send(payload);
        return true;
      },
      getBufferedAmount: () => this.compatSocket?.bufferedAmount ?? null,
      estimateServerTimeMs: (clientTimeMs) => this.estimateServerTimeMs(clientTimeMs),
      getClockConfidence: () => this.getClockConfidence(),
      txBufferPolicy,
      audioCodecPolicy,
    });
    this.uplinkSender = sender;
    this.localTxStats.reset('ws-compat');

    if (this.compatSocket) {
      this.compatSocket.onmessage = (event) => {
        if (typeof event.data !== 'string') {
          return;
        }
        try {
          this.handleClockSyncControlMessage(JSON.parse(event.data) as unknown);
        } catch {
          // ignore non-JSON control frames
        }
      };
    }
    this.startClockSync((payload) => {
      if (!this.compatSocket || this.compatSocket.readyState !== WebSocket.OPEN) {
        return false;
      }
      this.compatSocket.send(JSON.stringify(payload));
      return true;
    });
    this.startTimingProbe();

    captureBackend.setFrameHandler((frame) => {
      if (!this.shouldSendActivePttFrame(frame)) {
        return;
      }
      if (!this.compatSocket || this.compatSocket.readyState !== WebSocket.OPEN || this.uplinkSender !== sender) {
        this.recordCaptureDiagnostics(frame, null, 'transport-not-open');
        this.localTxStats.noteFrameSkipped();
        return;
      }

      try {
        const result = sender.sendFrame(frame);
        this.recordCaptureDiagnostics(frame, result);
        if (!result.sent) {
          this.localTxStats.noteFrameSkipped(result.dropped);
          return;
        }
        this.localTxStats.noteFrameSent(
          result.samplesPerChannel,
          result.sendDurationMs,
          result.bufferedAmountBytes,
          result.bufferedAudioMs,
          sender.clockConfidence,
          result.degraded,
          result.codec,
          result.bitrateKbps,
        );
        if (!hasLoggedFirstCompatFrame) {
          hasLoggedFirstCompatFrame = true;
          logger.info('First compatibility uplink audio frame sent', {
            sampleRate: frame.sampleRate,
            samplesPerChannel: frame.samplesPerChannel,
          });
        }
      } catch (error) {
        this.recordCaptureDiagnostics(frame, null, 'send-error');
        logger.debug('Failed to send compatibility uplink audio frame', error);
      }
    });

    this.transportKind = 'ws-compat';
    this.mediaStream = mediaStream;
    this.audioContext = audioContext;
    this.mediaSource = mediaSource;
    this.ensureInputLevelMonitor();
    this.captureBackend = captureBackend;
    this._participantIdentity = offer.participantIdentity ?? null;

    logger.info('Voice capture connected via compatibility WebSocket', {
      participantIdentity: offer.participantIdentity,
    });
  }


  private async startRtcDataAudioCapture(
    offer: RealtimeTransportOffer,
    hints?: RealtimeConnectivityHints,
    txBufferPolicy?: ResolvedVoiceTxBufferPolicy,
    audioCodecPolicy?: ResolvedRealtimeAudioCodecPolicy,
  ): Promise<void> {
    const {
      mediaStream,
      audioContext,
      mediaSource,
      captureBackend,
    } = await this.ensureCompatCaptureRuntime();
    captureBackend.setFrameHandler(null);
    const client = new RtcDataAudioClient({
      offer,
      iceServers: hints?.iceServers,
      onControlMessage: (message) => {
        this.handleClockSyncControlMessage(message);
      },
      onClose: () => {
        if (this.rtcDataAudioClient === client) {
          logger.warn('rtc-data-audio uplink closed unexpectedly');
        }
      },
    });
    this.rtcDataAudioClient = client;
    await client.connect();
    this.startClockSync((payload) => client.sendJson(payload as Record<string, unknown>));
    this.startTimingProbe();

    let hasLoggedFirstFrame = false;
    const sender = new VoiceTxUplinkSender({
      transport: 'rtc-data-audio',
      sendBinary: (payload) => client.sendBinary(payload),
      getBufferedAmount: () => client.bufferedAmount,
      estimateServerTimeMs: (clientTimeMs) => this.estimateServerTimeMs(clientTimeMs),
      getClockConfidence: () => this.getClockConfidence(),
      txBufferPolicy,
      audioCodecPolicy,
    });
    this.uplinkSender = sender;
    this.localTxStats.reset('rtc-data-audio');

    captureBackend.setFrameHandler((frame) => {
      if (!this.shouldSendActivePttFrame(frame)) {
        return;
      }
      if (!this.rtcDataAudioClient?.isOpen || this.uplinkSender !== sender) {
        this.recordCaptureDiagnostics(frame, null, 'transport-not-open');
        this.localTxStats.noteFrameSkipped();
        return;
      }

      try {
        const result = sender.sendFrame(frame);
        this.recordCaptureDiagnostics(frame, result);
        if (!result.sent) {
          this.localTxStats.noteFrameSkipped(result.dropped);
          return;
        }
        this.localTxStats.noteFrameSent(
          result.samplesPerChannel,
          result.sendDurationMs,
          result.bufferedAmountBytes,
          result.bufferedAudioMs,
          sender.clockConfidence,
          result.degraded,
          result.codec,
          result.bitrateKbps,
        );
        if (!hasLoggedFirstFrame) {
          hasLoggedFirstFrame = true;
          logger.info('First rtc-data-audio uplink audio frame sent', {
            sampleRate: frame.sampleRate,
            samplesPerChannel: frame.samplesPerChannel,
          });
        }
      } catch (error) {
        this.recordCaptureDiagnostics(frame, null, 'send-error');
        logger.debug('Failed to send rtc-data-audio uplink audio frame', error);
      }
    });

    this.transportKind = 'rtc-data-audio';
    this.mediaStream = mediaStream;
    this.audioContext = audioContext;
    this.mediaSource = mediaSource;
    this.ensureInputLevelMonitor();
    this.captureBackend = captureBackend;
    this._participantIdentity = offer.participantIdentity ?? null;

    logger.info('Voice capture connected via rtc-data-audio', {
      participantIdentity: offer.participantIdentity,
    });
  }

  private setState(state: VoiceCaptureState): void {
    this.state = state;
    this.options.onStateChange?.(state);
  }

  private ensureInputLevelMonitor(): void {
    if (!this.audioContext || !this.mediaSource) {
      return;
    }

    if (!this.levelAnalyser) {
      const analyser = this.audioContext.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.65;
      this.mediaSource.connect(analyser);
      this.levelAnalyser = analyser;
      this.levelAnalyserBuffer = new Float32Array(analyser.fftSize);
    }

    if (this.levelMonitorTimer !== null) {
      return;
    }

    this.levelMonitorTimer = window.setInterval(() => {
      this.sampleInputLevel();
    }, 50);
  }

  private sampleInputLevel(): void {
    if (!this.levelAnalyser || !this.levelAnalyserBuffer) {
      this._inputLevel = 0;
      return;
    }

    this.levelAnalyser.getFloatTimeDomainData(this.levelAnalyserBuffer);

    let sumSquares = 0;
    let peak = 0;
    for (const sample of this.levelAnalyserBuffer) {
      const amplitude = Math.abs(sample);
      sumSquares += sample * sample;
      if (amplitude > peak) {
        peak = amplitude;
      }
    }

    const rms = Math.sqrt(sumSquares / this.levelAnalyserBuffer.length);
    const rmsDb = 20 * Math.log10(Math.max(rms, 1e-4));
    const normalizedRms = Math.max(0, Math.min(1, (rmsDb + 55) / 45));
    const normalizedPeak = Math.max(0, Math.min(1, peak * 1.25));
    const nextLevel = Math.max(normalizedRms, normalizedPeak * 0.85);
    const smoothedLevel = nextLevel >= this._inputLevel
      ? nextLevel
      : (this._inputLevel * 0.8) + (nextLevel * 0.2);

    this._inputLevel = smoothedLevel < 0.01 ? 0 : smoothedLevel;
  }

  private resetInputLevelMonitor(): void {
    if (this.levelMonitorTimer !== null) {
      window.clearInterval(this.levelMonitorTimer);
      this.levelMonitorTimer = null;
    }

    if (this.levelAnalyser) {
      try {
        this.levelAnalyser.disconnect();
      } catch {
        // ignore
      }
      this.levelAnalyser = null;
    }

    this.levelAnalyserBuffer = null;
    this._inputLevel = 0;
  }

  private cleanupTransportOnly(options: { preserveCaptureBackend?: boolean } = {}): void {
    const preserveCaptureBackend = options.preserveCaptureBackend === true;
    this.maybeLogCaptureDiagnostics('cleanup', true);

    if (this.captureBackend) {
      this.captureBackend.setFrameHandler(null);
      if (!preserveCaptureBackend) {
        try {
          this.captureBackend.close();
        } catch {
          // ignore
        }
        this.captureBackend = null;
        this.captureBackendSourceConnected = false;
      }
    }

    if (this.compatSocket) {
      try {
        this.compatSocket.close();
      } catch {
        // ignore
      }
      this.compatSocket = null;
    }

    if (this.rtcDataAudioClient) {
      try {
        this.rtcDataAudioClient.close();
      } catch {
        // ignore
      }
      this.rtcDataAudioClient = null;
    }

    this.transportKind = null;
    this._participantIdentity = null;
    this.activeTxBufferPolicy = null;
    this.activeAudioCodecPolicy = null;
    this.uplinkSender = null;
    this.pttStartedAtMs = null;
    this.stopTimingProbe();
    this.stopClockSync();
    this.localTxStats.reset(null);
    this.lastCaptureFrameAtMs = null;
    this.lastCaptureDiagnosticsLogAtMs = 0;
    this.captureDiagnosticsWindow = this.createCaptureDiagnosticsWindow();
  }

  private cleanup(options: VoiceCaptureCleanupOptions = {}): void {
    const { preserveInteractiveRuntime = false } = options;

    this.cleanupTransportOnly({ preserveCaptureBackend: preserveInteractiveRuntime });

    if (!preserveInteractiveRuntime) {
      this.resetInputLevelMonitor();
    }

    if (!preserveInteractiveRuntime && this.mediaSource) {
      try {
        this.mediaSource.disconnect();
      } catch {
        // ignore
      }
      this.mediaSource = null;
      this.captureBackendSourceConnected = false;
    }

    if (!preserveInteractiveRuntime) {
      stopMediaStream(this.mediaStream);
      this.mediaStream = null;
    }

    if (!preserveInteractiveRuntime) {
      void closeAudioContext(this.audioContext);
      this.audioContext = null;
    }

    this.startPromise = null;
  }

  private createCaptureDiagnosticsWindow(now = Date.now()): VoiceTxCaptureDiagnosticsWindow {
    return {
      startedAt: now,
      frames: 0,
      sent: 0,
      skipped: 0,
      dropped: 0,
      degraded: 0,
      intervalSumMs: 0,
      intervalMaxMs: 0,
      sendDurationSumMs: 0,
      sendDurationMaxMs: 0,
      bufferedAudioMaxMs: 0,
      bufferedAmountMaxBytes: 0,
      pendingOpusMax: 0,
      sampleRate: null,
      samplesPerChannel: null,
      codec: null,
      lastSequence: null,
      skipReasons: {},
    };
  }

  private isVoiceTxDebugEnabled(): boolean {
    try {
      return window.localStorage.getItem('tx5dr.debug.voiceTx') === '1'
        || window.localStorage.getItem('tx5dr.debug.realtimeAudio') === '1';
    } catch {
      return false;
    }
  }

  private recordCaptureDiagnostics(
    frame: { sampleRate: number; samplesPerChannel: number },
    result: VoiceTxUplinkSendResult | null,
    skippedReason?: string,
  ): void {
    if (!this.isVoiceTxDebugEnabled()) {
      return;
    }
    const now = Date.now();
    const windowStats = this.captureDiagnosticsWindow;
    if (this.lastCaptureFrameAtMs !== null) {
      const intervalMs = Math.max(0, now - this.lastCaptureFrameAtMs);
      windowStats.intervalSumMs += intervalMs;
      windowStats.intervalMaxMs = Math.max(windowStats.intervalMaxMs, intervalMs);
    }
    this.lastCaptureFrameAtMs = now;
    windowStats.frames += 1;
    windowStats.sampleRate = frame.sampleRate;
    windowStats.samplesPerChannel = frame.samplesPerChannel;

    if (result) {
      if (result.sent) {
        windowStats.sent += 1;
      } else {
        windowStats.skipped += 1;
      }
      if (result.dropped) {
        windowStats.dropped += 1;
      }
      if (result.degraded) {
        windowStats.degraded += 1;
      }
      windowStats.sendDurationSumMs += result.sendDurationMs;
      windowStats.sendDurationMaxMs = Math.max(windowStats.sendDurationMaxMs, result.sendDurationMs);
      windowStats.bufferedAudioMaxMs = Math.max(windowStats.bufferedAudioMaxMs, result.bufferedAudioMs ?? 0);
      windowStats.bufferedAmountMaxBytes = Math.max(windowStats.bufferedAmountMaxBytes, result.bufferedAmountBytes ?? 0);
      windowStats.pendingOpusMax = Math.max(windowStats.pendingOpusMax, result.pendingOpusFrames);
      windowStats.codec = result.codec;
      windowStats.lastSequence = result.sequence;
    } else {
      windowStats.skipped += 1;
    }

    if (skippedReason) {
      windowStats.skipReasons[skippedReason] = (windowStats.skipReasons[skippedReason] ?? 0) + 1;
    } else if (result?.dropped) {
      windowStats.skipReasons.transportBackpressure = (windowStats.skipReasons.transportBackpressure ?? 0) + 1;
    } else if (result && !result.sent) {
      windowStats.skipReasons.sendReturnedFalse = (windowStats.skipReasons.sendReturnedFalse ?? 0) + 1;
    }

    this.maybeLogCaptureDiagnostics('frame');
  }

  private maybeLogCaptureDiagnostics(reason: string, force = false): void {
    if (!this.isVoiceTxDebugEnabled()) {
      return;
    }
    const now = Date.now();
    if (!force && (now - this.lastCaptureDiagnosticsLogAtMs) < VOICE_TX_CAPTURE_DIAGNOSTIC_INTERVAL_MS) {
      return;
    }
    const stats = this.captureDiagnosticsWindow;
    const avg = (sum: number, count: number): number | null => count > 0 ? sum / count : null;
    logger.info('Voice TX capture diagnostics', {
      reason,
      elapsedMs: Math.max(1, now - stats.startedAt),
      transport: this.transportKind,
      participantIdentity: this._participantIdentity,
      pttActive: this.pttActive,
      frames: stats.frames,
      sent: stats.sent,
      skipped: stats.skipped,
      dropped: stats.dropped,
      degraded: stats.degraded,
      avgFrameIntervalMs: avg(stats.intervalSumMs, Math.max(0, stats.frames - 1)),
      maxFrameIntervalMs: stats.intervalMaxMs,
      avgSendDurationMs: avg(stats.sendDurationSumMs, stats.frames),
      maxSendDurationMs: stats.sendDurationMaxMs,
      bufferedAudioMaxMs: stats.bufferedAudioMaxMs,
      bufferedAmountMaxBytes: stats.bufferedAmountMaxBytes,
      pendingOpusMax: stats.pendingOpusMax,
      sampleRate: stats.sampleRate,
      samplesPerChannel: stats.samplesPerChannel,
      codec: stats.codec,
      lastSequence: stats.lastSequence,
      skipReasons: stats.skipReasons,
      clockSync: this.clockSync.getSnapshot(),
      txBufferPolicy: this.activeTxBufferPolicy,
      audioCodecPolicy: this.activeAudioCodecPolicy,
    });
    this.lastCaptureDiagnosticsLogAtMs = now;
    this.captureDiagnosticsWindow = this.createCaptureDiagnosticsWindow(now);
  }
}
