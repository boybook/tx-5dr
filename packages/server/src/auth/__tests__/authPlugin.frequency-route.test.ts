import Fastify, { type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Permission, UserRole } from '@tx5dr/contracts';
import { buildAbility } from '../ability.js';
import { requireAbilityFor } from '../authPlugin.js';

describe('requireAbilityFor radio frequency routes', () => {
  let fastify: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    fastify = Fastify();
    fastify.decorateRequest('authUser', null);
    fastify.decorateRequest('ability');
    fastify.addHook('onRequest', async (request: FastifyRequest) => {
      const role = request.headers['x-role'];
      const frequencyGrant = request.headers['x-frequency-grant'];
      request.authUser = {
        tokenId: 'test-token',
        role: role === UserRole.ADMIN ? UserRole.ADMIN : UserRole.OPERATOR,
        operatorIds: ['operator-1'],
        iat: 0,
        exp: 0,
      };
      request.ability = buildAbility({
        role: request.authUser.role,
        permissionGrants: request.authUser.role === UserRole.ADMIN
          ? undefined
          : frequencyGrant === 'range'
            ? [{
              permission: Permission.RADIO_SET_FREQUENCY,
              conditions: { frequency: { $gte: 14_000_000, $lte: 14_350_000 } },
            }]
            : [{
              permission: Permission.RADIO_SET_FREQUENCY,
              conditions: { frequency: { $in: [7_050_000] } },
            }],
      });
    });
    fastify.post('/radio/frequency', {
      preHandler: [requireAbilityFor('execute', 'RadioFrequency', (request) => ({
        frequency: (request.body as { frequency: number }).frequency,
      }))],
    }, async (request: FastifyRequest) => ({
      success: true,
      frequency: (request.body as { frequency: number }).frequency,
    }));
  });

  afterEach(async () => {
    await fastify.close();
  });

  it('allows in-range frequency requests and rejects out-of-range requests', async () => {
    const allowed = await fastify.inject({
      method: 'POST',
      url: '/radio/frequency',
      headers: { 'x-frequency-grant': 'range' },
      payload: { frequency: 14_270_000 },
    });
    const denied = await fastify.inject({
      method: 'POST',
      url: '/radio/frequency',
      headers: { 'x-frequency-grant': 'range' },
      payload: { frequency: 14_500_000 },
    });

    expect(allowed.statusCode).toBe(200);
    expect(denied.statusCode).toBe(403);
  });

  it('allows preset frequency requests and lets admins bypass conditions', async () => {
    const presetAllowed = await fastify.inject({
      method: 'POST',
      url: '/radio/frequency',
      payload: { frequency: 7_050_000 },
    });
    const adminAllowed = await fastify.inject({
      method: 'POST',
      url: '/radio/frequency',
      headers: { 'x-role': UserRole.ADMIN },
      payload: { frequency: 999_000_000 },
    });

    expect(presetAllowed.statusCode).toBe(200);
    expect(adminAllowed.statusCode).toBe(200);
  });
});
