import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { IntervalHistogram } from 'node:perf_hooks';
import type { ProcessSnapshot, ProcessSnapshotHistory } from '@tx5dr/contracts';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('ProcessMonitor');

const NS_PER_MS = 1e6;

export interface ProcessMonitorConfig {
  intervalMs: number;
  maxHistory: number;
}

const DEFAULT_CONFIG: ProcessMonitorConfig = {
  intervalMs: 2000,
  maxHistory: 900, // 30 minutes at 2s interval
};

export class ProcessMonitor {
  private static instance: ProcessMonitor | null = null;

  private readonly config: ProcessMonitorConfig;
  private readonly history: ProcessSnapshot[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly elMonitor: IntervalHistogram;
  private lastCpuUsage = process.cpuUsage();
  private lastCpuTime = Date.now();
  private broadcastCallback: ((snapshot: ProcessSnapshot) => void) | null = null;

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

    const currentCpu = process.cpuUsage();
    const currentTime = now;
    const elapsedUs = (currentTime - this.lastCpuTime) * 1000;
    const userUs = currentCpu.user - this.lastCpuUsage.user;
    const sysUs = currentCpu.system - this.lastCpuUsage.system;
    this.lastCpuUsage = currentCpu;
    this.lastCpuTime = currentTime;
    const userPct = elapsedUs > 0 ? (userUs / elapsedUs) * 100 : 0;
    const sysPct = elapsedUs > 0 ? (sysUs / elapsedUs) * 100 : 0;

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
      cpu: {
        user: Math.min(userPct, 100),
        system: Math.min(sysPct, 100),
        total: Math.min(userPct + sysPct, 100),
      },
      eventLoop: {
        mean: this.elMonitor.mean / NS_PER_MS,
        p50: this.elMonitor.percentile(50) / NS_PER_MS,
        p99: this.elMonitor.percentile(99) / NS_PER_MS,
      },
    };

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
