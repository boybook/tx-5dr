import EventEmitter from 'eventemitter3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { DigitalRadioEngineEvents, FrameMessage, QSORecord, RadioOperatorConfig, SlotInfo, SlotPack } from '@tx5dr/contracts';
import { FT8MessageType, MODES } from '@tx5dr/contracts';

import { FT8MessageParser } from '@tx5dr/core';
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
}) {
  const eventEmitter = new EventEmitter<DigitalRadioEngineEvents>();
  const slotPackManager = {
    getActiveSlotPacks: vi.fn(() => options.activeSlotPacks ?? []),
    readStoredRecords: vi.fn(async () => options.storedRecords ?? []),
  };
  const encodeQueue = options.encodeQueue ?? { push: vi.fn() };
  const clockSource = {
    now: vi.fn(() => options.clockNow ?? 0),
  };

  const fakeLogManager = {
    getOperatorLogBook: vi.fn().mockResolvedValue(options.logBook),
    getOperatorCallsign: vi.fn().mockReturnValue(options.callsign ?? null),
    getOrCreateLogBookByCallsign: vi.fn().mockResolvedValue(options.logBook),
    registerOperatorCallsign: vi.fn(),
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
