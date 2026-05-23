import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  buildChildRuntimeEnv,
  buildNativeModuleCheckExitResult,
  isDegradableNativeModuleCheckFailure,
} from '../nativeRuntime.js';

const RESOURCES_ROOT = path.join(path.sep, 'opt', 'TX-5DR', 'resources');

describe('native runtime child environment', () => {
  it('does not put wsjtx-lib prebuilds on Linux LD_LIBRARY_PATH', () => {
    const env = buildChildRuntimeEnv({
      platform: 'linux',
      resourcesRoot: RESOURCES_ROOT,
      triplet: 'linux-x64',
      currentEnv: { LD_LIBRARY_PATH: '/usr/local/lib' } as NodeJS.ProcessEnv,
    });

    expect(env.LD_LIBRARY_PATH).toBe([
      path.join(RESOURCES_ROOT, 'native'),
      '/usr/local/lib',
    ].join(':'));
    expect(env.LD_LIBRARY_PATH).not.toContain('wsjtx-lib');
    expect(env.NODE_PATH).toBe(path.join(RESOURCES_ROOT, 'app', 'node_modules'));
  });

  it('keeps wsjtx-lib prebuilds on macOS DYLD_LIBRARY_PATH for dylib lookup', () => {
    const env = buildChildRuntimeEnv({
      platform: 'darwin',
      resourcesRoot: RESOURCES_ROOT,
      triplet: 'darwin-arm64',
      currentEnv: { DYLD_LIBRARY_PATH: '/opt/local/lib' } as NodeJS.ProcessEnv,
    });

    expect(env.DYLD_LIBRARY_PATH).toBe([
      path.join(RESOURCES_ROOT, 'app', 'node_modules', 'wsjtx-lib', 'prebuilds', 'darwin-arm64'),
      path.join(RESOURCES_ROOT, 'native'),
      '/opt/local/lib',
    ].join(':'));
  });
});

describe('native module check result handling', () => {
  it('treats parsed module failures as unsuccessful even when the checker exits cleanly', () => {
    const result = buildNativeModuleCheckExitResult({
      code: 0,
      signal: null,
      lastChecking: null,
      modules: [
        { name: 'serialport', ok: true },
        { name: 'audify', ok: false, error: 'GLIBCXX_3.4.32 not found' },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.crashedModule).toBeNull();
    expect(isDegradableNativeModuleCheckFailure(result)).toBe(false);
  });

  it('allows node-datachannel failures to remain degradable', () => {
    const result = buildNativeModuleCheckExitResult({
      code: 0,
      signal: null,
      lastChecking: null,
      modules: [
        { name: 'audify', ok: true },
        { name: 'node-datachannel', ok: false, error: 'optional transport failed' },
      ],
    });

    expect(result.success).toBe(false);
    expect(isDegradableNativeModuleCheckFailure(result)).toBe(true);
  });
});
