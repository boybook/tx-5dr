/* eslint-disable @typescript-eslint/no-explicit-any */
// EventTracer - 事件追踪需要使用any

/**
 * EventTracer - 事件追踪工具
 *
 * 用于开发环境的事件流可视化和性能分析
 * - 追踪事件传播路径
 * - 记录事件时序
 * - 识别性能瓶颈
 * - 检测事件循环
 * - 统计事件频率
 *
 * 使用方式:
 * ```typescript
 * const tracer = new EventTracer({ enabled: true });
 * tracer.attach(eventEmitter, 'DigitalRadioEngine');
 * tracer.printReport();
 * ```
 */

import EventEmitter from 'eventemitter3';
import { createLogger } from './logger.js';

const logger = createLogger('EventTracer');

/**
 * 事件追踪记录
 */
export interface EventTrace {
  /**
   * 事件名称
   */
  eventName: string;

  /**
   * 发射者名称
   */
  emitterName: string;

  /**
   * 时间戳
   */
  timestamp: number;

  /**
   * 数据大小（估算，字节）
   */
  dataSize?: number;

  /**
   * 监听器数量
   */
  listenerCount: number;

  /**
   * 调用栈（前3层）
   */
  stack?: string[];

  /**
   * 执行耗时（毫秒）
   */
  duration?: number;
}

/**
 * 事件统计信息
 */
export interface EventStats {
  /**
   * 事件名称
   */
  eventName: string;

  /**
   * 触发次数
   */
  count: number;

  /**
   * 总耗时（毫秒）
   */
  totalDuration: number;

  /**
   * 平均耗时（毫秒）
   */
  averageDuration: number;

  /**
   * 最大耗时（毫秒）
   */
  maxDuration: number;

  /**
   * 最小耗时（毫秒）
   */
  minDuration: number;

  /**
   * 平均数据大小（字节）
   */
  averageDataSize: number;

  /**
   * 频率（次/秒）
   */
  frequency: number;
}

/**
 * EventTracer 配置
 */
export interface EventTracerOptions {
  /**
   * 是否启用追踪
   * @default false
   */
  enabled?: boolean;

  /**
   * 最大追踪记录数量
   * @default 1000
   */
  maxTraces?: number;

  /**
   * 是否记录调用栈
   * @default false
   */
  captureStack?: boolean;

  /**
   * 是否自动打印报告
   * @default false
   */
  autoPrintReport?: boolean;

  /**
   * 自动打印报告间隔（毫秒）
   * @default 60000 (1分钟)
   */
  autoPrintInterval?: number;

  /**
   * 事件过滤器（返回true表示追踪该事件）
   */
  filter?: (eventName: string, emitterName: string) => boolean;

  /**
   * 警告阈值：事件耗时超过此值时警告（毫秒）
   * @default 100
   */
  slowEventThreshold?: number;

  /**
   * 警告阈值：事件频率超过此值时警告（次/秒）
   * @default 50
   */
  highFrequencyThreshold?: number;
}

/**
 * EventTracer 类
 */
export class EventTracer {
  private enabled: boolean;
  private maxTraces: number;
  private captureStack: boolean;
  private autoPrintReport: boolean;
  private autoPrintInterval: number;
  private filter?: (eventName: string, emitterName: string) => boolean;
  private slowEventThreshold: number;
  private highFrequencyThreshold: number;

  private traces: EventTrace[] = [];
  private attachedEmitters: Map<EventEmitter, string> = new Map();
  private originalEmitFunctions: Map<EventEmitter, Function> = new Map();
  private autoPrintTimer?: NodeJS.Timeout;

  constructor(options: EventTracerOptions = {}) {
    this.enabled = options.enabled ?? false;
    this.maxTraces = options.maxTraces ?? 1000;
    this.captureStack = options.captureStack ?? false;
    this.autoPrintReport = options.autoPrintReport ?? false;
    this.autoPrintInterval = options.autoPrintInterval ?? 60000;
    this.filter = options.filter;
    this.slowEventThreshold = options.slowEventThreshold ?? 100;
    this.highFrequencyThreshold = options.highFrequencyThreshold ?? 50;

    if (this.autoPrintReport) {
      this.startAutoPrint();
    }
  }

