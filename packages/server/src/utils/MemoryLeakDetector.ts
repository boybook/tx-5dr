/* eslint-disable @typescript-eslint/no-explicit-any */
// MemoryLeakDetector - 资源跟踪需要使用any

import type EventEmitter from 'eventemitter3';
import { createLogger } from './logger.js';

const logger = createLogger('MemoryLeakDetector');

/**
 * 内存泄漏检测器
 * 监控 EventEmitter 的监听器数量,检测潜在的内存泄漏
 */
export class MemoryLeakDetector {
  private static instance: MemoryLeakDetector | null = null;
  private monitoredEmitters: Map<string, { emitter: EventEmitter<any>; baseline: Map<string, number> }> = new Map();
  private checkInterval: NodeJS.Timeout | null = null;
  private isEnabled: boolean = false;

  /**
   * 监听器数量阈值警告配置
   */
  private readonly WARNING_THRESHOLD = 10; // 单个事件监听器数量超过此值发出警告
  private readonly CHECK_INTERVAL_MS = 30000; // 检查间隔: 30秒

  private constructor() {
    // Listener snapshots are expensive and very noisy. Keep them opt-in so
    // realtime audio diagnostics are not hidden by hundreds of debug lines.
    this.isEnabled = process.env.TX5DR_LEAK_DETECTOR === '1';

    if (this.isEnabled) {
      logger.info('MemoryLeakDetector enabled');
      this.startMonitoring();
    }
  }

  /**
   * 获取单例实例
   */
  static getInstance(): MemoryLeakDetector {
    if (!MemoryLeakDetector.instance) {
      MemoryLeakDetector.instance = new MemoryLeakDetector();
    }
    return MemoryLeakDetector.instance;
  }

  /**
   * 注册需要监控的 EventEmitter
   * @param name 标识名称,用于日志输出
   * @param emitter EventEmitter 实例
   */
  register(name: string, emitter: EventEmitter<any>): void {
    if (!this.isEnabled) return;

    // 记录当前的基线监听器数量
    const baseline = this.getListenerCounts(emitter);

    this.monitoredEmitters.set(name, { emitter, baseline });
  }

  /**
   * 取消注册
   * @param name 标识名称
   */
  unregister(name: string): void {
    if (!this.isEnabled) return;

    this.monitoredEmitters.delete(name);
  }

  /**
   * 开始监控
   */
  private startMonitoring(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }

    this.checkInterval = setInterval(() => {
      this.checkForLeaks();
    }, this.CHECK_INTERVAL_MS);

    logger.debug(`Monitoring started, check interval: ${this.CHECK_INTERVAL_MS / 1000}s`);
  }

  /**
   * 停止监控
   */
  stopMonitoring(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  /**
   * 检查是否存在内存泄漏
   */
  private checkForLeaks(): void {
    if (this.monitoredEmitters.size === 0) {
      return;
    }

    for (const [name, { emitter, baseline }] of this.monitoredEmitters.entries()) {
      const current = this.getListenerCounts(emitter);
      const changes = this.compareListenerCounts(baseline, current);

      if (changes.warnings.length > 0) {
        this.reportChanges(name, current, changes);
      }
    }
  }

  /**
   * 获取 EventEmitter 的所有事件监听器数量
   */
  private getListenerCounts(emitter: EventEmitter<any>): Map<string, number> {
    const counts = new Map<string, number>();

    // EventEmitter3 提供 eventNames() 方法获取所有事件名
    const eventNames = emitter.eventNames();

    for (const eventName of eventNames) {
      const listeners = emitter.listeners(eventName as string);
      counts.set(String(eventName), listeners.length);
    }

    return counts;
  }

  /**
   * 比较监听器数量变化
   */
  private compareListenerCounts(
    baseline: Map<string, number>,
    current: Map<string, number>
  ): { hasChanges: boolean; increased: Map<string, { from: number; to: number }>; decreased: Map<string, { from: number; to: number }>; warnings: string[] } {
    const increased = new Map<string, { from: number; to: number }>();
    const decreased = new Map<string, { from: number; to: number }>();
    const warnings: string[] = [];

    // 检查增加的监听器
    for (const [eventName, currentCount] of current.entries()) {
      const baselineCount = baseline.get(eventName) || 0;

      if (currentCount > baselineCount) {
        increased.set(eventName, { from: baselineCount, to: currentCount });

        // 检查是否超过警告阈值
        if (currentCount > this.WARNING_THRESHOLD) {
          warnings.push(`Event "${eventName}" listener count exceeds threshold (${currentCount} > ${this.WARNING_THRESHOLD})`);
        }
      } else if (currentCount < baselineCount) {
        decreased.set(eventName, { from: baselineCount, to: currentCount });
      }
    }

    // 检查已删除的事件(存在于baseline但不在current中)
    for (const [eventName, baselineCount] of baseline.entries()) {
      if (!current.has(eventName)) {
        decreased.set(eventName, { from: baselineCount, to: 0 });
      }
    }

    return {
      hasChanges: increased.size > 0 || decreased.size > 0,
      increased,
      decreased,
      warnings
    };
  }

  /**
   * 报告监听器数量变化
   */
  private reportChanges(
    name: string,
    current: Map<string, number>,
    changes: { increased: Map<string, { from: number; to: number }>; decreased: Map<string, { from: number; to: number }>; warnings: string[] }
  ): void {
    logger.warn('Event listener count threshold exceeded', {
      emitter: name,
      warnings: changes.warnings,
      total: this.getTotalListenerCount(current),
      topEvents: this.getTopListenerCounts(current, 8),
    });
  }

  private getTotalListenerCount(counts: Map<string, number>): number {
    return Array.from(counts.values()).reduce((sum, count) => sum + count, 0);
  }

  private getTopListenerCounts(counts: Map<string, number>, limit: number): Array<{ event: string; count: number }> {
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([event, count]) => ({ event, count }));
  }

  /**
   * 手动触发检查(用于测试)
   */
  checkNow(): void {
    if (!this.isEnabled) {
      logger.info('MemoryLeakDetector not enabled');
      return;
    }
    this.checkForLeaks();
  }

  /**
   * 获取当前监控状态快照
   */
  getSnapshot(): { name: string; baseline: Map<string, number>; current: Map<string, number> }[] {
    const snapshot: { name: string; baseline: Map<string, number>; current: Map<string, number> }[] = [];

    for (const [name, { emitter, baseline }] of this.monitoredEmitters.entries()) {
      const current = this.getListenerCounts(emitter);
      snapshot.push({ name, baseline, current });
    }

    return snapshot;
  }

  /**
   * 销毁检测器
   */
  destroy(): void {
    this.stopMonitoring();
    this.monitoredEmitters.clear();
  }
}

/**
 * 便捷方法:注册 EventEmitter 到内存泄漏检测器
 */
export function registerForLeakDetection(name: string, emitter: EventEmitter<any>): void {
  MemoryLeakDetector.getInstance().register(name, emitter);
}

/**
 * 便捷方法:取消注册
 */
export function unregisterFromLeakDetection(name: string): void {
  MemoryLeakDetector.getInstance().unregister(name);
}
