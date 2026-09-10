import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecodeRequest } from '@tx5dr/contracts';
import { WSJTXDecodeProcessPool, type DecodeWorkerProcess } from '../WSJTXDecodeProcessPool.js';
import { WSJTXDecodeWorkQueue } from '../WSJTXDecodeWorkQueue.js';
import { DecodeSessionEndedSchema, DecodeWorkerCommandSchema } from '../decode-worker-protocol.js';
import { DecodeWorkerTelemetrySummarySchema } from '@tx5dr/contracts';
import { SlotClock, SlotScheduler } from '@tx5dr/core';

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
  finish(): void {
    const command = this.commands.filter(c => c.type === 'decode').at(-1)!;
    this.emit('message', { type: 'result', id: command.id, result: {
      slotId: command.request!.slotId, windowIdx: command.request!.windowIdx,
      frames: [], timestamp: 0, processingTimeMs: 1,
    } });
  }
  acknowledgeEnd(): void {
    const command = this.commands.filter(c => c.type === 'end-session').at(-1)!;
    this.emit('message', { type: 'session-ended', id: command.id, sessionId: command.sessionId });
  }
}

function request(id: string, final = false): DecodeRequest {
  return { slotId: id, decodeSessionId: id, mode: 'FT8', windowIdx: final ? 2 : 0,
    decodeStage: final ? 50 : 41, decodeFinalWindow: final, decodeDepth: 3, windowOffsetMs: 0,
    timestamp: Date.now(), sampleRate: 12000, pcm: new Float32Array(16).buffer };
}