  /**
   * 附加到 EventEmitter 实例
   */
  attach(emitter: EventEmitter, emitterName: string): void {
    if (!this.enabled) return;
    if (this.attachedEmitters.has(emitter)) return;

    this.attachedEmitters.set(emitter, emitterName);

    // 保存原始 emit 函数
    const originalEmit = emitter.emit.bind(emitter);
    this.originalEmitFunctions.set(emitter, originalEmit);

    // 包装 emit 函数
    emitter.emit = (eventName: string | symbol, ...args: any[]): boolean => {
      // 将 symbol 转换为字符串用于过滤和记录
      const eventNameStr = typeof eventName === 'symbol'
        ? eventName.toString()
        : eventName;

      // 检查过滤器
      if (this.filter && !this.filter(eventNameStr, emitterName)) {
        return originalEmit(eventName, ...args);
      }

      const startTime = performance.now();
      const listenerCount = emitter.listenerCount(eventName);

      // 估算数据大小
      let dataSize: number | undefined;
      try {
        dataSize = JSON.stringify(args).length;
      } catch {
        dataSize = undefined;
      }

      // 捕获调用栈
      let stack: string[] | undefined;
      if (this.captureStack) {
        const error = new Error();
        const stackLines = error.stack?.split('\n').slice(2, 5) || [];
        stack = stackLines.map((line) => line.trim());
      }

      // 执行原始 emit
      const result = originalEmit(eventName, ...args);

      const endTime = performance.now();
      const duration = endTime - startTime;

      // 记录追踪（使用字符串版本）
      this.recordTrace({
        eventName: eventNameStr,
        emitterName,
        timestamp: Date.now(),
        dataSize,
        listenerCount,
        stack,
        duration,
      });

      // Slow event warning
      if (duration > this.slowEventThreshold) {
        logger.warn(
          `Slow event: ${emitterName}.${eventNameStr} (${duration.toFixed(2)}ms)`
        );
      }

      return result;
    };

    logger.debug(`Attached to: ${emitterName}`);
  }

  /**
   * 从 EventEmitter 实例解除附加
   */
  detach(emitter: EventEmitter): void {
    const originalEmit = this.originalEmitFunctions.get(emitter);
    if (originalEmit) {
      emitter.emit = originalEmit as any;
      this.originalEmitFunctions.delete(emitter);
      this.attachedEmitters.delete(emitter);
    }
  }

  /**
   * 解除所有附加
   */
  detachAll(): void {
    for (const emitter of this.attachedEmitters.keys()) {
      this.detach(emitter);
    }
  }

  /**
   * 记录追踪
   */
  private recordTrace(trace: EventTrace): void {
    this.traces.push(trace);

    // 限制追踪记录数量
    if (this.traces.length > this.maxTraces) {
      this.traces.shift();
    }
  }

  /**
   * 获取所有追踪记录
   */
  getTraces(): EventTrace[] {
    return [...this.traces];
  }

  /**
   * 清除所有追踪记录
   */
  clearTraces(): void {
    this.traces = [];
    logger.debug('All traces cleared');
  }

  /**
   * 计算事件统计信息
   */
  calculateStats(): EventStats[] {
    const statsMap = new Map<string, EventStats>();

    const now = Date.now();
    const oneSecondAgo = now - 1000;

    for (const trace of this.traces) {
      const key = `${trace.emitterName}.${trace.eventName}`;
      let stats = statsMap.get(key);

      if (!stats) {
        stats = {
          eventName: key,
          count: 0,
          totalDuration: 0,
          averageDuration: 0,
          maxDuration: 0,
          minDuration: Infinity,
          averageDataSize: 0,
          frequency: 0,
        };
        statsMap.set(key, stats);
      }

      stats.count += 1;
      stats.totalDuration += trace.duration || 0;
      stats.maxDuration = Math.max(stats.maxDuration, trace.duration || 0);
      stats.minDuration = Math.min(stats.minDuration, trace.duration || Infinity);

      // 计算最近1秒的频率
      if (trace.timestamp >= oneSecondAgo) {
        stats.frequency += 1;
      }
    }

    // 计算平均值
    for (const stats of statsMap.values()) {
      stats.averageDuration = stats.totalDuration / stats.count;
      stats.minDuration = stats.minDuration === Infinity ? 0 : stats.minDuration;

      const tracesForEvent = this.traces.filter(
        (t) => `${t.emitterName}.${t.eventName}` === stats.eventName
      );
      const totalDataSize = tracesForEvent.reduce(
        (sum, t) => sum + (t.dataSize || 0),
        0
      );
      stats.averageDataSize = totalDataSize / tracesForEvent.length;
    }

    return Array.from(statsMap.values()).sort((a, b) => b.count - a.count);
  }

