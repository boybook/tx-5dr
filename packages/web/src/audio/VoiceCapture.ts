import type { RealtimeConnectivityHints, RealtimeTransportOffer, RealtimeTransportKind } from '@tx5dr/contracts';
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
import { VoiceTxUplinkSender } from './VoiceTxUplinkSender';

const logger = createLogger('VoiceCapture');
const COMPAT_CAPTURE_CONNECT_TIMEOUT_MS = 5000;
const VOICE_TX_CLOCK_SYNC_INTERVAL_MS = 1000;
type AudioTrackConstraints = {
  sampleRate?: number;
  channelCount?: number;
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
};

export interface VoiceCaptureOptions {
  onStateChange?: (state: VoiceCaptureState) => void;
  onError?: (error: Error) => void;
}

interface VoiceCaptureStartOptions {
  transportOverride?: RealtimeTransportKind;
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
  private uplinkSender: VoiceTxUplinkSender | null = null;

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

  async switchTransportFromGesture(transport: RealtimeTransportKind): Promise<void> {
    await this.prepareCaptureFromGesture();
    if (this.state === 'capturing') {
      this.cleanup({ preserveInteractiveRuntime: true });
      this.setState('idle');
    }
    await this.start({ transportOverride: transport });
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
          connectStage: 'connect',
          startCompat: (offer) => this.startCompatCapture(offer),
          startRtcDataAudio: (offer) => this.startRtcDataAudioCapture(offer),
          cleanupFailedAttempt: () => {
            this.cleanupTransportOnly({ preserveCaptureBackend: true });
          },
        });
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
    this.pttActive = active;

    if (active) {
      this.localTxStats.notePTTActivated();
    }
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

  private startClockSync(sendControl: (payload: Record<string, unknown>) => boolean | void): void {
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

  private async startCompatCapture(offer: RealtimeTransportOffer): Promise<void> {
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

    captureBackend.setFrameHandler((frame) => {
      if (!this.pttActive) {
        return;
      }
      if (!this.compatSocket || this.compatSocket.readyState !== WebSocket.OPEN || this.uplinkSender !== sender) {
        this.localTxStats.noteFrameSkipped();
        return;
      }

      try {
        const result = sender.sendFrame(frame);
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
        );
        if (!hasLoggedFirstCompatFrame) {
          hasLoggedFirstCompatFrame = true;
          logger.info('First compatibility uplink audio frame sent', {
            sampleRate: frame.sampleRate,
            samplesPerChannel: frame.samplesPerChannel,
          });
        }
      } catch (error) {
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
    this.startClockSync((payload) => client.sendJson(payload));

    let hasLoggedFirstFrame = false;
    const sender = new VoiceTxUplinkSender({
      transport: 'rtc-data-audio',
      sendBinary: (payload) => client.sendBinary(payload),
      getBufferedAmount: () => client.bufferedAmount,
      estimateServerTimeMs: (clientTimeMs) => this.estimateServerTimeMs(clientTimeMs),
      getClockConfidence: () => this.getClockConfidence(),
    });
    this.uplinkSender = sender;
    this.localTxStats.reset('rtc-data-audio');

    captureBackend.setFrameHandler((frame) => {
      if (!this.pttActive) {
        return;
      }
      if (!this.rtcDataAudioClient?.isOpen || this.uplinkSender !== sender) {
        this.localTxStats.noteFrameSkipped();
        return;
      }

      try {
        const result = sender.sendFrame(frame);
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
        );
        if (!hasLoggedFirstFrame) {
          hasLoggedFirstFrame = true;
          logger.info('First rtc-data-audio uplink audio frame sent', {
            sampleRate: frame.sampleRate,
            samplesPerChannel: frame.samplesPerChannel,
          });
        }
      } catch (error) {
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
    this.uplinkSender = null;
    this.stopClockSync();
    this.localTxStats.reset(null);
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
}
