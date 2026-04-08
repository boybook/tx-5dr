import { existsSync } from 'node:fs';
import path from 'node:path';
import type { PluginDistribution, PluginRuntimeInfo } from '@tx5dr/contracts';
import { tx5drPaths } from '../utils/app-paths.js';

function normalizeEnvValue(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

interface RuntimeDetectionOptions {
  env?: NodeJS.ProcessEnv;
  hasDockerEnvFile?: boolean;
}

interface PluginRuntimePaths {
  configDir: string;
  dataDir: string;
  logsDir: string;
  cacheDir: string;
}

export function resolvePluginDistribution(
  dataDir: string,
  options: RuntimeDetectionOptions = {},
): PluginDistribution {
  const env = options.env ?? process.env;
  const hasDockerEnvFile = options.hasDockerEnvFile ?? existsSync('/.dockerenv');

  if (normalizeEnvValue(env.APP_RESOURCES) || normalizeEnvValue(env.EMBEDDED) === 'true') {
    return 'electron';
  }

  if (hasDockerEnvFile || dataDir === '/app/data') {
    return 'docker';
  }

  if (env.NODE_ENV === 'development') {
    return 'web-dev';
  }

  if (dataDir === '/var/lib/tx5dr') {
    return 'linux-service';
  }

  return 'generic-server';
}

export function buildPluginRuntimeInfo(
  paths: PluginRuntimePaths,
  options: RuntimeDetectionOptions = {},
): PluginRuntimeInfo {
  const distribution = resolvePluginDistribution(paths.dataDir, options);
  const info: PluginRuntimeInfo = {
    pluginDir: path.join(paths.dataDir, 'plugins'),
    pluginDataDir: path.join(paths.dataDir, 'plugin-data'),
    dataDir: paths.dataDir,
    configDir: paths.configDir,
    logsDir: paths.logsDir,
    cacheDir: paths.cacheDir,
    distribution,
  };

  if (distribution === 'docker' && paths.dataDir === '/app/data') {
    info.hostPluginDirHint = './data/plugins';
  }

  return info;
}

export async function getPluginRuntimeInfo(): Promise<PluginRuntimeInfo> {
  const [configDir, dataDir, logsDir, cacheDir] = await Promise.all([
    tx5drPaths.getConfigDir(),
    tx5drPaths.getDataDir(),
    tx5drPaths.getLogsDir(),
    tx5drPaths.getCacheDir(),
  ]);

  return buildPluginRuntimeInfo({ configDir, dataDir, logsDir, cacheDir });
}
