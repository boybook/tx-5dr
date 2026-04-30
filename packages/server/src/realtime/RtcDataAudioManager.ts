import { randomUUID } from 'crypto';
import type { WebSocket } from 'ws';
import {
  createRealtimeTimingProbe,
  isRealtimeTimingProbeMessage,
  REALTIME_TIMING_PROBE_INTERVAL_MS,
} from '@tx5dr/core';
import type {
  RealtimeConnectivityHints,
  RealtimeScope,
  RealtimeSessionDirection,
  RealtimeTransportOffer,
  UserRole,
  ResolvedVoiceTxBufferPolicy,
  VoiceTxBufferPreference,
  ResolvedRealtimeAudioCodecPolicy,
} from '@tx5dr/contracts';
import { resolveVoiceTxBufferPolicy, UserRole as UserRoleEnum, USER_ROLE_LEVEL } from '@tx5dr/contracts';
import { ConfigManager } from '../config/config-manager.js';
import type { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import type { VoiceTxFrameMeta } from '../voice/VoiceTxDiagnostics.js';
import { createLogger } from '../utils/logger.js';
import { resolveBrowserFacingRequestOrigin } from './requestOrigin.js';
import { handleRealtimeClockSyncControlMessage } from './RealtimeClockSyncControl.js';
import { RealtimeDownlinkAudioEncoder, RealtimeUplinkAudioDecoder } from './RealtimeAudioCodecPipeline.js';
import type { RealtimeRxAudioRouter } from './RealtimeRxAudioRouter.js';
import type { RealtimeAudioFrame, RealtimeRxAudioSource } from './RealtimeRxAudioSource.js';
import {
  appendPublicIceCandidatesToSdp,
  createPublicIceCandidateVariants,
  resolvePublicCandidateEndpoints,
  type RtcDataAudioPublicCandidateEndpoint,
} from './RtcDataAudioIceCandidates.js';

const logger = createLogger('RtcDataAudioManager');
const RTC_DATA_AUDIO_TOKEN_TTL_MS = 10 * 60 * 1000;
const RTC_DATA_AUDIO_LABEL = 'tx5dr-audio';
const RTC_DATA_AUDIO_PROTOCOL = 'tx5dr-audio/1';
const RTC_DATA_AUDIO_MAX_SOURCE_FRAME_AGE_MS = 60;
const RTC_DATA_AUDIO_BUFFERED_TARGET_MS = 40;
const RTC_DATA_AUDIO_DEFAULT_STUN = 'stun:stun.l.google.com:19302';
const RTC_DATA_AUDIO_DEFAULT_UDP_PORT = 50110;

type RtcDescriptionType = 'offer' | 'answer' | 'pranswer' | 'rollback' | 'unspec';

type NodeDataChannelModule = typeof import('node-datachannel');
type PeerConnection = import('node-datachannel').PeerConnection;
type DataChannel = import('node-datachannel').DataChannel;

interface RtcDataAudioSessionRecord {
  token: string;
  scope: RealtimeScope;
  direction: RealtimeSessionDirection;
  previewSessionId?: string;
  participantIdentity: string | null;
  participantName: string | null;
  voiceTxBufferPolicy?: ResolvedVoiceTxBufferPolicy;
  audioCodecPolicy: ResolvedRealtimeAudioCodecPolicy;
  expiresAt: number;
}

export interface BuildRtcDataAudioOfferParams {
  scope: RealtimeScope;
  direction: RealtimeSessionDirection;
  previewSessionId?: string;
  role: UserRole;
  tokenId?: string | null;
  label?: string | null;
  requestHeaders?: Record<string, string | string[] | undefined>;
  requestProtocol?: string;
  voiceTxBufferPreference?: VoiceTxBufferPreference;
  voiceTxBufferPolicy?: ResolvedVoiceTxBufferPolicy;
  audioCodecPolicy?: ResolvedRealtimeAudioCodecPolicy;
}

function buildRtcIdentity(direction: RealtimeSessionDirection, stablePart: string): string {
  const safeStablePart = stablePart.replace(/[^a-zA-Z0-9:_-]/g, '-');
  return `rtc-data-${direction}:${safeStablePart}:${randomUUID()}`;
}

function parseUdpPort(rawValue: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(rawValue ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : fallback;
}

function parseBooleanEnv(rawValue: string | undefined, fallback: boolean): boolean {
  if (!rawValue) {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(rawValue.trim().toLowerCase());
}

export function resolveRtcDataAudioPortRange(): { portRangeBegin?: number; portRangeEnd?: number; enableIceUdpMux?: boolean } {
  const port = parseUdpPort(process.env.RTC_DATA_AUDIO_UDP_PORT, RTC_DATA_AUDIO_DEFAULT_UDP_PORT);
  return {
    portRangeBegin: port,
    portRangeEnd: port,
    enableIceUdpMux: parseBooleanEnv(process.env.RTC_DATA_AUDIO_ICE_UDP_MUX, true),
  };
}

export function getRtcDataAudioLocalUdpPort(): number {
  const range = resolveRtcDataAudioPortRange();
  return range.portRangeBegin ?? range.portRangeEnd ?? RTC_DATA_AUDIO_DEFAULT_UDP_PORT;
}

export function getRtcDataAudioIceServers(): string[] {
  return (process.env.RTC_DATA_AUDIO_ICE_SERVERS || RTC_DATA_AUDIO_DEFAULT_STUN)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

export function buildRtcDataAudioConnectivityHints(options: {
  headers?: Record<string, string | string[] | undefined>;
  requestProtocol?: string;
} = {}): RealtimeConnectivityHints {
  const origin = resolveBrowserFacingRequestOrigin({
    headers: options.headers,
    requestProtocol: options.requestProtocol,
    fallbackHost: '127.0.0.1:4000',
  });
  const wsProtocol = origin.protocol === 'https' ? 'wss' : 'ws';
  const localUdpPort = getRtcDataAudioLocalUdpPort();
  const config = ConfigManager.getInstance();
  const publicHost = config.getRtcDataAudioPublicHost();
  const publicUdpPort = config.getRtcDataAudioPublicUdpPort() ?? localUdpPort;

  return {
    signalingUrl: `${wsProtocol}://${origin.host}/api/realtime/rtc-data-audio`,
    localUdpPort,
    publicCandidateEnabled: Boolean(publicHost),
    publicEndpoint: publicHost
      ? {
          host: publicHost,
          port: publicUdpPort,
        }
      : null,
    iceServers: getRtcDataAudioIceServers(),
    fallbackTransport: 'ws-compat',
  };
}

function normalizeBinaryPayload(payload: string | Buffer | ArrayBuffer): ArrayBuffer | null {
  if (typeof payload === 'string') {
    return null;
  }
  if (payload instanceof ArrayBuffer) {
    return payload;
  }
  return payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer;
}

function sourceFrameBufferedLimitBytes(frame: {
  codec: 'opus' | 'pcm-s16le';
  codecSampleRate: number;
  channels: number;
  wireBytes: number;
}): number {
  if (frame.codec === 'opus') {
    return Math.max(2048, frame.wireBytes * 8);
  }
  const channels = Number.isFinite(frame.channels) && frame.channels > 0
    ? Math.floor(frame.channels)
    : 1;
  const bytesPerMs = (frame.codecSampleRate * channels * 2) / 1000;
  return Math.max(2048, Math.ceil(bytesPerMs * RTC_DATA_AUDIO_BUFFERED_TARGET_MS));
}

export class RtcDataAudioManager {
  private readonly sessions = new Map<string, RtcDataAudioSessionRecord>();
  private modulePromise: Promise<NodeDataChannelModule | null> | null = null;
  private moduleAvailable: boolean | null = null;
  private unavailableReason: string | null = null;

  constructor(
    private readonly engine: DigitalRadioEngine,
    private readonly rxAudioRouter: RealtimeRxAudioRouter,
  ) {}

  isAvailableCached(): boolean {
    return this.moduleAvailable === true;
  }

  getUnavailableReason(): string | null {
    return this.unavailableReason;
  }

  async isAvailable(): Promise<boolean> {
    const mod = await this.loadModule();
    return Boolean(mod);
  }

  async buildOffer(params: BuildRtcDataAudioOfferParams): Promise<RealtimeTransportOffer | null> {
    if (params.scope === 'openwebrx-preview') {
      return null;
    }
    if (!(await this.isAvailable())) {
      return null;
    }
    if (params.direction === 'send' && USER_ROLE_LEVEL[params.role] < USER_ROLE_LEVEL[UserRoleEnum.OPERATOR]) {
      throw new Error('Operator role or above is required to publish audio');
    }

    const token = randomUUID();
    const participantIdentity = params.direction === 'send'
      ? buildRtcIdentity(params.direction, params.tokenId || params.role.toLowerCase())
      : null;
    const voiceTxBufferPolicy = params.direction === 'send'
      ? (params.voiceTxBufferPolicy ?? resolveVoiceTxBufferPolicy(params.voiceTxBufferPreference))
      : undefined;
    const audioCodecPolicy = params.audioCodecPolicy ?? {
      preference: 'pcm' as const,
      resolvedCodec: 'pcm-s16le' as const,
      fallbackReason: 'client-forced-pcm' as const,
      codecSampleRate: null,
      bitrateBps: null,
      frameDurationMs: null,
    };

    this.sessions.set(token, {
      token,
      scope: params.scope,
      direction: params.direction,
      previewSessionId: params.previewSessionId,
      participantIdentity,
      participantName: params.label ?? null,
      ...(voiceTxBufferPolicy ? { voiceTxBufferPolicy } : {}),
      audioCodecPolicy,
      expiresAt: Date.now() + RTC_DATA_AUDIO_TOKEN_TTL_MS,
    });

    return {
      transport: 'rtc-data-audio',
      direction: params.direction,
      url: this.resolveSignalingWsUrl(params.requestHeaders, params.requestProtocol),
      token,
      participantIdentity,
      participantName: params.label ?? null,
    };
  }

  acceptConnection(socket: WebSocket, rawUrl: string): void {
    const url = new URL(rawUrl, 'http://localhost');
    const token = url.searchParams.get('token');
    if (!token) {
      socket.close(4001, 'Rtc data audio token is required');
      return;
    }

    const session = this.sessions.get(token);
    if (!session || session.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      socket.close(4001, 'Rtc data audio token is invalid or expired');
      return;
    }
    this.sessions.delete(token);

    void this.handleConnection(socket, session).catch((error) => {
      logger.warn('Rtc data audio connection failed', { error: error instanceof Error ? error.message : String(error) });
      try {
        socket.close(1011, 'Rtc data audio setup failed');
      } catch {
        // ignore
      }
    });
  }

  private async handleConnection(socket: WebSocket, session: RtcDataAudioSessionRecord): Promise<void> {
    const mod = await this.loadModule();
    if (!mod) {
      socket.close(1011, 'Rtc data audio runtime is unavailable');
      return;
    }

    const portRange = resolveRtcDataAudioPortRange();
    const localUdpPort = portRange.portRangeBegin ?? portRange.portRangeEnd ?? RTC_DATA_AUDIO_DEFAULT_UDP_PORT;
    const publicEndpoints = await this.resolvePublicCandidateEndpoints(localUdpPort);
    const advertisedPublicCandidates = new Set<string>();
    const peer = this.createPeerConnection(mod, session, portRange);
    let dataChannel: DataChannel | null = null;

    const sendJson = (payload: Record<string, unknown>): void => {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify(payload));
      }
    };

    let cleanupChannelBinding: (() => void) | null = null;
    let cleanedUp = false;

    const cleanup = (): void => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      cleanupChannelBinding?.();
      cleanupChannelBinding = null;
      try {
        dataChannel?.close();
      } catch {
        // ignore
      }
      try {
        peer.close();
      } catch {
        // ignore
      }
    };
    peer.onLocalDescription((sdp: string, type: RtcDescriptionType) => {
      const sdpWithPublicCandidates = appendPublicIceCandidatesToSdp(sdp, publicEndpoints, {
        localUdpPort,
        seen: advertisedPublicCandidates,
      });
      sendJson({ type: 'offer', sdp: sdpWithPublicCandidates, sdpType: type, transport: 'rtc-data-audio' });
    });
    peer.onLocalCandidate((candidate: string, mid: string) => {
      sendJson({ type: 'candidate', candidate, mid });
      for (const publicCandidate of createPublicIceCandidateVariants(candidate, publicEndpoints, {
        localUdpPort,
        mid,
        seen: advertisedPublicCandidates,
      })) {
        sendJson({ type: 'candidate', candidate: publicCandidate, mid });
      }
    });
    peer.onStateChange((state: string) => {
      logger.debug('Rtc data audio peer state changed', { state, direction: session.direction, scope: session.scope });
    });

    dataChannel = peer.createDataChannel(RTC_DATA_AUDIO_LABEL, {
      protocol: RTC_DATA_AUDIO_PROTOCOL,
      unordered: true,
      maxRetransmits: 0,
    });
    cleanupChannelBinding = this.bindDataChannel(dataChannel, session, sendJson);

    socket.on('message', (payload: Buffer | ArrayBuffer | Buffer[]) => {
      const buffer = Array.isArray(payload)
        ? Buffer.concat(payload)
        : Buffer.isBuffer(payload)
          ? payload
          : Buffer.from(payload);
      if (buffer.length === 0) {
        return;
      }
      try {
        const message = JSON.parse(buffer.toString('utf-8')) as {
          type?: string;
          sdp?: string;
          sdpType?: RtcDescriptionType;
          candidate?: string;
          mid?: string;
        };
        if (message.type === 'answer' && message.sdp) {
          peer.setRemoteDescription(message.sdp, message.sdpType ?? 'answer');
        } else if (message.type === 'candidate' && message.candidate) {
          peer.addRemoteCandidate(message.candidate, message.mid ?? '0');
        }
      } catch (error) {
        logger.debug('Failed to handle rtc-data-audio signaling message', error);
      }
    });

    socket.once('close', cleanup);
    socket.once('error', cleanup);
  }

  private createPeerConnection(
    mod: NodeDataChannelModule,
    session: RtcDataAudioSessionRecord,
    portRange: ReturnType<typeof resolveRtcDataAudioPortRange>,
  ): PeerConnection {
    const iceServers = getRtcDataAudioIceServers();
    return new mod.PeerConnection(`tx5dr-${session.direction}-${randomUUID()}`, {
      iceServers,
      enableIceTcp: false,
      ...portRange,
    });
  }

  private async resolvePublicCandidateEndpoints(localUdpPort: number): Promise<RtcDataAudioPublicCandidateEndpoint[]> {
    const config = ConfigManager.getInstance();
    const publicHost = config.getRtcDataAudioPublicHost();
    if (!publicHost) {
      return [];
    }

    const publicUdpPort = config.getRtcDataAudioPublicUdpPort() ?? localUdpPort;
    try {
      const endpoints = await resolvePublicCandidateEndpoints(publicHost, publicUdpPort);
      if (endpoints.length === 0) {
        logger.warn('rtc-data-audio public candidate host resolved to no addresses', {
          publicHost,
          publicUdpPort,
        });
      } else {
        logger.info('rtc-data-audio public ICE candidates enabled', {
          publicHost,
          publicUdpPort,
          resolvedIps: endpoints.map((endpoint) => endpoint.ip),
        });
      }
      return endpoints;
    } catch (error) {
      logger.warn('Failed to resolve rtc-data-audio public candidate host; continuing without public candidates', {
        publicHost,
        publicUdpPort,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  private bindDataChannel(
    dataChannel: DataChannel,
    session: RtcDataAudioSessionRecord,
    sendJson: (payload: Record<string, unknown>) => void,
  ): () => void {
    let cleanupSource: (() => void) | null = null;
    let source: RealtimeRxAudioSource | null = null;
    const downlinkEncoder = new RealtimeDownlinkAudioEncoder(session.audioCodecPolicy);
    const uplinkDecoder = new RealtimeUplinkAudioDecoder();
    let hasLoggedFirstFrame = false;
    let droppedStaleFrames = 0;
    let droppedBackpressureFrames = 0;
    let channelBindingCleaned = false;
    let probeSequence = 0;
    let probeTimer: NodeJS.Timeout | null = null;

    dataChannel.onOpen(() => {
      sendJson({
        type: 'ready',
        transport: 'rtc-data-audio',
        direction: session.direction,
        scope: session.scope,
        participantIdentity: session.participantIdentity,
      });

      if (session.direction !== 'recv') {
        return;
      }

      probeTimer = setInterval(() => {
        if (dataChannel.isOpen()) {
          dataChannel.sendMessage(JSON.stringify(createRealtimeTimingProbe('monitor-downlink', probeSequence++)));
        }
      }, REALTIME_TIMING_PROBE_INTERVAL_MS);

      source = this.rxAudioRouter.resolveSource(session.scope, session.previewSessionId);
      if (!source) {
        logger.warn('Rtc data audio source is not available', { scope: session.scope, previewSessionId: session.previewSessionId });
        return;
      }

      const handleAudioFrame = (frame: RealtimeAudioFrame): void => {
        if (!dataChannel.isOpen() || frame.samples.length === 0 || frame.sampleRate <= 0) {
          return;
        }
        const frameAgeMs = Date.now() - frame.timestamp;
        if (frameAgeMs > RTC_DATA_AUDIO_MAX_SOURCE_FRAME_AGE_MS) {
          droppedStaleFrames += 1;
          return;
        }
        const packets = downlinkEncoder.encodeSourceFrame(frame);
        for (const packet of packets) {
          if (dataChannel.bufferedAmount() > sourceFrameBufferedLimitBytes(packet)) {
            droppedBackpressureFrames += 1;
            return;
          }

          const sent = dataChannel.sendMessageBinary(new Uint8Array(packet.payload));
          if (!sent) {
            droppedBackpressureFrames += 1;
            return;
          }

          if (!hasLoggedFirstFrame) {
            hasLoggedFirstFrame = true;
            logger.info('First rtc-data-audio downlink frame sent', {
              scope: session.scope,
              sourceId: source?.id ?? null,
              sourcePath: frame.sourceKind,
              nativeSourceKind: frame.nativeSourceKind ?? null,
              codec: packet.codec,
              sourceSampleRate: packet.sourceSampleRate,
              transportSampleRate: packet.codecSampleRate,
              samplesPerChannel: packet.samplesPerChannel,
              wireBytes: packet.wireBytes,
            });
          }
        }
      };

      source.on('audioFrame', handleAudioFrame);
      cleanupSource = () => {
        source?.off('audioFrame', handleAudioFrame);
      };
    });

    dataChannel.onMessage((payload: string | Buffer | ArrayBuffer) => {
      if (handleRealtimeClockSyncControlMessage(payload, (message) => {
        if (dataChannel.isOpen()) {
          dataChannel.sendMessage(JSON.stringify(message));
        }
      })) {
        return;
      }
      if (this.handleVoiceTimingProbe(payload, session)) {
        return;
      }
      if (session.direction !== 'send' || !session.participantIdentity) {
        return;
      }
      const buffer = normalizeBinaryPayload(payload);
      if (!buffer) {
        return;
      }
      try {
        const decodedPackets = uplinkDecoder.decode(buffer);
        if (decodedPackets.length === 0) {
          return;
        }
        for (const decoded of decodedPackets) {
          const serverReceivedAtMs = Date.now();
          const wrappedNow = serverReceivedAtMs >>> 0;
          const transportDelta = decoded.timestampMs > 0 ? ((wrappedNow - decoded.timestampMs) >>> 0) : Number.POSITIVE_INFINITY;
          const clientSentAtMs = transportDelta <= 60_000
            ? serverReceivedAtMs - transportDelta
            : null;
          const meta: VoiceTxFrameMeta = {
            transport: 'rtc-data-audio',
            participantIdentity: session.participantIdentity,
            sequence: decoded.sequence,
            clientSentAtMs,
            serverReceivedAtMs,
            mediaTimestampMs: decoded.timestampMs,
            frameDurationMs: decoded.sampleRate > 0 ? (decoded.samplesPerChannel / decoded.sampleRate) * 1000 : 20,
            codec: decoded.codec,
            sampleRate: decoded.sampleRate,
            samplesPerChannel: decoded.samplesPerChannel,
            ...(decoded.concealment ? { concealment: decoded.concealment } : {}),
            ...(session.voiceTxBufferPolicy ? { voiceTxBufferPolicy: session.voiceTxBufferPolicy } : {}),
          };
          void this.engine.getVoiceSessionManager()?.handleParticipantAudioFrame(meta, decoded.samples);
        }
      } catch (error) {
        logger.debug('Failed to decode rtc-data-audio uplink frame', error);
      }
    });

    const cleanupChannelBinding = (): void => {
      if (channelBindingCleaned) {
        return;
      }
      channelBindingCleaned = true;
      if (probeTimer) {
        clearInterval(probeTimer);
        probeTimer = null;
      }
      cleanupSource?.();
      cleanupSource = null;
      if (hasLoggedFirstFrame || droppedStaleFrames > 0 || droppedBackpressureFrames > 0) {
        logger.info('Rtc data audio channel closed', {
          scope: session.scope,
          direction: session.direction,
          droppedStaleFrames,
          droppedBackpressureFrames,
        });
      }
    };

    dataChannel.onClosed(() => {
      cleanupChannelBinding();
    });

    dataChannel.onError((error: string) => {
      logger.warn('Rtc data audio data channel error', { scope: session.scope, direction: session.direction, error });
    });

    return cleanupChannelBinding;
  }

  private handleVoiceTimingProbe(payload: string | Buffer | ArrayBuffer, session: RtcDataAudioSessionRecord): boolean {
    if (session.direction !== 'send' || !session.participantIdentity) {
      return false;
    }
    if (typeof payload !== 'string') {
      const firstByte = Buffer.isBuffer(payload) ? payload[0] : new Uint8Array(payload)[0];
      if (firstByte !== 0x7b) {
        return false;
      }
    }
    try {
      const text = typeof payload === 'string'
        ? payload
        : Buffer.isBuffer(payload)
          ? payload.toString('utf-8')
          : Buffer.from(payload).toString('utf-8');
      const message = JSON.parse(text) as unknown;
      if (!isRealtimeTimingProbeMessage(message) || message.stream !== 'voice-uplink') {
        return false;
      }
      this.engine.getVoiceSessionManager()?.recordParticipantTimingProbe({
        participantIdentity: session.participantIdentity,
        transport: 'rtc-data-audio',
        codec: session.audioCodecPolicy.resolvedCodec === 'opus' ? 'opus' : 'pcm-s16le',
        sequence: message.sequence,
        sentAtMs: message.sentAtMs,
        receivedAtMs: Date.now(),
        intervalMs: message.intervalMs,
        ...(session.voiceTxBufferPolicy ? { voiceTxBufferPolicy: session.voiceTxBufferPolicy } : {}),
      });
      return true;
    } catch {
      return false;
    }
  }

  private async loadModule(): Promise<NodeDataChannelModule | null> {
    if (!this.modulePromise) {
      this.modulePromise = import('node-datachannel')
        .then((mod) => {
          const resolved = (mod.default ?? mod) as NodeDataChannelModule;
          if (typeof resolved.preload === 'function') {
            resolved.preload();
          }
          this.moduleAvailable = true;
          this.unavailableReason = null;
          logger.info('rtc-data-audio runtime available', {
            libraryVersion: typeof resolved.getLibraryVersion === 'function' ? resolved.getLibraryVersion() : null,
          });
          return resolved;
        })
        .catch((error) => {
          this.moduleAvailable = false;
          this.unavailableReason = error instanceof Error ? error.message : String(error);
          logger.warn('rtc-data-audio runtime unavailable, falling back to ws-compat', {
            reason: this.unavailableReason,
          });
          return null;
        });
    }
    return this.modulePromise;
  }

  private resolveSignalingWsUrl(
    headers?: Record<string, string | string[] | undefined>,
    requestProtocol?: string,
  ): string {
    const origin = resolveBrowserFacingRequestOrigin({
      headers,
      requestProtocol,
      fallbackHost: '127.0.0.1:4000',
    });
    const wsProtocol = origin.protocol === 'https' ? 'wss' : 'ws';
    return `${wsProtocol}://${origin.host}/api/realtime/rtc-data-audio`;
  }
}
