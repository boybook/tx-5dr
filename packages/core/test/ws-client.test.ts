import test from 'node:test';
import assert from 'node:assert/strict';
import { WSClient } from '../src/websocket/WSClient.js';

class FakeWebSocket {
  static sockets: FakeWebSocket[] = [];

  url: string;
  readyState = 0;
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.sockets.push(this);
  }

  send(): void {
    // no-op
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
