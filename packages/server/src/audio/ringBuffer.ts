import { createLogger } from '../utils/logger.js';

const logger = createLogger('RingBuffer');
const OVERFLOW_LOG_INTERVAL_MS = 5000;
const CLOCK_DRIFT_WARNING_THRESHOLD_MS = 250;
const CLOCK_DRIFT_LOG_INTERVAL_MS = 5000;
export type AudioClock = () => number;

/**
 * 环形缓冲区 - 用于存储连续的 PCM 音频数据
 * 支持多线程安全的读写操作
 */
export class RingBuffer {
  private buffer: Float32Array;
  private writeIndex = 0;
  private readIndex = 0;
  private storedSamples = 0;
  private size: number;
  private sampleRate: number;
  private maxDurationMs: number;
  private startTimestamp: number; // 缓冲区开始时间戳
  private totalSamplesWritten = 0; // 总写入样本数
  private lastWriteTimestamp: number; // 最后写入时间戳
  private lastOverflowLogAt = 0;
  private suppressedOverflowSamples = 0;
  private lastClockDriftLogAt = 0;
  private readonly now: AudioClock;
  
  constructor(sampleRate: number, maxDurationMs: number = 60000, now: AudioClock = Date.now) {
    this.sampleRate = sampleRate;
    this.maxDurationMs = maxDurationMs;
    this.now = now;
    this.size = Math.floor((sampleRate * maxDurationMs) / 1000);
    this.buffer = new Float32Array(this.size);
    this.startTimestamp = this.now();
    this.lastWriteTimestamp = this.startTimestamp;
  }
  
  /**
   * 写入音频数据
   * @param samples PCM 样本数据
   */
  write(samples: Float32Array): void {
    const writeTimestamp = this.now();
    let inputOffset = 0;

    if (this.totalSamplesWritten === 0) {
      this.startTimestamp = writeTimestamp;
      this.lastWriteTimestamp = writeTimestamp;
    }

    // 在写入前一次性检查可用空间
    const freeSpace = this.size - this.storedSamples;

    // 如果单次写入超过容量，只保留输入块的最新尾部，并清掉旧内容。
    if (samples.length >= this.size) {
      const droppedSamples = this.storedSamples + samples.length - this.size;
      if (droppedSamples > 0) {
        this.logOverflow(droppedSamples, writeTimestamp);
      }
      inputOffset = samples.length - this.size;
      this.readIndex = this.writeIndex;
      this.storedSamples = 0;
    } else if (samples.length > freeSpace) {
      // 空间不足时丢弃最旧的已存样本，确保新样本保持实时。
      const needToDrop = samples.length - freeSpace;
      this.logOverflow(needToDrop, writeTimestamp);
      this.readIndex = (this.readIndex + needToDrop) % this.size;
      this.storedSamples = Math.max(0, this.storedSamples - needToDrop);
    }

    // 批量写入所有样本
    this.totalSamplesWritten += inputOffset;
    for (let i = inputOffset; i < samples.length; i++) {
      const sample = samples[i] || 0;

      // 检查样本有效性
      if (isNaN(sample) || !isFinite(sample)) {
        // 无效样本，用0替换
        this.buffer[this.writeIndex] = 0;
      } else {
        // 限制样本范围到 [-1, 1]
        const clampedSample = Math.max(-1, Math.min(1, sample));
        this.buffer[this.writeIndex] = clampedSample;
      }

      this.writeIndex = (this.writeIndex + 1) % this.size;
      this.totalSamplesWritten++;
      this.storedSamples = Math.min(this.size, this.storedSamples + 1);
    }

    // 更新最后写入时间（用于计算时间偏移）
    this.lastWriteTimestamp = writeTimestamp;
    this.logClockDriftIfNeeded(writeTimestamp);
  }

  private logOverflow(droppedSamples: number, now: number): void {
    this.suppressedOverflowSamples += droppedSamples;
    if (now - this.lastOverflowLogAt < OVERFLOW_LOG_INTERVAL_MS) {
      return;
    }

    logger.warn('RX/input ring buffer overflow', {
      bufferKind: 'rx-input',
      droppedSamples,
      suppressedDroppedSamples: this.suppressedOverflowSamples - droppedSamples,
      availableSamples: this.getAvailableSamples(),
      capacitySamples: this.size,
      sampleRate: this.sampleRate,
    });
    this.lastOverflowLogAt = now;
    this.suppressedOverflowSamples = 0;
  }

  private getWallClockSamples(now = this.now()): number {
    const elapsedMs = Math.max(0, now - this.startTimestamp);
    return Math.floor((this.sampleRate * elapsedMs) / 1000);
  }

  private getProducerLeadMs(now = this.now()): number {
    if (this.sampleRate <= 0) {
      return 0;
    }
    const wallClockSamples = this.getWallClockSamples(now);
    return ((this.totalSamplesWritten - wallClockSamples) / this.sampleRate) * 1000;
  }

