import Fastify, { type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RadioConnectionStatus, UserRole } from '@tx5dr/contracts';

const secretRadioConfig = {
  type: 'icom-wlan',
  icomWlan: {
    ip: '192.168.1.50',
    port: 50001,
    userName: 'radio-user',
    password: 'radio-secret',
  },
  pttPort: '/dev/tty.ptt',
  cwKeyPort: '/dev/tty.cw',
} as const;

vi.mock('serialport', () => ({
  default: {
    SerialPort: {
      list: vi.fn(async () => []),
    },
  },
}));

vi.mock('../../config/config-manager.js', () => ({
  ConfigManager: {
    getInstance: () => ({
      getRadioConfig: () => secretRadioConfig,
      getCustomFrequencyPresets: () => [],
      getLastSelectedFrequency: () => null,
      getLastVoiceFrequency: () => null,
      getLastCWFrequency: () => null,
    }),
  },
}));

const radioManager = {
  isConnected: vi.fn(() => false),
  getConnectionStatus: vi.fn(() => RadioConnectionStatus.DISCONNECTED),
  getRadioInfo: vi.fn(async () => null),
  getConnectionHealth: vi.fn(() => ({ connectionHealthy: false })),
  getCoreCapabilities: vi.fn(() => undefined),
  getCoreCapabilityDiagnostics: vi.fn(() => undefined),
};

vi.mock('../../DigitalRadioEngine.js', () => ({
  DigitalRadioEngine: {
    getInstance: () => ({
      getRadioManager: () => radioManager,
    }),
  },
}));

vi.mock('../../radio/PhysicalRadioManager.js', () => ({
  PhysicalRadioManager: class {
    static listSupportedRigs = vi.fn(async () => []);
    static getRigConfigSchema = vi.fn(async () => ({}));
  },
}));

describe('radioRoutes authorization', () => {
  let fastify: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    const { radioRoutes } = await import('../radio.js');
    fastify = Fastify();
    fastify.decorateRequest('authUser', null);
    fastify.decorateRequest('ability', null);
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
    await fastify.register(radioRoutes, { prefix: '/api/radio' });
  });

  afterEach(async () => {
    await fastify.close();
  });

  it('requires admin for local device enumeration', async () => {
    const anonymous = await fastify.inject({ method: 'GET', url: '/api/radio/serial-ports' });
    const viewer = await fastify.inject({
      method: 'GET',
      url: '/api/radio/serial-ports',
      headers: { 'x-role': UserRole.VIEWER },
    });

    expect(anonymous.statusCode).toBe(401);
    expect(viewer.statusCode).toBe(403);
  });

  it('rejects non-admin connection tests before schema validation', async () => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/radio/test',
      headers: { 'x-role': UserRole.VIEWER },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
  });

  it('redacts radio topology from non-admin status reads', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/api/radio/status',
      headers: { 'x-role': UserRole.OPERATOR },
    });

    expect(response.statusCode).toBe(200);
    const radioConfig = response.json().status.radioConfig;
    expect(radioConfig).toEqual({ type: 'icom-wlan' });
    expect(radioConfig.icomWlan).toBeUndefined();
    expect(radioConfig.cwKeyPort).toBeUndefined();
  });
});
