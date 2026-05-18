import Fastify, { type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserRole, type RadioProfile } from '@tx5dr/contracts';

const profile: RadioProfile = {
  id: 'profile-icom',
  name: 'IC-705 WLAN',
  description: 'shack radio',
  radio: {
    type: 'icom-wlan',
    icomWlan: {
      ip: '192.168.1.50',
      port: 50001,
      userName: 'radio-user',
      password: 'radio-secret',
      dataMode: true,
    },
    pttPort: '/dev/tty.ptt',
    cwKeyPort: '/dev/tty.cw',
  },
  audio: {
    inputDeviceName: 'IC-705 Mic',
    outputDeviceName: 'IC-705 Speaker',
  },
  audioLockedToRadio: true,
  createdAt: 1,
  updatedAt: 2,
};

let authEnabled = true;
let publicViewingAllowed = true;

vi.mock('../../config/ProfileManager.js', () => ({
  ProfileManager: {
    getInstance: () => ({
      getAllProfiles: () => [profile],
      getProfile: (id: string) => id === profile.id ? profile : null,
      createProfile: vi.fn(),
      reorderProfiles: vi.fn(),
      updateProfile: vi.fn(),
      deleteProfile: vi.fn(),
      activateProfile: vi.fn(),
    }),
  },
}));

vi.mock('../../config/config-manager.js', () => ({
  ConfigManager: {
    getInstance: () => ({
      getActiveProfileId: () => profile.id,
    }),
  },
}));

vi.mock('../../auth/AuthManager.js', () => {
  const roleLevel: Record<string, number> = {
    [UserRole.VIEWER]: 0,
    [UserRole.OPERATOR]: 1,
    [UserRole.ADMIN]: 2,
  };

  return {
    AuthManager: {
      getInstance: () => ({
        isAuthEnabled: () => authEnabled,
        isPublicViewingAllowed: () => publicViewingAllowed,
      }),
      hasMinRole: (role: UserRole, minRole: UserRole) => roleLevel[role] >= roleLevel[minRole],
    },
  };
});

describe('profileRoutes authorization and redaction', () => {
  let fastify: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    authEnabled = true;
    publicViewingAllowed = true;
    const { profileRoutes } = await import('../profiles.js');
    fastify = Fastify();
    fastify.decorateRequest('authUser', null);
    fastify.addHook('onRequest', async (request: FastifyRequest) => {
      const role = request.headers['x-role'];
      request.authUser = typeof role === 'string'
        ? {
          tokenId: 'test-token',
          role: role as UserRole,
          operatorIds: [],
          iat: 0,
          exp: 0,
        }
        : null;
    });
    await fastify.register(profileRoutes, { prefix: '/api/profiles' });
  });

  afterEach(async () => {
    await fastify.close();
  });

  it('returns full profile credentials only to admins', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/api/profiles',
      headers: { 'x-role': UserRole.ADMIN },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().profiles[0].radio.icomWlan.password).toBe('radio-secret');
    expect(response.json().profiles[0].radio.cwKeyPort).toBe('/dev/tty.cw');
  });

  it('redacts profile credentials for public viewers and non-admin users', async () => {
    const publicResponse = await fastify.inject({ method: 'GET', url: '/api/profiles' });
    const operatorResponse = await fastify.inject({
      method: 'GET',
      url: '/api/profiles',
      headers: { 'x-role': UserRole.OPERATOR },
    });

    for (const response of [publicResponse, operatorResponse]) {
      expect(response.statusCode).toBe(200);
      const publicProfile = response.json().profiles[0];
      expect(publicProfile).toMatchObject({
        id: 'profile-icom',
        name: 'IC-705 WLAN',
        radio: { type: 'icom-wlan' },
        audio: {},
      });
      expect(publicProfile.radio.icomWlan).toBeUndefined();
      expect(publicProfile.radio.cwKeyPort).toBeUndefined();
      expect(publicProfile.audio.inputDeviceName).toBeUndefined();
    }
  });

  it('rejects unauthenticated profile reads when public viewing is disabled', async () => {
    publicViewingAllowed = false;

    const response = await fastify.inject({ method: 'GET', url: '/api/profiles' });

    expect(response.statusCode).toBe(401);
  });

  it('requires admin for profile mutations before validation runs', async () => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/profiles',
      payload: {},
    });

    expect(response.statusCode).toBe(401);
  });
});
