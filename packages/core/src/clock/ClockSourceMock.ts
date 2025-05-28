import type { ClockSource } from './ClockSource.js';

/**
 * 模拟时钟源 - 用于测试
 * 允许手动控制时间流逝
 */
export class ClockSourceMock implements ClockSource {
  public readonly name = 'mock';
  
  private currentTime: number;
  private currentHrtime: bigint;
  
  constructor(initialTime: number = Date.now()) {
    this.currentTime = initialTime;
    this.currentHrtime = BigInt(initialTime * 1_000_000);
  }
  
  now(): number {
    return this.currentTime;
  }
  
  hrtime(): bigint {
    return this.currentHrtime;
  }
  
  /**
   * 手动推进时间
   * @param deltaMs 推进的毫秒数
   */
  advance(deltaMs: number): void {
    this.currentTime += deltaMs;
    this.currentHrtime += BigInt(deltaMs * 1_000_000);
  }
  
  /**
   * 设置绝对时间
   * @param timeMs 新的时间戳（毫秒）
   */
  setTime(timeMs: number): void {
    this.currentTime = timeMs;
    this.currentHrtime = BigInt(timeMs * 1_000_000);
  }
  
  /**
   * 重置到指定时间
   * @param timeMs 重置的时间戳，默认为当前系统时间
   */
  reset(timeMs: number = Date.now()): void {
    this.setTime(timeMs);
  }
} 