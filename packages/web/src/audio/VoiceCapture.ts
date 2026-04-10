import { encodeWsCompatAudioFrame } from '@tx5dr/core';
import type { RealtimeTransportOffer, RealtimeTransportKind } from '@tx5dr/contracts';
import { Room, RoomEvent, Track, LocalAudioTrack } from 'livekit-client';
import { createLogger } from '../utils/logger';
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
import {
  VoiceTxLocalStatsCollector,
  type VoiceTxLocalDiagnostics,
} from './voiceTxDiagnostics';

const logger = createLogger('VoiceCapture');
const COMPAT_CAPTURE_CONNECT_TIMEOUT_MS = 5000;
const LIVEKIT_SENDER_STATS_INTERVAL_MS = 1000;

type AudioTrackConstraints = {
  sampleRate?: number;
  channelCount?: number;
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
};
type OutboundRtpStatsLike = {
  packetsSent?: number;
  roundTripTime?: number;
  jitter?: number;
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
  private room: Room | null = null;
  private localTrack: LocalAudioTrack | null = null;
  private compatSocket: WebSocket | null = null;
  private mediaStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private mediaSource: MediaStreamAudioSourceNode | null = null;
  private levelAnalyser: AnalyserNode | null = null;
  private levelAnalyserBuffer: Float32Array | null = null;
  private levelMonitorTimer: number | null = null;
  private captureBackend: CompatCaptureBackend | null = null;
  private startPromise: Promise<void> | null = null;
  private pttActive = false;
  private _participantIdentity: string | null = null;
  private transportKind: RealtimeTransportKind | null = null;
  private compatSequence = 0;
  private _inputLevel = 0;
  private readonly localTxStats = new VoiceTxLocalStatsCollector();
  private liveKitStatsTimer: number | null = null;

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
    this.mediaStream = await requestInteractiveMicrophone(AUDIO_CONSTRAINTS, this.mediaStream);
    this.audioContext = await ensureInteractiveAudioContext(this.audioContext);
    if (!this.mediaSource) {
      this.mediaSource = this.audioContext.createMediaStreamSource(this.mediaStream);
    }
    this.ensureInputLevelMonitor();
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
          startLiveKit: (offer) => this.startLiveKitCapture(offer),
          startCompat: (offer) => this.startCompatCapture(offer),
          cleanupFailedAttempt: () => {
            this.cleanupTransportOnly();
          },
        });
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

    if (this.transportKind === 'livekit' && this.localTrack) {
      if (active) {
        const unmuteStartedAt = performance.now();
        void this.localTrack.unmute().then(() => {
          this.localTxStats.noteTrackUnmuted(performance.now() - unmuteStartedAt);
        }).catch((error) => {
          logger.error('Failed to unmute LiveKit microphone track', error);
        });
      } else {
        void this.localTrack.mute().catch((error) => {
          logger.error('Failed to mute LiveKit microphone track', error);
        });
      }
    }
  }

  private async startLiveKitCapture(
    offer: RealtimeTransportOffer,
  ): Promise<void> {
    const mediaStream = await requestInteractiveMicrophone(AUDIO_CONSTRAINTS, this.mediaStream);
    const audioContext = await ensureInteractiveAudioContext(this.audioContext);
    const mediaSource = this.mediaSource ?? audioContext.createMediaStreamSource(mediaStream);
    const sourceTrack = mediaStream.getAudioTracks()[0];
    if (!sourceTrack) {
      throw new Error('No microphone track is available for LiveKit capture');
    }

    const room = new Room({
      adaptiveStream: false,
      dynacast: false,
    });
    room.on(RoomEvent.Disconnected, () => {
      logger.warn('LiveKit voice capture disconnected unexpectedly');
    });
    await room.connect(offer.url, offer.token, {
      autoSubscribe: false,
    });

    const localTrack = new LocalAudioTrack(
      sourceTrack,
      AUDIO_CONSTRAINTS,
      true,
      audioContext,
    );
    await room.localParticipant.publishTrack(localTrack, {
      source: Track.Source.Microphone,
      name: 'voice-tx',
    });
    await localTrack.mute();

    this.transportKind = 'livekit';
    this.localTxStats.reset('livekit');
    this.room = room;
    this.localTrack = localTrack;
    this.mediaStream = mediaStream;
    this.audioContext = audioContext;
    this.mediaSource = mediaSource;
    this._participantIdentity = offer.participantIdentity ?? null;
    this.ensureInputLevelMonitor();

    if (this.pttActive) {
      await this.localTrack.unmute();
    }

    logger.info('Voice capture connected via LiveKit', {
      roomName: offer.roomName,
      participantIdentity: offer.participantIdentity,
    });
    this.startLiveKitSenderStatsPolling();
  }

  private async startCompatCapture(offer: RealtimeTransportOffer): Promise<void> {
    const mediaStream = await requestInteractiveMicrophone(AUDIO_CONSTRAINTS, this.mediaStream);
    const audioContext = await ensureInteractiveAudioContext(this.audioContext);
    const mediaSource = this.mediaSource ?? audioContext.createMediaStreamSource(mediaStream);
    const captureBackend = await createCompatCaptureBackend(audioContext);

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`${offer.url}?token=${encodeURIComponent(offer.token)}`);
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
    captureBackend.setFrameHandler((frame) => {
      if (!this.pttActive) {
        return;
      }
      if (!this.compatSocket || this.compatSocket.readyState !== WebSocket.OPEN) {
        this.localTxStats.noteFrameSkipped();
        return;
      }

      try {
        const sendStartedAt = performance.now();
        const payload = encodeWsCompatAudioFrame({
          sequence: this.compatSequence++,
          timestampMs: Date.now(),
          sampleRate: frame.sampleRate,
          channels: 1,
          samplesPerChannel: frame.samplesPerChannel,
          pcm: new Int16Array(frame.buffer),
        });
        this.compatSocket.send(payload);
        this.localTxStats.noteFrameSent(
          frame.samplesPerChannel,
          performance.now() - sendStartedAt,
          this.compatSocket.bufferedAmount,
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

    mediaSource.connect(captureBackend.inputNode);

    this.transportKind = 'ws-compat';
    this.localTxStats.reset('ws-compat');
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

  private cleanupTransportOnly(): void {
    if (this.liveKitStatsTimer !== null) {
      window.clearInterval(this.liveKitStatsTimer);
      this.liveKitStatsTimer = null;
    }

    if (this.captureBackend) {
      try {
        this.captureBackend.close();
      } catch {
        // ignore
      }
      this.captureBackend = null;
    }

    if (this.localTrack) {
      try {
        this.localTrack.stop();
      } catch {
        // ignore
      }
      this.localTrack = null;
    }

    if (this.compatSocket) {
      try {
        this.compatSocket.close();
      } catch {
        // ignore
      }
      this.compatSocket = null;
    }

    if (this.room) {
      void this.room.disconnect();
      this.room = null;
    }

    this.transportKind = null;
    this._participantIdentity = null;
    this.compatSequence = 0;
    this.localTxStats.reset(null);
  }

  private startLiveKitSenderStatsPolling(): void {
    if (!this.localTrack) {
      return;
    }

    if (this.liveKitStatsTimer !== null) {
      window.clearInterval(this.liveKitStatsTimer);
      this.liveKitStatsTimer = null;
    }

    const pollStats = async () => {
      if (!this.localTrack) {
        return;
      }

      try {
        const report = await this.localTrack.getRTCStatsReport();
        let packetsSent: number | null = null;
        let roundTripTimeMs: number | null = null;
        let jitterMs: number | null = null;

        report?.forEach((entry) => {
          if (entry.type === 'outbound-rtp') {
            const outbound = entry as OutboundRtpStatsLike;
            packetsSent = typeof outbound.packetsSent === 'number' ? outbound.packetsSent : packetsSent;
            roundTripTimeMs = typeof outbound.roundTripTime === 'number'
              ? outbound.roundTripTime * 1000
              : roundTripTimeMs;
            jitterMs = typeof outbound.jitter === 'number'
              ? outbound.jitter * 1000
              : jitterMs;
          }
        });

        this.localTxStats.noteLiveKitSenderStats({
          bitrateKbps: Number.isFinite(this.localTrack.currentBitrate) ? this.localTrack.currentBitrate / 1000 : null,
          packetsSent,
          roundTripTimeMs,
          jitterMs,
        });
      } catch (error) {
        logger.debug('Failed to poll LiveKit sender stats', error);
      }
    };

    void pollStats();
    this.liveKitStatsTimer = window.setInterval(() => {
      void pollStats();
    }, LIVEKIT_SENDER_STATS_INTERVAL_MS);
  }

  private cleanup(options: VoiceCaptureCleanupOptions = {}): void {
    const { preserveInteractiveRuntime = false } = options;

    this.cleanupTransportOnly();

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
