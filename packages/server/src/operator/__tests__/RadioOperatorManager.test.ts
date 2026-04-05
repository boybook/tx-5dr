import EventEmitter from 'eventemitter3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DigitalRadioEngineEvents, FrameMessage, QSORecord, SlotPack } from '@tx5dr/contracts';
import { MODES } from '@tx5dr/contracts';

import { LogManager } from '../../log/LogManager.js';
import { RadioOperatorManager } from '../RadioOperatorManager.js';

function buildSlotPack(slotId: string, startMs: number, frames: FrameMessage[]): SlotPack {
  return {
    slotId,
    startMs,
    endMs: startMs + MODES.FT8.slotMs,
    frames,
    stats: {
      totalDecodes: 1,
      successfulDecodes: frames.some(frame => frame.snr !== -999) ? 1 : 0,
      totalFramesBeforeDedup: frames.length,
      totalFramesAfterDedup: frames.length,
      lastUpdated: startMs + MODES.FT8.slotMs - 1,
    },
    decodeHistory: [],
  };
}

function createManager(options: {
  logBook: { id: string; name: string; provider: any };
  callsign?: string | null;
  activeSlotPacks?: SlotPack[];
  storedRecords?: Array<{ slotPack: SlotPack }>;
}) {
  const eventEmitter = new EventEmitter<DigitalRadioEngineEvents>();
  const slotPackManager = {
    getActiveSlotPacks: vi.fn(() => options.activeSlotPacks ?? []),
    readStoredRecords: vi.fn(async () => options.storedRecords ?? []),
  };

  const fakeLogManager = {
    getOperatorLogBook: vi.fn().mockResolvedValue(options.logBook),
    getOperatorCallsign: vi.fn().mockReturnValue(options.callsign ?? null),
  };

  vi.spyOn(LogManager, 'getInstance').mockReturnValue(fakeLogManager as any);

  const manager = new RadioOperatorManager({
    eventEmitter,
    encodeQueue: {} as any,
    clockSource: {} as any,
    getCurrentMode: () => MODES.FT8,
    setRadioFrequency: vi.fn(),
    slotPackManager: slotPackManager as any,
  });

  return {
    manager,
    eventEmitter,
    slotPackManager,
    fakeLogManager,
  };
}

async function invokeRecordQSO(manager: RadioOperatorManager, payload: { operatorId: string; qsoRecord: QSORecord }) {
  const handler = (manager as any).eventListeners.get('recordQSO') as ((data: typeof payload) => Promise<void>) | undefined;
  expect(handler).toBeTypeOf('function');
  await handler!(payload);
}