  /**
   * 打印统计报告
   */
  printReport(): void {
    const stats = this.calculateStats();

    logger.debug(`===== EventTracer stats report =====`);
    logger.debug(`Total traces: ${this.traces.length}`);
    logger.debug(`Attached emitters: ${this.attachedEmitters.size}`);

    logger.debug('Event stats (sorted by count):');
    console.table(
      stats.map((s) => ({
        event: s.eventName,
        count: s.count,
        frequency: `${s.frequency.toFixed(1)}/s`,
        avgDuration: `${s.averageDuration.toFixed(2)}ms`,
        maxDuration: `${s.maxDuration.toFixed(2)}ms`,
        avgData: `${(s.averageDataSize / 1024).toFixed(2)}KB`,
      }))
    );

    // High-frequency event warnings
    const highFrequencyEvents = stats.filter(
      (s) => s.frequency > this.highFrequencyThreshold
    );
    if (highFrequencyEvents.length > 0) {
      logger.warn('High-frequency events (above threshold):');
      for (const event of highFrequencyEvents) {
        logger.warn(
          `  - ${event.eventName}: ${event.frequency.toFixed(1)}/s (threshold: ${this.highFrequencyThreshold}/s)`
        );
      }
    }

    // Slow event warnings
    const slowEvents = stats.filter(
      (s) => s.averageDuration > this.slowEventThreshold
    );
    if (slowEvents.length > 0) {
      logger.warn('Slow events (avg duration above threshold):');
      for (const event of slowEvents) {
        logger.warn(
          `  - ${event.eventName}: ${event.averageDuration.toFixed(2)}ms (threshold: ${this.slowEventThreshold}ms)`
        );
      }
    }

    logger.debug('========================================');
  }

  /**
   * 启动自动打印报告
   */
  private startAutoPrint(): void {
    if (this.autoPrintTimer) return;

    this.autoPrintTimer = setInterval(() => {
      this.printReport();
    }, this.autoPrintInterval);

    logger.debug(`Auto report started (interval: ${this.autoPrintInterval / 1000}s)`);
  }

  /**
   * 停止自动打印报告
   */
  stopAutoPrint(): void {
    if (this.autoPrintTimer) {
      clearInterval(this.autoPrintTimer);
      this.autoPrintTimer = undefined;
      logger.debug('Auto report stopped');
    }
  }

  /**
   * 销毁追踪器
   */
  destroy(): void {
    this.detachAll();
    this.stopAutoPrint();
    this.clearTraces();
    logger.debug('EventTracer destroyed');
  }

  /**
   * 启用追踪
   */
  enable(): void {
    this.enabled = true;
    logger.debug('EventTracer enabled');
  }

  /**
   * 禁用追踪
   */
  disable(): void {
    this.enabled = false;
    logger.debug('EventTracer disabled');
  }
}

/**
 * 全局 EventTracer 实例（仅开发环境）
 */
let globalTracer: EventTracer | null = null;

/**
 * 获取全局 EventTracer 实例
 */
export function getGlobalEventTracer(): EventTracer | null {
  return globalTracer;
}

/**
 * 初始化全局 EventTracer
 */
export function initializeGlobalEventTracer(
  options: EventTracerOptions = {}
): EventTracer {
  if (globalTracer) {
    logger.warn('Global EventTracer instance already exists, skipping init');
    return globalTracer;
  }

  globalTracer = new EventTracer({
    enabled: process.env.NODE_ENV === 'development',
    autoPrintReport: true,
    autoPrintInterval: 60000, // 1分钟
    ...options,
  });

  logger.debug('Global EventTracer instance initialized');
  return globalTracer;
}

/**
 * 销毁全局 EventTracer
 */
export function destroyGlobalEventTracer(): void {
  if (globalTracer) {
    globalTracer.destroy();
    globalTracer = null;
  }
}
