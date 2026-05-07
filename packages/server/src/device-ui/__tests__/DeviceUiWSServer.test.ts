import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { DeviceUiWSServer } from '../DeviceUiWSServer.js';

class FakeSocket extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  send = vi.fn((payload: string) => this.sent.push(payload));
  close = vi.fn();
}

const model = {
  schemaVersion: 1,
  page: 'access',
  updatedAt: 1,
  device: { id: 'd', profile: 'p', renderer: 'r' },
  network: { kind: 'offline', connected: false, interfaceName: null, ipAddress: null, helperAvailable: false },
  access: { url: null, qrText: null, pairingCode: null, pairingExpiresAt: null, browserClientCount: 0 },
  radio: { serverConnected: true, engineState: 'idle', radioConnected: false, frequencyHz: null, mode: null, band: null, pttActive: false, txOperatorIds: [], txText: null, slotSecondsRemaining: null },
  spectrum: { timestamp: 1, bins: [], peakBin: null },
  recentMessages: [],
  alert: null,
} as const;

describe('DeviceUiWSServer', () => {
  it('sends device state without using normal websocket handshakes', () => {
    let listener: (ops: unknown[]) => void = () => { throw new Error('listener not registered'); };
    const projection = {
      getModel: () => model,
      onPatch: (cb: (ops: unknown[]) => void) => { listener = cb; return () => undefined; },
    };
    const server = new DeviceUiWSServer(projection as never);
    const socket = new FakeSocket();

    server.addConnection(socket as never);
    expect(socket.send).toHaveBeenCalledOnce();
    expect(JSON.parse(socket.sent[0]!).type).toBe('state.replace');

    listener([{ path: 'page', value: 'monitor' }]);
    expect(JSON.parse(socket.sent[1]!).type).toBe('state.patch');

    socket.emit('message', JSON.stringify({ type: 'clientHandshake' }));
    expect(socket.sent.map(line => JSON.parse(line).type)).not.toContain('clientCountChanged');
  });
});
