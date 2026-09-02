import Fastify, { type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getSpectrumPresetDefinition,
  UserRole,
  type SpectrumCustomSettings,
  type SpectrumPreset,
} from '@tx5dr/contracts';

const state = vi.hoisted(() => ({
  preset: 'balanced' as SpectrumPreset,
  revision: 0,
  update: vi.fn(),
}));

vi.mock('../../auth/AuthManager.js', () => ({
  AuthManager: {
    hasMinRole: (role: UserRole, required: UserRole) => {
      const levels = { [UserRole.VIEWER]: 0, [UserRole.OPERATOR]: 1, [UserRole.ADMIN]: 2 };
      return levels[role] >= levels[required];
    },
  },
}));

vi.mock('../../DigitalRadioEngine.js', () => ({
  DigitalRadioEngine: {
    getInstance: () => ({
      getSpectrumScheduler: () => ({
        getRenderConfig: () => ({
          ...getSpectrumPresetDefinition(state.preset === 'custom' ? 'balanced' : state.preset),
          ...(state.preset === 'custom' ? { preset: 'custom' as const } : {}),
          revision: state.revision,
        }),
      }),
      updateSpectrumSettings: state.update.mockImplementation(async (preset: SpectrumPreset, customSettings?: SpectrumCustomSettings) => {
        state.preset = preset;
        state.revision += 1;
        if (preset === 'custom' && customSettings) {
          return {
            ...getSpectrumPresetDefinition('balanced'),
            preset: 'custom' as const,
            revision: state.revision,
            analysisIntervalMs: customSettings.analysisIntervalMs,
            frameRateHz: 1000 / customSettings.analysisIntervalMs,
            fftSize: customSettings.fftSize,
            targetSampleRate: customSettings.targetSampleRate,
            fftWindowDurationMs: (customSettings.fftSize / customSettings.targetSampleRate) * 1000,
            frequencyResolutionHz: customSettings.targetSampleRate / customSettings.fftSize,
            frequencyRange: { min: 0, max: customSettings.targetSampleRate / 2 },
            displayBinCount: customSettings.fftSize / 2 + 1,
            windowFunction: customSettings.windowFunction,
            haloReduce: customSettings.haloReduce,
            customSettings,
          };
        }
        return {
          ...getSpectrumPresetDefinition(preset === 'custom' ? 'balanced' : preset),
          revision: state.revision,
        };
      }),
    }),
  },
}));

describe('spectrum settings authorization', () => {
  let fastify: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    state.preset = 'balanced';
    state.revision = 0;
    state.update.mockClear();
    const { spectrumSettingsReadRoutes, spectrumSettingsWriteRoutes } = await import('../spectrum-settings.js');
    fastify = Fastify();
    fastify.decorateRequest('authUser', null);
    fastify.addHook('onRequest', async (request: FastifyRequest) => {
      const role = request.headers['x-role'];
      request.authUser = typeof role === 'string'
        ? { tokenId: 'test', role: role as UserRole, operatorIds: [], iat: 0, exp: 0 }
        : null;
    });
    await fastify.register(spectrumSettingsReadRoutes, { prefix: '/api/audio/spectrum-settings' });
    await fastify.register(spectrumSettingsWriteRoutes, { prefix: '/api/audio/spectrum-settings' });
  });

  afterEach(async () => {
    await fastify.close();
  });

  it('allows authenticated viewers to read but only admins to write', async () => {
    const read = await fastify.inject({
      method: 'GET',
      url: '/api/audio/spectrum-settings',
      headers: { 'x-role': UserRole.OPERATOR },
    });
    const denied = await fastify.inject({
      method: 'POST',
      url: '/api/audio/spectrum-settings',
      headers: { 'x-role': UserRole.OPERATOR },
      payload: { preset: 'responsive' },
    });
    const updated = await fastify.inject({
      method: 'POST',
      url: '/api/audio/spectrum-settings',
      headers: { 'x-role': UserRole.ADMIN },
      payload: { preset: 'responsive' },
    });

    expect(read.statusCode).toBe(200);
    expect(denied.statusCode).toBe(403);
    expect(updated.statusCode).toBe(200);
    expect(state.update).toHaveBeenCalledWith('responsive', undefined);
  });

  it('requires authentication for reads', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/api/audio/spectrum-settings',
    });

    expect(response.statusCode).toBe(401);
  });

  it('forwards a validated custom draft only for admin writes', async () => {
    const custom = {
      analysisIntervalMs: 275,
      fftSize: 4096,
      targetSampleRate: 8000,
      windowFunction: 'hann',
      haloReduce: true,
    } as const;
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/audio/spectrum-settings',
      headers: { 'x-role': UserRole.ADMIN },
      payload: { preset: 'custom', settings: custom },
    });

    expect(response.statusCode).toBe(200);
    expect(state.update).toHaveBeenCalledWith('custom', custom);
  });
});
