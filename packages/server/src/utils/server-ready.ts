import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_SERVER_PORT = 4000;
export const DEFAULT_SERVER_PORT_SCAN_STEPS = 50;

export interface ServerPortOptions {
  requestedPort: number;
  autoPort: boolean;
  scanSteps: number;
}

export interface ServerReadyState {
  pid: number;
  timestamp: string;
  requestedPort: number;
  httpPort: number | null;
  baseUrl: string | null;
  healthOk: boolean;
  autoPort: boolean;
  error?: {
    code: string | null;
    message: string;
    attemptedPort?: number;
    startPort?: number;
    endPort?: number;
  } | null;
}

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : fallback;
}

function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function isEnabled(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value || '').toLowerCase());
}

function isDisabled(value: string | undefined): boolean {
  return ['0', 'false', 'no', 'off'].includes((value || '').toLowerCase());
}

export function resolveServerPortOptions(env: NodeJS.ProcessEnv = process.env): ServerPortOptions {
  const hasExplicitPort = typeof env.PORT === 'string' && env.PORT.trim() !== '';
  const requestedPort = parsePort(env.PORT, DEFAULT_SERVER_PORT);
  const forcedAuto = isEnabled(env.TX5DR_SERVER_PORT_AUTO);
  const forcedStrict = isEnabled(env.TX5DR_SERVER_PORT_STRICT) || isDisabled(env.TX5DR_SERVER_PORT_AUTO);

  return {
    requestedPort,
    autoPort: !forcedStrict && (forcedAuto || !hasExplicitPort),
    scanSteps: parseNonNegativeInteger(env.TX5DR_SERVER_PORT_SCAN_STEPS, DEFAULT_SERVER_PORT_SCAN_STEPS),
  };
}

export function getServerReadyFilePath(env: NodeJS.ProcessEnv = process.env): string | null {
  const readyFile = env.TX5DR_SERVER_READY_FILE?.trim();
  return readyFile || null;
}

export async function writeServerReadyFile(state: ServerReadyState, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const readyFile = getServerReadyFilePath(env);
  if (!readyFile) return;

  await mkdir(path.dirname(readyFile), { recursive: true });
  await writeFile(readyFile, JSON.stringify(state, null, 2), 'utf-8');
}

export function createServerReadyState(options: {
  requestedPort: number;
  httpPort: number | null;
  autoPort: boolean;
  error?: ServerReadyState['error'];
}): ServerReadyState {
  const baseUrl = options.httpPort ? `http://127.0.0.1:${options.httpPort}` : null;
  return {
    pid: process.pid,
    timestamp: new Date().toISOString(),
    requestedPort: options.requestedPort,
    httpPort: options.httpPort,
    baseUrl,
    healthOk: Boolean(options.httpPort),
    autoPort: options.autoPort,
    error: options.error ?? null,
  };
}
