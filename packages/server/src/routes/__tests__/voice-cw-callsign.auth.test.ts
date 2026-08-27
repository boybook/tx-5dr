import Fastify, { type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserRole } from '@tx5dr/contracts';

const getPanel = vi.fn(async () => ({ callsign: 'stub', slotCount: 12, slots: [] }));
const updatePanel = vi.fn(async () => ({ callsign: 'stub', slotCount: 12, slots: [] }));
const updateSlot = vi.fn(async () => ({ callsign: 'stub', slotCount: 12, slots: [] }));
const saveSlotAudio = vi.fn(async () => ({ callsign: 'stub', slotCount: 12, slots: [] }));
const deleteSlotAudio = vi.fn(async () => ({ callsign: 'stub', slotCount: 12, slots: [] }));
const swapSlots = vi.fn(async () => ({ callsign: 'stub', slotCount: 12, slots: [] }));
const deleteSlotText = vi.fn(async () => ({ callsign: 'stub', slotCount: 12, slots: [] }));

vi.mock('../../DigitalRadioEngine.js', () => ({
  DigitalRadioEngine: {
    getInstance: () => ({
      getVoiceKeyerManager: () => ({ getPanel, updatePanel, updateSlot, saveSlotAudio, deleteSlotAudio }),
      getCWKeyerManager: () => ({ getPanel, updatePanel, updateSlot, deleteSlotText, swapSlots }),
    }),
  },
}));

