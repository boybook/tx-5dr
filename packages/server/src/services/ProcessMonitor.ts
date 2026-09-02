import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { IntervalHistogram } from 'node:perf_hooks';
import os from 'node:os';
import type { CpuInfo } from 'node:os';
import type { DecodeWorkerTelemetrySnapshot, WorkerPoolTelemetrySnapshot, ProcessSnapshot, ProcessSnapshotHistory } from '@tx5dr/contracts';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('ProcessMonitor');

const NS_PER_MS = 1e6;
const EVENT_LOOP_DELAY_LOG_THRESHOLD_MS = 100;
const HEAP_GROWTH_LOG_THRESHOLD_BYTES = 32 * 1024 * 1024;
const RSS_GROWTH_LOG_THRESHOLD_BYTES = 64 * 1024 * 1024;
const DIAGNOSTIC_LOG_MIN_INTERVAL_MS = 5000;

export interface ProcessMonitorConfig {
  intervalMs: number;
  maxHistory: number;
}

const DEFAULT_CONFIG: ProcessMonitorConfig = {
  intervalMs: 2000,
  maxHistory: 900, // 30 minutes at 2s interval
};

export interface CpuCapacityInfo {
  availableParallelism: number;
  logicalCores: number;
  capacity: number;
}

export interface CpuPercentages {
  user: number;
  system: number;
  total: number;
  capacity: number;
  normalizedTotal: number;
}

export interface HostCpuTimes {
  idle: number;
  total: number;
}

function positiveIntegerOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

export function resolveCpuCapacityFromValues(options: {
  availableParallelism?: number | null;
  logicalCores?: number | null;
}): CpuCapacityInfo {
  const logicalCores = positiveIntegerOrNull(options.logicalCores) ?? 1;
  const resolvedParallelism = positiveIntegerOrNull(options.availableParallelism) ?? logicalCores;

  return {
    availableParallelism: resolvedParallelism,
    logicalCores,
    capacity: Math.max(resolvedParallelism * 100, 100),
  };
}

export function resolveCpuCapacity(): CpuCapacityInfo {
  const logicalCores = os.cpus().length;
  let availableParallelism: number | null = null;

  try {
    availableParallelism = os.availableParallelism?.() ?? null;
  } catch {
    availableParallelism = null;
  }

  return resolveCpuCapacityFromValues({ availableParallelism, logicalCores });
}

export function summarizeHostCpuTimes(cpus: CpuInfo[]): HostCpuTimes | null {
  if (cpus.length === 0) return null;

  return cpus.reduce<HostCpuTimes>((acc, cpu) => {
    const total = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
    return {
      idle: acc.idle + cpu.times.idle,
      total: acc.total + total,
    };
  }, { idle: 0, total: 0 });
}

export function readHostCpuTimes(): HostCpuTimes | null {
  try {
    return summarizeHostCpuTimes(os.cpus());
  } catch {
    return null;
  }
}

export function calculateHostCpuUsage(previous: HostCpuTimes | null, current: HostCpuTimes | null): number | undefined {
  if (!previous || !current) return undefined;

  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  if (totalDelta <= 0 || idleDelta < 0) return undefined;

  return Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100));
}

export function calculateCpuPercentages(options: {
  elapsedUs: number;
  userUs: number;
  sysUs: number;
  capacity: number;
}): CpuPercentages {
  const user = options.elapsedUs > 0 ? (options.userUs / options.elapsedUs) * 100 : 0;
  const system = options.elapsedUs > 0 ? (options.sysUs / options.elapsedUs) * 100 : 0;
  const total = user + system;
  const capacity = Math.max(options.capacity, 100);

  return {
    user,
    system,
    total,
    capacity,
    normalizedTotal: capacity > 0 ? (total / capacity) * 100 : 0,
  };
}

export class ProcessMonitor {
  private static instance: ProcessMonitor | null = null;

