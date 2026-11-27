import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'eventemitter3';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DigitalRadioEngineEvents, ModeDescriptor, SlotInfo, SlotPack } from '@tx5dr/contracts';
import { MODES } from '@tx5dr/contracts';
import { FT8MessageParser, RadioOperator } from '@tx5dr/core';
import { PluginManager } from '../PluginManager.js';
import { LogManager } from '../../log/LogManager.js';

/**
 * Characterization of FT8 decision-timing lessons owned by DecisionOrchestrator:
 * DCN-06 (stale encode correction), DCN-07 (hook budgets), DCN-27 (late
 * re-decision does not age a QSO) and DCN-37 (engine mode drives the cycle).
 * These tests describe current behavior; they do not change it.
 */

type BatchRequest = Parameters<DigitalRadioEngineEvents['requestTransmitBatch']>[0];

function installInMemoryLogManager(): void {
  const logBook = { id: 'logbook-test', provider: { queryQSOs: vi.fn(async () => []) } };
  const sessionLogBook = {
    id: 'plugin-session-test',
    name: 'Plugin Session',
    binding: { kind: 'plugin-session', pluginName: 'standard-qso', stationCallsign: 'BG4IAJ', sessionKey: 'standard-qso:2026' },
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

function createSlotInfo(startMs: number, mode: ModeDescriptor = MODES.FT8): SlotInfo {
  return {
    id: `slot-${startMs}`,
    startMs,
    utcSeconds: Math.floor(startMs / 1000),
    phaseMs: 0,
    driftMs: 0,
    cycleNumber: Math.floor(startMs / mode.slotMs) % 2,
    mode: mode.name,
  };
}

function createSlotPack(startMs: number, messages: string[]): SlotPack {
  return {
    slotId: `slot-${startMs}`,
    startMs,
    endMs: startMs + MODES.FT8.slotMs,
    frames: messages.map((message, index) => ({
      message,
      snr: -10,
      dt: 0,
      freq: 1200 + index * 100,
      confidence: 0.9,
    })),
    stats: {
      totalDecodes: messages.length,
      successfulDecodes: messages.length,
      totalFramesBeforeDedup: messages.length,
      totalFramesAfterDedup: messages.length,
      lastUpdated: startMs,
    },
    decodeHistory: [],
  };
}

async function writeUserPlugin(dataDir: string, pluginName: string, source: string): Promise<void> {
  const pluginDir = join(dataDir, 'plugins', pluginName);
  await mkdir(pluginDir, { recursive: true });
  await writeFile(join(pluginDir, 'index.mjs'), source, 'utf8');
}

/** In-process user strategy whose decide() is steered from the test through globalThis. */
const STEERED_STRATEGY_SOURCE = `
  export default {
    apiVersion: 2,
    name: 'steered-strategy',
    version: '1.0.0',
    type: 'strategy',
    permissions: ['operator:transmit-control'],
    isAutoCallEnabled: () => true,
    createStrategyRuntime() {
      const control = globalThis.__tx5drSteeredStrategy;
      let text = control.initialText;
      const snapshot = () => ({ currentState: 'TX6', context: {} });
      return {
        checkpoint: () => ({ text }),
        restore: (checkpoint) => { text = checkpoint.text; },
        async decide(messages, meta) {
          control.decisions.push({ source: meta.source, isReDecision: meta.isReDecision });
          await control.beforeDecide();
          text = control.decidedText;
          return { snapshot: snapshot(), transmission: text };
        },
        getSnapshot: snapshot,
        getTransmitText: () => text,
        requestCall: () => false,
        patchContext() {},
        setState() {},
        setSlotContent() {},
        reset() {},
      };
    },
  };
`;

interface SteeredStrategyControl {
  initialText: string;
  decidedText: string;
  decisions: Array<{ source: string; isReDecision: boolean }>;
  beforeDecide: () => Promise<void>;
}

function steeredStrategy(): SteeredStrategyControl {
  return (globalThis as unknown as { __tx5drSteeredStrategy: SteeredStrategyControl }).__tx5drSteeredStrategy;
}

describe('DecisionOrchestrator FT8 lessons (characterization)', () => {
  const tempDirs: string[] = [];
  const managers: PluginManager[] = [];

  beforeEach(() => {
    installInMemoryLogManager();
    (globalThis as unknown as { __tx5drSteeredStrategy: SteeredStrategyControl }).__tx5drSteeredStrategy = {
      initialText: 'CQ W1AAA FN42',
      decidedText: 'CQ W1AAA FN42',
      decisions: [],
      beforeDecide: async () => {},
    };
  });

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
    vi.restoreAllMocks();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    delete (globalThis as unknown as { __tx5drSteeredStrategy?: SteeredStrategyControl }).__tx5drSteeredStrategy;
  });

  async function createHarness(options: {
    strategy?: string;
    preparePlugins?: (dataDir: string) => Promise<void>;
    pluginConfigs?: Record<string, { enabled: boolean; settings: Record<string, unknown> }>;
    engineMode?: ModeDescriptor;
    operatorMode?: ModeDescriptor;
    transmitCycles?: number[];
    maxQSOTimeoutCycles?: number;
    triggerReEncode?: (operatorId: string, options?: { source?: string; reason?: string }) => void;
  } = {}) {
    const eventEmitter = new EventEmitter<DigitalRadioEngineEvents>();
    eventEmitter.on('checkHasWorkedCallsign' as any, (data: { requestId: string }) => {
      eventEmitter.emit('hasWorkedCallsignResponse' as any, { requestId: data.requestId, hasWorked: false });
    });
    eventEmitter.on('recordQSO', (data) => data.resolve?.(data.qsoRecord));

    const operator = new RadioOperator({
      id: 'operator-1',
      mode: options.operatorMode ?? MODES.FT8,
      myCallsign: 'BG4IAJ',
      myGrid: 'OM96',
      frequency: 1500,
      transmitCycles: options.transmitCycles ?? [0],
      maxQSOTimeoutCycles: options.maxQSOTimeoutCycles ?? 6,
      maxCallAttempts: 5,
      autoReplyToCQ: false,
      autoResumeCQAfterFail: false,
      autoResumeCQAfterSuccess: false,
      replyToWorkedStations: false,
      prioritizeNewCalls: true,
      targetSelectionPriorityMode: 'dxcc_first',
    }, eventEmitter);

    const dataDir = await mkdtemp(join(tmpdir(), 'tx5dr-ft8-lessons-'));
    tempDirs.push(dataDir);
    await options.preparePlugins?.(dataDir);

    let pluginManager!: PluginManager;
    pluginManager = new PluginManager({
      eventEmitter,
      getOperators: () => [operator],
      getOperatorById: (id) => (id === operator.config.id ? operator : undefined),
      getCurrentMode: () => options.engineMode ?? operator.config.mode,
      getOperatorAutomationSnapshot: (id) => pluginManager.getOperatorAutomationSnapshot(id),
      requestOperatorCall: () => {},
      getRadioFrequency: async () => 7_074_000,
      setRadioFrequency: () => {},
      getRadioBand: () => '40m',
      getRadioConnected: () => true,
      getLatestSlotPack: () => null,
      interruptOperatorTransmission: async () => undefined,
      requestOperatorStrategyStop: vi.fn(),
      hasWorkedCallsign: async () => false,
      resetOperatorRuntime: () => {},
      triggerReEncode: options.triggerReEncode as any,
      dataDir,
    });
    managers.push(pluginManager);

    const batches: BatchRequest[] = [];
    eventEmitter.on('requestTransmitBatch', (batch) => {
      batches.push(batch);
      // Emulate RadioOperatorManager accepting the queued frame.
      for (const item of batch.transmissions) {
        if (!FT8MessageParser.rawContainsUndecodedCallsign(item.transmission)) {
          pluginManager.notifyTransmissionQueued(batch.operatorId, item.transmission);
        }
      }
    });

    pluginManager.loadConfig({
      configs: options.pluginConfigs ?? {},
      operatorStrategies: { [operator.config.id]: options.strategy ?? 'standard-qso' },
      operatorSettings: {
        [operator.config.id]: {
          'standard-qso': {
            autoReplyToCQ: false,
            autoResumeCQAfterFail: false,
            autoResumeCQAfterSuccess: false,
            replyToWorkedStations: false,
            maxQSOTimeoutCycles: options.maxQSOTimeoutCycles ?? 6,
            maxCallAttempts: 5,
          },
        },
      },
    });
    await pluginManager.start();
    operator.start();

    return { eventEmitter, operator, pluginManager, batches };
  }

  function putInActiveQso(pluginManager: PluginManager, operatorId: string, state: 'TX2' | 'TX3'): void {
    pluginManager.patchOperatorRuntimeContext(operatorId, {
      targetCallsign: 'JA1AAA',
      targetGrid: 'PM95',
      reportSent: -10,
    });
    pluginManager.setOperatorRuntimeState(operatorId, state);
  }

  describe('DCN-06 slot-start decision races the encode start', () => {
    async function runRacedSlot(decidedText: string) {
      const triggerReEncode = vi.fn();
      const control = steeredStrategy();
      control.initialText = 'CQ W1AAA FN42';
      control.decidedText = decidedText;
      let enterDecide!: () => void;
      const decideEntered = new Promise<void>((resolve) => { enterDecide = resolve; });
      let releaseDecide!: () => void;
      const decideReleased = new Promise<void>((resolve) => { releaseDecide = resolve; });
      control.beforeDecide = async () => {
        enterDecide();
        await decideReleased;
      };

      const { operator, pluginManager, batches } = await createHarness({
        strategy: 'steered-strategy',
        preparePlugins: (dataDir) => writeUserPlugin(dataDir, 'steered-strategy', STEERED_STRATEGY_SOURCE),
        triggerReEncode,
      });
      const slot = createSlotInfo(30_000);

      const slotStart = (pluginManager as any).handleSlotStart(slot, createSlotPack(15_000, ['CQ JA1AAA PM95'])) as Promise<void>;
      await decideEntered;
      // Encoding starts while the asynchronous slot decision is still running.
      (pluginManager as any).handleEncodeStart(slot);
      releaseDecide();
      await slotStart;

      return { operator, triggerReEncode, batches };
    }

    it('re-encodes with replacement when the finished decision differs from the frame already encoded', async () => {
      const { operator, triggerReEncode, batches } = await runRacedSlot('CQ DX W1AAA FN42');

      expect(batches.map((batch) => batch.transmissions.map((item) => item.transmission))).toEqual([
        ['CQ W1AAA FN42'],
      ]);
      expect(triggerReEncode).toHaveBeenCalledTimes(1);
      expect(triggerReEncode).toHaveBeenCalledWith(operator.config.id, {
        source: 'late-decode',
        reason: 'slot decision corrected an already encoded frame',
      });
    });

    async function runEncodeBeforeDecision(encodedSlotMs: number) {
      const triggerReEncode = vi.fn();
      const control = steeredStrategy();
      control.initialText = 'CQ W1AAA FN42';
      control.decidedText = 'CQ DX W1AAA FN42';
      const { operator, pluginManager, batches } = await createHarness({
        strategy: 'steered-strategy',
        preparePlugins: (dataDir) => writeUserPlugin(dataDir, 'steered-strategy', STEERED_STRATEGY_SOURCE),
        triggerReEncode,
      });
      // A stalled event loop delivers the slot boundary late: the encode timer is
      // already due and fires before the slot decision has even started.
      (pluginManager as any).handleEncodeStart(createSlotInfo(encodedSlotMs));
      await (pluginManager as any).handleSlotStart(createSlotInfo(30_000), createSlotPack(15_000, ['CQ JA1AAA PM95']));
      return { operator, triggerReEncode, batches };
    }

    it('corrects a frame encoded before the delayed slot decision began', async () => {
      const { operator, triggerReEncode, batches } = await runEncodeBeforeDecision(30_000);

      expect(batches.map((batch) => batch.transmissions.map((item) => item.transmission))).toEqual([
        ['CQ W1AAA FN42'],
      ]);
      expect(triggerReEncode).toHaveBeenCalledTimes(1);
      expect(triggerReEncode).toHaveBeenCalledWith(operator.config.id, {
        source: 'late-decode',
        reason: 'slot decision corrected an already encoded frame',
      });
    });

    it('does not correct the current slot from a frame encoded for an earlier slot', async () => {
      const { triggerReEncode } = await runEncodeBeforeDecision(0);

      expect(triggerReEncode).not.toHaveBeenCalled();
    });

    it('does not re-encode when the finished decision matches the frame already encoded', async () => {
      const { triggerReEncode, batches } = await runRacedSlot('CQ W1AAA FN42');

      expect(batches).toHaveLength(1);
      expect(triggerReEncode).not.toHaveBeenCalled();
    });
  });

  describe('DCN-07 hook budgets', () => {
    const neverSettles = 'new Promise(() => {})';

    it('limits each never-settling pipeline hook to its budget and continues the decision without its result', async () => {
      const { operator, pluginManager } = await createHarness({
        pluginConfigs: { 'hanging-pipeline': { enabled: true, settings: {} } },
        preparePlugins: (dataDir) => writeUserPlugin(dataDir, 'hanging-pipeline', `
          export default {
            name: 'hanging-pipeline',
            version: '1.0.0',
            type: 'utility',
            hooks: {
              onFilterCandidates() { return ${neverSettles}; },
              onScoreCandidates() { return ${neverSettles}; },
            },
          };
        `),
      });
      putInActiveQso(pluginManager, operator.config.id, 'TX2');

      const startedAt = Date.now();
      await (pluginManager as any).handleSlotStart(
        createSlotInfo(30_000),
        createSlotPack(15_000, ['BG4IAJ JA1AAA R-12']),
      );
      const elapsedMs = Date.now() - startedAt;

      // Two hooks at 200 ms each; well under the 5 s broadcast budget.
      expect(elapsedMs).toBeLessThan(1_500);
      const status = pluginManager.getOperatorRuntimeStatus(operator.config.id);
      expect(status.currentSlot).toBe('TX4');
      expect(status.context?.targetCallsign).toBe('JA1AAA');
      expect(pluginManager.getCurrentTransmission(operator.config.id)).toBe('JA1AAA BG4IAJ RR73');
    });

    it('does not wait for never-settling passive hooks before the RF decision completes', async () => {
      const { operator, pluginManager } = await createHarness({
        pluginConfigs: { 'hanging-observer': { enabled: true, settings: {} } },
        preparePlugins: (dataDir) => writeUserPlugin(dataDir, 'hanging-observer', `
          export default {
            name: 'hanging-observer',
            version: '1.0.0',
            type: 'utility',
            hooks: {
              onSlotStart() { return ${neverSettles}; },
              onSlotActivity() { return ${neverSettles}; },
              onDecode() { return ${neverSettles}; },
            },
          };
        `),
      });
      putInActiveQso(pluginManager, operator.config.id, 'TX2');

      const startedAt = Date.now();
      await (pluginManager as any).handleSlotStart(
        createSlotInfo(30_000),
        createSlotPack(15_000, ['BG4IAJ JA1AAA R-12']),
      );
      const elapsedMs = Date.now() - startedAt;

      // Awaiting passive hooks would cost at least the 200 ms decision budget (or 5 s broadcast budget).
      expect(elapsedMs).toBeLessThan(200);
      expect(pluginManager.getOperatorRuntimeStatus(operator.config.id).currentSlot).toBe('TX4');
      expect(pluginManager.getCurrentTransmission(operator.config.id)).toBe('JA1AAA BG4IAJ RR73');
    });
  });

  describe('DCN-27 late re-decision does not age the QSO', () => {
    it('passes isReDecision through to the strategy for each decision source', async () => {
      const { operator, pluginManager } = await createHarness({
        strategy: 'steered-strategy',
        preparePlugins: (dataDir) => writeUserPlugin(dataDir, 'steered-strategy', STEERED_STRATEGY_SOURCE),
      });

      await (pluginManager as any).handleSlotStart(createSlotInfo(30_000), createSlotPack(15_000, ['CQ JA1AAA PM95']));
      await pluginManager.reDecideOperator(operator.config.id, createSlotPack(15_000, ['CQ JA1AAA PM95', 'CQ K1ABC FN42']));

      expect(steeredStrategy().decisions).toEqual([
        { source: 'slot-auto', isReDecision: false },
        { source: 'late-decode', isReDecision: true },
      ]);
    });

    it('keeps an unanswered QSO alive through repeated late re-decisions while slot decisions still time it out', async () => {
      const { operator, pluginManager } = await createHarness({ maxQSOTimeoutCycles: 2 });
      const operatorId = operator.config.id;
      putInActiveQso(pluginManager, operatorId, 'TX2');

      // Several late decode windows in one slot, each with new unrelated decodes.
      const lateMessages: string[] = [];
      for (const caller of ['K1ABC FN42', 'K2BCD FN31', 'K3CDE FM18', 'K4DEF EM73', 'K5EFG EM12']) {
        lateMessages.push(`CQ ${caller}`);
        await pluginManager.reDecideOperator(operatorId, createSlotPack(15_000, [...lateMessages]));
        const status = pluginManager.getOperatorRuntimeStatus(operatorId);
        expect(status.currentSlot).toBe('TX2');
        expect(status.context?.targetCallsign).toBe('JA1AAA');
      }
      expect(pluginManager.getCurrentTransmission(operatorId)).toMatch(/^JA1AAA BG4IAJ /);

      // Contrast: slot-start decisions without a reply do count toward the timeout.
      await (pluginManager as any).handleSlotStart(createSlotInfo(30_000), createSlotPack(15_000, ['CQ K6FGH DM04']));
      expect(pluginManager.getOperatorRuntimeStatus(operatorId).currentSlot).toBe('TX2');
      await (pluginManager as any).handleSlotStart(createSlotInfo(60_000), createSlotPack(45_000, ['CQ K7GHI DN31']));
      const timedOut = pluginManager.getOperatorRuntimeStatus(operatorId);
      expect(timedOut.currentSlot === 'TX2' && timedOut.context?.targetCallsign === 'JA1AAA').toBe(false);
    });
  });

  describe('DCN-37 engine mode drives the transmit cycle', () => {
    it('uses the FT4 7.5 s slot from the engine even when the operator config still says FT8', async () => {
      const { operator, pluginManager, batches } = await createHarness({
        engineMode: MODES.FT4,
        operatorMode: MODES.FT8,
        transmitCycles: [1],
      });
      expect(operator.config.mode.name).toBe('FT8');

      // FT4 slot 1 (7.5 s) is odd; under a stale FT8 15 s slot it would read as cycle 0.
      (pluginManager as any).handleEncodeStart(createSlotInfo(7_500, MODES.FT4));
      expect(batches).toHaveLength(1);
      expect(batches[0]).toMatchObject({ operatorId: operator.config.id });

      // FT4 slot 2 (15 s) is even, so the odd-cycle operator stays silent.
      (pluginManager as any).handleEncodeStart(createSlotInfo(15_000, MODES.FT4));
      // FT4 slot 3 (22.5 s) is odd again; FT8 would read it as cycle 1 too, so it only confirms cadence.
      (pluginManager as any).handleEncodeStart(createSlotInfo(22_500, MODES.FT4));
      expect(batches).toHaveLength(2);
    });
  });
});
