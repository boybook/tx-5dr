import os, { type NetworkInterfaceInfo } from 'node:os';
import { readFileSync } from 'node:fs';
import { createLogger } from './logger.js';
import type { PluginDistribution, RemoteAccessPreset } from '@tx5dr/contracts';
import { resolveRuntimeDistribution } from './runtime-distribution.js';

const DEFAULT_WEB_PORT = 8076;
const logger = createLogger('NetworkAccess');

export interface NetworkAccessAddress {
  ip: string;
  url: string;
}

export interface NetworkAccessInfo {
  addresses: NetworkAccessAddress[];
  hostname: string;
  webPort: number;
  exposure: RemoteAccessPreset;
  listenHost: string;
  runtimeManagement: 'electron' | 'external';
  distribution: PluginDistribution;
  supportsLocalOnly: boolean;
  supportedPresets: RemoteAccessPreset[];
  activeConnections: number;
  maxConnections: number;
}

export interface NetworkAccessInfoOptions {
  forwardedPort?: string | string[] | undefined;
  webPort?: number | string | null | undefined;
  env?: NodeJS.ProcessEnv;
  hostname?: string;
  networkInterfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>;
}

export function getNetworkAccessInfo(options: NetworkAccessInfoOptions = {}): NetworkAccessInfo {
  const webPort = resolveWebPort(options);
  const injected = getInjectedNetworkAccessInfo(options, webPort);
  if (injected) return injected;

  const interfaces = options.networkInterfaces ?? safeNetworkInterfaces();
  const addresses: NetworkAccessAddress[] = [];

  for (const nets of Object.values(interfaces)) {
    if (!nets) continue;
    for (const net of nets) {
      if (net.family === 'IPv4' && !net.internal && !net.address.startsWith('169.254.')) {
        addresses.push({
          ip: net.address,
          url: `http://${net.address}:${webPort}`,
        });
      }
    }
  }

  return {
    addresses,
    hostname: options.hostname ?? safeHostname(),
    webPort,
    ...getRuntimeMetadata(options.env),
  };
}

function getRuntimeMetadata(envInput?: NodeJS.ProcessEnv) {
  const env = envInput ?? process.env;
  const listenHost = env.TX5DR_WEB_LISTEN_HOST?.trim() || env.HOST?.trim() || '0.0.0.0';
  const distribution = resolveRuntimeDistribution(env.TX5DR_DATA_DIR || '', {
    env: env.TX5DR_RUNTIME_MANAGEMENT === 'electron'
      ? { ...env, APP_RESOURCES: env.APP_RESOURCES || 'electron-runtime' }
      : env,
  });
  const supportsLocalOnly = distribution === 'electron';
  return {
    exposure: (listenHost === '127.0.0.1' || listenHost === '::1' || listenHost === 'localhost' ? 'local' : 'lan') as RemoteAccessPreset,
    listenHost,
    runtimeManagement: env.TX5DR_RUNTIME_MANAGEMENT === 'electron' ? 'electron' as const : 'external' as const,
    distribution,
    supportsLocalOnly,
    supportedPresets: (supportsLocalOnly ? ['local', 'lan', 'public'] : ['lan', 'public']) as RemoteAccessPreset[],
    activeConnections: 0,
    maxConnections: 32,
  };
}

function getInjectedNetworkAccessInfo(options: NetworkAccessInfoOptions, fallbackWebPort: number): NetworkAccessInfo | null {
  const env = options.env ?? process.env;
  const filePath = env.TX5DR_NETWORK_ACCESS_FILE?.trim();
  if (!filePath) return null;

  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as {
      hostname?: unknown;
      webPort?: unknown;
      httpPort?: unknown;
      listenHost?: unknown;
      addresses?: Array<{ ip?: unknown }>;
      publicUrls?: unknown;
    };
    const webPort = parsePort(parsed.webPort ?? parsed.httpPort) ?? fallbackWebPort;
    const parsedAddresses = Array.isArray(parsed.addresses)
      ? parsed.addresses
        .map(address => typeof address?.ip === 'string' ? address.ip.trim() : '')
      : [];
    const publicUrlAddresses = Array.isArray(parsed.publicUrls)
      ? parsed.publicUrls.flatMap(value => {
          if (typeof value !== 'string') return [];
          try { return [new URL(value).hostname]; } catch { return []; }
        })
      : [];
    const listenHost = typeof parsed.listenHost === 'string' ? parsed.listenHost : undefined;
    const enumeratedAddresses = parsedAddresses.length === 0
      && publicUrlAddresses.length === 0
      && listenHost
      && !['127.0.0.1', '::1', 'localhost'].includes(listenHost)
      ? Object.values(options.networkInterfaces ?? safeNetworkInterfaces())
        .flatMap(nets => nets ?? [])
        .filter(net => net.family === 'IPv4' && !net.internal)
        .map(net => net.address)
      : [];
    const runtime = getRuntimeMetadata({
      ...(options.env ?? process.env),
      ...(listenHost ? { TX5DR_WEB_LISTEN_HOST: listenHost } : {}),
    });
    const addresses = (runtime.exposure === 'local' ? [] : [...new Set([...parsedAddresses, ...publicUrlAddresses, ...enumeratedAddresses])])
      .filter(isUsableIpv4)
      .map(ip => ({ ip, url: `http://${ip}:${webPort}` }));
    const hostname = typeof parsed.hostname === 'string' && parsed.hostname.trim()
      ? parsed.hostname.trim()
      : (options.hostname ?? 'android');
    return { addresses, hostname, webPort, ...runtime };
  } catch (error) {
    logger.warn('Failed to read injected network access file', {
      filePath,
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      addresses: [],
      hostname: options.hostname ?? 'android',
      webPort: fallbackWebPort,
      ...getRuntimeMetadata(options.env),
    };
  }
}

function isUsableIpv4(value: string): boolean {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return false;
  const parts = value.split('.').map(part => Number(part));
  if (parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  if (parts[0] === 127) return false;
  if (parts[0] === 169 && parts[1] === 254) return false;
  if (parts[0] === 0) return false;
  return true;
}

function safeNetworkInterfaces(): NodeJS.Dict<NetworkInterfaceInfo[]> {
  try {
    return os.networkInterfaces();
  } catch (error) {
    logger.warn('Failed to enumerate network interfaces', error);
    return {};
  }
}

function safeHostname(): string {
  try {
    return os.hostname();
  } catch {
    return 'localhost';
  }
}

function resolveWebPort(options: NetworkAccessInfoOptions): number {
  const forwardedPort = Array.isArray(options.forwardedPort) ? options.forwardedPort[0] : options.forwardedPort;
  return parsePort(forwardedPort)
    ?? parsePort(options.webPort)
    ?? parsePort((options.env ?? process.env).WEB_PORT)
    ?? DEFAULT_WEB_PORT;
}

function parsePort(value: unknown): number | null {
  if (typeof value === 'number') return Number.isInteger(value) && value > 0 && value < 65536 ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : null;
}
