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

export interface DecodeWorkQueueEvents {
  'decodeComplete': (result: DecodeResult) => void;
  'decodeError': (error: Error, request: DecodeRequest) => void;
  'queueEmpty': () => void;
  'decodeWorkerUnavailable': (status: DecodeWorkerPoolHealthSnapshot) => void;
  'decodeWorkerRecovered': (status: DecodeWorkerPoolHealthSnapshot) => void;
}

export class WSJTXDecodeWorkQueue extends EventEmitter<DecodeWorkQueueEvents> implements IDecodeQueue {
  private readonly pool: WSJTXDecodeProcessPool;

  constructor(maxConcurrency?: number) {
    super();
    this.pool = new WSJTXDecodeProcessPool({ workerCount: maxConcurrency });
    this.pool.on('healthStatusChanged', (status: DecodeWorkerPoolHealthSnapshot, previousStatus: string) => {
      if (status.status === 'unavailable') {
        this.emit('decodeWorkerUnavailable', status);
      } else if (previousStatus === 'unavailable') {
        this.emit('decodeWorkerRecovered', status);
      }
    });
    logger.info('decode work queue initialized with process pool', this.pool.getStatus());
  }

  async push(request: DecodeRequest): Promise<void> {
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
    return this.pool.size();
  }

  getStatus() {
    return this.pool.getStatus();
  }

  getDecodeWorkerTelemetrySnapshot(): DecodeWorkerTelemetrySnapshot | undefined {
    return this.pool.getTelemetrySnapshot();
  }

  async destroy(): Promise<void> {
    await this.pool.destroy();
  }
}
