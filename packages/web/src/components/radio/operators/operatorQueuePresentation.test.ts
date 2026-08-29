import { describe, expect, it, vi } from 'vitest';
import type { AssistedQueueRow, AssistedQueueSnapshot, OperatorStatus, PluginStatus } from '@tx5dr/contracts';
import {
  buildQueueCallsignOrder,
  getNewQueueEntryIds,
  getQueueBeforeEntryId,
  isTargetQueueStrategy,
  QUEUE_BODY_HEIGHT_PX,
  QUEUE_ROW_HEIGHT_PX,
  QUEUE_VISIBLE_ROW_COUNT,
  resolveOperatorTargetAction,
  shouldRenderOperatorQueue,
  submitOperatorTarget,
} from './operatorQueuePresentation';

function queueRow(overrides: Partial<AssistedQueueRow> = {}): AssistedQueueRow {
  return {
    entryId: 'entry-1',
    callsign: 'JA1AAA',
    order: 0,
    draggable: true,
    displayState: 'TX1',
    tone: 'neutral',
    icon: 'circle',
    ...overrides,
  };
}

function queue(overrides: Partial<AssistedQueueSnapshot> = {}): AssistedQueueSnapshot {
  return {
    version: 1,
    rows: [queueRow()],
    ...overrides,
  };
}

function operator(overrides: Partial<OperatorStatus> = {}): OperatorStatus {
  return {
    id: 'operator-1',
    isActive: true,
    isTransmitting: false,
    context: {
      myCall: 'BG5DRB',
      myGrid: 'PM01',
      targetCall: '',
    },
    strategy: {
      name: 'standard-qso',
      state: 'TX6',
      availableSlots: ['TX1', 'TX2', 'TX3', 'TX4', 'TX5', 'TX6'],
    },
    ...overrides,
  };
}

function queuePlugin(name = 'custom-queue'): PluginStatus {
  return {
    name,
    type: 'strategy',
    strategyFeatures: { targetQueue: 1 },
    version: '1.0.0',
    isBuiltIn: false,
    loaded: true,
    enabled: true,
    autoDisabled: false,
    errorCount: 0,
    permissions: [],
  };
}

describe('operator queue presentation', () => {
  it('recognizes the built-in strategy id and framework targetQueue feature', () => {
    expect(isTargetQueueStrategy(operator({
      strategy: { name: 'assisted-qso-queue', state: 'idle', availableSlots: [] },
    }))).toBe(true);
    expect(isTargetQueueStrategy(operator({
      strategy: { name: 'custom-queue', state: 'idle', availableSlots: [] },
    }), [queuePlugin()])).toBe(true);
    expect(isTargetQueueStrategy(operator())).toBe(false);
  });

  it('shows the compact table only for a queue strategy with a server snapshot', () => {
    const queued = operator({
      strategy: { name: 'assisted-qso-queue', state: 'idle', availableSlots: [] },
      runtime: { currentState: 'idle', queue: queue({ rows: [] }) },
    });
    expect(shouldRenderOperatorQueue(queued)).toBe(true);
    expect(shouldRenderOperatorQueue(operator())).toBe(false);
    expect(shouldRenderOperatorQueue(operator({
      strategy: { name: 'assisted-qso-queue', state: 'idle', availableSlots: [] },
    }))).toBe(false);
  });

  it('keeps exactly three visible row heights before scrolling', () => {
    expect(QUEUE_VISIBLE_ROW_COUNT).toBe(3);
    expect(QUEUE_BODY_HEIGHT_PX).toBe(QUEUE_ROW_HEIGHT_PX * 3);
  });

  it('builds case-insensitive authoritative queue markers in snapshot order', () => {
    const orders = buildQueueCallsignOrder(queue({
      activeEntryId: 'entry-2',
      rows: [
        queueRow({ entryId: 'entry-2', callsign: 'ja2bbb/p', draggable: false }),
        queueRow({ entryId: 'entry-1', callsign: 'JA1AAA' }),
      ],
    }));

    expect(orders).toEqual({ JA2BBB: 1, JA1AAA: 2 });
  });

  it('identifies only entry ids newly added by an authoritative queue snapshot', () => {
    expect(getNewQueueEntryIds(new Set(['entry-1']), [
      queueRow({ entryId: 'entry-1' }),
      queueRow({ entryId: 'entry-2' }),
    ])).toEqual(['entry-2']);
  });

  it('routes double-click target commands by active strategy capability', () => {
    const service = {
      enqueueQueueTarget: vi.fn(),
      sendRequestCall: vi.fn(),
    };
    const selectedFrame = { message: 'CQ JA1AAA PM95', snr: -10, dt: 0.1, freq: 1200, slotStartMs: 15_000 };

    submitOperatorTarget(service, resolveOperatorTargetAction(operator({
      strategy: { name: 'assisted-qso-queue', state: 'idle', availableSlots: [] },
    })), 'operator-1', 'JA1AAA', selectedFrame);
    submitOperatorTarget(service, resolveOperatorTargetAction(operator()), 'operator-1', 'JA2BBB');

    expect(service.enqueueQueueTarget).toHaveBeenCalledWith(
      'operator-1',
      'JA1AAA',
      selectedFrame,
      { startIfIdle: true },
    );
    expect(service.sendRequestCall).toHaveBeenCalledWith('operator-1', 'JA2BBB', undefined);
  });

  it('starts WW Digi when an empty queue receives a double-click target', () => {
    const service = {
      enqueueQueueTarget: vi.fn(),
      sendRequestCall: vi.fn(),
    };
    const wwDigi = queuePlugin('ww-digi');
    wwDigi.strategyFeatures = {
      targetQueue: 1,
      queueActivation: 'immediate',
    };

    submitOperatorTarget(service, resolveOperatorTargetAction(operator({
      strategy: { name: 'ww-digi', state: 'idle', availableSlots: [] },
    }), [wwDigi]), 'operator-1', 'JA1AAA');

    expect(service.enqueueQueueTarget).toHaveBeenCalledWith(
      'operator-1',
      'JA1AAA',
      undefined,
      { startIfIdle: true },
    );
    expect(service.sendRequestCall).not.toHaveBeenCalled();
  });

  it('keeps operator-toggle queue strategies enqueue-only', () => {
    const service = {
      enqueueQueueTarget: vi.fn(),
      sendRequestCall: vi.fn(),
    };
    const plugin = queuePlugin('manual-queue');
    plugin.strategyFeatures = { targetQueue: 1, queueActivation: 'operator-toggle' };

    submitOperatorTarget(service, resolveOperatorTargetAction(operator({
      strategy: { name: 'manual-queue', state: 'idle', availableSlots: [] },
    }), [plugin]), 'operator-1', 'JA1AAA');

    expect(service.enqueueQueueTarget).toHaveBeenCalledWith(
      'operator-1', 'JA1AAA', undefined, { startIfIdle: false },
    );
  });

  it('derives reorder payloads for waiting rows', () => {
    const rows = [
      queueRow({ entryId: 'entry-2' }),
      queueRow({ entryId: 'entry-3' }),
      queueRow({ entryId: 'entry-1' }),
    ];
    expect(getQueueBeforeEntryId(rows, 'entry-2')).toBe('entry-3');
    expect(getQueueBeforeEntryId(rows, 'entry-1')).toBeNull();
    expect(getQueueBeforeEntryId(rows, 'missing')).toBeUndefined();
  });
});
