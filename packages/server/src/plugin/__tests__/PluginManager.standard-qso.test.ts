import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'eventemitter3';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DigitalRadioEngineEvents, ParsedFT8Message, SlotInfo, SlotPack } from '@tx5dr/contracts';
import { FT8MessageType, MODES } from '@tx5dr/contracts';
import { FT8MessageParser, RadioOperator } from '@tx5dr/core';
import type { ScoredCandidate } from '@tx5dr/plugin-api';
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
  frames: Array<{
    message: string;
    snr: number;
    freq: number;
    operatorId?: string;
  }>,
): SlotPack {
  return {
    slotId: slotInfo.id,
    startMs: slotInfo.startMs,
    endMs: slotInfo.startMs + MODES.FT8.slotMs,
    frames: frames.map((frame) => ({
      message: frame.message,
      snr: frame.snr,
      dt: 0,
      freq: frame.freq,
      confidence: 0.9,
      operatorId: frame.operatorId,
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

function createParsedMessage(rawMessage: string, snr = -10, df = 1500): ParsedFT8Message {
  return {
    snr,
    dt: 0,
    df,
    rawMessage,
    message: FT8MessageParser.parseMessage(rawMessage),
    slotId: 'slot-test',
    timestamp: Date.now(),
  };
}

function getSenderCallsign(message: ParsedFT8Message['message']): string {
  return 'senderCallsign' in message && typeof message.senderCallsign === 'string'
    ? message.senderCallsign
    : '';
}

async function writeUserPlugin(
  dataDir: string,
  pluginName: string,
  source: string,
): Promise<void> {
  const pluginDir = join(dataDir, 'plugins', pluginName);
  await mkdir(pluginDir, { recursive: true });
  await writeFile(join(pluginDir, 'index.mjs'), source, 'utf8');
}

describe('PluginManager standard-qso late re-decision', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function createRuntimeHarness(options?: {
    myCallsign?: string;
    myGrid?: string;
    targetCallsign?: string;
    startOperator?: boolean;
    autoReplyToCQ?: boolean;
    autoResumeCQAfterFail?: boolean;
    autoResumeCQAfterSuccess?: boolean;
    maxQSOTimeoutCycles?: number;
    maxCallAttempts?: number;
    replyToWorkedStations?: boolean;
    hasWorkedCallsign?: boolean | ((callsign: string) => boolean | Promise<boolean>);
    pluginConfigs?: Record<string, { enabled: boolean; settings: Record<string, unknown> }>;
    operatorPluginSettings?: Record<string, Record<string, unknown>>;
    interruptOperatorTransmission?: (operatorId: string) => Promise<void>;
  }) {
    const eventEmitter = new EventEmitter<DigitalRadioEngineEvents>();
    eventEmitter.on('checkHasWorkedCallsign' as any, (data: { requestId: string; callsign: string }) => {
      const result = typeof options?.hasWorkedCallsign === 'function'
        ? options.hasWorkedCallsign(data.callsign)
        : (options?.hasWorkedCallsign ?? false);
      void Promise.resolve(result).then((hasWorked) => {
        eventEmitter.emit('hasWorkedCallsignResponse' as any, {
          requestId: data.requestId,
          hasWorked,
        });
      });
    });

    const operator = new RadioOperator({
      id: 'operator-1',
      mode: MODES.FT8,
      myCallsign: options?.myCallsign ?? 'BG4IAJ',
      myGrid: options?.myGrid ?? 'OM96',
      frequency: 7074000,
      transmitCycles: [0],
      maxQSOTimeoutCycles: options?.maxQSOTimeoutCycles ?? 6,
      maxCallAttempts: options?.maxCallAttempts ?? 5,
      autoReplyToCQ: options?.autoReplyToCQ ?? false,
      autoResumeCQAfterFail: options?.autoResumeCQAfterFail ?? false,
      autoResumeCQAfterSuccess: options?.autoResumeCQAfterSuccess ?? false,
      replyToWorkedStations: options?.replyToWorkedStations ?? false,
      prioritizeNewCalls: true,
      targetSelectionPriorityMode: 'dxcc_first',
    }, eventEmitter);

    const dataDir = await mkdtemp(join(tmpdir(), 'tx5dr-plugin-test-'));
    tempDirs.push(dataDir);
    const interruptOperatorTransmission = options?.interruptOperatorTransmission
      ?? (async () => undefined);

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
      interruptOperatorTransmission,
      hasWorkedCallsign: async (_operatorId, callsign) => {
        if (typeof options?.hasWorkedCallsign === 'function') {
          return options.hasWorkedCallsign(callsign);
        }
        return options?.hasWorkedCallsign ?? false;
      },
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
            autoReplyToCQ: operator.config.autoReplyToCQ,
            autoResumeCQAfterFail: operator.config.autoResumeCQAfterFail,
            autoResumeCQAfterSuccess: operator.config.autoResumeCQAfterSuccess,
            replyToWorkedStations: operator.config.replyToWorkedStations,
            targetSelectionPriorityMode: operator.config.targetSelectionPriorityMode,
            maxQSOTimeoutCycles: operator.config.maxQSOTimeoutCycles,
            maxCallAttempts: operator.config.maxCallAttempts,
          },
          ...(options?.operatorPluginSettings ?? {}),
        },
      },
    });

    await pluginManager.start();
    if (options?.startOperator ?? true) {
      operator.start();
    }

    if (options?.targetCallsign) {
      patchRuntimeContext(pluginManager, operator.config.id, {
        targetCallsign: options.targetCallsign,
        targetGrid: 'OL32',
        reportSent: 6,
        reportReceived: -16,
      });
    }

    return {
      dataDir,
      eventEmitter,
      interruptOperatorTransmission,
      operator,
      pluginManager,
    };
  }

  function patchRuntimeContext(
    pluginManager: PluginManager,
    operatorId: string,
    patch: {
      targetCallsign?: string;
      targetGrid?: string;
      reportSent?: number;
      reportReceived?: number;
    },
  ): void {
    pluginManager.patchOperatorRuntimeContext(operatorId, patch);
  }

  function setRuntimeState(
    pluginManager: PluginManager,
    operatorId: string,
    state: 'TX1' | 'TX2' | 'TX3' | 'TX4' | 'TX5' | 'TX6',
  ): void {
    pluginManager.setOperatorRuntimeState(operatorId, state);
  }

  function getCurrentTransmission(pluginManager: PluginManager, operatorId: string): string | null {
    return pluginManager.getCurrentTransmission(operatorId);
  }

  it('re-decides late R-report and advances the standard-qso runtime', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      targetCallsign: 'BG5DRB',
    });

    patchRuntimeContext(pluginManager, operator.config.id, {
      targetCallsign: 'BG5DRB',
      targetGrid: 'OM96',
      reportSent: -6,
    });
    setRuntimeState(pluginManager, operator.config.id, 'TX2');

    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX2');
    const initialTransmission = getCurrentTransmission(pluginManager, operator.config.id);
    expect(initialTransmission).toMatch(/BG5DRB BG4IAJ/);
    expect(initialTransmission).toMatch(/-0?6/);

    const currentTxSlot = createSlotInfo(30_000);
    const txEchoPack = createSlotPack(currentTxSlot, [{
      message: initialTransmission ?? '',
      snr: -999,
      freq: 1531,
      operatorId: operator.config.id,
    }]);
    await (pluginManager as any).handleSlotStart(currentTxSlot, txEchoPack);

    const lateDecodePack = createSlotPack(createSlotInfo(45_000), [{
      message: FT8MessageParser.generateMessage({
        type: FT8MessageType.ROGER_REPORT,
        senderCallsign: 'BG5DRB',
        targetCallsign: 'BG4IAJ',
        report: -5,
      }),
      snr: -4,
      freq: 1531,
    }]);

    const changed = await pluginManager.reDecideOperator(operator.config.id, lateDecodePack);
    expect(changed).toBe(true);
    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX4');

    const reDecidedTransmission = getCurrentTransmission(pluginManager, operator.config.id);
    expect(reDecidedTransmission).not.toBe(initialTransmission);
    expect(reDecidedTransmission).toMatch(/RR73|RRR/);

    const unchanged = await pluginManager.reDecideOperator(operator.config.id, lateDecodePack);
    expect(unchanged).toBe(false);

    await pluginManager.shutdown();
  });

  it('returns to CQ on the next cycle after queueing a single 73 in TX5', async () => {
    const { eventEmitter, operator, pluginManager } = await createRuntimeHarness({
      myCallsign: 'BG7XTV',
      myGrid: 'OL32',
      targetCallsign: 'BG5DRB',
      autoResumeCQAfterSuccess: true,
    });
    const requestTransmitSpy = (payload: { operatorId: string; transmission: string }) => payload;
    const transmissions: Array<{ operatorId: string; transmission: string }> = [];
    eventEmitter.on('requestTransmit', (payload) => {
      transmissions.push(payload);
    });

    setRuntimeState(pluginManager, operator.config.id, 'TX4');
    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX4');

    const rr73Pack = createSlotPack(createSlotInfo(45_000), [{
      message: FT8MessageParser.generateMessage({
        type: FT8MessageType.RRR,
        senderCallsign: 'BG5DRB',
        targetCallsign: 'BG7XTV',
      }),
      snr: 0,
      freq: 1502,
    }]);

    await (pluginManager as any).handleSlotStart(createSlotInfo(60_000), rr73Pack);
    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX5');

    (pluginManager as any).handleEncodeStart(createSlotInfo(60_000));
    expect(transmissions).toHaveLength(1);
    expect(transmissions[0]).toMatchObject({
      operatorId: operator.config.id,
      transmission: 'BG5DRB BG7XTV 73',
    });

    const own73EchoPack = createSlotPack(createSlotInfo(60_000), [{
      message: FT8MessageParser.generateMessage({
        type: FT8MessageType.SEVENTY_THREE,
        senderCallsign: 'BG7XTV',
        targetCallsign: 'BG5DRB',
      }),
      snr: -999,
      freq: 1806,
      operatorId: operator.config.id,
    }]);

    await (pluginManager as any).handleSlotStart(createSlotInfo(75_000), own73EchoPack);
    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX6');

    const nextTransmission = getCurrentTransmission(pluginManager, operator.config.id);
    expect(nextTransmission).toBe('CQ BG7XTV OL32');

    await pluginManager.shutdown();
    void requestTransmitSpy;
  });

  it('does not reply to direct calls from worked stations when replyToWorkedStations is disabled', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      myCallsign: 'BG7XTV',
      myGrid: 'OL32',
      replyToWorkedStations: false,
      hasWorkedCallsign: true,
    });

    await (pluginManager as any).handleSlotStart(createSlotInfo(60_000), createSlotPack(createSlotInfo(45_000), [{
      message: FT8MessageParser.generateMessage({
        type: FT8MessageType.CALL,
        senderCallsign: 'BG5DRB',
        targetCallsign: 'BG7XTV',
        grid: 'PM01',
      }),
      snr: -8,
      freq: 1502,
    }]));

    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX6');
    const transmission = getCurrentTransmission(pluginManager, operator.config.id);
    expect(transmission).toBe('CQ BG7XTV OL32');

    await pluginManager.shutdown();
  });

  it('replies to direct calls from worked stations when replyToWorkedStations is enabled', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      myCallsign: 'BG7XTV',
      myGrid: 'OL32',
      replyToWorkedStations: true,
      hasWorkedCallsign: true,
    });

    await (pluginManager as any).handleSlotStart(createSlotInfo(60_000), createSlotPack(createSlotInfo(45_000), [{
      message: FT8MessageParser.generateMessage({
        type: FT8MessageType.CALL,
        senderCallsign: 'BG5DRB',
        targetCallsign: 'BG7XTV',
        grid: 'PM01',
      }),
      snr: -8,
      freq: 1502,
    }]));

    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX2');
    const transmission = getCurrentTransmission(pluginManager, operator.config.id);
    expect(transmission).toBe('BG5DRB BG7XTV -08');

    await pluginManager.shutdown();
  });

  it('only retries 73 after returning to CQ when the same target sends RR73 again', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      myCallsign: 'BG7XTV',
      myGrid: 'OL32',
      targetCallsign: 'BG5DRB',
      autoResumeCQAfterSuccess: true,
    });

    setRuntimeState(pluginManager, operator.config.id, 'TX4');

    await (pluginManager as any).handleSlotStart(createSlotInfo(60_000), createSlotPack(createSlotInfo(45_000), [{
      message: FT8MessageParser.generateMessage({
        type: FT8MessageType.RRR,
        senderCallsign: 'BG5DRB',
        targetCallsign: 'BG7XTV',
      }),
      snr: 0,
      freq: 1502,
    }]));
    (pluginManager as any).handleEncodeStart(createSlotInfo(60_000));
    await (pluginManager as any).handleSlotStart(createSlotInfo(75_000), createSlotPack(createSlotInfo(60_000), [{
      message: FT8MessageParser.generateMessage({
        type: FT8MessageType.SEVENTY_THREE,
        senderCallsign: 'BG7XTV',
        targetCallsign: 'BG5DRB',
      }),
      snr: -999,
      freq: 1806,
      operatorId: operator.config.id,
    }]));

    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX6');

    await (pluginManager as any).handleSlotStart(createSlotInfo(90_000), createSlotPack(createSlotInfo(75_000), [{
      message: FT8MessageParser.generateMessage({
        type: FT8MessageType.SEVENTY_THREE,
        senderCallsign: 'BG5DRB',
        targetCallsign: 'BG7XTV',
      }),
      snr: 5,
      freq: 1502,
    }]));
    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX6');

    const cqTransmission = getCurrentTransmission(pluginManager, operator.config.id);
    expect(cqTransmission).toBe('CQ BG7XTV OL32');

    await (pluginManager as any).handleSlotStart(createSlotInfo(105_000), createSlotPack(createSlotInfo(90_000), [{
      message: FT8MessageParser.generateMessage({
        type: FT8MessageType.RRR,
        senderCallsign: 'BG5DRB',
        targetCallsign: 'BG7XTV',
      }),
      snr: 5,
      freq: 1502,
    }]));

    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX5');
    const retryTransmission = getCurrentTransmission(pluginManager, operator.config.id);
    expect(retryTransmission).toBe('BG5DRB BG7XTV 73');

    await pluginManager.shutdown();
  });

  it('returns to TX6 and keeps transmitting after a failed QSO when autoResumeCQAfterFail is enabled', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      myCallsign: 'BG7XTV',
      myGrid: 'OL32',
      targetCallsign: 'BG5DRB',
      autoResumeCQAfterFail: true,
      maxQSOTimeoutCycles: 1,
    });

    setRuntimeState(pluginManager, operator.config.id, 'TX2');
    await (pluginManager as any).handleSlotStart(createSlotInfo(60_000), createSlotPack(createSlotInfo(45_000), []));

    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX6');
    expect(operator.isTransmitting).toBe(true);

    const nextTransmission = getCurrentTransmission(pluginManager, operator.config.id);
    expect(nextTransmission).toBe('CQ BG7XTV OL32');

    await pluginManager.shutdown();
  });

  it('returns to TX6 and stops transmitting after a failed QSO when autoResumeCQAfterFail is disabled', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      myCallsign: 'BG7XTV',
      myGrid: 'OL32',
      targetCallsign: 'BG5DRB',
      autoResumeCQAfterFail: false,
      maxQSOTimeoutCycles: 1,
    });

    setRuntimeState(pluginManager, operator.config.id, 'TX2');
    await (pluginManager as any).handleSlotStart(createSlotInfo(60_000), createSlotPack(createSlotInfo(45_000), []));

    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX6');
    expect(operator.isTransmitting).toBe(false);

    await pluginManager.shutdown();
  });

  it('returns to TX6 and stops transmitting after a successful QSO when autoResumeCQAfterSuccess is disabled', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      myCallsign: 'BG7XTV',
      myGrid: 'OL32',
      targetCallsign: 'BG5DRB',
      autoResumeCQAfterSuccess: false,
    });

    setRuntimeState(pluginManager, operator.config.id, 'TX4');
    await (pluginManager as any).handleSlotStart(createSlotInfo(60_000), createSlotPack(createSlotInfo(45_000), [{
      message: FT8MessageParser.generateMessage({
        type: FT8MessageType.RRR,
        senderCallsign: 'BG5DRB',
        targetCallsign: 'BG7XTV',
      }),
      snr: 0,
      freq: 1502,
    }]));
    (pluginManager as any).handleEncodeStart(createSlotInfo(60_000));
    await (pluginManager as any).handleSlotStart(createSlotInfo(75_000), createSlotPack(createSlotInfo(60_000), [{
      message: FT8MessageParser.generateMessage({
        type: FT8MessageType.SEVENTY_THREE,
        senderCallsign: 'BG7XTV',
        targetCallsign: 'BG5DRB',
      }),
      snr: -999,
      freq: 1806,
      operatorId: operator.config.id,
    }]));

    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX6');
    expect(operator.isTransmitting).toBe(false);

    await (pluginManager as any).handleSlotStart(createSlotInfo(90_000), createSlotPack(createSlotInfo(75_000), [{
      message: FT8MessageParser.generateMessage({
        type: FT8MessageType.RRR,
        senderCallsign: 'BG5DRB',
        targetCallsign: 'BG7XTV',
      }),
      snr: 5,
      freq: 1502,
    }]));

    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX6');
    expect(operator.isTransmitting).toBe(false);

    await pluginManager.shutdown();
  });

  it('returns to TX6 and stops transmitting when a QSO completes directly in TX4 and autoResumeCQAfterSuccess is disabled', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      myCallsign: 'BG7XTV',
      myGrid: 'OL32',
      targetCallsign: 'BG5DRB',
      autoResumeCQAfterSuccess: false,
    });

    setRuntimeState(pluginManager, operator.config.id, 'TX4');
    await (pluginManager as any).handleSlotStart(createSlotInfo(60_000), createSlotPack(createSlotInfo(45_000), [{
      message: FT8MessageParser.generateMessage({
        type: FT8MessageType.SEVENTY_THREE,
        senderCallsign: 'BG5DRB',
        targetCallsign: 'BG7XTV',
      }),
      snr: 5,
      freq: 1502,
    }]));

    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX6');
    expect(operator.isTransmitting).toBe(false);

    await pluginManager.shutdown();
  });

  it('immediately interrupts the active transmission when a late re-decision stops the operator', async () => {
    const interruptOperatorTransmission = vi.fn(async () => undefined);
    const { operator, pluginManager } = await createRuntimeHarness({
      myCallsign: 'BG7XTV',
      myGrid: 'OL32',
      targetCallsign: 'BG5DRB',
      autoResumeCQAfterSuccess: false,
      interruptOperatorTransmission,
    });

    setRuntimeState(pluginManager, operator.config.id, 'TX4');

    const currentTxSlot = createSlotInfo(60_000);
    await (pluginManager as any).handleSlotStart(
      currentTxSlot,
      createSlotPack(createSlotInfo(45_000), []),
    );

    const stopped = await pluginManager.reDecideOperator(
      operator.config.id,
      createSlotPack(createSlotInfo(45_000), [{
        message: FT8MessageParser.generateMessage({
          type: FT8MessageType.SEVENTY_THREE,
          senderCallsign: 'BG5DRB',
          targetCallsign: 'BG7XTV',
        }),
        snr: 5,
        freq: 1502,
      }]),
    );

    expect(stopped).toBe(false);
    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX6');
    expect(operator.isTransmitting).toBe(false);
    expect(interruptOperatorTransmission).toHaveBeenCalledTimes(1);
    expect(interruptOperatorTransmission).toHaveBeenCalledWith(operator.config.id);

    await pluginManager.shutdown();
  });

  it('does not interrupt the active transmission on a normal slot-start stop decision', async () => {
    const interruptOperatorTransmission = vi.fn(async () => undefined);
    const { operator, pluginManager } = await createRuntimeHarness({
      myCallsign: 'BG7XTV',
      myGrid: 'OL32',
      targetCallsign: 'BG5DRB',
      autoResumeCQAfterSuccess: false,
      interruptOperatorTransmission,
    });

    setRuntimeState(pluginManager, operator.config.id, 'TX4');
    await (pluginManager as any).handleSlotStart(createSlotInfo(60_000), createSlotPack(createSlotInfo(45_000), [{
      message: FT8MessageParser.generateMessage({
        type: FT8MessageType.SEVENTY_THREE,
        senderCallsign: 'BG5DRB',
        targetCallsign: 'BG7XTV',
      }),
      snr: 5,
      freq: 1502,
    }]));

    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX6');
    expect(operator.isTransmitting).toBe(false);
    expect(interruptOperatorTransmission).not.toHaveBeenCalled();

    await pluginManager.shutdown();
  });

  it('filters candidates with the callsign filter utility plugin', async () => {
    // The utility plugin is enabled globally via pluginConfigs, but its
    // filter rules are operator-scoped settings, so they must be supplied
    // through operatorPluginSettings.
    const { operator, pluginManager } = await createRuntimeHarness({
      pluginConfigs: {
        'callsign-filter': { enabled: true, settings: {} },
      },
      operatorPluginSettings: {
        'callsign-filter': {
          // Advanced regex keep mode keeps only candidates matching one of
          // these regexes.
          filterMode: 'regex-keep',
          filterRules: ['JA.*', 'BG5DRB'],
        },
      },
    });

    const candidates = [
      createParsedMessage('CQ JA1AAA PM95', -5, 1200),
      createParsedMessage('CQ BG5DRB OL32', -7, 1400),
      createParsedMessage('CQ K1ABC FN31', -3, 1600),
    ];

    const filtered = await pluginManager.getHookDispatcher().dispatchFilterCandidates(
      operator.config.id,
      candidates,
      (instance) => pluginManager.getCtxForInstance(instance),
    );

    expect(filtered).toHaveLength(2);
    expect(filtered.map((candidate) => getSenderCallsign(candidate.message))).toEqual(['JA1AAA', 'BG5DRB']);

    await pluginManager.shutdown();
  });

  it('honours per-operator callsign-filter settings supplied via operatorPluginSettings', async () => {
    // Regression guard: callsign-filter settings live under operator scope, so
    // the filter rules persisted per operator must drive the candidate filter
    // for that operator without any extra global plugin config.
    const { operator, pluginManager } = await createRuntimeHarness({
      pluginConfigs: {
        'callsign-filter': { enabled: true, settings: {} },
      },
      operatorPluginSettings: {
        'callsign-filter': {
          filterMode: 'regex-keep',
          filterRules: ['JA.*'],
        },
      },
    });

    const filtered = await pluginManager.getHookDispatcher().dispatchFilterCandidates(
      operator.config.id,
      [
        createParsedMessage('CQ JA1AAA PM95', -5, 1200),
        createParsedMessage('CQ K1ABC FN31', -3, 1600),
      ],
      (instance) => pluginManager.getCtxForInstance(instance),
    );

    expect(filtered.map((candidate) => getSenderCallsign(candidate.message))).toEqual(['JA1AAA']);

    await pluginManager.shutdown();
  });

  it('filters out callsigns by simple callsign or prefix rules', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      pluginConfigs: {
        'callsign-filter': { enabled: true, settings: {} },
      },
      operatorPluginSettings: {
        'callsign-filter': {
          filterMode: 'blocklist',
          filterRules: ['JA', 'BG5DRB'],
        },
      },
    });

    const filtered = await pluginManager.getHookDispatcher().dispatchFilterCandidates(
      operator.config.id,
      [
        createParsedMessage('CQ JA1AAA PM95', -5, 1200),
        createParsedMessage('CQ BG5DRB OL32', -7, 1400),
        createParsedMessage('CQ K1ABC FN31', -3, 1600),
      ],
      (instance) => pluginManager.getCtxForInstance(instance),
    );

    expect(filtered.map((candidate) => getSenderCallsign(candidate.message))).toEqual(['K1ABC']);

    await pluginManager.shutdown();
  });

  it('keeps an empty candidate list when snr-filter removes all weak CQ calls', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      autoReplyToCQ: true,
      pluginConfigs: {
        'snr-filter': {
          enabled: true,
          settings: {
            minSNR: -15,
          },
        },
      },
    });

    const weakCqPack = createSlotPack(createSlotInfo(15_000), [{
      message: FT8MessageParser.generateMessage({
        type: FT8MessageType.CQ,
        senderCallsign: 'JA1AAA',
        grid: 'PM95',
      }),
      snr: -20,
      freq: 1200,
    }]);

    await (pluginManager as any).handleSlotStart(createSlotInfo(15_000), weakCqPack);

    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX6');
    expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe('CQ BG4IAJ OM96');

    await pluginManager.shutdown();
  });

  it('does not auto-reply to a low-score no-reply memory CQ candidate', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      autoReplyToCQ: true,
      pluginConfigs: {
        'no-reply-memory-filter': {
          enabled: true,
          settings: {},
        },
      },
    });

    await pluginManager.notifyQSOFail(operator.config.id, {
      targetCallsign: 'JA1AAA',
      reason: 'tx1_max_call_attempts',
      stage: 'TX1',
      unansweredTransmissions: 8,
      hadTargetReply: false,
    });
    await pluginManager.notifyQSOFail(operator.config.id, {
      targetCallsign: 'JA1AAA',
      reason: 'tx1_max_call_attempts',
      stage: 'TX1',
      unansweredTransmissions: 8,
      hadTargetReply: false,
    });

    await (pluginManager as any).handleSlotStart(createSlotInfo(15_000), createSlotPack(createSlotInfo(15_000), [{
      message: FT8MessageParser.generateMessage({
        type: FT8MessageType.CQ,
        senderCallsign: 'JA1AAA',
        grid: 'PM95',
      }),
      snr: -5,
      freq: 1200,
    }]));

    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX6');
    expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe('CQ BG4IAJ OM96');

    await pluginManager.shutdown();
  });

  it('still replies when a low-score no-reply station directly calls my station', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      autoReplyToCQ: true,
      pluginConfigs: {
        'no-reply-memory-filter': {
          enabled: true,
          settings: {},
        },
      },
    });

    await pluginManager.notifyQSOFail(operator.config.id, {
      targetCallsign: 'JA1AAA',
      reason: 'tx1_max_call_attempts',
      stage: 'TX1',
      unansweredTransmissions: 8,
      hadTargetReply: false,
    });
    await pluginManager.notifyQSOFail(operator.config.id, {
      targetCallsign: 'JA1AAA',
      reason: 'tx1_max_call_attempts',
      stage: 'TX1',
      unansweredTransmissions: 8,
      hadTargetReply: false,
    });

    await (pluginManager as any).handleSlotStart(createSlotInfo(15_000), createSlotPack(createSlotInfo(15_000), [{
      message: FT8MessageParser.generateMessage({
        type: FT8MessageType.CALL,
        senderCallsign: 'JA1AAA',
        targetCallsign: 'BG4IAJ',
        grid: 'PM95',
      }),
      snr: -5,
      freq: 1200,
    }]));

    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX2');
    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).context?.targetCallsign).toBe('JA1AAA');

    await pluginManager.shutdown();
  });

  it('penalizes standard-qso TX1 no-reply failures but not later-stage timeouts', async () => {
    const tx1Failure = await createRuntimeHarness({
      autoReplyToCQ: true,
      targetCallsign: 'JA1AAA',
      maxQSOTimeoutCycles: 1,
      maxCallAttempts: 1,
      pluginConfigs: {
        'no-reply-memory-filter': {
          enabled: true,
          settings: {},
        },
      },
    });
    setRuntimeState(tx1Failure.pluginManager, tx1Failure.operator.config.id, 'TX1');

    await (tx1Failure.pluginManager as any).handleSlotStart(
      createSlotInfo(15_000),
      createSlotPack(createSlotInfo(15_000), []),
    );
    tx1Failure.operator.start();
    patchRuntimeContext(tx1Failure.pluginManager, tx1Failure.operator.config.id, {
      targetCallsign: 'JA1AAA',
      targetGrid: 'PM95',
      reportSent: -5,
    });
    setRuntimeState(tx1Failure.pluginManager, tx1Failure.operator.config.id, 'TX1');
    await (tx1Failure.pluginManager as any).handleSlotStart(
      createSlotInfo(30_000),
      createSlotPack(createSlotInfo(30_000), []),
    );
    tx1Failure.operator.start();
    await (tx1Failure.pluginManager as any).handleSlotStart(createSlotInfo(45_000), createSlotPack(createSlotInfo(45_000), [{
      message: FT8MessageParser.generateMessage({
        type: FT8MessageType.CQ,
        senderCallsign: 'JA1AAA',
        grid: 'PM95',
      }),
      snr: -5,
      freq: 1200,
    }]));

    expect(tx1Failure.pluginManager.getOperatorRuntimeStatus(tx1Failure.operator.config.id).currentSlot).toBe('TX6');

    const tx2Failure = await createRuntimeHarness({
      autoReplyToCQ: true,
      targetCallsign: 'JA1AAA',
      maxQSOTimeoutCycles: 1,
      pluginConfigs: {
        'no-reply-memory-filter': {
          enabled: true,
          settings: {},
        },
      },
    });
    setRuntimeState(tx2Failure.pluginManager, tx2Failure.operator.config.id, 'TX2');

    await (tx2Failure.pluginManager as any).handleSlotStart(
      createSlotInfo(45_000),
      createSlotPack(createSlotInfo(45_000), []),
    );
    tx2Failure.operator.start();
    await (tx2Failure.pluginManager as any).handleSlotStart(createSlotInfo(60_000), createSlotPack(createSlotInfo(60_000), [{
      message: FT8MessageParser.generateMessage({
        type: FT8MessageType.CQ,
        senderCallsign: 'JA1AAA',
        grid: 'PM95',
      }),
      snr: -5,
      freq: 1200,
    }]));

    expect(tx2Failure.pluginManager.getOperatorRuntimeStatus(tx2Failure.operator.config.id).currentSlot).toBe('TX1');
    expect(tx2Failure.pluginManager.getOperatorRuntimeStatus(tx2Failure.operator.config.id).context?.targetCallsign).toBe('JA1AAA');

    await tx1Failure.pluginManager.shutdown();
    await tx2Failure.pluginManager.shutdown();
  });

  it('does not auto-reply to a directed CQ whose modifier excludes my station identity', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      myCallsign: 'BG4IAJ',
      autoReplyToCQ: true,
    });

    await (pluginManager as any).handleSlotStart(
      createSlotInfo(15_000),
      createSlotPack(createSlotInfo(15_000), [{
        message: 'CQ EU K1ABC FN31',
        snr: -5,
        freq: 1200,
      }]),
    );

    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX6');
    expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe('CQ BG4IAJ OM96');

    await pluginManager.shutdown();
  });

  it('auto-replies to a directed CQ when my station identity matches the modifier', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      myCallsign: 'BG4IAJ',
      autoReplyToCQ: true,
    });

    await (pluginManager as any).handleSlotStart(
      createSlotInfo(15_000),
      createSlotPack(createSlotInfo(15_000), [{
        message: 'CQ AS JA1AAA PM95',
        snr: -5,
        freq: 1200,
      }]),
    );

    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX1');
    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).context?.targetCallsign).toBe('JA1AAA');

    await pluginManager.shutdown();
  });

  it('treats CQ DX as intercontinental-only for automatic replies', async () => {
    const sameContinent = await createRuntimeHarness({
      myCallsign: 'BG4IAJ',
      autoReplyToCQ: true,
    });

    await (sameContinent.pluginManager as any).handleSlotStart(
      createSlotInfo(15_000),
      createSlotPack(createSlotInfo(15_000), [{
        message: 'CQ DX JA1AAA PM95',
        snr: -5,
        freq: 1200,
      }]),
    );

    expect(sameContinent.pluginManager.getOperatorRuntimeStatus(sameContinent.operator.config.id).currentSlot).toBe('TX6');
    expect(getCurrentTransmission(sameContinent.pluginManager, sameContinent.operator.config.id)).toBe('CQ BG4IAJ OM96');

    const intercontinental = await createRuntimeHarness({
      myCallsign: 'BG4IAJ',
      autoReplyToCQ: true,
    });

    await (intercontinental.pluginManager as any).handleSlotStart(
      createSlotInfo(15_000),
      createSlotPack(createSlotInfo(15_000), [{
        message: 'CQ DX K1ABC FN31',
        snr: -5,
        freq: 1200,
      }]),
    );

    expect(intercontinental.pluginManager.getOperatorRuntimeStatus(intercontinental.operator.config.id).currentSlot).toBe('TX1');
    expect(intercontinental.pluginManager.getOperatorRuntimeStatus(intercontinental.operator.config.id).context?.targetCallsign).toBe('K1ABC');

    await sameContinent.pluginManager.shutdown();
    await intercontinental.pluginManager.shutdown();
  });

  it('filters candidates with snr-filter using the configured threshold', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      pluginConfigs: {
        'snr-filter': {
          enabled: true,
          settings: {
            minSNR: -8,
          },
        },
      },
    });

    const candidates = [
      createParsedMessage('CQ JA1AAA PM95', -5, 1200),
      createParsedMessage('CQ BG5DRB OL32', -8, 1400),
      createParsedMessage('CQ K1ABC FN31', -12, 1600),
    ];

    const filtered = await pluginManager.getHookDispatcher().dispatchFilterCandidates(
      operator.config.id,
      candidates,
      (instance) => pluginManager.getCtxForInstance(instance),
    );

    expect(filtered.map((candidate) => getSenderCallsign(candidate.message))).toEqual(['JA1AAA', 'BG5DRB']);

    await pluginManager.shutdown();
  });

  it('applies filter plugins during late re-decision', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      autoReplyToCQ: true,
      pluginConfigs: {
        'snr-filter': {
          enabled: true,
          settings: {
            minSNR: -15,
          },
        },
      },
    });

    await (pluginManager as any).handleSlotStart(createSlotInfo(0), createSlotPack(createSlotInfo(0), []));

    const changed = await pluginManager.reDecideOperator(
      operator.config.id,
      createSlotPack(createSlotInfo(15_000), [{
        message: FT8MessageParser.generateMessage({
          type: FT8MessageType.CQ,
          senderCallsign: 'JA1AAA',
          grid: 'PM95',
        }),
        snr: -20,
        freq: 1200,
      }]),
    );

    expect(changed).toBe(false);
    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX6');
    expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe('CQ BG4IAJ OM96');

    await pluginManager.shutdown();
  });

  it('biases candidate scores using worked-station-bias', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      pluginConfigs: {
        'worked-station-bias': {
          enabled: true,
          settings: {
            newStationBonus: 15,
            workedStationPenalty: 8,
          },
        },
      },
      hasWorkedCallsign: (callsign) => callsign === 'BG5DRB',
    });

    const candidates: ScoredCandidate[] = [
      { ...createParsedMessage('CQ BG5DRB OL32', -4, 1200), score: 0 },
      { ...createParsedMessage('CQ JA1AAA PM95', -6, 1400), score: 0 },
    ];

    const scored = await pluginManager.getHookDispatcher().dispatchScoreCandidates(
      operator.config.id,
      candidates,
      (instance) => pluginManager.getCtxForInstance(instance),
    );

    const byCallsign = Object.fromEntries(scored.map((candidate) => [
      getSenderCallsign(candidate.message),
      candidate.score,
    ]));
    expect(byCallsign.BG5DRB).toBe(-8);
    expect(byCallsign.JA1AAA).toBe(15);

    await pluginManager.shutdown();
  });

  it('treats an empty watch list as disabled for watched-callsign-autocall', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      startOperator: false,
      pluginConfigs: {
        'watched-callsign-autocall': {
          enabled: true,
          settings: {},
        },
      },
    });

    await (pluginManager as any).handleSlotStart(
      createSlotInfo(30_000),
      createSlotPack(createSlotInfo(15_000), [{
        message: FT8MessageParser.generateMessage({
          type: FT8MessageType.CQ,
          senderCallsign: 'JA1AAA',
          grid: 'PM95',
        }),
        snr: -6,
        freq: 1500,
      }]),
    );

    expect(operator.isTransmitting).toBe(false);
    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX6');

    await pluginManager.shutdown();
  });

  it('automatically calls a watched CQ while idle and aligns transmit cycles to the next slot', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      startOperator: false,
      pluginConfigs: {
        'watched-callsign-autocall': {
          enabled: true,
          settings: {},
        },
      },
      operatorPluginSettings: {
        'watched-callsign-autocall': {
          watchList: ['JA1AAA'],
          triggerMode: 'cq',
        },
      },
    });

    await (pluginManager as any).handleSlotStart(
      createSlotInfo(30_000),
      createSlotPack(createSlotInfo(15_000), [{
        message: FT8MessageParser.generateMessage({
          type: FT8MessageType.CQ,
          senderCallsign: 'JA1AAA',
          grid: 'PM95',
        }),
        snr: -6,
        freq: 1500,
      }]),
    );

    expect(operator.isTransmitting).toBe(true);
    expect(operator.getTransmitCycles()).toEqual([0]);
    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX1');
    expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe('JA1AAA BG4IAJ OM96');

    await pluginManager.shutdown();
  });

  it('supports regex watch rules for watched-callsign-autocall', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      startOperator: false,
      pluginConfigs: {
        'watched-callsign-autocall': {
          enabled: true,
          settings: {},
        },
      },
      operatorPluginSettings: {
        'watched-callsign-autocall': {
          watchList: ['# Japan block', '^BG5'],
          triggerMode: 'cq',
        },
      },
    });

    await (pluginManager as any).handleSlotStart(
      createSlotInfo(30_000),
      createSlotPack(createSlotInfo(15_000), [{
        message: FT8MessageParser.generateMessage({
          type: FT8MessageType.CQ,
          senderCallsign: 'BG5DRB',
          grid: 'PM01',
        }),
        snr: -8,
        freq: 1502,
      }]),
    );

    expect(operator.isTransmitting).toBe(true);
    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX1');
    expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe('BG5DRB BG4IAJ OM96');

    await pluginManager.shutdown();
  });

  it('always responds to watched stations calling me directly, even in cq mode', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      startOperator: false,
      myCallsign: 'BG7XTV',
      myGrid: 'OL32',
      pluginConfigs: {
        'watched-callsign-autocall': {
          enabled: true,
          settings: {},
        },
      },
      operatorPluginSettings: {
        'watched-callsign-autocall': {
          watchList: ['BG5DRB'],
          triggerMode: 'cq',
        },
      },
    });

    await (pluginManager as any).handleSlotStart(
      createSlotInfo(30_000),
      createSlotPack(createSlotInfo(15_000), [{
        message: FT8MessageParser.generateMessage({
          type: FT8MessageType.CALL,
          senderCallsign: 'BG5DRB',
          targetCallsign: 'BG7XTV',
          grid: 'PM01',
        }),
        snr: -8,
        freq: 1502,
      }]),
    );

    expect(operator.isTransmitting).toBe(true);
    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX2');
    expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe('BG5DRB BG7XTV -08');

    await pluginManager.shutdown();
  });

  it('supports cq-or-signoff trigger mode for watched-callsign-autocall', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      startOperator: false,
      myCallsign: 'BG7XTV',
      myGrid: 'OL32',
      pluginConfigs: {
        'watched-callsign-autocall': {
          enabled: true,
          settings: {},
        },
      },
      operatorPluginSettings: {
        'watched-callsign-autocall': {
          watchList: ['BG5DRB'],
          triggerMode: 'cq-or-signoff',
        },
      },
    });

    await (pluginManager as any).handleSlotStart(
      createSlotInfo(30_000),
      createSlotPack(createSlotInfo(15_000), [{
        message: FT8MessageParser.generateMessage({
          type: FT8MessageType.SEVENTY_THREE,
          senderCallsign: 'BG5DRB',
          targetCallsign: 'JA1AAA',
        }),
        snr: -8,
        freq: 1502,
      }]),
    );

    expect(operator.isTransmitting).toBe(true);
    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX1');
    expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe('BG5DRB BG7XTV OL32');

    await pluginManager.shutdown();
  });

  it('does not interrupt a non-idle operator when watched-callsign-autocall matches', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      startOperator: false,
      pluginConfigs: {
        'watched-callsign-autocall': {
          enabled: true,
          settings: {},
        },
      },
      operatorPluginSettings: {
        'watched-callsign-autocall': {
          watchList: ['JA1AAA'],
          triggerMode: 'cq',
        },
      },
    });

    patchRuntimeContext(pluginManager, operator.config.id, {
      targetCallsign: 'BG5DRB',
    });
    setRuntimeState(pluginManager, operator.config.id, 'TX2');

    await (pluginManager as any).handleSlotStart(
      createSlotInfo(30_000),
      createSlotPack(createSlotInfo(15_000), [{
        message: FT8MessageParser.generateMessage({
          type: FT8MessageType.CQ,
          senderCallsign: 'JA1AAA',
          grid: 'PM95',
        }),
        snr: -6,
        freq: 1500,
      }]),
    );

    expect(operator.isTransmitting).toBe(false);
    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX2');
    expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe('BG5DRB BG4IAJ +00');

    await pluginManager.shutdown();
  });

  it('uses watch list order as the priority when multiple watched callsigns appear', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      startOperator: false,
      pluginConfigs: {
        'watched-callsign-autocall': {
          enabled: true,
          settings: {},
        },
      },
      operatorPluginSettings: {
        'watched-callsign-autocall': {
          watchList: ['BG5DRB', 'JA1AAA'],
          triggerMode: 'cq',
        },
      },
    });

    await (pluginManager as any).handleSlotStart(
      createSlotInfo(30_000),
      createSlotPack(createSlotInfo(15_000), [
        {
          message: FT8MessageParser.generateMessage({
            type: FT8MessageType.CQ,
            senderCallsign: 'JA1AAA',
            grid: 'PM95',
          }),
          snr: -3,
          freq: 1500,
        },
        {
          message: FT8MessageParser.generateMessage({
            type: FT8MessageType.CQ,
            senderCallsign: 'BG5DRB',
            grid: 'OL32',
          }),
          snr: -9,
          freq: 1600,
        },
      ]),
    );

    expect(operator.isTransmitting).toBe(true);
    expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe('BG5DRB BG4IAJ OM96');

    await pluginManager.shutdown();
  });

  it('honors the global utility switch for watched-callsign-autocall', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      startOperator: false,
      pluginConfigs: {
        'watched-callsign-autocall': {
          enabled: false,
          settings: {},
        },
      },
      operatorPluginSettings: {
        'watched-callsign-autocall': {
          watchList: ['JA1AAA'],
          triggerMode: 'cq',
        },
      },
    });

    await (pluginManager as any).handleSlotStart(
      createSlotInfo(30_000),
      createSlotPack(createSlotInfo(15_000), [{
        message: FT8MessageParser.generateMessage({
          type: FT8MessageType.CQ,
          senderCallsign: 'JA1AAA',
          grid: 'PM95',
        }),
        snr: -6,
        freq: 1500,
      }]),
    );

    expect(operator.isTransmitting).toBe(false);
    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX6');

    await pluginManager.shutdown();
  });

  it('skips invalid user plugins whose quick setting binds to a non-operator setting', async () => {
    const { dataDir, pluginManager } = await createRuntimeHarness();

    await writeUserPlugin(dataDir, 'invalid-quick-setting-plugin', `
      export default {
        name: 'invalid-quick-setting-plugin',
        version: '1.0.0',
        type: 'utility',
        settings: {
          sharedToggle: {
            type: 'boolean',
            default: false,
            label: 'sharedToggle',
            scope: 'global',
          },
        },
        quickSettings: [
          {
            settingKey: 'sharedToggle',
          },
        ],
      };
    `);

    await pluginManager.rescanPlugins();

    expect(pluginManager.getSnapshot().plugins.some((plugin) => plugin.name === 'invalid-quick-setting-plugin')).toBe(false);

    await pluginManager.shutdown();
  });

  it('reloads a user plugin with fresh code after the entry file changes', async () => {
    const { dataDir, operator, pluginManager } = await createRuntimeHarness({
      pluginConfigs: {
        'dynamic-filter': {
          enabled: true,
          settings: {},
        },
      },
    });

    await writeUserPlugin(dataDir, 'dynamic-filter', `
      export default {
        name: 'dynamic-filter',
        version: '1.0.0',
        type: 'utility',
        hooks: {
          onFilterCandidates(candidates) {
            return candidates.slice(0, 1);
          },
        },
      };
    `);

    await pluginManager.rescanPlugins();

    const candidates = [
      createParsedMessage('CQ JA1AAA PM95', -5, 1200),
      createParsedMessage('CQ BG5DRB OL32', -8, 1400),
      createParsedMessage('CQ K1ABC FN31', -12, 1600),
    ];

    const initialFiltered = await pluginManager.getHookDispatcher().dispatchFilterCandidates(
      operator.config.id,
      candidates,
      (instance) => pluginManager.getCtxForInstance(instance),
    );
    expect(initialFiltered).toHaveLength(1);

    await writeUserPlugin(dataDir, 'dynamic-filter', `
      export default {
        name: 'dynamic-filter',
        version: '1.1.0',
        type: 'utility',
        hooks: {
          onFilterCandidates(candidates) {
            return candidates.slice(0, 2);
          },
        },
      };
    `);

    await pluginManager.reloadPlugin('dynamic-filter');

    const reloadedFiltered = await pluginManager.getHookDispatcher().dispatchFilterCandidates(
      operator.config.id,
      candidates,
      (instance) => pluginManager.getCtxForInstance(instance),
    );
    expect(reloadedFiltered).toHaveLength(2);
    expect(pluginManager.getSnapshot().plugins.find((plugin) => plugin.name === 'dynamic-filter')?.version).toBe('1.1.0');

    await pluginManager.shutdown();
  });

  it('exposes automatic target eligibility checks through the public plugin context', async () => {
    const { dataDir, operator, pluginManager } = await createRuntimeHarness({
      pluginConfigs: {
        'eligibility-filter': {
          enabled: true,
          settings: {},
        },
      },
    });

    await writeUserPlugin(dataDir, 'eligibility-filter', `
      export default {
        name: 'eligibility-filter',
        version: '1.0.0',
        type: 'utility',
        hooks: {
          onFilterCandidates(candidates, ctx) {
            return candidates.filter((candidate) => {
              const decision = ctx.band.evaluateAutoTargetEligibility(candidate);
              return decision.eligible || decision.reason === 'continent_match';
            });
          },
        },
      };
    `);

    await pluginManager.rescanPlugins();

    const filtered = await pluginManager.getHookDispatcher().dispatchFilterCandidates(
      operator.config.id,
      [
        createParsedMessage('CQ EU K1ABC FN31', -5, 1200),
        createParsedMessage('CQ AS JA1AAA PM95', -6, 1400),
      ],
      (instance) => pluginManager.getCtxForInstance(instance),
    );

    expect(filtered.map((candidate) => getSenderCallsign(candidate.message))).toEqual(['JA1AAA']);

    await pluginManager.shutdown();
  });
});
