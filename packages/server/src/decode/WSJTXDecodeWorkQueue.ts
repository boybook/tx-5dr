import { EventEmitter } from 'eventemitter3';
import {
  type IDecodeQueue,
  type DecodeRequest,
  type DecodeResult,
} from '@tx5dr/core';
import type { DecodeWorkerTelemetrySnapshot } from '@tx5dr/contracts';
import { createLogger } from '../utils/logger.js';
import { WSJTXDecodeProcessPool, type DecodeWorkerPoolHealthSnapshot } from './WSJTXDecodeProcessPool.js';

const logger = createLogger('DecodeWorkQueue');

type DecodeWorkQueueLifecycleState = 'stopped' | 'starting' | 'running' | 'stopping' | 'destroyed';

export interface DecodeWorkQueueEvents {
  'decodeComplete': (result: DecodeResult) => void;
  'decodeError': (error: Error, request: DecodeRequest) => void;
  'queueEmpty': () => void;
  'decodeWorkerUnavailable': (status: DecodeWorkerPoolHealthSnapshot) => void;
  'decodeWorkerRecovered': (status: DecodeWorkerPoolHealthSnapshot) => void;
}

export interface WSJTXDecodeWorkQueueOptions {
  maxConcurrency?: number;
  poolFactory?: (maxConcurrency?: number) => WSJTXDecodeProcessPool;
}

export class WSJTXDecodeWorkQueue extends EventEmitter<DecodeWorkQueueEvents> implements IDecodeQueue {
  private readonly maxConcurrency?: number;
  private readonly poolFactory: (maxConcurrency?: number) => WSJTXDecodeProcessPool;
  private pool: WSJTXDecodeProcessPool | null = null;
  private lifecycleState: DecodeWorkQueueLifecycleState = 'stopped';
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private readonly healthStatusListener = (status: DecodeWorkerPoolHealthSnapshot, previousStatus: string) => {
    this.handlePoolHealthStatusChanged(status, previousStatus);
  };

  constructor(maxConcurrencyOrOptions?: number | WSJTXDecodeWorkQueueOptions) {
    super();
    const options = typeof maxConcurrencyOrOptions === 'number'
      ? { maxConcurrency: maxConcurrencyOrOptions }
      : maxConcurrencyOrOptions ?? {};
    this.maxConcurrency = options.maxConcurrency;
    this.poolFactory = options.poolFactory ?? ((maxConcurrency) => new WSJTXDecodeProcessPool({ workerCount: maxConcurrency }));
    logger.info('decode work queue initialized in lazy lifecycle mode', {
      maxConcurrency: this.maxConcurrency,
      lifecycleState: this.lifecycleState,
    });
  }

  async start(reason = 'manual'): Promise<void> {
    if (this.lifecycleState === 'destroyed') {
      throw new Error('decode work queue has been destroyed');
    }
    if (this.lifecycleState === 'running') {
      logger.debug('decode work queue already running', { reason });
      return;
    }
    if (this.lifecycleState === 'starting' && this.startPromise) {
      return this.startPromise;
    }
    if (this.lifecycleState === 'stopping' && this.stopPromise) {
      await this.stopPromise;
    }

    this.lifecycleState = 'starting';
    this.startPromise = Promise.resolve()
      .then(() => {
        const pool = this.poolFactory(this.maxConcurrency);
        this.pool = pool;
        pool.on('healthStatusChanged', this.healthStatusListener);
        this.lifecycleState = 'running';
        logger.info('decode work queue started', { reason, status: pool.getStatus() });

        const health = pool.getHealthSnapshot();
        if (health.status === 'unavailable') {
          this.handlePoolHealthStatusChanged(health, 'starting');
        }
      })
      .catch((error) => {
        this.lifecycleState = 'stopped';
        this.pool = null;
        logger.error('decode work queue failed to start', {
          reason,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      })
      .finally(() => {
        this.startPromise = null;
      });

    return this.startPromise;
  }

  async stop(reason = 'manual'): Promise<void> {
    if (this.lifecycleState === 'destroyed' || this.lifecycleState === 'stopped') {
      logger.debug('decode work queue already stopped', { reason, lifecycleState: this.lifecycleState });
      return;
    }
    if (this.lifecycleState === 'stopping' && this.stopPromise) {
      return this.stopPromise;
    }
    if (this.lifecycleState === 'starting' && this.startPromise) {
      await this.startPromise.catch(() => undefined);
    }

    const pool = this.pool;
    if (!pool) {
      this.lifecycleState = 'stopped';
      return;
    }

    this.lifecycleState = 'stopping';
    pool.off('healthStatusChanged', this.healthStatusListener);
    this.stopPromise = pool.destroy()
      .catch((error) => {
        logger.warn('decode work queue stop failed', {
          reason,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      })
      .finally(() => {
        if (this.pool === pool) {
          this.pool = null;
        }
        if (this.lifecycleState !== 'destroyed') {
          this.lifecycleState = 'stopped';
        }
        this.stopPromise = null;
        logger.info('decode work queue stopped', { reason });
      });

    return this.stopPromise;
  }

  async push(request: DecodeRequest): Promise<void> {
    if (this.lifecycleState !== 'running' || !this.pool) {
      const error = new Error(`decode work queue is ${this.lifecycleState}; decode worker pool is not running`);
      logger.debug('decode request rejected by lifecycle state', {
        slotId: request.slotId,
        windowIdx: request.windowIdx,
        lifecycleState: this.lifecycleState,
      });
      throw error;
    }

    try {
      const result = await this.pool.decode(request);
      this.emit('decodeComplete', result);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('decode failed', { slotId: request.slotId, windowIdx: request.windowIdx, error: err.message });
      this.emit('decodeError', err, request);
      throw err;
    } finally {
      if (this.size() === 0) {
        this.emit('queueEmpty');
      }
    }
  }

  size(): number {
    return this.pool?.size() ?? 0;
  }

  getStatus() {
    if (this.pool) {
      return {
        ...this.pool.getStatus(),
        lifecycleState: this.lifecycleState,
      };
    }
    return {
      status: 'stopped',
      lifecycleState: this.lifecycleState,
      queueSize: 0,
      maxConcurrency: 0,
      activeThreads: 0,
      readyWorkers: 0,
      workerProcesses: 0,
      nativeThreadsPerWorker: 1,
      totalNativeDecodeThreads: 0,
      utilization: 0,
      restartAttempts: 0,
    };
  }

  getDecodeWorkerTelemetrySnapshot(): DecodeWorkerTelemetrySnapshot {
    if (this.pool) {
      return this.pool.getTelemetrySnapshot() ?? this.buildStoppedTelemetrySnapshot('starting');
    }
    return this.buildStoppedTelemetrySnapshot(this.lifecycleState === 'starting' ? 'starting' : 'stopped');
  }

  async destroy(): Promise<void> {
    if (this.lifecycleState === 'destroyed') return;
    await this.stop('destroy');
    this.lifecycleState = 'destroyed';
    this.removeAllListeners();
  }

  private handlePoolHealthStatusChanged(status: DecodeWorkerPoolHealthSnapshot, previousStatus: string): void {
    if (this.lifecycleState !== 'running') return;
    if (status.status === 'unavailable') {
      this.emit('decodeWorkerUnavailable', status);
    } else if (previousStatus === 'unavailable') {
      this.emit('decodeWorkerRecovered', status);
    }
  }

  private buildStoppedTelemetrySnapshot(status: 'stopped' | 'starting'): DecodeWorkerTelemetrySnapshot {
    return {
      summary: {
        status,
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
    };
  }
}
