import os, { type NetworkInterfaceInfo } from 'node:os';
import { readFileSync } from 'node:fs';
import { createLogger } from './logger.js';

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
      addresses?: Array<{ ip?: unknown }>;
    };
    const webPort = parsePort(parsed.webPort) ?? fallbackWebPort;
    const addresses = Array.isArray(parsed.addresses)
      ? parsed.addresses
        .map(address => typeof address?.ip === 'string' ? address.ip.trim() : '')
        .filter(isUsableIpv4)
        .map(ip => ({ ip, url: `http://${ip}:${webPort}` }))
      : [];
    const hostname = typeof parsed.hostname === 'string' && parsed.hostname.trim()
      ? parsed.hostname.trim()
      : (options.hostname ?? 'android');
    return { addresses, hostname, webPort };
  } catch (error) {
    logger.warn('Failed to read injected network access file', {
      filePath,
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      addresses: [],
      hostname: options.hostname ?? 'android',
      webPort: fallbackWebPort,
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
