import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

vi.mock('../../DigitalRadioEngine.js', () => ({
  DigitalRadioEngine: {
    getInstance: () => ({
      pluginManager: {
        getSnapshot,
        logbookSyncHost: {},
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

  beforeEach(async () => {
    getSnapshot.mockClear();
    const { pluginRoutes } = await import('../plugins.js');
    fastify = Fastify();
    fastify.decorateRequest('authUser', null);
    fastify.addHook('onRequest', async (request) => {
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
});
