import type { AudioBufferProvider } from '@tx5dr/core';
import { RingBuffer, type AudioClock } from './ringBuffer.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('AudioBufferProvider');

/**
 * 基于环形缓冲区的音频缓冲区提供者实现
 */
export class RingBufferAudioProvider implements AudioBufferProvider {
  private ringBuffer: RingBuffer;
  private startTime: number;
  private sampleRate: number;
  private maxDurationMs: number;
  private readonly now: AudioClock;

  constructor(sampleRate: number = 12000, maxDurationMs: number = 60000, now: AudioClock = Date.now) {
    this.sampleRate = sampleRate;
    this.maxDurationMs = maxDurationMs;
    this.now = now;
    this.ringBuffer = new RingBuffer(sampleRate, maxDurationMs, this.now);
    this.startTime = this.now();
  }
  
  /**
   * 获取当前采样率
   */
  getSampleRate(): number {
    return this.sampleRate;
  }

  getCurrentTimeMs(): number {
    return this.now();
  }

  /**
   * Rebuilds the backing ring buffer when the unified RX processing rate changes.
   * Existing samples are intentionally dropped so consumers never mix rates.
   */
  setSampleRate(sampleRate: number, maxDurationMs = this.maxDurationMs): void {
    if (this.sampleRate === sampleRate && this.maxDurationMs === maxDurationMs) {
      return;
    }
    this.sampleRate = sampleRate;
    this.maxDurationMs = maxDurationMs;
    this.ringBuffer = new RingBuffer(sampleRate, maxDurationMs, this.now);
    this.startTime = this.now();
  }
  
  /**
   * 获取指定时间范围的音频数据
   */
  async getBuffer(startMs: number, durationMs: number): Promise<ArrayBuffer> {
    // 计算从时隙开始时间到现在的时间差
    const currentTime = this.now();
    const timeSinceSlotStart = currentTime - startMs;
    if (timeSinceSlotStart < 0) {
      logger.warn('requested audio buffer starts in the future', {
        startMs,
        currentTime,
        earlyByMs: Math.abs(timeSinceSlotStart),
        durationMs,
      });
    }
    
    // 对于完整时隙请求，确保有足够的时间已经过去
    if (durationMs >= 10000) { // 如果请求的是长时间数据（如完整时隙）
      if (timeSinceSlotStart < durationMs) {
        // 对于完整时隙，我们需要等待足够的时间
        const actualDurationMs = Math.max(0, Math.min(durationMs, timeSinceSlotStart));
        return this.ringBuffer.readFromSlotStart(startMs, actualDurationMs);
      }
    }
    
    // 确保不会读取超过实际可用的数据
    const actualDurationMs = Math.max(0, Math.min(durationMs, timeSinceSlotStart));

    return this.ringBuffer.readFromSlotStart(startMs, actualDurationMs);
  }
  
  /**
   * 写入音频数据到缓冲区
   */
  writeAudio(samples: Float32Array): void {
    this.ringBuffer.write(samples);
  }
  
  /**
   * 获取缓冲区状态
   */
  getStatus() {
    return {
      ...this.ringBuffer.getStatus(),
      startTime: this.startTime,
      uptime: this.now() - this.startTime,
      sampleRate: this.sampleRate
    };
  }

  /**
   * 获取当前可用的音频数据时长（毫秒）
   */
  getAvailableMs(): number {
    const availableSamples = this.ringBuffer.getAvailableSamples();
    return (availableSamples / this.sampleRate) * 1000;
  }

  /**
   * 检查是否有足够的音频数据可供读取
   * @param durationMs 需要的时长（毫秒）
   * @returns 是否有足够数据
   */
  hasEnoughData(durationMs: number): boolean {
    return this.getAvailableMs() >= durationMs;
  }

  /**
   * 读取下一段连续音频数据（流式播放专用）
   * 自动推进读指针，确保音频连续
   * @param sampleCount 要读取的样本数
   * @returns PCM 音频数据
   */
  readNextChunk(sampleCount: number): ArrayBuffer {
    return this.ringBuffer.readNext(sampleCount);
  }

  /**
   * 清空缓冲区
   */
  clear(): void {
    this.ringBuffer.clear();
    this.startTime = this.now();
  }
}
