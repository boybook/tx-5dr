import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

let existingCWKeyerManager: {
  getStatus: () => { active: boolean };
  getSerialKeyerTestState: (target: unknown) => unknown;
  testKeyer: (target: unknown, durationMs: number) => Promise<void>;
} | null = null;

vi.mock('../../DigitalRadioEngine.js', () => ({
  DigitalRadioEngine: {
    getInstance: () => ({
      getRadioManager: () => radioManager,
      getExistingCWKeyerManager: () => existingCWKeyerManager,
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
  let previousAndroidSerialFile: string | undefined;

  beforeEach(async () => {
    existingCWKeyerManager = null;
    previousAndroidSerialFile = process.env.TX5DR_ANDROID_SERIAL_DEVICES_FILE;
    const { radioRoutes } = await import('../radio.js');
    fastify = Fastify();
    fastify.decorateRequest('authUser', null);
    fastify.decorateRequest('ability', null);
    fastify.setErrorHandler((error: Error & { code?: string; userMessageKey?: string }, _request: FastifyRequest, reply: FastifyReply) => {
      if (error.name === 'RadioError') {
        reply.status(error.code === 'INVALID_STATE' ? 409 : 500).send({
          success: false,
          error: {
            code: error.code,
            userMessageKey: error.userMessageKey,
          },
        });
        return;
      }
      reply.send(error);
    });
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
    if (previousAndroidSerialFile === undefined) delete process.env.TX5DR_ANDROID_SERIAL_DEVICES_FILE;
    else process.env.TX5DR_ANDROID_SERIAL_DEVICES_FILE = previousAndroidSerialFile;
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


  it('uses Android bridge serial devices file when configured', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tx5dr-android-serial-'));
    const file = path.join(dir, 'android-serial-devices.json');
    writeFileSync(file, JSON.stringify({
      ports: [{
        path: '/opt/tx5dr-data/android-dev/ttyUSB0',
        manufacturer: 'Android USB Host',
        vendorId: '0c26',
        productId: '0000',
      }],
    }), 'utf8');
    process.env.TX5DR_ANDROID_SERIAL_DEVICES_FILE = file;

    const response = await fastify.inject({
      method: 'GET',
      url: '/api/radio/serial-ports',
      headers: { 'x-role': UserRole.ADMIN },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().ports).toEqual([{
      path: '/opt/tx5dr-data/android-dev/ttyUSB0',
      manufacturer: 'Android USB Host',
      vendorId: '0c26',
      productId: '0000',
    }]);
  });

  it('adds macOS /dev/cu callout serial ports for device control', async () => {
    const { includeDarwinCalloutSerialPorts } = await import('../radio.js');

    const ports = includeDarwinCalloutSerialPorts(
      [
        {
          path: '/dev/tty.usbserial-016F24B71',
          manufacturer: 'FTDI',
          serialNumber: '016F24B71',
        },
        { path: '/dev/cu.already-listed' },
      ] as any,
      ['tty.usbserial-016F24B71', 'cu.usbserial-016F24B71', 'cu.extra-only', 'cu.already-listed'],
    );

    expect(ports).toEqual([
      {
        path: '/dev/tty.usbserial-016F24B71',
        manufacturer: 'FTDI',
        serialNumber: '016F24B71',
      },
      {
        path: '/dev/cu.usbserial-016F24B71',
        manufacturer: 'FTDI',
        serialNumber: '016F24B71',
      },
      { path: '/dev/cu.already-listed' },
      { path: '/dev/cu.extra-only' },
    ]);
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

  it('reuses an already-open CW keyer backend for CW hardware tests', async () => {
    existingCWKeyerManager = {
      getStatus: vi.fn(() => ({ active: false })),
      getSerialKeyerTestState: vi.fn(() => ({ kind: 'reuse' })),
      testKeyer: vi.fn().mockResolvedValue(undefined),
    };

    const response = await fastify.inject({
      method: 'POST',
      url: '/api/radio/test-cw-keyer',
      headers: { 'x-role': UserRole.ADMIN },
      payload: {
        ...secretRadioConfig,
        cwKeyMethod: 'rts',
        cwKeyActiveLevel: 'high',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(existingCWKeyerManager?.getSerialKeyerTestState).toHaveBeenCalledWith({
      keyPort: '/dev/tty.cw',
      keyMethod: 'rts',
      keyActiveLevel: 'high',
    });
    expect(existingCWKeyerManager?.testKeyer).toHaveBeenCalledWith({
      keyPort: '/dev/tty.cw',
      keyMethod: 'rts',
      keyActiveLevel: 'high',
    }, 500);
    expect(response.json()).toMatchObject({ success: true });
  });

  it('rejects CW hardware tests while the existing keyer is active', async () => {
    existingCWKeyerManager = {
      getStatus: vi.fn(() => ({ active: true })),
      getSerialKeyerTestState: vi.fn(),
      testKeyer: vi.fn(),
    };

    const response = await fastify.inject({
      method: 'POST',
      url: '/api/radio/test-cw-keyer',
      headers: { 'x-role': UserRole.ADMIN },
      payload: secretRadioConfig,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({
      code: 'INVALID_STATE',
      userMessageKey: 'settings:radio.cwKeyerCurrentlyActive',
    });
    expect(existingCWKeyerManager?.testKeyer).not.toHaveBeenCalled();
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
