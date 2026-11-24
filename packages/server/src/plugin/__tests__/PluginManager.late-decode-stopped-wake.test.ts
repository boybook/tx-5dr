import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'eventemitter3';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DigitalRadioEngineEvents, FrameMessage, SlotPack } from '@tx5dr/contracts';
import { MODES } from '@tx5dr/contracts';
import { PluginManager } from '../PluginManager.js';
import { LogManager } from '../../log/LogManager.js';
import { RadioOperatorManager } from '../../operator/RadioOperatorManager.js';

/**
 * DCN-25: a call addressed to this station is often only decoded in a later
 * decode window of the same slot. The production late-decode entry
 * (RadioOperatorManager.reDecideOnLateDecodes) must be able to wake a stopped,
 * idle operator for that call when "auto-reply to direct calls while stopped"
 * is enabled, under the same rules as the slot-start path.
 */

const OPERATOR_ID = 'op1';
const MY_CALLSIGN = 'BG7XTV';
// Current slot starts at 30_000 (cycle 0); the late decodes belong to the prior
// RX slot at 15_000 (cycle 1), so the reply goes out in cycle 0 right now.
const CLOCK_NOW_MS = 31_000;
const LATE_SLOT_START_MS = 15_000;

function buildSlotPack(startMs: number, messages: string[]): SlotPack {
  const frames: FrameMessage[] = messages.map((message, index) => ({
    message,
    snr: -7,
    dt: 0,
    freq: 1300 + index * 100,
    confidence: 0.9,
  }));
  return {
    slotId: `slot-${startMs}`,
    startMs,
    endMs: startMs + MODES.FT8.slotMs,
    frames,
    stats: {
      totalDecodes: frames.length,
      successfulDecodes: frames.length,
      totalFramesBeforeDedup: frames.length,
      totalFramesAfterDedup: frames.length,
      lastUpdated: startMs + MODES.FT8.slotMs - 1,
    },
    decodeHistory: [],
  };
}

function installFakeLogManager(): void {
  const logBook = {
    id: 'logbook-test',
    name: 'Test Log',
    provider: {
      addQSO: vi.fn(async (record: unknown) => record),
      queryQSOs: vi.fn(async () => []),
      hasWorkedCallsign: vi.fn(async () => false),
      getLastQSOWithCallsign: vi.fn(async () => null),
      getStatistics: vi.fn(async () => ({ totalQSOs: 0, uniqueCallsigns: 0 })),
    },
  };
  const sessionLogBook = {
    id: 'plugin-session-test',
    name: 'Plugin Session',
    binding: { kind: 'plugin-session', pluginName: 'standard-qso', stationCallsign: MY_CALLSIGN, sessionKey: 'standard-qso:2026' },
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
    initialize: vi.fn().mockResolvedValue(undefined),
    resolveLogBookId: vi.fn(() => logBook.id),
    getLogBook: vi.fn(() => logBook),
    getOperatorIdsForLogBook: vi.fn(() => [OPERATOR_ID]),
    getOperatorLogBook: vi.fn().mockResolvedValue(logBook),
    getOperatorCallsign: vi.fn().mockReturnValue(MY_CALLSIGN),
    getOrCreateLogBookByCallsign: vi.fn().mockResolvedValue(logBook),
    getOrCreatePluginSessionLogBook: vi.fn(async () => sessionLogBook),
    getPluginSessionLogBook: vi.fn(() => sessionLogBook),
    prewarmLogBookByCallsign: vi.fn(),
    registerOperatorCallsign: vi.fn(),
    unregisterOperatorCallsign: vi.fn(),
    connectOperatorToLogBook: vi.fn().mockResolvedValue(undefined),
    disconnectOperatorFromLogBook: vi.fn(),
    getOperatorLogBookId: vi.fn().mockReturnValue(logBook.id),
    setApplicationEventSink: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as LogManager);
}

