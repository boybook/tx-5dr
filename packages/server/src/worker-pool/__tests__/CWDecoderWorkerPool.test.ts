import { afterEach, describe, expect, it, vi } from 'vitest';
import { CWDecoderWorkerPool } from '../CWDecoderWorkerPool.js';

const memory = {
  heapUsed: 100,
  heapTotal: 200,
  rss: 512,
  external: 30,
  arrayBuffers: 15,
};

const cpu = {
  user: 3,
  system: 1,
  total: 4,
};

describe('CWDecoderWorkerPool telemetry', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('preserves worker pid, memory, and delta CPU telemetry', () => {
    const pool = new CWDecoderWorkerPool({
      workerCount: 1,
      runtimeProbe: () => ({ available: true, error: null }),
    });
    const state = {
      id: 1,
      worker: { pid: 4321 },
      ready: true,
      activeJob: null,
      lastTelemetry: null,
    };

    const internals = pool as unknown as {
      updateTelemetry: (workerState: typeof state, telemetry: unknown) => void;
      buildWorkerTelemetry: (workerState: typeof state) => {
        pid?: number;
        memory: typeof memory;
        cpu: typeof cpu;
        ready: boolean;
        busy: boolean;
        lastSeenAt: number;
      };
    };

    internals.updateTelemetry(state, {
      pid: 1234,
      uptimeSeconds: 8,
      memory,
      cpu,
      lastSeenAt: 9,
    });

    const telemetry = internals.buildWorkerTelemetry(state);
    expect(telemetry).toMatchObject({
      pid: 1234,
      ready: true,
      busy: false,
      memory,
      cpu,
      lastSeenAt: 9,
    });
  });

  it('falls back to the child process pid when telemetry does not include pid', () => {
    const pool = new CWDecoderWorkerPool({
      workerCount: 1,
      runtimeProbe: () => ({ available: true, error: null }),
    });
    const state = {
      id: 1,
      worker: { pid: 4321 },
      ready: true,
      activeJob: null,
      lastTelemetry: null,
    };

    const internals = pool as unknown as {
      updateTelemetry: (workerState: typeof state, telemetry: unknown) => void;
      buildWorkerTelemetry: (workerState: typeof state) => { pid?: number };
    };

    internals.updateTelemetry(state, {
      uptimeSeconds: 8,
      memory,
      cpu,
      lastSeenAt: 9,
    });

    expect(internals.buildWorkerTelemetry(state).pid).toBe(4321);
  });

  it('keeps short CW decode jobs visible as recently busy between health samples', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const pool = new CWDecoderWorkerPool({
      workerCount: 1,
      runtimeProbe: () => ({ available: true, error: null }),
    });
    const timer = setTimeout(() => undefined, 10_000);
    const state = {
      id: 1,
      worker: { pid: 4321 },
      ready: true,
      activeJob: {
        id: 7,
        audio: new Float32Array(9_600),
        sampleRate: 9_600,
        resolve: vi.fn(),
        reject: vi.fn(),
        timer,
        startedAt: 900,
      },
      lastTelemetry: null,
      lastCompletedJob: undefined,
      recentlyActiveUntil: 0,
      lastNonZeroCpu: null,
      lastNonZeroCpuAt: 0,
    };

    const internals = pool as unknown as {
      handleWorkerMessage: (workerState: typeof state, message: unknown) => void;
      buildWorkerTelemetry: (workerState: typeof state, now?: number) => {
        busy: boolean;
        currentJob?: { jobId: number; mode: string; elapsedMs: number };
      };
    };

    internals.handleWorkerMessage(state, {
      type: 'result',
      id: 7,
      result: { id: 7, text: '', confidence: 0 },
      telemetry: { pid: 4321, uptimeSeconds: 8, memory, cpu: { user: 0, system: 0, total: 0 }, lastSeenAt: 1_000 },
    });

    expect(internals.buildWorkerTelemetry(state, 1_000)).toMatchObject({
      busy: true,
      currentJob: {
        jobId: 7,
        mode: 'cw',
        elapsedMs: 100,
      },
    });
    expect(internals.buildWorkerTelemetry(state, 6_001).busy).toBe(false);
  });

  it('holds the last non-zero CPU sample briefly so periodic short decodes are visible', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const pool = new CWDecoderWorkerPool({
      workerCount: 1,
      runtimeProbe: () => ({ available: true, error: null }),
    });
    const state = {
      id: 1,
      worker: { pid: 4321 },
      ready: true,
      activeJob: null,
      lastTelemetry: null,
      lastCompletedJob: undefined,
      recentlyActiveUntil: 0,
      lastNonZeroCpu: null,
      lastNonZeroCpuAt: 0,
    };

    const internals = pool as unknown as {
      updateTelemetry: (workerState: typeof state, telemetry: unknown) => void;
      buildWorkerTelemetry: (workerState: typeof state, now?: number) => { cpu: typeof cpu };
    };

    internals.updateTelemetry(state, {
      pid: 4321,
      uptimeSeconds: 8,
      memory,
      cpu,
      lastSeenAt: 1_000,
    });
    internals.updateTelemetry(state, {
      pid: 4321,
      uptimeSeconds: 9,
      memory,
      cpu: { user: 0, system: 0, total: 0 },
      lastSeenAt: 1_100,
    });

    expect(internals.buildWorkerTelemetry(state, 1_100).cpu).toEqual(cpu);
    expect(internals.buildWorkerTelemetry(state, 6_001).cpu.total).toBe(0);
  });
});
