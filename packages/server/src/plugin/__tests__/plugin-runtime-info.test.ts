import { describe, expect, it } from 'vitest';
import { buildPluginRuntimeInfo, resolvePluginDistribution } from '../runtime-info.js';

describe('plugin runtime info', () => {
  it('prefers electron when embedded desktop environment markers are present', () => {
    expect(resolvePluginDistribution('/Users/demo/Library/Application Support/TX-5DR', {
      env: { APP_RESOURCES: '/Applications/TX-5DR.app/Contents/Resources' } as NodeJS.ProcessEnv,
      hasDockerEnvFile: false,
    })).toBe('electron');
  });

  it('detects docker from the canonical data directory', () => {
    expect(resolvePluginDistribution('/app/data', {
      env: {} as NodeJS.ProcessEnv,
      hasDockerEnvFile: false,
    })).toBe('docker');
  });

  it('detects linux service from the packaged server data directory', () => {
    expect(resolvePluginDistribution('/var/lib/tx5dr', {
      env: { NODE_ENV: 'production' } as NodeJS.ProcessEnv,
      hasDockerEnvFile: false,
    })).toBe('linux-service');
  });

  it('detects generic dev runtime when development mode is active', () => {
    expect(resolvePluginDistribution('/home/dev/.local/share/TX-5DR', {
      env: { NODE_ENV: 'development' } as NodeJS.ProcessEnv,
      hasDockerEnvFile: false,
    })).toBe('web-dev');
  });

  it('builds pluginDir from dataDir and exposes the default docker host hint', () => {
    expect(buildPluginRuntimeInfo({
      configDir: '/app/data/config',
      dataDir: '/app/data',
      logsDir: '/app/data/logs',
      cacheDir: '/app/data/cache',
    }, {
      env: {} as NodeJS.ProcessEnv,
      hasDockerEnvFile: false,
    })).toEqual({
      pluginDir: '/app/data/plugins',
      pluginDataDir: '/app/data/plugin-data',
      dataDir: '/app/data',
      configDir: '/app/data/config',
      logsDir: '/app/data/logs',
      cacheDir: '/app/data/cache',
      distribution: 'docker',
      hostPluginDirHint: './data/plugins',
    });
  });
});
