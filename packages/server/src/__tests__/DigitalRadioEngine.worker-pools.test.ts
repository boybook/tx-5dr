import { describe, expect, it } from 'vitest';
import { DigitalRadioEngine } from '../DigitalRadioEngine.js';

describe('DigitalRadioEngine worker pool telemetry', () => {
  it('aggregates cw-decode worker RSS and CPU from worker snapshots', () => {
    const workers = [
      {
        workerId: 1,
        pid: 1234,
        ready: true,
        busy: false,
        nativeThreads: 1,
        uptimeSeconds: 8,
        memory: {
          heapUsed: 100,
          heapTotal: 200,
          rss: 512,
          external: 30,
          arrayBuffers: 15,
        },
        cpu: {
          user: 3,
          system: 1,
          total: 4,
        },
        lastSeenAt: 9,
      },
      {
        workerId: 2,
        pid: 5678,
        ready: true,
        busy: true,
        nativeThreads: 1,
        uptimeSeconds: 8,
        memory: {
          heapUsed: 101,
          heapTotal: 201,
          rss: 1024,
          external: 31,
          arrayBuffers: 16,
        },
        cpu: {
          user: 6,
          system: 2,
          total: 8,
        },
        lastSeenAt: 9,
      },
    ];
    const engine = Object.assign(Object.create(DigitalRadioEngine.prototype), {
      realDecodeQueue: {
        getDecodeWorkerTelemetrySnapshot: () => undefined,
      },
      cwDecoderManager: {
        getWorkerPoolTelemetrySnapshot: () => ({
          status: 'running',
          workerCount: 2,
          jobsStarted: 1,
          jobsCompleted: 1,
          jobsFailed: 0,
          inFlight: 1,
          pendingJobs: 0,
          lastError: null,
          workers,
        }),
      },
    });

    const pools = (DigitalRadioEngine.prototype as unknown as {
      getWorkerPoolTelemetrySnapshots: () => Array<{
        id: string;
        summary: {
          totalRss: number;
          totalCpu: number;
          workerCount: number;
          desiredWorkers?: number;
          readyCount: number;
          busyCount: number;
        };
        workers: typeof workers;
      }>;
    }).getWorkerPoolTelemetrySnapshots.call(engine);

    expect(pools).toHaveLength(1);
    expect(pools[0]).toMatchObject({
      id: 'cw-decode',
      summary: {
        workerCount: 2,
        desiredWorkers: 2,
        readyCount: 2,
        busyCount: 1,
        totalRss: 1536,
        totalCpu: 12,
      },
    });
    expect(pools[0]?.workers.map((worker) => worker.pid)).toEqual([1234, 5678]);
  });
});
