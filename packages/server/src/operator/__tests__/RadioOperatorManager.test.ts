import EventEmitter from 'eventemitter3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { DigitalRadioEngineEvents, FrameMessage, QSORecord, RadioOperatorConfig, SlotInfo, SlotPack } from '@tx5dr/contracts';
import { FT8MessageType, MODES } from '@tx5dr/contracts';

import { FT8MessageParser } from '@tx5dr/core';
import { ConfigManager } from '../../config/config-manager.js';
import { LogManager } from '../../log/LogManager.js';
import { PluginManager } from '../../plugin/PluginManager.js';
import { RadioOperatorManager } from '../RadioOperatorManager.js';

function buildSlotPack(slotId: string, startMs: number, frames: FrameMessage[]): SlotPack {
  return {
    slotId,
    startMs,
    endMs: startMs + MODES.FT8.slotMs,
    frames,
    stats: {
      totalDecodes: frames.length,
      successfulDecodes: frames.some(frame => frame.snr !== -999) ? 1 : 0,
      totalFramesBeforeDedup: frames.length,
      totalFramesAfterDedup: frames.length,
      lastUpdated: startMs + MODES.FT8.slotMs - 1,
    },
    decodeHistory: [],
  };
}

function createSlotInfo(startMs: number): SlotInfo {
  return {
    id: `slot-${startMs}`,
    startMs,
    utcSeconds: Math.floor(startMs / 1000),
    phaseMs: 0,
    driftMs: 0,
    cycleNumber: Math.floor(startMs / MODES.FT8.slotMs) % 2,
    mode: 'FT8',
  };
}

function createManager(options: {
  logBook: { id: string; name: string; provider: any };
  callsign?: string | null;
  activeSlotPacks?: SlotPack[];
  storedRecords?: Array<{ slotPack: SlotPack }>;
  clockNow?: number;
  encodeQueue?: { push: ReturnType<typeof vi.fn> };
  getRadioFrequency?: () => Promise<number | null>;
  getKnownRadioFrequency?: () => number | null;
  callsignTracker?: { getGrid: (callsign: string) => string | undefined };
  getFakeFrequencyEnabled?: () => boolean;
}) {
  const eventEmitter = new EventEmitter<DigitalRadioEngineEvents>();
  const slotPackManager = {
    getActiveSlotPacks: vi.fn(() => options.activeSlotPacks ?? []),
    readStoredRecords: vi.fn(async () => options.storedRecords ?? []),
    getFrequencyContext: vi.fn(() => undefined),
  };
  const encodeQueue = options.encodeQueue ?? { push: vi.fn() };
  const clockSource = {
    now: vi.fn(() => options.clockNow ?? 0),
  };

  const fakeLogManager = {
    initialize: vi.fn().mockResolvedValue(undefined),
    getOperatorLogBook: vi.fn().mockResolvedValue(options.logBook),
    getOperatorCallsign: vi.fn().mockReturnValue(options.callsign ?? null),
    getOrCreateLogBookByCallsign: vi.fn().mockResolvedValue(options.logBook),
    prewarmLogBookByCallsign: vi.fn(),
    registerOperatorCallsign: vi.fn(),
    connectOperatorToLogBook: vi.fn().mockResolvedValue(undefined),
    disconnectOperatorFromLogBook: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };

  vi.spyOn(LogManager, 'getInstance').mockReturnValue(fakeLogManager as any);

  const manager = new RadioOperatorManager({
    eventEmitter,
    encodeQueue: encodeQueue as any,
    clockSource: clockSource as any,
    getCurrentMode: () => MODES.FT8,
    setRadioFrequency: vi.fn(),
    slotPackManager: slotPackManager as any,
    getRadioFrequency: options.getRadioFrequency,
    getKnownRadioFrequency: options.getKnownRadioFrequency,
    callsignTracker: options.callsignTracker as any,
    getFakeFrequencyEnabled: options.getFakeFrequencyEnabled,
  });

  return {
    manager,
    eventEmitter,
    slotPackManager,
    clockSource,
    encodeQueue,
    fakeLogManager,
  };
}

async function invokeRecordQSO(manager: RadioOperatorManager, payload: { operatorId: string; qsoRecord: QSORecord }) {
  const handler = (manager as any).eventListeners.get('recordQSO') as ((data: typeof payload) => Promise<void>) | undefined;
  expect(handler).toBeTypeOf('function');
  await handler!(payload);
}

function attachQSOHookSpy(manager: RadioOperatorManager) {
  const notifyQSOComplete = vi.fn().mockResolvedValue(undefined);
  const autoSync = vi.fn();
  manager.setPluginManager({
    notifyQSOComplete,
    logbookSyncHost: {
      onQSOComplete: autoSync,
    },
  } as any);
  return { notifyQSOComplete, autoSync };
}

function mockMaxSameTransmissionCount(limit: number) {
  return vi.spyOn(ConfigManager, 'getInstance').mockReturnValue({
    getFT8Config: () => ({ maxSameTransmissionCount: limit }),
  } as any);
}

async function addBasicOperator(manager: RadioOperatorManager, id: string, callsign = 'BG4IAJ') {
  await manager.addOperator({
    id,
    myCallsign: callsign,
    myGrid: 'OM96',
    frequency: 1500,
    transmitCycles: [0],
    mode: MODES.FT8,
  });
  const operator = manager.getOperatorById(id);
  expect(operator).toBeDefined();
  operator!.start();
  return operator!;
}

describe('RadioOperatorManager logbook startup binding', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not wait for callsign logbook creation while initializing configured operators', async () => {
    const logBook = {
      id: 'log-1',
      name: 'Test Log',
      provider: {},
    };
    const { manager, fakeLogManager } = createManager({ logBook, callsign: 'BG4IAJ' });
    const operatorConfig: RadioOperatorConfig = {
      id: 'op1',
      myCallsign: 'BG4IAJ',
      myGrid: 'OM96',
      frequency: 14_074_000,
      transmitCycles: [0],
      mode: MODES.FT8,
    };
    vi.spyOn(ConfigManager, 'getInstance').mockReturnValue({
      getOperatorsConfig: () => [operatorConfig],
    } as any);

    await manager.initialize();

    expect(manager.getOperatorById('op1')).toBeDefined();
    expect(fakeLogManager.registerOperatorCallsign).toHaveBeenCalledWith('op1', 'BG4IAJ');
    expect(fakeLogManager.prewarmLogBookByCallsign).toHaveBeenCalledWith('BG4IAJ');
    expect(fakeLogManager.getOrCreateLogBookByCallsign).not.toHaveBeenCalled();
  });

  it('connects an explicit logbook id after the operator is registered', async () => {
    const logBook = {
      id: 'log-1',
      name: 'Test Log',
      provider: {},
    };
    const { manager, fakeLogManager } = createManager({ logBook, callsign: 'BG4IAJ' });

    await manager.addOperator({
      id: 'op1',
      myCallsign: 'BG4IAJ',
      myGrid: 'OM96',
      frequency: 14_074_000,
      transmitCycles: [0],
      mode: MODES.FT8,
      logBookId: 'log-1',
    });

    expect(manager.getOperatorById('op1')).toBeDefined();
    expect(fakeLogManager.connectOperatorToLogBook).toHaveBeenCalledWith('op1', 'log-1');
  });

  it('normalizes operator callsign and grid updates before persisting and broadcasting', async () => {
    const logBook = {
      id: 'log-1',
      name: 'Test Log',
      provider: {},
    };
    const { manager, eventEmitter } = createManager({ logBook, callsign: 'BG4IAJ' });
    const updateOperatorConfig = vi.fn().mockImplementation(async (_id, updates) => ({
      id: 'op1',
      myCallsign: 'BG5DRB',
      myGrid: 'PM01',
      frequency: 1500,
      transmitCycles: [0],
      mode: MODES.FT8,
      ...updates,
    }));
    vi.spyOn(ConfigManager, 'getInstance').mockReturnValue({
      updateOperatorConfig,
      getOperatorConfig: vi.fn(() => ({ logBookId: undefined })),
    } as any);
    const statusSpy = vi.fn();
    eventEmitter.on('operatorStatusUpdate', statusSpy);

    await manager.addOperator({
      id: 'op1',
      myCallsign: 'BG4IAJ',
      myGrid: 'OM96',
      frequency: 1500,
      transmitCycles: [0],
      mode: MODES.FT8,
    });

    await manager.updateOperatorContext('op1', {
      myCall: ' bg5drb ',
      myGrid: ' pm01 ',
    });

    expect(updateOperatorConfig).toHaveBeenCalledWith('op1', {
      myCallsign: 'BG5DRB',
      myGrid: 'PM01',
    });
    expect(manager.getOperatorById('op1')?.config.myCallsign).toBe('BG5DRB');
    expect(manager.getOperatorById('op1')?.config.myGrid).toBe('PM01');
    expect(statusSpy).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({
        myCall: 'BG5DRB',
        myGrid: 'PM01',
      }),
    }));
  });
});

