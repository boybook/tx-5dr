import Fastify, { type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UserRole, type PluginSystemSnapshot } from '@tx5dr/contracts';

const snapshot: PluginSystemSnapshot = {
  state: 'ready',
  generation: 1,
  plugins: [
    {
      name: 'automation-demo',
      type: 'utility',
      instanceScope: 'operator',
      version: '1.0.0',
      isBuiltIn: true,
      loaded: true,
      enabled: true,
      autoDisabled: false,
      errorCount: 0,
      quickActions: [{ id: 'run', label: 'Run' }],
    },
  ],
  panelMeta: [],
  panelContributions: [],
};

const getSnapshot = vi.fn(() => snapshot);
const getLoadedPlugin = vi.fn();
const setOperatorPluginPaused = vi.fn();
const pauseActiveTransmitControlPlugins = vi.fn();
const resumeTransmitControlPlugins = vi.fn();
const logbookSyncHost = {
  getProviderInfo: vi.fn(),
  upload: vi.fn(),
  download: vi.fn(),
  getUploadPreflight: vi.fn(),
  testConnection: vi.fn(),
  getProviders: vi.fn(() => []),
  getConfiguredStatus: vi.fn(() => ({})),
};

vi.mock('../../DigitalRadioEngine.js', () => ({
  DigitalRadioEngine: {
    getInstance: () => ({
      pluginManager: {
        getSnapshot,
        getLoadedPlugin,
        setOperatorPluginPaused,
        pauseActiveTransmitControlPlugins,
        resumeTransmitControlPlugins,
        logbookSyncHost,
      },
    }),
  },
}));

vi.mock('../../config/config-manager.js', () => ({
  ConfigManager: {
    getInstance: () => ({}),
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
      getInstance: () => ({}),
      hasMinRole: (role: UserRole, minRole: UserRole) => roleLevel[role] >= roleLevel[minRole],
    },
  };
});

