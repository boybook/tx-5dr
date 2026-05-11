import { describe, expect, it } from 'vitest';
import { ProcessSnapshotSchema } from '../process-monitor.schema.js';

function createBaseSnapshot() {
  return {
    timestamp: 1,
    uptimeSeconds: 10,
    memory: {
      heapUsed: 100,
      heapTotal: 200,
      rss: 300,
      external: 20,
      arrayBuffers: 10,
    },
    cpu: {
      user: 10,
      system: 5,
      total: 15,
      capacity: 800,
      normalizedTotal: 1.875,
    },
    eventLoop: {
      mean: 1,
      p50: 1,
      p99: 2,
    },
  };
}

describe('ProcessSnapshotSchema', () => {
  it('accepts legacy snapshots without decode worker telemetry', () => {
    expect(ProcessSnapshotSchema.parse(createBaseSnapshot()).decodeWorkers).toBeUndefined();
  });

  it('accepts decode worker telemetry snapshots', () => {
    const parsed = ProcessSnapshotSchema.parse({
      ...createBaseSnapshot(),
      decodeWorkers: {
        summary: {
          status: 'ready',
          workerCount: 2,
          desiredWorkers: 2,
          readyCount: 2,
          busyCount: 1,
          totalRss: 512,
          totalCpu: 340,
          nativeThreadsPerWorker: 4,
          pendingJobs: 1,
          activeJobs: 1,
          restartAttempts: 0,
          workerEntry: '/app/packages/server/dist/decode/decode-worker-entry.js',
          workerMode: 'production',
        },
        workers: [
          {
            workerId: 1,
            pid: 1234,
            ready: true,
            busy: true,
            nativeThreads: 4,
            uptimeSeconds: 30,
            memory: {
              heapUsed: 100,
              heapTotal: 200,
              rss: 256,
              external: 20,
              arrayBuffers: 10,
            },
            cpu: {
              user: 300,
              system: 40,
              total: 340,
            },
            currentJob: {
              jobId: 7,
              slotId: 'FT8-1-0',
              windowIdx: 0,
              mode: 'FT8',
              startedAt: 1,
              elapsedMs: 1200,
              requestAudioDurationMs: 11500,
            },
            lastSeenAt: 2,
          },
        ],
      },
    });

    expect(parsed.decodeWorkers?.summary.workerCount).toBe(2);
    expect(parsed.decodeWorkers?.workers[0].currentJob?.mode).toBe('FT8');
  });

  it('accepts decode worker unavailable snapshots without per-worker telemetry', () => {
    const parsed = ProcessSnapshotSchema.parse({
      ...createBaseSnapshot(),
      decodeWorkers: {
        summary: {
          status: 'unavailable',
          workerCount: 0,
          desiredWorkers: 1,
          readyCount: 0,
          busyCount: 0,
          totalRss: 0,
          totalCpu: 0,
          nativeThreadsPerWorker: 1,
          pendingJobs: 2,
          activeJobs: 0,
          lastError: 'decode worker startup timed out',
          lastFailureAt: 2,
          restartAttempts: 3,
          workerEntry: '/app/packages/server/dist/decode/decode-worker-entry.js',
          workerMode: 'production',
        },
        workers: [],
      },
    });

    expect(parsed.decodeWorkers?.summary.status).toBe('unavailable');
    expect(parsed.decodeWorkers?.summary.lastError).toContain('startup');
  });

  it('accepts stopped decode worker snapshots without treating them as failures', () => {
    const parsed = ProcessSnapshotSchema.parse({
      ...createBaseSnapshot(),
      decodeWorkers: {
        summary: {
          status: 'stopped',
          workerCount: 0,
          desiredWorkers: 0,
          readyCount: 0,
          busyCount: 0,
          totalRss: 0,
          totalCpu: 0,
          nativeThreadsPerWorker: 1,
          pendingJobs: 0,
          activeJobs: 0,
          restartAttempts: 0,
        },
        workers: [],
      },
    });

    expect(parsed.decodeWorkers?.summary.status).toBe('stopped');
    expect(parsed.decodeWorkers?.summary.lastError).toBeUndefined();
  });

  it('accepts generic worker pool telemetry while preserving decodeWorkers compatibility', () => {
    const decodeWorkerTelemetry = {
      summary: {
        status: 'ready' as const,
        workerCount: 1,
        desiredWorkers: 1,
        readyCount: 1,
        busyCount: 0,
        totalRss: 256,
        totalCpu: 12,
        nativeThreadsPerWorker: 2,
        pendingJobs: 0,
        activeJobs: 0,
      },
      workers: [
        {
          workerId: 1,
          pid: 1234,
          ready: true,
          busy: false,
          nativeThreads: 2,
          uptimeSeconds: 30,
          memory: {
            heapUsed: 100,
            heapTotal: 200,
            rss: 256,
            external: 20,
            arrayBuffers: 10,
          },
          cpu: {
            user: 10,
            system: 2,
            total: 12,
          },
          lastSeenAt: 2,
        },
      ],
    };

    const parsed = ProcessSnapshotSchema.parse({
      ...createBaseSnapshot(),
      decodeWorkers: decodeWorkerTelemetry,
      workerPools: [
        {
          id: 'ft8-decode',
          name: 'FT8 Decode Workers',
          kind: 'decode',
          ...decodeWorkerTelemetry,
        },
        {
          id: 'cw-decoder',
          name: 'CW Decoder Workers',
          kind: 'cw-decoder',
          summary: {
            status: 'stopped',
            workerCount: 0,
            desiredWorkers: 0,
            readyCount: 0,
            busyCount: 0,
            totalRss: 0,
            totalCpu: 0,
            nativeThreadsPerWorker: 1,
            pendingJobs: 0,
            activeJobs: 0,
          },
          workers: [],
        },
      ],
    });

    expect(parsed.decodeWorkers?.summary.workerCount).toBe(1);
    expect(parsed.workerPools?.map((pool) => pool.id)).toEqual(['ft8-decode', 'cw-decoder']);
    expect(parsed.workerPools?.[0].workers[0].workerId).toBe(1);
  });
});