describe('RadioOperatorManager same transmission guard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('allows 20 same transmissions and stops the operator before the 21st encode', async () => {
    const encodeQueue = { push: vi.fn() };
    const { manager, eventEmitter } = createManager({
      logBook: {
        id: 'log-1',
        name: 'Test Log',
        provider: {
          getOrCreateLogBookByCallsign: vi.fn(),
          getStatistics: vi.fn(),
        },
      },
      callsign: 'BG4IAJ',
      clockNow: 0,
      encodeQueue,
    });
    const statusSpy = vi.fn();
    const textMessageSpy = vi.fn();
    eventEmitter.on('operatorStatusUpdate', statusSpy);
    eventEmitter.on('textMessage', textMessageSpy);

    await addBasicOperator(manager, 'op1');
    const resetOperatorPluginRuntime = vi.fn((operatorId: string, reason: string) => {
      manager.resetPluginRuntime(operatorId, reason);
    });
    manager.setPluginManager({
      resetOperatorPluginRuntime,
      getOperatorRuntimeStatus: vi.fn(() => undefined),
    } as any);
    manager.start();

    for (let index = 0; index < 21; index += 1) {
      const slotStartMs = index * MODES.FT8.slotMs;
      eventEmitter.emit('requestTransmit', {
        operatorId: 'op1',
        transmission: 'CQ BG4IAJ OM96',
      });
      manager.processPendingTransmissions(createSlotInfo(slotStartMs));
    }

    expect(encodeQueue.push).toHaveBeenCalledTimes(20);
    expect(manager.getOperatorById('op1')?.isTransmitting).toBe(false);
    expect(manager.getPendingTransmissionsCount()).toBe(0);
    expect(manager.getLatestEncodeRequestId('op1')).toBeUndefined();
    expect(resetOperatorPluginRuntime).toHaveBeenCalledTimes(1);
    expect(resetOperatorPluginRuntime).toHaveBeenCalledWith('op1', 'same transmission guard limit');
    expect(textMessageSpy).toHaveBeenCalledTimes(1);
    expect(textMessageSpy.mock.calls[0]?.[0]).toMatchObject({
      color: 'warning',
      key: 'sameTransmissionLimit',
      params: {
        operatorId: 'op1',
        attemptedCount: '21',
        maxCount: '20',
        transmission: 'CQ BG4IAJ OM96',
      },
    });
    expect(statusSpy.mock.calls.at(-1)?.[0]).toMatchObject({
      id: 'op1',
      isTransmitting: false,
    });
  });

  it('resets the standard-qso context and returns to TX6 after the guard stops an operator', async () => {
    const encodeQueue = { push: vi.fn() };
    const { manager, eventEmitter } = createManager({
      logBook: { id: 'log-1', name: 'Test Log', provider: {} },
      callsign: 'BG4IAJ',
      clockNow: 0,
      encodeQueue,
    });
    const dataDir = await mkdtemp(join(tmpdir(), 'tx5dr-same-transmission-reset-'));

    let pluginManager!: PluginManager;
    pluginManager = new PluginManager({
      eventEmitter,
      getOperators: () => manager.getAllOperators(),
      getOperatorById: (id) => manager.getOperatorById(id),
      getCurrentMode: () => MODES.FT8,
      getOperatorAutomationSnapshot: (id) => pluginManager.getOperatorAutomationSnapshot(id),
      requestOperatorCall: () => {},
      getRadioFrequency: async () => 7_074_000,
      setRadioFrequency: () => {},
      getRadioBand: () => '40m',
      getRadioConnected: () => true,
      getLatestSlotPack: () => null,
      interruptOperatorTransmission: async () => {},
      hasWorkedCallsign: async () => false,
      resetOperatorRuntime: (operatorId, reason) => manager.resetPluginRuntime(operatorId, reason),
      dataDir,
    });

    try {
      manager.setPluginManager(pluginManager);
      pluginManager.loadConfig({ configs: {}, operatorStrategies: {}, operatorSettings: {} });
      await manager.addOperator({
        id: 'op1',
        myCallsign: 'BG4IAJ',
        myGrid: 'OM96',
        frequency: 1500,
        transmitCycles: [0],
        mode: MODES.FT8,
      });
      await pluginManager.start();
      manager.start();

      const operator = manager.getOperatorById('op1');
      expect(operator).toBeDefined();
      operator!.start();

      pluginManager.requestCall('op1', 'JA1AAA', {
        message: {
          message: 'CQ JA1AAA PM95',
          snr: 0,
          dt: 0,
          freq: 1500,
          confidence: 1,
        },
        slotInfo: createSlotInfo(0),
      });

      expect(pluginManager.getOperatorRuntimeStatus('op1')).toMatchObject({
        currentSlot: 'TX1',
        context: { targetCallsign: 'JA1AAA' },
      });

      encodeQueue.push.mockClear();
      for (let index = 0; index < 21; index += 1) {
        eventEmitter.emit('requestTransmit', { operatorId: 'op1', transmission: 'JA1AAA BG4IAJ -10' });
        manager.processPendingTransmissions(createSlotInfo(index * MODES.FT8.slotMs));
      }

      expect(encodeQueue.push).toHaveBeenCalledTimes(20);
      expect(manager.getOperatorById('op1')?.isTransmitting).toBe(false);
      const status = pluginManager.getOperatorRuntimeStatus('op1');
      expect(status.currentSlot).toBe('TX6');
      expect(status.context?.targetCallsign).toBeUndefined();
      expect(status.context?.targetGrid).toBeUndefined();
      expect(status.context?.reportSent).toBeUndefined();
      expect(status.context?.reportReceived).toBeUndefined();
    } finally {
      manager.stop();
      await pluginManager.shutdown().catch(() => undefined);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('disables the guard when maxSameTransmissionCount is set to 0', async () => {
    mockMaxSameTransmissionCount(0);
    const encodeQueue = { push: vi.fn() };
    const { manager, eventEmitter } = createManager({
      logBook: { id: 'log-1', name: 'Test Log', provider: {} },
      callsign: 'BG4IAJ',
      clockNow: 0,
      encodeQueue,
    });
    const textMessageSpy = vi.fn();
    eventEmitter.on('textMessage', textMessageSpy);

    await addBasicOperator(manager, 'op1');
    manager.start();

    for (let index = 0; index < 25; index += 1) {
      const slotStartMs = index * MODES.FT8.slotMs;
      eventEmitter.emit('requestTransmit', {
        operatorId: 'op1',
        transmission: 'CQ BG4IAJ OM96',
      });
      manager.processPendingTransmissions(createSlotInfo(slotStartMs));
    }

    expect(encodeQueue.push).toHaveBeenCalledTimes(25);
    expect(manager.getOperatorById('op1')?.isTransmitting).toBe(true);
    expect(textMessageSpy).not.toHaveBeenCalled();
  });

  it('resets the counter when the transmit text changes', async () => {
    mockMaxSameTransmissionCount(2);
    const encodeQueue = { push: vi.fn() };
    const { manager, eventEmitter } = createManager({
      logBook: { id: 'log-1', name: 'Test Log', provider: {} },
      callsign: 'BG4IAJ',
      clockNow: 0,
      encodeQueue,
    });

    await addBasicOperator(manager, 'op1');
    manager.start();

    for (const [index, transmission] of ['CQ BG4IAJ OM96', 'CQ BG4IAJ OM96', 'BG5DRB BG4IAJ -06', 'CQ BG4IAJ OM96'].entries()) {
      const slotStartMs = index * MODES.FT8.slotMs;
      eventEmitter.emit('requestTransmit', { operatorId: 'op1', transmission });
      manager.processPendingTransmissions(createSlotInfo(slotStartMs));
    }

    expect(encodeQueue.push).toHaveBeenCalledTimes(4);
    expect(manager.getOperatorById('op1')?.isTransmitting).toBe(true);
  });

  it('tracks the same message independently for each operator', async () => {
    mockMaxSameTransmissionCount(2);
    const encodeQueue = { push: vi.fn() };
    const { manager, eventEmitter } = createManager({
      logBook: { id: 'log-1', name: 'Test Log', provider: {} },
      callsign: 'BG4IAJ',
      clockNow: 0,
      encodeQueue,
    });

    await addBasicOperator(manager, 'op1', 'BG4IAJ');
    await addBasicOperator(manager, 'op2', 'BG4IAJ');
    manager.start();

    for (let index = 0; index < 3; index += 1) {
      const slotInfo = createSlotInfo(index * MODES.FT8.slotMs);
      eventEmitter.emit('requestTransmit', { operatorId: 'op1', transmission: 'CQ BG4IAJ OM96' });
      eventEmitter.emit('requestTransmit', { operatorId: 'op2', transmission: 'CQ BG4IAJ OM96' });
      manager.processPendingTransmissions(slotInfo);
    }

    expect(encodeQueue.push).toHaveBeenCalledTimes(4);
    expect(manager.getOperatorById('op1')?.isTransmitting).toBe(false);
    expect(manager.getOperatorById('op2')?.isTransmitting).toBe(false);
    expect(encodeQueue.push.mock.calls.filter((call) => call[0].operatorId === 'op1')).toHaveLength(2);
    expect(encodeQueue.push.mock.calls.filter((call) => call[0].operatorId === 'op2')).toHaveLength(2);
  });

  it('does not count same-slot replacement encodes as another repeated transmission', async () => {
    mockMaxSameTransmissionCount(1);
    const encodeQueue = { push: vi.fn() };
    const { manager, eventEmitter } = createManager({
      logBook: { id: 'log-1', name: 'Test Log', provider: {} },
      callsign: 'BG4IAJ',
      clockNow: 0,
      encodeQueue,
    });

    await addBasicOperator(manager, 'op1');
    manager.start();

    eventEmitter.emit('requestTransmit', { operatorId: 'op1', transmission: 'CQ BG4IAJ OM96' });
    manager.processPendingTransmissions(createSlotInfo(0));
    eventEmitter.emit('requestTransmit', {
      operatorId: 'op1',
      transmission: 'CQ BG4IAJ OM96',
      replaceExisting: true,
    });
    manager.processPendingTransmissions(createSlotInfo(0));
    eventEmitter.emit('requestTransmit', { operatorId: 'op1', transmission: 'CQ BG4IAJ OM96' });
    manager.processPendingTransmissions(createSlotInfo(MODES.FT8.slotMs));

    expect(encodeQueue.push).toHaveBeenCalledTimes(2);
    expect(encodeQueue.push.mock.calls[1]?.[0]).toMatchObject({
      operatorId: 'op1',
      message: 'CQ BG4IAJ OM96',
    });
    expect(manager.getOperatorById('op1')?.isTransmitting).toBe(false);
  });
});

describe('RadioOperatorManager decode AP context selection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a TX3/TX4 AP context only for RX-cycle automated operators', async () => {
    const { manager } = createManager({
      logBook: { id: 'log-1', name: 'Test Log', provider: {} },
    });
    await addBasicOperator(manager, 'op1', 'BG4IAJ');
    manager.setPluginManager({
      getOperatorRuntimeStatus: vi.fn(() => ({
        strategyName: 'standard-qso',
        currentSlot: 'TX3',
        context: {
          targetCallsign: 'ja1aaa',
          targetGrid: 'pm95',
        },
      })),
    } as any);
    manager.start();

    expect(manager.getDecodeApContext(createSlotInfo(0), 0)).toBeUndefined();
    expect(manager.getDecodeApContext(createSlotInfo(MODES.FT8.slotMs), 0)).toEqual({
      operatorId: 'op1',
      myCall: 'BG4IAJ',
      myGrid: 'OM96',
      dxCall: 'JA1AAA',
      dxGrid: 'PM95',
      frequencyHz: 1500,
      qsoProgress: 3,
      currentSlot: 'TX3',
    });
  });

  it('does not enable AP for TX1, TX2, TX5, TX6, or missing targets', async () => {
    const { manager } = createManager({
      logBook: { id: 'log-1', name: 'Test Log', provider: {} },
    });
    await addBasicOperator(manager, 'op1', 'BG4IAJ');
    const runtime: {
      strategyName: string;
      currentSlot: string;
      context: Record<string, unknown>;
    } = {
      strategyName: 'standard-qso',
      currentSlot: 'TX1',
      context: { targetCallsign: 'JA1AAA' },
    };
    manager.setPluginManager({
      getOperatorRuntimeStatus: vi.fn(() => runtime),
    } as any);
    manager.start();

    for (const slot of ['TX1', 'TX2', 'TX5', 'TX6']) {
      runtime.currentSlot = slot;
      expect(manager.getDecodeApContext(createSlotInfo(MODES.FT8.slotMs), 0)).toBeUndefined();
    }

    runtime.currentSlot = 'TX3';
    runtime.context = {};
    expect(manager.getDecodeApContext(createSlotInfo(MODES.FT8.slotMs), 0)).toBeUndefined();
  });

  it('chooses one stable best AP context and can use tracker grid fallback', async () => {
    const { manager } = createManager({
      logBook: { id: 'log-1', name: 'Test Log', provider: {} },
      callsignTracker: { getGrid: vi.fn(() => 'PM64') },
    });
    await addBasicOperator(manager, 'op2', 'BG4BBB');
    await addBasicOperator(manager, 'op1', 'BG4AAA');

    manager.setPluginManager({
      getOperatorRuntimeStatus: vi.fn((operatorId: string) => operatorId === 'op2'
        ? {
            strategyName: 'standard-qso',
            currentSlot: 'TX3',
            context: { targetCallsign: 'JA2BBB' },
          }
        : {
            strategyName: 'standard-qso',
            currentSlot: 'TX4',
            context: { targetCallsign: 'JA1AAA' },
          }),
    } as any);
    manager.start();

    expect(manager.getDecodeApContext(createSlotInfo(MODES.FT8.slotMs), 0)).toEqual(expect.objectContaining({
      operatorId: 'op1',
      myCall: 'BG4AAA',
      dxCall: 'JA1AAA',
      dxGrid: 'PM64',
      qsoProgress: 4,
      currentSlot: 'TX4',
    }));
  });
});

