import { describe, expect, it, vi } from 'vitest';
import { PluginEventBusHost } from '../PluginEventBusHost.js';

describe('PluginEventBusHost', () => {
  it('delivers messages to matching subscribers', async () => {
    const host = new PluginEventBusHost();
    const received: unknown[] = [];

    host.subscribe(
      { pluginName: 'subscriber', instanceScope: 'operator', operatorId: 'operator-1' },
      'plugin.topic',
      async (message) => {
        received.push(message.payload);
      },
    );

    host.publish(
      { pluginName: 'publisher', instanceScope: 'global' },
      'plugin.topic',
      { ok: true },
    );
    await Promise.resolve();

    expect(received).toEqual([{ ok: true }]);
  });

  it('gives the publisher and each subscriber independent payload snapshots', () => {
    const host = new PluginEventBusHost();
    const owner = { pluginName: 'subscriber', instanceScope: 'global' as const };
    const payload = { nested: { value: 'original' } };
    const received: unknown[] = [];

    host.subscribe(owner, 'plugin.topic', (message) => {
      received.push(message);
      (message.payload as typeof payload).nested.value = 'changed-by-first';
      message.publisher.pluginName = 'changed-by-first';
    });
    host.subscribe(
      { pluginName: 'second-subscriber', instanceScope: 'global' },
      'plugin.topic',
      (message) => {
        received.push(message);
      },
    );

    host.publish(
      { pluginName: 'publisher', instanceScope: 'global' },
      'plugin.topic',
      payload,
    );

    const [first, second] = received as Array<{
      payload: typeof payload;
      publisher: { pluginName: string };
    }>;
    expect(first).not.toBe(second);
    expect(first.payload).not.toBe(payload);
    expect(first.payload).not.toBe(second.payload);
    expect(payload).toEqual({ nested: { value: 'original' } });
    expect(second).toMatchObject({
      payload: { nested: { value: 'original' } },
      publisher: { pluginName: 'publisher' },
    });
  });

  it('preserves structured-clone data types and cyclic references', () => {
    const host = new PluginEventBusHost();
    const received: unknown[] = [];
    const payload: Record<string, unknown> = {
      date: new Date('2026-08-23T01:02:03.000Z'),
      map: new Map([['answer', 42]]),
      set: new Set(['FT8', 'FT4']),
      bigint: 7_074_000n,
      bytes: new Uint8Array([1, 2, 3]),
    };
    payload.self = payload;

    host.subscribe(
      { pluginName: 'subscriber', instanceScope: 'global' },
      'plugin.topic',
      (message) => {
        received.push(message.payload);
      },
    );
    host.publish({ pluginName: 'publisher', instanceScope: 'global' }, 'plugin.topic', payload);

    const snapshot = received[0] as typeof payload;
    expect(snapshot).not.toBe(payload);
    expect(snapshot.date).toEqual(new Date('2026-08-23T01:02:03.000Z'));
    expect(snapshot.map).toEqual(new Map([['answer', 42]]));
    expect(snapshot.set).toEqual(new Set(['FT8', 'FT4']));
    expect(snapshot.bigint).toBe(7_074_000n);
    expect(snapshot.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(snapshot.self).toBe(snapshot);
  });

  it('rejects uncloneable payloads before starting any subscriber', () => {
    const host = new PluginEventBusHost();
    const subscriber = vi.fn();
    host.subscribe(
      { pluginName: 'subscriber', instanceScope: 'global' },
      'plugin.topic',
      subscriber,
    );

    expect(() => {
      host.publish(
        { pluginName: 'publisher', instanceScope: 'global' },
        'plugin.topic',
        { callback: () => undefined },
      );
    }).toThrow(expect.objectContaining({
      code: 'PLUGIN_DATA_NOT_SERIALIZABLE',
      mode: 'structured',
    }));
    expect(subscriber).not.toHaveBeenCalled();
  });

  it('starts subscribers in order without waiting for async handlers', async () => {
    const host = new PluginEventBusHost();
    const events: string[] = [];
    let finishFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });

    host.subscribe(
      { pluginName: 'first-subscriber', instanceScope: 'global' },
      'plugin.topic',
      async () => {
        events.push('first:start');
        await firstCanFinish;
        events.push('first:finish');
      },
    );
    host.subscribe(
      { pluginName: 'second-subscriber', instanceScope: 'global' },
      'plugin.topic',
      () => {
        events.push('second:start');
      },
    );

    host.publish({ pluginName: 'publisher', instanceScope: 'global' }, 'plugin.topic');

    expect(events).toEqual(['first:start', 'second:start']);
    finishFirst();
    await firstCanFinish;
    await Promise.resolve();
    expect(events).toEqual(['first:start', 'second:start', 'first:finish']);
  });

  it('supports unsubscribe and unsubscribeAll', async () => {
    const host = new PluginEventBusHost();
    const first = vi.fn();
    const second = vi.fn();
    const owner = { pluginName: 'subscriber', instanceScope: 'operator' as const, operatorId: 'operator-1' };

    const unsubscribe = host.subscribe(owner, 'plugin.topic', first);
    host.subscribe(owner, 'plugin.topic', second);

    unsubscribe();
    host.publish({ pluginName: 'publisher', instanceScope: 'global' }, 'plugin.topic', 'one');
    await Promise.resolve();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);

    host.unsubscribeAll(owner);
    host.publish({ pluginName: 'publisher', instanceScope: 'global' }, 'plugin.topic', 'two');
    await Promise.resolve();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('deduplicates the same handler for the same owner and topic', async () => {
    const host = new PluginEventBusHost();
    const owner = { pluginName: 'subscriber', instanceScope: 'operator' as const, operatorId: 'operator-1' };
    const handler = vi.fn();

    host.subscribe(owner, 'plugin.topic', handler);
    host.subscribe(owner, 'plugin.topic', handler);

    host.publish({ pluginName: 'publisher', instanceScope: 'global' }, 'plugin.topic', 'value');
    await Promise.resolve();

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('captures subscriber errors without throwing to publishers', async () => {
    const onError = vi.fn();
    const host = new PluginEventBusHost(onError);

    host.subscribe(
      { pluginName: 'subscriber', instanceScope: 'global' },
      'plugin.topic',
      async () => {
        throw new Error('boom');
      },
    );

    expect(() => {
      host.publish({ pluginName: 'publisher', instanceScope: 'global' }, 'plugin.topic', 'value');
    }).not.toThrow();

    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      subscriber: expect.objectContaining({ pluginName: 'subscriber' }),
      message: expect.objectContaining({
        topic: 'plugin.topic',
        payload: 'value',
        publisher: expect.objectContaining({ pluginName: 'publisher' }),
      }),
      error: expect.any(Error),
    }));
  });

  it('does not let a failing subscriber spoof diagnostic message metadata', () => {
    const onError = vi.fn();
    const host = new PluginEventBusHost(onError);
    host.subscribe(
      { pluginName: 'subscriber', instanceScope: 'global' },
      'plugin.topic',
      (message) => {
        message.topic = 'spoofed.topic';
        message.publisher.pluginName = 'spoofed-plugin';
        throw new Error('boom');
      },
    );

    host.publish({ pluginName: 'publisher', instanceScope: 'global' }, 'plugin.topic', 'value');

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.objectContaining({
        topic: 'plugin.topic',
        publisher: expect.objectContaining({ pluginName: 'publisher' }),
      }),
    }));
  });
});
