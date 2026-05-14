import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { deviceUiRoutes } from '../routes.js';

function createProjection() {
  return {
    getSnapshot: vi.fn(() => ({
      server: { status: 'ok', version: 'test', webPort: 8076 },
      station: { callsign: 'BG5DRB' },
      engine: { running: false, mode: null, currentMode: null, state: null },
      radio: { connected: false, frequency: null, radioMode: null, ptt: false, tx: false },
      ft8: {
        slot: null,
        utc: null,
        cycle: null,
        periodMs: null,
        recentDecodeRawMessages: [],
        lastDecodeRawMessage: null,
        recentFramesSlotId: null,
        recentFramesSlotStartMs: null,
        recentFrames: [],
        currentTx: { active: false, operatorIds: [], messages: [], lastMessage: null, slotStartMs: null },
      },
      voice: {
        active: false,
        radioMode: null,
        pttLocked: false,
        pttLockedByLabel: null,
        keyerActive: false,
        keyerMode: null,
        keyerSlotId: null,
      },
      cw: {
        decoder: {
          enabled: false,
          active: false,
          state: 'disabled',
          muted: false,
          pendingText: '',
          committedText: '',
          lastDecodeAt: null,
          updatedAt: 1,
        },
        keyer: {
          active: false,
          mode: null,
          messageId: null,
          currentText: null,
          lastText: null,
        },
        currentTx: {
          active: false,
          messages: [],
          lastMessage: null,
        },
      },
      access: { localUrl: 'http://192.168.1.10:8076', localUrls: ['http://192.168.1.10:8076'] },
      updatedAt: 1,
    })),
  };
}

function createAuth() {
  return {
    createSession: vi.fn(async (request: { deviceId: string; sessionToken: string }) => (
      request.sessionToken === 'device-secret'
        ? { jwt: 'device-jwt', deviceId: request.deviceId, sessionId: 'session-1', expiresAt: 2 }
        : null
    )),
    verifyDeviceSession: vi.fn(async (token: string) => (
      token === 'device-jwt'
        ? { payload: { typ: 'device-ui', aud: 'tx5dr-device-ui', deviceId: 'panel-1', sessionId: 'session-1', iat: 1, exp: 2 }, session: {} }
        : null
    )),
  };
}

async function buildApp() {
  const app = Fastify();
  const auth = createAuth();
  const projection = createProjection();
  await app.register(deviceUiRoutes, {
    prefix: '/api/device-ui',
    authManager: auth as any,
    projectionService: projection as any,
  });
  return { app, auth, projection };
}

describe('deviceUiRoutes', () => {
  it('returns a public health payload without sensitive fields', async () => {
    const { app } = await buildApp();

    const response = await app.inject({ method: 'GET', url: '/api/device-ui/health' });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({ status: 'ok', service: 'tx5dr-device-ui' });
    expect(Object.keys(body).sort()).toEqual(['service', 'status', 'time']);
    await app.close();
  });

  it('exchanges only the device session token for a device JWT', async () => {
    const { app } = await buildApp();

    const ok = await app.inject({
      method: 'POST',
      url: '/api/device-ui/session',
      payload: { deviceId: 'panel-1', sessionToken: 'device-secret' },
    });
    const rejected = await app.inject({
      method: 'POST',
      url: '/api/device-ui/session',
      payload: { deviceId: 'panel-1', sessionToken: 'wrong' },
    });

    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ jwt: 'device-jwt', deviceId: 'panel-1', sessionId: 'session-1' });
    expect(rejected.statusCode).toBe(401);
    await app.close();
  });

  it('requires a device JWT for bootstrap and rejects normal bearer tokens', async () => {
    const { app, projection } = await buildApp();

    const missing = await app.inject({ method: 'GET', url: '/api/device-ui/bootstrap' });
    const normalJwt = await app.inject({
      method: 'GET',
      url: '/api/device-ui/bootstrap',
      headers: { authorization: 'Bearer normal-user-jwt' },
    });
    const deviceJwt = await app.inject({
      method: 'GET',
      url: '/api/device-ui/bootstrap',
      headers: { authorization: 'Bearer device-jwt' },
    });

    expect(missing.statusCode).toBe(401);
    expect(normalJwt.statusCode).toBe(401);
    expect(deviceJwt.statusCode).toBe(200);
    expect(deviceJwt.json()).toMatchObject({ server: { status: 'ok' }, access: { localUrl: 'http://192.168.1.10:8076', localUrls: ['http://192.168.1.10:8076'] } });
    expect(projection.getSnapshot).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('does not expose pairing endpoints', async () => {
    const { app } = await buildApp();

    const response = await app.inject({ method: 'POST', url: '/api/device-ui/pairing-code' });

    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