  private readonly config: ProcessMonitorConfig;
  private readonly history: ProcessSnapshot[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly elMonitor: IntervalHistogram;
  private readonly cpuCapacity = resolveCpuCapacity();
  private lastCpuUsage = process.cpuUsage();
  private lastCpuTime = Date.now();
  private lastHostCpuTimes = readHostCpuTimes();
  private lastMemoryUsage = process.memoryUsage();
  private lastEventLoopDelayLogAt = 0;
  private lastMemoryJumpLogAt = 0;
  private broadcastCallback: ((snapshot: ProcessSnapshot) => void) | null = null;
  private extraSnapshotProvider: (() => { decodeWorkers?: DecodeWorkerTelemetrySnapshot; workerPools?: WorkerPoolTelemetrySnapshot[] } | undefined) | null = null;

  private constructor(config: Partial<ProcessMonitorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.elMonitor = monitorEventLoopDelay({ resolution: 20 });
  }

  static getInstance(config?: Partial<ProcessMonitorConfig>): ProcessMonitor {
    if (!ProcessMonitor.instance) {
      ProcessMonitor.instance = new ProcessMonitor(config);
    }
    return ProcessMonitor.instance;
  }

  setBroadcastCallback(cb: (snapshot: ProcessSnapshot) => void): void {
    this.broadcastCallback = cb;
  }

  setExtraSnapshotProvider(provider: (() => { decodeWorkers?: DecodeWorkerTelemetrySnapshot; workerPools?: WorkerPoolTelemetrySnapshot[] } | undefined) | null): void {
    this.extraSnapshotProvider = provider;
  }

  start(): void {
    if (this.timer) return;
    this.elMonitor.enable();
    this.timer = setInterval(() => this.sample(), this.config.intervalMs);
    this.timer.unref();
    logger.info('process monitor started', {
      intervalMs: this.config.intervalMs,
      maxHistory: this.config.maxHistory,
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.elMonitor.disable();
    logger.info('process monitor stopped');
  }

  getHistory(): ProcessSnapshot[] {
    return [...this.history];
  }

  getHistoryPayload(): ProcessSnapshotHistory {
    return {
      snapshots: this.getHistory(),
      intervalMs: this.config.intervalMs,
      maxHistory: this.config.maxHistory,
    };
  }

  getIntervalMs(): number {
    return this.config.intervalMs;
  }

  getMaxHistory(): number {
    return this.config.maxHistory;
  }

  private sample(): void {
    const now = Date.now();

    const mem = process.memoryUsage();
    const heapGrowthBytes = mem.heapUsed - this.lastMemoryUsage.heapUsed;
    const rssGrowthBytes = mem.rss - this.lastMemoryUsage.rss;
    this.lastMemoryUsage = mem;

    const currentCpu = process.cpuUsage();
    const currentTime = now;
    const elapsedUs = (currentTime - this.lastCpuTime) * 1000;
    const userUs = currentCpu.user - this.lastCpuUsage.user;
    const sysUs = currentCpu.system - this.lastCpuUsage.system;
    this.lastCpuUsage = currentCpu;
    this.lastCpuTime = currentTime;
    const cpu = calculateCpuPercentages({
      elapsedUs,
      userUs,
      sysUs,
      capacity: this.cpuCapacity.capacity,
    });
    const currentHostCpuTimes = readHostCpuTimes();
    const hostTotalUsage = calculateHostCpuUsage(this.lastHostCpuTimes, currentHostCpuTimes);
    this.lastHostCpuTimes = currentHostCpuTimes;

    const eventLoop = {
      mean: this.elMonitor.mean / NS_PER_MS,
      p50: this.elMonitor.percentile(50) / NS_PER_MS,
      p99: this.elMonitor.percentile(99) / NS_PER_MS,
    };

    const snapshot: ProcessSnapshot = {
      timestamp: now,
      uptimeSeconds: process.uptime(),
      memory: {
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        rss: mem.rss,
        external: mem.external,
        arrayBuffers: mem.arrayBuffers,
      },
      cpu,
      hostCpu: {
        logicalCores: this.cpuCapacity.logicalCores,
        availableParallelism: this.cpuCapacity.availableParallelism,
        totalUsage: hostTotalUsage,
      },
      eventLoop,
    };

    if (this.extraSnapshotProvider) {
      try {
        const extra = this.extraSnapshotProvider();
        if (extra?.decodeWorkers) {
          snapshot.decodeWorkers = extra.decodeWorkers;
        }
        if (extra?.workerPools) {
          snapshot.workerPools = extra.workerPools;
        }
      } catch (error) {
        logger.warn('process monitor extra snapshot provider failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (
      Number.isFinite(eventLoop.p99)
      && eventLoop.p99 >= EVENT_LOOP_DELAY_LOG_THRESHOLD_MS
      && now - this.lastEventLoopDelayLogAt >= DIAGNOSTIC_LOG_MIN_INTERVAL_MS
    ) {
      this.lastEventLoopDelayLogAt = now;
      logger.warn(
        `event loop delay elevated timestamp=${now} meanMs=${eventLoop.mean.toFixed(1)} p50Ms=${eventLoop.p50.toFixed(1)} p99Ms=${eventLoop.p99.toFixed(1)} `
        + `processCpuNormalizedPercent=${cpu.normalizedTotal.toFixed(1)} hostCpuPercent=${hostTotalUsage === undefined ? 'na' : hostTotalUsage.toFixed(1)} `
        + `heapUsedBytes=${mem.heapUsed} heapTotalBytes=${mem.heapTotal} heapGrowthBytes=${heapGrowthBytes} rssBytes=${mem.rss} rssGrowthBytes=${rssGrowthBytes} `
        + `externalBytes=${mem.external} arrayBuffersBytes=${mem.arrayBuffers}`,
      );
    }

    if (
      (heapGrowthBytes >= HEAP_GROWTH_LOG_THRESHOLD_BYTES || rssGrowthBytes >= RSS_GROWTH_LOG_THRESHOLD_BYTES)
      && now - this.lastMemoryJumpLogAt >= DIAGNOSTIC_LOG_MIN_INTERVAL_MS
    ) {
      this.lastMemoryJumpLogAt = now;
      logger.warn(
        `process memory jump timestamp=${now} heapUsedBytes=${mem.heapUsed} heapTotalBytes=${mem.heapTotal} heapGrowthBytes=${heapGrowthBytes} `
        + `rssBytes=${mem.rss} rssGrowthBytes=${rssGrowthBytes} externalBytes=${mem.external} arrayBuffersBytes=${mem.arrayBuffers} `
        + `eventLoopP99Ms=${eventLoop.p99.toFixed(1)} processCpuNormalizedPercent=${cpu.normalizedTotal.toFixed(1)}`,
      );
    }

    this.elMonitor.reset();

    this.history.push(snapshot);
    if (this.history.length > this.config.maxHistory) {
      this.history.shift();
    }

    if (this.broadcastCallback) {
      this.broadcastCallback(snapshot);
    }
  }
}
