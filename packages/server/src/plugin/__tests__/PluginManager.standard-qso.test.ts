import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'eventemitter3';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DigitalRadioEngineEvents, ParsedFT8Message, SlotInfo, SlotPack } from '@tx5dr/contracts';
import { FT8MessageType, MODES } from '@tx5dr/contracts';
import { FT8MessageParser, RadioOperator } from '@tx5dr/core';
import type { ScoredCandidate } from '@tx5dr/plugin-api';
import { STANDARD_QSO_TX6_MESSAGE_OVERRIDE_SETTING } from '@tx5dr/builtin-plugins';
import { PluginManager } from '../PluginManager.js';
import { LogManager } from '../../log/LogManager.js';
import { TargetReservationCoordinator } from '../../transmission/TargetReservationCoordinator.js';

type RecordQSORequest = Parameters<DigitalRadioEngineEvents['recordQSO']>[0];

function installInMemoryLogManager(): void {
  const logBook = {
    id: 'logbook-test',
    provider: {
      queryQSOs: vi.fn(async () => []),
    },
  };
  const sessionLogBook = {
    id: 'plugin-session-test',
    name: 'Plugin Session',
    binding: { kind: 'plugin-session', pluginName: 'standard-qso', stationCallsign: 'BG5DRB', sessionKey: 'standard-qso:2026' },
    provider: {
      queryQSOs: vi.fn(async () => []),
      readQsoSnapshot: vi.fn(async () => ({ revision: 'r0', records: [] })),
      applyQsoBatch: vi.fn(async () => ({ revision: 'r0', outcomes: [] })),
      getHealth: vi.fn(() => ({ state: 'healthy', readable: true, writable: true, issues: [], updatedAt: 0 })),
      onHealthChanged: vi.fn(() => () => {}),
      getStatistics: vi.fn(async () => ({ totalQSOs: 0, uniqueCallsigns: 0 })),
    },
  };

  vi.spyOn(LogManager, 'getInstance').mockReturnValue({
    resolveLogBookId: vi.fn(() => logBook.id),
    getLogBook: vi.fn(() => logBook),
    getOperatorIdsForLogBook: vi.fn(() => []),
    getOrCreatePluginSessionLogBook: vi.fn(async () => sessionLogBook),
    getPluginSessionLogBook: vi.fn(() => sessionLogBook),
  } as unknown as LogManager);
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

function createSlotPack(
  slotInfo: SlotInfo,
  frames: Array<{
    message: string;
    snr: number;
    freq: number;
    operatorId?: string;
    logbookAnalysis?: ParsedFT8Message['logbookAnalysis'];
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
      logbookAnalysis: frame.logbookAnalysis,
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
  const managers: PluginManager[] = [];

  beforeEach(() => {
    // Plugin logbook queries must remain isolated from the user's real logbook directory.
    installInMemoryLogManager();
  });

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
    vi.restoreAllMocks();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function createRuntimeHarness(options?: {
    strategy?: 'standard-qso' | 'assisted-qso-queue';
    myCallsign?: string;
    myGrid?: string;
    targetCallsign?: string;
    startOperator?: boolean;
    autoReplyToCQ?: boolean;
    autoReplyToDirectCallWhenStopped?: boolean;
    autoResumeCQAfterFail?: boolean;
    autoResumeCQAfterSuccess?: boolean;
    maxQSOTimeoutCycles?: number;
    maxCallAttempts?: number;
    maxConcurrentStreams?: number;
    replyToWorkedStations?: boolean;
    distinguishWorkedStationsByBand?: boolean;
    skipTx1?: boolean;
    hasWorkedCallsign?: boolean | ((callsign: string, options?: { anyBand?: boolean }) => boolean | Promise<boolean>);
    pluginConfigs?: Record<string, { enabled: boolean; settings: Record<string, unknown> }>;
    operatorPluginSettings?: Record<string, Record<string, unknown>>;
    interruptOperatorTransmission?: (operatorId: string) => Promise<void>;
    triggerReEncode?: (
      operatorId: string,
      options?: { source?: 'late-decode' | 'operator-edit' | 'plugin'; reason?: string },
    ) => void;
    radioBand?: string;
    radioFrequency?: number;
    recordQSOHandler?: (data: RecordQSORequest) => void;
    notifyOperatorStatusChanged?: (operatorId: string) => void;
    removeOperatorContribution?: (
      operatorId: string,
      options: {
        signal: AbortSignal;
        commandToken: import('../../transmission/OperatorIntentCoordinator.js').OperatorCommandToken;
      },
    ) => Promise<void>;
  }) {
    const eventEmitter = new EventEmitter<DigitalRadioEngineEvents>();
    eventEmitter.on('checkHasWorkedCallsign' as any, (data: { requestId: string; callsign: string }) => {
      const result = typeof options?.hasWorkedCallsign === 'function'
        ? options.hasWorkedCallsign(data.callsign, (data as { options?: { anyBand?: boolean } }).options)
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
      frequency: 1500,
      transmitCycles: [0],
      maxConcurrentStreams: options?.maxConcurrentStreams,
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
    const requestOperatorStrategyStop = vi.fn();

    // This unit harness intentionally omits RadioOperatorManager. Acknowledge
    // persistence requests so protocol tests do not hang on the production
    // request/ack contract introduced for durable QSO writes.
    eventEmitter.on('recordQSO', (data) => {
      if (options?.recordQSOHandler) {
        options.recordQSOHandler(data);
        return;
      }
      data.resolve?.(data.qsoRecord);
    });

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
      notifyOperatorStatusChanged: options?.notifyOperatorStatusChanged,
      getRadioFrequency: async () => options?.radioFrequency ?? 7_074_000,
      setRadioFrequency: () => {},
      getRadioBand: () => options?.radioBand ?? '40m',
      getRadioConnected: () => true,
      getLatestSlotPack: () => null,
      interruptOperatorTransmission,
      requestOperatorStrategyStop,
      removeOperatorContribution: options?.removeOperatorContribution,
      hasWorkedCallsign: async (_operatorId, callsign, hasWorkedOptions) => {
        if (typeof options?.hasWorkedCallsign === 'function') {
          return options.hasWorkedCallsign(callsign, hasWorkedOptions);
        }
        return options?.hasWorkedCallsign ?? false;
      },
      resetOperatorRuntime: () => {},
      triggerReEncode: options?.triggerReEncode,
      dataDir,
    });
    managers.push(pluginManager);
    // This harness omits RadioOperatorManager, so emulate its post-validation acceptance callback.
    eventEmitter.on('requestTransmit', ({ operatorId, transmission }) => {
      if (!FT8MessageParser.rawContainsUndecodedCallsign(transmission)) {
        pluginManager.notifyTransmissionQueued(operatorId, transmission);
      }
    });
    eventEmitter.on('requestTransmitBatch', (batch) => {
      for (const transmission of batch.transmissions) {
        eventEmitter.emit('requestTransmit', {
          operatorId: batch.operatorId,
          transmission: transmission.transmission,
          decisionEpoch: batch.decisionEpoch,
        });
      }
    });
    pluginManager.loadConfig({
      configs: options?.pluginConfigs ?? {},
      operatorStrategies: {
        [operator.config.id]: options?.strategy ?? 'standard-qso',
      },
      operatorSettings: {
        [operator.config.id]: {
          'standard-qso': {
            autoReplyToCQ: operator.config.autoReplyToCQ,
            autoReplyToDirectCallWhenStopped: options?.autoReplyToDirectCallWhenStopped ?? false,
            autoResumeCQAfterFail: operator.config.autoResumeCQAfterFail,
            autoResumeCQAfterSuccess: operator.config.autoResumeCQAfterSuccess,
            replyToWorkedStations: operator.config.replyToWorkedStations,
            distinguishWorkedStationsByBand: options?.distinguishWorkedStationsByBand ?? true,
            skipTx1: options?.skipTx1 ?? false,
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
      requestOperatorStrategyStop,
      operator,
      pluginManager,
    };
  }

  async function createMultiOperatorRuntimeHarness(options?: {
    strategy?: 'standard-qso' | 'assisted-qso-queue';
    operatorCount?: number;
    myCallsign?: string;
    myGrid?: string;
    autoReplyToCQ?: boolean;
    autoReplyToDirectCallWhenStopped?: boolean;
    replyToWorkedStations?: boolean;
    hasWorkedCallsign?: boolean | ((callsign: string, options?: { anyBand?: boolean }) => boolean | Promise<boolean>);
  }) {
    const eventEmitter = new EventEmitter<DigitalRadioEngineEvents>();
    eventEmitter.on('checkHasWorkedCallsign' as any, (data: { requestId: string; callsign: string }) => {
      const result = typeof options?.hasWorkedCallsign === 'function'
        ? options.hasWorkedCallsign(data.callsign, (data as { options?: { anyBand?: boolean } }).options)
        : (options?.hasWorkedCallsign ?? false);
      void Promise.resolve(result).then((hasWorked) => {
        eventEmitter.emit('hasWorkedCallsignResponse' as any, {
          requestId: data.requestId,
          hasWorked,
        });
      });
    });

    let pluginManager!: PluginManager;
    const operators: RadioOperator[] = [];
    const targetReservations = new TargetReservationCoordinator();
    const isTargetBeingWorkedByOtherOperators = (
      myCallsign: string,
      targetCallsign: string,
      currentOperatorId: string,
    ): boolean => {
      const normalizedMyCall = myCallsign.toUpperCase();
      const normalizedTarget = targetCallsign.toUpperCase();
      if (targetReservations.isReservedByOther(normalizedMyCall, normalizedTarget, currentOperatorId)) {
        return true;
      }
      return operators.some((operator) => {
        if (operator.config.id === currentOperatorId) return false;
        if (!operator.isTransmitting) return false;
        if (operator.config.myCallsign.toUpperCase() !== normalizedMyCall) return false;
        const status = pluginManager.getOperatorRuntimeStatus(operator.config.id);
        const currentTarget = String(status.context?.targetCallsign ?? '').toUpperCase();
        return currentTarget === normalizedTarget && status.currentSlot !== 'TX6';
      });
    };

    for (let index = 0; index < (options?.operatorCount ?? 2); index += 1) {
      operators.push(new RadioOperator({
        id: `operator-${index + 1}`,
        mode: MODES.FT8,
        myCallsign: options?.myCallsign ?? 'BG4IAJ',
        myGrid: options?.myGrid ?? 'OM96',
        frequency: 1000 + index * 200,
        transmitCycles: [0],
        maxQSOTimeoutCycles: 6,
        maxCallAttempts: 5,
        autoReplyToCQ: options?.autoReplyToCQ ?? false,
        autoResumeCQAfterFail: false,
        autoResumeCQAfterSuccess: false,
        replyToWorkedStations: options?.replyToWorkedStations ?? false,
        prioritizeNewCalls: true,
        targetSelectionPriorityMode: 'dxcc_first',
      }, eventEmitter, isTargetBeingWorkedByOtherOperators));
    }

    const dataDir = await mkdtemp(join(tmpdir(), 'tx5dr-plugin-multi-test-'));
    tempDirs.push(dataDir);

    pluginManager = new PluginManager({
      eventEmitter,
      getOperators: () => operators,
      getOperatorById: (id) => operators.find((operator) => operator.config.id === id),
      getCurrentMode: () => MODES.FT8,
      getOperatorAutomationSnapshot: (id) => pluginManager.getOperatorAutomationSnapshot(id),
      requestOperatorCall: (operatorId, callsign, lastMessage) => {
        pluginManager.requestCall(operatorId, callsign, lastMessage);
      },
      getRadioFrequency: async () => 7074000,
      setRadioFrequency: () => {},
      getRadioBand: () => '40m',
      getRadioConnected: () => true,
      getLatestSlotPack: () => null,
      interruptOperatorTransmission: async () => undefined,
      transitionTargetReservation: (operatorId, epoch, targetCallsign) => {
        const operator = operators.find((candidate) => candidate.config.id === operatorId);
        if (!operator) return false;
        return targetReservations.tryTransition({
          stationCallsign: operator.config.myCallsign,
          targetCallsign,
          operatorId,
          epoch,
        });
      },
      releaseTargetReservation: (operatorId, epoch) => targetReservations.releaseOperator(operatorId, epoch),
      hasWorkedCallsign: async (_operatorId, callsign, hasWorkedOptions) => {
        if (typeof options?.hasWorkedCallsign === 'function') {
          return options.hasWorkedCallsign(callsign, hasWorkedOptions);
        }
        return options?.hasWorkedCallsign ?? false;
      },
      resetOperatorRuntime: () => {},
      dataDir,
    });
    managers.push(pluginManager);

    pluginManager.loadConfig({
      configs: {},
      operatorStrategies: Object.fromEntries(operators.map((operator) => [
        operator.config.id,
        options?.strategy ?? 'standard-qso',
      ])),
      operatorSettings: Object.fromEntries(operators.map((operator) => [
        operator.config.id,
        {
          'standard-qso': {
            autoReplyToCQ: operator.config.autoReplyToCQ,
            autoReplyToDirectCallWhenStopped: options?.autoReplyToDirectCallWhenStopped ?? false,
            autoResumeCQAfterFail: operator.config.autoResumeCQAfterFail,
            autoResumeCQAfterSuccess: operator.config.autoResumeCQAfterSuccess,
            replyToWorkedStations: operator.config.replyToWorkedStations,
            targetSelectionPriorityMode: operator.config.targetSelectionPriorityMode,
            maxQSOTimeoutCycles: operator.config.maxQSOTimeoutCycles,
            maxCallAttempts: operator.config.maxCallAttempts,
          },
        },
      ])),
    });

    await pluginManager.start();
    operators.forEach((operator) => operator.start());

    return {
      dataDir,
      eventEmitter,
      operators,
      pluginManager,
      targetReservations,
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

  describe('assisted QSO queue integration', () => {
    it('observes the slot that produced decoded messages at the next slot boundary', async () => {
      const { operator, pluginManager } = await createRuntimeHarness({
        strategy: 'assisted-qso-queue',
      });
      const runtime = (pluginManager as unknown as {
        getStrategyRuntime(operatorId: string): {
          observeDecodedMessages: (...args: unknown[]) => boolean;
        } | undefined;
      }).getStrategyRuntime(operator.config.id);
      expect(runtime).toBeDefined();
      const observe = vi.spyOn(runtime!, 'observeDecodedMessages');
      const sourceSlot = createSlotInfo(45_000);
      const currentSlot = createSlotInfo(60_000);

      await (pluginManager as any).handleSlotStart(
        currentSlot,
        createSlotPack(sourceSlot, []),
      );

      expect(observe).toHaveBeenCalledWith(
        [],
        expect.objectContaining({
          source: 'slot-auto',
          slotInfo: expect.objectContaining({
            id: sourceSlot.id,
            startMs: sourceSlot.startMs,
            cycleNumber: Math.floor(sourceSlot.startMs / MODES.FT8.slotMs),
          }),
        }),
      );
    });

    it('routes a lifecycle-scoped state change to one active queue stream', async () => {
      const { operator, pluginManager, eventEmitter } = await createRuntimeHarness({
        strategy: 'assisted-qso-queue',
      });
      const operatorId = operator.config.id;
      await pluginManager.enqueueQueueTarget(operatorId, { callsign: 'JA1AAA' });
      await pluginManager.resumeQueueExecution(operatorId);
      const stream = pluginManager.getOperatorRuntimeStatus(operatorId).streams?.[0];
      expect(stream?.stateOptions?.map((option) => option.id)).toEqual([
        'TX1', 'TX2', 'TX3', 'TX4', 'TX5', 'TX6',
      ]);
      const changed = vi.fn();
      eventEmitter.on('operatorStreamStateChanged', changed);

      await pluginManager.setOperatorStreamState(operatorId, {
        streamId: stream!.streamId,
        stateId: 'TX4',
        expectedLifecycleEpoch: stream!.qsoLifecycleEpoch,
      });

      expect(pluginManager.getOperatorRuntimeStatus(operatorId).streams?.[0]?.currentState).toBe('TX4');
      expect(changed).toHaveBeenCalledWith(expect.objectContaining({
        operatorId,
        streamId: stream!.streamId,
        state: 'TX4',
        source: 'manual',
      }));
      await expect(pluginManager.setOperatorStreamState(operatorId, {
        streamId: stream!.streamId,
        stateId: 'TX3',
        expectedLifecycleEpoch: stream!.qsoLifecycleEpoch + 1,
      })).rejects.toThrow('stream_lifecycle_conflict');
    });

    it('observes direct callers while stopped without starting the operator', async () => {
      const { operator, pluginManager } = await createRuntimeHarness({
        strategy: 'assisted-qso-queue',
        startOperator: false,
      });
      const sourceSlot = createSlotInfo(Date.now());
      const pack = createSlotPack(sourceSlot, [{
        message: 'BG4IAJ JA1AAA PM95',
        snr: -8,
        freq: 1400,
      }]);

      expect(pluginManager.hasTargetQueue(operator.config.id)).toBe(true);
      expect(await pluginManager.reDecideOperator(operator.config.id, pack)).toBe(false);
      expect(operator.isTransmitting).toBe(false);
      expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).queue?.rows).toMatchObject([
        { callsign: 'JA1AAA', displayState: 'TX2' },
      ]);
    });

    it('routes versioned queue commands and rejects direct requestCall bypasses', async () => {
      const { operator, pluginManager } = await createRuntimeHarness({
        strategy: 'assisted-qso-queue',
        startOperator: false,
      });
      const operatorId = operator.config.id;
      const first = await pluginManager.enqueueQueueTarget(operatorId, { callsign: 'JA1AAA' });
      const duplicate = await pluginManager.enqueueQueueTarget(operatorId, { callsign: 'ja1aaa' });
      const second = await pluginManager.enqueueQueueTarget(operatorId, { callsign: 'JA2BBB' });

      expect(duplicate.outcome).toBe('duplicate');
      expect(duplicate.snapshot.rows).toHaveLength(1);
      const stale = await pluginManager.reorderQueueTarget(
        operatorId,
        second.snapshot.rows[1]!.entryId,
        second.snapshot.rows[0]!.entryId,
        first.snapshot.version,
      );
      expect(stale).toMatchObject({ outcome: 'rejected', reason: 'version_conflict' });
      expect(stale.snapshot.version).toBe(second.snapshot.version);

      pluginManager.requestCall(operatorId, 'JA3CCC');
      expect(pluginManager.getOperatorRuntimeStatus(operatorId).queue?.rows.map((row) => row.callsign))
        .toEqual(['JA1AAA', 'JA2BBB']);
      expect(operator.isTransmitting).toBe(false);
    });

    it('starts a stopped operator only when a manual enqueue accepts the first queue target', async () => {
      const { operator, pluginManager } = await createRuntimeHarness({
        strategy: 'assisted-qso-queue',
        startOperator: false,
      });
      const operatorId = operator.config.id;
      const sourceSlot = createSlotInfo(Date.now());
      const first = await pluginManager.enqueueQueueTarget(operatorId, {
        callsign: 'JA1AAA',
        lastMessage: {
          message: {
            message: 'BG4IAJ JA1AAA -07',
            snr: -10,
            dt: 0,
            freq: 1500,
            confidence: 1,
          },
          slotInfo: sourceSlot,
        },
      }, { startIfIdle: true });

      expect(first.outcome).toBe('accepted');
      expect(operator.isTransmitting).toBe(true);
      expect(pluginManager.getOperatorRuntimeStatus(operatorId)).toMatchObject({
        currentSlot: 'TX3',
        context: { targetCallsign: 'JA1AAA' },
        queue: { activeEntryId: first.snapshot.rows[0]?.entryId },
      });
      expect(operator.getTransmitCycles()).toEqual([(sourceSlot.cycleNumber + 1) % 2]);

      operator.stop();
      const second = await pluginManager.enqueueQueueTarget(
        operatorId,
        { callsign: 'JA2BBB' },
        { startIfIdle: true },
      );
      expect(second.outcome).toBe('accepted');
      expect(operator.isTransmitting).toBe(false);
    });

    it('honors an explicit queue mutation start request without changing other queue defaults', async () => {
      const { operator, pluginManager } = await createRuntimeHarness({
        strategy: 'assisted-qso-queue',
        startOperator: false,
      });
      const operatorId = operator.config.id;
      await pluginManager.enqueueQueueTarget(operatorId, { callsign: 'JA1AAA' }, { startIfIdle: true });
      operator.stop();

      const runtime = (pluginManager as any).getStrategyRuntime(operatorId);
      const originalEnqueue = runtime.enqueueTarget.bind(runtime);
      runtime.enqueueTarget = (request: unknown) => ({
        ...originalEnqueue(request),
        requestOperatorStart: true,
      });

      await pluginManager.enqueueQueueTarget(operatorId, { callsign: 'JA2BBB' }, { startIfIdle: true });
      expect(operator.isTransmitting).toBe(true);

      operator.stop();
      await pluginManager.enqueueQueueTarget(operatorId, { callsign: 'JA3CCC' }, { startIfIdle: false });
      expect(operator.isTransmitting).toBe(false);

      vi.spyOn(pluginManager, 'getOperatorTransmitGate').mockReturnValue({
        allowed: false,
        reason: 'blocked_for_test',
      });
      await pluginManager.enqueueQueueTarget(operatorId, { callsign: 'JA4DDD' }, { startIfIdle: true });
      expect(operator.isTransmitting).toBe(false);
    });

    it('adds each subsequent double-click target to the active multistream frame', async () => {
      const triggerReEncode = vi.fn();
      const { operator, pluginManager } = await createRuntimeHarness({
        strategy: 'assisted-qso-queue',
        startOperator: false,
        triggerReEncode,
        radioFrequency: 7_090_000,
        maxConcurrentStreams: 3,
        operatorPluginSettings: {
          'standard-qso': { parallelStreams: 3 },
        },
      });
      const operatorId = operator.config.id;
      const sourceSlot = createSlotInfo(Date.now());
      const selectedFrame = (callsign: string) => ({
        message: {
          message: `BG4IAJ ${callsign} PM95`,
          snr: -10,
          dt: 0,
          freq: 1_500,
          confidence: 1,
        },
        slotInfo: sourceSlot,
      });

      await pluginManager.enqueueQueueTarget(
        operatorId,
        { callsign: 'JA1AAA', lastMessage: selectedFrame('JA1AAA') },
        { startIfIdle: true },
      );
      expect(operator.isTransmitting).toBe(true);
      expect(pluginManager.getCurrentTransmissions(operatorId)).toHaveLength(1);
      expect(pluginManager.getOperatorRuntimeStatus(operatorId).queue).toMatchObject({
        maxActiveStreams: 3,
        requestedMaxActiveStreams: 3,
      });

      triggerReEncode.mockClear();
      await pluginManager.enqueueQueueTarget(
        operatorId,
        { callsign: 'JA2BBB', lastMessage: selectedFrame('JA2BBB') },
        { startIfIdle: true },
      );
      const secondQueue = pluginManager.getOperatorRuntimeStatus(operatorId).queue;
      expect(secondQueue?.rows.map((row) => row.callsign)).toEqual(['JA1AAA', 'JA2BBB']);
      expect(secondQueue?.activeEntryIds).toHaveLength(2);
      expect(pluginManager.getCurrentTransmissions(operatorId)).toHaveLength(2);
      expect(triggerReEncode).toHaveBeenCalledOnce();

      triggerReEncode.mockClear();
      await pluginManager.enqueueQueueTarget(
        operatorId,
        { callsign: 'JA3CCC', lastMessage: selectedFrame('JA3CCC') },
        { startIfIdle: true },
      );
      expect(pluginManager.getCurrentTransmissions(operatorId)).toHaveLength(3);
      expect(triggerReEncode).toHaveBeenCalledOnce();
    });

    it('retries a timed-out target and starts a stopped operator', async () => {
      const { operator, pluginManager } = await createRuntimeHarness({
        strategy: 'assisted-qso-queue',
        maxQSOTimeoutCycles: 1,
        maxCallAttempts: 1,
      });
      const operatorId = operator.config.id;
      await pluginManager.enqueueQueueTarget(operatorId, { callsign: 'JA1AAA' });
      const slot = createSlotInfo(Date.now());
      await (pluginManager as any).handleSlotStart(slot, createSlotPack(slot, []));
      operator.stop();

      const failed = pluginManager.getOperatorRuntimeStatus(operatorId).queue!;
      expect(failed.rows[0]).toMatchObject({
        callsign: 'JA1AAA',
        displayState: 'no-response',
        noResponseCycles: 1,
      });
      const retried = await pluginManager.retryQueueTarget(
        operatorId,
        failed.rows[0]!.entryId,
        failed.version,
      );

      expect(retried).toMatchObject({
        outcome: 'accepted',
        snapshot: { rows: [{ callsign: 'JA1AAA', displayState: 'TX1' }] },
      });
      expect(operator.isTransmitting).toBe(true);
      expect(pluginManager.getCurrentTransmissions(operatorId)).toHaveLength(1);
    });

    it('retries a target into a spare parallel lane while another lane remains active', async () => {
      const triggerReEncode = vi.fn();
      const { operator, pluginManager } = await createRuntimeHarness({
        strategy: 'assisted-qso-queue',
        maxQSOTimeoutCycles: 1,
        maxCallAttempts: 1,
        triggerReEncode,
        operatorPluginSettings: {
          'standard-qso': { parallelStreams: 3, maxQSOTimeoutCycles: 1, maxCallAttempts: 1 },
        },
      });
      const operatorId = operator.config.id;
      await pluginManager.enqueueQueueTarget(operatorId, { callsign: 'JA1AAA' });
      const firstSlot = createSlotInfo(0);
      await (pluginManager as any).handleSlotStart(firstSlot, createSlotPack(firstSlot, []));
      const failed = pluginManager.getOperatorRuntimeStatus(operatorId).queue!;
      const failedEntry = failed.rows.find((row) => row.callsign === 'JA1AAA');
      expect(failedEntry).toMatchObject({ displayState: 'no-response' });

      pluginManager.setOperatorPluginSettings(operatorId, 'assisted-qso-queue', {
        ...pluginManager.getOperatorPluginSettings(operatorId, 'assisted-qso-queue'),
        parallelStreams: 3,
        maxQSOTimeoutCycles: 6,
        maxCallAttempts: 5,
      });
      await pluginManager.enqueueQueueTarget(operatorId, { callsign: 'JA2BBB' });
      await pluginManager.resumeQueueExecution(operatorId);
      const partiallyActive = pluginManager.getOperatorRuntimeStatus(operatorId).queue!;
      expect(partiallyActive.activeEntryIds).toHaveLength(1);
      expect(partiallyActive.rows.find((row) => row.callsign === 'JA1AAA'))
        .toMatchObject({ displayState: 'no-response' });
      const orchestrator = (pluginManager as any).orchestrator;
      const revalidate = orchestrator.revalidateQueueExecutionInLane.bind(orchestrator);
      vi.spyOn(orchestrator, 'revalidateQueueExecutionInLane').mockImplementation(async (...args: unknown[]) => {
        const decision = await revalidate(...args);
        return decision ? { ...decision, transmission: null } : decision;
      });
      triggerReEncode.mockClear();

      const retried = await pluginManager.retryQueueTarget(
        operatorId,
        failedEntry!.entryId,
        partiallyActive.version,
      );

      expect(retried.outcome).toBe('accepted');
      expect(pluginManager.getOperatorRuntimeStatus(operatorId).queue?.activeEntryIds).toHaveLength(2);
      expect(pluginManager.getCurrentTransmissions(operatorId)).toHaveLength(2);
      expect(triggerReEncode).toHaveBeenCalledOnce();
      expect(triggerReEncode).toHaveBeenCalledWith(operatorId, expect.objectContaining({
        source: 'operator-edit',
        reason: 'manual assisted queue retry became executable',
        decisionEpoch: expect.any(Number),
      }));
    });

    it('removes stream-2 by replacing the operator transmission set while retaining the other lanes', async () => {
      const removeOperatorContribution = vi.fn(async () => undefined);
      const triggerReEncode = vi.fn();
      const { operator, pluginManager } = await createRuntimeHarness({
        strategy: 'assisted-qso-queue',
        removeOperatorContribution,
        triggerReEncode,
        operatorPluginSettings: {
          'standard-qso': { parallelStreams: 3 },
        },
      });
      const operatorId = operator.config.id;
      await pluginManager.enqueueQueueTarget(operatorId, { callsign: 'JA1AAA' });
      await pluginManager.enqueueQueueTarget(operatorId, { callsign: 'JA2BBB' });
      await pluginManager.enqueueQueueTarget(operatorId, { callsign: 'JA3CCC' });
      const slot = createSlotInfo(0);
      await (pluginManager as any).handleSlotStart(slot, createSlotPack(slot, []));
      const active = pluginManager.getOperatorRuntimeStatus(operatorId).queue!;
      expect(active.activeEntryIds).toHaveLength(3);
      expect(pluginManager.getCurrentTransmissions(operatorId).map((item) => item.streamId))
        .toEqual(['stream-1', 'stream-2', 'stream-3']);
      triggerReEncode.mockClear();

      const result = await pluginManager.removeQueueTarget(
        operatorId,
        active.activeEntryIds![1]!,
        active.version,
      );

      expect(result.outcome).toBe('accepted');
      expect(result.snapshot.rows.map((row) => row.callsign)).toEqual(['JA1AAA', 'JA3CCC']);
      expect(result.snapshot.activeEntryIds).toHaveLength(2);
      expect(pluginManager.getCurrentTransmissions(operatorId).map((item) => item.streamId))
        .toEqual(['stream-1', 'stream-3']);
      expect(triggerReEncode).toHaveBeenCalledOnce();
      expect(triggerReEncode).toHaveBeenCalledWith(operatorId, expect.objectContaining({
        source: 'operator-edit',
        reason: 'active assisted queue target removed by operator',
        decisionEpoch: expect.any(Number),
      }));
      expect(removeOperatorContribution).not.toHaveBeenCalled();
      expect(operator.isTransmitting).toBe(true);
    });

    it('clears every active lane by replacing the complete operator transmission set', async () => {
      const removeOperatorContribution = vi.fn(async () => undefined);
      const triggerReEncode = vi.fn();
      const { operator, pluginManager } = await createRuntimeHarness({
        strategy: 'assisted-qso-queue',
        removeOperatorContribution,
        triggerReEncode,
        operatorPluginSettings: {
          'standard-qso': { parallelStreams: 3 },
        },
      });
      const operatorId = operator.config.id;
      await pluginManager.enqueueQueueTarget(operatorId, { callsign: 'JA1AAA' });
      await pluginManager.enqueueQueueTarget(operatorId, { callsign: 'JA2BBB' });
      await pluginManager.enqueueQueueTarget(operatorId, { callsign: 'JA3CCC' });
      const slot = createSlotInfo(0);
      await (pluginManager as any).handleSlotStart(slot, createSlotPack(slot, []));
      const active = pluginManager.getOperatorRuntimeStatus(operatorId).queue!;
      expect(active.activeEntryIds).toHaveLength(3);
      triggerReEncode.mockClear();

      const result = await pluginManager.clearQueueTargets(operatorId, active.version);

      expect(result).toMatchObject({
        outcome: 'accepted',
        snapshot: { rows: [], activeEntryIds: [] },
      });
      expect(pluginManager.getCurrentTransmissions(operatorId)).toEqual([
        expect.objectContaining({ streamId: 'stream-1', text: expect.stringMatching(/^CQ /) }),
      ]);
      expect(triggerReEncode).toHaveBeenCalledOnce();
      expect(triggerReEncode).toHaveBeenCalledWith(operatorId, expect.objectContaining({
        source: 'operator-edit',
        reason: 'assisted queue cleared by operator',
        decisionEpoch: expect.any(Number),
      }));
      expect(removeOperatorContribution).not.toHaveBeenCalled();
      expect(operator.isTransmitting).toBe(true);
    });

    it('serializes rapid queue commands without dropping intermediate targets', async () => {
      const { operator, pluginManager } = await createRuntimeHarness({
        strategy: 'assisted-qso-queue',
        startOperator: false,
      });
      const results = await Promise.all(['JA1AAA', 'JA2BBB', 'HL3CCC', 'VK2ABC'].map((callsign) => (
        pluginManager.enqueueQueueTarget(operator.config.id, { callsign })
      )));

      expect(results.every((result) => result.outcome === 'accepted')).toBe(true);
      expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).queue?.rows.map((row) => row.callsign))
        .toEqual(['JA1AAA', 'JA2BBB', 'HL3CCC', 'VK2ABC']);
    });

    it('falls back to its own CQ without treating decoded CQ messages as queue targets', async () => {
      const { operator, pluginManager } = await createRuntimeHarness({
        strategy: 'assisted-qso-queue',
        autoReplyToCQ: true,
      });
      const sourceSlot = createSlotInfo(Date.now());
      await (pluginManager as any).handleSlotStart(sourceSlot, createSlotPack(sourceSlot, [{
        message: 'CQ JA1AAA PM95',
        snr: -4,
        freq: 1600,
      }]));

      const status = pluginManager.getOperatorRuntimeStatus(operator.config.id);
      expect(status.queue?.rows).toHaveLength(0);
      expect(status.context?.targetCallsign).toBeUndefined();
      expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe(status.slots?.TX6);
      expect(getCurrentTransmission(pluginManager, operator.config.id)).toMatch(/^CQ /);
    });

    it('applies worked-station and band-scope settings to automatic inbound callers', async () => {
      const hasWorkedCallsign = vi.fn(async () => true);
      const { operator, pluginManager } = await createRuntimeHarness({
        strategy: 'assisted-qso-queue',
        replyToWorkedStations: false,
        distinguishWorkedStationsByBand: false,
        hasWorkedCallsign,
      });
      const sourceSlot = createSlotInfo(Date.now());
      await (pluginManager as any).handleSlotStart(sourceSlot, createSlotPack(sourceSlot, [{
        message: 'BG4IAJ JA1AAA PM95',
        snr: -8,
        freq: 1400,
      }]));

      expect(hasWorkedCallsign).toHaveBeenCalledWith('JA1AAA', { anyBand: true });
      const status = pluginManager.getOperatorRuntimeStatus(operator.config.id);
      expect(status.queue?.rows).toHaveLength(0);
      expect(status.context?.targetCallsign).toBeUndefined();
      expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe(status.slots?.TX6);
    });

    it('automatically schedules a queued direct opportunity and clears on strategy switch', async () => {
      const { operator, pluginManager } = await createRuntimeHarness({ strategy: 'assisted-qso-queue' });
      const operatorId = operator.config.id;
      const sourceSlot = createSlotInfo(Date.now());
      await (pluginManager as any).handleSlotStart(sourceSlot, createSlotPack(sourceSlot, [{
        message: 'BG4IAJ JA1AAA -07',
        snr: -10,
        freq: 1500,
      }]));

      const active = pluginManager.getOperatorRuntimeStatus(operatorId);
      expect(active.currentSlot).toBe('TX3');
      expect(active.queue?.activeEntryId).toBe(active.queue?.rows[0]?.entryId);
      expect(active.queue?.rows[0]?.callsign).toBe('JA1AAA');
      expect(operator.getTransmitCycles()).toEqual([(sourceSlot.cycleNumber + 1) % 2]);

      pluginManager.setOperatorStrategy(operatorId, 'standard-qso');
      expect(pluginManager.getOperatorRuntimeStatus(operatorId).queue).toBeUndefined();
      pluginManager.setOperatorStrategy(operatorId, 'assisted-qso-queue');
      await vi.waitFor(() => expect(pluginManager.hasTargetQueue(operatorId)).toBe(true));
      expect(pluginManager.getOperatorRuntimeStatus(operatorId).queue?.rows).toHaveLength(0);
    });

    it('shares the standard QSO operator settings namespace', async () => {
      const { operator, pluginManager } = await createRuntimeHarness({
        strategy: 'assisted-qso-queue',
        autoReplyToCQ: true,
        autoResumeCQAfterSuccess: true,
        skipTx1: true,
      });
      expect(pluginManager.getOperatorSettingsNamespace('assisted-qso-queue')).toBe('standard-qso');
      const assistedSettings = pluginManager.getSnapshot().plugins
        .find((plugin) => plugin.name === 'assisted-qso-queue')?.settings;
      expect(Object.keys(assistedSettings ?? {})).toEqual([
        'strategyOverview',
        'replyToWorkedStations',
        'distinguishWorkedStationsByBand',
        'skipTx1',
        'maxQSOTimeoutCycles',
        'maxCallAttempts',
        'parallelStreams',
      ]);
      const assistedQuickSettings = pluginManager.getSnapshot().plugins
        .find((plugin) => plugin.name === 'assisted-qso-queue')?.quickSettings;
      expect(assistedQuickSettings?.map((entry) => entry.settingKey)).toEqual([
        'replyToWorkedStations',
        'distinguishWorkedStationsByBand',
        'skipTx1',
        'parallelStreams',
      ]);
      expect(pluginManager.getOperatorPluginSettings(operator.config.id, 'assisted-qso-queue'))
        .toMatchObject({
          autoReplyToCQ: true,
          autoResumeCQAfterSuccess: true,
          skipTx1: true,
        });
      expect(pluginManager.getOperatorPluginSettingsProjection(
        operator.config.id,
        'assisted-qso-queue',
      )).toEqual({
        replyToWorkedStations: false,
        distinguishWorkedStationsByBand: true,
        skipTx1: true,
        maxQSOTimeoutCycles: 6,
        maxCallAttempts: 5,
      });

      const saved = pluginManager.setOperatorPluginSettings(
        operator.config.id,
        'assisted-qso-queue',
        {
          replyToWorkedStations: true,
          distinguishWorkedStationsByBand: true,
          skipTx1: false,
          maxQSOTimeoutCycles: 8,
          maxCallAttempts: 4,
        },
      );
      expect(saved).toMatchObject({
        autoReplyToCQ: true,
        autoResumeCQAfterSuccess: true,
        replyToWorkedStations: true,
        skipTx1: false,
      });
      expect(pluginManager.getOperatorPluginSettings(operator.config.id, 'standard-qso'))
        .toEqual(saved);
    });

    it('keeps the same target isolated across multiple operators', async () => {
      const { operators, pluginManager, targetReservations } = await createMultiOperatorRuntimeHarness({
        strategy: 'assisted-qso-queue',
      });
      for (const operator of operators) {
        await pluginManager.enqueueQueueTarget(operator.config.id, { callsign: 'JA1AAA' });
      }

      const slot = createSlotInfo(Date.now());
      await (pluginManager as any).handleSlotStart(slot, createSlotPack(slot, []));
      const statuses = operators.map((operator) => pluginManager.getOperatorRuntimeStatus(operator.config.id));
      expect(statuses.filter((status) => status.context?.targetCallsign === 'JA1AAA')).toHaveLength(1);
      expect(statuses.filter((status) => status.queue?.activeEntryId)).toHaveLength(1);

      const activeIndex = statuses.findIndex((status) => status.queue?.activeEntryId);
      const activeOperator = operators[activeIndex]!;
      const waitingOperator = operators[activeIndex === 0 ? 1 : 0]!;
      pluginManager.suspendQueueExecution(activeOperator.config.id);
      activeOperator.stop();
      targetReservations.releaseOperator(activeOperator.config.id);
      const nextSlot = createSlotInfo(slot.startMs + MODES.FT8.slotMs);
      await (pluginManager as any).handleSlotStart(nextSlot, createSlotPack(nextSlot, []));
      expect(pluginManager.getOperatorRuntimeStatus(waitingOperator.config.id).context?.targetCallsign).toBe('JA1AAA');

      activeOperator.start();
      expect(await pluginManager.resumeQueueExecution(activeOperator.config.id)).toBe(false);
      expect(pluginManager.isQueueExecutionSuspended(activeOperator.config.id)).toBe(true);
    });

    it('projects a failed log settlement as review without selecting the next entry', async () => {
      const { operator, pluginManager } = await createRuntimeHarness({
        strategy: 'assisted-qso-queue',
        recordQSOHandler: (data) => data.reject?.(new Error('disk full')),
      });
      const operatorId = operator.config.id;
      const sourceSlot = createSlotInfo(Date.now());
      await pluginManager.enqueueQueueTarget(operatorId, {
        callsign: 'JA1AAA',
        lastMessage: {
          message: {
            message: 'BG4IAJ JA1AAA -07',
            snr: -10,
            dt: 0,
            freq: 1500,
            confidence: 1,
          },
          slotInfo: sourceSlot,
        },
      });
      await pluginManager.enqueueQueueTarget(operatorId, { callsign: 'JA2BBB' });
      await (pluginManager as any).handleSlotStart(sourceSlot, createSlotPack(sourceSlot, []));
      pluginManager.notifyTransmissionQueued(operatorId, pluginManager.getCurrentTransmission(operatorId)!);

      const rrrSlot = createSlotInfo(sourceSlot.startMs + MODES.FT8.slotMs);
      await (pluginManager as any).handleSlotStart(rrrSlot, createSlotPack(rrrSlot, [{
        message: 'BG4IAJ JA1AAA RRR',
        snr: -8,
        freq: 1500,
      }]));
      await vi.waitFor(() => expect(
        pluginManager.getOperatorRuntimeStatus(operatorId).queue?.rows[0]?.displayState,
      ).toBe('review'));
      const status = pluginManager.getOperatorRuntimeStatus(operatorId);
      expect(status.queue?.rows.map((row) => row.callsign)).toEqual(['JA1AAA', 'JA2BBB']);
      expect(status.queue?.activeEntryId).toBe(status.queue?.rows[0]?.entryId);
      expect(pluginManager.getCurrentTransmission(operatorId)).toBeNull();
    });
  });

  it('keeps manual TX6 slot content after standard-qso regenerates slots', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      myCallsign: 'BG5DRB',
      myGrid: 'OL32',
    });

    const persistedSettings = pluginManager.setOperatorRuntimeSlotContent(
      operator.config.id,
      'TX6',
      'CQ DX BG5DRB OL32',
    );
    expect(persistedSettings?.[STANDARD_QSO_TX6_MESSAGE_OVERRIDE_SETTING]).toBe('CQ DX BG5DRB OL32');

    patchRuntimeContext(pluginManager, operator.config.id, {
      targetCallsign: 'JA1AAA',
      targetGrid: 'PM95',
      reportSent: -12,
    });

    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).slots?.TX6).toBe('CQ DX BG5DRB OL32');
    expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe('CQ DX BG5DRB OL32');
  });

  it('restores manual TX6 slot content from standard-qso operator settings', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      myCallsign: 'BG5DRB',
      myGrid: 'OL32',
      operatorPluginSettings: {
        'standard-qso': {
          [STANDARD_QSO_TX6_MESSAGE_OVERRIDE_SETTING]: 'CQ TEST BG5DRB OL32',
        },
      },
    });

    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).slots?.TX6).toBe('CQ TEST BG5DRB OL32');
    expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe('CQ TEST BG5DRB OL32');
  });

  it('exposes worked-band as an operator setting and skipTx1 as a quick setting', async () => {
    const { pluginManager } = await createRuntimeHarness();

    const standardQso = pluginManager.getSnapshot().plugins.find((plugin) => plugin.name === 'standard-qso');

    expect(standardQso?.settings?.distinguishWorkedStationsByBand).toMatchObject({
      type: 'boolean',
      default: true,
      scope: 'operator',
    });
    expect(standardQso?.quickSettings?.some((entry) => entry.settingKey === 'distinguishWorkedStationsByBand')).toBe(false);
    expect(standardQso?.settings?.autoReplyToDirectCallWhenStopped).toMatchObject({
      type: 'boolean',
      default: false,
      scope: 'operator',
    });
    expect(standardQso?.quickSettings?.some((entry) => entry.settingKey === 'autoReplyToDirectCallWhenStopped')).toBe(true);
    expect(standardQso?.settings?.skipTx1).toMatchObject({
      type: 'boolean',
      default: false,
      scope: 'operator',
    });
    expect(standardQso?.quickSettings?.some((entry) => entry.settingKey === 'skipTx1')).toBe(true);

    await pluginManager.shutdown();
  });

  it('starts manual CQ calls at TX2 when skipTx1 is enabled', async () => {
    const triggerReEncode = vi.fn();
    const { operator, pluginManager } = await createRuntimeHarness({
      myCallsign: 'BG5DRB',
      myGrid: 'PM01',
      skipTx1: true,
      triggerReEncode,
    });

    pluginManager.requestCall(
      operator.config.id,
      'JA1AAA',
      {
        message: {
          message: 'CQ JA1AAA PM95',
          snr: -7,
          dt: 0,
          freq: 1300,
          confidence: 0.9,
        },
        slotInfo: createSlotInfo(45_000),
      },
      { submitCurrentFrame: true, source: 'operator-edit' },
    );

    const status = pluginManager.getOperatorRuntimeStatus(operator.config.id);
    expect(status.currentSlot).toBe('TX2');
    expect(status.context?.targetCallsign).toBe('JA1AAA');
    expect(status.slots?.TX1).toBe('JA1AAA BG5DRB PM01');
    expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe('JA1AAA BG5DRB -07');
    expect(triggerReEncode).not.toHaveBeenCalled();

    await pluginManager.shutdown();
  });

  it('starts calls without a source message at TX2 with the default report when skipTx1 is enabled', async () => {
    const triggerReEncode = vi.fn();
    const { operator, pluginManager } = await createRuntimeHarness({
      myCallsign: 'BG5DRB',
      myGrid: 'PM01',
      skipTx1: true,
      triggerReEncode,
    });

    pluginManager.requestCall(
      operator.config.id,
      'JA1AAA',
      undefined,
      { submitCurrentFrame: true, source: 'operator-edit' },
    );

    const status = pluginManager.getOperatorRuntimeStatus(operator.config.id);
    expect(status.currentSlot).toBe('TX2');
    expect(status.context?.targetCallsign).toBe('JA1AAA');
    expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe('JA1AAA BG5DRB +00');
    expect(triggerReEncode).toHaveBeenCalledWith(operator.config.id, {
      source: 'operator-edit',
      reason: 'requestCall updated operator context',
      decisionEpoch: expect.any(Number),
    });

    await pluginManager.shutdown();
  });

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
    const transmissions: Array<{ operatorId: string; transmission: string; decisionEpoch?: number }> = [];
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

  it.each([
    {
      finalMessage: 'RR73',
      initialState: 'TX2' as const,
      incomingMessage: FT8MessageParser.generateMessage({
        type: FT8MessageType.ROGER_REPORT,
        senderCallsign: 'BG5DRB',
        targetCallsign: 'BG7XTV',
        report: -5,
      }),
      expectedState: 'TX4',
      expectedTransmission: 'BG5DRB BG7XTV RR73',
    },
    {
      finalMessage: '73',
      initialState: 'TX3' as const,
      incomingMessage: FT8MessageParser.generateMessage({
        type: FT8MessageType.RRR,
        senderCallsign: 'BG5DRB',
        targetCallsign: 'BG7XTV',
      }),
      expectedState: 'TX5',
      expectedTransmission: 'BG5DRB BG7XTV 73',
    },
  ])('queues $finalMessage while durable persistence overlaps encodeStart', async ({
    initialState,
    incomingMessage,
    expectedState,
    expectedTransmission,
  }) => {
    let persistenceRequest: RecordQSORequest | undefined;
    let notifyPersistenceStarted!: () => void;
    const persistenceStarted = new Promise<void>((resolve) => {
      notifyPersistenceStarted = resolve;
    });
    const { eventEmitter, operator, pluginManager } = await createRuntimeHarness({
      myCallsign: 'BG7XTV',
      myGrid: 'OL32',
      targetCallsign: 'BG5DRB',
      recordQSOHandler: (data) => {
        persistenceRequest = data;
        notifyPersistenceStarted();
      },
    });
    const transmissions: Array<{ operatorId: string; transmission: string }> = [];
    eventEmitter.on('requestTransmit', (payload) => transmissions.push(payload));

    setRuntimeState(pluginManager, operator.config.id, initialState);
    const decisionPromise = (pluginManager as any).handleSlotStart(
      createSlotInfo(60_000),
      createSlotPack(createSlotInfo(45_000), [{
        message: incomingMessage,
        snr: -4,
        freq: 1502,
      }]),
    );
    await persistenceStarted;

    // The final RF frame remains available while durability controls later success side effects.
    expect(operator.isTransmitting).toBe(true);
    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe(expectedState);
    expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe(expectedTransmission);

    (pluginManager as any).handleEncodeStart(createSlotInfo(60_000));
    expect(transmissions).toEqual([{
      operatorId: operator.config.id,
      transmission: expectedTransmission,
      decisionEpoch: expect.any(Number),
    }]);

    const pending = persistenceRequest;
    expect(pending).toBeDefined();
    pending?.resolve?.({ ...pending.qsoRecord, id: 'persisted-test' });
    await decisionPromise;

    expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe(expectedTransmission);
    expect(transmissions).toHaveLength(1);

    await pluginManager.shutdown();
  });

  it('does not mark a rejected placeholder TX5 message as queued', async () => {
    const { eventEmitter, operator, pluginManager } = await createRuntimeHarness({
      myCallsign: 'BG7XTV',
      myGrid: 'OL32',
      targetCallsign: 'BG5DRB',
      autoResumeCQAfterSuccess: true,
    });
    const transmissions: Array<{ operatorId: string; transmission: string }> = [];
    eventEmitter.on('requestTransmit', (payload) => {
      transmissions.push(payload);
    });

    setRuntimeState(pluginManager, operator.config.id, 'TX5');
    pluginManager.setOperatorRuntimeSlotContent(
      operator.config.id,
      'TX5',
      'BG5DRB <...> 73',
    );

    (pluginManager as any).handleEncodeStart(createSlotInfo(60_000));
    expect(transmissions).toHaveLength(1);

    await (pluginManager as any).handleSlotStart(
      createSlotInfo(75_000),
      createSlotPack(createSlotInfo(60_000), []),
    );
    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX5');

    await pluginManager.shutdown();
  });

  it('switches from TX4 to TX5 when an RRR is decoded alongside a bare callsign noise frame', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      myCallsign: 'BG2BFG',
      myGrid: 'PN26',
      targetCallsign: 'K6QQX',
    });

    setRuntimeState(pluginManager, operator.config.id, 'TX4');

    await (pluginManager as any).handleSlotStart(createSlotInfo(60_000), createSlotPack(createSlotInfo(45_000), [
      {
        message: 'BG2BFG',
        snr: -11,
        freq: 671,
      },
      {
        message: 'BG2BFG K6QQX RRR',
        snr: -7,
        freq: 671,
      },
    ]));

    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX5');
    expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe('K6QQX BG2BFG 73');

    await pluginManager.shutdown();
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

  it('replies to direct calls when the callsign is only worked on another band', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      myCallsign: 'BG5DRB',
      myGrid: 'PL09',
      replyToWorkedStations: false,
      hasWorkedCallsign: false,
    });

    await (pluginManager as any).handleSlotStart(createSlotInfo(60_000), createSlotPack(createSlotInfo(45_000), [{
      message: FT8MessageParser.generateMessage({
        type: FT8MessageType.CALL,
        senderCallsign: 'BG7OO',
        targetCallsign: 'BG5DRB',
        grid: 'OL63',
      }),
      snr: -6,
      freq: 1395,
    }]));

    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX2');
    expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe('BG7OO BG5DRB -06');

    await pluginManager.shutdown();
  });

  it('treats any-band worked direct callers as worked when band distinction is disabled', async () => {
    const hasWorkedSpy = vi.fn((_callsign: string, options?: { anyBand?: boolean }) => options?.anyBand === true);
    const { operator, pluginManager } = await createRuntimeHarness({
      myCallsign: 'BG5DRB',
      myGrid: 'PL09',
      replyToWorkedStations: false,
      distinguishWorkedStationsByBand: false,
      hasWorkedCallsign: hasWorkedSpy,
    });

    await (pluginManager as any).handleSlotStart(createSlotInfo(60_000), createSlotPack(createSlotInfo(45_000), [{
      message: FT8MessageParser.generateMessage({
        type: FT8MessageType.CALL,
        senderCallsign: 'BG7OO',
        targetCallsign: 'BG5DRB',
        grid: 'OL63',
      }),
      snr: -6,
      freq: 1395,
    }]));

    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX6');
    expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe('CQ BG5DRB PL09');
    expect(hasWorkedSpy).toHaveBeenCalledWith('BG7OO', { anyBand: true });

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

  it('does not wake a stopped operator for direct calls by default', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      startOperator: false,
      myCallsign: 'BG7XTV',
      myGrid: 'OL32',
    });

    await (pluginManager as any).handleSlotStart(createSlotInfo(30_000), createSlotPack(createSlotInfo(15_000), [{
      message: 'BG7XTV JA1AAA -12',
      snr: -18,
      freq: 1300,
    }]));

    expect(operator.isTransmitting).toBe(false);
    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX6');
    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).context?.targetCallsign).toBeUndefined();

    await pluginManager.shutdown();
  });

  it('wakes a stopped idle operator for direct CALL when enabled', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      startOperator: false,
      myCallsign: 'BG7XTV',
      myGrid: 'OL32',
      autoReplyToDirectCallWhenStopped: true,
    });

    await (pluginManager as any).handleSlotStart(createSlotInfo(30_000), createSlotPack(createSlotInfo(15_000), [{
      message: FT8MessageParser.generateMessage({
        type: FT8MessageType.CALL,
        senderCallsign: 'JA1AAA',
        targetCallsign: 'BG7XTV',
        grid: 'PM95',
      }),
      snr: -8,
      freq: 1502,
    }]));

    const status = pluginManager.getOperatorRuntimeStatus(operator.config.id);
    expect(operator.isTransmitting).toBe(true);
    expect(operator.getTransmitCycles()).toEqual([0]);
    expect(status.currentSlot).toBe('TX2');
    expect(status.context?.targetCallsign).toBe('JA1AAA');
    expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe('JA1AAA BG7XTV -08');

    await pluginManager.shutdown();
  });

  it('wakes a stopped idle operator for direct signal reports when enabled', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      startOperator: false,
      myCallsign: 'BG7XTV',
      myGrid: 'OL32',
      autoReplyToDirectCallWhenStopped: true,
    });

    await (pluginManager as any).handleSlotStart(createSlotInfo(45_000), createSlotPack(createSlotInfo(30_000), [{
      message: 'BG7XTV JA1AAA -12',
      snr: -18,
      freq: 1300,
    }]));

    const status = pluginManager.getOperatorRuntimeStatus(operator.config.id);
    expect(operator.isTransmitting).toBe(true);
    expect(operator.getTransmitCycles()).toEqual([1]);
    expect(status.currentSlot).toBe('TX3');
    expect(status.context?.targetCallsign).toBe('JA1AAA');
    expect(status.context?.reportReceived).toBe(-12);
    expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe('JA1AAA BG7XTV R-18');

    await pluginManager.shutdown();
  });

  it('does not wake a stopped operator for worked direct callers when duplicates are disabled', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      startOperator: false,
      myCallsign: 'BG7XTV',
      myGrid: 'OL32',
      autoReplyToDirectCallWhenStopped: true,
      replyToWorkedStations: false,
      hasWorkedCallsign: true,
    });

    await (pluginManager as any).handleSlotStart(createSlotInfo(30_000), createSlotPack(createSlotInfo(15_000), [{
      message: FT8MessageParser.generateMessage({
        type: FT8MessageType.CALL,
        senderCallsign: 'JA1AAA',
        targetCallsign: 'BG7XTV',
        grid: 'PM95',
      }),
      snr: -8,
      freq: 1502,
    }]));

    expect(operator.isTransmitting).toBe(false);
    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX6');
    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).context?.targetCallsign).toBeUndefined();

    await pluginManager.shutdown();
  });

  it('does not wake a stopped non-idle operator for direct calls', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      startOperator: false,
      myCallsign: 'BG7XTV',
      myGrid: 'OL32',
      targetCallsign: 'BG5DRB',
      autoReplyToDirectCallWhenStopped: true,
    });
    setRuntimeState(pluginManager, operator.config.id, 'TX2');

    await (pluginManager as any).handleSlotStart(createSlotInfo(30_000), createSlotPack(createSlotInfo(15_000), [{
      message: 'BG7XTV JA1AAA -12',
      snr: -18,
      freq: 1300,
    }]));

    const status = pluginManager.getOperatorRuntimeStatus(operator.config.id);
    expect(operator.isTransmitting).toBe(false);
    expect(status.currentSlot).toBe('TX2');
    expect(status.context?.targetCallsign).toBe('BG5DRB');

    await pluginManager.shutdown();
  });

  it('does not wake a stopped operator when another same-callsign operator is working the direct caller', async () => {
    const { operators, pluginManager } = await createMultiOperatorRuntimeHarness({
      autoReplyToDirectCallWhenStopped: true,
    });
    const [stoppedOperator, activeOperator] = operators;
    stoppedOperator.stop();
    patchRuntimeContext(pluginManager, activeOperator.config.id, {
      targetCallsign: 'JA1AAA',
      targetGrid: 'PM95',
      reportSent: -5,
    });
    setRuntimeState(pluginManager, activeOperator.config.id, 'TX2');

    await (pluginManager as any).handleSlotStart(createSlotInfo(30_000), createSlotPack(createSlotInfo(15_000), [{
      message: FT8MessageParser.generateMessage({
        type: FT8MessageType.CALL,
        senderCallsign: 'JA1AAA',
        targetCallsign: 'BG4IAJ',
        grid: 'PM95',
      }),
      snr: -8,
      freq: 1502,
    }]));

    expect(stoppedOperator.isTransmitting).toBe(false);
    expect(pluginManager.getOperatorRuntimeStatus(stoppedOperator.config.id).currentSlot).toBe('TX6');
    expect(pluginManager.getOperatorRuntimeStatus(stoppedOperator.config.id).context?.targetCallsign).toBeUndefined();

    await pluginManager.shutdown();
  });

  it('uses WSJT-X structured slots when manually calling a special event long callsign', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      myCallsign: 'BG5DRB',
      myGrid: 'PM01',
    });
    const sourceSlot = createSlotInfo(45_000);

    pluginManager.requestCall(operator.config.id, 'SX100PAOK', {
      message: {
        message: 'CQ SX100PAOK',
        snr: -10,
        dt: 0,
        freq: 1500,
        confidence: 0.9,
      },
      slotInfo: sourceSlot,
    });

    const status = pluginManager.getOperatorRuntimeStatus(operator.config.id);
    expect(status.currentSlot).toBe('TX1');
    expect(status.context?.targetCallsign).toBe('SX100PAOK');
    expect(status.slots?.TX1).toBe('<SX100PAOK> BG5DRB PM01');
    expect(status.slots?.TX2).toBe('<SX100PAOK> BG5DRB -10');
    expect(status.slots?.TX3).toBe('<SX100PAOK> BG5DRB R-10');
    expect(status.slots?.TX4).toBe('<SX100PAOK> BG5DRB RR73');
    expect(status.slots?.TX5).toBe('<SX100PAOK> BG5DRB 73');

    await pluginManager.shutdown();
  });

  it('advances from TX1 when a special event long callsign sends an R-report', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      myCallsign: 'BG5DRB',
      myGrid: 'PM01',
      targetCallsign: 'SX100PAOK',
    });
    setRuntimeState(pluginManager, operator.config.id, 'TX1');

    await (pluginManager as any).handleSlotStart(createSlotInfo(60_000), createSlotPack(createSlotInfo(45_000), [{
      message: 'BG5DRB <SX100PAOK> R-10',
      snr: -7,
      freq: 1502,
    }]));

    const status = pluginManager.getOperatorRuntimeStatus(operator.config.id);
    expect(status.currentSlot).toBe('TX4');
    expect(status.context?.targetCallsign).toBe('SX100PAOK');
    expect(status.context?.reportReceived).toBe(-10);
    expect(status.context?.reportSent).toBe(-7);
    expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe('<SX100PAOK> BG5DRB RR73');

    await pluginManager.shutdown();
  });

  it('advances from TX3 when a special event long callsign sends 73', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      myCallsign: 'BG5DRB',
      myGrid: 'PM01',
      targetCallsign: 'SX100PAOK',
    });
    patchRuntimeContext(pluginManager, operator.config.id, {
      targetCallsign: 'SX100PAOK',
      reportSent: -10,
      reportReceived: -7,
    });
    setRuntimeState(pluginManager, operator.config.id, 'TX3');

    await (pluginManager as any).handleSlotStart(createSlotInfo(60_000), createSlotPack(createSlotInfo(45_000), [{
      message: 'BG5DRB <SX100PAOK> 73',
      snr: -7,
      freq: 1502,
    }]));

    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX5');
    expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe('<SX100PAOK> BG5DRB 73');

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

  it('resumes from TX6 to reply to a delayed R-report after failed CQ recovery', async () => {
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
    expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe('CQ BG7XTV OL32');

    await (pluginManager as any).handleSlotStart(createSlotInfo(75_000), createSlotPack(createSlotInfo(60_000), [{
      message: 'BG7XTV BG5DRB R-11',
      snr: -6,
      freq: 1502,
    }]));

    const status = pluginManager.getOperatorRuntimeStatus(operator.config.id);
    expect(status.currentSlot).toBe('TX4');
    expect(status.context?.targetCallsign).toBe('BG5DRB');
    expect(status.context?.reportReceived).toBe(-11);
    expect(status.context?.reportSent).toBe(-6);
    expect(operator.isTransmitting).toBe(true);
    expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe('BG5DRB BG7XTV RR73');

    await pluginManager.shutdown();
  });

  it('re-decides from queued CQ to a delayed R-report after failed CQ recovery', async () => {
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
    expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe('CQ BG7XTV OL32');

    const changed = await pluginManager.reDecideOperator(operator.config.id, createSlotPack(createSlotInfo(45_000), [{
      message: 'BG7XTV BG5DRB R-11',
      snr: -6,
      freq: 1502,
    }]));

    const status = pluginManager.getOperatorRuntimeStatus(operator.config.id);
    expect(changed).toBe(true);
    expect(status.currentSlot).toBe('TX4');
    expect(status.context?.targetCallsign).toBe('BG5DRB');
    expect(operator.isTransmitting).toBe(true);
    expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe('BG5DRB BG7XTV RR73');

    await pluginManager.shutdown();
  });

  it('re-decides from queued CQ to a delayed RR73 after failed CQ recovery', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      myCallsign: 'BG7XTV',
      myGrid: 'OL32',
      targetCallsign: 'BG5DRB',
      autoResumeCQAfterFail: true,
      maxQSOTimeoutCycles: 1,
    });

    setRuntimeState(pluginManager, operator.config.id, 'TX2');
    await (pluginManager as any).handleSlotStart(createSlotInfo(60_000), createSlotPack(createSlotInfo(45_000), []));

    const changed = await pluginManager.reDecideOperator(operator.config.id, createSlotPack(createSlotInfo(45_000), [{
      message: 'BG7XTV BG5DRB RR73',
      snr: -6,
      freq: 1502,
    }]));

    const status = pluginManager.getOperatorRuntimeStatus(operator.config.id);
    expect(changed).toBe(true);
    expect(status.currentSlot).toBe('TX5');
    expect(status.context?.targetCallsign).toBe('BG5DRB');
    expect(operator.isTransmitting).toBe(true);
    expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe('BG5DRB BG7XTV 73');

    await pluginManager.shutdown();
  });

  it('preserves delayed R-report recovery through candidate filters at TX6', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      myCallsign: 'BG7XTV',
      myGrid: 'OL32',
      targetCallsign: 'BG5DRB',
      autoResumeCQAfterFail: true,
      maxQSOTimeoutCycles: 1,
      pluginConfigs: {
        'snr-filter': {
          enabled: true,
          settings: {
            minSNR: -15,
          },
        },
      },
    });

    setRuntimeState(pluginManager, operator.config.id, 'TX2');
    await (pluginManager as any).handleSlotStart(createSlotInfo(60_000), createSlotPack(createSlotInfo(45_000), []));

    const changed = await pluginManager.reDecideOperator(operator.config.id, createSlotPack(createSlotInfo(45_000), [{
      message: 'BG7XTV BG5DRB R-11',
      snr: -21,
      freq: 1502,
    }]));

    const status = pluginManager.getOperatorRuntimeStatus(operator.config.id);
    expect(changed).toBe(true);
    expect(status.currentSlot).toBe('TX4');
    expect(status.context?.targetCallsign).toBe('BG5DRB');
    expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe('BG5DRB BG7XTV RR73');

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

  it('takes over a third-party direct TX2 in the same RX batch after our RR73 is answered with 73', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      myCallsign: 'BG7XTV',
      myGrid: 'OL32',
      targetCallsign: 'BG5DRB',
      autoResumeCQAfterSuccess: false,
    });

    setRuntimeState(pluginManager, operator.config.id, 'TX4');
    await (pluginManager as any).handleSlotStart(createSlotInfo(60_000), createSlotPack(createSlotInfo(45_000), [
      {
        message: FT8MessageParser.generateMessage({
          type: FT8MessageType.SEVENTY_THREE,
          senderCallsign: 'BG5DRB',
          targetCallsign: 'BG7XTV',
        }),
        snr: 5,
        freq: 1502,
      },
      {
        message: 'BG7XTV JA1AAA -12',
        snr: -18,
        freq: 1300,
      },
    ]));

    const status = pluginManager.getOperatorRuntimeStatus(operator.config.id);
    expect(status.currentSlot).toBe('TX3');
    expect(status.context?.targetCallsign).toBe('JA1AAA');
    expect(status.context?.reportReceived).toBe(-12);
    expect(operator.isTransmitting).toBe(true);
    expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe('JA1AAA BG7XTV R-18');

    await pluginManager.shutdown();
  });

  it('wakes from silent listen for a late direct TX2 after our RR73 is answered with 73', async () => {
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

    const changed = await pluginManager.reDecideOperator(operator.config.id, createSlotPack(createSlotInfo(45_000), [{
      message: 'BG7XTV JA1AAA -12',
      snr: -18,
      freq: 1300,
    }]));

    const status = pluginManager.getOperatorRuntimeStatus(operator.config.id);
    expect(changed).toBe(true);
    expect(status.currentSlot).toBe('TX3');
    expect(status.context?.targetCallsign).toBe('JA1AAA');
    expect(operator.isTransmitting).toBe(true);
    expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe('JA1AAA BG7XTV R-18');

    await pluginManager.shutdown();
  });

  it('wakes from silent listen for a late direct TX2 after queueing our final 73', async () => {
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

    const changed = await pluginManager.reDecideOperator(operator.config.id, createSlotPack(createSlotInfo(60_000), [{
      message: 'BG7XTV JA1AAA -12',
      snr: -18,
      freq: 1300,
    }]));

    const status = pluginManager.getOperatorRuntimeStatus(operator.config.id);
    expect(changed).toBe(true);
    expect(status.currentSlot).toBe('TX3');
    expect(status.context?.targetCallsign).toBe('JA1AAA');
    expect(operator.isTransmitting).toBe(true);
    expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe('JA1AAA BG7XTV R-18');

    await pluginManager.shutdown();
  });

  it('does not wake from silent listen after the success window expires', async () => {
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

    expect(operator.isTransmitting).toBe(false);

    const changed = await pluginManager.reDecideOperator(operator.config.id, createSlotPack(createSlotInfo(90_000), [{
      message: 'BG7XTV JA1AAA -12',
      snr: -18,
      freq: 1300,
    }]));

    expect(changed).toBe(false);
    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX6');
    expect(operator.isTransmitting).toBe(false);

    const rReportChanged = await pluginManager.reDecideOperator(operator.config.id, createSlotPack(createSlotInfo(45_000), [{
      message: 'BG7XTV JA1AAA R-12',
      snr: -18,
      freq: 1300,
    }]));

    expect(rReportChanged).toBe(false);
    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX6');
    expect(operator.isTransmitting).toBe(false);

    await pluginManager.shutdown();
  });

  it('does not wake from a failed-QSO stop without a success silent-listen gate', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      myCallsign: 'BG7XTV',
      myGrid: 'OL32',
      targetCallsign: 'BG5DRB',
      autoResumeCQAfterFail: false,
      maxQSOTimeoutCycles: 1,
    });

    setRuntimeState(pluginManager, operator.config.id, 'TX2');
    await (pluginManager as any).handleSlotStart(createSlotInfo(60_000), createSlotPack(createSlotInfo(45_000), []));
    expect(operator.isTransmitting).toBe(false);

    const changed = await pluginManager.reDecideOperator(operator.config.id, createSlotPack(createSlotInfo(45_000), [{
      message: 'BG7XTV JA1AAA -12',
      snr: -18,
      freq: 1300,
    }]));

    expect(changed).toBe(false);
    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX6');
    expect(operator.isTransmitting).toBe(false);

    await pluginManager.shutdown();
  });

  it('does not wake after a manual stop without a success silent-listen gate', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      myCallsign: 'BG7XTV',
      myGrid: 'OL32',
    });

    operator.stop();

    const changed = await pluginManager.reDecideOperator(operator.config.id, createSlotPack(createSlotInfo(45_000), [{
      message: 'BG7XTV JA1AAA -12',
      snr: -18,
      freq: 1300,
    }]));

    expect(changed).toBe(false);
    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX6');
    expect(operator.isTransmitting).toBe(false);

    await pluginManager.shutdown();
  });

  it('stops future automation without interrupting committed RF when a late re-decision stops the operator', async () => {
    const interruptOperatorTransmission = vi.fn(async () => undefined);
    const { operator, pluginManager, requestOperatorStrategyStop } = await createRuntimeHarness({
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
    expect(requestOperatorStrategyStop).toHaveBeenCalledWith(operator.config.id, 'strategy stop');
    expect(interruptOperatorTransmission).not.toHaveBeenCalled();

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

  it('uses only the active band rules when callsign-filter per-band mode is enabled', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      radioBand: '40m',
      pluginConfigs: {
        'callsign-filter': { enabled: true, settings: {} },
      },
      operatorPluginSettings: {
        'callsign-filter': {
          filterMode: 'blocklist',
          perBandEnabled: true,
          filterRules: ['K'],
          bandFilterRules: {
            '40m': ['JA'],
            '20m': ['BG5DRB'],
          },
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

    expect(filtered.map((candidate) => getSenderCallsign(candidate.message))).toEqual(['BG5DRB', 'K1ABC']);

    await pluginManager.shutdown();
  });

  it('allows all callsigns when callsign-filter per-band mode has no rules for the active band', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      radioBand: '20m',
      pluginConfigs: {
        'callsign-filter': { enabled: true, settings: {} },
      },
      operatorPluginSettings: {
        'callsign-filter': {
          filterMode: 'blocklist',
          perBandEnabled: true,
          filterRules: ['K'],
          bandFilterRules: {
            '40m': ['JA'],
          },
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

    expect(filtered.map((candidate) => getSenderCallsign(candidate.message))).toEqual(['JA1AAA', 'K1ABC']);

    await pluginManager.shutdown();
  });

  it('applies regex keep rules in callsign-filter per-band mode', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      radioBand: '40m',
      pluginConfigs: {
        'callsign-filter': { enabled: true, settings: {} },
      },
      operatorPluginSettings: {
        'callsign-filter': {
          filterMode: 'regex-keep',
          perBandEnabled: true,
          bandFilterRules: {
            '40m': ['^JA', '^BG5DRB$'],
          },
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

    expect(filtered.map((candidate) => getSenderCallsign(candidate.message))).toEqual(['JA1AAA', 'BG5DRB']);

    await pluginManager.shutdown();
  });

  it('blocks candidates by DXCC entity when callsign-filter DXCC block is enabled', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      pluginConfigs: {
        'callsign-filter': { enabled: true, settings: {} },
      },
      operatorPluginSettings: {
        'callsign-filter': {
          dxccBlockEnabled: true,
          blockedDxccEntityCodes: ['339'],
        },
      },
    });

    const filtered = await pluginManager.getHookDispatcher().dispatchFilterCandidates(
      operator.config.id,
      [
        createParsedMessage('CQ JA1AAA PM95', -5, 1200),
        createParsedMessage('CQ BG5DRB OL32', -7, 1400),
      ],
      (instance) => pluginManager.getCtxForInstance(instance),
    );

    expect(filtered.map((candidate) => getSenderCallsign(candidate.message))).toEqual(['BG5DRB']);

    await pluginManager.shutdown();
  });

  it('uses only the active band DXCC blocks when callsign-filter per-band mode is enabled', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      radioBand: '40m',
      pluginConfigs: {
        'callsign-filter': { enabled: true, settings: {} },
      },
      operatorPluginSettings: {
        'callsign-filter': {
          perBandEnabled: true,
          dxccBlockEnabled: true,
          blockedDxccEntityCodes: ['318'],
          bandBlockedDxccEntityCodes: {
            '40m': ['339'],
            '20m': ['318'],
          },
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

    expect(filtered.map((candidate) => getSenderCallsign(candidate.message))).toEqual(['BG5DRB', 'K1ABC']);

    await pluginManager.shutdown();
  });

  it('does not inherit common DXCC blocks when per-band mode has no entities for the active band', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      radioBand: '20m',
      pluginConfigs: {
        'callsign-filter': { enabled: true, settings: {} },
      },
      operatorPluginSettings: {
        'callsign-filter': {
          perBandEnabled: true,
          dxccBlockEnabled: true,
          blockedDxccEntityCodes: ['339'],
          bandBlockedDxccEntityCodes: {
            '40m': ['339'],
          },
        },
      },
    });

    const filtered = await pluginManager.getHookDispatcher().dispatchFilterCandidates(
      operator.config.id,
      [
        createParsedMessage('CQ JA1AAA PM95', -5, 1200),
        createParsedMessage('CQ BG5DRB OL32', -7, 1400),
      ],
      (instance) => pluginManager.getCtxForInstance(instance),
    );

    expect(filtered.map((candidate) => getSenderCallsign(candidate.message))).toEqual(['JA1AAA', 'BG5DRB']);

    await pluginManager.shutdown();
  });

  it('leaves DXCC entities untouched when callsign-filter DXCC block is disabled', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      pluginConfigs: {
        'callsign-filter': { enabled: true, settings: {} },
      },
      operatorPluginSettings: {
        'callsign-filter': {
          dxccBlockEnabled: false,
          blockedDxccEntityCodes: ['339'],
        },
      },
    });

    const filtered = await pluginManager.getHookDispatcher().dispatchFilterCandidates(
      operator.config.id,
      [
        createParsedMessage('CQ JA1AAA PM95', -5, 1200),
        createParsedMessage('CQ BG5DRB OL32', -7, 1400),
      ],
      (instance) => pluginManager.getCtxForInstance(instance),
    );

    expect(filtered.map((candidate) => getSenderCallsign(candidate.message))).toEqual(['JA1AAA', 'BG5DRB']);

    await pluginManager.shutdown();
  });

  it('applies per-band DXCC blocks as an extra condition in regex keep mode', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      radioBand: '40m',
      pluginConfigs: {
        'callsign-filter': { enabled: true, settings: {} },
      },
      operatorPluginSettings: {
        'callsign-filter': {
          filterMode: 'regex-keep',
          perBandEnabled: true,
          bandFilterRules: {
            '40m': ['^JA', '^BG5DRB$'],
          },
          dxccBlockEnabled: true,
          bandBlockedDxccEntityCodes: {
            '40m': ['339'],
          },
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

    expect(filtered.map((candidate) => getSenderCallsign(candidate.message))).toEqual(['BG5DRB']);

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

  it('preserves weak direct TX2 signal reports through snr-filter while in CQ state', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      myCallsign: 'BG4IAJ',
      myGrid: 'OM96',
      pluginConfigs: {
        'snr-filter': {
          enabled: true,
          settings: {
            minSNR: -8,
          },
        },
      },
    });

    await (pluginManager as any).handleSlotStart(createSlotInfo(15_000), createSlotPack(createSlotInfo(15_000), [{
      message: 'BG4IAJ JA1AAA -12',
      snr: -20,
      freq: 1200,
    }]));

    const status = pluginManager.getOperatorRuntimeStatus(operator.config.id);
    expect(status.currentSlot).toBe('TX3');
    expect(status.context?.targetCallsign).toBe('JA1AAA');
    expect(status.context?.reportReceived).toBe(-12);
    expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe('JA1AAA BG4IAJ R-20');

    await pluginManager.shutdown();
  });

  it('preserves direct TX2 signal reports through callsign-filter rules while in CQ state', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      myCallsign: 'BG4IAJ',
      myGrid: 'OM96',
      pluginConfigs: {
        'callsign-filter': { enabled: true, settings: {} },
      },
      operatorPluginSettings: {
        'callsign-filter': {
          filterMode: 'blocklist',
          filterRules: ['JA'],
        },
      },
    });

    await (pluginManager as any).handleSlotStart(createSlotInfo(15_000), createSlotPack(createSlotInfo(15_000), [{
      message: 'BG4IAJ JA1AAA -12',
      snr: -10,
      freq: 1200,
    }]));

    const status = pluginManager.getOperatorRuntimeStatus(operator.config.id);
    expect(status.currentSlot).toBe('TX3');
    expect(status.context?.targetCallsign).toBe('JA1AAA');
    expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe('JA1AAA BG4IAJ R-10');

    await pluginManager.shutdown();
  });

  it('lets snr-filter prioritize a higher-SNR normal CQ over a weak new DXCC CQ', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      autoReplyToCQ: true,
      pluginConfigs: {
        'snr-filter': {
          enabled: true,
          settings: {
            minSNR: -30,
            prioritizeHigherSNR: true,
          },
        },
      },
    });

    await (pluginManager as any).handleSlotStart(createSlotInfo(15_000), createSlotPack(createSlotInfo(15_000), [
      {
        message: 'CQ DX1NEW OO01',
        snr: -16,
        freq: 1200,
        logbookAnalysis: {
          callsign: 'DX1NEW',
          isNewDxccEntity: true,
          dxccStatus: 'current',
        },
      },
      {
        message: 'CQ JA1AAA PM95',
        snr: -3,
        freq: 1400,
        logbookAnalysis: {
          callsign: 'JA1AAA',
          isNewDxccEntity: false,
          dxccStatus: 'current',
        },
      },
    ]));

    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).context?.targetCallsign).toBe('JA1AAA');

    await pluginManager.shutdown();
  });

  it('keeps novelty-first CQ selection when snr-filter SNR-priority is disabled', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      autoReplyToCQ: true,
      pluginConfigs: {
        'snr-filter': {
          enabled: true,
          settings: {
            minSNR: -30,
            prioritizeHigherSNR: false,
          },
        },
      },
    });

    await (pluginManager as any).handleSlotStart(createSlotInfo(15_000), createSlotPack(createSlotInfo(15_000), [
      {
        message: 'CQ DX1NEW OO01',
        snr: -16,
        freq: 1200,
        logbookAnalysis: {
          callsign: 'DX1NEW',
          isNewDxccEntity: true,
          dxccStatus: 'current',
        },
      },
      {
        message: 'CQ JA1AAA PM95',
        snr: -3,
        freq: 1400,
        logbookAnalysis: {
          callsign: 'JA1AAA',
          isNewDxccEntity: false,
          dxccStatus: 'current',
        },
      },
    ]));

    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).context?.targetCallsign).toBe('DX1NEW');

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

  it('refreshes operator config after plugin initialization before choosing between direct calls and CQ', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      autoReplyToCQ: true,
    });

    operator.config.myCallsign = 'BI7ALG';
    operator.config.myGrid = 'OL78';

    expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe('CQ BI7ALG OL78');

    await (pluginManager as any).handleSlotStart(createSlotInfo(15_000), createSlotPack(createSlotInfo(15_000), [
      {
        message: 'BI7ALG BG4JLJ -06',
        snr: 10,
        freq: 919,
      },
      {
        message: 'CQ DX LA9GX JO59',
        snr: -17,
        freq: 1197,
      },
    ]));

    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX3');
    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).context?.targetCallsign).toBe('BG4JLJ');
    expect(getCurrentTransmission(pluginManager, operator.config.id)).toMatch(/^BG4JLJ BI7ALG R/);

    await pluginManager.shutdown();
  });

  it('assigns simultaneous direct callers across same-callsign operators after config refresh', async () => {
    const { operators, pluginManager } = await createMultiOperatorRuntimeHarness({
      operatorCount: 2,
    });

    for (const operator of operators) {
      operator.config.myCallsign = 'BI7ALG';
      operator.config.myGrid = 'OL78';
    }

    const slotInfo = createSlotInfo(15_000);
    await (pluginManager as any).handleSlotStart(slotInfo, createSlotPack(slotInfo, [
      {
        message: 'BI7ALG BG4JLJ -06',
        snr: 10,
        freq: 919,
      },
      {
        message: 'BI7ALG BA7IWL OL63',
        snr: 1,
        freq: 1619,
      },
    ]));

    const firstStatus = pluginManager.getOperatorRuntimeStatus(operators[0].config.id);
    const secondStatus = pluginManager.getOperatorRuntimeStatus(operators[1].config.id);

    expect(firstStatus.currentSlot).toBe('TX3');
    expect(firstStatus.context?.targetCallsign).toBe('BG4JLJ');
    expect(secondStatus.currentSlot).toBe('TX2');
    expect(secondStatus.context?.targetCallsign).toBe('BA7IWL');
    expect(new Set([
      firstStatus.context?.targetCallsign,
      secondStatus.context?.targetCallsign,
    ])).toEqual(new Set(['BG4JLJ', 'BA7IWL']));

    await pluginManager.shutdown();
  });

  it('ignores another local operator TX echo when both operators transmit in the same source cycle', async () => {
    const { operators, pluginManager } = await createMultiOperatorRuntimeHarness({
      operatorCount: 2,
      autoReplyToCQ: true,
    });
    const [sourceOperator, receivingOperator] = operators;
    sourceOperator.config.myCallsign = 'BH2VSQ';
    sourceOperator.config.myGrid = 'OM44';
    receivingOperator.config.myCallsign = 'BI9CBK';
    receivingOperator.config.myGrid = 'OM44';
    sourceOperator.setTransmitCycles([0]);
    receivingOperator.setTransmitCycles([0]);

    await (pluginManager as any).handleSlotStart(createSlotInfo(30_000), createSlotPack(createSlotInfo(30_000), [
      {
        message: FT8MessageParser.generateMessage({
          type: FT8MessageType.CALL,
          senderCallsign: 'BH2VSQ',
          targetCallsign: 'BI9CBK',
          grid: 'OM44',
        }),
        snr: -999,
        freq: 1214,
        operatorId: sourceOperator.config.id,
      },
      {
        message: FT8MessageParser.generateMessage({
          type: FT8MessageType.CQ,
          senderCallsign: 'BH2VSQ',
          grid: 'OM44',
        }),
        snr: -999,
        freq: 1214,
        operatorId: sourceOperator.config.id,
      },
    ]));

    const status = pluginManager.getOperatorRuntimeStatus(receivingOperator.config.id);
    expect(status.currentSlot).toBe('TX6');
    expect(status.context?.targetCallsign).toBeUndefined();
    expect(getCurrentTransmission(pluginManager, receivingOperator.config.id)).toBe('CQ BI9CBK OM44');

    await pluginManager.shutdown();
  });

  it('allows another local operator TX echo from an RX source cycle and normalizes its SNR', async () => {
    const { operators, pluginManager } = await createMultiOperatorRuntimeHarness({
      operatorCount: 2,
      autoReplyToCQ: true,
    });
    const [sourceOperator, receivingOperator] = operators;
    sourceOperator.config.myCallsign = 'BH2VSQ';
    sourceOperator.config.myGrid = 'OM44';
    receivingOperator.config.myCallsign = 'BI9CBK';
    receivingOperator.config.myGrid = 'OM44';
    sourceOperator.setTransmitCycles([0]);
    receivingOperator.setTransmitCycles([1]);

    await (pluginManager as any).handleSlotStart(createSlotInfo(30_000), createSlotPack(createSlotInfo(30_000), [{
      message: FT8MessageParser.generateMessage({
        type: FT8MessageType.CALL,
        senderCallsign: 'BH2VSQ',
        targetCallsign: 'BI9CBK',
        grid: 'OM44',
      }),
      snr: -999,
      freq: 1214,
      operatorId: sourceOperator.config.id,
    }]));

    const status = pluginManager.getOperatorRuntimeStatus(receivingOperator.config.id);
    expect(status.currentSlot).toBe('TX2');
    expect(status.context?.targetCallsign).toBe('BH2VSQ');
    expect(status.context?.reportSent).toBe(10);
    expect(getCurrentTransmission(pluginManager, receivingOperator.config.id)).toBe('BH2VSQ BI9CBK +10');

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

  it('auto-replies to CQ at TX2 when skipTx1 is enabled', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      myCallsign: 'BG4IAJ',
      myGrid: 'OM96',
      autoReplyToCQ: true,
      skipTx1: true,
    });

    await (pluginManager as any).handleSlotStart(
      createSlotInfo(15_000),
      createSlotPack(createSlotInfo(15_000), [{
        message: 'CQ JA1AAA PM95',
        snr: -5,
        freq: 1200,
      }]),
    );

    const status = pluginManager.getOperatorRuntimeStatus(operator.config.id);
    expect(status.currentSlot).toBe('TX2');
    expect(status.context?.targetCallsign).toBe('JA1AAA');
    expect(status.slots?.TX1).toBe('JA1AAA BG4IAJ OM96');
    expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe('JA1AAA BG4IAJ -05');

    await pluginManager.shutdown();
  });

  it('auto-replies to CQ when the callsign is only worked on another band by default', async () => {
    const hasWorkedSpy = vi.fn((_callsign: string, options?: { anyBand?: boolean }) => options?.anyBand === true);
    const { operator, pluginManager } = await createRuntimeHarness({
      myCallsign: 'BG5DRB',
      myGrid: 'PL09',
      autoReplyToCQ: true,
      hasWorkedCallsign: hasWorkedSpy,
    });

    await (pluginManager as any).handleSlotStart(
      createSlotInfo(15_000),
      createSlotPack(createSlotInfo(15_000), [{
        message: 'CQ BG7OO OL63',
        snr: -5,
        freq: 1395,
      }]),
    );

    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX1');
    expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe('BG7OO BG5DRB PL09');
    expect(hasWorkedSpy).toHaveBeenCalledWith('BG7OO', { anyBand: false });

    await pluginManager.shutdown();
  });

  it('does not auto-reply to CQ worked on another band when band distinction is disabled', async () => {
    const hasWorkedSpy = vi.fn((_callsign: string, options?: { anyBand?: boolean }) => options?.anyBand === true);
    const { operator, pluginManager } = await createRuntimeHarness({
      myCallsign: 'BG5DRB',
      myGrid: 'PL09',
      autoReplyToCQ: true,
      distinguishWorkedStationsByBand: false,
      hasWorkedCallsign: hasWorkedSpy,
    });

    await (pluginManager as any).handleSlotStart(
      createSlotInfo(15_000),
      createSlotPack(createSlotInfo(15_000), [{
        message: 'CQ BG7OO OL63',
        snr: -5,
        freq: 1395,
      }]),
    );

    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX6');
    expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe('CQ BG5DRB PL09');
    expect(hasWorkedSpy).toHaveBeenCalledWith('BG7OO', { anyBand: true });

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

  it('preserves active QSO protocol messages during late re-decision even when filters reject them', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      myCallsign: 'BD7PWV',
      myGrid: 'OL62',
      targetCallsign: 'JA4RSI',
      pluginConfigs: {
        'snr-filter': {
          enabled: true,
          settings: {
            minSNR: -15,
          },
        },
      },
    });

    patchRuntimeContext(pluginManager, operator.config.id, {
      targetCallsign: 'JA4RSI',
      targetGrid: 'PM64',
      reportSent: -13,
      reportReceived: -18,
    });
    setRuntimeState(pluginManager, operator.config.id, 'TX3');
    expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe('JA4RSI BD7PWV R-13');

    await (pluginManager as any).handleSlotStart(
      createSlotInfo(60_000),
      createSlotPack(createSlotInfo(45_000), []),
    );

    const changed = await pluginManager.reDecideOperator(
      operator.config.id,
      createSlotPack(createSlotInfo(45_000), [{
        message: 'BD7PWV JA4RSI RR73',
        snr: -21,
        freq: 971,
      }]),
    );

    expect(changed).toBe(true);
    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX5');
    expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe('JA4RSI BD7PWV 73');

    await pluginManager.shutdown();
  });

  it('preserves Fox/Hound RR73 completion during late re-decision even when filters reject it', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      myCallsign: 'BD4XYR',
      myGrid: 'OM89',
      targetCallsign: 'EX8ABR',
      pluginConfigs: {
        'snr-filter': {
          enabled: true,
          settings: {
            minSNR: -15,
          },
        },
      },
    });

    patchRuntimeContext(pluginManager, operator.config.id, {
      targetCallsign: 'EX8ABR',
      reportSent: -24,
      reportReceived: -10,
    });
    setRuntimeState(pluginManager, operator.config.id, 'TX3');
    expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe('EX8ABR BD4XYR R-24');

    await (pluginManager as any).handleSlotStart(
      createSlotInfo(60_000),
      createSlotPack(createSlotInfo(45_000), []),
    );

    const changed = await pluginManager.reDecideOperator(
      operator.config.id,
      createSlotPack(createSlotInfo(45_000), [{
        message: 'BD4XYR RR73; JH1UBK <EX8ABR> -24',
        snr: -24,
        freq: 971,
      }]),
    );

    expect(changed).toBe(true);
    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX5');
    expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe('EX8ABR BD4XYR 73');

    await pluginManager.shutdown();
  });

  it('preserves clipped Fox/Hound RR73 completion for a portable Fox callsign matched by base target', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      myCallsign: 'JH5FVT',
      myGrid: 'PM74',
      targetCallsign: 'EX8ABR',
      pluginConfigs: {
        'snr-filter': {
          enabled: true,
          settings: {
            minSNR: -10,
          },
        },
      },
    });

    patchRuntimeContext(pluginManager, operator.config.id, {
      targetCallsign: 'EX8ABR',
      reportSent: -14,
      reportReceived: -9,
    });
    setRuntimeState(pluginManager, operator.config.id, 'TX3');
    expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe('EX8ABR JH5FVT R-14');

    await (pluginManager as any).handleSlotStart(
      createSlotInfo(60_000),
      createSlotPack(createSlotInfo(45_000), []),
    );

    const changed = await pluginManager.reDecideOperator(
      operator.config.id,
      createSlotPack(createSlotInfo(45_000), [{
        message: 'JH5FVT RR73; JA1AAA <EX8ABR/P',
        snr: -14,
        freq: 971,
      }]),
    );

    expect(changed).toBe(true);
    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX5');
    expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe('EX8ABR JH5FVT 73');

    await pluginManager.shutdown();
  });

  it('recognizes a portable Fox/Hound invite and replies with the full portable Fox callsign', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      myCallsign: 'JH5FVT',
      myGrid: 'PM74',
      targetCallsign: 'EX8ABR/P',
    });

    patchRuntimeContext(pluginManager, operator.config.id, {
      targetCallsign: 'EX8ABR/P',
      reportSent: -10,
      reportReceived: -9,
    });
    setRuntimeState(pluginManager, operator.config.id, 'TX1');
    expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe('EX8ABR/P JH5FVT PM74');

    const changed = await pluginManager.reDecideOperator(
      operator.config.id,
      createSlotPack(createSlotInfo(45_000), [{
        message: 'BH5HIE RR73; JH5FVT <EX8ABR/P> -14',
        snr: -9,
        freq: 971,
      }]),
    );

    expect(changed).toBe(true);
    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX3');
    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).context?.reportSent).toBe(-14);
    expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe('EX8ABR/P JH5FVT R-14');

    await pluginManager.shutdown();
  });

  it('biases candidate scores using worked-station-bias', async () => {
    const hasWorkedSpy = vi.fn((callsign: string) => callsign === 'BG5DRB' || callsign === 'K1AAA');
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
      hasWorkedCallsign: hasWorkedSpy,
    });

    const candidates: ScoredCandidate[] = [
      { ...createParsedMessage('CQ BG5DRB OL32', -4, 1200), score: 0 },
      { ...createParsedMessage('CQ JA1AAA PM95', -6, 1400), score: 0 },
      { ...createParsedMessage('CQ K1AAA FN42', -7, 1500), score: 0 },
      { ...createParsedMessage('CQ VK2XYZ QF56', -8, 1600), score: 0 },
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
    expect(byCallsign.K1AAA).toBe(-8);
    expect(byCallsign.VK2XYZ).toBe(15);
    expect(hasWorkedSpy).toHaveBeenCalledTimes(candidates.length);

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

  it('starts watched CQ autocalls at TX2 when skipTx1 is enabled', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      startOperator: false,
      skipTx1: true,
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
    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX2');
    expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe('JA1AAA BG4IAJ -06');

    await pluginManager.shutdown();
  });

  it('starts watched novelty CQ autocalls at TX2 when skipTx1 is enabled', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      startOperator: false,
      skipTx1: true,
      pluginConfigs: {
        'watched-novelty-autocall': {
          enabled: true,
          settings: {},
        },
      },
      operatorPluginSettings: {
        'watched-novelty-autocall': {
          watchNewCallsign: true,
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
        logbookAnalysis: {
          isNewCallsign: true,
        },
      }]),
    );

    expect(operator.isTransmitting).toBe(true);
    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX2');
    expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe('JA1AAA BG4IAJ -06');

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

  it('supports Fox/Hound RR73 in cq-or-signoff mode for watched-callsign-autocall', async () => {
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
          watchList: ['EX8ABR'],
          triggerMode: 'cq-or-signoff',
          workedCallsignSkipDays: 0,
        },
      },
    });

    await (pluginManager as any).handleSlotStart(
      createSlotInfo(30_000),
      createSlotPack(createSlotInfo(15_000), [{
        message: 'BD4XYR RR73; JH1UBK <EX8ABR> -24',
        snr: -24,
        freq: 1502,
      }]),
    );

    expect(operator.isTransmitting).toBe(true);
    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).context?.targetCallsign).toBe('EX8ABR');
    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX1');
    expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe('EX8ABR BG7XTV OL32');

    await pluginManager.shutdown();
  });

  it('matches a base watched callsign against a portable Fox/Hound signoff', async () => {
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
          watchList: ['EX8ABR'],
          triggerMode: 'cq-or-signoff',
          workedCallsignSkipDays: 0,
        },
      },
    });

    await (pluginManager as any).handleSlotStart(
      createSlotInfo(30_000),
      createSlotPack(createSlotInfo(15_000), [{
        message: 'BH5HIE RR73; JH5FVT <EX8ABR/P> -14',
        snr: -14,
        freq: 1502,
      }]),
    );

    expect(operator.isTransmitting).toBe(true);
    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).context?.targetCallsign).toBe('EX8ABR/P');
    expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX1');
    expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe('EX8ABR/P BG7XTV OL32');

    await pluginManager.shutdown();
  });

  it('does not treat Fox/Hound completed or next Hound callsigns as watched autocall senders', async () => {
    for (const watchList of [['BD4XYR'], ['JH1UBK']]) {
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
            watchList,
            triggerMode: 'cq-or-signoff',
            workedCallsignSkipDays: 0,
          },
        },
      });

      await (pluginManager as any).handleSlotStart(
        createSlotInfo(30_000),
        createSlotPack(createSlotInfo(15_000), [{
          message: 'BD4XYR RR73; JH1UBK <EX8ABR> -24',
          snr: -24,
          freq: 1502,
        }]),
      );

      expect(operator.isTransmitting).toBe(false);
      expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).context?.targetCallsign).toBeUndefined();

      await pluginManager.shutdown();
    }
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

  it('uses SNR as the priority when multiple watched callsigns appear', async () => {
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
    expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe('JA1AAA BG4IAJ OM96');

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

  it('does not wake a stopped operator for partial-decode direct messages', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      startOperator: false,
      myCallsign: 'BG7XTV',
      myGrid: 'OL32',
      autoReplyToDirectCallWhenStopped: true,
    });

    await (pluginManager as any).handleSlotStart(createSlotInfo(30_000), createSlotPack(createSlotInfo(15_000), [
      { message: 'BG7XTV <...> RR73', snr: -8, freq: 1502 },
      { message: 'BG7XTV <...> -01', snr: -10, freq: 1502 },
    ]));

    const status = pluginManager.getOperatorRuntimeStatus(operator.config.id);
    expect(operator.isTransmitting).toBe(false);
    expect(status.currentSlot).toBe('TX6');
    expect(status.context?.targetCallsign).toBeUndefined();

    await pluginManager.shutdown();
  });

  it('does not auto-reply to a partial-decode CQ', async () => {
    const { operator, pluginManager } = await createRuntimeHarness({
      myCallsign: 'BG7XTV',
      myGrid: 'OL32',
      autoReplyToCQ: true,
    });

    await (pluginManager as any).handleSlotStart(createSlotInfo(30_000), createSlotPack(createSlotInfo(15_000), [
      { message: 'CQ <...> PL09', snr: -5, freq: 1300 },
    ]));

    const status = pluginManager.getOperatorRuntimeStatus(operator.config.id);
    expect(status.currentSlot).toBe('TX6');
    expect(status.context?.targetCallsign).toBeUndefined();
    expect(getCurrentTransmission(pluginManager, operator.config.id)).toBe('CQ BG7XTV OL32');

    await pluginManager.shutdown();
  });

  it('rejects autocall proposals with an undecoded placeholder callsign', async () => {
    const { operator, pluginManager, dataDir } = await createRuntimeHarness({
      startOperator: false,
      myCallsign: 'BG4IAJ',
      myGrid: 'OM96',
    });

    await writeUserPlugin(dataDir, 'placeholder-autocall', `
      export default {
        name: 'placeholder-autocall',
        version: '1.0.0',
        type: 'utility',
        hooks: {
          onAutoCallCandidate(slotInfo, messages, ctx) {
            return { callsign: '...' };
          },
        },
      };
    `);
    await pluginManager.rescanPlugins();

    await (pluginManager as any).handleSlotStart(createSlotInfo(30_000), createSlotPack(createSlotInfo(15_000), []));

    const status = pluginManager.getOperatorRuntimeStatus(operator.config.id);
    expect(operator.isTransmitting).toBe(false);
    expect(status.currentSlot).toBe('TX6');
    expect(status.context?.targetCallsign).toBeUndefined();

    await pluginManager.shutdown();
  });
});
