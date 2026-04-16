import fs from 'fs';
import path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('LiveKitCredentialState');
const MANAGED_LINUX_LIVEKIT_CREDENTIAL_PATH = '/etc/tx5dr/livekit-credentials.env';
const MANAGED_LINUX_LIVEKIT_CONFIG_PATH = '/var/lib/tx5dr/realtime/livekit.resolved.yaml';
const MANAGED_LINUX_TX5DR_CONFIG_DIR = '/var/lib/tx5dr/config';

export type LiveKitCredentialSource = 'managed-file' | 'environment-override' | 'missing';

export interface LiveKitCredentialValues {
  apiKey: string;
  apiSecret: string;
}

export interface LiveKitCredentialRuntimeStatus {
  initialized: boolean;
  source: LiveKitCredentialSource;
  filePath: string | null;
  apiKeyPreview: string | null;
  createdAt: string | null;
  rotatedAt: string | null;
}

interface ParsedCredentialFile extends LiveKitCredentialValues {
  createdAt: string | null;
  rotatedAt: string | null;
}

function isManagedLinuxDeployment(): boolean {
  const liveKitConfigFile = process.env.LIVEKIT_CONFIG_FILE?.trim();
  if (liveKitConfigFile === MANAGED_LINUX_LIVEKIT_CONFIG_PATH) {
    return true;
  }

  const configDir = process.env.TX5DR_CONFIG_DIR?.trim();
  if (configDir === MANAGED_LINUX_TX5DR_CONFIG_DIR) {
    return true;
  }

  return fs.existsSync('/etc/tx5dr/config.env') || fs.existsSync(MANAGED_LINUX_LIVEKIT_CREDENTIAL_PATH);
}

export function resolveLiveKitCredentialFilePath(): string | null {
  const explicit = process.env.LIVEKIT_CREDENTIALS_FILE?.trim();
  if (explicit) {
    return explicit;
  }

  if (isManagedLinuxDeployment()) {
    return MANAGED_LINUX_LIVEKIT_CREDENTIAL_PATH;
  }

  const configDir = process.env.TX5DR_CONFIG_DIR?.trim();
  if (configDir) {
    return path.join(configDir, 'livekit-credentials.env');
  }

  return null;
}

function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith('\'') && value.endsWith('\''))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function readCredentialFile(filePath: string | null): ParsedCredentialFile | null {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }

  try {
    const parsed = parseEnvFile(fs.readFileSync(filePath, 'utf-8'));
    const apiKey = parsed.LIVEKIT_API_KEY?.trim();
    const apiSecret = parsed.LIVEKIT_API_SECRET?.trim();
    if (!apiKey || !apiSecret) {
      return null;
    }

    return {
      apiKey,
      apiSecret,
      createdAt: parsed.LIVEKIT_CREDENTIALS_CREATED_AT?.trim() || null,
      rotatedAt: parsed.LIVEKIT_CREDENTIALS_ROTATED_AT?.trim() || null,
    };
  } catch (error) {
    logger.warn('Failed to read LiveKit credential file', { filePath, error });
    return null;
  }
}

function readEnvironmentCredentials(): LiveKitCredentialValues | null {
  const apiKey = process.env.LIVEKIT_API_KEY?.trim();
  const apiSecret = process.env.LIVEKIT_API_SECRET?.trim();
  if (!apiKey || !apiSecret) {
    return null;
  }
  return { apiKey, apiSecret };
}

function maskApiKey(apiKey: string | null): string | null {
  if (!apiKey) {
    return null;
  }
  if (apiKey.length <= 10) {
    return `${apiKey.slice(0, 3)}***`;
  }
  return `${apiKey.slice(0, 6)}...${apiKey.slice(-4)}`;
}

export function getLiveKitCredentialValues(): LiveKitCredentialValues | null {
  const envCredentials = readEnvironmentCredentials();
  if (envCredentials) {
    return envCredentials;
  }

  const fileCredentials = readCredentialFile(resolveLiveKitCredentialFilePath());
  if (!fileCredentials) {
    return null;
  }

  return {
    apiKey: fileCredentials.apiKey,
    apiSecret: fileCredentials.apiSecret,
  };
}

export function getLiveKitCredentialRuntimeStatus(): LiveKitCredentialRuntimeStatus {
  const filePath = resolveLiveKitCredentialFilePath();
  const envCredentials = readEnvironmentCredentials();
  if (envCredentials) {
    return {
      initialized: true,
      source: 'environment-override',
      filePath,
      apiKeyPreview: maskApiKey(envCredentials.apiKey),
      createdAt: null,
      rotatedAt: null,
    };
  }

  const fileCredentials = readCredentialFile(filePath);
  if (!fileCredentials) {
    return {
      initialized: false,
      source: 'missing',
      filePath,
      apiKeyPreview: null,
      createdAt: null,
      rotatedAt: null,
    };
  }

  return {
    initialized: true,
    source: 'managed-file',
    filePath,
    apiKeyPreview: maskApiKey(fileCredentials.apiKey),
    createdAt: fileCredentials.createdAt,
    rotatedAt: fileCredentials.rotatedAt,
  };
}

export function assertLiveKitCredentialsReady(): void {
  if (getLiveKitCredentialValues()) {
    return;
  }

  const filePath = resolveLiveKitCredentialFilePath();
  const hint = filePath
    ? `Expected managed credential file: ${filePath}`
    : 'Set LIVEKIT_CREDENTIALS_FILE or provide LIVEKIT_API_KEY / LIVEKIT_API_SECRET explicitly.';
  throw new Error(`LiveKit credentials are not initialized. ${hint}`);
}
