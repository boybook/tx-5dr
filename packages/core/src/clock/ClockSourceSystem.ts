import type { ClockSource } from './ClockSource.js';

/**
 * 系统时钟源实现
 * 使用系统时间作为基准，配合校准偏移
 */
export class ClockSourceSystem implements ClockSource {
  public readonly name = 'system';

  private calibrationOffsetMs: number = 0;

  constructor() {
    // 不再保存固定快照，直接使用当前系统时间
  }

  setCalibrationOffsetMs(offsetMs: number): void {
    this.calibrationOffsetMs = offsetMs;
  }

  getCalibrationOffsetMs(): number {
    return this.calibrationOffsetMs;
  }
  
  now(): number {
    return Date.now() + this.calibrationOffsetMs;
  }
  
  hrtime(): bigint {
    if (typeof process !== 'undefined' && process.hrtime?.bigint) {
      return process.hrtime.bigint();
    } else {
      return BigInt(Math.floor(performance.now() * 1_000_000));
    }
  }
}