import Fastify, { type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserRole, type HamlibConfig } from '@tx5dr/contracts';
import { buildAbility } from '../../auth/ability.js';

const mocks = vi.hoisted(() => ({
  activeConfig: { type: 'none' } as HamlibConfig,
  testPhysicalPTT: vi.fn(async () => undefined),
  createTemporaryManager: vi.fn(),
  applyConfig: vi.fn(async (_config: HamlibConfig) => undefined),
  setPTT: vi.fn(async (_enabled: boolean) => undefined),
  disconnect: vi.fn(async () => undefined),
}));

vi.mock('../../config/config-manager.js', () => ({ ConfigManager: { getInstance: () => ({}) } }));
vi.mock('../../config/ProfileManager.js', () => ({ ProfileManager: { getInstance: () => ({}) } }));
vi.mock('../../DigitalRadioEngine.js', () => ({
  DigitalRadioEngine: {
    getInstance: () => ({
      getRadioManager: () => ({ isConnected: () => true, getConfig: () => mocks.activeConfig }),
      testPhysicalPTT: mocks.testPhysicalPTT,
    }),
  },
}));
vi.mock('../../radio/PhysicalRadioManager.js', () => ({
  PhysicalRadioManager: class {
    constructor() { mocks.createTemporaryManager(); }
    applyConfig = mocks.applyConfig;
    isConnected = () => true;
    setPTT = mocks.setPTT;
    disconnect = mocks.disconnect;
  },
}));

import { radioRoutes } from '../radio.js';

describe('standalone PTT test target selection', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.activeConfig = { type: 'none', pttMethod: 'dtr', pttPort: '/mock/active' };
    app = Fastify();
    app.decorateRequest('authUser', null);
    app.decorateRequest('ability', null);
    app.addHook('onRequest', async (req: FastifyRequest) => {
      req.ability = buildAbility({ role: UserRole.ADMIN });
      req.authUser = { tokenId: 'test-admin', role: UserRole.ADMIN, operatorIds: [], iat: 0, exp: 0 };
    });
    await app.register(radioRoutes);
  });

  afterEach(async () => { await app.close(); });

  const testPtt = (config: HamlibConfig) => app.inject({ method: 'POST', url: '/test-ptt', payload: config });

  it.each(['dtr', 'rts'] as const)('reuses the active connection only for the same port and %s pin', async (method) => {
    mocks.activeConfig.pttMethod = method;
    const response = await testPtt(mocks.activeConfig);

    expect(response.json().success).toBe(true);
    expect(mocks.testPhysicalPTT).toHaveBeenCalledOnce();
    expect(mocks.testPhysicalPTT).toHaveBeenCalledWith(500);
    expect(mocks.createTemporaryManager).not.toHaveBeenCalled();
  });

  it.each(['dtr', 'rts'] as const)('tests the requested %s port without keying a different active radio', async (method) => {
    const requested: HamlibConfig = { type: 'none', pttMethod: method, pttPort: '/mock/requested' };
    const response = await testPtt(requested);

    expect(response.statusCode).toBe(200);
    expect(response.json().success).toBe(true);
    expect(mocks.testPhysicalPTT).not.toHaveBeenCalled();
    expect(mocks.applyConfig).toHaveBeenCalledWith(expect.objectContaining(requested));
    expect(mocks.setPTT.mock.calls).toEqual([[true], [false]]);
    expect(mocks.disconnect).toHaveBeenCalledOnce();
  });

  it.each(['dtr', 'rts'] as const)('rejects changing from %s to the other pin on an occupied port', async (activeMethod) => {
    mocks.activeConfig.pttMethod = activeMethod;
    const response = await testPtt({ ...mocks.activeConfig, pttMethod: activeMethod === 'dtr' ? 'rts' : 'dtr' });

    expect(response.json().success).toBe(false);
    expect(mocks.testPhysicalPTT).not.toHaveBeenCalled();
    expect(mocks.createTemporaryManager).not.toHaveBeenCalled();
  });

  it('does not reuse a no-hardware session for a standalone PTT test', async () => {
    mocks.activeConfig = { type: 'none' };
    const requested: HamlibConfig = { type: 'none', pttMethod: 'dtr', pttPort: '/mock/requested' };
    const response = await testPtt(requested);

    expect(response.json().success).toBe(true);
    expect(mocks.testPhysicalPTT).not.toHaveBeenCalled();
    expect(mocks.applyConfig).toHaveBeenCalledWith(expect.objectContaining(requested));
    expect(mocks.setPTT.mock.calls).toEqual([[true], [false]]);
  });

  it('preserves reuse of an existing CAT connection', async () => {
    mocks.activeConfig = { type: 'network', network: { host: 'localhost', port: 4532 } };
    const response = await testPtt(mocks.activeConfig);

    expect(response.json().success).toBe(true);
    expect(mocks.testPhysicalPTT).toHaveBeenCalledOnce();
    expect(mocks.testPhysicalPTT).toHaveBeenCalledWith(500);
    expect(mocks.createTemporaryManager).not.toHaveBeenCalled();
  });
});
