import { randomUUID } from 'crypto';
import type { WebSocket } from 'ws';
import type {
  RealtimeConnectivityHints,
  RealtimeScope,
  RealtimeSessionDirection,
  RealtimeSessionResponse,
  RealtimeTransportKind,
  RealtimeTransportOffer,
  UserRole,
} from '@tx5dr/contracts';
import { UserRole as UserRoleEnum } from '@tx5dr/contracts';
import { USER_ROLE_LEVEL } from '@tx5dr/contracts';
import { float32ToInt16Pcm, encodeWsCompatAudioFrame, decodeWsCompatAudioFrame, int16ToFloat32Pcm } from '@tx5dr/core';
import type { AudioMonitorService } from '../audio/AudioMonitorService.js';
import { ConfigManager } from '../config/config-manager.js';
import type { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { OpenWebRXStationManager } from '../openwebrx/OpenWebRXStationManager.js';
import { createLogger } from '../utils/logger.js';
import { LiveKitAuthService } from './LiveKitAuthService.js';
import { LiveKitBridgeManager } from './LiveKitBridgeManager.js';
import { LiveKitConfig } from './LiveKitConfig.js';

const logger = createLogger('RealtimeTransportManager');
const COMPAT_TOKEN_TTL_MS = 10 * 60 * 1000;

interface CompatSessionRecord {
  token: string;
  scope: RealtimeScope;
  direction: RealtimeSessionDirection;
  previewSessionId?: string;
  participantIdentity: string | null;
  expiresAt: number;
}

interface CompatSocketContext {
  cleanup?: () => void;
}

type RealtimeTransportSelectionReason =
  | 'client-override'
  | 'server-policy'
  | 'bridge-unhealthy'
  | 'livekit-disabled'
  | 'default-livekit';

export interface IssueRealtimeSessionParams {
  scope: RealtimeScope;
  direction: RealtimeSessionDirection;
  transportOverride?: RealtimeTransportKind;
  role: UserRole;
  tokenId?: string | null;
  operatorIds?: string[];
  label?: string | null;
  clientKind: string;
  publicLiveKitUrl?: string;
  previewSessionId?: string;
  roomName: string;
  requestHeaders?: Record<string, string | string[] | undefined>;
  requestProtocol?: string;
}

function getHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function hostIncludesExplicitPort(host: string): boolean {
  if (host.startsWith('[')) {
    return /\]:\d+$/.test(host);
  }

  const firstColon = host.indexOf(':');
  const lastColon = host.lastIndexOf(':');
  return firstColon !== -1 && firstColon === lastColon;
}

function tryGetUrlHost(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    return new URL(value).host || null;
  } catch {
    return null;
  }
}

function buildCompatIdentity(direction: RealtimeSessionDirection, stablePart: string): string {
  const safeStablePart = stablePart.replace(/[^a-zA-Z0-9:_-]/g, '-');
  return `compat-${direction}:${safeStablePart}:${randomUUID()}`;
}

export class RealtimeTransportManager {
  private static instance: RealtimeTransportManager | null = null;

  static initialize(engine: DigitalRadioEngine, liveKitBridgeManager: LiveKitBridgeManager): RealtimeTransportManager {
    RealtimeTransportManager.instance = new RealtimeTransportManager(engine, liveKitBridgeManager);
    return RealtimeTransportManager.instance;
  }

  static getInstance(): RealtimeTransportManager {
    if (!RealtimeTransportManager.instance) {
      throw new Error('RealtimeTransportManager is not initialized');
    }
    return RealtimeTransportManager.instance;
  }

  private readonly authService = new LiveKitAuthService();
  private readonly compatSessions = new Map<string, CompatSessionRecord>();
  private readonly compatSocketContexts = new WeakMap<WebSocket, CompatSocketContext>();
  private readonly stationManager = OpenWebRXStationManager.getInstance();

  private constructor(
    private readonly engine: DigitalRadioEngine,
    private readonly liveKitBridgeManager: LiveKitBridgeManager,
  ) {}

