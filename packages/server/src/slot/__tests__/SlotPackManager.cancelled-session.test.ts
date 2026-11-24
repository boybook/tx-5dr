import { EventEmitter } from 'node:events';
import { EventEmitter as EventEmitter3 } from 'eventemitter3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MODES } from '@tx5dr/contracts';
import type { DecodeRequest, DecodeResult, SlotInfo, SlotPack } from '@tx5dr/contracts';
import { SlotClock, SlotScheduler } from '@tx5dr/core';
import { SlotPackManager } from '../SlotPackManager.js';
import { WSJTXDecodeProcessPool, type DecodeWorkerProcess } from '../../decode/WSJTXDecodeProcessPool.js';
import { WSJTXDecodeWorkQueue } from '../../decode/WSJTXDecodeWorkQueue.js';
import { ClockCoordinator } from '../../subsystems/ClockCoordinator.js';

function createPersistenceMock() {
  return {
    store: vi.fn(async (_slotPack: SlotPack, _operation?: 'updated' | 'created', _mode?: string) => undefined),
    getStorageStats: vi.fn(async () => ({ currentFile: null, queueSize: 0, isWriting: false, currentDate: null })),
    flush: vi.fn(async () => undefined),
    cleanup: vi.fn(async () => undefined),
    readRecords: vi.fn(async () => []),
    getAvailableDates: vi.fn(async () => []),
  };
}

function decodeResult(slotStartMs: number, windowIdx: number, messages: string[]): DecodeResult {
  return {
    slotId: `FT8-1-${slotStartMs}`,
    windowIdx,
    timestamp: slotStartMs + 12_000,
    processingTimeMs: 10,
    frames: messages.map(message => ({ message, snr: -10, dt: 0.1, freq: 1200, confidence: 1 })),
  } as DecodeResult;
}

describe('SlotPackManager calibrated clock', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('discards stale decodes after a frequency change by the calibrated clock', () => {
    const systemNow = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(systemNow);
    const calibratedNow = systemNow + 5_000;
    const manager = new SlotPackManager({ persistence: createPersistenceMock(), now: () => calibratedNow });
    manager.setPersistenceEnabled(false);

    manager.clearInMemory();

    // Began before the change on the calibrated clock, after it on the system clock.
    expect(manager.processDecodeResult(decodeResult(calibratedNow - 2_000, 0, ['CQ K1ABC FN42']))).toBeNull();
    expect(manager.processDecodeResult(decodeResult(calibratedNow + 1_000, 0, ['CQ K1ABC FN42']))).not.toBeNull();
    expect(manager.getRetainedSinceMs()).toBe(calibratedNow);
  });
});

describe('SlotPackManager cancelled decode sessions', () => {
  function createManager() {
    const persistence = createPersistenceMock();
    const manager = new SlotPackManager({ persistence });
    manager.setMode(MODES.FT8);
    const reviewed = vi.fn();
    manager.on('slotPackReviewUpdated', reviewed);
    return { manager, persistence, reviewed };
  }

  it('persists the delivered windows once as the final batch when the session is cancelled', () => {
    const { manager, persistence, reviewed } = createManager();
    manager.processDecodeResult(decodeResult(45_000, 0, ['CQ K1ABC FN42']));
    expect(persistence.store).not.toHaveBeenCalled();

    manager.markDecodeSessionCancelled('FT8-1-45000');
    manager.markDecodeSessionCancelled('FT8-1-45000');

    expect(persistence.store).toHaveBeenCalledTimes(1);
    expect(persistence.store.mock.calls[0]?.[0].frames.map(frame => frame.message)).toEqual(['CQ K1ABC FN42']);
    expect(reviewed).toHaveBeenCalledTimes(1);
  });

  it('writes no record for a cancelled session without decode results', () => {
    const { manager, persistence, reviewed } = createManager();
    manager.markDecodeWindowFailed('FT8-1-45000', 0);
    manager.markDecodeSessionCancelled('FT8-1-45000');
    manager.markDecodeSessionCancelled('FT8-1-60000');

    expect(persistence.store).not.toHaveBeenCalled();
    expect(reviewed).not.toHaveBeenCalled();
  });
});

