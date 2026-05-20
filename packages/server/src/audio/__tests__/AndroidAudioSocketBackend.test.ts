import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { writeBufferWithBackpressure } from '../AndroidAudioSocketBackend.js';

class FakeDrainableSocket extends EventEmitter {
  destroyed = false;
  writable = true;
  writableLength = 0;
  writes = 0;

  constructor(private readonly writeResult: boolean) {
    super();
  }

  write(_buffer: Buffer): boolean {
    this.writes += 1;
    return this.writeResult;
  }
}

describe('AndroidAudioSocketBackend backpressure writes', () => {
  it('resolves immediately when socket accepts the chunk', async () => {
    const socket = new FakeDrainableSocket(true);

    const result = await writeBufferWithBackpressure(socket, Buffer.alloc(4), 10);

    expect(result.ok).toBe(true);
    expect(result.backpressured).toBe(false);
    expect(socket.writes).toBe(1);
  });

  it('waits for drain when socket applies backpressure', async () => {
    vi.useFakeTimers();
    const socket = new FakeDrainableSocket(false);
    const promise = writeBufferWithBackpressure(socket, Buffer.alloc(4), 100);

    await vi.advanceTimersByTimeAsync(10);
    socket.emit('drain');
    const result = await promise;

    expect(result.ok).toBe(true);
    expect(result.backpressured).toBe(true);
    expect(result.waitMs).toBeGreaterThanOrEqual(0);
    vi.useRealTimers();
  });

  it('fails when drain does not arrive before timeout', async () => {
    vi.useFakeTimers();
    const socket = new FakeDrainableSocket(false);
    const promise = writeBufferWithBackpressure(socket, Buffer.alloc(4), 25);

    await vi.advanceTimersByTimeAsync(25);
    const result = await promise;

    expect(result.ok).toBe(false);
    expect(result.backpressured).toBe(true);
    vi.useRealTimers();
  });

  it('fails when the socket closes while waiting for drain', async () => {
    const socket = new FakeDrainableSocket(false);
    const promise = writeBufferWithBackpressure(socket, Buffer.alloc(4), 100);

    socket.emit('close');
    const result = await promise;

    expect(result.ok).toBe(false);
    expect(result.backpressured).toBe(true);
  });
});
