import Piscina from 'piscina';
import { EventEmitter } from 'eventemitter3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { DecodeRequest, DecodeResult } from '@tx5dr/contracts';
import type { IDecodeQueue } from '@tx5dr/core';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface DecodeWorkQueueEvents {
  'result': (result: DecodeResult) => void;
  'error': (error: Error, request: DecodeRequest) => void;
  'queueEmpty': () => void;
}

/**
 * 解码工作队列
 * 实现 IDecodeQueue 接口，使用 Piscina 管理工作线程池
 */
export class DecodeWorkQueue extends EventEmitter<DecodeWorkQueueEvents> implements IDecodeQueue {
  private pool: Piscina;
  private pendingRequests = new Map<string, DecodeRequest>();
  private queueSize = 0;
  
  constructor(options: {
    maxThreads?: number;
    minThreads?: number;
    idleTimeout?: number;
  } = {}) {
    super();
    
    const {
      maxThreads = 4,
      minThreads = 1,
      idleTimeout = 60000
    } = options;
    
    this.pool = new Piscina({
      filename: join(__dirname, 'worker.js'),
      maxThreads,
      minThreads,
      idleTimeout
    });
    
    // 监听工作线程池事件
    this.pool.on('drain', () => {
      if (this.queueSize === 0) {
        this.emit('queueEmpty');
      }
    });
  }
  
  /**
   * 推送解码请求到队列
   */
  async push(request: DecodeRequest): Promise<void> {
    this.queueSize++;
    this.pendingRequests.set(request.slotId, request);
    
    try {
      const result = await this.pool.run(request) as DecodeResult;
      this.pendingRequests.delete(request.slotId);
      this.queueSize--;
      
      this.emit('result', result);
      
    } catch (error) {
      this.pendingRequests.delete(request.slotId);
      this.queueSize--;
      
      const err = error instanceof Error ? error : new Error(String(error));
      this.emit('error', err, request);
    }
  }
  
  /**
   * 获取队列长度
   */
  size(): number {
    return this.queueSize;
  }
  
  /**
   * 获取待处理请求数量
   */
  getPendingCount(): number {
    return this.pendingRequests.size;
  }
  
  /**
   * 获取工作线程池状态
   */
  getPoolStatus() {
    return {
      threads: this.pool.threads.length,
      queueSize: this.pool.queueSize,
      completed: this.pool.completed,
      duration: this.pool.duration,
      utilization: this.pool.utilization
    };
  }
  
  /**
   * 取消指定的解码请求
   */
  cancel(slotId: string): boolean {
    const request = this.pendingRequests.get(slotId);
    if (request) {
      this.pendingRequests.delete(slotId);
      this.queueSize--;
      return true;
    }
    return false;
  }
  
  /**
   * 清空队列
   */
  clear(): void {
    this.pendingRequests.clear();
    this.queueSize = 0;
  }
  
  /**
   * 关闭工作线程池
   */
  async close(): Promise<void> {
    await this.pool.destroy();
    this.clear();
  }
  
  // EventEmitter3 已经提供了类型安全的方法
} 