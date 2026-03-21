import { EventEmitter } from 'eventemitter3';
import { WSJTXLib, WSJTXMode } from 'wsjtx-lib';
import { resampleAudioProfessional } from '../utils/audioUtils.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('EncodeWorkQueue');

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
  private queueSize = 0;
  private maxConcurrency: number;
  private lib: WSJTXLib;
  
  constructor(maxConcurrency: number = 2) {
    super();
    this.maxConcurrency = maxConcurrency;
    this.lib = new WSJTXLib();
    logger.info('encode work queue initialized', { maxConcurrency });
  }
  
  /**
   * 推送编码请求到队列
   */
  async push(request: EncodeRequest): Promise<void> {
    this.queueSize++;
    
    logger.debug('encode request received', {
      operatorId: request.operatorId,
      message: request.message,
      frequency: request.frequency,
      mode: request.mode || 'FT8',
      timeSinceSlotStartMs: request.timeSinceSlotStartMs,
      queueSize: this.queueSize,
    });
    
    try {
      const startTime = performance.now();

      // 确定模式
      const mode = request.mode === 'FT4' ? WSJTXMode.FT4 : WSJTXMode.FT8;

      // 调用原生库编码
      const { audioData: audioFloat32, messageSent } = await this.lib.encode(
        mode,
        request.message,
        request.frequency
      );

      if (!audioFloat32 || audioFloat32.length === 0) {
        throw new Error('编码返回的音频数据为空');
      }

      // 基于模式校验并必要时截断
      const expectedDuration = mode === WSJTXMode.FT8 ? 12.64 : 6.4;
      const encodeSampleRate = 48000; // wsjtx-lib 编码输出为 48kHz
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
      logger.debug(`resampling: ${encodeSampleRate}Hz -> ${INTERNAL_SAMPLE_RATE}Hz`);
      finalAudio = await resampleAudioProfessional(
        finalAudio,
        encodeSampleRate,
        INTERNAL_SAMPLE_RATE,
        1 // 单声道
      );

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
      if (this.queueSize === 0) this.emit('queueEmpty');

    } catch (error) {
      console.error(`encode failed for operator ${request.operatorId}:`, error);
      this.emit('encodeError', error as Error, request);
      if (this.queueSize === 0) this.emit('queueEmpty');
    } finally {
      if (this.queueSize > 0) this.queueSize--;
    }
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
    logger.info('encode work queue destroyed (main thread, no worker pool)');
  }
}