describe('RadioOperatorManager automatic QSO logging', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('merges repeated FT8 auto logs and backfills grid/messages from persisted slot history', async () => {
    const base = Date.parse('2026-04-05T12:00:00.000Z');
    const provider = {
      addQSO: vi.fn(),
      updateQSO: vi.fn(),
      getQSO: vi.fn(),
      getLastQSOWithCallsign: vi.fn(),
      getStatistics: vi.fn().mockResolvedValue({ totalQSOs: 1 }),
    };

    const existingQSO: QSORecord = {
      id: 'existing-1',
      callsign: 'N0CALL',
      frequency: 14_074_000,
      mode: 'FT8',
      startTime: base + MODES.FT8.slotMs,
      endTime: base + MODES.FT8.slotMs * 2,
      reportSent: '-10',
      reportReceived: '-08',
      messages: ['BG5DRB N0CALL -10'],
      myCallsign: 'BG5DRB',
      myGrid: 'PM01AA',
    };

    provider.getLastQSOWithCallsign.mockResolvedValue(existingQSO);
    provider.getQSO.mockImplementation(async (id: string) => {
      if (id !== existingQSO.id) return null;
      const [, updates] = provider.updateQSO.mock.calls[0] as [string, Partial<QSORecord>];
      return { ...existingQSO, ...updates, id: existingQSO.id };
    });

    const storedCqSlot = buildSlotPack(`ft8-${base}`, base, [
      {
        message: 'CQ N0CALL FN42',
        snr: -12,
        dt: 0.1,
        freq: 1200,
        confidence: 0.95,
      },
    ]);

    const activeSlotPacks = [
      buildSlotPack(`ft8-${base + MODES.FT8.slotMs}`, base + MODES.FT8.slotMs, [
        {
          message: 'BG5DRB N0CALL -10',
          snr: -999,
          dt: 0,
          freq: 1100,
          confidence: 1,
          operatorId: 'op1',
        },
      ]),
      buildSlotPack(`ft8-${base + MODES.FT8.slotMs * 2}`, base + MODES.FT8.slotMs * 2, [
        {
          message: 'N0CALL BG5DRB R-08',
          snr: -8,
          dt: 0.2,
          freq: 1250,
          confidence: 0.96,
        },
      ]),
      buildSlotPack(`ft8-${base + MODES.FT8.slotMs * 3}`, base + MODES.FT8.slotMs * 3, [
        {
          message: 'BG5DRB N0CALL RR73',
          snr: -999,
          dt: 0,
          freq: 1100,
          confidence: 1,
          operatorId: 'op1',
        },
      ]),
    ];

    const { manager, eventEmitter } = createManager({
      logBook: { id: 'log-1', name: 'Test Log', provider },
      callsign: 'BG5DRB',
      activeSlotPacks,
      storedRecords: [{ slotPack: storedCqSlot }],
    });

    const updatedSpy = vi.fn();
    const addedSpy = vi.fn();
    eventEmitter.on('qsoRecordUpdated', updatedSpy);
    eventEmitter.on('qsoRecordAdded', addedSpy);

    await invokeRecordQSO(manager, {
      operatorId: 'op1',
      qsoRecord: {
        id: 'temp-1',
        callsign: 'n0call',
        frequency: 14_074_000,
        mode: 'FT8',
        startTime: base + MODES.FT8.slotMs,
        endTime: base + MODES.FT8.slotMs * 3,
        reportSent: '-10',
        reportReceived: '-08',
        messages: [],
        myCallsign: 'BG5DRB',
        myGrid: 'PM01AA',
      },
    });

    expect(provider.addQSO).not.toHaveBeenCalled();
    expect(provider.updateQSO).toHaveBeenCalledTimes(1);

    const [updatedId, updates] = provider.updateQSO.mock.calls[0] as [string, Partial<QSORecord>];
    expect(updatedId).toBe('existing-1');
    expect(updates.grid).toBe('FN42');
    expect(updates.messages).toEqual([
      'CQ N0CALL FN42',
      'BG5DRB N0CALL -10',
      'N0CALL BG5DRB R-08',
      'BG5DRB N0CALL RR73',
    ]);
    expect(updatedSpy).toHaveBeenCalledTimes(1);
    expect(addedSpy).not.toHaveBeenCalled();
    expect(updatedSpy.mock.calls[0]?.[0]?.qsoRecord?.id).toBe('existing-1');
    expect(updatedSpy.mock.calls[0]?.[0]?.qsoRecord?.grid).toBe('FN42');
  });

  it('creates a new record when the latest QSO is outside the merge window', async () => {
    const base = Date.parse('2026-04-05T13:00:00.000Z');
    const provider = {
      addQSO: vi.fn().mockResolvedValue(undefined),
      updateQSO: vi.fn(),
      getQSO: vi.fn(),
      getLastQSOWithCallsign: vi.fn().mockResolvedValue({
        id: 'old-1',
        callsign: 'N0CALL',
        frequency: 14_074_000,
        mode: 'FT8',
        startTime: base - 20 * 60 * 1000,
        endTime: base - 10 * 60 * 1000,
        reportSent: '-12',
        reportReceived: '-09',
        messages: ['old message'],
      }),
      getStatistics: vi.fn().mockResolvedValue({ totalQSOs: 2 }),
    };

    const { manager, eventEmitter } = createManager({
      logBook: { id: 'log-1', name: 'Test Log', provider },
      callsign: null,
      activeSlotPacks: [
        buildSlotPack(`ft8-${base}`, base, [
          {
            message: 'BG5DRB N0CALL -12',
            snr: -999,
            dt: 0,
            freq: 1300,
            confidence: 1,
            operatorId: 'op1',
          },
        ]),
      ],
      storedRecords: [],
    });

    const updatedSpy = vi.fn();
    const addedSpy = vi.fn();
    eventEmitter.on('qsoRecordUpdated', updatedSpy);
    eventEmitter.on('qsoRecordAdded', addedSpy);

    await invokeRecordQSO(manager, {
      operatorId: 'op1',
      qsoRecord: {
        id: 'temp-2',
        callsign: 'N0CALL',
        frequency: 14_074_000,
        mode: 'FT8',
        startTime: base,
        endTime: base + MODES.FT8.slotMs,
        reportSent: '-12',
        reportReceived: '-09',
        messages: [],
        myCallsign: 'BG5DRB',
        myGrid: 'PM01AA',
      },
    });

    expect(provider.updateQSO).not.toHaveBeenCalled();
    expect(provider.addQSO).toHaveBeenCalledTimes(1);
    expect(updatedSpy).not.toHaveBeenCalled();
    expect(addedSpy).toHaveBeenCalledTimes(1);
    expect(provider.addQSO.mock.calls[0]?.[0]?.messages).toEqual(['BG5DRB N0CALL -12']);
  });
});
