import { describe, it, expect } from 'vitest';
import {
  createMockKVStore,
  createMockLogger,
  createMockTimers,
  createMockUIBridge,
  createMockContext,
  createMockSlotInfo,
  createMockParsedMessage,
  createMockOperatorControl,
  createMockRadioControl,
  createMockLogbookAccess,
  createMockBandAccess,
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
  });

  describe('createMockContext', () => {
    it('creates a full context with defaults', () => {
      const ctx = createMockContext();
      expect(ctx.operator.callsign).toBe('W1AW');
      expect(ctx.operator.grid).toBe('FN31');
      expect(ctx.radio.isConnected).toBe(true);
      expect(ctx.config).toEqual({});
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

    it('provides typed access to sub-mocks', () => {
      const ctx = createMockContext();
      ctx.store.global.set('k', 'v');
      expect(ctx.store.global._data.get('k')).toBe('v');

      ctx.log.info('test');
      expect(ctx.log._calls).toHaveLength(1);
    });
  });

  describe('createMockOperatorControl', () => {
    it('has reasonable defaults', () => {
      const op = createMockOperatorControl();
      expect(op.isTransmitting).toBe(false);
      expect(op.mode.name).toBe('FT8');
    });

    it('supports partial overrides', () => {
      const op = createMockOperatorControl({ isTransmitting: true, callsign: 'K1ABC' });
      expect(op.isTransmitting).toBe(true);
      expect(op.callsign).toBe('K1ABC');
    });
  });

  describe('createMockRadioControl', () => {
    it('provides connected radio by default', () => {
      const radio = createMockRadioControl();
      expect(radio.isConnected).toBe(true);
      expect(radio.frequency).toBe(14074000);
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
