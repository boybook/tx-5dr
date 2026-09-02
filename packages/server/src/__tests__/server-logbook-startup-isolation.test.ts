import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { UserRole } from '@tx5dr/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LogManager } from '../log/LogManager.js';

const mocks = vi.hoisted(() => {
  const processMonitor = {
    setExtraSnapshotProvider: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  };
  const engine = {
    initialize: vi.fn(),
    pluginManager: { shutdown: vi.fn(async () => undefined) },
    operatorManager: {
      getLogManager: vi.fn(),
      getAllOperators: vi.fn(() => []),
    },
    getDecodeWorkerTelemetrySnapshot: vi.fn(() => ({})),
    getWorkerPoolTelemetrySnapshots: vi.fn(() => ({})),
    getAudioStreamManager: vi.fn(() => ({})),
    initializeAndroidOperatorAudioService: vi.fn(),
    getStatus: vi.fn(() => ({ isRunning: false })),
    stop: vi.fn(async () => undefined),
  };
  return { engine, processMonitor };
});

vi.mock('../config/config-manager.js', () => ({
  ConfigManager: {
    getInstance: () => ({
      initialize: vi.fn(async () => undefined),
      getOperatorsConfig: vi.fn(() => []),
    }),
  },
}));

vi.mock('../audio/audio-device-manager.js', () => ({
  AudioDeviceManager: {
    getInstance: () => ({ initializeDeviceRegistry: vi.fn(async () => undefined) }),
  },
}));

vi.mock('../auth/AuthManager.js', () => ({
  AuthManager: {
    getInstance: () => ({
      initialize: vi.fn(async () => undefined),
      isAuthEnabled: vi.fn(() => false),
      isTokenStillValid: vi.fn(() => true),
      getTokenCurrentPermissions: vi.fn(),
    }),
    hasMinRole: vi.fn(() => true),
  },
}));

vi.mock('../auth/DeviceServiceAuthManager.js', () => ({
  DeviceServiceAuthManager: {
    getInstance: () => ({ initialize: vi.fn(async () => undefined) }),
  },
}));

vi.mock('../auth/authPlugin.js', () => {
  const authPlugin = async (fastify: FastifyInstance) => {
    fastify.decorateRequest('authUser', null);
    fastify.addHook('onRequest', async (request: FastifyRequest) => {
      request.authUser = {
        tokenId: '__startup_test__',
        role: UserRole.ADMIN,
        operatorIds: [],
        iat: 0,
        exp: Number.MAX_SAFE_INTEGER,
      };
    });
  };
  Object.defineProperty(authPlugin, Symbol.for('skip-override'), { value: true });
  return {
    authPlugin,
    requireRole: () => async () => undefined,
    requireAbility: () => async () => undefined,
    requireExistingLogbookAccess: (logManager: LogManager) => async (request: FastifyRequest) => {
      const id = (request.params as { id?: string }).id;
      const resolvedId = id ? logManager.resolveLogBookId(id) : null;
      request.logBookInstance = resolvedId
        ? (logManager.getLogBook(resolvedId) ?? undefined)
        : undefined;
    },
  };
});

vi.mock('../DigitalRadioEngine.js', () => ({
  DigitalRadioEngine: { getInstance: () => mocks.engine },
}));

vi.mock('../services/ProcessMonitor.js', () => ({
  ProcessMonitor: { getInstance: () => mocks.processMonitor },
}));

vi.mock('../realtime/RealtimeRxAudioRouter.js', () => ({
  RealtimeRxAudioRouter: class {
    dispose() {}
  },
}));

vi.mock('../realtime/RealtimeTransportManager.js', () => ({
  RealtimeTransportManager: {
    initialize: () => ({
      acceptCompatConnection: vi.fn(),
      acceptRtcDataAudioConnection: vi.fn(),
    }),
  },
}));

vi.mock('../websocket/WSServer.js', () => ({
  WSServer: class {
    addConnection() {}
    cleanup() {}
  },
}));

vi.mock('../websocket/LogbookWSServer.js', () => ({
  LogbookWSServer: class {
    addConnection() {}
    cleanup() {}
  },
  resolveLogbookConnectionParams: (_manager: unknown, params: Record<string, unknown>) => params,
}));

vi.mock('../device-ui/DeviceUiWSServer.js', () => ({
  DeviceUiWSServer: class {
    getProjectionService() { return {}; }
    acceptConnection() {}
    cleanup() {}
  },
}));

function emptyRouteModule(exportName: string) {
  return { [exportName]: async () => undefined };
}

