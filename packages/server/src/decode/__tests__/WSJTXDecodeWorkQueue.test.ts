import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { DecodeRequest, DecodeResult } from '@tx5dr/contracts';

const decodeCalls = vi.hoisted((): Array<{ mode: number; frequency: number; samples: number; threads?: number }> => []);
const constructorCalls = vi.hoisted((): Array<{ maxThreads?: number }> => []);
const pendingMessages = vi.hoisted((): Array<{
  text: string;
  snr: number;
  deltaTime: number;
  deltaFrequency: number;
}> => []);

vi.mock('wsjtx-lib', () => {
  const WSJTXMode = {
    FT8: 0,
    FT4: 1,
  };

  class WSJTXLib {
    constructor(options?: { maxThreads?: number }) {
      constructorCalls.push({ maxThreads: options?.maxThreads });
    }

    async convertAudioFormat(audioData: Float32Array): Promise<Int16Array> {
      return new Int16Array(audioData.length);
    }

    async decode(mode: number, audioData: Int16Array, options: { frequency: number; threads?: number }): Promise<{ success: boolean; messages: Array<{ text: string; snr: number; deltaTime: number; deltaFrequency: number }> }> {
      decodeCalls.push({ mode, frequency: options.frequency, samples: audioData.length, threads: options.threads });
      pendingMessages.push({
        text: mode === WSJTXMode.FT4 ? 'CQ DX BH1ABC OM88' : 'CQ DX FT8TEST OM88',
        snr: 10,
        deltaTime: 0.1,
        deltaFrequency: 1000,
      });
      return { success: true, messages: [...pendingMessages] };
    }
  }

  return { WSJTXLib, WSJTXMode };
});

import { WSJTXDecodeWorkerCore } from '../WSJTXDecodeWorkerCore.js';
import {
  resolveDecodeWorkerCount,
  resolveDecodeNativeThreadCount,
  WSJTXDecodeProcessPool,
  type DecodeWorkerProcess,
} from '../WSJTXDecodeProcessPool.js';

function makePcm(samples = 1200): ArrayBuffer {
  const data = new Float32Array(samples);
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
}

async function decodeOnce(request: DecodeRequest): Promise<DecodeResult> {
  const decoder = new WSJTXDecodeWorkerCore(1);
  return decoder.decode(request);
}

describe('WSJTXDecodeWorkerCore mode selection', () => {
  it('uses the FT4 native decoder for FT4 decode requests', async () => {
    decodeCalls.length = 0;
    constructorCalls.length = 0;
    pendingMessages.length = 0;

    const result = await decodeOnce({
      slotId: 'FT4-0-0',
      mode: 'FT4',
      windowIdx: 1,
      pcm: makePcm(),
      sampleRate: 12000,
      timestamp: Date.now(),
      windowOffsetMs: 0,
    });

    expect(constructorCalls).toEqual([{ maxThreads: 1 }]);
    expect(decodeCalls).toEqual([{ mode: 1, frequency: 0, samples: 1200, threads: 1 }]);
    expect(result.frames).toEqual([
      expect.objectContaining({
        message: 'CQ DX BH1ABC OM88',
        freq: 1000,
      }),
    ]);
  });

  it('keeps using the FT8 native decoder for FT8 decode requests', async () => {
    decodeCalls.length = 0;
    pendingMessages.length = 0;

    await decodeOnce({
      slotId: 'FT8-0-0',
      mode: 'FT8',
      windowIdx: 0,
      pcm: makePcm(600),
      sampleRate: 12000,
      timestamp: Date.now(),
      windowOffsetMs: -300,
    });

    expect(decodeCalls).toEqual([{ mode: 0, frequency: 0, samples: 600, threads: 1 }]);
  });
});

describe('resolveDecodeWorkerCount', () => {
  it('defaults to two workers on normal devices', () => {
    expect(resolveDecodeWorkerCount({}, {
      totalmem: () => 16 * 1024 * 1024 * 1024,
      cpuCount: () => 8,
    })).toEqual(expect.objectContaining({
      resolvedWorkers: 2,
      reason: 'default',
    }));
  });

  it('uses one worker on low-memory devices', () => {
    expect(resolveDecodeWorkerCount({}, {
      totalmem: () => 4 * 1024 * 1024 * 1024,
      cpuCount: () => 8,
    })).toEqual(expect.objectContaining({
      resolvedWorkers: 1,
      reason: 'low-memory',
    }));
  });

  it('uses one worker on low-cpu devices', () => {
    expect(resolveDecodeWorkerCount({}, {
      totalmem: () => 16 * 1024 * 1024 * 1024,
      cpuCount: () => 2,
    })).toEqual(expect.objectContaining({
      resolvedWorkers: 1,
      reason: 'low-cpu',
    }));
  });

  it('honors explicit worker counts with clamping', () => {
    expect(resolveDecodeWorkerCount({ TX5DR_DECODE_WORKERS: '1' }, {
      totalmem: () => 16 * 1024 * 1024 * 1024,
      cpuCount: () => 8,
    })).toEqual(expect.objectContaining({
      resolvedWorkers: 1,
      reason: 'explicit',
    }));

    expect(resolveDecodeWorkerCount({ TX5DR_DECODE_WORKERS: '9' }, {
      totalmem: () => 16 * 1024 * 1024 * 1024,
      cpuCount: () => 8,
    })).toEqual(expect.objectContaining({
      resolvedWorkers: 4,
      reason: 'explicit',
    }));
  });

  it('falls back to auto policy for invalid values', () => {
    expect(resolveDecodeWorkerCount({ TX5DR_DECODE_WORKERS: 'nope' }, {
      totalmem: () => 16 * 1024 * 1024 * 1024,
      cpuCount: () => 8,
    })).toEqual(expect.objectContaining({
      resolvedWorkers: 2,
      reason: 'default',
      warning: expect.stringContaining('invalid'),
    }));
  });
});


