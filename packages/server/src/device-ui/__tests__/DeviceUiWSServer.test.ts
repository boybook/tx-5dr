import { EventEmitter } from 'eventemitter3';
import { describe, expect, it, vi } from 'vitest';
import { DeviceUiWSServer } from '../DeviceUiWSServer.js';

class FakeWebSocket extends EventEmitter<any> {
  sent: string[] = [];
  failSend = false;
  close = vi.fn((code?: number, reason?: string) => {
    this.emit('close', code, reason);
  });

  send(data: string): void {
    if (this.failSend) throw new Error('send failed');
    this.sent.push(data);
  }
}

function createAuth() {
  return {
    verifyDeviceSession: vi.fn(async (token: string) => (
      token === 'device-jwt'
        ? { payload: { deviceId: 'panel-1', sessionId: 'session-1' }, session: {} }
        : null
    )),
  };
}

function createProjection() {
  const listeners = new Set<(snapshot: any) => void>();
  const snapshot = {
    server: { status: 'ok', version: 'test', webPort: 8076 },
    station: { callsign: 'BG5DRB' },
    engine: { running: false, mode: null, currentMode: null, state: null },
    radio: { connected: false, frequency: null, radioMode: null, ptt: false, tx: false },
    ft8: {
      slot: null,
      utc: null,
      cycle: null,
      periodMs: null,
      recentDecodeRawMessages: [],
      lastDecodeRawMessage: null,
      recentFramesSlotId: null,
      recentFramesSlotStartMs: null,
      recentFrames: [],
      currentTx: { active: false, operatorIds: [], messages: [], lastMessage: null, slotStartMs: null },
    },
    voice: {
      active: false,
      radioMode: null,
      pttLocked: false,
      pttLockedByLabel: null,
      keyerActive: false,
      keyerMode: null,
      keyerSlotId: null,
    },
    cw: {
      decoder: {
        enabled: false,
        active: false,
        state: 'disabled',
        muted: false,
        pendingText: '',
        committedText: '',
        lastDecodeAt: null,
        updatedAt: 1,
      },
      keyer: {
        active: false,
        mode: null,
        messageId: null,
        currentText: null,
        lastText: null,
      },
      currentTx: {
        active: false,
        messages: [],
        lastMessage: null,
      },
    },
    access: { localUrl: 'http://192.168.1.10:8076', localUrls: ['http://192.168.1.10:8076'] },
    updatedAt: 1,
  };
  return {
    subscribe: vi.fn((listener: (snapshot: any) => void) => {
      listeners.add(listener);
      listener(snapshot);
      return () => listeners.delete(listener);
    }),
    destroy: vi.fn(),
    emitSnapshot(next = snapshot) {
      for (const listener of listeners) listener(next);
    },
    listenerCount() {
      return listeners.size;
    },
  };
}

describe('DeviceUiWSServer', () => {
  it('rejects missing or non-device JWTs without subscribing to projection', async () => {
    const auth = createAuth();
    const projection = createProjection();
    const server = new DeviceUiWSServer({} as any, auth as any, projection as any);
    const ws = new FakeWebSocket();

    await server.acceptConnection(ws as any, { headers: { authorization: 'Bearer normal-jwt' } } as any);

    expect(ws.close).toHaveBeenCalledWith(4001, 'Device JWT required');
    expect(projection.subscribe).not.toHaveBeenCalled();
  });

  it('sends snapshot events for valid device JWTs and cleans up on close', async () => {
    const auth = createAuth();
    const projection = createProjection();
    const server = new DeviceUiWSServer({} as any, auth as any, projection as any);
    const ws = new FakeWebSocket();

    await server.acceptConnection(ws as any, { headers: { authorization: 'Bearer device-jwt' } } as any);

    expect(ws.close).not.toHaveBeenCalled();
    expect(projection.subscribe).toHaveBeenCalledTimes(1);
    expect(projection.listenerCount()).toBe(1);
    expect(JSON.parse(ws.sent[0])).toMatchObject({
      type: 'snapshot',
      payload: { server: { status: 'ok' }, access: { localUrl: 'http://192.168.1.10:8076', localUrls: ['http://192.168.1.10:8076'] } },
    });

    projection.emitSnapshot();
    expect(ws.sent).toHaveLength(2);

    ws.emit('message', JSON.stringify({ type: 'clientHandshake' }));
    expect(ws.sent).toHaveLength(2);

    ws.emit('close');
    expect(projection.listenerCount()).toBe(0);
  });

  it('cleans up the projection subscription if the initial snapshot send fails', async () => {
    const auth = createAuth();
    const projection = createProjection();
    const server = new DeviceUiWSServer({} as any, auth as any, projection as any);
    const ws = new FakeWebSocket();
    ws.failSend = true;

    await server.acceptConnection(ws as any, { headers: { authorization: 'Bearer device-jwt' } } as any);

    expect(projection.subscribe).toHaveBeenCalledTimes(1);
    expect(projection.listenerCount()).toBe(0);
    expect(ws.close).toHaveBeenCalledWith(1011, 'Device UI snapshot send failed');
  });
});
