import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  VC_REDIST_REGISTRY_KEYS,
  VC_REDIST_REQUIRED_DLLS,
  buildWindowsChildPath,
  detectWindowsVCRuntime,
} from '../vcRuntime.js';

const RESOURCES_ROOT = path.join(path.sep, 'app', 'resources');
const TRIPLET = 'win32-x64';

describe('Windows VC runtime detection', () => {
  it('accepts app-local VC runtime DLLs before checking the system', () => {
    const appLocalDir = path.join(RESOURCES_ROOT, 'bin', TRIPLET);
    const existing = new Set(VC_REDIST_REQUIRED_DLLS.map((dll) => path.join(appLocalDir, dll)));

    const status = detectWindowsVCRuntime({
      platform: 'win32',
      resourcesRoot: RESOURCES_ROOT,
      triplet: TRIPLET,
      existsSync: (filePath) => existing.has(filePath),
      queryRegistryValue: () => {
        throw new Error('registry should not be queried when app-local DLLs are complete');
      },
    });

    expect(status).toMatchObject({
      installed: true,
      versionOk: true,
      source: 'app-local',
      detail: appLocalDir,
    });
  });

  it('falls back to an installed system VC runtime when app-local DLLs are missing', () => {
    const status = detectWindowsVCRuntime({
      platform: 'win32',
      resourcesRoot: RESOURCES_ROOT,
      triplet: TRIPLET,
      existsSync: () => false,
      queryRegistryValue: (_key, valueName) => valueName === 'Installed' ? '0x1' : 'v14.40.33810.0',
    });

    expect(status).toMatchObject({
      installed: true,
      versionOk: true,
      source: 'registry',
      version: 'v14.40.33810.0',
    });
  });

  it('reports an outdated system VC runtime when registry version is too old', () => {
    const status = detectWindowsVCRuntime({
      platform: 'win32',
      resourcesRoot: RESOURCES_ROOT,
      triplet: TRIPLET,
      existsSync: () => false,
      queryRegistryValue: (_key, valueName) => valueName === 'Installed' ? '1' : 'v14.20.10000.0',
    });

    expect(status).toMatchObject({
      installed: true,
      versionOk: false,
      source: 'registry',
      version: 'v14.20.10000.0',
    });
  });

  it('falls back to System32 DLL detection when registry keys are absent', () => {
    const systemRoot = 'C:\\Windows';
    const system32 = path.join(systemRoot, 'System32');
    const existing = new Set(VC_REDIST_REQUIRED_DLLS.map((dll) => path.join(system32, dll)));

    const status = detectWindowsVCRuntime({
      platform: 'win32',
      resourcesRoot: RESOURCES_ROOT,
      triplet: TRIPLET,
      systemRoot,
      existsSync: (filePath) => existing.has(filePath),
      queryRegistryValue: () => null,
    });

    expect(status).toMatchObject({
      installed: true,
      versionOk: true,
      source: 'filesystem',
      detail: system32,
    });
  });

  it('reports missing DLLs when neither app-local nor system runtime is available', () => {
    const status = detectWindowsVCRuntime({
      platform: 'win32',
      resourcesRoot: RESOURCES_ROOT,
      triplet: TRIPLET,
      existsSync: () => false,
      queryRegistryValue: () => null,
    });

    expect(status).toMatchObject({
      installed: false,
      versionOk: false,
      source: 'missing',
    });
    expect(status.detail).toContain('vcruntime140.dll');
    expect(status.detail).toContain('msvcp140_atomic_wait.dll');
  });

  it('checks both x64 VC runtime registry locations', () => {
    expect(VC_REDIST_REGISTRY_KEYS).toHaveLength(2);
    expect(VC_REDIST_REGISTRY_KEYS.every((key) => key.includes('Runtimes\\x64'))).toBe(true);
  });
});

describe('Windows child process PATH', () => {
  it('prepends app-local node and native directories before the original PATH', () => {
    const result = buildWindowsChildPath(RESOURCES_ROOT, TRIPLET, 'C:\\Windows\\System32');

    expect(result).toBe([
      path.join(RESOURCES_ROOT, 'bin', TRIPLET),
      path.join(RESOURCES_ROOT, 'native'),
      'C:\\Windows\\System32',
    ].join(';'));
  });
});
