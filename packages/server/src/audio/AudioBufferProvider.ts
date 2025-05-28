import type { AudioBufferProvider } from '@tx5dr/core';
import { RingBuffer } from './ringBuffer.js';

/**
 * 基于环形缓冲区的音频缓冲区提供者实现
 */
export class RingBufferAudioProvider implements AudioBufferProvider {
  private ringBuffer: RingBuffer;
  private startTime: number;
  private sampleRate: number;
  
  constructor(sampleRate: number = 48000, maxDurationMs: number = 60000) {
    this.sampleRate = sampleRate;
    this.ringBuffer = new RingBuffer(sampleRate, maxDurationMs);
    this.startTime = Date.now();
  }
  
  /**
   * 获取当前采样率
   */
  getSampleRate(): number {
    return this.sampleRate;
  }
  
  /**
   * 获取指定时间范围的音频数据
   */
  async getBuffer(startMs: number, durationMs: number): Promise<ArrayBuffer> {
    // 计算从时隙开始时间到现在的时间差
    const currentTime = Date.now();
    const timeSinceSlotStart = currentTime - startMs;
    
    // 对于完整时隙请求，确保有足够的时间已经过去
    if (durationMs >= 10000) { // 如果请求的是长时间数据（如完整时隙）
      if (timeSinceSlotStart < durationMs) {
        console.log(`⏳ [AudioBufferProvider] 等待完整时隙数据: 需要=${durationMs}ms, 已过去=${timeSinceSlotStart}ms`);
        // 对于完整时隙，我们需要等待足够的时间
        const actualDurationMs = Math.min(durationMs, timeSinceSlotStart);
        return this.ringBuffer.readFromSlotStart(startMs, actualDurationMs);
      }
    }
    
    // 确保不会读取超过实际可用的数据
    const actualDurationMs = Math.min(durationMs, timeSinceSlotStart);
    
    // console.log(`📖 [AudioBufferProvider] 读取音频数据: 时隙开始=${new Date(startMs).toISOString()}, 请求时长=${durationMs}ms, 实际时长=${actualDurationMs}ms`);
    
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
      uptime: Date.now() - this.startTime,
      sampleRate: this.sampleRate
    };
  }
  
  /**
   * 清空缓冲区
   */
  clear(): void {
    this.ringBuffer.clear();
    this.startTime = Date.now();
  }
} 