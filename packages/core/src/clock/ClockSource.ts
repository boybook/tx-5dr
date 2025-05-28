/**
 * 时钟源接口 - 提供当前时间戳
 * 支持不同的实现：系统时钟、模拟时钟等
 */
export interface ClockSource {
  /**
   * 获取当前时间戳（毫秒）
   * @returns 当前时间的毫秒时间戳
   */
  now(): number;
  
  /**
   * 获取高精度时间戳（纳秒）
   * 用于精确的时序测量
   */
  hrtime?(): bigint;
  
  /**
   * 时钟源名称，用于调试
   */
  readonly name: string;
} 