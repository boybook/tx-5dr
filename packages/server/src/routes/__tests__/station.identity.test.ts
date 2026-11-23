import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StationIdentitySchema, type StationIdentity } from '@tx5dr/contracts';

vi.mock('../../config/config-manager.js', () => ({
  ConfigManager: {
    getInstance: () => ({
      getStationInfo: () => ({ callsign: 'BG7XXX' }),
      updateStationInfo: vi.fn(),
    }),
  },
}));

const identity: StationIdentity = {
  identityVersion: 1,
  product: 'tx5dr',
  instanceId: '6f1c2c1e-3d7b-4c55-9a4c-1f5b9a7c2e10',
  hostVersion: '1.2.3',
  sourceSha: 'abcdef1234567890',
  channel: 'nightly',
  distribution: 'docker',
  auth: { enabled: true, allowPublicViewing: false },
  desktopBridge: { minVersion: 1 },
};

describe('GET /api/station/identity', () => {
  let fastify: FastifyInstance;

  beforeEach(async () => {
    const { stationRoutes } = await import('../station.js');
    fastify = Fastify();
    await fastify.register(stationRoutes, {
      prefix: '/api/station',
      identityService: { getIdentity: async () => identity } as never,
    });
  });

  afterEach(async () => {
    await fastify.close();
  });

  it('is public and returns the identity contract without caching', async () => {
    const response = await fastify.inject({ method: 'GET', url: '/api/station/identity' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(StationIdentitySchema.parse(response.json())).toEqual(identity);
  });

  it('does not expose station profile data such as the callsign', async () => {
    const response = await fastify.inject({ method: 'GET', url: '/api/station/identity' });

    expect(response.body).not.toContain('BG7XXX');
  });
});
