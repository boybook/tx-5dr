import type { HamlibConfig } from '@tx5dr/contracts';
import type { SpectrumSupportSummary } from 'hamlib/spectrum';
import { HamlibConnection } from '../radio/connections/HamlibConnection.js';
import type { IRadioConnection } from '../radio/connections/IRadioConnection.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('HamlibSpectrumConfig');

export const DEFAULT_HAMLIB_SPECTRUM_SPEED = 10;

export interface HamlibSpectrumRuntimeConfig {
  speed: number;
}

export function resolveHamlibSpectrumRuntimeConfig(config: HamlibConfig): HamlibSpectrumRuntimeConfig {
  const configuredSpeed = config.spectrum?.speed;
  return {
    speed: typeof configuredSpeed === 'number' && Number.isInteger(configuredSpeed)
      ? configuredSpeed
      : DEFAULT_HAMLIB_SPECTRUM_SPEED,
  };
}

export function supportsHamlibSpectrumSpeed(summary: SpectrumSupportSummary): boolean {
  return summary.configurableLevels.includes('SPECTRUM_SPEED');
}

export async function applyHamlibSpectrumRuntimeConfig(
  connection: IRadioConnection | null,
  config: HamlibConfig,
): Promise<boolean> {
  if (!(connection instanceof HamlibConnection) || config.type !== 'serial') {
    return false;
  }

  const runtimeConfig = resolveHamlibSpectrumRuntimeConfig(config);

  try {
    await connection.applySpectrumRuntimeConfig?.(runtimeConfig);
    logger.debug('Processed Hamlib spectrum runtime config request', {
      speed: runtimeConfig.speed,
      configuredSpeed: config.spectrum?.speed ?? null,
    });
    return true;
  } catch (error) {
    logger.warn('Failed to apply Hamlib spectrum runtime config', error);
    return false;
  }
}
