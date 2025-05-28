import type { ClockSource } from './ClockSource.js';

/**
 * 系统时钟源实现
 * 使用 Date.now() + process.hrtime() 提供高精度时间
 */
export class ClockSourceSystem implements ClockSource {
  public readonly name = 'system';
  
  private readonly startTime: number;
  private readonly startHrtime: bigint;
  
  constructor() {
    this.startTime = Date.now();
    // 在 Node.js 环境中使用 process.hrtime.bigint()
    // 在浏览器环境中使用 performance.now()
    this.startHrtime = typeof process !== 'undefined' && process.hrtime?.bigint
      ? process.hrtime.bigint()
      : BigInt(Math.floor(performance.now() * 1_000_000));
  }
  
  now(): number {
    if (typeof process !== 'undefined' && process.hrtime?.bigint) {
      // Node.js 环境：使用高精度时间
      const hrNow = process.hrtime.bigint();
      const elapsedNs = hrNow - this.startHrtime;
      const elapsedMs = Number(elapsedNs) / 1_000_000;
      return this.startTime + elapsedMs;
    } else {
      // 浏览器环境：使用 performance.now()
      const perfNow = performance.now();
      return this.startTime + perfNow;
    }
  }
  
  hrtime(): bigint {
    if (typeof process !== 'undefined' && process.hrtime?.bigint) {
      return process.hrtime.bigint();
    } else {
      // 浏览器环境的近似实现
      return BigInt(Math.floor(performance.now() * 1_000_000));
    }
  }
} 