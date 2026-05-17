import { EventEmitter } from 'eventemitter3';
import { WSJTXLib, WSJTXMode } from 'wsjtx-lib';
import { resampleAudioProfessional } from '../utils/audioUtils.js';
import { createLogger } from '../utils/logger.js';
import { WSJTXNativeGate } from './WSJTXNativeGate.js';

const logger = createLogger('EncodeWorkQueue');

function normalizeMessageForEncodeCheck(message: string): string {
  return message.trim().toUpperCase().replace(/\s+/g, ' ');
}

export interface EncodeRequest {
  message: string;
  frequency: number;
  operatorId: string;
  mode?: 'FT8' | 'FT4';
  slotStartMs?: number; // 时隙开始时间戳
  timeSinceSlotStartMs?: number; // 从时隙开始到现在经过的时间（毫秒）
  requestId?: string; // 编码请求唯一ID（用于去重和追踪）
}

export interface EncodeResult {
  operatorId: string;
  audioData: Float32Array;
  sampleRate: number;
  duration: number;
  success: boolean;
  error?: string;
}

export interface EncodeWorkQueueEvents {
  'encodeComplete': (result: EncodeResult) => void;
  'encodeError': (error: Error, request: EncodeRequest) => void;
  'queueEmpty': () => void;
}

/**
 * 使用 wsjtx-lib 进行FT8消息编码
 */
export class WSJTXEncodeWorkQueue extends EventEmitter<EncodeWorkQueueEvents> {
  private readonly maxConcurrency: number;
  private readonly lib: WSJTXLib;
  private activeCount = 0;
  private readonly pending: Array<{
    request: EncodeRequest;
    resolve: () => void;
  }> = [];
  
  constructor(maxConcurrency: number = 2) {
    super();
    this.maxConcurrency = Number.isFinite(maxConcurrency)
      ? Math.max(1, Math.floor(maxConcurrency))
      : 1;
    this.lib = new WSJTXLib({ maxThreads: 4 });
    logger.info('encode work queue initialized', { maxConcurrency: this.maxConcurrency });
  }
  
  /**
   * 推送编码请求到队列
   */
  async push(request: EncodeRequest): Promise<void> {
    return new Promise<void>((resolve) => {
      this.pending.push({ request, resolve });
      logger.debug('encode request queued', {
        operatorId: request.operatorId,
        message: request.message,
        frequency: request.frequency,
        mode: request.mode || 'FT8',
        timeSinceSlotStartMs: request.timeSinceSlotStartMs,
        queueSize: this.size(),
      });
      this.processQueue();
    });
  }

  private processQueue(): void {
    while (this.activeCount < this.maxConcurrency && this.pending.length > 0) {
      const item = this.pending.shift()!;
      this.activeCount++;
      void this.processItem(item.request)
        .finally(() => {
          this.activeCount--;
          item.resolve();
          if (this.size() === 0) {
            this.emit('queueEmpty');
          }
          this.processQueue();
        });
    }
  }

  private async processItem(request: EncodeRequest): Promise<void> {
    try {
      const startTime = performance.now();

      // 确定模式
      const mode = request.mode === 'FT4' ? WSJTXMode.FT4 : WSJTXMode.FT8;

      // 调用原生库编码
      const { audioData: audioFloat32, messageSent, sampleRate: resultSampleRate } = await WSJTXNativeGate.run(
        () => this.lib.encode(
          mode,
          request.message,
          request.frequency
        )
      );

      const normalizedRequestedMessage = normalizeMessageForEncodeCheck(request.message);
      const normalizedSentMessage = normalizeMessageForEncodeCheck(messageSent ?? '');
      if (normalizedSentMessage !== normalizedRequestedMessage) {
        throw new Error(
          `encoder changed message text: requested="${normalizedRequestedMessage}", sent="${normalizedSentMessage}". `
          + 'Free text messages are limited to 13 characters by WSJT-X.',
        );
      }

      if (!audioFloat32 || audioFloat32.length === 0) {
        throw new Error('encode returned empty audio data');
      }

      // 基于模式校验并必要时截断
      const expectedDuration = mode === WSJTXMode.FT8 ? 12.64 : 6.0;
      const encodeSampleRate = Number.isFinite(resultSampleRate)
        ? resultSampleRate
        : this.lib.getSampleRate(mode);
      const actualDuration = audioFloat32.length / encodeSampleRate;
      const maxSamples = Math.floor(expectedDuration * encodeSampleRate * 1.5);
      let finalAudio = audioFloat32;
      if (finalAudio.length > maxSamples) {
        logger.warn(`audio too long, truncating ${finalAudio.length} -> ${maxSamples}`);
        finalAudio = finalAudio.slice(0, maxSamples);
      }
      if (Math.abs(actualDuration - expectedDuration) > 2 && actualDuration > expectedDuration * 2) {
        const expectedSamples = Math.floor(expectedDuration * encodeSampleRate);
        logger.debug(`truncating to expected length: ${expectedSamples}`);
        finalAudio = finalAudio.slice(0, expectedSamples);
      }

      // 重采样到统一的内部采样率（12kHz）
      const INTERNAL_SAMPLE_RATE = 12000;
      if (encodeSampleRate !== INTERNAL_SAMPLE_RATE) {
        logger.debug(`resampling: ${encodeSampleRate}Hz -> ${INTERNAL_SAMPLE_RATE}Hz`);
        finalAudio = await resampleAudioProfessional(
          finalAudio,
          encodeSampleRate,
          INTERNAL_SAMPLE_RATE,
          1 // 单声道
        );
      }

      // 统计振幅范围
      let minSample = finalAudio[0];
      let maxSample = finalAudio[0];
      let maxAmplitude = 0;
      for (let i = 0; i < finalAudio.length; i++) {
        const s = finalAudio[i];
        if (s < minSample) minSample = s;
        if (s > maxSample) maxSample = s;
        const a = Math.abs(s);
        if (a > maxAmplitude) maxAmplitude = a;
      }

      // 输出采样率固定为 12kHz（统一内部采样率）
      const sampleRate = INTERNAL_SAMPLE_RATE;
      const duration = finalAudio.length / sampleRate;
      const processingTimeMs = performance.now() - startTime;

      logger.debug('encode complete', {
        operatorId: request.operatorId,
        duration: `${duration.toFixed(2)}s`,
        amplitude: `[${minSample.toFixed(4)}, ${maxSample.toFixed(4)}]`,
        processingTimeMs: processingTimeMs.toFixed(2),
      });

      const encodeResult: EncodeResult & { request?: EncodeRequest } = {
        operatorId: request.operatorId,
        audioData: finalAudio,
        sampleRate,
        duration,
        success: true,
        request
      };

      this.emit('encodeComplete', encodeResult);

    } catch (error) {
      logger.error('encode failed', { operatorId: request.operatorId, error });
      this.emit('encodeError', error as Error, request);
    }
  }
  
  /**
   * 获取队列大小
   */
  size(): number {
    return this.pending.length + this.activeCount;
  }
  
  /**
   * 获取工作池状态
   */
  getStatus() {
    return {
      queueSize: this.size(),
      maxConcurrency: this.maxConcurrency,
      activeThreads: this.activeCount,
      utilization: this.activeCount / this.maxConcurrency,
    };
  }
  
  /**
   * 销毁工作池
   */
  async destroy(): Promise<void> {
    this.pending.splice(0).forEach((item) => item.resolve());
    logger.info('encode work queue destroyed (main thread)', {
      activeCount: this.activeCount,
    });
  }
}
