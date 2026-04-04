import { describe, expect, it, vi } from 'vitest';

import { HamlibConnection } from '../../radio/connections/HamlibConnection.js';
import {
  applyHamlibSpectrumRuntimeConfig,
  DEFAULT_HAMLIB_SPECTRUM_SPEED,
  resolveHamlibSpectrumRuntimeConfig,
} from '../hamlibSpectrumConfig.js';

describe('hamlibSpectrumConfig', () => {
  it('uses the default speed when profile does not define one', () => {
    expect(resolveHamlibSpectrumRuntimeConfig({ type: 'serial' as const })).toEqual({
      speed: DEFAULT_HAMLIB_SPECTRUM_SPEED,
    });
  });

  it('uses the configured profile speed when present', () => {
    expect(resolveHamlibSpectrumRuntimeConfig({
      type: 'serial',
      spectrum: { speed: 5 },
    })).toEqual({ speed: 5 });
  });

  it('applies runtime speed updates to active Hamlib serial connections', async () => {
    const connection = new HamlibConnection();
    const applySpectrumRuntimeConfig = vi
      .spyOn(connection, 'applySpectrumRuntimeConfig')
      .mockResolvedValue(undefined);

    const applied = await applyHamlibSpectrumRuntimeConfig(connection, {
      type: 'serial',
      spectrum: { speed: 20 },
    });

    expect(applied).toBe(true);
    expect(applySpectrumRuntimeConfig).toHaveBeenCalledWith({ speed: 20 });
  });

  it('skips hot updates for non-serial configs', async () => {
    const connection = new HamlibConnection();
    const applySpectrumRuntimeConfig = vi
      .spyOn(connection, 'applySpectrumRuntimeConfig')
      .mockResolvedValue(undefined);

    const applied = await applyHamlibSpectrumRuntimeConfig(connection, {
      type: 'network',
      network: { host: '127.0.0.1', port: 4532 },
      spectrum: { speed: 20 },
    });

    expect(applied).toBe(false);
    expect(applySpectrumRuntimeConfig).not.toHaveBeenCalled();
  });
});
