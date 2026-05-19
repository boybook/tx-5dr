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

  it('prefers Android bridge runtime flavor over docker filesystem markers', () => {
    expect(resolvePluginDistribution('/opt/tx5dr-data', {
      env: { TX5DR_RUNTIME_FLAVOR: 'android-bridge', NODE_ENV: 'production' } as NodeJS.ProcessEnv,
      hasDockerEnvFile: true,
    })).toBe('android-bridge');
  });

  it('does not expose docker host mapping hints for Android bridge runtime', () => {
    expect(buildPluginRuntimeInfo({
      configDir: '/opt/tx5dr-data/config',
      dataDir: '/opt/tx5dr-data',
      logsDir: '/opt/tx5dr-data/logs',
      cacheDir: '/opt/tx5dr-data/cache',
    }, {
      env: { TX5DR_RUNTIME_FLAVOR: 'android-bridge' } as NodeJS.ProcessEnv,
      hasDockerEnvFile: true,
    })).toEqual({
      pluginDir: '/opt/tx5dr-data/plugins',
      pluginDataDir: '/opt/tx5dr-data/plugin-data',
      dataDir: '/opt/tx5dr-data',
      configDir: '/opt/tx5dr-data/config',
      logsDir: '/opt/tx5dr-data/logs',
      cacheDir: '/opt/tx5dr-data/cache',
      distribution: 'android-bridge',
    });
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
