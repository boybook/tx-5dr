import { EventEmitter } from 'eventemitter3';
import { WSJTXLib, WSJTXMode } from 'wsjtx-lib';

export interface EncodeRequest {
  message: string;
  frequency: number;
  operatorId: string;
  mode?: 'FT8' | 'FT4';
  slotStartMs?: number; // 时隙开始时间戳
  timeSinceSlotStartMs?: number; // 从时隙开始到现在经过的时间（毫秒）
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
    console.log(`🎵 [编码队列] 初始化完成（主线程），最大并发标注: ${maxConcurrency}`);
  }
  
  /**
   * 推送编码请求到队列
   */
  async push(request: EncodeRequest): Promise<void> {
    this.queueSize++;
    
    console.log(`🎵 [编码队列] 收到编码请求:`);
    console.log(`   操作员: ${request.operatorId}`);
    console.log(`   消息: "${request.message}"`);
    console.log(`   频率: ${request.frequency}Hz`);
    console.log(`   模式: ${request.mode || 'FT8'}`);
    if (request.timeSinceSlotStartMs) {
      console.log(`   时隙已过时间: ${request.timeSinceSlotStartMs}ms`);
    }
    console.log(`   队列大小: ${this.queueSize}`);
    
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
      const sampleRate = 48000; // FT8/FT4 均为48kHz
      const actualDuration = audioFloat32.length / sampleRate;
      const maxSamples = Math.floor(expectedDuration * sampleRate * 1.5);
      let finalAudio = audioFloat32;
      if (finalAudio.length > maxSamples) {
        console.warn(`⚠️ [编码队列] 音频过长，截断 ${finalAudio.length} -> ${maxSamples}`);
        finalAudio = finalAudio.slice(0, maxSamples);
      }
      if (Math.abs(actualDuration - expectedDuration) > 2 && actualDuration > expectedDuration * 2) {
        const expectedSamples = Math.floor(expectedDuration * sampleRate);
        console.log(`🔄 [编码队列] 再次截断到期望长度: ${expectedSamples}`);
        finalAudio = finalAudio.slice(0, expectedSamples);
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

      const duration = finalAudio.length / sampleRate;
      const processingTimeMs = performance.now() - startTime;

      console.log(`✅ [编码完成] 操作员: ${request.operatorId}, 时长: ${duration.toFixed(2)}s, 振幅范围: [${minSample.toFixed(4)}, ${maxSample.toFixed(4)}], 耗时: ${processingTimeMs.toFixed(2)}ms`);

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
      console.error(`❌ [编码失败] 操作员: ${request.operatorId}:`, error);
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
    console.log('🗑️ [编码队列] 清理（主线程，无工作池）');
  }
}