describe('late-decode wake of a stopped operator for a direct call (DCN-25)', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup();
    }
    vi.restoreAllMocks();
  });

  async function createStation(options: { autoReplyToDirectCallWhenStopped: boolean }) {
    installFakeLogManager();
    const eventEmitter = new EventEmitter<DigitalRadioEngineEvents>();
    eventEmitter.on('checkHasWorkedCallsign' as any, (data: { requestId: string }) => {
      eventEmitter.emit('hasWorkedCallsignResponse' as any, { requestId: data.requestId, hasWorked: false });
    });
    const encodeQueue = { push: vi.fn() };
    const manager = new RadioOperatorManager({
      eventEmitter,
      encodeQueue: encodeQueue as any,
      clockSource: { now: () => CLOCK_NOW_MS } as any,
      getCurrentMode: () => MODES.FT8,
      setRadioFrequency: vi.fn(),
      slotPackManager: {
        getActiveSlotPacks: vi.fn(() => []),
        readStoredRecords: vi.fn(async () => []),
        getFrequencyContext: vi.fn(() => undefined),
        getRetainedSinceMs: vi.fn(() => 0),
      } as any,
      getKnownRadioFrequency: () => 7_074_000,
    });

    const dataDir = await mkdtemp(join(tmpdir(), 'tx5dr-late-wake-'));
    let pluginManager!: PluginManager;
    pluginManager = new PluginManager({
      intentCoordinator: (manager as any).intentCoordinator,
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
    cleanups.push(async () => {
      manager.stop();
      await pluginManager.shutdown().catch(() => undefined);
      await rm(dataDir, { recursive: true, force: true });
    });

    manager.setPluginManager(pluginManager);
    pluginManager.loadConfig({
      configs: {},
      operatorStrategies: { [OPERATOR_ID]: 'standard-qso' },
      operatorSettings: {
        [OPERATOR_ID]: {
          'standard-qso': {
            autoReplyToDirectCallWhenStopped: options.autoReplyToDirectCallWhenStopped,
            replyToWorkedStations: true,
          },
        },
      },
    });
    await manager.addOperator({
      id: OPERATOR_ID,
      myCallsign: MY_CALLSIGN,
      myGrid: 'OL32',
      frequency: 1_500,
      transmitCycles: [1],
      mode: MODES.FT8,
    });
    await pluginManager.start();
    manager.start();

    const operator = manager.getOperatorById(OPERATOR_ID)!;
    expect(operator.isTransmitting).toBe(false);
    const reDecideSpy = vi.spyOn(pluginManager, 'reDecideOperator');
    return { manager, pluginManager, operator, encodeQueue, reDecideSpy };
  }

  async function flushLateDecode(): Promise<void> {
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  it.each([
    { message: `${MY_CALLSIGN} JA1AAA PM95`, expectedSlot: 'TX2', expectedReply: 'JA1AAA BG7XTV -07' },
    { message: `${MY_CALLSIGN} JA1AAA R-05`, expectedSlot: 'TX4', expectedReply: 'JA1AAA BG7XTV RR73' },
  ])('wakes a stopped idle operator through the production late-decode entry for $message', async ({
    message,
    expectedSlot,
    expectedReply,
  }) => {
    const { manager, pluginManager, operator, encodeQueue } = await createStation({
      autoReplyToDirectCallWhenStopped: true,
    });

    manager.reDecideOnLateDecodes(buildSlotPack(LATE_SLOT_START_MS, [message]));

    await vi.waitFor(() => expect(encodeQueue.push).toHaveBeenCalled());
    const status = pluginManager.getOperatorRuntimeStatus(OPERATOR_ID);
    expect(operator.isTransmitting).toBe(true);
    // Reply in the cycle opposite to the caller's slot (15_000 is cycle 1).
    expect(operator.getTransmitCycles()).toEqual([0]);
    expect(status.currentSlot).toBe(expectedSlot);
    expect(status.context?.targetCallsign).toBe('JA1AAA');
    expect(encodeQueue.push.mock.calls[0]?.[0]).toMatchObject({
      operatorId: OPERATOR_ID,
      message: expectedReply,
      slotStartMs: 30_000,
    });
  });

  it('does not wake a stopped operator from a late direct call when the setting is off', async () => {
    const { manager, pluginManager, operator, encodeQueue, reDecideSpy } = await createStation({
      autoReplyToDirectCallWhenStopped: false,
    });

    manager.reDecideOnLateDecodes(buildSlotPack(LATE_SLOT_START_MS, [`${MY_CALLSIGN} JA1AAA R-05`]));
    await flushLateDecode();

    expect(reDecideSpy).not.toHaveBeenCalled();
    expect(operator.isTransmitting).toBe(false);
    expect(pluginManager.getOperatorRuntimeStatus(OPERATOR_ID).currentSlot).toBe('TX6');
    expect(encodeQueue.push).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'a report addressed to another station', message: 'BG5DRB JA1AAA R-05' },
    { label: 'a lone 73', message: `${MY_CALLSIGN} JA1AAA 73` },
    { label: 'a partial decode', message: `${MY_CALLSIGN} <...> R-05` },
  ])('does not admit a stopped operator into late re-decision for $label', async ({ message }) => {
    const { manager, pluginManager, operator, encodeQueue, reDecideSpy } = await createStation({
      autoReplyToDirectCallWhenStopped: true,
    });

    manager.reDecideOnLateDecodes(buildSlotPack(LATE_SLOT_START_MS, [message]));
    await flushLateDecode();

    expect(reDecideSpy).not.toHaveBeenCalled();
    expect(operator.isTransmitting).toBe(false);
    expect(pluginManager.getOperatorRuntimeStatus(OPERATOR_ID).currentSlot).toBe('TX6');
    expect(encodeQueue.push).not.toHaveBeenCalled();
  });

  it('does not admit a stopped non-idle operator into late re-decision for a direct call', async () => {
    const { manager, pluginManager, operator, encodeQueue, reDecideSpy } = await createStation({
      autoReplyToDirectCallWhenStopped: true,
    });
    pluginManager.patchOperatorRuntimeContext(OPERATOR_ID, { targetCallsign: 'BG5DRB', targetGrid: 'OL32' });
    pluginManager.setOperatorRuntimeState(OPERATOR_ID, 'TX2');

    manager.reDecideOnLateDecodes(buildSlotPack(LATE_SLOT_START_MS, [`${MY_CALLSIGN} JA1AAA R-05`]));
    await flushLateDecode();

    expect(reDecideSpy).not.toHaveBeenCalled();
    expect(operator.isTransmitting).toBe(false);
    expect(pluginManager.getOperatorRuntimeStatus(OPERATOR_ID).context?.targetCallsign).toBe('BG5DRB');
    expect(encodeQueue.push).not.toHaveBeenCalled();
  });
});
