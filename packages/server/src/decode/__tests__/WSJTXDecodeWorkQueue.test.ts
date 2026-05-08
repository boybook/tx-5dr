import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { DecodeRequest, DecodeResult } from '@tx5dr/contracts';

const decodeCalls = vi.hoisted((): Array<{ mode: number; samples: number; options: Record<string, unknown> }> => []);
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

    async decode(mode: number, audioData: Int16Array, options: Record<string, unknown>): Promise<{ success: boolean; messages: Array<{ text: string; snr: number; deltaTime: number; deltaFrequency: number }> }> {
      decodeCalls.push({ mode, samples: audioData.length, options: { ...options } });
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
import { WSJTXDecodeWorkQueue } from '../WSJTXDecodeWorkQueue.js';
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
    expect(decodeCalls).toEqual([{
      mode: 1,
      samples: 1200,
      options: expect.objectContaining({
        frequency: 0,
        txFrequency: 0,
        threads: 1,
        apDecode: false,
        decodeDepth: 1,
        qsoProgress: 0,
      }),
    }]);
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

    expect(decodeCalls).toEqual([{
      mode: 0,
      samples: 600,
      options: expect.objectContaining({
        frequency: 0,
        txFrequency: 0,
        threads: 1,
        apDecode: false,
        decodeDepth: 1,
      }),
    }]);
  });

  it('passes conservative AP context to native decode when provided', async () => {
    decodeCalls.length = 0;
    pendingMessages.length = 0;

    const result = await decodeOnce({
      slotId: 'FT8-0-0',
      mode: 'FT8',
      windowIdx: 0,
      pcm: makePcm(600),
      sampleRate: 12000,
      timestamp: Date.now(),
      windowOffsetMs: -300,
      apContext: {
        operatorId: 'op1',
        myCall: 'BG4IAJ',
        myGrid: 'OM96',
        dxCall: 'JA1AAA',
        dxGrid: 'PM95',
        frequencyHz: 1500,
        qsoProgress: 4,
        currentSlot: 'TX4',
      },
    });

    expect(decodeCalls).toEqual([{
      mode: 0,
      samples: 600,
      options: expect.objectContaining({
        frequency: 1500,
        txFrequency: 1500,
        threads: 1,
        apDecode: true,
        decodeDepth: 1,
        myCall: 'BG4IAJ',
        myGrid: 'OM96',
        dxCall: 'JA1AAA',
        dxGrid: 'PM95',
        qsoProgress: 4,
      }),
    }]);
    expect(result.frames[0]?.freq).toBe(1000);
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

class NeverReadyDecodeWorkerProcess extends EventEmitter implements DecodeWorkerProcess {
  pid: number;
  killed = false;

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  send(input: unknown, callback?: (error: Error | null) => void): boolean {
    const message = input as { type?: string };
    callback?.(null);
    if (message.type === 'shutdown') {
      this.killed = true;
      setTimeout(() => this.emit('exit', 0, null), 0);
    }
    return true;
  }

  kill(): boolean {
    this.killed = true;
    setTimeout(() => this.emit('exit', null, 'SIGTERM'), 0);
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

    expect(pool.getTelemetrySnapshot()).toEqual(expect.objectContaining({
      summary: expect.objectContaining({
        status: 'unavailable',
        workerCount: 0,
        lastError: expect.stringContaining('exited'),
      }),
      workers: [],
    }));
    await pool.destroy();
  });

  it('reports unavailable instead of crashing when workerFactory throws', async () => {
    const pool = new WSJTXDecodeProcessPool({
      workerCount: 1,
      readyTimeoutMs: 1000,
      jobTimeoutMs: 1000,
      workerFactory: () => {
        throw new Error('spawn failed for test');
      },
    });

    expect(pool.getStatus()).toEqual(expect.objectContaining({
      status: 'unavailable',
      readyWorkers: 0,
      lastFailure: 'spawn failed for test',
    }));
    expect(pool.getTelemetrySnapshot()).toEqual(expect.objectContaining({
      summary: expect.objectContaining({
        status: 'unavailable',
        desiredWorkers: 1,
        workerCount: 0,
        lastError: 'spawn failed for test',
      }),
      workers: [],
    }));

    await pool.destroy();
  });

  it('uses startup backoff instead of respawning immediately after ready timeout', async () => {
    const workers: NeverReadyDecodeWorkerProcess[] = [];
    const pool = new WSJTXDecodeProcessPool({
      workerCount: 1,
      readyTimeoutMs: 10,
      jobTimeoutMs: 1000,
      workerFactory: (workerId) => {
        const worker = new NeverReadyDecodeWorkerProcess(workerId);
        workers.push(worker);
        return worker;
      },
    });

    await new Promise(resolve => setTimeout(resolve, 30));

    expect(workers).toHaveLength(1);
    expect(pool.getStatus()).toEqual(expect.objectContaining({
      status: 'unavailable',
      readyWorkers: 0,
    }));

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

describe('WSJTXDecodeWorkQueue lifecycle', () => {
  function createRequest(overrides: Partial<DecodeRequest> = {}): DecodeRequest {
    return {
      slotId: 'FT8-lifecycle',
      mode: 'FT8',
      windowIdx: 0,
      pcm: makePcm(16),
      sampleRate: 12000,
      timestamp: 1,
      windowOffsetMs: 0,
      ...overrides,
    };
  }

  it('does not create a worker pool until started', async () => {
    const poolFactory = vi.fn(() => new WSJTXDecodeProcessPool({
      workerCount: 1,
      workerFactory: (workerId) => new FakeDecodeWorkerProcess(workerId),
    }));
    const queue = new WSJTXDecodeWorkQueue({ poolFactory });

    expect(poolFactory).not.toHaveBeenCalled();
    expect(queue.getStatus()).toEqual(expect.objectContaining({
      status: 'stopped',
      lifecycleState: 'stopped',
      workerProcesses: 0,
    }));
    expect(queue.getDecodeWorkerTelemetrySnapshot()).toEqual(expect.objectContaining({
      summary: expect.objectContaining({
        status: 'stopped',
        workerCount: 0,
      }),
      workers: [],
    }));

    await queue.destroy();
  });

  it('starts and stops workers idempotently', async () => {
    const workers: FakeDecodeWorkerProcess[] = [];
    const poolFactory = vi.fn((maxConcurrency?: number) => new WSJTXDecodeProcessPool({
      workerCount: maxConcurrency,
      readyTimeoutMs: 1000,
      jobTimeoutMs: 1000,
      workerFactory: (workerId, _entry, env) => {
        const worker = new FakeDecodeWorkerProcess(workerId, env);
        workers.push(worker);
        return worker;
      },
    }));
    const queue = new WSJTXDecodeWorkQueue({ maxConcurrency: 1, poolFactory });

    await queue.start('test-start');
    await queue.start('test-start-again');
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(poolFactory).toHaveBeenCalledTimes(1);
    expect(workers).toHaveLength(1);
    expect(queue.getStatus()).toEqual(expect.objectContaining({
      lifecycleState: 'running',
      workerProcesses: 1,
    }));

    await queue.stop('test-stop');
    await queue.stop('test-stop-again');

    expect(workers[0].killed).toBe(true);
    expect(queue.getDecodeWorkerTelemetrySnapshot().summary.status).toBe('stopped');
    await queue.destroy();
  });

  it('rejects decode requests while stopped without emitting worker unavailable', async () => {
    const queue = new WSJTXDecodeWorkQueue();
    const unavailable = vi.fn();
    queue.on('decodeWorkerUnavailable', unavailable);

    await expect(queue.push(createRequest())).rejects.toThrow('decode worker pool is not running');

    expect(unavailable).not.toHaveBeenCalled();
    await queue.destroy();
  });

  it('still emits worker unavailable for real worker startup failures', async () => {
    const queue = new WSJTXDecodeWorkQueue({
      maxConcurrency: 1,
      poolFactory: () => new WSJTXDecodeProcessPool({
        workerCount: 1,
        readyTimeoutMs: 1000,
        jobTimeoutMs: 1000,
        workerFactory: () => {
          throw new Error('spawn failed for lifecycle test');
        },
      }),
    });
    const unavailable = vi.fn();
    queue.on('decodeWorkerUnavailable', unavailable);

    await queue.start('test-start-failure');

    expect(unavailable).toHaveBeenCalledWith(expect.objectContaining({
      status: 'unavailable',
      lastFailure: 'spawn failed for lifecycle test',
    }));
    await queue.destroy();
  });
});
