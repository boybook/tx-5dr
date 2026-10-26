import Fastify, { type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserRole } from '@tx5dr/contracts';
import { buildAbility } from '../../auth/ability.js';

const mocks = vi.hoisted(() => ({ apply: vi.fn(), persist: vi.fn() }));
vi.mock('../../config/config-manager.js', () => ({ ConfigManager: { getInstance: () => ({
  getRadioConfig: () => ({ type: 'serial' }),
  getLastVoiceFrequency: () => ({ frequency: 14270000, radioMode: 'USB', band: '20m' }),
  updateLastVoiceFrequency: mocks.persist,
}) } }));
vi.mock('../../config/ProfileManager.js', () => ({ ProfileManager: { getInstance: () => ({}) } }));
vi.mock('../../DigitalRadioEngine.js', () => ({ DigitalRadioEngine: { getInstance: () => ({
  getEngineMode: () => 'voice',
  getRadioManager: () => ({ isConnected: () => true, applyOperatingState: mocks.apply }),
}) } }));
import { radioRoutes } from '../radio.js';

describe('mode retry response', () => {
  let app: ReturnType<typeof Fastify>;
  beforeEach(async () => {
    vi.clearAllMocks();
    app = Fastify();
    app.decorateRequest('authUser', null);
    app.decorateRequest('ability', null);
    app.addHook('onRequest', async (req: FastifyRequest) => {
      req.ability = buildAbility({ role: UserRole.ADMIN });
      req.authUser = { tokenId: 'test', role: UserRole.ADMIN, operatorIds: [], iat: 0, exp: 0 };
    });
    await app.register(radioRoutes);
  });
  afterEach(async () => { await app.close(); });

  it.each([true, false])('reports the retained mode only when mode writing fails: %s', async failed => {
    mocks.apply.mockResolvedValue({ frequencyApplied: true, frequencyConfirmed: true, modeApplied: !failed,
      ...(failed ? { modeError: new Error('Feature not available') } : {}),
    });
    const response = await app.inject({ method: 'POST', url: '/frequency', payload: {
      frequency: 14270000, mode: 'VOICE', radioMode: 'AM', band: '20m',
    } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ success: true, radioMode: failed ? 'USB' : 'AM',
      message: failed ? 'Frequency set successfully' : 'Frequency and mode set successfully (AM)',
    });
    expect(mocks.apply).toHaveBeenCalledWith(expect.objectContaining({ frequency: 14270000, mode: 'AM', tolerateModeFailure: true }));
  });
});
