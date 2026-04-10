import { createLogger } from '../utils/logger.js';
import { ConfigManager } from '../config/config-manager.js';
import type { RealtimeConnectivityHints } from '@tx5dr/contracts';
import {
  getLiveKitCredentialRuntimeStatus,
  getLiveKitCredentialValues,
} from './LiveKitCredentialState.js';
import { resolveBrowserFacingRequestOrigin } from './requestOrigin.js';

const logger = createLogger('LiveKitConfig');

const DEFAULT_LIVEKIT_WS_URL = 'ws://127.0.0.1:7880';
const DEFAULT_LIVEKIT_TCP_PORT = 7881;
const DEFAULT_LIVEKIT_UDP_PORT_RANGE = '50000-50100';
const DEFAULT_LIVEKIT_PUBLIC_PATH = '/livekit';

export interface LiveKitConnectionConfig {
  wsUrl: string;
  publicWsUrl: string | null;
  apiKey: string;
  apiSecret: string;
}

interface LiveKitWsConfig {
  wsUrl: string;
  publicWsUrl: string | null;
}

interface LiveKitRequestContext {
  headers?: Record<string, string | string[] | undefined>;
  protocol?: string;
}

export class LiveKitConfig {
  private static runtimeAvailable = false;
  private static runtimeUnavailableReason: string | null = null;

  static isEnabled(): boolean {
    return process.env.LIVEKIT_DISABLED !== '1' && Boolean(getLiveKitCredentialValues());
  }

  static isExplicitlyDisabled(): boolean {
    return process.env.LIVEKIT_DISABLED === '1';
  }

  /**
   * Set the runtime availability of the LiveKit server.
   * Called by LiveKitBridgeManager after connection attempt.
   */
  static setRuntimeAvailable(available: boolean, reason?: string): void {
    const changed = this.runtimeAvailable !== available;
    this.runtimeAvailable = available;
    this.runtimeUnavailableReason = available ? null : (reason ?? null);
    if (changed) {
      logger.info('LiveKit runtime availability changed', { available, reason: reason ?? null });
    }
  }

  /**
   * Single source of truth: is LiveKit usable right now?
   * Combines static config check (credentials + env) with runtime connectivity.
   */
  static isRuntimeAvailable(): boolean {
    return this.isEnabled() && this.runtimeAvailable;
  }

  static getRuntimeUnavailableReason(): string | null {
    if (!this.isEnabled()) {
      return this.isExplicitlyDisabled() ? 'disabled-by-env' : 'credentials-missing';
    }
    return this.runtimeUnavailableReason;
  }

  private static getSignalingPort(wsUrl: string): string {
    try {
      const parsed = new URL(wsUrl);
      return parsed.port || (parsed.protocol === 'wss:' || parsed.protocol === 'https:' ? '443' : '80');
    } catch {
      return '7880';
    }
  }

  private static getPublicPathPrefix(): string {
    return DEFAULT_LIVEKIT_PUBLIC_PATH;
  }

  private static getWsConfig(): LiveKitWsConfig {
    return {
      wsUrl: process.env.LIVEKIT_URL || DEFAULT_LIVEKIT_WS_URL,
      publicWsUrl: ConfigManager.getInstance().getLiveKitPublicUrl() || null,
    };
  }

  static getConnectionConfig(): LiveKitConnectionConfig {
    const wsConfig = this.getWsConfig();
    const credentials = getLiveKitCredentialValues();
    if (!credentials) {
      throw new Error('LiveKit credentials are not initialized');
    }

    return {
      wsUrl: wsConfig.wsUrl,
      publicWsUrl: wsConfig.publicWsUrl,
      apiKey: credentials.apiKey,
      apiSecret: credentials.apiSecret,
    };
  }

  static getConnectivityHints(request?: LiveKitRequestContext): RealtimeConnectivityHints {
    const config = this.getWsConfig();
    const signalingUrl = this.resolvePublicWsUrl(request);

    let signalingPort = 7880;
    try {
      const parsed = new URL(signalingUrl);
      signalingPort = Number(parsed.port || (parsed.protocol === 'wss:' ? '443' : '80'));
    } catch {
      signalingPort = Number(this.getSignalingPort(config.wsUrl));
    }

    const rtcTcpPort = Number(process.env.LIVEKIT_TCP_PORT || DEFAULT_LIVEKIT_TCP_PORT);
    const udpPortRange = process.env.LIVEKIT_UDP_PORT_RANGE || DEFAULT_LIVEKIT_UDP_PORT_RANGE;

    return {
      signalingUrl,
      signalingPort: Number.isFinite(signalingPort) ? signalingPort : 7880,
      rtcTcpPort: Number.isFinite(rtcTcpPort) ? rtcTcpPort : DEFAULT_LIVEKIT_TCP_PORT,
      udpPortRange,
      publicUrlOverrideActive: Boolean(config.publicWsUrl),
    };
  }

  static logEffectiveConfig(): void {
    const status = getLiveKitCredentialRuntimeStatus();
    const explicitlyDisabled = this.isExplicitlyDisabled();
    const enabled = this.isEnabled();
    logger.info('LiveKit config loaded', {
      enabled,
      explicitlyDisabled,
      wsUrl: process.env.LIVEKIT_URL || DEFAULT_LIVEKIT_WS_URL,
      publicWsUrl: ConfigManager.getInstance().getLiveKitPublicUrl() || `<derived-from-request>${DEFAULT_LIVEKIT_PUBLIC_PATH}`,
      credentialSource: status.source,
      apiKeyPreview: status.apiKeyPreview,
      credentialFilePath: status.filePath,
      fallbackMode: !enabled && !explicitlyDisabled ? 'ws-compat' : null,
    });
  }

  static resolvePublicWsUrl(request?: LiveKitRequestContext): string {
    const config = this.getWsConfig();
    if (config.publicWsUrl) {
      return config.publicWsUrl;
    }

    const publicPathPrefix = this.getPublicPathPrefix();
    const origin = resolveBrowserFacingRequestOrigin({
      headers: request?.headers,
      requestProtocol: request?.protocol,
      fallbackHost: new URL(config.wsUrl).host,
    });

    const wsProtocol = origin.protocol === 'https' ? 'wss' : 'ws';
    const publicUrl = new URL(`${wsProtocol}://${origin.host}`);
    publicUrl.protocol = `${wsProtocol}:`;
    publicUrl.pathname = publicPathPrefix;
    publicUrl.search = '';
    publicUrl.hash = '';
    return publicUrl.toString().replace(/\/$/, publicPathPrefix === '/' ? '/' : '');
  }
}
