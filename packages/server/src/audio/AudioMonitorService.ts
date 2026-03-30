import { EventEmitter } from 'eventemitter3';
import { RingBufferAudioProvider } from './AudioBufferProvider.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('AudioMonitorService');
const MONITOR_STREAM_SAMPLE_RATE = 16000;
const MONITOR_FRAME_MS = 20;
const HIGH_LATENCY_WARN_MS = 120;

/**
 * 音频监听统计信息
 */
interface AudioMonitorStats {
  latencyMs: number;
  bufferFillPercent: number;
  isActive: boolean;
  audioLevel?: number;
  droppedSamples?: number;
  sampleRate: number;
}

/**
 * AudioMonitorService 事件接口
 */
export interface AudioMonitorServiceEvents {
  audioData: (data: {
    audioData: ArrayBuffer;
    sampleRate: number;
    samples: number;
    timestamp: number;
    sequence: number;
  }) => void;
  stats: (stats: AudioMonitorStats) => void;
}

/**
 * 音频监听服务（广播模式）
 * 负责独立于数字电台引擎的音频监听功能
 * - 广播模式：自动启动，向所有已连接客户端推送音频
 * - 解耦设计：直接从 RingBufferAudioProvider 读取，不依赖现有发射链路
 * - 统一采样率：固定16kHz输出（足够覆盖电台监听所需带宽）
 * - 客户端音量：在浏览器播放侧调整
 */
export class AudioMonitorService extends EventEmitter<AudioMonitorServiceEvents> {
  private audioProvider: RingBufferAudioProvider;
  private pushInterval: NodeJS.Timeout | null = null;
  private readonly CHECK_INTERVAL_MS = 5;       // 检查间隔：5ms（更快达到首帧发送）
  private readonly TARGET_BUFFER_MS = 20;       // 目标缓冲区水位：20ms（降低监听预缓冲）
  private readonly TARGET_CHUNK_MS = 20;        // 输入块大小：20ms（低延迟流式处理）
  private readonly TARGET_SAMPLE_RATE = MONITOR_STREAM_SAMPLE_RATE;
  private readonly OUTPUT_FRAME_SAMPLES = (this.TARGET_SAMPLE_RATE * MONITOR_FRAME_MS) / 1000;
  private readonly sourceSampleRate: number;
  private readonly needsResample: boolean;
  private outputBuffer = new Float32Array(0);
  private isProcessingChunk = false;

  // 统计信息
  private droppedSamplesCount = 0;
  private isRunning = false;
  private sequenceNumber = 0;
  private latestStats: AudioMonitorStats | null = null;

  constructor(audioProvider: RingBufferAudioProvider) {
    super();
    this.audioProvider = audioProvider;
    this.sourceSampleRate = audioProvider.getSampleRate();
    this.needsResample = this.sourceSampleRate !== this.TARGET_SAMPLE_RATE;

    logger.info('Audio monitor service initialized (broadcast mode)', {
      sourceSampleRate: this.sourceSampleRate,
      targetSampleRate: this.TARGET_SAMPLE_RATE,
      streamingResampler: false,
      quality: this.needsResample ? 'linear' : 'bypass',
    });

    // 自动启动推送
    this.startPushingAudio();
  }

  /**
   * 启动音频推送
   */
  private startPushingAudio(): void {
    if (this.pushInterval) {
      return; // 已经在推送中
    }

    logger.info(
      `Starting adaptive audio push (checkInterval=${this.CHECK_INTERVAL_MS}ms, ` +
      `targetBuffer=${this.TARGET_BUFFER_MS}ms, targetChunk=${this.TARGET_CHUNK_MS}ms)`
    );
    this.isRunning = true;

    this.pushInterval = setInterval(() => {
      this.checkAndPush();
    }, this.CHECK_INTERVAL_MS);
  }

  /**
   * 停止音频推送
   */
  private stopPushingAudio(): void {
    if (this.pushInterval) {
      clearInterval(this.pushInterval);
      this.pushInterval = null;
      this.isRunning = false;
      logger.info('Stopped broadcasting audio data');
    }
  }

  /**
   * 检查缓冲区并按需推送
   */
  private async checkAndPush(): Promise<void> {
    try {
      if (this.isProcessingChunk) {
        return;
      }

      // 检查缓冲区是否达到目标水位
      const availableMs = this.audioProvider.getAvailableMs();

      if (availableMs < this.TARGET_BUFFER_MS) {
        // 缓冲区未满，等待累积
        return;
      }

      // 执行推送
      this.isProcessingChunk = true;
      await this.pushAudioChunk();
    } catch (error) {
      logger.error('Check and push failed', error);
    } finally {
      this.isProcessingChunk = false;
    }
  }

