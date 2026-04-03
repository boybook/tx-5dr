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

const logger = createLogger('VoiceCapture');
const LIVEKIT_FAST_WEBSOCKET_TIMEOUT_MS = 1500;
const LIVEKIT_FAST_PEER_TIMEOUT_MS = 2000;
const COMPAT_CAPTURE_CONNECT_TIMEOUT_MS = 5000;

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

const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
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
  private captureBackend: CompatCaptureBackend | null = null;
  private startPromise: Promise<void> | null = null;
  private pttActive = false;
  private _participantIdentity: string | null = null;
  private transportKind: RealtimeTransportKind | null = null;
  private compatSequence = 0;

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

  async prepareCaptureFromGesture(): Promise<void> {
    this.mediaStream = await requestInteractiveMicrophone(AUDIO_CONSTRAINTS, this.mediaStream);
    this.audioContext = await ensureInteractiveAudioContext(this.audioContext);
    if (!this.mediaSource) {
      this.mediaSource = this.audioContext.createMediaStreamSource(this.mediaStream);
    }
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
          startLiveKit: (offer, startOptions) => this.startLiveKitCapture(offer, startOptions),
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

    if (this.transportKind === 'livekit' && this.localTrack) {
      if (active) {
        void this.localTrack.unmute().catch((error) => {
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
    options?: { fastFallback?: boolean },
  ): Promise<void> {
    const mediaStream = await requestInteractiveMicrophone(AUDIO_CONSTRAINTS, this.mediaStream);
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
      maxRetries: options?.fastFallback ? 0 : undefined,
      websocketTimeout: options?.fastFallback ? LIVEKIT_FAST_WEBSOCKET_TIMEOUT_MS : undefined,
      peerConnectionTimeout: options?.fastFallback ? LIVEKIT_FAST_PEER_TIMEOUT_MS : undefined,
    });

    const localTrack = new LocalAudioTrack(
      sourceTrack,
      AUDIO_CONSTRAINTS,
      true,
      this.audioContext ?? undefined,
    );
    await room.localParticipant.publishTrack(localTrack, {
      source: Track.Source.Microphone,
      name: 'voice-tx',
    });
    await localTrack.mute();

    this.transportKind = 'livekit';
    this.room = room;
    this.localTrack = localTrack;
    this.mediaStream = mediaStream;
    this._participantIdentity = offer.participantIdentity ?? null;

    if (this.pttActive) {
      await this.localTrack.unmute();
    }

    logger.info('Voice capture connected via LiveKit', {
      roomName: offer.roomName,
      participantIdentity: offer.participantIdentity,
    });
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
      if (!this.compatSocket || this.compatSocket.readyState !== WebSocket.OPEN) {
        return;
      }
      if (!this.pttActive) {
        return;
      }

      try {
        const payload = encodeWsCompatAudioFrame({
          sequence: this.compatSequence++,
          timestampMs: Date.now(),
          sampleRate: frame.sampleRate,
          channels: 1,
          samplesPerChannel: frame.samplesPerChannel,
          pcm: new Int16Array(frame.buffer),
        });
        this.compatSocket.send(payload);
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
    this.mediaStream = mediaStream;
    this.audioContext = audioContext;
    this.mediaSource = mediaSource;
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

  private cleanupTransportOnly(): void {
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
  }

  private cleanup(options: VoiceCaptureCleanupOptions = {}): void {
    const { preserveInteractiveRuntime = false } = options;

    this.cleanupTransportOnly();

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
