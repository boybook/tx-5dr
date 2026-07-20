import Fastify, { type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Permission, UserRole } from '@tx5dr/contracts';
import { buildAbility } from '../../auth/ability.js';
import { RadioError, RadioErrorCode } from '../../utils/errors/RadioError.js';

const { state, handleRequest } = vi.hoisted(() => ({
  state: { activeProfileId: 'profile-a' as string | null },
  handleRequest: vi.fn(),
}));

vi.mock('../../config/config-manager.js', () => ({
  ConfigManager: {
    getInstance: () => ({
      getActiveProfileId: () => state.activeProfileId,
    }),
  },
}));

vi.mock('../../DigitalRadioEngine.js', () => ({
  DigitalRadioEngine: {
    getInstance: () => ({
      getRadioPowerController: () => ({ handleRequest }),
    }),
  },
}));

describe('powerRoutes Profile authorization', () => {
  let fastify: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    state.activeProfileId = 'profile-a';
    handleRequest.mockReset().mockResolvedValue('awake');
    const { powerRoutes } = await import('../power.js');
    fastify = Fastify();
    fastify.decorateRequest('authUser', null);
    fastify.decorateRequest('ability', null);
    fastify.addHook('onRequest', async (request: FastifyRequest) => {
      const role = request.headers['x-role'];
      const resolvedRole = typeof role === 'string' ? role as UserRole : null;
      request.authUser = resolvedRole
        ? {
          tokenId: 'test-token',
          role: resolvedRole,
          operatorIds: [],
          iat: 0,
          exp: 0,
        }
        : null;
      request.ability = buildAbility({
        role: resolvedRole ?? UserRole.VIEWER,
        permissionGrants: request.headers['x-power-grant'] === 'true'
          ? [{ permission: Permission.RADIO_POWER }]
          : [],
      });
    });
    await fastify.register(powerRoutes, { prefix: '/api/radio/power' });
  });

  afterEach(async () => {
    await fastify.close();
  });

  it('allows delegated power for the current active Profile', async () => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/radio/power',
      headers: {
        'x-role': UserRole.OPERATOR,
        'x-power-grant': 'true',
      },
      payload: { profileId: 'profile-a', state: 'on' },
    });

    expect(response.statusCode).toBe(200);
    expect(handleRequest).toHaveBeenCalledWith(
      { profileId: 'profile-a', state: 'on', autoEngine: true },
      { allowProfileActivation: false },
    );
  });

  it('rejects delegated power for a different Profile', async () => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/radio/power',
      headers: {
        'x-role': UserRole.OPERATOR,
        'x-power-grant': 'true',
      },
      payload: { profileId: 'profile-b', state: 'on' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(handleRequest).not.toHaveBeenCalled();
  });

  it('allows an administrator to power and activate a different Profile', async () => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/radio/power',
      headers: { 'x-role': UserRole.ADMIN },
      payload: { profileId: 'profile-b', state: 'on', autoEngine: false },
    });

    expect(response.statusCode).toBe(200);
    expect(handleRequest).toHaveBeenCalledWith(
      { profileId: 'profile-b', state: 'on', autoEngine: false },
      { allowProfileActivation: true },
    );
  });

  it('maps a lock-time Profile authorization failure to HTTP 403', async () => {
    handleRequest.mockImplementationOnce(async () => {
      state.activeProfileId = 'profile-b';
      throw new RadioError({
        code: RadioErrorCode.INVALID_OPERATION,
        message: 'Power operation may not activate Profile profile-a',
        context: { reason: 'profile-activation-not-authorized' },
      });
    });

    const response = await fastify.inject({
      method: 'POST',
      url: '/api/radio/power',
      headers: {
        'x-role': UserRole.OPERATOR,
        'x-power-grant': 'true',
      },
      payload: { profileId: 'profile-a', state: 'on' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
  });
});