describe('pluginRoutes auth', () => {
  let fastify: ReturnType<typeof Fastify>;
  const tempDirs: string[] = [];

  beforeEach(async () => {
    getSnapshot.mockClear();
    getLoadedPlugin.mockReset();
    setOperatorPluginPaused.mockReset().mockResolvedValue(['automation-demo']);
    pauseActiveTransmitControlPlugins.mockReset().mockResolvedValue(['automation-demo']);
    resumeTransmitControlPlugins.mockReset().mockResolvedValue([]);
    logbookSyncHost.getProviderInfo.mockReset();
    logbookSyncHost.upload.mockReset();
    logbookSyncHost.download.mockReset();
    logbookSyncHost.getUploadPreflight.mockReset();
    logbookSyncHost.testConnection.mockReset();
    logbookSyncHost.getProviders.mockReset().mockReturnValue([]);
    logbookSyncHost.getConfiguredStatus.mockReset().mockReturnValue({});
    const { pluginRoutes } = await import('../plugins.js');
    fastify = Fastify();
    fastify.decorateRequest('authUser', null);
    fastify.addHook('onRequest', async (request: FastifyRequest) => {
      const role = request.headers['x-role'];
      request.authUser = typeof role === 'string'
        ? {
          tokenId: 'test-token',
          role: role as UserRole,
          operatorIds: ['operator-1'],
          iat: 0,
          exp: 0,
        }
        : null;
    });
    await fastify.register(pluginRoutes, { prefix: '/api/plugins' });
  });

  afterEach(async () => {
    await fastify.close();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('allows operator accounts to read the plugin snapshot for automation UI', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/api/plugins',
      headers: { 'x-role': UserRole.OPERATOR },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(snapshot);
    expect(getSnapshot).toHaveBeenCalledTimes(1);
  });

  it('keeps plugin snapshots unavailable to viewers', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/api/plugins',
      headers: { 'x-role': UserRole.VIEWER },
    });

    expect(response.statusCode).toBe(403);
    expect(getSnapshot).not.toHaveBeenCalled();
  });

  it('allows operator accounts to pause their own operator transmit-control plugins', async () => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/plugins/operators/operator-1/transmit-control/pause-all',
      headers: { 'x-role': UserRole.OPERATOR },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      success: true,
      operatorId: 'operator-1',
      pausedPlugins: ['automation-demo'],
    });
    expect(pauseActiveTransmitControlPlugins).toHaveBeenCalledWith('operator-1');
  });

  it('prevents operator accounts from pausing another operator transmit-control plugins', async () => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/plugins/operators/operator-2/transmit-control/pause-all',
      headers: { 'x-role': UserRole.OPERATOR },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      success: false,
      error: {
        code: 'FORBIDDEN',
        message: 'No operator access',
        userMessage: 'You do not have access to this operator',
      },
    });
    expect(pauseActiveTransmitControlPlugins).not.toHaveBeenCalled();
  });

  it('keeps transmit-control pause actions unavailable to viewers', async () => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/plugins/operators/operator-1/transmit-control/pause-all',
      headers: { 'x-role': UserRole.VIEWER },
    });

    expect(response.statusCode).toBe(403);
    expect(pauseActiveTransmitControlPlugins).not.toHaveBeenCalled();
  });

  it('allows operator accounts to resume their own operator transmit-control plugins', async () => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/plugins/operators/operator-1/transmit-control/resume-all',
      headers: { 'x-role': UserRole.OPERATOR },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      success: true,
      operatorId: 'operator-1',
      pausedPlugins: [],
    });
    expect(resumeTransmitControlPlugins).toHaveBeenCalledWith('operator-1');
  });

  it('uses the same operator binding gate for per-plugin pause changes', async () => {
    const allowed = await fastify.inject({
      method: 'PUT',
      url: '/api/plugins/automation-demo/operator/operator-1/pause',
      headers: { 'x-role': UserRole.OPERATOR },
      payload: { paused: true },
    });
    const denied = await fastify.inject({
      method: 'PUT',
      url: '/api/plugins/automation-demo/operator/operator-2/pause',
      headers: { 'x-role': UserRole.OPERATOR },
      payload: { paused: true },
    });

    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toEqual({
      success: true,
      operatorId: 'operator-1',
      pausedPlugins: ['automation-demo'],
    });
    expect(denied.statusCode).toBe(403);
    expect(setOperatorPluginPaused).toHaveBeenCalledTimes(1);
    expect(setOperatorPluginPaused).toHaveBeenCalledWith('operator-1', 'automation-demo', true);
  });

  it('returns structured sync failures when a provider upload throws', async () => {
    logbookSyncHost.getProviderInfo.mockReturnValue({
      id: 'wavelog',
      pluginName: 'wavelog-sync',
      displayName: 'WaveLog',
      settingsPageId: 'settings',
      accessScope: 'admin',
    });
    logbookSyncHost.upload.mockRejectedValue(new Error('remote server exploded'));

    const response = await fastify.inject({
      method: 'POST',
      url: '/api/plugins/sync-providers/wavelog/upload',
      headers: { 'x-role': UserRole.ADMIN },
      payload: { callsign: 'BG5DRB' },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      failures: [
        expect.objectContaining({
          code: 'sync_upload_failed',
          message: 'remote server exploded',
          providerId: 'wavelog',
          operation: 'upload',
        }),
      ],
    });
  });

  it('returns structured sync failures when a provider is missing', async () => {
    logbookSyncHost.getProviderInfo.mockReturnValue(null);

    const response = await fastify.inject({
      method: 'POST',
      url: '/api/plugins/sync-providers/missing/download',
      headers: { 'x-role': UserRole.ADMIN },
      payload: { callsign: 'BG5DRB' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      failures: [
        expect.objectContaining({
          code: 'sync_provider_not_found',
          message: 'provider not found',
          providerId: 'missing',
          operation: 'download',
        }),
      ],
    });
  });

  it('does not serve plugin ui assets through symlinks that escape the ui root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tx5dr-plugin-ui-route-'));
    tempDirs.push(root);
    const pluginDir = join(root, 'plugin');
    await mkdir(join(pluginDir, 'ui'), { recursive: true });
    await writeFile(join(root, 'secret.txt'), 'secret', 'utf8');
    await symlink('../../secret.txt', join(pluginDir, 'ui', 'secret-link.txt'));
    getLoadedPlugin.mockReturnValue({
      dirPath: pluginDir,
      definition: {
        name: 'ui-symlink-test',
        version: '1.0.0',
        type: 'utility',
        ui: {
          dir: 'ui',
          pages: [],
        },
      },
    });

    const response = await fastify.inject({
      method: 'GET',
      url: '/api/plugins/ui-symlink-test/ui/secret-link.txt',
      headers: { 'x-role': UserRole.ADMIN },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain('secret');
  });
});
