import test from 'node:test';
import assert from 'node:assert/strict';
import { WSMessageType } from '@tx5dr/contracts';
import { WSClient } from '../src/websocket/WSClient.js';

class FakeWebSocket {
  static sockets: FakeWebSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  readyState = 0;
  bufferedAmount = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.sockets.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
}

function installFakeWebSocket(): () => void {
  const originalWebSocket = globalThis.WebSocket;
  FakeWebSocket.sockets = [];
  (globalThis as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket = FakeWebSocket;
  return () => {
    (globalThis as unknown as { WebSocket: typeof originalWebSocket }).WebSocket = originalWebSocket;
  };
}

test('does not emit an error event for a socket replaced by forceReconnect', async () => {
  const restoreWebSocket = installFakeWebSocket();
  try {
    const client = new WSClient({ url: 'ws://example.test/ws' });
    let errorEvents = 0;
    client.onWSEvent('error', () => {
      errorEvents += 1;
    });

    const connectPromise = client.connect();
    const firstSocket = FakeWebSocket.sockets[0];
    firstSocket.open();
    await connectPromise;

    const reconnectPromise = client.forceReconnect();
    assert.equal(FakeWebSocket.sockets.length, 2);

    firstSocket.onerror?.({ type: 'error' });
    assert.equal(errorEvents, 0);

    FakeWebSocket.sockets[1].open();
    await reconnectPromise;
    client.disconnect();
  } finally {
    restoreWebSocket();
  }
});

test('does not emit an app error event for an active socket transport error', async () => {
  const restoreWebSocket = installFakeWebSocket();
  try {
    const client = new WSClient({ url: 'ws://example.test/ws' });
    let errorEvents = 0;
    client.onWSEvent('error', () => {
      errorEvents += 1;
    });

    const connectPromise = client.connect();
    const socket = FakeWebSocket.sockets[0];
    socket.open();
    await connectPromise;

    socket.onerror?.({ type: 'error' });
    assert.equal(errorEvents, 0);

    client.disconnect();
  } finally {
    restoreWebSocket();
  }
});

test('rejects the pending connection without emitting app error for a pre-open transport error', async () => {
  const restoreWebSocket = installFakeWebSocket();
  try {
    const client = new WSClient({ url: 'ws://example.test/ws' });
    let errorEvents = 0;
    client.onWSEvent('error', () => {
      errorEvents += 1;
    });

    const connectPromise = client.connect();
    const socket = FakeWebSocket.sockets[0];
    socket.onerror?.({ type: 'error' });

    await assert.rejects(connectPromise, /WebSocket connection failed/);
    assert.equal(errorEvents, 0);
    client.disconnect();
  } finally {
    restoreWebSocket();
  }
});

test('voice transmit commands include operatorId when provided', async () => {
  const restoreWebSocket = installFakeWebSocket();
  try {
    const client = new WSClient({ url: 'ws://example.test/ws' });
    const connectPromise = client.connect();
    const socket = FakeWebSocket.sockets[0];
    socket.open();
    await connectPromise;

    client.requestVoicePTT('voice-client-1', 'operator-1');
    client.playVoiceKeyer('BG5DRB', 'slot-1', true, false, 'operator-1');

    const messages = socket.sent.map(raw => JSON.parse(raw) as { type: string; data?: Record<string, unknown> });
    assert.deepEqual(messages.map(message => message.type), [
      WSMessageType.VOICE_PTT_REQUEST,
      WSMessageType.VOICE_KEYER_PLAY,
    ]);
    assert.deepEqual(messages[0].data, {
      voiceAudioClientId: 'voice-client-1',
      operatorId: 'operator-1',
    });
    assert.deepEqual(messages[1].data, {
      callsign: 'BG5DRB',
      slotId: 'slot-1',
      repeat: true,
      startImmediately: false,
      operatorId: 'operator-1',
    });

    client.disconnect();
  } finally {
    restoreWebSocket();
  }
});
