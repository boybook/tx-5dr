import { api, encodeWsCompatAudioFrame } from '@tx5dr/core';
import type { RealtimeConnectivityHints, RealtimeTransportOffer, RealtimeTransportKind } from '@tx5dr/contracts';
import { Room, RoomEvent, Track, createLocalAudioTrack, type LocalAudioTrack } from 'livekit-client';
import { createLogger } from '../utils/logger';
import {
  buildRealtimeConnectivityIssue,
  showRealtimeFallbackActivatedToast,
  toRealtimeConnectivityError,
} from '../realtime/realtimeConnectivity';

const logger = createLogger('VoiceCapture');
const LIVEKIT_FAST_WEBSOCKET_TIMEOUT_MS = 1500;
const LIVEKIT_FAST_PEER_TIMEOUT_MS = 2000;

export interface VoiceCaptureOptions {
  onStateChange?: (state: VoiceCaptureState) => void;
  onError?: (error: Error) => void;
}

interface VoiceCaptureStartOptions {
  transportOverride?: RealtimeTransportKind;
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
  private captureNode: AudioWorkletNode | null = null;
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

  async whenReady(): Promise<void> {
    if (this.startPromise) {
      await this.startPromise;
    }
  }

  async start(options?: VoiceCaptureStartOptions): Promise<void> {
    if (this.startPromise) {
      return this.startPromise;
    }

    this.setState('starting');

    this.startPromise = (async () => {
      let errorStage: 'token' | 'connect' | 'publish' = 'token';
      let connectivityHints: RealtimeConnectivityHints | undefined;
      let compatFallbackAttempted = false;
      let liveKitFailureIssue: ReturnType<typeof buildRealtimeConnectivityIssue> | null = null;
      try {
        const session = await api.getRealtimeSession({
          scope: 'radio',
          direction: 'send',
        });
        connectivityHints = session.connectivityHints;
        const offers = options?.transportOverride
          ? session.offers.filter((offer) => offer.transport === options.transportOverride)
          : session.offers;

        let lastError: unknown = null;
        for (const offer of offers) {
          try {
            errorStage = 'connect';
            if (offer.transport === 'livekit') {
              await this.startLiveKitCapture(offer, {
                fastFallback: offers.some((candidate) => candidate.transport === 'ws-compat'),
              });
            } else {
              compatFallbackAttempted = liveKitFailureIssue !== null;
              await this.startCompatCapture(offer);
              if (liveKitFailureIssue) {
                showRealtimeFallbackActivatedToast(liveKitFailureIssue);
              }
            }
            this.setState('capturing');
            return;
          } catch (error) {
            lastError = error;
            if (offer.transport === 'livekit') {
              liveKitFailureIssue = buildRealtimeConnectivityIssue(error, {
                scope: 'radio',
                stage: errorStage,
                hints: connectivityHints,
              });
              logger.warn('LiveKit voice capture path failed, trying compatibility fallback', {
                code: liveKitFailureIssue.code,
                details: liveKitFailureIssue.technicalDetails,
              });
            }
            this.cleanup();
          }
        }

        throw lastError ?? new Error('No realtime uplink transport succeeded');
      } catch (error) {
        logger.error('Failed to start voice capture', error);
        this.setState('error');
        const realtimeError = toRealtimeConnectivityError(error, {
          scope: 'radio',
          stage: errorStage,
          hints: connectivityHints,
        });
        if (!realtimeError.issue.context) {
          realtimeError.issue.context = {};
        }
        realtimeError.issue.context.compatFallbackAttempted = String(compatFallbackAttempted);
        this.options.onError?.(realtimeError);
        this.cleanup();
        throw realtimeError;
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

    const localTrack = await createLocalAudioTrack(AUDIO_CONSTRAINTS);
    await room.localParticipant.publishTrack(localTrack, {
      source: Track.Source.Microphone,
      name: 'voice-tx',
    });
    await localTrack.mute();

    this.transportKind = 'livekit';
    this.room = room;
    this.localTrack = localTrack;
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
    const mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: AUDIO_CONSTRAINTS,
      video: false,
    });
    const audioContext = new AudioContext({
      latencyHint: 'interactive',
    });
    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }

    await audioContext.audioWorklet.addModule('/voice-capture-worklet.js');
    const mediaSource = audioContext.createMediaStreamSource(mediaStream);
    const captureNode = new AudioWorkletNode(audioContext, 'voice-capture-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`${offer.url}?token=${encodeURIComponent(offer.token)}`);
      ws.binaryType = 'arraybuffer';
      let resolved = false;

      ws.onopen = () => {
        resolved = true;
        this.compatSocket = ws;
        resolve();
      };

      ws.onerror = () => {
        reject(new Error('Realtime compatibility uplink WebSocket failed'));
      };

      ws.onclose = () => {
        if (!resolved) {
          reject(new Error('Realtime compatibility uplink closed before ready'));
        }
      };
    });

    if (this.compatSocket) {
      this.compatSocket.onclose = () => {
        logger.warn('Realtime compatibility uplink closed unexpectedly');
      };
    }

    captureNode.port.onmessage = (event) => {
      if (event.data?.type !== 'audioFrame' || !this.compatSocket || this.compatSocket.readyState !== WebSocket.OPEN) {
        return;
      }
      if (!this.pttActive) {
        return;
      }

      const frameBuffer = event.data.buffer as ArrayBuffer | undefined;
      const sampleRate = Number(event.data.sampleRate ?? 16000);
      const samplesPerChannel = Number(event.data.samplesPerChannel ?? 320);
      if (!frameBuffer) {
        return;
      }

      try {
        const payload = encodeWsCompatAudioFrame({
          sequence: this.compatSequence++,
          timestampMs: Date.now(),
          sampleRate,
          channels: 1,
          samplesPerChannel,
          pcm: new Int16Array(frameBuffer),
        });
        this.compatSocket.send(payload);
      } catch (error) {
        logger.debug('Failed to send compatibility uplink audio frame', error);
      }
    };

    mediaSource.connect(captureNode);

    this.transportKind = 'ws-compat';
    this.mediaStream = mediaStream;
    this.audioContext = audioContext;
    this.mediaSource = mediaSource;
    this.captureNode = captureNode;
    this._participantIdentity = offer.participantIdentity ?? null;

    logger.info('Voice capture connected via compatibility WebSocket', {
      participantIdentity: offer.participantIdentity,
    });
  }

  private setState(state: VoiceCaptureState): void {
    this.state = state;
    this.options.onStateChange?.(state);
  }

  private cleanup(): void {
    if (this.captureNode) {
      try {
        this.captureNode.disconnect();
      } catch {
        // ignore
      }
      this.captureNode.port.onmessage = null;
      this.captureNode = null;
    }

    if (this.mediaSource) {
      try {
        this.mediaSource.disconnect();
      } catch {
        // ignore
      }
      this.mediaSource = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          // ignore
        }
      });
      this.mediaStream = null;
    }

    if (this.audioContext) {
      void this.audioContext.close().catch(() => {});
      this.audioContext = null;
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
    this.startPromise = null;
  }
}
