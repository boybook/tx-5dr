import { describe, expect, it } from 'vitest';
import {
  calculateCpuPercentages,
  calculateHostCpuUsage,
  ProcessMonitor,
  resolveCpuCapacityFromValues,
  summarizeHostCpuTimes,
} from '../ProcessMonitor.js';

describe('ProcessMonitor CPU helpers', () => {
  it('preserves process CPU above 100 percent on multi-core workloads', () => {
    const cpu = calculateCpuPercentages({
      elapsedUs: 2_000_000,
      userUs: 2_400_000,
      sysUs: 600_000,
      capacity: 800,
    });

    expect(cpu.user).toBe(120);
    expect(cpu.system).toBe(30);
    expect(cpu.total).toBe(150);
  });

  it('normalizes process CPU against available capacity', () => {
    const cpu = calculateCpuPercentages({
      elapsedUs: 2_000_000,
      userUs: 2_400_000,
      sysUs: 600_000,
      capacity: 800,
    });

    expect(cpu.capacity).toBe(800);
    expect(cpu.normalizedTotal).toBe(18.75);
  });

  it('falls back to logical cores when available parallelism is missing', () => {
    expect(resolveCpuCapacityFromValues({
      availableParallelism: null,
      logicalCores: 6,
    })).toEqual({
      availableParallelism: 6,
      logicalCores: 6,
      capacity: 600,
    });
  });

  it('uses a single-core floor when CPU discovery fails', () => {
    expect(resolveCpuCapacityFromValues({
      availableParallelism: null,
      logicalCores: 0,
    })).toEqual({
      availableParallelism: 1,
      logicalCores: 1,
      capacity: 100,
    });
  });

  it('calculates host CPU usage from aggregate logical-core times', () => {
    const previous = summarizeHostCpuTimes([
      { model: 'cpu0', speed: 1, times: { user: 100, nice: 0, sys: 100, idle: 800, irq: 0 } },
      { model: 'cpu1', speed: 1, times: { user: 100, nice: 0, sys: 100, idle: 800, irq: 0 } },
    ]);
    const current = summarizeHostCpuTimes([
      { model: 'cpu0', speed: 1, times: { user: 300, nice: 0, sys: 200, idle: 900, irq: 0 } },
      { model: 'cpu1', speed: 1, times: { user: 150, nice: 0, sys: 150, idle: 1_100, irq: 0 } },
    ]);

    expect(calculateHostCpuUsage(previous, current)).toBeCloseTo(50);
  });

  it('merges extra decode worker telemetry into process snapshots', async () => {
    const monitor = ProcessMonitor.getInstance({ intervalMs: 10, maxHistory: 4 });
    monitor.setExtraSnapshotProvider(() => ({
      decodeWorkers: {
        summary: {
          workerCount: 1,
          readyCount: 1,
          busyCount: 1,
          totalRss: 1024,
          totalCpu: 250,
          nativeThreadsPerWorker: 2,
          pendingJobs: 0,
          activeJobs: 1,
        },
        workers: [
          {
            workerId: 1,
            pid: 123,
            ready: true,
            busy: true,
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
              user: 200,
              system: 50,
              total: 250,
            },
            lastSeenAt: Date.now(),
          },
        ],
      },
    }));

    const snapshot = await new Promise<ReturnType<typeof monitor.getHistory>[number]>((resolve) => {
      monitor.setBroadcastCallback((next) => {
        resolve(next);
      });
      monitor.start();
    });
    monitor.stop();

    expect(snapshot.decodeWorkers?.summary.totalCpu).toBe(250);
    expect(snapshot.decodeWorkers?.workers[0].busy).toBe(true);
  });

  it('continues process snapshots when the extra provider fails', async () => {
    const monitor = ProcessMonitor.getInstance({ intervalMs: 10, maxHistory: 4 });
    monitor.setExtraSnapshotProvider(() => {
      throw new Error('boom');
    });

    const snapshot = await new Promise<ReturnType<typeof monitor.getHistory>[number]>((resolve) => {
      monitor.setBroadcastCallback((next) => {
        resolve(next);
      });
      monitor.start();
    });
    monitor.stop();
    monitor.setExtraSnapshotProvider(null);

    expect(snapshot.timestamp).toBeGreaterThan(0);
    expect(snapshot.decodeWorkers).toBeUndefined();
  });
});
