import EventEmitter from 'eventemitter3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DigitalRadioEngineEvents, FrameMessage, QSORecord, RadioOperatorConfig, SlotInfo, SlotPack } from '@tx5dr/contracts';
import { MODES } from '@tx5dr/contracts';
import { FT8MessageParser } from '@tx5dr/core';
import { ConfigManager } from '../../config/config-manager.js';
import { LogManager } from '../../log/LogManager.js';
import { CallsignContextTracker } from '../../slot/CallsignContextTracker.js';
import { RadioOperatorManager } from '../RadioOperatorManager.js';

// Characterization of QSO completion admission and history reconstruction
// (ft8-lessons QSO-02, QSO-16, QSO-17, QSO-32) and of the multi-signal
// carrier layout check (TX-08). These describe current behavior; they do not
// change it.

const SLOT_MS = MODES.FT8.slotMs;
const THIRTY_MINUTES_MS = 30 * 60 * 1000;

function slotPack(startMs: number, frames: Array<Partial<FrameMessage> & { message: string; snr: number }>): SlotPack {
  return {
    slotId: `ft8-${startMs}`,
    startMs,
    endMs: startMs + SLOT_MS,
    frames: frames.map(frame => ({ dt: 0, freq: 1500, confidence: 1, ...frame })),
    stats: {
      totalDecodes: frames.length,
      successfulDecodes: frames.length,
      totalFramesBeforeDedup: frames.length,
      totalFramesAfterDedup: frames.length,
      lastUpdated: startMs + SLOT_MS - 1,
    },
    decodeHistory: [],
  };
}

function writableProvider(addQSO = vi.fn(async (record: QSORecord) => record)) {
  return {
    addQSO,
    updateQSO: vi.fn(),
    getQSO: vi.fn(async () => null),
    getLastQSOWithCallsign: vi.fn(async () => null),
    getStatistics: vi.fn(async () => ({ totalQSOs: 0 })),
  };
}

type Provider = ReturnType<typeof writableProvider>;

interface Station {
  logBookId: string;
  callsign: string;
}

