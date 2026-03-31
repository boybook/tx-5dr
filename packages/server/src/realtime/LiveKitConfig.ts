import { createLogger } from '../utils/logger.js';
import { ConfigManager } from '../config/config-manager.js';
import type { RealtimeConnectivityHints } from '@tx5dr/contracts';
import {
  getLiveKitCredentialRuntimeStatus,
  getLiveKitCredentialValues,
} from './LiveKitCredentialState.js';

const logger = createLogger('LiveKitConfig');

const DEFAULT_LIVEKIT_WS_URL = 'ws://127.0.0.1:7880';
const DEFAULT_LIVEKIT_TCP_PORT = 7881;
const DEFAULT_LIVEKIT_UDP_PORT_RANGE = '50000-50100';

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

export class LiveKitConfig {
  static isEnabled(): boolean {
    return process.env.LIVEKIT_DISABLED !== '1' && Boolean(getLiveKitCredentialValues());
  }

  static isExplicitlyDisabled(): boolean {
    return process.env.LIVEKIT_DISABLED === '1';
  }

  private static getHeaderValue(value: string | string[] | undefined): string | undefined {
    if (Array.isArray(value)) {
      return value[0];
    }
    return value;
  }

  private static getSignalingPort(wsUrl: string): string {
    try {
      const parsed = new URL(wsUrl);
      return parsed.port || (parsed.protocol === 'wss:' || parsed.protocol === 'https:' ? '443' : '80');
    } catch {
      return '7880';
    }
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

  static getConnectivityHints(): RealtimeConnectivityHints {
    const config = this.getWsConfig();

    let signalingPort = 7880;
    try {
      const parsed = new URL(config.publicWsUrl || config.wsUrl);
      signalingPort = Number(parsed.port || (parsed.protocol === 'wss:' ? '443' : '80'));
    } catch {
      signalingPort = Number(this.getSignalingPort(config.wsUrl));
    }

    const rtcTcpPort = Number(process.env.LIVEKIT_TCP_PORT || DEFAULT_LIVEKIT_TCP_PORT);
    const udpPortRange = process.env.LIVEKIT_UDP_PORT_RANGE || DEFAULT_LIVEKIT_UDP_PORT_RANGE;

    return {
      signalingUrl: config.publicWsUrl || config.wsUrl,
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
      publicWsUrl: ConfigManager.getInstance().getLiveKitPublicUrl() || '<derived-from-request>',
      credentialSource: status.source,
      apiKeyPreview: status.apiKeyPreview,
      credentialFilePath: status.filePath,
      fallbackMode: !enabled && !explicitlyDisabled ? 'ws-compat' : null,
    });
  }

  static resolvePublicWsUrl(request?: {
    headers?: Record<string, string | string[] | undefined>;
    protocol?: string;
  }): string {
    const config = this.getWsConfig();
    if (config.publicWsUrl) {
      return config.publicWsUrl;
    }

    const headers = request?.headers ?? {};
    const protocol = this.getHeaderValue(headers['x-forwarded-proto'])?.split(',')[0]?.trim();
    const forwardedHost = this.getHeaderValue(headers['x-forwarded-host'])?.split(',')[0]?.trim();
    const hostHeader = this.getHeaderValue(headers.host)?.split(',')[0]?.trim();
    const host = forwardedHost || hostHeader;

    if (!host) {
      return config.wsUrl;
    }

    const wsProtocol = (protocol || request?.protocol || 'http') === 'https' ? 'wss' : 'ws';
    const publicUrl = new URL(`${wsProtocol}://${host}`);
    publicUrl.protocol = `${wsProtocol}:`;
    publicUrl.port = this.getSignalingPort(config.wsUrl);
    publicUrl.pathname = '';
    publicUrl.search = '';
    publicUrl.hash = '';
    return publicUrl.toString().replace(/\/$/, '');
  }
}
