import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  settings: { enabled: true, noticeVersion: 0 },
  statePath: '',
  activeConnections: 0,
}));

vi.mock('../../config/config-manager.js', () => ({
  ConfigManager: {
    getInstance: () => ({ getConfig: () => ({ observability: mocks.settings }) }),
  },
}));
vi.mock('../../generated/buildInfo.js', () => ({
  SERVER_BUILD_INFO: {
    version: '1.0.0-nightly.202608311200+gabcdef1',
    channel: 'nightly',
    commit: 'abcdef0123456789',
    commitShort: 'abcdef0',
  },
}));
vi.mock('../../websocket/WSServer.js', () => ({
  WSServer: {
    getInstance: () => ({ getCapacityStats: () => ({ active: mocks.activeConnections }) }),
  },
}));
vi.mock('../../utils/app-paths.js', () => ({
  getDataFilePath: async () => mocks.statePath,
  tx5drPaths: { getDataDir: async () => '/private/test-data' },
}));
vi.mock('../../utils/runtime-distribution.js', () => ({
  resolveRuntimeDistribution: () => 'electron',
}));

import { TelemetryService } from '../TelemetryService.js';

const services: TelemetryService[] = [];

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function registrationResponse(): Response {
  return jsonResponse({
    installation_token: 'test-token',
    token_expires_at: '2035-01-01T00:00:00.000Z',
  }, 201);
}

beforeEach(async () => {
  mocks.settings = { enabled: true, noticeVersion: 0 };
  mocks.activeConnections = 0;
  mocks.statePath = join(await mkdtemp(join(tmpdir(), 'tx5dr-observability-')), 'state.json');
  process.env.TX5DR_OBSERVABILITY_ENDPOINT = 'https://telemetry.example.invalid';
  delete process.env.TX5DR_TELEMETRY_CONSENT;
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(async () => {
  mocks.settings = { enabled: false, noticeVersion: 1 };
  await Promise.all(services.splice(0).map((service) => service.applySettings()));
  vi.unstubAllGlobals();
  delete process.env.TX5DR_OBSERVABILITY_ENDPOINT;
  delete process.env.TX5DR_TELEMETRY_CONSENT;
});

describe('TelemetryService', () => {
  it('uses the production gateway when no endpoint override is set', async () => {
    delete process.env.TX5DR_OBSERVABILITY_ENDPOINT;
    const service = new TelemetryService();
    services.push(service);
    await service.initialize();

    expect(fetch).not.toHaveBeenCalled();
    expect(service.getStatus()).toMatchObject({ endpointConfigured: true });
  });

  it('does not make a request before the privacy notice is acknowledged', async () => {
    const service = new TelemetryService();
    services.push(service);
    await service.initialize();

    expect(fetch).not.toHaveBeenCalled();
    expect(service.getStatus()).toMatchObject({
      effectiveEnabled: false,
      noticeRequired: true,
      endpointConfigured: true,
    });
  });

  it('provides a diagnostic identity without registering or sending telemetry', async () => {
    const service = new TelemetryService();
    services.push(service);

    const context = await service.getDiagnosticGatewayContext();

    expect(context.endpoint).toBe('https://telemetry.example.invalid');
    expect(context.installationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(context.app).toMatchObject({
      version: '1.0.0-nightly.202608311200+gabcdef1',
      distribution: 'electron',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports build metadata and completed WebSocket connections after consent', async () => {
    mocks.settings = { enabled: true, noticeVersion: 1 };
    mocks.activeConnections = 4;
    vi.mocked(fetch)
      .mockResolvedValueOnce(registrationResponse())
      .mockResolvedValueOnce(jsonResponse({}, 202));

    const service = new TelemetryService();
    services.push(service);
    await service.initialize();

    expect(fetch).toHaveBeenCalledTimes(2);
    const registration = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
    const events = JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]?.body));
    expect(registration.app).toEqual({
      version: '1.0.0-nightly.202608311200+gabcdef1',
      build_channel: 'nightly',
      build_commit: 'abcdef0',
      distribution: 'electron',
      os_family: process.platform,
      arch: process.arch,
    });
    expect(events.events[0]).toMatchObject({
      event_name: 'session_started',
      active_connections: 4,
      runtime_state: 'online',
    });
  });

  it('drops stale presence snapshots instead of replaying false online state', async () => {
    mocks.settings = { enabled: true, noticeVersion: 1 };
    const now = Date.now();
    await writeFile(mocks.statePath, JSON.stringify({
      installationId: 'ad3be608-5c6f-4fda-a524-48c8fa8cff4b',
      registrationEventId: 'd1533337-e79f-4fc1-b550-4b8c1cf9ec79',
      token: 'existing-token',
      tokenExpiresAt: Date.parse('2035-01-01T00:00:00.000Z'),
      queue: [
        {
          event_id: '6cd4c636-ab0c-4240-af07-e5ae8efe39f8',
          event_name: 'presence_snapshot',
          occurred_at_ms: now - (11 * 60 * 1000),
          session_id: '09e73550-8a15-4aed-b7f0-51830752893f',
          runtime_state: 'online',
          active_connections: 8,
          uptime_seconds: 600,
          reason: 'heartbeat',
        },
      ],
      lastSentAt: null,
      lastError: null,
    }));
    vi.mocked(fetch).mockResolvedValue(jsonResponse({}, 202));

    const service = new TelemetryService();
    services.push(service);
    await service.initialize();

    const sent = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
    expect(sent.events).toHaveLength(1);
    expect(sent.events[0].event_name).toBe('session_started');
    expect(JSON.stringify(sent)).not.toContain('6cd4c636-ab0c-4240-af07-e5ae8efe39f8');
  });

  it('re-registers and retries after an expired installation token', async () => {
    mocks.settings = { enabled: true, noticeVersion: 1 };
    const now = Date.now();
    await writeFile(mocks.statePath, JSON.stringify({
      installationId: 'ad3be608-5c6f-4fda-a524-48c8fa8cff4b',
      registrationEventId: 'd1533337-e79f-4fc1-b550-4b8c1cf9ec79',
      token: 'expired-at-gateway',
      tokenExpiresAt: Date.parse('2035-01-01T00:00:00.000Z'),
      queue: [],
      lastSentAt: now,
      lastError: null,
    }));
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(registrationResponse())
      .mockResolvedValueOnce(jsonResponse({}, 202));

    const service = new TelemetryService();
    services.push(service);
    await service.initialize();
    await (service as unknown as { flush: () => Promise<void> }).flush();

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(vi.mocked(fetch).mock.calls[1][0]).toBe('https://telemetry.example.invalid/v1/installations/register');
    expect(vi.mocked(fetch).mock.calls[2][0]).toBe('https://telemetry.example.invalid/v1/telemetry/events');
  });
});
