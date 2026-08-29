import { describe, it, expect, vi } from 'vitest';
import {
  createMockKVStore,
  createMockLogger,
  createMockTimers,
  createMockUIBridge,
  createMockFileStore,
  createMockContext,
  createMockSlotInfo,
  createMockParsedMessage,
  createMockOperatorSnapshot,
  createMockOperatorCommandPort,
  createMockRadioView,
  createMockRadioCapabilitiesView,
  createMockRadioPowerView,
  createMockLogbookAccess,
  createMockBandAccess,
  createMockHostSettingsControl,
  createMockEventBus,
} from '../testing/index.js';

describe('plugin-api testing utilities', () => {
  describe('createMockKVStore', () => {
    it('supports get/set/delete/getAll', () => {
      const store = createMockKVStore({ key1: 'value1' });
      expect(store.get('key1')).toBe('value1');
      expect(store.get('missing', 'default')).toBe('default');

      store.set('key2', 42);
      expect(store._data.get('key2')).toBe(42);

      store.delete('key1');
      expect(store.getAll()).toEqual({ key2: 42 });
    });

    it('matches production JSON copy semantics', () => {
      const initial = { config: { nested: { count: 1 } } };
      const store = createMockKVStore(initial);
      initial.config.nested.count = 2;
      expect(store.get('config')).toEqual({ nested: { count: 1 } });

      const input = { nested: { count: 3 }, omitted: undefined, invalidNumber: Number.NaN };
      store.set('config', input);
      store.set('removed', { stale: true });
      store.set('removed', undefined);
      input.nested.count = 4;
      expect(store.get('config')).toEqual({ nested: { count: 3 }, invalidNumber: null });

      const value = store.get<{ nested: { count: number } }>('config');
      value.nested.count = 5;
      expect(store.get('config')).toEqual({ nested: { count: 3 }, invalidNumber: null });

      const all = store.getAll() as { config: { nested: { count: number } } };
      all.config.nested.count = 6;
      expect(store.getAll()).toEqual({ config: { nested: { count: 3 }, invalidNumber: null } });
    });

    it('returns a missing key default without cloning it', () => {
      const store = createMockKVStore();
      const defaultValue = { nested: { count: 1 } };

      expect(store.get('missing', defaultValue)).toBe(defaultValue);
    });
  });

  describe('createMockLogger', () => {
    it('records all log calls', () => {
      const log = createMockLogger();
      log.debug('d', { a: 1 });
      log.info('i');
      log.warn('w');
      log.error('e', new Error('test'));

      expect(log._calls).toHaveLength(4);
      expect(log._calls[0]).toEqual({ level: 'debug', message: 'd', data: { a: 1 } });
      expect(log._calls[1]).toEqual({ level: 'info', message: 'i', data: undefined });
    });
  });

  describe('createMockTimers', () => {
    it('tracks active timers', () => {
      const timers = createMockTimers();
      timers.set('poll', 5000);
      expect(timers._active.get('poll')).toBe(5000);

      timers.clear('poll');
      expect(timers._active.size).toBe(0);
    });

    it('clearAll removes all timers', () => {
      const timers = createMockTimers();
      timers.set('a', 100);
      timers.set('b', 200);
      timers.clearAll();
      expect(timers._active.size).toBe(0);
    });
  });

  describe('createMockUIBridge', () => {
    it('captures sent panel data', () => {
      const ui = createMockUIBridge();
      ui.send('my-panel', { count: 1 });
      ui.send('my-panel', { count: 2 });

      expect(ui._sentData.get('my-panel')).toEqual([{ count: 1 }, { count: 2 }]);
    });

    it('captures panel data by value', () => {
      const ui = createMockUIBridge();
      const data = { nested: { count: 1 } };
      ui.send('my-panel', data);
      data.nested.count = 2;

      expect(ui._sentData.get('my-panel')).toEqual([{ nested: { count: 1 } }]);
    });

    it('captures metadata, contributions, and pushes by value', () => {
      const ui = createMockUIBridge();
      const data = { nested: { count: 1 } };
      const meta = { titleValues: { count: '1' } };
      const params = { count: '1' };
      ui.setPanelMeta('panel', meta);
      ui.setPanelContributions('group', [{
        id: 'panel', title: 'Panel', component: 'key-value', params,
      }]);
      ui.pushToSession('session', 'updated', data);
      ui.pushToPage('settings', 'updated', data);
      data.nested.count = 2;
      meta.titleValues.count = '2';
      params.count = '2';

      expect(ui._events).toEqual([
        { type: 'panel-meta', id: 'panel', data: { titleValues: { count: '1' } } },
        {
          type: 'panel-contributions',
          id: 'group',
          data: [{ id: 'panel', title: 'Panel', component: 'key-value', params: { count: '1' } }],
        },
        { type: 'session-push', id: 'session:updated', data: { nested: { count: 1 } } },
        { type: 'page-push', id: 'settings:updated', data: { nested: { count: 1 } } },
      ]);
    });
  });

  describe('createMockFileStore', () => {
    it('copies buffers at write and read boundaries', async () => {
      const files = createMockFileStore();
      const input = Buffer.from('original');
      await files.write('value.bin', input);
      input.fill(0);

      const first = await files.read('value.bin');
      expect(first?.toString()).toBe('original');
      first?.fill(1);
      expect((await files.read('value.bin'))?.toString()).toBe('original');
    });
  });

  describe('createMockContext', () => {
    it('creates a safe context with defaults', () => {
      const ctx = createMockContext();
      expect(ctx.operator.callsign).toBe('W1AW');
      expect(ctx.operator.grid).toBe('FN31');
      expect(ctx.radio.isConnected).toBe(true);
      expect(ctx.config).toEqual({});
      expect('eventBus' in ctx).toBe(false);
    });

    it('does not expose mock host dependencies without permissions', () => {
      const ctx = createMockContext();
      expect('hostDependencies' in ctx).toBe(false);
      expect('operatorCommands' in ctx).toBe(false);
    });

    it('exposes only the host-arbitrated command port with transmit-control permission', async () => {
      const ctx = createMockContext({ permissions: ['operator:transmit-control'] });
      expect(ctx.operatorCommands).toBeDefined();
      expect('startTransmitting' in ctx.operator).toBe(false);
      await ctx.operatorCommands?.submit({ type: 'start-automation' });
    });

    it('provides mock host dependencies with host permissions', () => {
      const ctx = createMockContext({ permissions: ['host:hamlib'] });
      expect(ctx.hostDependencies?.hamlib?.Rotator.getHamlibVersion()).toBe('mock-hamlib');
      expect(ctx.hostDependencies?.hamlib?.Rotator.getSupportedRotators()).toEqual([]);
    });

    it('accepts overrides', () => {
      const ctx = createMockContext({
        callsign: 'JA1ABC',
        grid: 'PM95',
        config: { watchNewDxcc: true },
        radio: { band: '40m', frequency: 7074000 },
      });
      expect(ctx.operator.callsign).toBe('JA1ABC');
      expect(ctx.operator.grid).toBe('PM95');
      expect(ctx.config).toEqual({ watchNewDxcc: true });
      expect(ctx.radio.band).toBe('40m');
    });

    it('provides config snapshots and applies explicit updates', async () => {
      const initial = { nested: { enabled: true } };
      const ctx = createMockContext({ config: initial });
      initial.nested.enabled = false;
      const snapshot = ctx.config as typeof initial;
      snapshot.nested.enabled = false;

      expect(ctx.config).toEqual({ nested: { enabled: true } });
      await ctx.updateConfig({ nested: { enabled: false } });
      expect(ctx.config).toEqual({ nested: { enabled: false } });
      await ctx.updateConfig({ updatedAt: new Date('2026-08-23T00:00:00.000Z') });
      expect(ctx.config.updatedAt).toBe('2026-08-23T00:00:00.000Z');
      await expect(ctx.updateConfig({ invalid: 1n })).rejects.toThrow();
    });

    it('provides typed access to sub-mocks', () => {
      const ctx = createMockContext();
      ctx.store.global.set('k', 'v');
      expect(ctx.store.global._data.get('k')).toBe('v');

      ctx.log.info('test');
      expect(ctx.log._calls).toHaveLength(1);
    });

    it('exposes only plugin-owned sessions for the session permission', async () => {
      const ctx = createMockContext({
        permissions: ['logbook:session'],
        callsign: 'BG4IAJ',
      });
      expect('queryQSOs' in ctx.logbook).toBe(false);
      const session = await ctx.logbook.sessions.open({
        sessionKey: 'contest:2026',
        stationCallsign: 'BG4IAJ',
        title: 'Contest 2026',
      });
      expect(session).toMatchObject({
        id: 'plugin-session-contest:2026',
        title: 'Contest 2026',
      });
    });

    it('includes host settings mocks', async () => {
      const ctx = createMockContext({ permissions: ['settings:ft8'] });
      await expect(ctx.settings.ft8.update({ maxSameTransmissionCount: 0 })).resolves.toMatchObject({
        maxSameTransmissionCount: 0,
      });
    });

    it('accepts an event bus override', () => {
      const eventBus = createMockEventBus();
      const ctx = createMockContext({ permissions: ['plugin:event-bus'], eventBus });
      expect(ctx.eventBus).toBe(eventBus);
    });
  });

  describe('createMockEventBus', () => {
    it('publishes to matching subscribers and supports unsubscribe', async () => {
      const eventBus = createMockEventBus();
      const received: string[] = [];
      const unsubscribe = eventBus.subscribe('plugin.topic', async (message) => {
        received.push(String(message.payload));
      });

      eventBus.publish('plugin.topic', 'first');
      await Promise.resolve();
      expect(received).toEqual(['first']);
      expect(eventBus._published).toHaveLength(1);

      unsubscribe();
      eventBus.publish('plugin.topic', 'second');
      await Promise.resolve();
      expect(received).toEqual(['first']);
    });

    it('deduplicates the same handler per topic', async () => {
      const eventBus = createMockEventBus();
      const handler = vi.fn();

      eventBus.subscribe('plugin.topic', handler);
      eventBus.subscribe('plugin.topic', handler);
      eventBus.publish('plugin.topic', 'value');
      await Promise.resolve();

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('omits operatorId for global-scope publishers', () => {
      const eventBus = createMockEventBus({
        owner: {
          pluginName: 'global-plugin',
          instanceScope: 'global',
          operatorId: 'operator-should-be-ignored',
        },
      });

      eventBus.publish('plugin.topic', 'value');

      expect(eventBus._published[0]?.publisher).toEqual({
        pluginName: 'global-plugin',
        instanceScope: 'global',
      });
    });

    it('delivers independent payload values', async () => {
      const eventBus = createMockEventBus();
      const received: number[] = [];
      eventBus.subscribe('plugin.topic', (message) => {
        const payload = message.payload as { nested: { count: number } };
        payload.nested.count = 2;
      });
      eventBus.subscribe('plugin.topic', (message) => {
        received.push((message.payload as { nested: { count: number } }).nested.count);
      });
      const payload = { nested: { count: 1 } };

      eventBus.publish('plugin.topic', payload);
      payload.nested.count = 3;
      await Promise.resolve();

      expect(received).toEqual([1]);
      expect((eventBus._published[0]?.payload as typeof payload).nested.count).toBe(1);
    });

    it('isolates subscriber failures from publishers and later subscribers', async () => {
      const eventBus = createMockEventBus();
      const later = vi.fn();
      eventBus.subscribe('plugin.topic', () => {
        throw new Error('sync failure');
      });
      eventBus.subscribe('plugin.topic', async () => {
        throw new Error('async failure');
      });
      eventBus.subscribe('plugin.topic', later);

      expect(() => eventBus.publish('plugin.topic', 'value')).not.toThrow();
      await Promise.resolve();
      await Promise.resolve();
      expect(later).toHaveBeenCalledTimes(1);
    });
  });

  describe('createMockHostSettingsControl', () => {
    it('supports default host settings namespaces', async () => {
      const settings = createMockHostSettingsControl();

      expect(await settings.ft8.get()).toMatchObject({ myCallsign: 'W1AW' });
      await expect(settings.ntp.update({ servers: ['time.cloudflare.com'] })).resolves.toMatchObject({
        servers: ['time.cloudflare.com'],
      });
    });

    it('returns settings by value', async () => {
      const settings = createMockHostSettingsControl();
      const first = await settings.station.get();
      first.qth!.grid = 'AA00';

      expect((await settings.station.get()).qth!.grid).toBe('FN31');
    });

    it('accepts namespace overrides', async () => {
      const settings = createMockHostSettingsControl({
        ft8: {
          get: async () => ({
            myCallsign: 'JA1ABC',
            myGrid: 'PM95',
            frequency: 7_074_000,
            transmitPower: 10,
            autoReply: true,
            maxQSOTimeout: 4,
            maxSameTransmissionCount: 30,
            decodeWhileTransmitting: true,
            spectrumWhileTransmitting: false,
          }),
          update: async (patch) => ({
            myCallsign: 'JA1ABC',
            myGrid: 'PM95',
            frequency: 7_074_000,
            transmitPower: 10,
            autoReply: true,
            maxQSOTimeout: 4,
            maxSameTransmissionCount: patch.maxSameTransmissionCount ?? 30,
            decodeWhileTransmitting: true,
            spectrumWhileTransmitting: false,
          }),
        },
      });

      await expect(settings.ft8.get()).resolves.toMatchObject({ myCallsign: 'JA1ABC' });
    });
  });

  describe('createMockOperatorSnapshot', () => {
    it('has reasonable defaults', () => {
      const op = createMockOperatorSnapshot();
      expect(op.isTransmitting).toBe(false);
      expect(op.mode.name).toBe('FT8');
      expect(op.getOtherOperators()).toEqual([]);
    });

    it('supports partial overrides', () => {
      const otherMode = createMockOperatorSnapshot().mode;
      const op = createMockOperatorSnapshot({
        isTransmitting: true,
        callsign: 'K1ABC',
        getOtherOperators: () => [{
          id: 'operator-1',
          callsign: 'N0CALL',
          grid: 'FN20',
          audioFrequencyHz: 1800,
          mode: otherMode,
          isTransmitting: false,
          transmitCycles: [1],
        }],
      });
      expect(op.isTransmitting).toBe(true);
      expect(op.callsign).toBe('K1ABC');
      expect(op.getOtherOperators()).toEqual([expect.objectContaining({
        id: 'operator-1',
        audioFrequencyHz: 1800,
        isTransmitting: false,
      })]);
    });
  });

  describe('createMockOperatorCommandPort', () => {
    it('records declarative commands', async () => {
      const port = createMockOperatorCommandPort();
      await port.submit({ type: 'stop-automation' });
      expect(port._commands).toEqual([{ type: 'stop-automation' }]);
    });
  });

  describe('radio capability mocks', () => {
    it('provides connected radio by default', () => {
      const radio = createMockRadioView();
      expect(radio.isConnected).toBe(true);
      expect(radio.frequency).toBe(14074000);
      expect(radio.mode).toMatchObject({ engineMode: 'digital', mode: 'FT8', radioMode: 'USB' });
      expect(createMockRadioCapabilitiesView().getSnapshot()).toEqual({ descriptors: [], capabilities: [] });
      expect(createMockRadioPowerView().getState()).toMatchObject({ state: 'awake', stage: 'idle' });
    });
  });

  describe('createMockLogbookAccess', () => {
    it('returns false by default for all queries', async () => {
      const logbook = createMockLogbookAccess();
      expect(await logbook.hasWorked('W1AW')).toBe(false);
      expect(await logbook.hasWorkedDXCC('US')).toBe(false);
      expect(await logbook.hasWorkedGrid('FN31')).toBe(false);
    });

    it('accepts custom implementations', async () => {
      const worked = new Set(['W1AW']);
      const logbook = createMockLogbookAccess({
        hasWorked: async (cs) => worked.has(cs),
      });
      expect(await logbook.hasWorked('W1AW')).toBe(true);
      expect(await logbook.hasWorked('K2ABC')).toBe(false);
    });

    it('returns immutable committed records from mutation helpers', async () => {
      const logbook = createMockLogbookAccess();
      const input = {
        id: 'mock-qso',
        callsign: 'JA1ABC',
        frequency: 14_074_000,
        mode: 'FT8',
        startTime: 1,
        messageHistory: ['CQ JA1ABC PM95'],
      };

      const added = await logbook.addQSO(input);
      const updateHistory = ['CQ JA1ABC PM95', 'JA1ABC W1AW -10'];
      const updated = await logbook.updateQSO(input.id, {
        id: 'must-not-replace-target-id',
        notes: 'durable',
        messageHistory: updateHistory,
      });

      expect(added).toEqual(input);
      expect(added).not.toBe(input);
      expect(added.messageHistory).not.toBe(input.messageHistory);
      expect(updated).toMatchObject({ id: input.id, notes: 'durable' });
      expect(updated.messageHistory).toEqual(updateHistory);
      expect(updated.messageHistory).not.toBe(updateHistory);
    });
  });

  describe('createMockBandAccess', () => {
    it('returns empty/null defaults', () => {
      const band = createMockBandAccess();
      expect(band.getActiveCallers()).toEqual([]);
      expect(band.getLatestSlotPack()).toBeNull();
      expect(band.findIdleTransmitFrequency()).toBeNull();
    });
  });

  describe('createMockSlotInfo', () => {
    it('provides FT8 defaults', () => {
      const slot = createMockSlotInfo();
      expect(slot.mode).toBe('FT8');
      expect(slot.id).toBe('slot-0');
    });

    it('accepts overrides', () => {
      const slot = createMockSlotInfo({ id: 'slot-42', cycleNumber: 5 });
      expect(slot.id).toBe('slot-42');
      expect(slot.cycleNumber).toBe(5);
    });
  });

  describe('createMockParsedMessage', () => {
    it('creates a CQ message by default', () => {
      const msg = createMockParsedMessage();
      expect(msg.message.type).toBe('cq');
      expect(msg.rawMessage).toBe('CQ TEST W1AW FN31');
    });

    it('accepts overrides', () => {
      const msg = createMockParsedMessage({
        snr: 5,
        rawMessage: 'CQ DX JA1ABC PM95',
        message: { type: 'cq' as const, senderCallsign: 'JA1ABC', grid: 'PM95' },
      });
      expect(msg.snr).toBe(5);
      expect(msg.rawMessage).toBe('CQ DX JA1ABC PM95');
    });
  });
});