class ControlledWorker extends EventEmitter implements DecodeWorkerProcess {
  killed = false;
  commands: Array<{ type: string; id: number; sessionId?: string; request?: DecodeRequest }> = [];
  constructor(readonly pid: number) { super(); }
  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    const command = message as ControlledWorker['commands'][number];
    this.commands.push(command);
    callback?.(null);
    if (command.type === 'shutdown') this.kill();
    return true;
  }
  kill(): boolean { this.killed = true; this.emit('exit', 0, null); return true; }
  finish(messages: string[]): void {
    const command = this.commands.filter(c => c.type === 'decode').at(-1)!;
    this.emit('message', { type: 'result', id: command.id, result: {
      slotId: command.request!.slotId, windowIdx: command.request!.windowIdx,
      frames: messages.map(message => ({ message, snr: -10, dt: 0.1, freq: 1200, confidence: 1 })),
      timestamp: command.request!.timestamp, processingTimeMs: 1,
    } });
  }
  acknowledgeEnd(): void {
    const command = this.commands.filter(c => c.type === 'end-session').at(-1);
    if (command) this.emit('message', { type: 'session-ended', id: command.id, sessionId: command.sessionId });
  }
}

describe('cancelled decode session through the receive pipeline', () => {
  let workers: ControlledWorker[];
  let queue: WSJTXDecodeWorkQueue;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    workers = [];
  });
  afterEach(async () => {
    await queue?.destroy();
    vi.useRealTimers();
  });

  it('persists window 0 results once after a mid-slot transmit cancels the session', async () => {
    const pool = new WSJTXDecodeProcessPool({
      workerCount: 1,
      performanceNow: () => performance.now(),
      workerFactory: id => { const worker = new ControlledWorker(id); workers.push(worker); return worker; },
    });
    for (const worker of workers) worker.emit('message', { type: 'ready' });
    queue = new WSJTXDecodeWorkQueue({ poolFactory: () => pool });
    await queue.start();

    const persistence = createPersistenceMock();
    const slotPackManager = new SlotPackManager({ persistence });
    slotPackManager.setMode(MODES.FT8);
    const reviewed = vi.fn();
    slotPackManager.on('slotPackReviewUpdated', reviewed);

    const clock = new SlotClock({ name: 'test', now: () => Date.now() }, MODES.FT8);
    let transmitting = false;
    const scheduler = new SlotScheduler(clock, queue, {
      getBuffer: async () => new ArrayBuffer(64), getSampleRate: () => 12000,
    }, { hasActiveTransmissionsInCurrentCycle: () => transmitting }, () => false);

    const coordinator = new ClockCoordinator({
      engineEmitter: new EventEmitter3() as never,
      slotClock: clock,
      decodeQueue: queue,
      slotPackManager,
      spectrumScheduler: new EventEmitter3() as never,
      operatorManager: {
        broadcastAllOperatorStatusUpdates: vi.fn(),
        hasActiveTransmissionsInCurrentCycle: () => transmitting,
        reDecideOnLateDecodes: vi.fn(),
      } as never,
      callsignTracker: { updateFromSlotPack: vi.fn() } as never,
      getTransmissionPipeline: () => ({}) as never,
      getRadioBridge: () => ({}) as never,
      getCurrentMode: () => MODES.FT8,
    });
    coordinator.setup();
    scheduler.start();

    const startMs = 1_800_000_000_000 - (1_800_000_000_000 % MODES.FT8.slotMs);
    const info: SlotInfo = {
      id: `FT8-1-${startMs}`, startMs, cycleNumber: 1, utcSeconds: startMs / 1000,
      phaseMs: 0, driftMs: 0, mode: 'FT8',
    };
    try {
      clock.emit('subWindow', info, 0); await vi.advanceTimersByTimeAsync(0);
      workers[0].finish(['CQ K1ABC FN42']); await vi.advanceTimersByTimeAsync(0);
      expect(slotPackManager.getSlotPack(info.id)?.frames).toHaveLength(1);
      expect(persistence.store).not.toHaveBeenCalled();

      transmitting = true;
      clock.emit('subWindow', info, 1); await vi.advanceTimersByTimeAsync(0);
      clock.emit('subWindow', info, 2); await vi.advanceTimersByTimeAsync(0);
      workers[0].acknowledgeEnd(); await vi.advanceTimersByTimeAsync(0);

      expect(persistence.store).toHaveBeenCalledTimes(1);
      expect(persistence.store.mock.calls[0]?.[0]).toMatchObject({
        slotId: info.id,
        frames: [expect.objectContaining({ message: 'CQ K1ABC FN42' })],
      });
      expect(reviewed).toHaveBeenCalledTimes(1);
    } finally {
      scheduler.stop();
      coordinator.teardown();
    }
  });
});