describe('decode session cancellation and bounded waiting', () => {
  let pool: WSJTXDecodeProcessPool;
  let workers: ControlledWorker[];
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    workers = [];
    pool = new WSJTXDecodeProcessPool({ workerCount: 2,
      performanceNow: () => performance.now(),
      workerFactory: id => { const worker = new ControlledWorker(id); workers.push(worker); return worker; },
    });
    for (const worker of workers) worker.emit('message', { type: 'ready' });
  });
  afterEach(async () => { await pool.destroy(); vi.useRealTimers(); });

  it('reuses both workers after two sessions lose their final windows', async () => {
    const a = pool.decode(request('slot-A')); workers[0].finish(); await a;
    const b = pool.decode(request('slot-B')); workers[1].finish(); await b;
    pool.cancelSession('slot-A', 'transmit-skipped');
    pool.cancelSession('slot-B', 'transmit-skipped');
    const next = pool.decode(request('slot-C', true));
    expect(workers.every(w => w.commands.filter(c => c.type === 'decode').length === 1)).toBe(true);
    workers[0].acknowledgeEnd();
    workers[1].acknowledgeEnd();
    workers[0].finish(); await next;
    expect(pool.getStatus()).toMatchObject({ status: 'ready', queueSize: 0, readyWorkers: 2, restartAttempts: 0 });
  });

  it('keeps the scheduler-to-worker pipeline decoding after repeated mid-slot transmit toggles', async () => {
    const queue = new WSJTXDecodeWorkQueue({ poolFactory: () => pool });
    await queue.start();
    const mode = { name: 'FT8', slotMs: 15_000, windowTiming: [-3200, -1500, -300], transmitTiming: 500, encodeAdvance: 0, toleranceMs: 0 };
    const clock = new SlotClock({ name: 'test', now: () => Date.now() }, mode);
    let transmitting = false;
    const scheduler = new SlotScheduler(clock, queue, {
      getBuffer: async () => new ArrayBuffer(64), getSampleRate: () => 12000,
    }, { hasActiveTransmissionsInCurrentCycle: () => transmitting }, () => false);
    const results: string[] = [];
    queue.on('decodeComplete', result => results.push(result.slotId));
    scheduler.start();
    for (let slot = 1; slot <= 3; slot++) {
      const info = { id: `pipeline-${slot}`, startMs: slot * 15000, cycleNumber: slot, utcSeconds: slot * 15, phaseMs: 0, driftMs: 0, mode: 'FT8' };
      clock.emit('subWindow', info, 0); await vi.advanceTimersByTimeAsync(0);
      workers[0].finish(); await vi.advanceTimersByTimeAsync(0);
      transmitting = true;
      clock.emit('subWindow', info, 1);
      transmitting = false;
      clock.emit('subWindow', info, 2);
      workers[0].acknowledgeEnd(); await vi.advanceTimersByTimeAsync(0);
    }
    expect(results).toEqual(['pipeline-1', 'pipeline-2', 'pipeline-3']);
    expect(pool.getStatus()).toMatchObject({ status: 'ready', queueSize: 0, restartAttempts: 0 });
    scheduler.stop(); await queue.stop();
  });

  it('expires abandoned sessions without needing another decode request', async () => {
    const a = pool.decode(request('slot-A')); workers[0].finish(); await a;
    await vi.advanceTimersByTimeAsync(21_000);
    expect(workers[0].commands.at(-1)).toMatchObject({ type: 'end-session', sessionId: 'slot-A' });
    workers[0].acknowledgeEnd();
    expect(pool.size()).toBe(0);
  });

  it('settles cancellation immediately but waits for native completion before cleanup or reuse', async () => {
    const running = pool.decode(request('slot-A')).catch(e => e);
    const queued = pool.decode({ ...request('slot-A', true), windowIdx: 2 }).catch(e => e);
    pool.cancelSession('slot-A', 'transmit-skipped');
    pool.cancelSession('slot-A', 'transmit-skipped');
    expect((await running).code).toBe('DECODE_SESSION_CANCELLED');
    expect((await queued).code).toBe('DECODE_SESSION_CANCELLED');
    expect(workers[0].commands).toHaveLength(1);
    workers[0].finish();
    expect(workers[0].commands.at(-1)).toMatchObject({ type: 'end-session' });
    const close = workers[0].commands.at(-1)!;
    // A mismatched or old acknowledgement cannot release the reservation.
    workers[0].emit('message', { type: 'session-ended', id: close.id + 100, sessionId: close.sessionId });
    expect(workers[0].commands.filter(c => c.type === 'end-session')).toHaveLength(1);
    workers[0].acknowledgeEnd();
    await expect(pool.decode(request('slot-A', true))).rejects.toMatchObject({ code: 'DECODE_SESSION_CANCELLED' });
    const next = pool.decode(request('slot-next', true));
    workers[0].emit('message', { type: 'session-ended', id: close.id, sessionId: close.sessionId });
    workers[0].finish(); await next;
    expect(pool.size()).toBe(0);
  });

  it('suppresses cancelled decode results and ordinary cancellation errors in the work queue', async () => {
    const queue = new WSJTXDecodeWorkQueue({ poolFactory: () => pool });
    const complete = vi.fn(), error = vi.fn(), unavailable = vi.fn();
    queue.on('decodeComplete', complete); queue.on('decodeError', error); queue.on('decodeWorkerUnavailable', unavailable);
    await queue.start();
    const running = queue.push(request('slot-A')).catch(e => e);
    queue.cancelSession('slot-A', 'scheduler-reset');
    workers[0].finish(); workers[0].acknowledgeEnd();
    expect((await running).code).toBe('DECODE_SESSION_CANCELLED');
    expect(complete).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled(); expect(unavailable).not.toHaveBeenCalled();
    await queue.stop();
  });

  it('does not release a healthy session between stages or reject a valid late final result', async () => {
    const partial = pool.decode(request('slot-A')); workers[0].finish(); await partial;
    await vi.advanceTimersByTimeAsync(6000);
    expect(workers[0].commands).toHaveLength(1);
    const final = pool.decode({ ...request('slot-A', true), decisionDeadlineMs: Date.now() - 500, windowOffsetMs: 1000 });
    await vi.advanceTimersByTimeAsync(1500);
    workers[0].finish(); await final;
    expect(workers[0].commands.map(c => c.type)).toEqual(['decode', 'decode']);
    expect(pool.getStatus().status).toBe('ready');
  });

  it('does not deliver a final result cancelled between pool completion and queue delivery', async () => {
    const queue = new WSJTXDecodeWorkQueue({ poolFactory: () => pool });
    const complete = vi.fn(); queue.on('decodeComplete', complete);
    await queue.start();
    const result = queue.push(request('slot-A', true)).catch(e => e);
    workers[0].finish();
    queue.cancelSession('slot-A', 'scheduler-reset');
    expect((await result).code).toBe('DECODE_SESSION_CANCELLED');
    expect(complete).not.toHaveBeenCalled();
    await queue.stop();
  });

  it('does not treat a wall-clock step as session expiry', async () => {
    const partial = pool.decode(request('slot-A')); workers[0].finish(); await partial;
    vi.setSystemTime(Date.now() + 3_600_000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(workers[0].commands).toHaveLength(1);
    const final = pool.decode(request('slot-A', true)); workers[0].finish(); await final;
  });

  it('reports a stall before expiring queued work, and recovers only after an actual result', async () => {
    // Model a regression in the dispatch boundary: workers remain alive but
    // no queued job can be selected. This must be visible independently of exits.
    const dispatch = vi.spyOn(pool as never as { dispatch(): void }, 'dispatch').mockImplementation(() => {});
    const health = vi.fn(); pool.on('healthStatusChanged', health);
    const waiting = pool.decode(request('slot-A')).catch(e => e);
    await vi.advanceTimersByTimeAsync(21_000);
    expect((await waiting).reason).toBe('queue-expired');
    expect(pool.getHealthSnapshot()).toMatchObject({ status: 'unavailable', unavailableReason: 'queue-stalled' });
    expect(health).toHaveBeenCalledTimes(1);
    dispatch.mockRestore();
    const next = pool.decode(request('slot-B', true));
    expect(pool.getHealthSnapshot().status).toBe('unavailable');
    workers[0].finish(); await next;
    expect(pool.getHealthSnapshot()).toMatchObject({ status: 'ready', unavailableReason: undefined });
    expect(health).toHaveBeenCalledTimes(2);
  });

  it('reclaims lost final stages before queue starvation without a false unavailable event', async () => {
    const health = vi.fn(); pool.on('healthStatusChanged', health);
    const a = pool.decode(request('slot-A')); workers[0].finish(); await a;
    const b = pool.decode(request('slot-B')); workers[1].finish(); await b;
    await vi.advanceTimersByTimeAsync(5000);
    const next = pool.decode(request('slot-next', true));
    await vi.advanceTimersByTimeAsync(15_000);
    workers[0].acknowledgeEnd(); workers[1].acknowledgeEnd();
    workers[0].finish(); await next;
    expect(health).not.toHaveBeenCalled();
  });

  it('does not dispatch a younger final window after an earlier window has expired between sweeps', async () => {
    await vi.advanceTimersByTimeAsync(250);
    const a = pool.decode(request('A')); workers[0].finish(); await a;
    const b = pool.decode(request('B')); workers[1].finish(); await b;
    const partial = pool.decode(request('C')).catch(e => e);
    await vi.advanceTimersByTimeAsync(1000);
    const final = pool.decode(request('C', true)).catch(e => e);
    await vi.advanceTimersByTimeAsync(18_950);
    pool.cancelSession('A', 'transmit-skipped');
    await vi.advanceTimersByTimeAsync(300);
    workers[0].acknowledgeEnd();
    expect(workers[0].commands.filter(c => c.type === 'decode')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(500);
    expect((await partial).reason).toBe('queue-expired');
    expect((await final).reason).toBe('queue-expired');
  });

  it('kills only a worker whose cleanup acknowledgement times out and ignores its late messages', async () => {
    const a = pool.decode(request('slot-A')); workers[0].finish(); await a;
    pool.cancelSession('slot-A', 'transmit-skipped');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(workers[0].killed).toBe(true); expect(workers[1].killed).toBe(false);
    expect(pool.getStatus().restartAttempts).toBe(1);
    workers[0].acknowledgeEnd(); workers[0].emit('message', { type: 'ready' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(workers).toHaveLength(3);
    workers[2].emit('message', { type: 'ready' });
    const next = pool.decode(request('slot-next', true)); workers[1].finish(); await next;
    expect(pool.getStatus()).toMatchObject({ readyWorkers: 2, queueSize: 0, restartAttempts: 1 });
  });

  it('drains an active cancelled call under its original execution timeout', async () => {
    const a = pool.decode(request('slot-A')).catch(e => e);
    pool.cancelSession('slot-A', 'transmit-skipped'); await a;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(workers[0].killed).toBe(true);
    expect(workers[0].commands.some(c => c.type === 'end-session')).toBe(false);
    expect(pool.getStatus().restartAttempts).toBe(1);
  });

  it('settles same-session queued jobs on worker exit and remains usable', async () => {
    const a = pool.decode(request('slot-A')).catch(e => e);
    const tail = pool.decode(request('slot-A', true)).catch(e => e);
    workers[0].emit('exit', 1, null);
    expect((await a).message).toContain('exited');
    expect((await tail).code).toBe('DECODE_SESSION_CANCELLED');
    const next = pool.decode(request('slot-B', true)); workers[1].finish(); await next;
    expect(pool.size()).toBe(0);
  });

  it('releases idle reservations when ENOMEM reduces the pool size', async () => {
    const a = pool.decode(request('slot-A')); workers[0].finish(); await a;
    const b = pool.decode(request('slot-B')); workers[1].finish(); await b;
    const error = Object.assign(new Error('out of memory'), { code: 'ENOMEM' });
    workers[1].emit('error', error);
    expect(pool.getStatus().maxConcurrency).toBe(1);
    pool.cancelSession('slot-A', 'scheduler-reset'); workers[0].acknowledgeEnd();
    const next = pool.decode(request('slot-next', true)); workers[0].finish(); await next;
    expect(pool.size()).toBe(0);
  });

  it('isolates invalid cleanup responses and synchronous IPC send failures', async () => {
    const a = pool.decode(request('slot-A')); workers[0].finish(); await a;
    pool.cancelSession('slot-A', 'transmit-skipped');
    workers[0].emit('message', { type: 'session-ended', id: 'wrong', sessionId: 'slot-A' });
    expect(workers[0].killed).toBe(true);
    const send = vi.spyOn(workers[1], 'send').mockImplementation(() => { throw new Error('IPC closed'); });
    await expect(pool.decode(request('slot-B'))).rejects.toThrow('IPC closed');
    send.mockRestore();
    expect(pool.getStatus().restartAttempts).toBe(2);
    await pool.destroy(); expect(vi.getTimerCount()).toBe(0);
  });

  it('discards reservations for all extra idle workers when a larger pool degrades', async () => {
    await pool.destroy(); workers = [];
    pool = new WSJTXDecodeProcessPool({ workerCount: 4,
      workerFactory: id => { const worker = new ControlledWorker(id); workers.push(worker); return worker; },
    });
    workers.forEach(worker => worker.emit('message', { type: 'ready' }));
    for (let i = 0; i < 3; i++) {
      const partial = pool.decode(request(`slot-${i}`)); workers[i].finish(); await partial;
    }
    workers[3].emit('error', Object.assign(new Error('out of memory'), { code: 'ENOMEM' }));
    expect(workers.map(worker => worker.killed)).toEqual([true, true, false, true]);
    expect(pool.getStatus()).toMatchObject({ maxConcurrency: 1, workerProcesses: 1 });
    await expect(pool.decode(request('slot-0', true))).rejects.toMatchObject({ code: 'DECODE_SESSION_CANCELLED' });
    pool.cancelSession('slot-2', 'scheduler-reset'); workers[2].acknowledgeEnd();
    const next = pool.decode(request('next', true)); workers[2].finish(); await next;
    expect(pool.size()).toBe(0);
  });

  it('emits bounded summaries even when no new request arrives', async () => {
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});
    const a = pool.decode(request('slot-A')); workers[0].finish(); await a;
    pool.cancelSession('slot-A', 'transmit-skipped'); workers[0].acknowledgeEnd();
    await vi.advanceTimersByTimeAsync(90_000);
    const snapshots = info.mock.calls.filter(call => String(call[0]).includes('diagnostic snapshot'));
    expect(snapshots).toHaveLength(3);
    expect(snapshots[0][1]).toMatchObject({ counts: { submitted: 1, dispatched: 1, completed: 1 }, cancellations: { 'transmit-skipped': 1 } });
    expect(snapshots[1][1]).toMatchObject({ counts: { submitted: 0, dispatched: 0, completed: 0 }, cancellations: {} });
    info.mockRestore();
  });

  it('settles all requests and clears timers when stopped during active/queued/cleanup work', async () => {
    const partial = pool.decode(request('slot-A')); workers[0].finish(); await partial;
    pool.cancelSession('slot-A', 'scheduler-reset');
    const active = pool.decode(request('slot-B')).catch(e => e);
    const pending = pool.decode(request('slot-C')).catch(e => e);
    await pool.destroy();
    expect((await active).code).toBe('DECODE_SESSION_CANCELLED');
    expect((await pending).code).toBe('DECODE_SESSION_CANCELLED');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('validates cleanup messages and the additive telemetry fields at runtime', () => {
    expect(DecodeWorkerCommandSchema.safeParse({ type: 'end-session', id: 1, sessionId: 'A' }).success).toBe(true);
    expect(DecodeWorkerCommandSchema.safeParse({ type: 'end-session', id: -1, sessionId: '' }).success).toBe(false);
    expect(DecodeSessionEndedSchema.safeParse({ type: 'session-ended', id: 1 }).success).toBe(false);
    expect(DecodeWorkerTelemetrySummarySchema.safeParse({ workerCount: 2, readyCount: 2, busyCount: 0,
      totalRss: 0, totalCpu: 0, nativeThreadsPerWorker: 1, pendingJobs: 2, activeJobs: 0,
      status: 'unavailable', unavailableReason: 'queue-stalled', oldestPendingMs: 20_000, noProgressMs: 20_000,
    }).success).toBe(true);
  });
});
