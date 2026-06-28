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
});
