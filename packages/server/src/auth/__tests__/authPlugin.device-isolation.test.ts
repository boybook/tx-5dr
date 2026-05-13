import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UserRole } from '@tx5dr/contracts';

import { AuthManager } from '../AuthManager.js';
import { authPlugin, requireRole } from '../authPlugin.js';
import { DeviceServiceAuthManager } from '../DeviceServiceAuthManager.js';

describe('authPlugin device JWT isolation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects device-ui JWTs on ordinary authenticated APIs', async () => {
    const normalAuth = {
      getJwtSecret: () => 'normal-user-jwt-secret-that-is-separate-from-device-ui',
      getJwtExpiresIn: () => 3600,
      isAuthEnabled: () => true,
      isTokenStillValid: (tokenId: string) => tokenId === 'normal-token',
      getTokenCurrentPermissions: (tokenId: string) => tokenId === 'normal-token'
        ? { role: UserRole.ADMIN, operatorIds: [] }
        : null,
    };
    vi.spyOn(AuthManager, 'getInstance').mockReturnValue(normalAuth as unknown as AuthManager);

    const deviceDir = await mkdtemp(join(tmpdir(), 'tx5dr-device-auth-isolation-'));
    const deviceAuth = new DeviceServiceAuthManager({
      sessionTokenFilePath: join(deviceDir, '.device-ui-token'),
      stateFilePath: join(deviceDir, 'device-ui-auth-state.json'),
      jwtTtlSeconds: 60,
      now: () => 1_700_000_000_000,
    });
    await deviceAuth.initialize();
    const { jwt: deviceJwt } = await deviceAuth.signDeviceJwt({ deviceId: 'panel-1' });

    const app = Fastify();
    await app.register(authPlugin);
    app.get('/ordinary', { preHandler: [requireRole(UserRole.VIEWER)] }, async () => ({ ok: true }));
    await app.ready();

    const normalJwt = app.jwt.sign({ tokenId: 'normal-token', role: UserRole.ADMIN, operatorIds: [] });
    const normalResponse = await app.inject({
      method: 'GET',
      url: '/ordinary',
      headers: { authorization: `Bearer ${normalJwt}` },
    });
    const deviceResponse = await app.inject({
      method: 'GET',
      url: '/ordinary',
      headers: { authorization: `Bearer ${deviceJwt}` },
    });

    expect(normalResponse.statusCode).toBe(200);
    expect(deviceResponse.statusCode).toBe(401);
    expect(deviceResponse.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });

    await app.close();
    await deviceAuth.flush();
  });
});
