import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecodeRequest, DecodeResult } from '@tx5dr/contracts';
import { WSJTXDecodeProcessPool, type DecodeWorkerProcess } from '../WSJTXDecodeProcessPool.js';
import { WSJTXDecodeWorkQueue } from '../WSJTXDecodeWorkQueue.js';

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
      frames: [], timestamp: command.request!.timestamp, processingTimeMs: 1,
    } });
  }
  fail(): void {
    const command = this.commands.filter(c => c.type === 'decode').at(-1)!;
    this.emit('message', { type: 'error', id: command.id, error: { name: 'Error', message: 'native crash' } });
  }
}

const CALIBRATION_OFFSET_MS = 5_000;

function request(overrides: Partial<DecodeRequest> = {}): DecodeRequest {
  return {
    slotId: 'slot-A', mode: 'FT8', windowIdx: 0, windowOffsetMs: -3200,
    timestamp: Date.now(), sampleRate: 12000, pcm: new Float32Array(16).buffer,
    ...overrides,
  };
}

function staged(slotId: string, windowIdx: number): DecodeRequest {
  return request({
    slotId, decodeSessionId: slotId, windowIdx, decodeStage: windowIdx === 0 ? 41 : 47,
    decodeFinalWindow: false, decodeDepth: 3,
  });
}

describe('WSJTXDecodeWorkQueue calibrated clock and cancellation reporting', () => {
  let workers: ControlledWorker[];
  let queue: WSJTXDecodeWorkQueue;
  const calibratedNow = () => Date.now() + CALIBRATION_OFFSET_MS;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    workers = [];
    const pool = new WSJTXDecodeProcessPool({
      workerCount: 1,
      performanceNow: () => performance.now(),
      workerFactory: id => { const worker = new ControlledWorker(id); workers.push(worker); return worker; },
    });
    for (const worker of workers) worker.emit('message', { type: 'ready' });
    queue = new WSJTXDecodeWorkQueue({ poolFactory: () => pool, now: calibratedNow });
    await queue.start();
  });

  afterEach(async () => {
    await queue.destroy();
    vi.useRealTimers();
  });

  it('judges late against the calibrated clock that produced the decision deadline', async () => {
    const delivered: DecodeResult[] = [];
    queue.on('decodeComplete', result => delivered.push(result));

    // Still ahead of the system clock, but already past on the calibrated clock.
    const missed = queue.push(request({ decisionDeadlineMs: Date.now() + 2_000 }));
    workers[0].finish(); await missed;
    const met = queue.push(request({ slotId: 'slot-B', decisionDeadlineMs: calibratedNow() + 2_000 }));
    workers[0].finish(); await met;
    const unbounded = queue.push(request({ slotId: 'slot-C' }));
    workers[0].finish(); await unbounded;

    expect(delivered.map(result => [result.slotId, result.late])).toEqual([
      ['slot-A', true],
      ['slot-B', false],
      ['slot-C', undefined],
    ]);
  });

  it('reports scheduler-requested cancellation as a session cancellation', () => {
    const cancelled = vi.fn();
    queue.on('decodeSessionCancelled', cancelled);
    queue.cancelSession('slot-A', 'transmit-skipped');
    expect(cancelled).toHaveBeenCalledWith('slot-A', 'transmit-skipped');
  });

  it('reports pool-owned cancellation observed through rejected work', async () => {
    const cancelled = vi.fn();
    const errors = vi.fn();
    queue.on('decodeSessionCancelled', cancelled);
    queue.on('decodeError', errors);

    const first = queue.push(staged('slot-A', 0)).catch(error => error);
    const second = queue.push(staged('slot-A', 1)).catch(error => error);
    workers[0].fail();

    expect((await first).message).toBe('native crash');
    expect((await second).code).toBe('DECODE_SESSION_CANCELLED');
    expect(errors).toHaveBeenCalledTimes(1);
    expect(cancelled).toHaveBeenCalledWith('slot-A', 'worker-failed');
  });
});
