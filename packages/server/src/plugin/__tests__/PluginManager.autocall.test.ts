import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'eventemitter3';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DigitalRadioEngineEvents, LogbookAnalysis, SlotInfo, SlotPack } from '@tx5dr/contracts';
import { MODES } from '@tx5dr/contracts';
import { RadioOperator } from '@tx5dr/core';
import { PluginManager } from '../PluginManager.js';

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

function createSlotPack(
  slotInfo: SlotInfo,
  frames: Array<{ message: string; snr?: number; freq?: number }>,
): SlotPack {
  return {
    slotId: slotInfo.id,
    startMs: slotInfo.startMs,
    endMs: slotInfo.startMs + MODES.FT8.slotMs,
    frames: frames.map((frame) => ({
      message: frame.message,
      snr: frame.snr ?? -10,
      dt: 0,
      freq: frame.freq ?? 1500,
      confidence: 0.9,
    })),
    stats: {
      totalDecodes: frames.length,
      successfulDecodes: frames.length,
      totalFramesBeforeDedup: frames.length,
      totalFramesAfterDedup: frames.length,
      lastUpdated: slotInfo.startMs,
    },
    decodeHistory: [],
  };
}

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('PluginManager autocall arbitration and novelty watch', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function createHarness(options?: {
    startOperator?: boolean;
    autoReplyToCQ?: boolean;
    operatorFrequency?: number;
    pluginConfigs?: Record<string, { enabled: boolean; settings: Record<string, unknown> }>;
    operatorPluginSettings?: Record<string, Record<string, unknown>>;
    analyzeCallsign?: (callsign: string, grid?: string) => LogbookAnalysis | null | Promise<LogbookAnalysis | null>;
    findBestTransmitFrequency?: (slotId: string) => number | undefined;
  }) {
    const eventEmitter = new EventEmitter<DigitalRadioEngineEvents>();
    eventEmitter.on('checkHasWorkedCallsign' as any, (data: { requestId: string }) => {
      eventEmitter.emit('hasWorkedCallsignResponse' as any, {
        requestId: data.requestId,
        hasWorked: false,
      });
    });

    const operator = new RadioOperator({
      id: 'operator-1',
      mode: MODES.FT8,
      myCallsign: 'BG4IAJ',
      myGrid: 'OM96',
      frequency: options?.operatorFrequency ?? 1000,
      transmitCycles: [0],
      maxQSOTimeoutCycles: 6,
      maxCallAttempts: 5,
      autoReplyToCQ: options?.autoReplyToCQ ?? false,
      autoResumeCQAfterFail: false,
      autoResumeCQAfterSuccess: false,
      replyToWorkedStations: false,
      prioritizeNewCalls: true,
      targetSelectionPriorityMode: 'dxcc_first',
    }, eventEmitter);

    const dataDir = await mkdtemp(join(tmpdir(), 'tx5dr-plugin-autocall-'));
    tempDirs.push(dataDir);

    let pluginManager!: PluginManager;
    pluginManager = new PluginManager({
      eventEmitter,
      getOperators: () => [operator],
      getOperatorById: (id) => (id === operator.config.id ? operator : undefined),
      getCurrentMode: () => operator.config.mode,
      getOperatorAutomationSnapshot: (id) => pluginManager.getOperatorAutomationSnapshot(id),
      requestOperatorCall: (operatorId, callsign, lastMessage) => {
        pluginManager.requestCall(operatorId, callsign, lastMessage);
      },
      getRadioFrequency: async () => operator.config.frequency,
      setRadioFrequency: () => {},
      getRadioBand: () => '40m',
      getRadioConnected: () => true,
      getLatestSlotPack: () => null,
      findBestTransmitFrequency: options?.findBestTransmitFrequency,
      setOperatorAudioFrequency: async (operatorId, frequency) => {
        if (operatorId === operator.config.id) {
          operator.config.frequency = frequency;
        }
      },
      interruptOperatorTransmission: async () => {},
      hasWorkedCallsign: async () => false,
      analyzeCallsignForOperator: options?.analyzeCallsign
        ? async (_operatorId, callsign, grid) => options.analyzeCallsign?.(callsign, grid) ?? null
        : undefined,
      resetOperatorRuntime: () => {},
      dataDir,
    });

    pluginManager.loadConfig({
      configs: options?.pluginConfigs ?? {},
      operatorStrategies: {
        [operator.config.id]: 'standard-qso',
      },
      operatorSettings: {
        [operator.config.id]: {
          'standard-qso': {
            autoReplyToCQ: options?.autoReplyToCQ ?? false,
            autoResumeCQAfterFail: false,
            autoResumeCQAfterSuccess: false,
            replyToWorkedStations: false,
            targetSelectionPriorityMode: 'dxcc_first',
            maxQSOTimeoutCycles: 6,
            maxCallAttempts: 5,
          },
          ...(options?.operatorPluginSettings ?? {}),
        },
      },
    });

    await pluginManager.start();
    if (options?.startOperator) {
      operator.start();
    }

    return { eventEmitter, operator, pluginManager };
  }

  it('prefers the higher-priority autocall plugin when multiple plugins match the same slot', async () => {
    const { eventEmitter, operator, pluginManager } = await createHarness({
      pluginConfigs: {
        'watched-callsign-autocall': { enabled: true, settings: {} },
        'watched-novelty-autocall': { enabled: true, settings: {} },
      },
      operatorPluginSettings: {
        'watched-callsign-autocall': {
          watchList: ['JA1AAA'],
          triggerMode: 'cq',
          autocallPriority: 100,
          workedCallsignSkipDays: 0,
        },
        'watched-novelty-autocall': {
          watchNewDxcc: true,
          triggerMode: 'cq',
          autocallPriority: 80,
        },
      },
      analyzeCallsign: async (callsign) => {
        if (callsign === 'DX1BBB') {
          return {
            callsign,
            isNewDxccEntity: true,
            dxccStatus: 'current',
            dxccEntity: 'Rare DX',
          };
        }
        return {
          callsign,
          isNewDxccEntity: false,
          dxccStatus: 'current',
        };
      },
    });

    const sourceSlotInfo = createSlotInfo(15_000);
    const slotInfo = createSlotInfo(30_000);
    const slotPack = createSlotPack(sourceSlotInfo, [
      { message: 'CQ DX1BBB OO01' },
      { message: 'CQ JA1AAA PM95' },
    ]);

    eventEmitter.emit('slotStart', slotInfo, slotPack);
    await flushAsyncWork();

    expect(operator.isTransmitting).toBe(true);
    expect(operator.getTransmitCycles()).toEqual([0]);
    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).context?.targetCallsign).toBe('JA1AAA');
  });

  it('triggers watched-novelty-autocall for a new DXCC and ignores deleted DXCC entities', async () => {
    const baseOptions = {
      pluginConfigs: {
        'watched-novelty-autocall': { enabled: true, settings: {} },
      },
      operatorPluginSettings: {
        'watched-novelty-autocall': {
          watchNewDxcc: true,
          triggerMode: 'cq',
          autocallPriority: 80,
        },
      },
    };

    const active = await createHarness({
      ...baseOptions,
      analyzeCallsign: async (callsign) => ({
        callsign,
        isNewDxccEntity: true,
        dxccStatus: 'current',
        dxccEntity: 'Fresh DX',
      }),
    });
    const activeSlot = createSlotInfo(30_000);
    active.eventEmitter.emit('slotStart', activeSlot, createSlotPack(activeSlot, [
      { message: 'CQ DX2CCC OJ11' },
    ]));
    await flushAsyncWork();
    expect(active.operator.isTransmitting).toBe(true);
    expect(active.pluginManager.getOperatorRuntimeStatus(active.operator.config.id).context?.targetCallsign).toBe('DX2CCC');

    const deleted = await createHarness({
      ...baseOptions,
      analyzeCallsign: async (callsign) => ({
        callsign,
        isNewDxccEntity: true,
        dxccStatus: 'deleted',
        dxccEntity: 'Deleted DX',
      }),
    });
    const deletedSlot = createSlotInfo(45_000);
    deleted.eventEmitter.emit('slotStart', deletedSlot, createSlotPack(deletedSlot, [
      { message: 'CQ DX3DDD OJ11' },
    ]));
    await flushAsyncWork();
    expect(deleted.operator.isTransmitting).toBe(false);
    expect(deleted.pluginManager.getOperatorRuntimeStatus(deleted.operator.config.id).context?.targetCallsign).toBeUndefined();
  });

  it('applies hard candidate filters before watched novelty autocall proposals', async () => {
    const { eventEmitter, operator, pluginManager } = await createHarness({
      pluginConfigs: {
        'snr-filter': {
          enabled: true,
          settings: {
            minSNR: -10,
          },
        },
        'watched-novelty-autocall': { enabled: true, settings: {} },
      },
      operatorPluginSettings: {
        'watched-novelty-autocall': {
          watchNewDxcc: true,
          triggerMode: 'cq',
          autocallPriority: 80,
        },
      },
      analyzeCallsign: async (callsign) => ({
        callsign,
        isNewDxccEntity: true,
        dxccStatus: 'current',
        dxccEntity: 'Fresh DX',
      }),
    });

    const slotInfo = createSlotInfo(60_000);
    eventEmitter.emit('slotStart', slotInfo, createSlotPack(slotInfo, [
      { message: 'CQ DX4LOW OJ11', snr: -18 },
    ]));
    await flushAsyncWork();

    expect(operator.isTransmitting).toBe(false);
    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).context?.targetCallsign).toBeUndefined();
  });

  it('does not let weak novelty autocall overtake a higher-SNR normal candidate when SNR priority is enabled', async () => {
    const { eventEmitter, operator, pluginManager } = await createHarness({
      pluginConfigs: {
        'snr-filter': {
          enabled: true,
          settings: {
            minSNR: -30,
            prioritizeHigherSNR: true,
          },
        },
        'watched-novelty-autocall': { enabled: true, settings: {} },
      },
      operatorPluginSettings: {
        'watched-novelty-autocall': {
          watchNewGrid: true,
          triggerMode: 'cq',
          autocallPriority: 80,
        },
      },
      analyzeCallsign: async (callsign) => ({
        callsign,
        isNewGrid: callsign === 'DX4LOW',
        dxccStatus: 'current',
      }),
    });

    const slotInfo = createSlotInfo(60_000);
    eventEmitter.emit('slotStart', slotInfo, createSlotPack(slotInfo, [
      { message: 'CQ DX4LOW OJ11', snr: -16 },
      { message: 'CQ JA1AAA PM95', snr: -3 },
    ]));
    await flushAsyncWork();

    expect(operator.isTransmitting).toBe(false);
    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).context?.targetCallsign).toBeUndefined();
  });

  it('allows novelty autocall when the new grid is also the highest-SNR candidate', async () => {
    const { eventEmitter, operator, pluginManager } = await createHarness({
      pluginConfigs: {
        'snr-filter': {
          enabled: true,
          settings: {
            minSNR: -30,
            prioritizeHigherSNR: true,
          },
        },
        'watched-novelty-autocall': { enabled: true, settings: {} },
      },
      operatorPluginSettings: {
        'watched-novelty-autocall': {
          watchNewGrid: true,
          triggerMode: 'cq',
          autocallPriority: 80,
        },
      },
      analyzeCallsign: async (callsign) => ({
        callsign,
        isNewGrid: callsign === 'DX4HIGH',
        dxccStatus: 'current',
      }),
    });

    const slotInfo = createSlotInfo(75_000);
    eventEmitter.emit('slotStart', slotInfo, createSlotPack(slotInfo, [
      { message: 'CQ DX4HIGH OJ11', snr: -3 },
      { message: 'CQ JA1AAA PM95', snr: -16 },
    ]));
    await flushAsyncWork();

    expect(operator.isTransmitting).toBe(true);
    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).context?.targetCallsign).toBe('DX4HIGH');
  });

  it('ranks autocall proposals by source score before plugin priority when SNR priority is enabled', async () => {
    const { eventEmitter, operator, pluginManager } = await createHarness({
      pluginConfigs: {
        'snr-filter': {
          enabled: true,
          settings: {
            minSNR: -30,
            prioritizeHigherSNR: true,
          },
        },
        'watched-callsign-autocall': { enabled: true, settings: {} },
        'watched-novelty-autocall': { enabled: true, settings: {} },
      },
      operatorPluginSettings: {
        'watched-callsign-autocall': {
          watchList: ['JA1AAA'],
          triggerMode: 'cq',
          autocallPriority: 10,
          workedCallsignSkipDays: 0,
        },
        'watched-novelty-autocall': {
          watchNewDxcc: true,
          triggerMode: 'cq',
          autocallPriority: 100,
        },
      },
      analyzeCallsign: async (callsign) => ({
        callsign,
        isNewDxccEntity: callsign === 'DX4LOW',
        dxccStatus: 'current',
      }),
    });

    const slotInfo = createSlotInfo(90_000);
    eventEmitter.emit('slotStart', slotInfo, createSlotPack(slotInfo, [
      { message: 'CQ DX4LOW OJ11', snr: -16 },
      { message: 'CQ JA1AAA PM95', snr: -3 },
    ]));
    await flushAsyncWork();

    expect(operator.isTransmitting).toBe(true);
    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).context?.targetCallsign).toBe('JA1AAA');
  });

  it('applies no-reply memory before watched novelty autocall proposals', async () => {
    const { eventEmitter, operator, pluginManager } = await createHarness({
      pluginConfigs: {
        'no-reply-memory-filter': {
          enabled: true,
          settings: {},
        },
        'watched-novelty-autocall': { enabled: true, settings: {} },
      },
      operatorPluginSettings: {
        'watched-novelty-autocall': {
          watchNewDxcc: true,
          triggerMode: 'cq',
          autocallPriority: 80,
        },
      },
      analyzeCallsign: async (callsign) => ({
        callsign,
        isNewDxccEntity: true,
        dxccStatus: 'current',
        dxccEntity: 'Fresh DX',
      }),
    });

    await pluginManager.notifyQSOFail(operator.config.id, {
      targetCallsign: 'DX5MEM',
      reason: 'tx1_max_call_attempts',
      stage: 'TX1',
      unansweredTransmissions: 8,
      hadTargetReply: false,
    });
    await pluginManager.notifyQSOFail(operator.config.id, {
      targetCallsign: 'DX5MEM',
      reason: 'tx1_max_call_attempts',
      stage: 'TX1',
      unansweredTransmissions: 8,
      hadTargetReply: false,
    });

    const slotInfo = createSlotInfo(75_000);
    eventEmitter.emit('slotStart', slotInfo, createSlotPack(slotInfo, [
      { message: 'CQ DX5MEM OJ11', snr: -5 },
    ]));
    await flushAsyncWork();

    expect(operator.isTransmitting).toBe(false);
    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).context?.targetCallsign).toBeUndefined();
  });

  it('can auto-select an idle transmit frequency before accepting an autocall proposal', async () => {
    const observedSlotIds: string[] = [];
    const { eventEmitter, operator } = await createHarness({
      operatorFrequency: 1000,
      pluginConfigs: {
        'watched-callsign-autocall': { enabled: true, settings: {} },
      },
      operatorPluginSettings: {
        'autocall-idle-frequency': {
          autoSelectIdleFrequency: true,
        },
        'watched-callsign-autocall': {
          watchList: ['JA1AAA'],
          triggerMode: 'cq',
          autocallPriority: 100,
          workedCallsignSkipDays: 0,
        },
      },
      findBestTransmitFrequency: (slotId) => {
        observedSlotIds.push(slotId);
        return 1825;
      },
    });

    const sourceSlotInfo = createSlotInfo(75_000);
    const slotInfo = createSlotInfo(90_000);
    const slotPack = createSlotPack(sourceSlotInfo, [
      { message: 'CQ JA1AAA PM95', freq: 1100 },
      { message: 'CQ DX1BBB OO01', freq: 1500 },
    ]);

    eventEmitter.emit('slotStart', slotInfo, slotPack);
    await flushAsyncWork();

    expect(observedSlotIds).toEqual([sourceSlotInfo.id]);
    expect(operator.config.frequency).toBe(1825);
    expect(operator.isTransmitting).toBe(true);
  });

  it('rejects watched autocall proposals when a directed CQ modifier excludes my station identity', async () => {
    const { eventEmitter, operator, pluginManager } = await createHarness({
      pluginConfigs: {
        'watched-callsign-autocall': { enabled: true, settings: {} },
      },
      operatorPluginSettings: {
        'watched-callsign-autocall': {
          watchList: ['K1ABC'],
          triggerMode: 'cq',
          autocallPriority: 100,
          workedCallsignSkipDays: 0,
        },
      },
    });

    const slotInfo = createSlotInfo(75_000);
    const slotPack = createSlotPack(slotInfo, [
      { message: 'CQ EU K1ABC FN31', freq: 1100 },
    ]);

    eventEmitter.emit('slotStart', slotInfo, slotPack);
    await flushAsyncWork();

    expect(operator.isTransmitting).toBe(false);
    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).context?.targetCallsign).toBeUndefined();
  });

  it('treats CQ DX as intercontinental-only for watched autocall proposals', async () => {
    const sameContinent = await createHarness({
      pluginConfigs: {
        'watched-callsign-autocall': { enabled: true, settings: {} },
      },
      operatorPluginSettings: {
        'watched-callsign-autocall': {
          watchList: ['JA1AAA'],
          triggerMode: 'cq',
          autocallPriority: 100,
          workedCallsignSkipDays: 0,
        },
      },
    });

    const sameSlot = createSlotInfo(75_000);
    sameContinent.eventEmitter.emit('slotStart', sameSlot, createSlotPack(sameSlot, [
      { message: 'CQ DX JA1AAA PM95', freq: 1100 },
    ]));
    await flushAsyncWork();

    expect(sameContinent.operator.isTransmitting).toBe(false);
    expect(sameContinent.pluginManager.getOperatorRuntimeStatus(sameContinent.operator.config.id).context?.targetCallsign).toBeUndefined();

    const intercontinental = await createHarness({
      pluginConfigs: {
        'watched-callsign-autocall': { enabled: true, settings: {} },
      },
      operatorPluginSettings: {
        'watched-callsign-autocall': {
          watchList: ['K1ABC'],
          triggerMode: 'cq',
          autocallPriority: 100,
          workedCallsignSkipDays: 0,
        },
      },
    });

    const dxSlot = createSlotInfo(90_000);
    intercontinental.eventEmitter.emit('slotStart', dxSlot, createSlotPack(dxSlot, [
      { message: 'CQ DX K1ABC FN31', freq: 1100 },
    ]));
    await flushAsyncWork();

    expect(intercontinental.operator.isTransmitting).toBe(true);
    expect(intercontinental.pluginManager.getOperatorRuntimeStatus(intercontinental.operator.config.id).context?.targetCallsign).toBe('K1ABC');
  });

  it('conservatively rejects watched novelty autocall on unsupported activity modifiers', async () => {
    const { eventEmitter, operator, pluginManager } = await createHarness({
      pluginConfigs: {
        'watched-novelty-autocall': { enabled: true, settings: {} },
      },
      operatorPluginSettings: {
        'watched-novelty-autocall': {
          watchNewDxcc: true,
          triggerMode: 'cq',
          autocallPriority: 80,
        },
      },
      analyzeCallsign: async (callsign) => ({
        callsign,
        isNewDxccEntity: true,
        dxccStatus: 'current',
        dxccEntity: 'Fresh DX',
      }),
    });

    const slotInfo = createSlotInfo(105_000);
    eventEmitter.emit('slotStart', slotInfo, createSlotPack(slotInfo, [
      { message: 'CQ POTA DX2CCC OJ11' },
    ]));
    await flushAsyncWork();

    expect(operator.isTransmitting).toBe(false);
    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).context?.targetCallsign).toBeUndefined();
  });

  it('uses the matched decode slot to choose the reply cycle for autocall proposals', async () => {
    const { eventEmitter, operator, pluginManager } = await createHarness({
      pluginConfigs: {
        'watched-callsign-autocall': { enabled: true, settings: {} },
      },
      operatorPluginSettings: {
        'watched-callsign-autocall': {
          watchList: ['JA1AAA'],
          triggerMode: 'cq',
          autocallPriority: 100,
          workedCallsignSkipDays: 0,
        },
      },
    });

    const decodeSlot = createSlotInfo(60_000);
    const currentSlot = createSlotInfo(75_000);
    const previousSlotPack = createSlotPack(decodeSlot, [
      { message: 'CQ JA1AAA PM95', freq: 1100 },
    ]);

    eventEmitter.emit('slotStart', currentSlot, previousSlotPack);
    await flushAsyncWork();

    expect(operator.isTransmitting).toBe(true);
    expect(operator.getTransmitCycles()).toEqual([decodeSlot.cycleNumber === 0 ? 1 : 0]);
    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).context?.targetCallsign).toBe('JA1AAA');
  });

  it('enriches parsed messages with operator-specific logbook analysis before standard-qso selects a target', async () => {
    const { eventEmitter, operator, pluginManager } = await createHarness({
      startOperator: true,
      autoReplyToCQ: true,
      analyzeCallsign: async (callsign) => {
        if (callsign === 'DX9NEW') {
          return {
            callsign,
            isNewDxccEntity: true,
            isNewCallsign: true,
            dxccStatus: 'current',
            dxccEntity: 'Rare DX',
          };
        }
        return {
          callsign,
          isNewDxccEntity: false,
          isNewCallsign: false,
          dxccStatus: 'current',
          dxccEntity: 'Worked DX',
        };
      },
    });

    const slotInfo = createSlotInfo(60_000);
    const slotPack = createSlotPack(slotInfo, [
      { message: 'CQ OLD1AA PM95', snr: -8, freq: 1200 },
      { message: 'CQ DX9NEW QL22', snr: -12, freq: 1300 },
    ]);

    eventEmitter.emit('slotStart', slotInfo, slotPack);
    await flushAsyncWork();

    const runtimeStatus = pluginManager.getOperatorRuntimeStatus(operator.config.id);
    expect(runtimeStatus.currentSlot).toBe('TX1');
    expect(runtimeStatus.context?.targetCallsign).toBe('DX9NEW');
  });
});