describe('RadioOperatorManager automatic QSO logging', () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
        messageHistory: ['old message'],
      }),
      getStatistics: vi.fn().mockResolvedValue({ totalQSOs: 2 }),
    };

    const { manager, eventEmitter } = createManager({
      logBook: { id: 'log-1', name: 'Test Log', provider },
      callsign: 'BG5DRB',
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
    const { notifyQSOComplete, autoSync } = attachQSOHookSpy(manager);

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
        messageHistory: [],
        myCallsign: 'BG5DRB',
        myGrid: 'PM01AA',
      },
    });

    expect(provider.updateQSO).not.toHaveBeenCalled();
    expect(provider.addQSO).toHaveBeenCalledTimes(1);
    expect(updatedSpy).not.toHaveBeenCalled();
    expect(addedSpy).toHaveBeenCalledTimes(1);
    expect(provider.addQSO.mock.calls[0]?.[0]?.messageHistory).toEqual(['BG5DRB N0CALL -12']);
    expect(provider.addQSO.mock.calls[0]?.[0]?.comment).toBe('FT8  Sent: -12  Rcvd: -09');
    expect(autoSync).toHaveBeenCalledTimes(1);
    expect(notifyQSOComplete).toHaveBeenCalledTimes(1);
    expect(notifyQSOComplete).toHaveBeenCalledWith(
      'op1',
      expect.objectContaining({
        id: 'temp-2',
        callsign: 'N0CALL',
        messageHistory: ['BG5DRB N0CALL -12'],
        comment: 'FT8  Sent: -12  Rcvd: -09',
      }),
    );
  });

  it('notifies QSO completion hooks when an automatic QSO is merged into an existing record', async () => {
    const base = Date.parse('2026-04-05T13:00:00.000Z');
    const provider = {
      addQSO: vi.fn(),
      updateQSO: vi.fn().mockResolvedValue(undefined),
      getQSO: vi.fn().mockResolvedValue({
        id: 'existing-1',
        callsign: 'N0CALL',
        frequency: 14_074_000,
        mode: 'FT8',
        startTime: base - 30_000,
        endTime: base + MODES.FT8.slotMs,
        reportSent: '-12',
        reportReceived: '-09',
        messageHistory: ['merged message'],
        comment: 'FT8  Sent: -12  Rcvd: -09',
      }),
      getLastQSOWithCallsign: vi.fn().mockResolvedValue({
        id: 'existing-1',
        callsign: 'N0CALL',
        frequency: 14_074_000,
        mode: 'FT8',
        startTime: base - 30_000,
        endTime: base - 15_000,
        reportSent: '-10',
        reportReceived: '-08',
        messageHistory: ['old message'],
      }),
      getStatistics: vi.fn().mockResolvedValue({ totalQSOs: 1 }),
    };

    const { manager, eventEmitter } = createManager({
      logBook: { id: 'log-1', name: 'Test Log', provider },
      callsign: 'BG5DRB',
      activeSlotPacks: [],
      storedRecords: [],
    });
    const updatedSpy = vi.fn();
    const addedSpy = vi.fn();
    eventEmitter.on('qsoRecordUpdated', updatedSpy);
    eventEmitter.on('qsoRecordAdded', addedSpy);
    const { notifyQSOComplete, autoSync } = attachQSOHookSpy(manager);

    await invokeRecordQSO(manager, {
      operatorId: 'op1',
      qsoRecord: {
        id: 'temp-merged',
        callsign: 'n0call',
        frequency: 14_074_000,
        mode: 'FT8',
        startTime: base,
        endTime: base + MODES.FT8.slotMs,
        reportSent: '-12',
        reportReceived: '-09',
        messageHistory: [],
        myCallsign: 'BG5DRB',
      },
    });

    expect(provider.addQSO).not.toHaveBeenCalled();
    expect(provider.updateQSO).toHaveBeenCalledTimes(1);
    expect(provider.updateQSO.mock.calls[0]?.[1]).toMatchObject({
      comment: 'FT8  Sent: -12  Rcvd: -09',
    });
    expect(addedSpy).not.toHaveBeenCalled();
    expect(updatedSpy).toHaveBeenCalledTimes(1);
    expect(autoSync).not.toHaveBeenCalled();
    expect(notifyQSOComplete).toHaveBeenCalledTimes(1);
    expect(notifyQSOComplete).toHaveBeenCalledWith(
      'op1',
      expect.objectContaining({
        id: 'existing-1',
        callsign: 'N0CALL',
        comment: 'FT8  Sent: -12  Rcvd: -09',
      }),
    );
  });

  it('replaces the queued transmission when a late decode advances standard-qso during the current TX slot', async () => {
    const encodeQueue = { push: vi.fn() };
    const { manager, eventEmitter } = createManager({
      logBook: {
        id: 'log-1',
        name: 'Test Log',
        provider: {
          addQSO: vi.fn().mockResolvedValue(undefined),
          updateQSO: vi.fn(),
          getQSO: vi.fn(),
          getLastQSOWithCallsign: vi.fn().mockResolvedValue(null),
          getStatistics: vi.fn().mockResolvedValue({ totalQSOs: 0 }),
          hasWorkedCallsign: vi.fn().mockResolvedValue(false),
        },
      },
      callsign: 'BG4IAJ',
      clockNow: 60_001,
      encodeQueue,
    });

    const dataDir = await mkdtemp(join(tmpdir(), 'tx5dr-operator-redecide-'));
    const transmissionLogSpy = vi.fn();
    eventEmitter.on('transmissionLog' as any, transmissionLogSpy);
    eventEmitter.on('checkHasWorkedCallsign' as any, (data: { requestId: string }) => {
      eventEmitter.emit('hasWorkedCallsignResponse' as any, {
        requestId: data.requestId,
        hasWorked: false,
      });
    });

    let pluginManager!: PluginManager;
    pluginManager = new PluginManager({
      eventEmitter,
      getOperators: () => manager.getAllOperators(),
      getOperatorById: (id) => manager.getOperatorById(id),
      getCurrentMode: () => MODES.FT8,
      getOperatorAutomationSnapshot: (id) => pluginManager.getOperatorAutomationSnapshot(id),
      requestOperatorCall: () => {},
      getRadioFrequency: async () => 7_074_000,
      setRadioFrequency: () => {},
      getRadioBand: () => '40m',
      getRadioConnected: () => true,
      getLatestSlotPack: () => null,
      interruptOperatorTransmission: async () => {},
      hasWorkedCallsign: async () => false,
      resetOperatorRuntime: () => {},
      dataDir,
    });

    try {
      manager.setPluginManager(pluginManager);
      pluginManager.loadConfig({
        configs: {},
        operatorStrategies: {},
        operatorSettings: {},
      });

      await manager.addOperator({
        id: 'op1',
        myCallsign: 'BG4IAJ',
        myGrid: 'OM96',
        frequency: 7_074_000,
        transmitCycles: [0],
        mode: MODES.FT8,
      });
      await pluginManager.start();
      manager.start();

      const operator = manager.getOperatorById('op1');
      expect(operator).toBeDefined();
      operator!.start();

      pluginManager.patchOperatorRuntimeContext('op1', {
        targetCallsign: 'BG5DRB',
        targetGrid: 'OM96',
        reportSent: -6,
      });
      pluginManager.setOperatorRuntimeState('op1', 'TX2');

      const initialTransmission = pluginManager.getCurrentTransmission('op1');
      expect(initialTransmission).toBe('BG5DRB BG4IAJ -06');

      const currentTxSlot = createSlotInfo(60_000);
      const incompleteRxPack = buildSlotPack('slot-45000', 45_000, []);
      await (pluginManager as any).handleSlotStart(currentTxSlot, incompleteRxPack);

      const lateDecodePack = buildSlotPack('slot-45000', 45_000, [{
        message: FT8MessageParser.generateMessage({
          type: FT8MessageType.ROGER_REPORT,
          senderCallsign: 'BG5DRB',
          targetCallsign: 'BG4IAJ',
          report: -5,
        }),
        snr: -4,
        dt: 0,
        freq: 1531,
        confidence: 0.95,
      }]);

      manager.reDecideOnLateDecodes(lateDecodePack);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(pluginManager.getOperatorRuntimeStatus('op1').currentSlot).toBe('TX4');
      expect(encodeQueue.push).toHaveBeenCalledTimes(2);
      expect(encodeQueue.push.mock.calls[0]?.[0]?.message).toBe('BG5DRB BG4IAJ -06');
      expect(encodeQueue.push.mock.calls[1]?.[0]?.message).toBe('BG5DRB BG4IAJ RR73');
      expect(transmissionLogSpy).toHaveBeenCalledTimes(2);
      expect(transmissionLogSpy.mock.calls[0]?.[0]).toMatchObject({
        operatorId: 'op1',
        message: 'BG5DRB BG4IAJ -06',
      });
      expect(transmissionLogSpy.mock.calls[1]?.[0]).toMatchObject({
        operatorId: 'op1',
        message: 'BG5DRB BG4IAJ RR73',
        replaceExisting: true,
      });
    } finally {
      manager.stop();
      await pluginManager.shutdown().catch(() => undefined);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('keeps late decode re-decision active after the old 4s FT8 cutoff and still replaces current TX', async () => {
    const encodeQueue = { push: vi.fn() };
    const { manager, eventEmitter } = createManager({
      logBook: {
        id: 'log-1',
        name: 'Test Log',
        provider: {
          addQSO: vi.fn().mockResolvedValue(undefined),
          updateQSO: vi.fn(),
          getQSO: vi.fn(),
          getLastQSOWithCallsign: vi.fn().mockResolvedValue(null),
          getStatistics: vi.fn().mockResolvedValue({ totalQSOs: 0 }),
          hasWorkedCallsign: vi.fn().mockResolvedValue(false),
        },
      },
      callsign: 'BG4IAJ',
      clockNow: 64_500, // current slot 60_000, elapsed 4.5s: beyond old 4s cutoff
      encodeQueue,
    });
    const transmissionLogSpy = vi.fn();
    eventEmitter.on('transmissionLog' as any, transmissionLogSpy);

    await manager.addOperator({
      id: 'op1',
      myCallsign: 'BG4IAJ',
      myGrid: 'OM96',
      frequency: 7_074_000,
      transmitCycles: [0],
      mode: MODES.FT8,
    });

    const reDecideOperator = vi.fn().mockResolvedValue(true);
    manager.setPluginManager({
      reDecideOperator,
      shouldProcessStoppedOperatorReDecision: vi.fn(() => false),
      getCurrentTransmission: vi.fn(() => 'BG5DRB BG4IAJ RR73'),
      getOperatorRuntimeStatus: vi.fn(() => null),
      notifyTransmissionQueued: vi.fn(),
    } as any);

    try {
      manager.start();
      manager.getOperatorById('op1')!.start();

      const lateDecodePack = buildSlotPack('slot-45000', 45_000, [{
        message: FT8MessageParser.generateMessage({
          type: FT8MessageType.ROGER_REPORT,
          senderCallsign: 'BG5DRB',
          targetCallsign: 'BG4IAJ',
          report: -5,
        }),
        snr: -4,
        dt: 0,
        freq: 1531,
        confidence: 0.95,
      }]);

      manager.reDecideOnLateDecodes(lateDecodePack);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(reDecideOperator).toHaveBeenCalledWith('op1', lateDecodePack);
      expect(encodeQueue.push).toHaveBeenCalledTimes(1);
      expect(encodeQueue.push.mock.calls[0]?.[0]).toMatchObject({
        operatorId: 'op1',
        message: 'BG5DRB BG4IAJ RR73',
        slotStartMs: 60_000,
        timeSinceSlotStartMs: 4_500,
      });
      expect(transmissionLogSpy.mock.calls[0]?.[0]).toMatchObject({
        operatorId: 'op1',
        message: 'BG5DRB BG4IAJ RR73',
        replaceExisting: true,
      });
    } finally {
      manager.stop();
    }
  });

  it('rejects late decode re-decision inside the final FT8 slot guard window', async () => {
    const encodeQueue = { push: vi.fn() };
    const { manager } = createManager({
      logBook: {
        id: 'log-1',
        name: 'Test Log',
        provider: {
          addQSO: vi.fn().mockResolvedValue(undefined),
          updateQSO: vi.fn(),
          getQSO: vi.fn(),
          getLastQSOWithCallsign: vi.fn().mockResolvedValue(null),
          getStatistics: vi.fn().mockResolvedValue({ totalQSOs: 0 }),
          hasWorkedCallsign: vi.fn().mockResolvedValue(false),
        },
      },
      callsign: 'BG4IAJ',
      clockNow: 74_501, // current slot 60_000, elapsed 14.501s: inside 500ms guard
      encodeQueue,
    });

    await manager.addOperator({
      id: 'op1',
      myCallsign: 'BG4IAJ',
      myGrid: 'OM96',
      frequency: 7_074_000,
      transmitCycles: [0],
      mode: MODES.FT8,
    });

    const reDecideOperator = vi.fn().mockResolvedValue(true);
    manager.setPluginManager({
      reDecideOperator,
      shouldProcessStoppedOperatorReDecision: vi.fn(() => false),
      getCurrentTransmission: vi.fn(() => 'BG5DRB BG4IAJ RR73'),
      getOperatorRuntimeStatus: vi.fn(() => null),
      notifyTransmissionQueued: vi.fn(),
    } as any);

    try {
      manager.start();
      manager.getOperatorById('op1')!.start();

      manager.reDecideOnLateDecodes(buildSlotPack('slot-45000', 45_000, [{
        message: 'BG5DRB BG4IAJ R-05',
        snr: -4,
        dt: 0,
        freq: 1531,
        confidence: 0.95,
      }]));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(reDecideOperator).not.toHaveBeenCalled();
      expect(encodeQueue.push).not.toHaveBeenCalled();
    } finally {
      manager.stop();
    }
  });

  it('uses the double-click request target before changing transmit cycle and refreshing the panel status', async () => {
    const encodeQueue = { push: vi.fn() };
    const { manager, eventEmitter } = createManager({
      logBook: {
        id: 'log-1',
        name: 'Test Log',
        provider: {
          addQSO: vi.fn().mockResolvedValue(undefined),
          updateQSO: vi.fn(),
          getQSO: vi.fn(),
          getLastQSOWithCallsign: vi.fn().mockResolvedValue(null),
          getStatistics: vi.fn().mockResolvedValue({ totalQSOs: 0 }),
          hasWorkedCallsign: vi.fn().mockResolvedValue(false),
        },
      },
      callsign: 'BG5DRB',
      clockNow: 60_001,
      encodeQueue,
    });

    const dataDir = await mkdtemp(join(tmpdir(), 'tx5dr-operator-request-call-'));
    eventEmitter.on('checkHasWorkedCallsign' as any, (data: { requestId: string }) => {
      eventEmitter.emit('hasWorkedCallsignResponse' as any, {
        requestId: data.requestId,
        hasWorked: false,
      });
    });

    let pluginManager!: PluginManager;
    pluginManager = new PluginManager({
      eventEmitter,
      getOperators: () => manager.getAllOperators(),
      getOperatorById: (id) => manager.getOperatorById(id),
      getCurrentMode: () => MODES.FT8,
      getOperatorAutomationSnapshot: (id) => pluginManager.getOperatorAutomationSnapshot(id),
      requestOperatorCall: () => {},
      getRadioFrequency: async () => 7_074_000,
      setRadioFrequency: () => {},
      getRadioBand: () => '40m',
      getRadioConnected: () => true,
      getLatestSlotPack: () => null,
      interruptOperatorTransmission: async () => {},
      hasWorkedCallsign: async () => false,
      resetOperatorRuntime: () => {},
      dataDir,
    });

    try {
      manager.setPluginManager(pluginManager);
      pluginManager.loadConfig({
        configs: {},
        operatorStrategies: {},
        operatorSettings: {},
      });

      await manager.addOperator({
        id: 'op1',
        myCallsign: 'BG5DRB',
        myGrid: 'PL09',
        frequency: 1824,
        transmitCycles: [1],
        mode: MODES.FT8,
      });
      await pluginManager.start();
      manager.start();

      const statusSpy = vi.fn();
      eventEmitter.on('operatorStatusUpdate', statusSpy);

      pluginManager.requestCall('op1', 'BH3RAU', {
        message: {
          message: 'CQ BH3RAU OM99',
          snr: 0,
          dt: 0.6,
          freq: 1502,
          confidence: 1,
        },
        slotInfo: createSlotInfo(45_000),
      });

      expect(encodeQueue.push).toHaveBeenCalledTimes(1);
      expect(encodeQueue.push.mock.calls[0]?.[0]).toMatchObject({
        operatorId: 'op1',
        message: 'BH3RAU BG5DRB PL09',
        frequency: 1824,
      });

      const latestStatus = statusSpy.mock.calls.at(-1)?.[0];
      expect(latestStatus).toMatchObject({
        id: 'op1',
        currentSlot: 'TX1',
        context: {
          targetCall: 'BH3RAU',
        },
        slots: {
          TX1: 'BH3RAU BG5DRB PL09',
        },
        transmitCycles: [0],
      });
    } finally {
      manager.stop();
      await pluginManager.shutdown().catch(() => undefined);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('reDecideOnLateDecodes rejects a slotPack from the current TX slot (not the prior RX slot)', async () => {
    // 2026-04-19 BG5DRB 事故修复（方案 B）：addTransmissionFrame 的 slotPackUpdated
    // 在「多 operator 混合 TX」场景下会把当前 TX 槽的 slotPack 喂给 reDecideOnLateDecodes。
    // reDecide 的 slotPack 必须是「上一 RX 槽」；若不是就拒绝，避免 standard-qso 被错误
    // 输入污染 QSO 上下文。
    const encodeQueue = { push: vi.fn() };
    const { manager, eventEmitter } = createManager({
      logBook: {
        id: 'log-1',
        name: 'Test Log',
        provider: {
          addQSO: vi.fn().mockResolvedValue(undefined),
          updateQSO: vi.fn(),
          getQSO: vi.fn(),
          getLastQSOWithCallsign: vi.fn().mockResolvedValue(null),
          getStatistics: vi.fn().mockResolvedValue({ totalQSOs: 0 }),
          hasWorkedCallsign: vi.fn().mockResolvedValue(false),
        },
      },
      callsign: 'BG4IAJ',
      clockNow: 60_001, // 当前 TX 槽 startMs=60_000，上一 RX 槽 startMs=45_000
      encodeQueue,
    });

    const dataDir = await mkdtemp(join(tmpdir(), 'tx5dr-operator-wrongslot-'));
    eventEmitter.on('checkHasWorkedCallsign' as any, (data: { requestId: string }) => {
      eventEmitter.emit('hasWorkedCallsignResponse' as any, {
        requestId: data.requestId,
        hasWorked: false,
      });
    });

    let pluginManager!: PluginManager;
    pluginManager = new PluginManager({
      eventEmitter,
      getOperators: () => manager.getAllOperators(),
      getOperatorById: (id) => manager.getOperatorById(id),
      getCurrentMode: () => MODES.FT8,
      getOperatorAutomationSnapshot: (id) => pluginManager.getOperatorAutomationSnapshot(id),
      requestOperatorCall: () => {},
      getRadioFrequency: async () => 7_074_000,
      setRadioFrequency: () => {},
      getRadioBand: () => '40m',
      getRadioConnected: () => true,
      getLatestSlotPack: () => null,
      interruptOperatorTransmission: async () => {},
      hasWorkedCallsign: async () => false,
      resetOperatorRuntime: () => {},
      dataDir,
    });

    try {
      manager.setPluginManager(pluginManager);
      pluginManager.loadConfig({ configs: {}, operatorStrategies: {}, operatorSettings: {} });
      await manager.addOperator({
        id: 'op1',
        myCallsign: 'BG4IAJ',
        myGrid: 'OM96',
        frequency: 7_074_000,
        transmitCycles: [0],
        mode: MODES.FT8,
      });
      await pluginManager.start();
      manager.start();
      const operator = manager.getOperatorById('op1');
      operator!.start();

      pluginManager.patchOperatorRuntimeContext('op1', {
        targetCallsign: 'BG5DRB',
        targetGrid: 'OM96',
        reportSent: -6,
      });
      pluginManager.setOperatorRuntimeState('op1', 'TX3');

      const reDecideSpy = vi.spyOn(pluginManager, 'reDecideOperator');

      // 关键反例：喂入的 slotPack.startMs 是当前 TX 槽 60_000，不是上一 RX 槽 45_000
      // （模拟 addTransmissionFrame 写入 TX echo 后 emit 的 slotPackUpdated 漏到本路径）
      const currentTxSlotPack = buildSlotPack('slot-60000', 60_000, [{
        message: 'BA4IE BG5BNW -07',
        snr: -999,
        dt: 0,
        freq: 1595,
        confidence: 1,
        operatorId: 'other-op',
      }]);

      manager.reDecideOnLateDecodes(currentTxSlotPack);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(reDecideSpy).not.toHaveBeenCalled();

      // 反向验证：喂入上一 RX 槽的 slotPack 可以正常触发（确保守卫不过度严格）
      const priorRxSlotPack = buildSlotPack('slot-45000', 45_000, [{
        message: FT8MessageParser.generateMessage({
          type: FT8MessageType.ROGER_REPORT,
          senderCallsign: 'BG5DRB',
          targetCallsign: 'BG4IAJ',
          report: -5,
        }),
        snr: -4,
        dt: 0,
        freq: 1531,
        confidence: 0.95,
      }]);

      manager.reDecideOnLateDecodes(priorRxSlotPack);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(reDecideSpy).toHaveBeenCalledTimes(1);
      expect(reDecideSpy.mock.calls[0]?.[0]).toBe('op1');
    } finally {
      manager.stop();
      await pluginManager.shutdown().catch(() => undefined);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('refreshes the logbook callsign binding after the operator callsign changes', async () => {
    const perCallsignWorked = new Map<string, boolean>([
      ['BG4IAJ', false],
      ['BG7XTV', true],
    ]);
    const registeredCallsigns = new Map<string, string>();
    const logBooks = new Map<string, { id: string; name: string; provider: any }>();

    const getOrCreateLogBookByCallsign = vi.fn(async (callsign: string) => {
      const normalized = callsign.toUpperCase();
      let logBook = logBooks.get(normalized);
      if (!logBook) {
        logBook = {
          id: `log-${normalized}`,
          name: normalized,
          provider: {
            hasWorkedCallsign: vi.fn(async () => perCallsignWorked.get(normalized) ?? false),
          },
        };
        logBooks.set(normalized, logBook);
      }
      return logBook!;
    });

    const fakeLogManager = {
      getOperatorLogBook: vi.fn(async (operatorId: string) => {
        const callsign = registeredCallsigns.get(operatorId);
        if (!callsign) return null;
        return getOrCreateLogBookByCallsign(callsign);
      }),
      getOperatorCallsign: vi.fn((operatorId: string) => registeredCallsigns.get(operatorId) ?? null),
      getOrCreateLogBookByCallsign,
      registerOperatorCallsign: vi.fn((operatorId: string, callsign: string) => {
        registeredCallsigns.set(operatorId, callsign.toUpperCase());
      }),
      disconnectOperatorFromLogBook: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };

    vi.spyOn(LogManager, 'getInstance').mockReturnValue(fakeLogManager as any);

    const manager = new RadioOperatorManager({
      eventEmitter: new EventEmitter<DigitalRadioEngineEvents>(),
      encodeQueue: { push: vi.fn() } as any,
      clockSource: { now: vi.fn(() => 0) } as any,
      getCurrentMode: () => MODES.FT8,
      setRadioFrequency: vi.fn(),
      getRadioFrequency: vi.fn(async () => 7_074_000),
      getKnownRadioFrequency: vi.fn(() => 7_074_000),
      slotPackManager: {
        getActiveSlotPacks: vi.fn(() => []),
        readStoredRecords: vi.fn(async () => []),
      } as any,
    });

    const initialConfig: RadioOperatorConfig = {
      id: 'op1',
      myCallsign: 'BG4IAJ',
      myGrid: 'OM96',
      frequency: 7_074_000,
      transmitCycles: [0],
      mode: MODES.FT8,
    };

    await manager.syncAddOperator(initialConfig);
    expect(await manager.hasWorkedCallsign('op1', 'BG5DRB')).toBe(false);

    await manager.syncUpdateOperator({
      ...initialConfig,
      myCallsign: 'BG7XTV',
    });

    expect(await manager.hasWorkedCallsign('op1', 'BG5DRB')).toBe(true);
    expect(fakeLogManager.registerOperatorCallsign).toHaveBeenLastCalledWith('op1', 'BG7XTV');
  });
});

describe('RadioOperatorManager has-worked checks', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('scopes hasWorkedCallsign to the current known RF band without reading live radio frequency', async () => {
    let currentFrequency = 14_074_000;
    const getRadioFrequency = vi.fn(async () => 50_313_000);
    const provider = {
      hasWorkedCallsign: vi.fn(async (_callsign: string, options?: { band?: string }) => {
        return options?.band === '6m';
      }),
    };
    const { manager } = createManager({
      logBook: { id: 'log-1', name: 'Test Log', provider },
      getKnownRadioFrequency: () => currentFrequency,
      getRadioFrequency,
    });

    await expect(manager.hasWorkedCallsign('op1', 'BG7OO')).resolves.toBe(false);
    expect(provider.hasWorkedCallsign).toHaveBeenLastCalledWith('BG7OO', { band: '20m' });
    expect(getRadioFrequency).not.toHaveBeenCalled();

    currentFrequency = 50_313_000;

    await expect(manager.hasWorkedCallsign('op1', 'BG7OO')).resolves.toBe(true);
    expect(provider.hasWorkedCallsign).toHaveBeenLastCalledWith('BG7OO', { band: '6m' });
    expect(getRadioFrequency).not.toHaveBeenCalled();
  });

  it('falls back to the last selected frequency when known RF is unavailable', async () => {
    vi.spyOn(ConfigManager, 'getInstance').mockReturnValue({
      getLastSelectedFrequency: () => ({ frequency: 14_074_000 }),
    } as any);
    const getRadioFrequency = vi.fn(async () => 50_313_000);
    const provider = {
      hasWorkedCallsign: vi.fn(async (_callsign: string, options?: { band?: string }) => options?.band === '20m'),
    };
    const { manager } = createManager({
      logBook: { id: 'log-1', name: 'Test Log', provider },
      getKnownRadioFrequency: () => null,
      getRadioFrequency,
    });

    await expect(manager.hasWorkedCallsign('op1', 'BG7OO')).resolves.toBe(true);
    expect(provider.hasWorkedCallsign).toHaveBeenLastCalledWith('BG7OO', { band: '20m' });
    expect(getRadioFrequency).not.toHaveBeenCalled();
  });

  it('can check any band when requested by a plugin', async () => {
    const getRadioFrequency = vi.fn(async () => 14_074_000);
    const provider = {
      hasWorkedCallsign: vi.fn(async (_callsign: string, options?: { band?: string }) => !options?.band),
    };
    const { manager } = createManager({
      logBook: { id: 'log-1', name: 'Test Log', provider },
      getKnownRadioFrequency: () => 14_074_000,
      getRadioFrequency,
    });

    await expect(manager.hasWorkedCallsign('op1', 'BG7OO', { anyBand: true })).resolves.toBe(true);
    expect(provider.hasWorkedCallsign).toHaveBeenLastCalledWith('BG7OO', {});
    expect(getRadioFrequency).not.toHaveBeenCalled();
  });

  it('treats unknown current band as not worked', async () => {
    vi.spyOn(ConfigManager, 'getInstance').mockReturnValue({
      getLastSelectedFrequency: () => ({ frequency: 999_000 }),
    } as any);
    const provider = {
      hasWorkedCallsign: vi.fn(async () => true),
    };
    const { manager } = createManager({
      logBook: { id: 'log-1', name: 'Test Log', provider },
      getKnownRadioFrequency: () => 0,
    });

    await expect(manager.hasWorkedCallsign('op1', 'BG7OO')).resolves.toBe(false);
    expect(provider.hasWorkedCallsign).not.toHaveBeenCalled();
  });

  it('keeps worked-station-bias style concurrent checks off the live radio path', async () => {
    const getRadioFrequency = vi.fn(async () => {
      throw new Error('live RF read should not run during worked checks');
    });
    const provider = {
      hasWorkedCallsign: vi.fn(async (_callsign: string, options?: { band?: string }) => options?.band === '20m'),
    };
    const { manager } = createManager({
      logBook: { id: 'log-1', name: 'Test Log', provider },
      getKnownRadioFrequency: () => 14_074_000,
      getRadioFrequency,
    });

    await Promise.all(
      Array.from({ length: 32 }, (_, index) => manager.hasWorkedCallsign('op1', `BG${index}ZZ`)),
    );

    expect(provider.hasWorkedCallsign).toHaveBeenCalledTimes(32);
    expect(provider.hasWorkedCallsign).toHaveBeenLastCalledWith('BG31ZZ', { band: '20m' });
    expect(getRadioFrequency).not.toHaveBeenCalled();
  });
});

describe('RadioOperatorManager operator status payloads', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not include cycleInfo in operator status updates', async () => {
    const { manager, eventEmitter } = createManager({
      logBook: { id: 'log-1', name: 'Test Log', provider: {} },
      clockNow: 14_999,
    });
    await manager.addOperator({
      id: 'op1',
      myCallsign: 'BG5DRB',
      myGrid: 'PM01',
      frequency: 1000,
      transmitCycles: [0],
    } as RadioOperatorConfig);
    manager.start();

    const statusSpy = vi.fn();
    eventEmitter.on('operatorStatusUpdate' as any, statusSpy);

    manager.emitOperatorStatusUpdate('op1');

    expect(statusSpy).toHaveBeenCalledTimes(1);
    expect(statusSpy.mock.calls[0]?.[0]).not.toHaveProperty('cycleInfo');
  });

  it('does not rebroadcast operator status only because the clock moved to another slot', async () => {
    const { manager, eventEmitter, clockSource } = createManager({
      logBook: { id: 'log-1', name: 'Test Log', provider: {} },
      clockNow: 0,
    });
    await manager.addOperator({
      id: 'op1',
      myCallsign: 'BG5DRB',
      myGrid: 'PM01',
      frequency: 1000,
      transmitCycles: [0],
    } as RadioOperatorConfig);
    manager.start();

    const statusSpy = vi.fn();
    eventEmitter.on('operatorStatusUpdate' as any, statusSpy);

    manager.emitOperatorStatusUpdate('op1');
    clockSource.now.mockReturnValue(MODES.FT8.slotMs);
    manager.emitOperatorStatusUpdate('op1');

    expect(statusSpy).toHaveBeenCalledTimes(1);
  });
});

describe('RadioOperatorManager fake frequency dial shift', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function addTxOperator(manager: RadioOperatorManager, id: string, frequency: number) {
    await manager.addOperator({
      id,
      myCallsign: 'BG4IAJ',
      myGrid: 'OM96',
      frequency,
      transmitCycles: [0],
      mode: MODES.FT8,
    });
    const operator = manager.getOperatorById(id);
    expect(operator).toBeDefined();
    operator!.start();
    return operator!;
  }

  function queueAndProcess(
    manager: RadioOperatorManager,
    eventEmitter: EventEmitter<DigitalRadioEngineEvents>,
    operatorIds: string[],
    slotStartMs: number,
  ) {
    for (const id of operatorIds) {
      eventEmitter.emit('requestTransmit' as any, {
        operatorId: id,
        transmission: 'CQ BG4IAJ OM96',
      });
    }
    manager.processPendingTransmissions(createSlotInfo(slotStartMs));
  }

  function mockConfigManager() {
    return vi.spyOn(ConfigManager, 'getInstance').mockReturnValue({
      updateOperatorConfig: vi.fn().mockResolvedValue(undefined),
      getOperatorConfig: vi.fn(() => undefined),
      getFT8Config: () => ({ maxSameTransmissionCount: 20 }),
    } as any);
  }

  it('attaches the frozen shift to the encode request and centers a single operator', async () => {
    const encodeQueue = { push: vi.fn() };
    const { manager, eventEmitter } = createManager({
      logBook: { id: 'log-1', name: 'Test Log', provider: {} },
      callsign: 'BG4IAJ',
      clockNow: 0,
      encodeQueue,
      getFakeFrequencyEnabled: () => true,
    });
    await addTxOperator(manager, 'op1', 2400);
    manager.start();

    queueAndProcess(manager, eventEmitter, ['op1'], 0);

    expect(encodeQueue.push).toHaveBeenCalledTimes(1);
    expect(encodeQueue.push.mock.calls[0][0]).toMatchObject({
      operatorId: 'op1',
      frequency: 1500, // 2400 - 900 → 甜区
      txDialShiftHz: 900, // 2400 - 1500
    });
  });

  it('uses the min/max center and shifts every operator by the same amount', async () => {
    const encodeQueue = { push: vi.fn() };
    const { manager, eventEmitter } = createManager({
      logBook: { id: 'log-1', name: 'Test Log', provider: {} },
      callsign: 'BG4IAJ',
      clockNow: 0,
      encodeQueue,
      getFakeFrequencyEnabled: () => true,
    });
    await addTxOperator(manager, 'op1', 1200);
    await addTxOperator(manager, 'op2', 2400);
    manager.start();

    queueAndProcess(manager, eventEmitter, ['op1', 'op2'], 0);

    // center = (1200 + 2400) / 2 = 1800 → shift = 300，两操作员同量平移
    expect(encodeQueue.push).toHaveBeenCalledTimes(2);
    const byId: Record<string, any> = Object.fromEntries(
      encodeQueue.push.mock.calls.map((c: any[]) => [c[0].operatorId, c[0]]),
    );
    expect(byId.op1).toMatchObject({ frequency: 900, txDialShiftHz: 300 });
    expect(byId.op2).toMatchObject({ frequency: 2100, txDialShiftHz: 300 });
  });

  it('does not shift when the center is within the hysteresis band', async () => {
    const encodeQueue = { push: vi.fn() };
    const { manager, eventEmitter } = createManager({
      logBook: { id: 'log-1', name: 'Test Log', provider: {} },
      callsign: 'BG4IAJ',
      clockNow: 0,
      encodeQueue,
      getFakeFrequencyEnabled: () => true,
    });
    await addTxOperator(manager, 'op1', 1550); // |1550 - 1500| = 50 <= 200 → 不平移
    manager.start();

    queueAndProcess(manager, eventEmitter, ['op1'], 0);

    expect(encodeQueue.push.mock.calls[0][0]).toMatchObject({
      operatorId: 'op1',
      frequency: 1550,
      txDialShiftHz: 0,
    });
  });

  it('defers a mid-slot frequency change to the next slot once the shift is committed', async () => {
    const encodeQueue = { push: vi.fn() };
    const { manager, eventEmitter } = createManager({
      logBook: { id: 'log-1', name: 'Test Log', provider: {} },
      callsign: 'BG4IAJ',
      clockNow: 0,
      encodeQueue,
      getFakeFrequencyEnabled: () => true,
    });
    mockConfigManager();
    await addTxOperator(manager, 'op1', 2400);
    manager.start();

    queueAndProcess(manager, eventEmitter, ['op1'], 0); // 提交本时隙 shift
    manager.updateActiveTransmissionOperators(['op1']);

    const retrigger = vi.spyOn(manager as any, 'checkAndTriggerTransmission').mockImplementation(() => {});
    await manager.updateOperatorContext('op1', { frequency: 1000 });

    // 已提交：不重编码，仅更新 config 供下一时隙采纳
    expect(retrigger).not.toHaveBeenCalled();
    expect(manager.getOperatorById('op1')?.config.frequency).toBe(1000);
  });

  it('re-triggers immediately when fake frequency is disabled (no regression)', async () => {
    const encodeQueue = { push: vi.fn() };
    const { manager, eventEmitter } = createManager({
      logBook: { id: 'log-1', name: 'Test Log', provider: {} },
      callsign: 'BG4IAJ',
      clockNow: 0,
      encodeQueue,
      getFakeFrequencyEnabled: () => false,
    });
    mockConfigManager();
    await addTxOperator(manager, 'op1', 2400);
    manager.start();

    queueAndProcess(manager, eventEmitter, ['op1'], 0);
    manager.updateActiveTransmissionOperators(['op1']);

    const retrigger = vi.spyOn(manager as any, 'checkAndTriggerTransmission').mockImplementation(() => {});
    await manager.updateOperatorContext('op1', { frequency: 1000 });

    expect(retrigger).toHaveBeenCalledTimes(1);
  });
});
