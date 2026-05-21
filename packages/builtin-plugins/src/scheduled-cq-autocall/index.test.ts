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
});