  async issueSession(params: IssueRealtimeSessionParams): Promise<RealtimeSessionResponse> {
    const hints = LiveKitConfig.getConnectivityHints();
    const selection = this.determineTransportSelection(
      params.scope,
      params.direction,
      params.transportOverride,
    );
    const forceCompat = selection.forcedCompatibilityMode;
    const preferredTransport = selection.transport;
    const liveKitOffer = forceCompat || params.transportOverride === 'ws-compat'
      ? null
      : await this.buildLiveKitOffer(params, hints);
    const compatOffer = this.buildCompatOffer(params);

    const offers: RealtimeTransportOffer[] = [];
    const preferredOffer = preferredTransport === 'livekit' ? liveKitOffer : compatOffer;
    const secondaryOffer = preferredTransport === 'livekit' ? compatOffer : liveKitOffer;

    if (preferredOffer) {
      offers.push(preferredOffer);
    }
    if (secondaryOffer && secondaryOffer.transport !== preferredTransport && !params.transportOverride) {
      offers.push(secondaryOffer);
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
    };
  }

  getPreferredTransport(scope: RealtimeScope, direction: RealtimeSessionDirection): RealtimeTransportKind {
    return this.determineTransportSelection(scope, direction).transport;
  }

  getScopeHealth(scope: RealtimeScope): { healthy: boolean; updatedAt: number; issueCode: string | null } {
    return this.liveKitBridgeManager.getScopeHealth(scope);
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

    if (session.direction === 'recv') {
      const monitor = this.resolveAudioMonitor(session.scope, session.previewSessionId);
      if (!monitor) {
        socket.close(4004, 'Realtime audio source is not available');
        return;
      }

      let sequence = 0;
      const handleAudioData = (data: {
        audioData: ArrayBuffer;
        sampleRate: number;
        samples: number;
        timestamp: number;
      }) => {
        if (socket.readyState !== 1) {
          return;
        }

        try {
          const pcm = float32ToInt16Pcm(new Float32Array(data.audioData));
          const payload = encodeWsCompatAudioFrame({
            sequence: sequence++,
            timestampMs: data.timestamp,
            sampleRate: data.sampleRate,
            channels: 1,
            samplesPerChannel: data.samples,
            pcm,
          });
          socket.send(Buffer.from(payload));
        } catch (error) {
          logger.debug('Failed to send compatibility audio frame', error);
        }
      };

      monitor.on('audioData', handleAudioData);
      context.cleanup = () => {
        monitor.off('audioData', handleAudioData);
      };
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
      socket.on('message', (payload: Buffer | ArrayBuffer | Buffer[]) => {
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

        try {
          const decoded = decodeWsCompatAudioFrame(
            buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
          );
          const float32 = int16ToFloat32Pcm(decoded.pcm);
          if (!hasLoggedFirstCompatUplinkFrame) {
            hasLoggedFirstCompatUplinkFrame = true;
            logger.info('First compatibility uplink audio frame received', {
              scope: session.scope,
              participantIdentity: session.participantIdentity,
              sampleRate: decoded.sampleRate,
              samplesPerChannel: decoded.samplesPerChannel,
            });
          }
          void this.engine.getVoiceSessionManager()?.handleParticipantAudioFrame(
            session.participantIdentity,
            float32,
            decoded.sampleRate,
          );
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

  private determineTransportSelection(
    scope: RealtimeScope,
    direction: RealtimeSessionDirection,
    transportOverride?: RealtimeTransportKind,
  ): {
    transport: RealtimeTransportKind;
    forcedCompatibilityMode: boolean;
    policy: 'auto' | 'force-compat';
    reason: RealtimeTransportSelectionReason;
  } {
    const policy = ConfigManager.getInstance().getRealtimeTransportPolicy();
    const liveKitEnabled = LiveKitConfig.isEnabled();

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

    if (!liveKitEnabled) {
      return {
        transport: 'ws-compat',
        forcedCompatibilityMode: true,
        policy,
        reason: 'livekit-disabled',
      };
    }

    if (transportOverride === 'livekit') {
      return {
        transport: 'livekit',
        forcedCompatibilityMode: false,
        policy,
        reason: 'client-override',
      };
    }

    if (direction === 'recv') {
      const health = this.liveKitBridgeManager.getScopeHealth(scope);
      if (!health.healthy) {
        return {
          transport: 'ws-compat',
          forcedCompatibilityMode: false,
          policy,
          reason: 'bridge-unhealthy',
        };
      }
    }

    return {
      transport: 'livekit',
      forcedCompatibilityMode: false,
      policy,
      reason: 'default-livekit',
    };
  }

  private async buildLiveKitOffer(
    params: IssueRealtimeSessionParams,
    hints: RealtimeConnectivityHints,
  ): Promise<RealtimeTransportOffer | null> {
    if (!LiveKitConfig.isEnabled()) {
      return null;
    }

    try {
      const tokenResponse = this.authService.issueClientToken({
        roomName: params.roomName,
        scope: params.scope,
        publish: params.direction === 'send',
        publicWsUrl: params.publicLiveKitUrl,
        role: params.role,
        tokenId: params.tokenId,
        operatorIds: params.operatorIds,
        label: params.label,
        clientKind: params.clientKind,
        previewSessionId: params.previewSessionId,
      });
      const finalized = await this.authService.finalizeToken(tokenResponse);
      return {
        transport: 'livekit',
        direction: params.direction,
        url: finalized.url || hints.signalingUrl,
        token: finalized.token,
        participantIdentity: finalized.participantIdentity,
        participantName: finalized.participantName,
        roomName: finalized.roomName,
      };
    } catch (error) {
      logger.warn('Failed to build LiveKit realtime offer, compatibility mode will be used', {
        scope: params.scope,
        direction: params.direction,
        error,
      });
      return null;
    }
  }

  private buildCompatOffer(params: IssueRealtimeSessionParams): RealtimeTransportOffer {
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
      expiresAt: Date.now() + COMPAT_TOKEN_TTL_MS,
    });

    return {
      transport: 'ws-compat',
      direction: params.direction,
      url: this.resolveCompatWsUrl(params.requestHeaders, params.requestProtocol),
      token,
      participantIdentity,
      participantName: params.label ?? null,
      roomName: params.roomName,
    };
  }

  private resolveCompatWsUrl(
    headers?: Record<string, string | string[] | undefined>,
    requestProtocol?: string,
  ): string {
    const protocol = getHeaderValue(headers?.['x-forwarded-proto'])?.split(',')[0]?.trim()
      || requestProtocol
      || 'http';
    const forwardedHost = getHeaderValue(headers?.['x-forwarded-host'])?.split(',')[0]?.trim();
    const hostHeader = getHeaderValue(headers?.host)?.split(',')[0]?.trim();
    const forwardedPort = getHeaderValue(headers?.['x-forwarded-port'])?.split(',')[0]?.trim();
    const originHost = tryGetUrlHost(getHeaderValue(headers?.origin)?.split(',')[0]?.trim());
    const refererHost = tryGetUrlHost(getHeaderValue(headers?.referer)?.split(',')[0]?.trim());

    let host = forwardedHost || hostHeader || originHost || refererHost || '127.0.0.1:4000';
    if (!hostIncludesExplicitPort(host)) {
      const originHostWithPort = [originHost, refererHost]
        .find((candidate): candidate is string => Boolean(candidate && hostIncludesExplicitPort(candidate)));
      if (originHostWithPort) {
        host = originHostWithPort;
      } else if (forwardedPort && forwardedPort.length > 0) {
        host = `${host}:${forwardedPort}`;
      }
    }

    const wsProtocol = protocol === 'https' ? 'wss' : 'ws';
    return `${wsProtocol}://${host}/api/realtime/ws-compat`;
  }

  private resolveAudioMonitor(scope: RealtimeScope, previewSessionId?: string): AudioMonitorService | null {
    if (scope === 'radio') {
      return this.engine.getAudioMonitorService();
    }

    const status = this.stationManager.getListenStatus();
    if (!status?.isListening || !status.previewSessionId || status.previewSessionId !== previewSessionId) {
      return null;
    }
    return this.stationManager.getAudioMonitorService();
  }
}
