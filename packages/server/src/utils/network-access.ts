import os, { type NetworkInterfaceInfo } from 'node:os';

const DEFAULT_WEB_PORT = 8076;

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
  const interfaces = options.networkInterfaces ?? os.networkInterfaces();
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
    hostname: options.hostname ?? os.hostname(),
    webPort,
  };
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