describe('resolveDecodeNativeThreadCount', () => {
  it('defaults to one native thread regardless of CPU count', () => {
    expect(resolveDecodeNativeThreadCount({}, 2, 4)).toEqual(expect.objectContaining({
      resolvedThreads: 1,
      reason: 'default',
    }));

    expect(resolveDecodeNativeThreadCount({}, 2, 6)).toEqual(expect.objectContaining({
      resolvedThreads: 1,
      totalDecodeThreadBudget: 4,
      reason: 'default',
    }));

    expect(resolveDecodeNativeThreadCount({}, 2, 10)).toEqual(expect.objectContaining({
      resolvedThreads: 1,
      totalDecodeThreadBudget: 8,
      reason: 'default',
    }));

    expect(resolveDecodeNativeThreadCount({}, 4, 10)).toEqual(expect.objectContaining({
      resolvedThreads: 1,
      totalDecodeThreadBudget: 8,
      reason: 'default',
    }));
  });

  it('honors explicit native thread counts with clamping', () => {
    expect(resolveDecodeNativeThreadCount({ TX5DR_DECODE_THREADS: '3' }, 2, 10)).toEqual(expect.objectContaining({
      resolvedThreads: 3,
      reason: 'explicit',
    }));

    expect(resolveDecodeNativeThreadCount({ TX5DR_DECODE_THREADS: '9' }, 2, 10)).toEqual(expect.objectContaining({
      resolvedThreads: 4,
      reason: 'explicit',
    }));
  });

  it('falls back to auto native thread policy for invalid values', () => {
    expect(resolveDecodeNativeThreadCount({ TX5DR_DECODE_THREADS: 'many' }, 2, 10)).toEqual(expect.objectContaining({
      resolvedThreads: 1,
      reason: 'default',
      warning: expect.stringContaining('invalid'),
    }));
  });
});


class FakeDecodeWorkerProcess extends EventEmitter implements DecodeWorkerProcess {
  pid: number;
  killed = false;
  env?: NodeJS.ProcessEnv;
  decodeCommands = 0;
  active = 0;
  maxActive = 0;

  constructor(pid: number, env?: NodeJS.ProcessEnv) {
    super();
    this.pid = pid;
    this.env = env;
    setTimeout(() => this.emit('message', { type: 'ready', workerId: String(pid) }), 0);
  }

  send(input: unknown, callback?: (error: Error | null) => void): boolean {
    const message = input as { type?: string; id?: number; request?: DecodeRequest };
    callback?.(null);
    if (message.type === 'shutdown') {
      this.killed = true;
      setTimeout(() => this.emit('exit', 0, null), 0);
      return true;
    }

    if (message.type === 'decode' && typeof message.id === 'number' && message.request) {
      this.decodeCommands++;
      this.active++;
      this.maxActive = Math.max(this.maxActive, this.active);
      const request = message.request;
      setTimeout(() => {
        this.active--;
        this.emit('message', {
          type: 'result',
          id: message.id,
          result: {
            slotId: request.slotId,
            windowIdx: request.windowIdx,
            frames: [],
            timestamp: request.timestamp,
            processingTimeMs: 1,
            windowOffsetMs: request.windowOffsetMs,
          },
        });
      }, 10);
    }
    return true;
  }

  kill(): boolean {
    this.killed = true;
    setTimeout(() => this.emit('exit', null, 'SIGTERM'), 0);
    return true;
  }
}

class NeverRespondingDecodeWorkerProcess extends FakeDecodeWorkerProcess {
  override send(input: unknown, callback?: (error: Error | null) => void): boolean {
    const message = input as { type?: string };
    callback?.(null);
    if (message.type === 'shutdown') {
      this.killed = true;
      setTimeout(() => this.emit('exit', 0, null), 0);
      return true;
    }
    if (message.type === 'decode') {
      this.decodeCommands++;
      this.active++;
      this.maxActive = Math.max(this.maxActive, this.active);
    }
    return true;
  }
}

