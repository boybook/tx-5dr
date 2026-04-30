import { randomUUID } from 'crypto';
import type { WebSocket } from 'ws';
import {
  createRealtimeTimingProbe,
  isRealtimeTimingProbeMessage,
  REALTIME_TIMING_PROBE_INTERVAL_MS,
} from '@tx5dr/core';
import type {
  RealtimeScope,
  RealtimeSessionDirection,
  RealtimeSessionResponse,
  RealtimeTransportKind,
  RealtimeTransportOffer,
  UserRole,
  ResolvedVoiceTxBufferPolicy,
  VoiceTxBufferPreference,
  RealtimeAudioCodecCapabilities,
  RealtimeAudioCodecPreference,
  ResolvedRealtimeAudioCodecPolicy,
} from '@tx5dr/contracts';
import { resolveVoiceTxBufferPolicy, UserRole as UserRoleEnum, USER_ROLE_LEVEL } from '@tx5dr/contracts';
import { ConfigManager } from '../config/config-manager.js';
import type { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { createLogger } from '../utils/logger.js';
import type { VoiceTxFrameMeta } from '../voice/VoiceTxDiagnostics.js';
import { resolveBrowserFacingRequestOrigin } from './requestOrigin.js';
import { handleRealtimeClockSyncControlMessage } from './RealtimeClockSyncControl.js';
import {
  RealtimeDownlinkAudioEncoder,
  RealtimeOpusCodecService,
  RealtimeUplinkAudioDecoder,
  resolveRealtimeAudioCodecPolicy,
} from './RealtimeAudioCodecPipeline.js';
import type { RealtimeRxAudioRouter } from './RealtimeRxAudioRouter.js';
import type { RealtimeAudioFrame, RealtimeRxAudioSourceStats } from './RealtimeRxAudioSource.js';
import { buildRtcDataAudioConnectivityHints, RtcDataAudioManager } from './RtcDataAudioManager.js';

const logger = createLogger('RealtimeTransportManager');
const COMPAT_TOKEN_TTL_MS = 10 * 60 * 1000;

interface CompatSessionRecord {
  token: string;
  scope: RealtimeScope;
  direction: RealtimeSessionDirection;
  previewSessionId?: string;
  participantIdentity: string | null;
  voiceTxBufferPolicy?: ResolvedVoiceTxBufferPolicy;
  audioCodecPolicy: ResolvedRealtimeAudioCodecPolicy;
  expiresAt: number;
}

interface CompatSocketContext {
  cleanup?: () => void;
}

type RealtimeTransportSelectionReason =
  | 'client-override'
  | 'server-policy'
  | 'default-rtc-data-audio'
  | 'rtc-data-audio-unavailable';

export interface IssueRealtimeSessionParams {
  scope: RealtimeScope;
  direction: RealtimeSessionDirection;
  transportOverride?: RealtimeTransportKind;
  role: UserRole;
  tokenId?: string | null;
  operatorIds?: string[];
  label?: string | null;
  clientKind: string;
  previewSessionId?: string;
  requestHeaders?: Record<string, string | string[] | undefined>;
  requestProtocol?: string;
  voiceTxBufferPreference?: VoiceTxBufferPreference;
  audioCodecPreference?: RealtimeAudioCodecPreference;
  audioCodecCapabilities?: RealtimeAudioCodecCapabilities;
}

function buildCompatIdentity(direction: RealtimeSessionDirection, stablePart: string): string {
  const safeStablePart = stablePart.replace(/[^a-zA-Z0-9:_-]/g, '-');
  return `compat-${direction}:${safeStablePart}:${randomUUID()}`;
}

export class RealtimeTransportManager {
  private static instance: RealtimeTransportManager | null = null;

  static initialize(
    engine: DigitalRadioEngine,
    rxAudioRouter: RealtimeRxAudioRouter,
  ): RealtimeTransportManager {
    RealtimeTransportManager.instance = new RealtimeTransportManager(engine, rxAudioRouter);
    return RealtimeTransportManager.instance;
  }

  static getInstance(): RealtimeTransportManager {
    if (!RealtimeTransportManager.instance) {
      throw new Error('RealtimeTransportManager is not initialized');
    }
    return RealtimeTransportManager.instance;
  }

  private readonly compatSessions = new Map<string, CompatSessionRecord>();
  private readonly compatSocketContexts = new WeakMap<WebSocket, CompatSocketContext>();
  private readonly rtcDataAudioManager: RtcDataAudioManager;

  private constructor(
    private readonly engine: DigitalRadioEngine,
    private readonly rxAudioRouter: RealtimeRxAudioRouter,
  ) {
    this.rtcDataAudioManager = new RtcDataAudioManager(engine, rxAudioRouter);
  }

  async issueSession(params: IssueRealtimeSessionParams): Promise<RealtimeSessionResponse> {
    const hints = buildRtcDataAudioConnectivityHints({
      headers: params.requestHeaders,
      requestProtocol: params.requestProtocol,
    });
    const rtcDataAudioAvailable = await this.rtcDataAudioManager.isAvailable();
    const selection = this.determineTransportSelection(
      params.scope,
      params.direction,
      params.transportOverride,
      rtcDataAudioAvailable,
    );
    const forceCompat = selection.forcedCompatibilityMode;
    const preferredTransport = selection.transport;
    const voiceTxBufferPolicy = params.direction === 'send'
      ? resolveVoiceTxBufferPolicy(params.voiceTxBufferPreference)
      : undefined;
    const opusAvailable = await RealtimeOpusCodecService.getInstance().isAvailable();
    const audioCodecPolicy = resolveRealtimeAudioCodecPolicy({
      scope: params.scope,
      direction: params.direction,
      preference: params.audioCodecPreference,
      capabilities: params.audioCodecCapabilities,
      serverOpusAvailable: opusAvailable,
    });

    const compatOffer = this.buildCompatOffer(params, voiceTxBufferPolicy, audioCodecPolicy);
    const rtcDataAudioOffer = !forceCompat && (preferredTransport === 'rtc-data-audio' || (!params.transportOverride && params.scope === 'radio'))
      ? await this.rtcDataAudioManager.buildOffer({ ...params, voiceTxBufferPolicy, audioCodecPolicy })
      : null;

    const offers: RealtimeTransportOffer[] = [];
    const pushOffer = (offer: RealtimeTransportOffer | null): void => {
      if (!offer) return;
      if (!offers.some((existing) => existing.transport === offer.transport)) {
        offers.push(offer);
      }
    };

    if (preferredTransport === 'rtc-data-audio') {
      pushOffer(rtcDataAudioOffer);
      if (!params.transportOverride) {
        pushOffer(compatOffer);
      }
    } else {
      pushOffer(compatOffer);
      if (!params.transportOverride && rtcDataAudioOffer && selection.reason !== 'server-policy') {
        pushOffer(rtcDataAudioOffer);
      }
    }

    if (offers.length === 0) {
      throw new Error('No realtime transport offers are available');
    }

    logger.info('Realtime session issued', {
      scope: params.scope,
      direction: params.direction,
      transportOverride: params.transportOverride ?? null,
      policy: selection.policy,
      preferredTransport,
      forcedCompatibilityMode: forceCompat,
      selectionReason: selection.reason,
      offers: offers.map((offer) => offer.transport),
      rtcDataAudioAvailable,
      rtcDataAudioUnavailableReason: this.rtcDataAudioManager.getUnavailableReason(),
      audioCodec: audioCodecPolicy.resolvedCodec,
      audioCodecFallbackReason: audioCodecPolicy.fallbackReason,
    });

    return {
      scope: params.scope,
      direction: params.direction,
      preferredTransport,
      effectiveTransportPolicy: selection.policy,
      selectionReason: selection.reason,
      forcedCompatibilityMode: forceCompat,
      offers,
      connectivityHints: hints,
      ...(voiceTxBufferPolicy ? { voiceTxBufferPolicy } : {}),
      audioCodecPolicy,
    };
  }

  getPreferredTransport(scope: RealtimeScope, direction: RealtimeSessionDirection): RealtimeTransportKind {
    return this.determineTransportSelection(
      scope,
      direction,
      undefined,
      this.rtcDataAudioManager.isAvailableCached(),
    ).transport;
  }

  getSourceStats(scope: RealtimeScope, previewSessionId?: string): RealtimeRxAudioSourceStats | null {
    return this.rxAudioRouter.getLatestStats(scope, previewSessionId);
  }

  acceptRtcDataAudioConnection(socket: WebSocket, rawUrl: string): void {
    this.rtcDataAudioManager.acceptConnection(socket, rawUrl);
  }

  acceptCompatConnection(socket: WebSocket, rawUrl: string): void {
    const url = new URL(rawUrl, 'http://localhost');
    const token = url.searchParams.get('token');
    if (!token) {
      socket.close(4001, 'Realtime compatibility token is required');
      return;
    }

    const session = this.compatSessions.get(token);
    if (!session || session.expiresAt <= Date.now()) {
      this.compatSessions.delete(token);
      socket.close(4001, 'Realtime compatibility token is invalid or expired');
      return;
    }

    this.compatSessions.delete(token);
    const context: CompatSocketContext = {};
    this.compatSocketContexts.set(socket, context);
    const sendClockSyncJson = (payload: Record<string, unknown>): void => {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify(payload));
      }
    };

    if (session.direction === 'recv') {
      const source = this.rxAudioRouter.resolveSource(session.scope, session.previewSessionId);
      if (!source) {
        socket.close(4004, 'Realtime audio source is not available');
        return;
      }

      const downlinkEncoder = new RealtimeDownlinkAudioEncoder(session.audioCodecPolicy);
      let hasLoggedFirstCompatDownlinkFrame = false;
      let probeSequence = 0;
      const probeTimer = setInterval(() => {
        if (socket.readyState === 1) {
          socket.send(JSON.stringify(createRealtimeTimingProbe('monitor-downlink', probeSequence++)));
        }
      }, REALTIME_TIMING_PROBE_INTERVAL_MS);
      const handleAudioData = (frame: RealtimeAudioFrame) => {
        if (socket.readyState !== 1) {
          return;
        }

        try {
          const packets = downlinkEncoder.encodeSourceFrame(frame);
          for (const packet of packets) {
            socket.send(Buffer.from(packet.payload));
            if (!hasLoggedFirstCompatDownlinkFrame) {
              hasLoggedFirstCompatDownlinkFrame = true;
              logger.info('First compatibility downlink audio frame sent', {
                scope: session.scope,
                sourceId: source.id,
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
        } catch (error) {
          logger.debug('Failed to send compatibility audio frame', error);
        }
      };

      source.on('audioFrame', handleAudioData);
      context.cleanup = () => {
        clearInterval(probeTimer);
        source.off('audioFrame', handleAudioData);
      };
      socket.on('message', (payload: Buffer | ArrayBuffer | Buffer[]) => {
        handleRealtimeClockSyncControlMessage(payload, sendClockSyncJson);
      });
      socket.send(JSON.stringify({
        type: 'ready',
        transport: 'ws-compat',
        direction: session.direction,
        scope: session.scope,
      }));
    } else {
      socket.send(JSON.stringify({
        type: 'ready',
        transport: 'ws-compat',
        direction: session.direction,
        scope: session.scope,
        participantIdentity: session.participantIdentity,
      }));

      let hasLoggedFirstCompatUplinkFrame = false;
      const uplinkDecoder = new RealtimeUplinkAudioDecoder();
      socket.on('message', (payload: Buffer | ArrayBuffer | Buffer[]) => {
        if (handleRealtimeClockSyncControlMessage(payload, sendClockSyncJson)) {
          return;
        }
        if (!session.participantIdentity) {
          return;
        }

        const buffer = Array.isArray(payload)
          ? Buffer.concat(payload)
          : Buffer.isBuffer(payload)
            ? payload
            : Buffer.from(payload);

        if (buffer.length === 0) {
          return;
        }
        if (this.handleVoiceTimingProbe(buffer, session, 'ws-compat')) {
          return;
        }

        try {
          const decodedPackets = uplinkDecoder.decode(
            buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
          );
          if (decodedPackets.length === 0) {
            return;
          }
          for (const decoded of decodedPackets) {
            if (!hasLoggedFirstCompatUplinkFrame) {
              hasLoggedFirstCompatUplinkFrame = true;
              logger.info('First compatibility uplink audio frame received', {
                scope: session.scope,
                participantIdentity: session.participantIdentity,
                codec: decoded.codec,
                sampleRate: decoded.sampleRate,
                samplesPerChannel: decoded.samplesPerChannel,
              });
            }
            const serverReceivedAtMs = Date.now();
            const wrappedNow = serverReceivedAtMs >>> 0;
            const transportDelta = decoded.timestampMs > 0 ? ((wrappedNow - decoded.timestampMs) >>> 0) : Number.POSITIVE_INFINITY;
            const clientSentAtMs = transportDelta <= 60_000
              ? serverReceivedAtMs - transportDelta
              : null;
            const meta: VoiceTxFrameMeta = {
              transport: 'ws-compat',
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
          logger.debug('Failed to decode compatibility uplink audio frame', error);
        }
      });
    }

    const cleanup = () => {
      const current = this.compatSocketContexts.get(socket);
      current?.cleanup?.();
      this.compatSocketContexts.delete(socket);
    };

    socket.once('close', cleanup);
    socket.once('error', cleanup);
  }

  private handleVoiceTimingProbe(
    buffer: Buffer,
    session: CompatSessionRecord,
    transport: RealtimeTransportKind,
  ): boolean {
    if (buffer[0] !== 0x7b) {
      return false;
    }
    try {
      const message = JSON.parse(buffer.toString('utf-8')) as unknown;
      if (!isRealtimeTimingProbeMessage(message) || message.stream !== 'voice-uplink' || !session.participantIdentity) {
        return false;
      }
      this.engine.getVoiceSessionManager()?.recordParticipantTimingProbe({
        participantIdentity: session.participantIdentity,
        transport,
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

  private determineTransportSelection(
    scope: RealtimeScope,
    direction: RealtimeSessionDirection,
    transportOverride?: RealtimeTransportKind,
    rtcDataAudioAvailable = this.rtcDataAudioManager.isAvailableCached(),
  ): {
    transport: RealtimeTransportKind;
    forcedCompatibilityMode: boolean;
    policy: 'auto' | 'force-compat';
    reason: RealtimeTransportSelectionReason;
  } {
    const policy = ConfigManager.getInstance().getRealtimeTransportPolicy();

    // OpenWebRX preview remains on ws-compat in rtc-data-audio v1.
    if (scope === 'openwebrx-preview') {
      return {
        transport: 'ws-compat',
        forcedCompatibilityMode: true,
        policy,
        reason: 'server-policy',
      };
    }

    if (transportOverride === 'ws-compat') {
      return {
        transport: 'ws-compat',
        forcedCompatibilityMode: true,
        policy,
        reason: 'client-override',
      };
    }

    if (policy === 'force-compat') {
      return {
        transport: 'ws-compat',
        forcedCompatibilityMode: true,
        policy,
        reason: 'server-policy',
      };
    }

    if (transportOverride === 'rtc-data-audio') {
      return rtcDataAudioAvailable
        ? {
            transport: 'rtc-data-audio',
            forcedCompatibilityMode: false,
            policy,
            reason: 'client-override',
          }
        : {
            transport: 'ws-compat',
            forcedCompatibilityMode: false,
            policy,
            reason: 'rtc-data-audio-unavailable',
          };
    }

    if (rtcDataAudioAvailable) {
      return {
        transport: 'rtc-data-audio',
        forcedCompatibilityMode: false,
        policy,
        reason: 'default-rtc-data-audio',
      };
    }

    return {
      transport: 'ws-compat',
      forcedCompatibilityMode: false,
      policy,
      reason: 'rtc-data-audio-unavailable',
    };
  }

  private buildCompatOffer(
    params: IssueRealtimeSessionParams,
    voiceTxBufferPolicy?: ResolvedVoiceTxBufferPolicy,
    audioCodecPolicy?: ResolvedRealtimeAudioCodecPolicy,
  ): RealtimeTransportOffer {
    if (params.direction === 'send' && USER_ROLE_LEVEL[params.role] < USER_ROLE_LEVEL[UserRoleEnum.OPERATOR]) {
      throw new Error('Operator role or above is required to publish audio');
    }

    const token = randomUUID();
    const participantIdentity = params.direction === 'send'
      ? buildCompatIdentity(params.direction, params.tokenId || params.role.toLowerCase())
      : null;

    this.compatSessions.set(token, {
      token,
      scope: params.scope,
      direction: params.direction,
      previewSessionId: params.previewSessionId,
      participantIdentity,
      ...(voiceTxBufferPolicy ? { voiceTxBufferPolicy } : {}),
      audioCodecPolicy: audioCodecPolicy ?? resolveRealtimeAudioCodecPolicy({
        scope: params.scope,
        direction: params.direction,
        preference: 'pcm',
        capabilities: undefined,
        serverOpusAvailable: false,
      }),
      expiresAt: Date.now() + COMPAT_TOKEN_TTL_MS,
    });

    return {
      transport: 'ws-compat',
      direction: params.direction,
      url: this.resolveCompatWsUrl(params.requestHeaders, params.requestProtocol),
      token,
      participantIdentity,
      participantName: params.label ?? null,
    };
  }

  private resolveCompatWsUrl(
    headers?: Record<string, string | string[] | undefined>,
    requestProtocol?: string,
  ): string {
    const origin = resolveBrowserFacingRequestOrigin({
      headers,
      requestProtocol,
      fallbackHost: '127.0.0.1:4000',
    });

    const wsProtocol = origin.protocol === 'https' ? 'wss' : 'ws';
    return `${wsProtocol}://${origin.host}/api/realtime/ws-compat`;
  }

}
