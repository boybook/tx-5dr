import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  WorkerIpcSender,
  type WorkerIpcChannel,
} from '../WorkerIpcSender.js';

interface TestMessage {
  type: string;
}

describe('WorkerIpcSender', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for every send acknowledgement before disconnecting', async () => {
    const callbacks: Array<(error: Error | null) => void> = [];
    const channel: WorkerIpcChannel = {
      connected: true,
      send: vi.fn((_message, callback) => {
        callbacks.push(callback!);
        return false;
      }),
      disconnect: vi.fn(),
    };
    const sender = new WorkerIpcSender<TestMessage>(channel);

    sender.post({ type: 'progress' });
    const finished = sender.finish({ type: 'result' });
    await vi.waitFor(() => expect(channel.send).toHaveBeenCalledTimes(1));
    expect(channel.disconnect).not.toHaveBeenCalled();

    callbacks.shift()!(null);
    await vi.waitFor(() => expect(channel.send).toHaveBeenCalledTimes(2));
    expect(channel.disconnect).not.toHaveBeenCalled();

    callbacks.shift()!(null);
    await finished;
    expect(channel.disconnect).toHaveBeenCalledTimes(1);
  });

  it('reports a disconnected channel without waiting for the timeout', async () => {
    const onFailure = vi.fn();
    const channel: WorkerIpcChannel = {
      connected: false,
      send: vi.fn(() => true),
      disconnect: vi.fn(),
    };
    const sender = new WorkerIpcSender<TestMessage>(channel, { onFailure });

    await sender.finish({ type: 'result' });

    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Worker IPC channel is not connected',
    }));
    expect(channel.send).not.toHaveBeenCalled();
    expect(channel.disconnect).not.toHaveBeenCalled();
  });

  it('bounds a send whose callback never arrives', async () => {
    vi.useFakeTimers();
    const onFailure = vi.fn();
    const channel: WorkerIpcChannel = {
      connected: true,
      send: vi.fn(() => true),
      disconnect: vi.fn(),
    };
    const sender = new WorkerIpcSender<TestMessage>(channel, {
      sendTimeoutMs: 100,
      onFailure,
    });

    const finished = sender.finish({ type: 'result' });
    await vi.advanceTimersByTimeAsync(101);
    await finished;

    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Worker IPC send was not acknowledged within 100ms',
    }));
    expect(channel.disconnect).toHaveBeenCalledTimes(1);
  });

  it('reports an asynchronous send error and disconnects', async () => {
    const onFailure = vi.fn();
    const channel: WorkerIpcChannel = {
      connected: true,
      send: vi.fn((_message, callback) => {
        callback!(new Error('send failed'));
        return false;
      }),
      disconnect: vi.fn(),
    };
    const sender = new WorkerIpcSender<TestMessage>(channel, { onFailure });

    await sender.finish({ type: 'result' });

    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ message: 'send failed' }));
    expect(channel.disconnect).toHaveBeenCalledTimes(1);
  });
});
