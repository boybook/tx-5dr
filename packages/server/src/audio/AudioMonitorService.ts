import { EventEmitter } from 'eventemitter3';
import { RingBufferAudioProvider } from './AudioBufferProvider.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('AudioMonitorService');

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
 * - 统一采样率：固定48kHz输出（浏览器标准采样率）
 * - 客户端音量：音量控制在客户端AudioWorklet中实现
 */
export class AudioMonitorService extends EventEmitter<AudioMonitorServiceEvents> {
  private audioProvider: RingBufferAudioProvider;
  private pushInterval: NodeJS.Timeout | null = null;
  private readonly CHECK_INTERVAL_MS = 10;      // 检查间隔：10ms（高频检查）
  private readonly TARGET_BUFFER_MS = 40;       // 目标缓冲区水位：40ms（小块高频发送）
  private readonly TARGET_CHUNK_MS = 20;        // 目标发送块大小：20ms（VoIP标准帧大小）
  private readonly TARGET_SAMPLE_RATE = 48000;  // 目标采样率：48kHz（浏览器标准）

  // 统计信息
  private lastPushTimestamp = 0;
  private droppedSamplesCount = 0;
  private isRunning = false;
  private sequenceNumber = 0;
  private lastPushStartTime = 0;

  constructor(audioProvider: RingBufferAudioProvider) {
    super();
    this.audioProvider = audioProvider;
    logger.info('Audio monitor service initialized (broadcast mode)');

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
    this.lastPushTimestamp = Date.now();
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
  private checkAndPush(): void {
    try {
      // 检查缓冲区是否达到目标水位
      const availableMs = this.audioProvider.getAvailableMs();

      if (availableMs < this.TARGET_BUFFER_MS) {
        // 缓冲区未满，等待累积
        return;
      }

      // 执行推送
      this.pushAudioChunk();
    } catch (error) {
      logger.error('Check and push failed', error);
    }
  }

  /**
   * 推送音频数据块
   */
  private pushAudioChunk(): void {
    try {
      const t0 = performance.now();
      const now = Date.now();

      // 计算需要读取的样本数
      const sourceSampleRate = this.audioProvider.getSampleRate();
      const sourceSampleCount = Math.floor((sourceSampleRate * this.TARGET_CHUNK_MS) / 1000);

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

      // Resample to target sample rate using stateless linear interpolation.
      // This is intentionally simple: AudioMonitorService processes small 20ms
      // chunks for real-time streaming, which is incompatible with FFT-based
      // resamplers (warm-up latency, large internal buffers). Linear interpolation
      // is adequate for monitoring/preview audio quality.
      let processedAudio = sourceAudioData;
      if (this.TARGET_SAMPLE_RATE !== sourceSampleRate) {
        processedAudio = this.resampleLinear(sourceAudioData, sourceSampleRate, this.TARGET_SAMPLE_RATE);
      }
      const t1 = performance.now();

      if (processedAudio.length === 0) {
        return;
      }

      // 广播音频数据（创建独立副本，避免底层缓冲区复用问题）
      const audioCopy = new Float32Array(processedAudio).buffer;
      this.emit('audioData', {
        audioData: audioCopy,
        sampleRate: this.TARGET_SAMPLE_RATE,
        samples: processedAudio.length,
        timestamp: now,
        sequence: this.sequenceNumber++,
      });

      // 每秒输出一次统计日志
      if (this.sequenceNumber % 50 === 0) {
        const availableMs = this.audioProvider.getAvailableMs();
        const pushInterval = this.lastPushStartTime > 0 ? t0 - this.lastPushStartTime : 0;

        logger.debug(
          `seq=${this.sequenceNumber}, buffer=${availableMs.toFixed(1)}ms, ` +
          `samples=${processedAudio.length}, interval=${pushInterval.toFixed(1)}ms, ` +
          `process=${(t1-t0).toFixed(1)}ms`
        );

        const stats = this.calculateStats(this.TARGET_SAMPLE_RATE, isActive, rms);
        this.emit('stats', stats);
      }

      this.lastPushStartTime = t0;
      this.lastPushTimestamp = now;
    } catch (error) {
      logger.error('Push audio failed', error);
    }
  }

  /**
   * Stateless linear-interpolation resampler for small streaming chunks.
   * Produces exactly floor(inputLength * outputRate / inputRate) samples per call
   * with zero warm-up, zero internal state, and no cross-chunk artifacts.
   */
  private resampleLinear(
    samples: Float32Array,
    inputRate: number,
    outputRate: number
  ): Float32Array {
    const ratio = inputRate / outputRate; // e.g. 12000/48000 = 0.25
    const outputLength = Math.floor(samples.length / ratio);
    const result = new Float32Array(outputLength);

    for (let i = 0; i < outputLength; i++) {
      const srcPos = i * ratio;
      const idx = Math.floor(srcPos);
      const frac = srcPos - idx;
      const s0 = samples[idx] ?? 0;
      const s1 = samples[Math.min(idx + 1, samples.length - 1)] ?? 0;
      result[i] = s0 + (s1 - s0) * frac;
    }

    return result;
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
    const now = Date.now();
    const latencyMs = now - this.lastPushTimestamp;

    // 基于目标缓冲区水位计算填充百分比
    const availableMs = this.audioProvider.getAvailableMs();
    const bufferFillPercent = Math.min(100, (availableMs / this.TARGET_BUFFER_MS) * 100);

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
    this.removeAllListeners();
    logger.info('Service destroyed');
  }
}
