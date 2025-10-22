import { EventEmitter } from 'eventemitter3';
import { 
  type IDecodeQueue, 
  type DecodeRequest, 
  type DecodeResult 
} from '@tx5dr/core';
import { resampleAudioProfessional } from '../utils/audioUtils.js';
import { WSJTXLib, WSJTXMode } from 'wsjtx-lib';

export interface DecodeWorkQueueEvents {
  'decodeComplete': (result: DecodeResult) => void;
  'decodeError': (error: Error, request: DecodeRequest) => void;
  'queueEmpty': () => void;
}

/**
 * 使用 wsjtx-lib 进行解码
 */
export class WSJTXDecodeWorkQueue extends EventEmitter<DecodeWorkQueueEvents> implements IDecodeQueue {
  private queueSize = 0;
  private maxConcurrency: number;
  private lib: WSJTXLib;
  private activeCount = 0;
  private pending: Array<{
    request: DecodeRequest;
    resolve: () => void;
    reject: (err: unknown) => void;
  }> = [];
  
  constructor(maxConcurrency: number = 4) {
    super();
    this.maxConcurrency = maxConcurrency;
    this.lib = new WSJTXLib();
    console.log(`🔧 [解码队列] 初始化完成（主线程），最大并发标注: ${maxConcurrency}`);
  }
  
  /**
   * 推送解码请求到队列
   */
  async push(request: DecodeRequest): Promise<void> {
    this.queueSize++;
    return new Promise<void>((resolve, reject) => {
      this.pending.push({ request, resolve, reject });
      this.processQueue();
    });
  }

  private processQueue() {
    while (this.activeCount < this.maxConcurrency && this.pending.length > 0) {
      const item = this.pending.shift()!;
      this.activeCount++;
      this.processItem(item.request)
        .then(() => item.resolve())
        .catch((err) => item.reject(err))
        .finally(() => {
          this.activeCount--;
          if (this.queueSize > 0) this.queueSize--;
          if (this.queueSize === 0) this.emit('queueEmpty');
          // 继续处理下一批
          this.processQueue();
        });
    }
  }

  private async processItem(request: DecodeRequest): Promise<void> {
    const startTime = performance.now();

    // 将 ArrayBuffer 转换为 Float32Array
    const originalAudioData = new Float32Array(request.pcm);

    // 步骤1: 采样率验证（系统统一 12kHz，理论上不需要重采样）
    // 保留此逻辑作为保险，以防特殊情况下传入非 12kHz 数据
    let resampledAudioData: Float32Array;
    if (request.sampleRate && request.sampleRate !== 12000) {
      console.warn(`⚠️ [解码队列] 意外的采样率 ${request.sampleRate}Hz，重采样到 12kHz`);
      resampledAudioData = await resampleAudioProfessional(
        originalAudioData,
        request.sampleRate,
        12000,
        1 // 单声道
      );
    } else {
      resampledAudioData = originalAudioData;
    }

    // 将 Float32Array 转换为 Int16Array（当前原生解码在 Int16 路径上更稳定）
    const audioInt16 = await this.lib.convertAudioFormat(resampledAudioData, 'int16') as Int16Array;

    // 清空消息队列并调用解码
    this.lib.pullMessages();
    const baseFrequency = 0; // 基频，目前为0
    await this.lib.decode(WSJTXMode.FT8, audioInt16, baseFrequency);

    // 读取消息并映射到帧
    const messages = this.lib.pullMessages() as any[];
    const frames = (messages || []).map((msg: any) => ({
      message: msg.text,
      snr: msg.snr,
      dt: msg.deltaTime,
      freq: (msg.deltaFrequency || 0) + baseFrequency,
      confidence: 1.0
    }));

    const processingTimeMs = performance.now() - startTime;

    const decodeResult: DecodeResult = {
      slotId: request.slotId,
      windowIdx: request.windowIdx,
      frames,
      timestamp: request.timestamp,
      processingTimeMs,
      windowOffsetMs: request.windowOffsetMs || 0
    };

    console.log(`🔧 [解码完成] 时隙: ${request.slotId}, 窗口: ${request.windowIdx}, 找到 ${decodeResult.frames.length} 个信号, 耗时: ${processingTimeMs.toFixed(2)}ms`);
    this.emit('decodeComplete', decodeResult);
  }
  
  /**
   * 获取队列大小
   */
  size(): number {
    return this.queueSize;
  }
  
  /**
   * 获取工作池状态
   */
  getStatus() {
    return {
      queueSize: this.queueSize,
      maxConcurrency: this.maxConcurrency,
      activeThreads: 0,
      utilization: 0
    };
  }
  
  /**
   * 销毁工作池
   */
  async destroy(): Promise<void> {
    console.log('🗑️ [解码队列] 清理（主线程，无工作池）');
  }
}