describe('WSJTXDecodeProcessPool scheduling', () => {
  it('dispatches concurrent jobs across workers while keeping each worker serial', async () => {
    const workers: FakeDecodeWorkerProcess[] = [];
    const pool = new WSJTXDecodeProcessPool({
      workerCount: 2,
      readyTimeoutMs: 1000,
      jobTimeoutMs: 1000,
      env: { TX5DR_DECODE_THREADS: '3' },
      workerFactory: (workerId, _entry, env) => {
        const worker = new FakeDecodeWorkerProcess(workerId, env);
        workers.push(worker);
        return worker;
      },
    });

    const requestA: DecodeRequest = {
      slotId: 'FT8-0-0',
      mode: 'FT8',
      windowIdx: 0,
      pcm: makePcm(16),
      sampleRate: 12000,
      timestamp: 1,
      windowOffsetMs: 0,
    };
    const requestB: DecodeRequest = {
      ...requestA,
      slotId: 'FT8-0-1',
      windowIdx: 1,
      timestamp: 2,
    };

    const [resultA, resultB] = await Promise.all([
      pool.decode(requestA),
      pool.decode(requestB),
    ]);

    expect(resultA.slotId).toBe('FT8-0-0');
    expect(resultB.slotId).toBe('FT8-0-1');
    expect(workers).toHaveLength(2);
    expect(workers.map((worker) => worker.decodeCommands)).toEqual([1, 1]);
    expect(workers.every((worker) => worker.env?.TX5DR_DECODE_NATIVE_THREADS === '3')).toBe(true);
    expect(workers.every((worker) => worker.maxActive <= 1)).toBe(true);
    expect(pool.size()).toBe(0);

    await pool.destroy();
  });

  it('tracks decode worker telemetry and removes it after worker exit', async () => {
    const workers: FakeDecodeWorkerProcess[] = [];
    const pool = new WSJTXDecodeProcessPool({
      workerCount: 1,
      readyTimeoutMs: 1000,
      jobTimeoutMs: 1000,
      env: { TX5DR_DECODE_THREADS: '2' },
      workerFactory: (workerId, _entry, env) => {
        const worker = new FakeDecodeWorkerProcess(workerId, env);
        workers.push(worker);
        return worker;
      },
    });

    await new Promise(resolve => setTimeout(resolve, 0));
    workers[0].emit('message', {
      type: 'telemetry',
      metrics: {
        workerId: 1,
        pid: workers[0].pid,
        ready: true,
        busy: false,
        nativeThreads: 2,
        uptimeSeconds: 1,
        memory: {
          heapUsed: 1,
          heapTotal: 2,
          rss: 1024,
          external: 0,
          arrayBuffers: 0,
        },
        cpu: {
          user: 100,
          system: 20,
          total: 120,
        },
        lastSeenAt: Date.now(),
      },
    });

    expect(pool.getTelemetrySnapshot()).toEqual(expect.objectContaining({
      summary: expect.objectContaining({
        workerCount: 1,
        readyCount: 1,
        totalRss: 1024,
        totalCpu: 120,
        nativeThreadsPerWorker: 2,
      }),
    }));

    workers[0].kill();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(pool.getTelemetrySnapshot()).toBeUndefined();
    await pool.destroy();
  });

  it('ignores tsx watch IPC messages from development workers', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const workers: FakeDecodeWorkerProcess[] = [];
    const pool = new WSJTXDecodeProcessPool({
      workerCount: 1,
      readyTimeoutMs: 1000,
      jobTimeoutMs: 1000,
      workerFactory: (workerId, _entry, env) => {
        const worker = new FakeDecodeWorkerProcess(workerId, env);
        workers.push(worker);
        return worker;
      },
    });

    await new Promise(resolve => setTimeout(resolve, 0));
    workers[0].emit('message', {
      'watch:require': [
        '/tmp/rubato-fft-node-darwin-universal.tsx',
      ],
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(warnSpy.mock.calls.some((call) => String(call[0]).includes('unknown job'))).toBe(false);
    expect(warnSpy.mock.calls.some((call) => String(call[0]).includes('unknown message'))).toBe(false);
    await pool.destroy();
    warnSpy.mockRestore();
  });

  it('does not count one timed-out worker twice when deciding degradation', async () => {
    const pool = new WSJTXDecodeProcessPool({
      workerCount: 2,
      readyTimeoutMs: 1000,
      jobTimeoutMs: 10,
      workerFactory: (workerId, _entry, env) => new NeverRespondingDecodeWorkerProcess(workerId, env),
    });

    const request: DecodeRequest = {
      slotId: 'FT8-timeout',
      mode: 'FT8',
      windowIdx: 0,
      pcm: makePcm(16),
      sampleRate: 12000,
      timestamp: 1,
      windowOffsetMs: 0,
    };

    await Promise.allSettled([
      pool.decode(request),
      pool.decode({ ...request, windowIdx: 1 }),
    ]);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(pool.getStatus().maxConcurrency).toBe(2);
    await pool.destroy();
  });
});