vi.mock('../routes/profiles.js', () => emptyRouteModule('profileRoutes'));
vi.mock('../routes/audio.js', () => emptyRouteModule('audioRoutes'));
vi.mock('../routes/settings.js', () => emptyRouteModule('settingsRoutes'));
vi.mock('../routes/diagnostics.js', () => emptyRouteModule('diagnosticRoutes'));
vi.mock('../routes/storage.js', () => emptyRouteModule('storageRoutes'));
vi.mock('../routes/pskreporter.js', () => emptyRouteModule('pskreporterRoutes'));
vi.mock('../routes/system.js', () => emptyRouteModule('systemRoutes'));
vi.mock('../routes/openwebrx.js', () => emptyRouteModule('openwebrxRoutes'));
vi.mock('../routes/operators.js', () => emptyRouteModule('operatorRoutes'));
vi.mock('../routes/radio.js', () => ({
  radioRoutes: async (fastify: FastifyInstance) => {
    fastify.get('/status', async () => ({ status: 'radio-ok' }));
  },
}));
vi.mock('../routes/power.js', () => emptyRouteModule('powerRoutes'));
vi.mock('../routes/rigctld.js', () => emptyRouteModule('rigctldRoutes'));
vi.mock('../routes/mode.js', () => emptyRouteModule('modeRoutes'));
vi.mock('../routes/slotpack.js', () => emptyRouteModule('slotpackRoutes'));
vi.mock('../routes/voice.js', () => emptyRouteModule('voiceRoutes'));
vi.mock('../routes/cw.js', () => emptyRouteModule('cwRoutes'));
vi.mock('../routes/callsigns.js', () => emptyRouteModule('callsignRoutes'));
vi.mock('../routes/plugins.js', () => emptyRouteModule('pluginRoutes'));
vi.mock('../routes/auth.js', () => emptyRouteModule('authRoutes'));
vi.mock('../device-ui/routes.js', () => emptyRouteModule('deviceUiRoutes'));
vi.mock('../routes/realtime.js', () => emptyRouteModule('realtimeRoutes'));
vi.mock('../routes/station.js', () => emptyRouteModule('stationRoutes'));

describe('createServer logbook startup isolation', () => {
  let tempDir: string;
  let app: Awaited<ReturnType<typeof import('../server.js')['createServer']>> | undefined;
  const manager = LogManager.getInstance();

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(tmpdir(), 'tx5dr-server-logbook-startup-'));
    await manager.close();
    mocks.engine.operatorManager.getLogManager.mockReset().mockReturnValue(manager);
    mocks.engine.initialize.mockReset().mockImplementation(async () => {
      const invalidPath = path.join(tempDir, 'NOT-A-FILE.adi');
      const healthyPath = path.join(tempDir, 'HEALTHY.adi');
      await fs.mkdir(invalidPath);
      await fs.writeFile(healthyPath, '<ADIF_VER:5>3.1.4<EOH>\n', 'utf8');
      await manager.createLogBook({
        id: 'unavailable-book',
        name: 'Unavailable book',
        filePath: invalidPath,
        autoCreateFile: false,
      });
      await manager.createLogBook({
        id: 'healthy-book',
        name: 'Healthy book',
        filePath: healthyPath,
        autoCreateFile: false,
      });
    });
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await manager.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('reaches ready and serves API/radio while one physical logbook is unavailable', async () => {
    const { createServer } = await import('../server.js');
    app = await createServer();
    await app.ready();

    const [hello, radio] = await Promise.all([
      app.inject({ method: 'GET', url: '/api/hello' }),
      app.inject({ method: 'GET', url: '/api/radio/status' }),
    ]);
    expect(hello.statusCode).toBe(200);
    expect(radio.statusCode).toBe(200);

    await vi.waitFor(() => {
      expect(manager.getLogBook('unavailable-book')?.provider.getHealth().state).toBe('unavailable');
      expect(manager.getLogBook('healthy-book')?.provider.getHealth().state).toBe('healthy');
    });

    const healthyBook = manager.getLogBook('healthy-book')!;
    const committed = await healthyBook.provider.addQSO({
      id: 'startup-isolation-qso',
      callsign: 'N0CALL',
      frequency: 14_074_000,
      mode: 'FT8',
      startTime: Date.parse('2026-08-10T00:00:00Z'),
      messageHistory: [],
    }, 'startup-test-operator');
    expect(committed.id).toBe('startup-isolation-qso');
    const physicalLog = await fs.readFile(healthyBook.filePath, 'utf8');
    expect(physicalLog).toContain('<CALL:6>N0CALL');
    expect(physicalLog.endsWith('<EOR>\n')).toBe(true);

    const list = await app.inject({ method: 'GET', url: '/api/logbooks' });
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'unavailable-book',
        health: expect.objectContaining({ state: 'unavailable', readable: false, writable: false }),
      }),
      expect.objectContaining({
        id: 'healthy-book',
        health: expect.objectContaining({ state: 'healthy', readable: true, writable: true }),
      }),
    ]));
  }, 15_000);
});