vi.mock('../../config/config-manager.js', () => ({
  ConfigManager: {
    getInstance: () => ({
      getOperatorsConfig: () => [
        { id: 'operator-1', myCallsign: 'BG5DRB' },
        { id: 'operator-2', myCallsign: 'AA1BB' },
      ],
    }),
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

describe('voice/cw keyer callsign access control', () => {
  let fastify: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    getPanel.mockClear();
    updatePanel.mockClear();
    updateSlot.mockClear();
    saveSlotAudio.mockClear();
    deleteSlotAudio.mockClear();
    swapSlots.mockClear();
    deleteSlotText.mockClear();
    const [{ voiceRoutes }, { cwRoutes }] = await Promise.all([
      import('../voice.js'),
      import('../cw.js'),
    ]);
    fastify = Fastify();
    fastify.decorateRequest('authUser', null);
    fastify.addHook('onRequest', async (request: FastifyRequest) => {
      const role = request.headers['x-role'];
      if (typeof role !== 'string') {
        request.authUser = null;
        return;
      }
      const operatorIdsHeader = request.headers['x-operator-ids'];
      request.authUser = {
        tokenId: 'test-token',
        role: role as UserRole,
        operatorIds: typeof operatorIdsHeader === 'string'
          ? operatorIdsHeader.split(',').map((id) => id.trim()).filter(Boolean)
          : ['operator-1'],
        iat: 0,
        exp: 0,
      };
    });
    await fastify.register(voiceRoutes, { prefix: '/api/voice' });
    await fastify.register(cwRoutes, { prefix: '/api/cw' });
  });

  afterEach(async () => {
    await fastify.close();
  });

  it('allows an operator to read their own callsign voice keyer panel', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/api/voice/keyer/BG5DRB',
      headers: { 'x-role': UserRole.OPERATOR },
    });

    expect(response.statusCode).toBe(200);
    expect(getPanel).toHaveBeenCalledWith('BG5DRB');
  });

  it('blocks an operator from reading another callsign voice keyer panel', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/api/voice/keyer/AA1BB',
      headers: { 'x-role': UserRole.OPERATOR },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      success: false,
      error: { code: 'FORBIDDEN', message: 'No permission to access this callsign' },
    });
    expect(getPanel).not.toHaveBeenCalled();
  });

  it('blocks callsigns with portable suffixes belonging to other operators', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/api/voice/keyer/AA1BB%2FP',
      headers: { 'x-role': UserRole.OPERATOR },
    });

    expect(response.statusCode).toBe(403);
    expect(getPanel).not.toHaveBeenCalled();
  });

  it('allows admins to read any callsign voice keyer panel', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/api/voice/keyer/AA1BB',
      headers: { 'x-role': UserRole.ADMIN },
    });

    expect(response.statusCode).toBe(200);
    expect(getPanel).toHaveBeenCalledWith('AA1BB');
  });

  it('keeps voice keyer panels unavailable to anonymous requests', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/api/voice/keyer/BG5DRB',
    });

    expect(response.statusCode).toBe(401);
    expect(getPanel).not.toHaveBeenCalled();
  });

  it('blocks operators from uploading audio to another callsign keyer slot', async () => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/voice/keyer/AA1BB/slots/1/audio',
      headers: { 'x-role': UserRole.OPERATOR },
    });

    expect(response.statusCode).toBe(403);
    expect(saveSlotAudio).not.toHaveBeenCalled();
  });

  it('blocks operators from modifying another callsign keyer slot and panel', async () => {
    const slot = await fastify.inject({
      method: 'PATCH',
      url: '/api/voice/keyer/AA1BB/slots/1',
      headers: { 'x-role': UserRole.OPERATOR },
      payload: { text: 'hijack' },
    });
    const panel = await fastify.inject({
      method: 'PATCH',
      url: '/api/voice/keyer/AA1BB',
      headers: { 'x-role': UserRole.OPERATOR },
      payload: { slotCount: 6 },
    });
    const removed = await fastify.inject({
      method: 'DELETE',
      url: '/api/voice/keyer/AA1BB/slots/1/audio',
      headers: { 'x-role': UserRole.OPERATOR },
    });

    expect(slot.statusCode).toBe(403);
    expect(panel.statusCode).toBe(403);
    expect(removed.statusCode).toBe(403);
    expect(updateSlot).not.toHaveBeenCalled();
    expect(updatePanel).not.toHaveBeenCalled();
    expect(deleteSlotAudio).not.toHaveBeenCalled();
  });

  it('allows a token bound to several operators to access each of their callsigns', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/api/voice/keyer/AA1BB',
      headers: { 'x-role': UserRole.OPERATOR, 'x-operator-ids': 'operator-1,operator-2' },
    });

    expect(response.statusCode).toBe(200);
    expect(getPanel).toHaveBeenCalledWith('AA1BB');
  });

  it('allows an operator to read their own callsign cw panel', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/api/cw/panel/BG5DRB',
      headers: { 'x-role': UserRole.OPERATOR },
    });

    expect(response.statusCode).toBe(200);
    expect(getPanel).toHaveBeenCalledWith('BG5DRB');
  });

  it('blocks an operator from touching another callsign cw panel', async () => {
    const read = await fastify.inject({
      method: 'GET',
      url: '/api/cw/panel/AA1BB',
      headers: { 'x-role': UserRole.OPERATOR },
    });
    const removed = await fastify.inject({
      method: 'DELETE',
      url: '/api/cw/panel/AA1BB/slots/1',
      headers: { 'x-role': UserRole.OPERATOR },
    });
    const swapped = await fastify.inject({
      method: 'POST',
      url: '/api/cw/panel/AA1BB/slots/swap',
      headers: { 'x-role': UserRole.OPERATOR },
      payload: { slotIdA: '1', slotIdB: '2' },
    });
    const updated = await fastify.inject({
      method: 'PATCH',
      url: '/api/cw/panel/AA1BB/slots/1',
      headers: { 'x-role': UserRole.OPERATOR },
      payload: { text: 'hijack' },
    });
    const panelUpdate = await fastify.inject({
      method: 'PATCH',
      url: '/api/cw/panel/AA1BB',
      headers: { 'x-role': UserRole.OPERATOR },
      payload: { slotCount: 4 },
    });

    expect(read.statusCode).toBe(403);
    expect(removed.statusCode).toBe(403);
    expect(swapped.statusCode).toBe(403);
    expect(updated.statusCode).toBe(403);
    expect(panelUpdate.statusCode).toBe(403);
    expect(getPanel).not.toHaveBeenCalled();
    expect(deleteSlotText).not.toHaveBeenCalled();
    expect(swapSlots).not.toHaveBeenCalled();
    expect(updateSlot).not.toHaveBeenCalled();
    expect(updatePanel).not.toHaveBeenCalled();
  });

  it('allows admins to read any callsign cw panel', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/api/cw/panel/AA1BB',
      headers: { 'x-role': UserRole.ADMIN },
    });

    expect(response.statusCode).toBe(200);
    expect(getPanel).toHaveBeenCalledWith('AA1BB');
  });

  it('keeps cw panels unavailable to viewers', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/api/cw/panel/BG5DRB',
      headers: { 'x-role': UserRole.VIEWER },
    });

    expect(response.statusCode).toBe(403);
    expect(getPanel).not.toHaveBeenCalled();
  });
});
