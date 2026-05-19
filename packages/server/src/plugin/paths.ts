import path from 'node:path';

export interface PluginPaths {
  pluginDir: string;
  pluginDataDir: string;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolvePluginPaths(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): PluginPaths {
  return {
    pluginDir: nonEmpty(env.TX5DR_PLUGINS_DIR) ?? path.join(dataDir, 'plugins'),
    pluginDataDir: nonEmpty(env.TX5DR_PLUGIN_DATA_DIR) ?? path.join(dataDir, 'plugin-data'),
  };
}