  /**
   * 推送音频数据块
   */
  private async pushAudioChunk(): Promise<void> {
    try {
      const now = Date.now();

      // 计算需要读取的样本数
      const sourceSampleCount = Math.floor((this.sourceSampleRate * this.TARGET_CHUNK_MS) / 1000);

      // ✅ 使用连续读取替代基于时间戳的读取
      const audioBuffer = this.audioProvider.readNextChunk(sourceSampleCount);
      const sourceAudioData = new Float32Array(audioBuffer);

      // 检查是否读取到足够数据
      if (sourceAudioData.length < sourceSampleCount) {
        logger.warn(`Insufficient buffer data: needed=${sourceSampleCount}, actual=${sourceAudioData.length}`);
        return;
      }

      // 检查音频活动
      const rms = this.calculateRMS(sourceAudioData);
      const isActive = rms > 0.001;

      let processedAudio = sourceAudioData;
      if (this.needsResample) {
        processedAudio = this.resampleChunkLinear(
          sourceAudioData,
          this.sourceSampleRate,
          this.TARGET_SAMPLE_RATE,
        );
      }

      if (processedAudio.length === 0) {
        return;
      }

      this.appendToOutputBuffer(processedAudio);
      const emittedFrames = this.emitReadyFrames(now);
      const stats = this.calculateStats(this.TARGET_SAMPLE_RATE, isActive, rms);
      this.latestStats = stats;

      if (stats.latencyMs >= HIGH_LATENCY_WARN_MS) {
        logger.warn('Audio monitor source latency is high', {
          sourceLatencyMs: Number(stats.latencyMs.toFixed(1)),
          bufferFillPercent: Number(stats.bufferFillPercent.toFixed(1)),
          providerAvailableMs: Number(this.audioProvider.getAvailableMs().toFixed(1)),
          outputQueuedMs: Number(((this.outputBuffer.length / this.TARGET_SAMPLE_RATE) * 1000).toFixed(1)),
          emittedFrames,
          sourceSamples: sourceAudioData.length,
          outputSamples: processedAudio.length,
        });
      }

      this.emit('stats', stats);
    } catch (error) {
      logger.error('Push audio failed', error);
    }
  }

  /**
   * Append resampled audio to a small staging buffer so downstream always
   * receives fixed-size 20ms frames even if the native resampler output size
   * varies because of filter warm-up and internal delay.
   */
  private appendToOutputBuffer(samples: Float32Array): void {
    if (samples.length === 0) return;

    if (this.outputBuffer.length === 0) {
      this.outputBuffer = new Float32Array(samples);
      return;
    }

    const merged = new Float32Array(this.outputBuffer.length + samples.length);
    merged.set(this.outputBuffer);
    merged.set(samples, this.outputBuffer.length);
    this.outputBuffer = merged;
  }

  private emitReadyFrames(timestamp: number): number {
    let emittedFrames = 0;

    while (this.outputBuffer.length >= this.OUTPUT_FRAME_SAMPLES) {
      const frame = this.outputBuffer.slice(0, this.OUTPUT_FRAME_SAMPLES);
      this.outputBuffer = this.outputBuffer.slice(this.OUTPUT_FRAME_SAMPLES);

      // 广播音频数据（创建独立副本，避免底层缓冲区复用问题）
      const audioCopy = new Float32Array(frame).buffer;
      this.emit('audioData', {
        audioData: audioCopy,
        sampleRate: this.TARGET_SAMPLE_RATE,
        samples: frame.length,
        timestamp,
        sequence: this.sequenceNumber++,
      });
      emittedFrames++;
    }

    return emittedFrames;
  }

  private resampleChunkLinear(samples: Float32Array, inputRate: number, outputRate: number): Float32Array {
    if (samples.length === 0 || inputRate === outputRate) {
      return samples;
    }

    const outputLength = Math.max(1, Math.round((samples.length * outputRate) / inputRate));
    const output = new Float32Array(outputLength);
    const ratio = inputRate / outputRate;

    for (let i = 0; i < outputLength; i += 1) {
      const sourceIndex = i * ratio;
      const left = Math.floor(sourceIndex);
      const right = Math.min(left + 1, samples.length - 1);
      const fraction = sourceIndex - left;
      const leftSample = samples[left] ?? 0;
      const rightSample = samples[right] ?? leftSample;
      output[i] = leftSample * (1 - fraction) + rightSample * fraction;
    }

    return output;
  }

  /**
   * 计算音频RMS（均方根）
   */
  private calculateRMS(audioData: Float32Array): number {
    if (audioData.length === 0) return 0;

    let sumSquares = 0;
    for (let i = 0; i < audioData.length; i++) {
      sumSquares += audioData[i] * audioData[i];
    }
    return Math.sqrt(sumSquares / audioData.length);
  }

  /**
   * 计算统计信息
   */
  private calculateStats(sampleRate: number, isActive: boolean, audioLevel: number): AudioMonitorStats {
    // 基于目标缓冲区水位计算填充百分比
    const availableMs = this.audioProvider.getAvailableMs();
    const bufferFillPercent = Math.min(100, (availableMs / this.TARGET_BUFFER_MS) * 100);
    const queuedOutputMs = (this.outputBuffer.length / this.TARGET_SAMPLE_RATE) * 1000;
    const latencyMs = availableMs + queuedOutputMs;

    return {
      latencyMs,
      bufferFillPercent,
      isActive,
      audioLevel,
      droppedSamples: this.droppedSamplesCount,
      sampleRate,
    };
  }

  /**
   * 获取服务运行状态
   */
  isServiceRunning(): boolean {
    return this.isRunning;
  }

  getLatestStats(): AudioMonitorStats | null {
    return this.latestStats;
  }

  /**
   * 销毁服务
   */
  /**
   * Pause audio pushing (e.g. during voice TX to prevent echo).
   * The service stays initialized and can be resumed.
   */
  pause(): void {
    if (!this.isRunning) return;
    this.stopPushingAudio();
    logger.info('Audio monitor paused');
  }

  /**
   * Resume audio pushing after pause.
   */
  resume(): void {
    if (this.isRunning) return;
    this.startPushingAudio();
    logger.info('Audio monitor resumed');
  }

  destroy(): void {
    this.stopPushingAudio();
    this.outputBuffer = new Float32Array(0);
    this.latestStats = null;
    this.removeAllListeners();
    logger.info('Service destroyed');
  }
}