function createManager(options: {
  books: Record<string, Provider>;
  station: Station;
  activeSlotPacks?: SlotPack[];
  getKnownRadioFrequency?: () => number | null;
  getRadioFrequency?: () => Promise<number | null>;
  callsignTracker?: unknown;
  encodeQueue?: { push: ReturnType<typeof vi.fn> };
  mode?: typeof MODES.FT8;
}) {
  const eventEmitter = new EventEmitter<DigitalRadioEngineEvents>();
  const slotPackManager = {
    getActiveSlotPacks: vi.fn(() => options.activeSlotPacks ?? []),
    readStoredRecords: vi.fn(async () => []),
    getFrequencyContext: vi.fn(() => undefined),
    getRetainedSinceMs: vi.fn(() => 0),
  };
  const books = Object.fromEntries(Object.entries(options.books).map(([id, provider]) => [
    id, { id, name: id, provider },
  ]));
  const bookForCallsign = (callsign: string) => Object.values(books)
    .find(book => book.id === `log-${callsign}`) ?? null;
  const fakeLogManager = {
    initialize: vi.fn().mockResolvedValue(undefined),
    // Station settings are read live; the test mutates `options.station`.
    getOperatorLogBookId: vi.fn(() => options.station.logBookId),
    getOperatorCallsign: vi.fn(() => options.station.callsign),
    getOperatorLogBook: vi.fn(async () => books[options.station.logBookId] ?? null),
    getLogBook: vi.fn((id: string) => books[id] ?? null),
    getOrCreateLogBookByCallsign: vi.fn(async (callsign: string) => bookForCallsign(callsign)),
    getPluginSessionLogBook: vi.fn(() => null),
    getPluginSessionLogBookByKey: vi.fn(() => null),
    prewarmLogBookByCallsign: vi.fn(),
    registerOperatorCallsign: vi.fn(),
    unregisterOperatorCallsign: vi.fn(),
    connectOperatorToLogBook: vi.fn().mockResolvedValue(undefined),
    disconnectOperatorFromLogBook: vi.fn(),
    setApplicationEventSink: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
  vi.spyOn(LogManager, 'getInstance').mockReturnValue(fakeLogManager as any);

  const manager = new RadioOperatorManager({
    eventEmitter,
    encodeQueue: (options.encodeQueue ?? { push: vi.fn() }) as any,
    clockSource: { now: vi.fn(() => 0) } as any,
    getCurrentMode: () => options.mode ?? MODES.FT8,
    setRadioFrequency: vi.fn(),
    slotPackManager: slotPackManager as any,
    getRadioFrequency: options.getRadioFrequency,
    getKnownRadioFrequency: options.getKnownRadioFrequency,
    callsignTracker: options.callsignTracker as any,
  });
  manager.setPluginManager({
    notifyQSOComplete: vi.fn().mockResolvedValue(undefined),
    notifyPluginSessionQSOComplete: vi.fn().mockResolvedValue(undefined),
    getOperatorRuntimeStatus: vi.fn(() => undefined),
    resetOperatorPluginRuntime: vi.fn(),
    interruptOperatorTransmission: vi.fn().mockResolvedValue(undefined),
    logbookSyncHost: { onQSOComplete: vi.fn() },
    isRunning: vi.fn(() => false),
  } as any);
  return { manager, slotPackManager, eventEmitter };
}

type RecordQsoPayload = {
  operatorId: string;
  startedAt?: number;
  qsoLifecycleEpoch?: number;
  qsoRecord: QSORecord;
  resolve?: (record: QSORecord) => void;
  reject?: (error: unknown) => void;
};

function recordQSO(manager: RadioOperatorManager, payload: RecordQsoPayload): Promise<void> {
  const handler = (manager as any).eventListeners.get('recordQSO') as (data: RecordQsoPayload) => Promise<void>;
  return handler(payload);
}

function strategyRecord(overrides: Partial<QSORecord> = {}): QSORecord {
  const at = Date.parse('2026-07-23T09:00:00.000Z');
  return {
    id: 'qso-1',
    callsign: 'JA1AAA',
    frequency: 14_074_000,
    mode: 'FT8',
    startTime: at,
    endTime: at,
    reportSent: '-10',
    reportReceived: '-12',
    messageHistory: [],
    ...overrides,
  };
}

const trackers: CallsignContextTracker[] = [];
function createTracker(): CallsignContextTracker {
  const tracker = new CallsignContextTracker();
  trackers.push(tracker);
  return tracker;
}

afterEach(() => {
  for (const tracker of trackers.splice(0)) tracker.dispose();
  vi.restoreAllMocks();
});

describe('QSO-02 message history lookback cap', () => {
  it('rebuilds at most 30 minutes plus one slot before completion when the attempt started earlier', async () => {
    const completionAt = Date.parse('2026-07-23T12:00:00.000Z');
    const capStart = completionAt - THIRTY_MINUTES_MS - SLOT_MS;
    const provider = writableProvider();
    const { manager, slotPackManager } = createManager({
      books: { 'log-BG5JKZ': provider },
      station: { logBookId: 'log-BG5JKZ', callsign: 'BG5JKZ' },
      activeSlotPacks: [
        // Ends before the capped window: dropped even though the attempt began earlier.
        slotPack(capStart - 2 * SLOT_MS, [{ message: 'BG5JKZ VE6TL DO21', snr: -15 }]),
        // The one extra slot before the 30-minute bound is still included.
        slotPack(capStart, [{ message: 'CQ VE6TL DO21', snr: -12 }]),
        slotPack(completionAt - SLOT_MS, [{ message: 'BG5JKZ VE6TL R-12', snr: -14 }]),
      ],
    });

    await recordQSO(manager, {
      operatorId: 'op1',
      startedAt: completionAt - 2 * 60 * 60 * 1000,
      qsoRecord: strategyRecord({
        callsign: 'VE6TL', myCallsign: 'BG5JKZ', startTime: completionAt, endTime: completionAt,
      }),
    });

    expect(slotPackManager.getActiveSlotPacks).toHaveBeenCalledWith(capStart, completionAt);
    expect(provider.addQSO.mock.calls[0]?.[0]?.messageHistory).toEqual([
      'CQ VE6TL DO21',
      'BG5JKZ VE6TL R-12',
    ]);
  });
});

describe('QSO-16 admission freezes the destination and Host observations', () => {
  it('writes a re-delivered in-flight completion to the original logbook after station settings change', async () => {
    let releaseWrite!: () => void;
    const originalBook = writableProvider(vi.fn(async (record: QSORecord) => {
      await new Promise<void>(resolve => { releaseWrite = resolve; });
      return record;
    }));
    const otherBook = writableProvider();
    const station = { logBookId: 'log-BG5DRB', callsign: 'BG5DRB' };
    let knownRf = 14_074_000;
    const tracker = createTracker();
    tracker.updateFromParsedMessage(FT8MessageParser.parseMessage('CQ JA1AAA PM95'));
    const { manager } = createManager({
      books: { 'log-BG5DRB': originalBook, 'log-BG5NEW': otherBook },
      station,
      getKnownRadioFrequency: () => knownRf,
      callsignTracker: tracker,
    });
    const first = vi.fn();
    const second = vi.fn();
    const secondRejected = vi.fn();
    const payload = {
      operatorId: 'op1',
      qsoLifecycleEpoch: 3,
      // Audio offset, no grid, no station callsign: all filled at admission.
      qsoRecord: strategyRecord({ frequency: 1500, grid: undefined, myCallsign: undefined }),
    };

    const firstDelivery = recordQSO(manager, { ...payload, resolve: first });
    await vi.waitFor(() => expect(originalBook.addQSO).toHaveBeenCalledOnce());

    station.logBookId = 'log-BG5NEW';
    station.callsign = 'BG5NEW';
    knownRf = 7_074_000;
    tracker.updateFromParsedMessage(FT8MessageParser.parseMessage('CQ JA1AAA QM05'));
    const secondDelivery = recordQSO(manager, { ...payload, resolve: second, reject: secondRejected });
    releaseWrite();
    await Promise.all([firstDelivery, secondDelivery]);

    expect(originalBook.addQSO).toHaveBeenCalledOnce();
    expect(otherBook.addQSO).not.toHaveBeenCalled();
    expect(secondRejected).not.toHaveBeenCalled();
    const written = originalBook.addQSO.mock.calls[0]![0];
    expect(written).toMatchObject({ frequency: 14_075_500, grid: 'PM95', myCallsign: 'BG5DRB' });
    expect(first).toHaveBeenCalledWith(written);
    expect(second).toHaveBeenCalledWith(written);
  });

  it('retries a failed completion into its original logbook with the admission-time data', async () => {
    const originalBook = writableProvider(vi.fn()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockImplementation(async (record: QSORecord) => record));
    const otherBook = writableProvider();
    const station = { logBookId: 'log-BG5DRB', callsign: 'BG5DRB' };
    let knownRf = 14_074_000;
    const { manager } = createManager({
      books: { 'log-BG5DRB': originalBook, 'log-BG5NEW': otherBook },
      station,
      getKnownRadioFrequency: () => knownRf,
    });
    const payload = {
      operatorId: 'op1',
      qsoLifecycleEpoch: 4,
      qsoRecord: strategyRecord({ frequency: 1500, myCallsign: undefined }),
    };

    await recordQSO(manager, { ...payload, reject: vi.fn() });
    expect(manager.listUnsavedQsos('log-BG5DRB')).toHaveLength(1);

    station.logBookId = 'log-BG5NEW';
    station.callsign = 'BG5NEW';
    knownRf = 7_074_000;
    const redeliveryRejected = vi.fn();
    await recordQSO(manager, { ...payload, reject: redeliveryRejected });

    // Re-delivery neither rebinds nor writes; it reports the retained failure.
    expect(redeliveryRejected).toHaveBeenCalledOnce();
    expect(originalBook.addQSO).toHaveBeenCalledOnce();
    expect(manager.listUnsavedQsos('log-BG5NEW')).toEqual([]);

    const attempt = manager.listUnsavedQsos('log-BG5DRB')[0]!;
    await manager.retryUnsavedQso('log-BG5DRB', attempt.attemptId);

    expect(otherBook.addQSO).not.toHaveBeenCalled();
    expect(originalBook.addQSO).toHaveBeenCalledTimes(2);
    expect(originalBook.addQSO.mock.calls[1]![0]).toMatchObject({
      frequency: 14_075_500,
      myCallsign: 'BG5DRB',
    });
  });
});

describe('QSO-17 audio-offset frequency synthesis', () => {
  async function writtenFrequency(options: {
    recordFrequency: number;
    knownRf: number | null;
    lastSelected?: number;
  }) {
    if (options.lastSelected !== undefined) {
      vi.spyOn(ConfigManager, 'getInstance').mockReturnValue({
        getLastSelectedFrequency: () => ({ frequency: options.lastSelected }),
      } as any);
    }
    const provider = writableProvider();
    const getRadioFrequency = vi.fn(async () => 50_313_000);
    const { manager } = createManager({
      books: { 'log-BG5DRB': provider },
      station: { logBookId: 'log-BG5DRB', callsign: 'BG5DRB' },
      getKnownRadioFrequency: () => options.knownRf,
      getRadioFrequency,
    });
    await recordQSO(manager, {
      operatorId: 'op1',
      qsoRecord: strategyRecord({ frequency: options.recordFrequency, myCallsign: 'BG5DRB' }),
    });
    // The live radio is never queried on the completion path.
    expect(getRadioFrequency).not.toHaveBeenCalled();
    return provider.addQSO.mock.calls[0]![0].frequency;
  }

  it('adds an audio offset to the RF known at admission', async () => {
    await expect(writtenFrequency({ recordFrequency: 1500, knownRf: 14_074_000 })).resolves.toBe(14_075_500);
  });

  it('falls back to the last selected frequency when no RF is known', async () => {
    await expect(writtenFrequency({
      recordFrequency: 1500, knownRf: null, lastSelected: 7_074_000,
    })).resolves.toBe(7_075_500);
  });

  it('keeps a frequency that is already a full RF value', async () => {
    await expect(writtenFrequency({ recordFrequency: 14_074_000, knownRf: 7_074_000 })).resolves.toBe(14_074_000);
  });
});

describe('QSO-32 callsign-context enrichment', () => {
  it('fills a missing grid and reports from the callsign context frozen at admission', async () => {
    const tracker = createTracker();
    tracker.updateFromSlotPack(slotPack(Date.now(), [
      { message: 'CQ JA1AAA PM95', snr: -9 },
      // Our own TX echo carries the report we sent.
      { message: 'JA1AAA BG5DRB -07', snr: -999 },
      { message: 'BG5DRB JA1AAA R-11', snr: -12 },
    ]), message => FT8MessageParser.parseMessage(message));
    const provider = writableProvider();
    const { manager } = createManager({
      books: { 'log-BG5DRB': provider },
      station: { logBookId: 'log-BG5DRB', callsign: 'BG5DRB' },
      getKnownRadioFrequency: () => 14_074_000,
      callsignTracker: tracker,
    });

    const delivery = recordQSO(manager, {
      operatorId: 'op1',
      qsoRecord: strategyRecord({
        myCallsign: 'BG5DRB', grid: undefined, reportSent: undefined, reportReceived: undefined,
      }),
    });
    // Context observed after admission must not reach the record.
    tracker.updateFromSlotPack(slotPack(Date.now() + SLOT_MS, [
      { message: 'CQ JA1AAA QM05', snr: -3 },
      { message: 'JA1AAA BG5DRB +03', snr: -999 },
      { message: 'BG5DRB JA1AAA R+01', snr: -4 },
    ]), message => FT8MessageParser.parseMessage(message));
    await delivery;

    expect(provider.addQSO.mock.calls[0]![0]).toMatchObject({
      grid: 'PM95',
      reportSent: '-7',
      reportReceived: '-11',
    });
  });

  it('keeps strategy-provided grid and reports over the callsign context', async () => {
    const tracker = createTracker();
    tracker.updateFromSlotPack(slotPack(Date.now(), [
      { message: 'CQ JA1AAA PM95', snr: -9 },
      { message: 'BG5DRB JA1AAA R-11', snr: -12 },
    ]), message => FT8MessageParser.parseMessage(message));
    const provider = writableProvider();
    const { manager } = createManager({
      books: { 'log-BG5DRB': provider },
      station: { logBookId: 'log-BG5DRB', callsign: 'BG5DRB' },
      getKnownRadioFrequency: () => 14_074_000,
      callsignTracker: tracker,
    });

    await recordQSO(manager, {
      operatorId: 'op1',
      qsoRecord: strategyRecord({ myCallsign: 'BG5DRB', grid: 'QM05', reportSent: '0', reportReceived: '-3' }),
    });

    expect(provider.addQSO.mock.calls[0]![0]).toMatchObject({
      grid: 'QM05',
      reportSent: '0',
      reportReceived: '-3',
    });
  });
});

describe('TX-08 multi-signal audio carrier layout', () => {
  type Carrier = { operatorId: string; streamId: string; transmission: string; audioFrequencyHz: number };

  async function transmitFrame(options: {
    mode?: typeof MODES.FT8;
    operatorFrequencies: Record<string, number>;
    batches?: Record<string, Array<Omit<Carrier, 'operatorId'>>>;
    singles?: Record<string, string>;
  }) {
    const mode = options.mode ?? MODES.FT8;
    vi.spyOn(ConfigManager, 'getInstance').mockReturnValue({
      updateOperatorConfig: vi.fn().mockResolvedValue(undefined),
      getOperatorConfig: vi.fn(() => undefined),
      getFT8Config: () => ({ maxSameTransmissionCount: 20 }),
    } as any);
    const encodeQueue = { push: vi.fn() };
    const { manager, eventEmitter } = createManager({
      books: {},
      station: { logBookId: 'log-BG5DRB', callsign: 'BG5DRB' },
      encodeQueue,
      mode,
    });
    const textMessages: Array<{ key?: string; params?: Record<string, string> }> = [];
    eventEmitter.on('textMessage', message => textMessages.push(message as any));
    for (const [id, frequency] of Object.entries(options.operatorFrequencies)) {
      await manager.addOperator({
        id, myCallsign: 'BG5DRB', myGrid: 'PL09', frequency, transmitCycles: [0], mode,
      } as RadioOperatorConfig);
      manager.getOperatorById(id)!.start();
    }
    manager.start();

    for (const [operatorId, transmissions] of Object.entries(options.batches ?? {})) {
      eventEmitter.emit('requestTransmitBatch', { operatorId, transmissions } as any);
    }
    for (const [operatorId, transmission] of Object.entries(options.singles ?? {})) {
      eventEmitter.emit('requestTransmit', { operatorId, transmission } as any);
    }
    manager.processPendingTransmissions({
      id: 'slot-0', startMs: 0, utcSeconds: 0, phaseMs: 0, driftMs: 0, cycleNumber: 0, mode: mode.name,
    } as SlotInfo);

    const encoded = encodeQueue.push.mock.calls.map(([request]) => `${request.operatorId}@${request.frequency}`);
    return { encoded, conflicts: textMessages.filter(message => message.key === 'multiSignalFrequencyConflict') };
  }

  const pair = (a: number, b: number) => [
    { streamId: 'a', transmission: 'CQ BG5DRB PL09', audioFrequencyHz: a },
    { streamId: 'b', transmission: 'JA1AAA BG5DRB -10', audioFrequencyHz: b },
  ];

  it('requires FT8 carriers at least 60 Hz apart', async () => {
    const accepted = await transmitFrame({ operatorFrequencies: { op1: 1500 }, batches: { op1: pair(1500, 1560) } });
    expect(accepted.encoded).toEqual(['op1@1500', 'op1@1560']);
    expect(accepted.conflicts).toEqual([]);

    vi.restoreAllMocks();
    const rejected = await transmitFrame({ operatorFrequencies: { op1: 1500 }, batches: { op1: pair(1500, 1559) } });
    expect(rejected.encoded).toEqual([]);
    expect(rejected.conflicts).toEqual([expect.objectContaining({ params: { minimumSpacingHz: '60' } })]);
  });

  it('requires FT4 carriers at least 100 Hz apart', async () => {
    const accepted = await transmitFrame({
      mode: MODES.FT4, operatorFrequencies: { op1: 1500 }, batches: { op1: pair(1500, 1600) },
    });
    expect(accepted.encoded).toEqual(['op1@1500', 'op1@1600']);

    vi.restoreAllMocks();
    const rejected = await transmitFrame({
      mode: MODES.FT4, operatorFrequencies: { op1: 1500 }, batches: { op1: pair(1500, 1599) },
    });
    expect(rejected.encoded).toEqual([]);
    expect(rejected.conflicts).toEqual([expect.objectContaining({ params: { minimumSpacingHz: '100' } })]);
  });

  it('keeps every carrier of a multi-signal frame between 100 and 5000 Hz', async () => {
    const edges = await transmitFrame({ operatorFrequencies: { op1: 1500 }, batches: { op1: pair(100, 5000) } });
    expect(edges.encoded).toEqual(['op1@100', 'op1@5000']);

    vi.restoreAllMocks();
    const tooLow = await transmitFrame({ operatorFrequencies: { op1: 1500 }, batches: { op1: pair(99, 1500) } });
    expect(tooLow.encoded).toEqual([]);
    expect(tooLow.conflicts).toHaveLength(1);

    vi.restoreAllMocks();
    const tooHigh = await transmitFrame({ operatorFrequencies: { op1: 1500 }, batches: { op1: pair(1500, 5001) } });
    expect(tooHigh.encoded).toEqual([]);
    expect(tooHigh.conflicts).toHaveLength(1);
  });

  it('drops only the operator whose own set is unsafe', async () => {
    const result = await transmitFrame({
      operatorFrequencies: { op1: 1500, op2: 2500 },
      batches: { op1: pair(1500, 1520) },
      singles: { op2: 'CQ BG5DRB PL09' },
    });

    expect(result.encoded).toEqual(['op2@2500']);
    expect(result.conflicts).toHaveLength(1);
  });

  it('rejects the whole frame when carriers from different operators collide', async () => {
    // A single transmission without an explicit carrier uses the operator's configured frequency.
    const result = await transmitFrame({
      operatorFrequencies: { op1: 1500, op2: 1530 },
      singles: { op1: 'CQ BG5DRB PL09', op2: 'JA1AAA BG5DRB -10' },
    });

    expect(result.encoded).toEqual([]);
    expect(result.conflicts).toHaveLength(1);
  });

  it('does not check the layout of a single carrier', async () => {
    const result = await transmitFrame({ operatorFrequencies: { op1: 6000 }, singles: { op1: 'CQ BG5DRB PL09' } });

    expect(result.encoded).toEqual(['op1@6000']);
    expect(result.conflicts).toEqual([]);
  });
});