  private logClockDriftIfNeeded(now: number): void {
    const producerLeadMs = this.getProducerLeadMs(now);
    if (Math.abs(producerLeadMs) < CLOCK_DRIFT_WARNING_THRESHOLD_MS) {
      return;
    }
    if (now - this.lastClockDriftLogAt < CLOCK_DRIFT_LOG_INTERVAL_MS) {
      return;
    }

    logger.warn('RX/input audio sample clock drift detected', {
      bufferKind: 'rx-input',
      producerLeadMs: Number(producerLeadMs.toFixed(1)),
      totalSamplesWritten: this.totalSamplesWritten,
      wallClockSamples: this.getWallClockSamples(now),
      availableSamples: this.getAvailableSamples(),
      sampleRate: this.sampleRate,
    });
    this.lastClockDriftLogAt = now;
  }
  
  /**
   * 读取指定时间范围的音频数据
   * @param startMs 开始时间戳（毫秒）
   * @param durationMs 持续时间（毫秒）
   * @returns PCM 音频数据
   */
  read(startMs: number, durationMs: number): ArrayBuffer {
    void startMs;
    return this.readLatest(durationMs);
  }
  
  /**
   * 基于时隙开始时间读取累积音频数据
   * @param slotStartMs 时隙开始时间戳（毫秒）
   * @param durationMs 从时隙开始到现在的累积时长（毫秒）
   * @returns PCM 音频数据
   */
  readFromSlotStart(slotStartMs: number, durationMs: number): ArrayBuffer {
    void slotStartMs;
    return this.readLatest(durationMs);
  }

  private readLatest(durationMs: number): ArrayBuffer {
    const sampleCount = Math.floor((this.sampleRate * Math.max(0, durationMs)) / 1000);
    const result = new Float32Array(sampleCount);

    // 以最新写入位置为窗口结尾读取，避免样本时钟和墙钟漂移导致越读越旧。
    const samplesToRead = Math.min(sampleCount, this.storedSamples);
    const outputOffset = sampleCount - samplesToRead;
    const startIndex = (this.writeIndex - samplesToRead + this.size) % this.size;

    for (let i = 0; i < samplesToRead; i++) {
      const bufferIndex = (startIndex + i) % this.size;
      const value = this.buffer[bufferIndex];
      result[outputOffset + i] = (value !== undefined && !isNaN(value)) ? value : 0;
    }

    return result.buffer;
  }
  
  /**
   * 连续读取音频数据（流式播放专用）
   * 自动推进读指针，确保音频连续
   * @param sampleCount 要读取的样本数
   * @returns PCM 音频数据
   */
  readNext(sampleCount: number): ArrayBuffer {
    const result = new Float32Array(sampleCount);
    const available = this.getAvailableSamples();

    // 读取可用的样本（如果不足，剩余部分填充静音）
    const samplesToRead = Math.min(sampleCount, available);

    for (let i = 0; i < samplesToRead; i++) {
      result[i] = this.buffer[this.readIndex];
      this.readIndex = (this.readIndex + 1) % this.size;
    }
    this.storedSamples = Math.max(0, this.storedSamples - samplesToRead);

    // 如果缓冲区不足，剩余部分填充静音
    for (let i = samplesToRead; i < sampleCount; i++) {
      result[i] = 0;
    }

    return result.buffer;
  }

  /**
   * 获取当前可用的样本数量
   */
  getAvailableSamples(): number {
    return this.storedSamples;
  }
  
  /**
   * 清空缓冲区
   */
  clear(): void {
    this.writeIndex = 0;
    this.readIndex = 0;
    this.storedSamples = 0;
    this.totalSamplesWritten = 0;
    this.buffer.fill(0);
    this.startTimestamp = this.now();
    this.lastWriteTimestamp = this.startTimestamp;
    this.lastOverflowLogAt = 0;
    this.suppressedOverflowSamples = 0;
    this.lastClockDriftLogAt = 0;
  }
  
  /**
   * 获取缓冲区状态信息
   */
  getStatus() {
    const now = this.now();
    const wallClockSamples = this.getWallClockSamples(now);
    const producerLeadMs = this.getProducerLeadMs(now);
    return {
      size: this.size,
      writeIndex: this.writeIndex,
      readIndex: this.readIndex,
      storedSamples: this.storedSamples,
      availableSamples: this.getAvailableSamples(),
      sampleRate: this.sampleRate,
      maxDurationMs: this.maxDurationMs,
      startTimestamp: this.startTimestamp,
      totalSamplesWritten: this.totalSamplesWritten,
      wallClockSamples,
      producerLeadMs,
      uptimeMs: now - this.startTimestamp
    };
  }
}
