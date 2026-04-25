import { existsSync } from 'node:fs';
import type { PluginDistribution } from '@tx5dr/contracts';

function normalizeEnvValue(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export interface RuntimeDetectionOptions {
  env?: NodeJS.ProcessEnv;
  hasDockerEnvFile?: boolean;
}

export function resolveRuntimeDistribution(
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

