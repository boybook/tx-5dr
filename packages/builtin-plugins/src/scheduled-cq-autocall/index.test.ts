import { describe, expect, it } from 'vitest';
import { createMockContext } from '@tx5dr/plugin-api/testing';
import { scheduledCqAutocallTestables } from './index.js';

describe('scheduled-cq-autocall', () => {
  it('finds a due schedule key for a matching local minute', () => {
    const ctx = createMockContext({
      config: {
        scheduledCqTasks: [{ id: 'morning', enabled: true, days: 'thu', time: '08:30' }],
      },
    });
    expect(scheduledCqAutocallTestables.getDueScheduleKey(ctx, new Date(2026, 0, 1, 8, 30))).toContain('morning');
  });

  it('starts transmitting once per matching schedule minute', () => {
    const starts: string[] = [];
    const ctx = createMockContext({
      config: {
        scheduledCqEnabled: true,
        scheduledCqTasks: [{ id: 'morning', enabled: true, days: 'thu', time: '08:30' }],
      },
      operator: {
        automation: { currentState: 'TX6', slots: {}, context: {} } as any,
        startTransmitting: () => starts.push('start'),
      },
    });
    const now = new Date(2026, 0, 1, 8, 30);
    scheduledCqAutocallTestables.runScheduledCqCheck(ctx, now);
    scheduledCqAutocallTestables.runScheduledCqCheck(ctx, now);
    expect(starts).toEqual(['start']);
  });

  it('uses only the current band schedule when per-band mode is enabled', () => {
    const starts: string[] = [];
    const ctx = createMockContext({
      config: {
        scheduledCqEnabled: true,
        scheduledCqPerBandEnabled: true,
        scheduledCqTasks: [{ id: 'common', enabled: true, days: 'thu', time: '08:30' }],
        scheduledCqBandTasks: {
          '20m': [{ id: 'twenty', enabled: true, days: 'thu', time: '08:30' }],
          '40m': [{ id: 'forty', enabled: true, days: 'thu', time: '08:45' }],
        },
      },
      radio: { band: '20m' },
      operator: {
        automation: { currentState: 'TX6', slots: {}, context: {} } as any,
        startTransmitting: () => starts.push('start'),
      },
    });

    expect(scheduledCqAutocallTestables.getDueScheduleKey(ctx, new Date(2026, 0, 1, 8, 30))).toContain('band:20m');
    scheduledCqAutocallTestables.runScheduledCqCheck(ctx, new Date(2026, 0, 1, 8, 30));

    expect(starts).toEqual(['start']);
  });

  it('does not inherit common schedules for an empty band in per-band mode', () => {
    const starts: string[] = [];
    const ctx = createMockContext({
      config: {
        scheduledCqEnabled: true,
        scheduledCqPerBandEnabled: true,
        scheduledCqTasks: [{ id: 'common', enabled: true, days: 'thu', time: '08:30' }],
        scheduledCqBandTasks: {
          '40m': [{ id: 'forty', enabled: true, days: 'thu', time: '08:30' }],
        },
      },
      radio: { band: '20m' },
      operator: {
        automation: { currentState: 'TX6', slots: {}, context: {} } as any,
        startTransmitting: () => starts.push('start'),
      },
    });

    scheduledCqAutocallTestables.runScheduledCqCheck(ctx, new Date(2026, 0, 1, 8, 30));

    expect(starts).toEqual([]);
  });

  it('starts transmitting at a fixed interval after the first full interval elapses', () => {
    const starts: string[] = [];
    const ctx = createMockContext({
      config: {
        scheduledCqEnabled: true,
        scheduledCqIntervalEnabled: true,
        scheduledCqIntervalMinutes: 10,
      },
      operator: {
        automation: { currentState: 'TX6', slots: {}, context: {} } as any,
        startTransmitting: () => starts.push('start'),
      },
    });

    scheduledCqAutocallTestables.runScheduledCqCheck(ctx, new Date(2026, 0, 1, 8, 0));
    scheduledCqAutocallTestables.runScheduledCqCheck(ctx, new Date(2026, 0, 1, 8, 9));
    scheduledCqAutocallTestables.runScheduledCqCheck(ctx, new Date(2026, 0, 1, 8, 10));
    scheduledCqAutocallTestables.runScheduledCqCheck(ctx, new Date(2026, 0, 1, 8, 10, 15));

    expect(starts).toEqual(['start']);
  });

  it('keeps per-band interval baselines isolated', () => {
    const starts: string[] = [];
    let currentBand = '20m';
    const ctx = createMockContext({
      config: {
        scheduledCqEnabled: true,
        scheduledCqPerBandEnabled: true,
        scheduledCqIntervalEnabled: true,
        scheduledCqIntervalMinutes: 1,
        scheduledCqBandIntervalSettings: {
          '20m': { enabled: true, intervalMinutes: 10 },
          '40m': { enabled: true, intervalMinutes: 5 },
        },
      },
      radio: { band: currentBand },
      operator: {
        automation: { currentState: 'TX6', slots: {}, context: {} } as any,
        startTransmitting: () => starts.push(`${currentBand}:start`),
      },
    });

    scheduledCqAutocallTestables.runScheduledCqCheck(ctx, new Date(2026, 0, 1, 8, 0));
    scheduledCqAutocallTestables.runScheduledCqCheck(ctx, new Date(2026, 0, 1, 8, 10));
    currentBand = '40m';
    (ctx.radio as any).band = currentBand;
    scheduledCqAutocallTestables.runScheduledCqCheck(ctx, new Date(2026, 0, 1, 8, 10));
    scheduledCqAutocallTestables.runScheduledCqCheck(ctx, new Date(2026, 0, 1, 8, 15));

    expect(starts).toEqual(['20m:start', '40m:start']);
  });

  it('skips per-band CQ when the current band is unknown', () => {
    const starts: string[] = [];
    const ctx = createMockContext({
      config: {
        scheduledCqEnabled: true,
        scheduledCqPerBandEnabled: true,
        scheduledCqBandTasks: {
          '20m': [{ id: 'twenty', enabled: true, days: 'thu', time: '08:30' }],
        },
        scheduledCqBandIntervalSettings: {
          '20m': { enabled: true, intervalMinutes: 10 },
        },
      },
      radio: { band: 'unknown' },
      operator: {
        automation: { currentState: 'TX6', slots: {}, context: {} } as any,
        startTransmitting: () => starts.push('start'),
      },
    });

    scheduledCqAutocallTestables.runScheduledCqCheck(ctx, new Date(2026, 0, 1, 8, 30));
    scheduledCqAutocallTestables.runScheduledCqCheck(ctx, new Date(2026, 0, 1, 8, 40));

    expect(starts).toEqual([]);
  });

  it('supports fixed time and interval CQ together without double-starting at the same moment', () => {
    const starts: string[] = [];
    const ctx = createMockContext({
      config: {
        scheduledCqEnabled: true,
        scheduledCqTasks: [{ id: 'morning', enabled: true, days: 'thu', time: '08:30' }],
        scheduledCqIntervalEnabled: true,
        scheduledCqIntervalMinutes: 10,
      },
      operator: {
        automation: { currentState: 'TX6', slots: {}, context: {} } as any,
        startTransmitting: () => starts.push('start'),
      },
    });

    scheduledCqAutocallTestables.runScheduledCqCheck(ctx, new Date(2026, 0, 1, 8, 20));
    scheduledCqAutocallTestables.runScheduledCqCheck(ctx, new Date(2026, 0, 1, 8, 30));
    scheduledCqAutocallTestables.runScheduledCqCheck(ctx, new Date(2026, 0, 1, 8, 30, 15));
    scheduledCqAutocallTestables.runScheduledCqCheck(ctx, new Date(2026, 0, 1, 8, 40));

    expect(starts).toEqual(['start', 'start']);
  });

  it('skips when the operator is not in pure standby', () => {
    const starts: string[] = [];
    const ctx = createMockContext({
      config: {
        scheduledCqEnabled: true,
        scheduledCqTasks: [{ id: 'morning', enabled: true, days: 'thu', time: '08:30' }],
      },
      operator: {
        isTransmitting: true,
        startTransmitting: () => starts.push('start'),
      },
    });
    scheduledCqAutocallTestables.runScheduledCqCheck(ctx, new Date(2026, 0, 1, 8, 30));
    expect(starts).toEqual([]);
  });

  it('skips interval CQ when the operator is not in pure standby', () => {
    const starts: string[] = [];
    const ctx = createMockContext({
      config: {
        scheduledCqEnabled: true,
        scheduledCqIntervalEnabled: true,
        scheduledCqIntervalMinutes: 10,
      },
      operator: {
        isTransmitting: true,
        startTransmitting: () => starts.push('start'),
      },
    });

    scheduledCqAutocallTestables.runScheduledCqCheck(ctx, new Date(2026, 0, 1, 8, 0));
    scheduledCqAutocallTestables.runScheduledCqCheck(ctx, new Date(2026, 0, 1, 8, 10));
    scheduledCqAutocallTestables.runScheduledCqCheck(ctx, new Date(2026, 0, 1, 8, 10, 15));

    expect(starts).toEqual([]);
  });

  it('reports auto-call enabled state from scheduled CQ master switch', () => {
    expect(scheduledCqAutocallTestables.isScheduledCqAutoCallEnabled(createMockContext({
      config: { scheduledCqEnabled: true },
    }))).toBe(true);
    expect(scheduledCqAutocallTestables.isScheduledCqAutoCallEnabled(createMockContext({
      config: { scheduledCqEnabled: false },
    }))).toBe(false);
  });
});
