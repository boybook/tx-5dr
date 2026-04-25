import { existsSync } from 'node:fs';
import path from 'node:path';
import type { PluginDistribution, PluginRuntimeInfo } from '@tx5dr/contracts';
import { tx5drPaths } from '../utils/app-paths.js';
import { resolveRuntimeDistribution, type RuntimeDetectionOptions } from '../utils/runtime-distribution.js';


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
  return resolveRuntimeDistribution(dataDir, {
    env: options.env,
    hasDockerEnvFile: options.hasDockerEnvFile ?? existsSync('/.dockerenv'),
  });
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
