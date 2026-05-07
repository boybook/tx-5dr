import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DeviceServiceAuth } from '../DeviceServiceAuth.js';
import type { DeviceUiModel } from '@tx5dr/contracts';
import { deviceUiRoutes } from '../routes.js';

const tempDirs: string[] = [];

const model: DeviceUiModel = {
  schemaVersion: 1,
  page: 'access',
  updatedAt: 1,
  device: { id: 'd', profile: 'p', renderer: 'r' },
  network: { kind: 'offline', connected: false, interfaceName: null, ipAddress: null, helperAvailable: false },
  access: { url: null, qrText: null, pairingCode: null, pairingExpiresAt: null, browserClientCount: 0 },
  radio: { serverConnected: true, engineState: 'idle', radioConnected: false, frequencyHz: null, mode: null, band: null, pttActive: false, txOperatorIds: [], txText: null, slotSecondsRemaining: null },
  spectrum: { timestamp: 1, bins: [], peakBin: null },
  recentMessages: [],
  alert: null,
};

async function buildApp() {
  const app = Fastify();
  await app.register(fastifyJwt, { secret: 'device-ui-test-secret' });
  await app.register(deviceUiRoutes, {
    prefix: '/api/device-ui',
    projection: {
      getModel: () => model,
      updateAccess: () => model.access,
      onPatch: () => () => undefined,
    } as never,
  });
  return app;
}

describe('deviceUiRoutes', () => {
  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tx5dr-device-ui-routes-'));
    tempDirs.push(dir);
    process.env.TX5DR_CONFIG_DIR = dir;
    (DeviceServiceAuth as unknown as { instance: DeviceServiceAuth | null }).instance = null;
  });

  afterEach(async () => {
    delete process.env.TX5DR_CONFIG_DIR;
    (DeviceServiceAuth as unknown as { instance: DeviceServiceAuth | null }).instance = null;
    await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
  });

  it('keeps health public and bootstrap protected by dedicated device JWT', async () => {
    const app = await buildApp();
    const health = await app.inject('/api/device-ui/health');
    expect(health.statusCode).toBe(200);
    expect(Object.keys(health.json()).sort()).toEqual(['service', 'status', 'time']);

    const unauthenticated = await app.inject('/api/device-ui/bootstrap');
    expect(unauthenticated.statusCode).toBe(401);

    const ordinaryJwt = app.jwt.sign({ tokenId: 'token-1', role: 'admin', operatorIds: [] });
    const ordinary = await app.inject({ url: '/api/device-ui/bootstrap', headers: { authorization: `Bearer ${ordinaryJwt}` } });
    expect(ordinary.statusCode).toBe(403);

    const deviceJwt = app.jwt.sign({ sub: 'device-1', deviceId: 'device-1', aud: 'tx5dr-device-ui', scope: 'device-ui' }, { expiresIn: 3600 });
    const device = await app.inject({ url: '/api/device-ui/bootstrap', headers: { authorization: `Bearer ${deviceJwt}` } });
    expect(device.statusCode).toBe(200);
    expect(device.json().model.access.browserClientCount).toBe(0);

    await app.close();
  });

  it('creates sessions only from the local device token file', async () => {
    const auth = DeviceServiceAuth.getInstance();
    const record = await auth.ensureToken();
    const app = await buildApp();

    const rejected = await app.inject({
      method: 'POST',
      url: '/api/device-ui/session',
      payload: { deviceToken: 'wrong-token-wrong-token', deviceId: 'device-1' },
    });
    expect(rejected.statusCode).toBe(401);

    const accepted = await app.inject({
      method: 'POST',
      url: '/api/device-ui/session',
      payload: { deviceToken: record.token, deviceId: 'device-1' },
    });
    expect(accepted.statusCode).toBe(200);
    const decoded = app.jwt.verify(accepted.json().jwt) as { aud: string; scope: string; deviceId: string; role?: string };
    expect(decoded).toMatchObject({ aud: 'tx5dr-device-ui', scope: 'device-ui', deviceId: 'device-1' });
    expect(decoded.role).toBeUndefined();

    await app.close();
  });
});
