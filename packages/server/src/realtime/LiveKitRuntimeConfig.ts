import { promises as fs } from 'fs';
import net from 'net';
import path from 'path';
import type { LiveKitNetworkMode } from '@tx5dr/contracts';
import { createLogger } from '../utils/logger.js';
import { getLiveKitCredentialValues } from './LiveKitCredentialState.js';

const logger = createLogger('LiveKitRuntimeConfig');

export interface ManagedLiveKitSettings {
  networkMode: LiveKitNetworkMode;
  nodeIp: string | null;
}

export interface LiveKitPortConfig {
  signalPort: number;
  tcpPort: number;
  udpStart: number;
  udpEnd: number;
}

const DEFAULT_PORT_CONFIG: LiveKitPortConfig = {
  signalPort: 7880,
  tcpPort: 7881,
  udpStart: 50000,
  udpEnd: 50100,
};

export const DEFAULT_MANAGED_LIVEKIT_SETTINGS: ManagedLiveKitSettings = {
  networkMode: 'lan',
  nodeIp: null,
};

function parsePositiveInt(rawValue: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(rawValue ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeNodeIp(rawValue: unknown): string | null {
  if (typeof rawValue !== 'string') {
    return null;
  }

  const trimmed = rawValue.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function isValidIpv4Address(value: string): boolean {
  return net.isIP(value) === 4;
}

export function normalizeManagedLiveKitSettings(rawValue: unknown): ManagedLiveKitSettings {
  if (!rawValue || typeof rawValue !== 'object') {
    return { ...DEFAULT_MANAGED_LIVEKIT_SETTINGS };
  }

  const record = rawValue as Record<string, unknown>;
  const rawMode = record.networkMode ?? record.livekitNetworkMode;
  const networkMode: LiveKitNetworkMode = rawMode === 'internet-auto' || rawMode === 'internet-manual' || rawMode === 'lan'
    ? rawMode
    : 'lan';

  const nodeIp = normalizeNodeIp(record.nodeIp ?? record.livekitNodeIp);

  return {
    networkMode,
    nodeIp,
  };
}

export function validateManagedLiveKitSettings(settings: ManagedLiveKitSettings): void {
  if (settings.networkMode !== 'internet-manual') {
    return;
  }

  if (!settings.nodeIp) {
    throw new Error('Manual LiveKit media mode requires nodeIp');
  }

  if (!isValidIpv4Address(settings.nodeIp)) {
    throw new Error(`Invalid LiveKit nodeIp: ${settings.nodeIp}`);
  }
}

export function resolveLiveKitPortConfig(env: NodeJS.ProcessEnv = process.env): LiveKitPortConfig {
  let udpStart = parsePositiveInt(env.LIVEKIT_UDP_PORT_START, DEFAULT_PORT_CONFIG.udpStart);
  let udpEnd = parsePositiveInt(env.LIVEKIT_UDP_PORT_END, DEFAULT_PORT_CONFIG.udpEnd);

  if (!env.LIVEKIT_UDP_PORT_START && !env.LIVEKIT_UDP_PORT_END && env.LIVEKIT_UDP_PORT_RANGE) {
    const [rangeStart, rangeEnd] = env.LIVEKIT_UDP_PORT_RANGE.split('-', 2);
    udpStart = parsePositiveInt(rangeStart, udpStart);
    udpEnd = parsePositiveInt(rangeEnd, udpEnd);
  }

  if (udpEnd < udpStart) {
    udpEnd = udpStart;
  }

  return {
    signalPort: parsePositiveInt(env.LIVEKIT_SIGNAL_PORT, DEFAULT_PORT_CONFIG.signalPort),
    tcpPort: parsePositiveInt(env.LIVEKIT_TCP_PORT, DEFAULT_PORT_CONFIG.tcpPort),
    udpStart,
    udpEnd,
  };
}

export function resolveLiveKitRuntimeConfigPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.LIVEKIT_CONFIG_PATH?.trim() || env.LIVEKIT_CONFIG_FILE?.trim();
  if (explicit) {
    return explicit;
  }

  const configDir = env.TX5DR_CONFIG_DIR?.trim();
  if (configDir) {
    return path.join(configDir, 'livekit.resolved.yaml');
  }

  return null;
}

export function buildLiveKitRuntimeConfigYaml(
  settings: ManagedLiveKitSettings,
  ports: LiveKitPortConfig,
  apiKey: string,
  apiSecret: string,
): string {
  validateManagedLiveKitSettings(settings);

  const lines = [
    `port: ${ports.signalPort}`,
    'rtc:',
    `  tcp_port: ${ports.tcpPort}`,
    `  port_range_start: ${ports.udpStart}`,
    `  port_range_end: ${ports.udpEnd}`,
  ];

  if (settings.networkMode === 'internet-auto') {
    lines.push('  use_external_ip: true');
  } else {
    lines.push('  use_external_ip: false');
    if (settings.networkMode === 'internet-manual' && settings.nodeIp) {
      lines.push(`  node_ip: ${settings.nodeIp}`);
    }
  }

  lines.push(
    'keys:',
    `  ${apiKey}: ${apiSecret}`,
    'logging:',
    '  level: info',
    '',
  );

  return lines.join('\n');
}

export async function loadManagedLiveKitSettingsFromConfigFile(configFilePath: string): Promise<ManagedLiveKitSettings> {
  try {
    const content = await fs.readFile(configFilePath, 'utf-8');
    return normalizeManagedLiveKitSettings(JSON.parse(content));
  } catch (error) {
    logger.debug('Falling back to default LiveKit settings because config file could not be read', {
      configFilePath,
      message: error instanceof Error ? error.message : String(error),
    });
    return { ...DEFAULT_MANAGED_LIVEKIT_SETTINGS };
  }
}

export async function writeManagedLiveKitRuntimeConfig(options: {
  settings: ManagedLiveKitSettings;
  outputPath?: string | null;
  ports?: LiveKitPortConfig;
  credentials?: { apiKey: string; apiSecret: string } | null;
}): Promise<{ outputPath: string; settings: ManagedLiveKitSettings } | null> {
  const outputPath = options.outputPath ?? resolveLiveKitRuntimeConfigPath();
  if (!outputPath) {
    return null;
  }

  const credentials = options.credentials ?? getLiveKitCredentialValues();
  if (!credentials) {
    logger.debug('Skipping managed LiveKit config write because credentials are missing');
    return null;
  }

  const settings = normalizeManagedLiveKitSettings(options.settings);
  validateManagedLiveKitSettings(settings);

  const ports = options.ports ?? resolveLiveKitPortConfig();
  const content = buildLiveKitRuntimeConfigYaml(settings, ports, credentials.apiKey, credentials.apiSecret);

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, content, 'utf-8');

  logger.info('Managed LiveKit runtime config written', {
    outputPath,
    networkMode: settings.networkMode,
    nodeIp: settings.nodeIp,
    signalPort: ports.signalPort,
    tcpPort: ports.tcpPort,
    udpStart: ports.udpStart,
    udpEnd: ports.udpEnd,
  });

  return { outputPath, settings };
}
