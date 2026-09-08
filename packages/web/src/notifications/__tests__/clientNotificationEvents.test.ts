import { describe, expect, it, vi } from 'vitest';
import { WSClient } from '@tx5dr/core';
import { QSORecordSchema, SlotPackSchema } from '@tx5dr/contracts';
import { subscribeClientNotificationEvents, type NotificationEventSnapshot } from '../clientNotificationEvents';

function pack(startMs: number, sender = 'JA1ABC') {
  return SlotPackSchema.parse({
    slotId: `slot-${startMs}`, startMs, endMs: startMs + 15000,
    frames: [{ message: `BG5DRB ${sender} PM95`, snr: -12, dt: 0, freq: 1000 }],
  });
}

function setup() {
  const client = new WSClient({ url: 'ws://localhost:4000' });
  const state: NotificationEventSnapshot = { callsigns: ['BG5DRB'], mode: 'FT8', replyEnabled: true, slotPacks: [], syncing: false };
  const deliver = vi.fn();
  const cleanup = subscribeClientNotificationEvents(client, () => state, deliver);
  return { client, state, deliver, cleanup };
}

describe('client notification event subscription', () => {
  it('suppresses handshake history and operator-selection replay, then delivers fresh replies', () => {
    const { client, deliver, cleanup } = setup();
    client.emitWSEvent('slotPacksReset', { phase: 'start' });
    client.emitWSEvent('slotPackUpdated', pack(0));
    client.emitWSEvent('slotPacksReset', { phase: 'complete' });
    client.emitWSEvent('handshakeComplete', {} as never);
    client.emitWSEvent('slotPackUpdated', pack(30000));
    expect(deliver).not.toHaveBeenCalled();
    client.emitWSEvent('slotPackUpdated', pack(30000, 'JA2ABC'));
    expect(deliver).toHaveBeenCalledOnce();
    client.emitWSEvent('slotPacksReset', { phase: 'start' });
    client.emitWSEvent('slotPackUpdated', pack(60000, 'JA3ABC'));
    client.emitWSEvent('slotPacksReset', { phase: 'complete' });
    client.emitWSEvent('slotPackUpdated', pack(90000, 'JA3ABC'));
    expect(deliver).toHaveBeenCalledOnce();
    cleanup();
  });

  it('uses current scope and mode, consumes disabled messages and rejects malformed packets', () => {
    const { client, state, deliver, cleanup } = setup();
    client.emitWSEvent('handshakeComplete', {} as never);
    state.replyEnabled = false;
    client.emitWSEvent('slotPackUpdated', pack(0));
    state.replyEnabled = true;
    client.emitWSEvent('slotPackUpdated', pack(30000));
    state.callsigns = ['BG6ABC'];
    client.emitWSEvent('slotPackUpdated', pack(60000, 'JA2ABC'));
    state.callsigns = ['BG5DRB'];
    state.mode = 'CW';
    client.emitWSEvent('slotPackUpdated', pack(90000, 'JA3ABC'));
    state.mode = 'FT4';
    client.emitWSEvent('slotPackUpdated', { frames: null } as never);
    expect(deliver).not.toHaveBeenCalled();
    client.emitWSEvent('slotPackUpdated', pack(120000, 'JA4ABC'));
    expect(deliver).toHaveBeenCalledOnce();
    cleanup();
  });

  it('waits for a new handshake after disconnect and removes all its listeners on cleanup', () => {
    const { client, deliver, cleanup } = setup();
    client.emitWSEvent('handshakeComplete', {} as never);
    client.emitWSEvent('slotPackUpdated', pack(0));
    client.emitWSEvent('disconnected');
    client.emitWSEvent('slotPackUpdated', pack(30000));
    client.emitWSEvent('handshakeComplete', {} as never);
    client.emitWSEvent('slotPackUpdated', pack(60000, 'JA2ABC'));
    expect(deliver).toHaveBeenCalledTimes(2);
    cleanup();
    client.emitWSEvent('slotPackUpdated', pack(90000, 'JA3ABC'));
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(client.listenerCount('slotPackUpdated')).toBe(0);
    expect(client.listenerCount('qsoRecordAdded')).toBe(0);
  });

  it('delivers QSO events independently of reply settings and digital mode', () => {
    const { client, state, deliver, cleanup } = setup();
    state.replyEnabled = false;
    state.mode = 'VOICE';
    client.emitWSEvent('handshakeComplete', {} as never);
    const record = QSORecordSchema.parse({ id: 'qso-1', callsign: 'JA1ABC', mode: 'SSB', frequency: 14074000, startTime: 0, messageHistory: [] });
    client.emitWSEvent('qsoRecordAdded', { operatorId: 'op-1', logBookId: 'log-1', qsoRecord: record });
    expect(deliver).toHaveBeenCalledWith({ type: 'qsoLogged', record });
    cleanup();
  });
});
