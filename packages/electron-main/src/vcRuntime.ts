import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface WindowsVCRuntimeStatus {
  installed: boolean;
  versionOk: boolean;
  version: string | null;
  source: 'app-local' | 'registry' | 'filesystem' | 'missing';
  detail: string;
}

export const VC_REDIST_X64_URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe';
export const VC_REDIST_REGISTRY_KEYS = [
  'HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64',
] as const;
export const VC_REDIST_REQUIRED_DLLS = [
  'vcruntime140.dll',
  'vcruntime140_1.dll',
  'msvcp140.dll',
  'msvcp140_1.dll',
  'msvcp140_atomic_wait.dll',
] as const;
export const VC_REDIST_MIN_VERSION = { major: 14, minor: 30 } as const; // VS 2022 = 14.3x series

type RegistryValueReader = (key: string, valueName: string) => string | null;

interface DetectWindowsVCRuntimeOptions {
  platform?: NodeJS.Platform;
  resourcesRoot?: string;
  triplet?: string;
  systemRoot?: string;
  existsSync?: (filePath: string) => boolean;
  queryRegistryValue?: RegistryValueReader;
}

export function queryWindowsRegistryValue(key: string, valueName: string): string | null {
  const probe = spawnSync('reg', ['query', key, '/v', valueName], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (probe.status !== 0) {
    return null;
  }

  const pattern = new RegExp(`^\\s*${valueName}\\s+REG_\\w+\\s+(.+)$`, 'im');
  const match = probe.stdout.match(pattern);
  return match?.[1]?.trim() || null;
}

export function parseVCRuntimeVersion(versionStr: string): { major: number; minor: number } | null {
  const match = versionStr.match(/^v?(\d+)\.(\d+)/);
  if (!match) return null;
  return { major: parseInt(match[1], 10), minor: parseInt(match[2], 10) };
}

export function isVCRuntimeVersionSufficient(versionStr: string): boolean {
  const parsed = parseVCRuntimeVersion(versionStr);
  if (!parsed) return false;
  if (parsed.major !== VC_REDIST_MIN_VERSION.major) {
    return parsed.major > VC_REDIST_MIN_VERSION.major;
  }
  return parsed.minor >= VC_REDIST_MIN_VERSION.minor;
}

function getMissingVCRuntimeDlls(dir: string, existsSync: (filePath: string) => boolean): string[] {
  return VC_REDIST_REQUIRED_DLLS.filter((dllName) => !existsSync(path.join(dir, dllName)));
}

export function buildWindowsChildPath(resourcesRoot: string, triplet: string, currentPath = ''): string {
  const entries = [
    path.join(resourcesRoot, 'bin', triplet),
    path.join(resourcesRoot, 'native'),
    currentPath,
  ].filter((entry) => entry.length > 0);

  return entries.join(';');
}

export function detectWindowsVCRuntime(options: DetectWindowsVCRuntimeOptions = {}): WindowsVCRuntimeStatus {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') {
    return { installed: true, versionOk: true, version: null, source: 'registry', detail: 'not-applicable' };
  }

  const existsSync = options.existsSync ?? fs.existsSync;
  if (options.resourcesRoot && options.triplet) {
    const appLocalDir = path.join(options.resourcesRoot, 'bin', options.triplet);
    const missingAppLocalDlls = getMissingVCRuntimeDlls(appLocalDir, existsSync);
    if (missingAppLocalDlls.length === 0) {
      return {
        installed: true,
        versionOk: true,
        version: null,
        source: 'app-local',
        detail: appLocalDir,
      };
    }
  }

  const readRegistryValue = options.queryRegistryValue ?? queryWindowsRegistryValue;
  for (const key of VC_REDIST_REGISTRY_KEYS) {
    const installed = readRegistryValue(key, 'Installed');
    if (installed === '0x1' || installed === '1') {
      const version = readRegistryValue(key, 'Version') || 'unknown';
      const versionOk = version !== 'unknown' && isVCRuntimeVersionSufficient(version);
      return {
        installed: true,
        versionOk,
        version,
        source: 'registry',
        detail: `${key} (Version=${version})`,
      };
    }
  }

  const systemRoot = options.systemRoot || process.env.SystemRoot || 'C:\\Windows';
  const system32 = path.join(systemRoot, 'System32');
  const missingSystemDlls = getMissingVCRuntimeDlls(system32, existsSync);
  if (missingSystemDlls.length === 0) {
    return {
      installed: true,
      versionOk: true,
      version: null,
      source: 'filesystem',
      detail: system32,
    };
  }

  return {
    installed: false,
    versionOk: false,
    version: null,
    source: 'missing',
    detail: `missing DLLs: ${missingSystemDlls.join(', ')}`,
  };
}
