/* eslint-disable @typescript-eslint/no-explicit-any */
// EventBus - 事件系统需要使用any以支持动态类型

/**
 * EventBus - 全局事件总线
 *
 * 用于减少高频事件的转发层级，提升性能
 * 支持事件聚合、限流、追踪等高级功能
 */

import { EventEmitter } from 'eventemitter3';
import type { MeterData } from '@tx5dr/contracts';
import { createLogger } from './logger.js';

const logger = createLogger('EventBus');

/**
 * 事件总线支持的事件类型
 */
export interface EventBusEvents {
  // 高频事件（直接路由到 WSServer）
  'bus:meterData': (data: MeterData) => void;

  // 聚合事件
  'bus:radioStatusChanged': (status: any) => void;
}

/**
 * 事件统计信息
 */
interface EventStats {
  eventName: string;
  count: number;
  lastEmitTime: number;
  avgInterval: number; // 平均间隔（ms）
}

/**
 * 事件总线配置
 */
export interface EventBusConfig {
  /**
   * 是否启用事件追踪（仅开发环境）
   */
  enableTracing?: boolean;

  /**
   * 是否启用事件统计
   */
  enableStats?: boolean;

  /**
   * 事件限流配置（防止过载）
   */
  rateLimits?: {
    [eventName: string]: {
      maxPerSecond: number;
    };
  };
}

/**
 * 全局事件总线单例
 */
export class EventBus extends EventEmitter<EventBusEvents> {
  private static instance: EventBus | null = null;

  /**
   * 事件统计
   */
  private eventStats: Map<string, EventStats> = new Map();

  /**
   * 配置
   */
  private config: EventBusConfig;

  /**
   * 限流状态（记录每秒发射次数）
   */
  private rateLimitState: Map<string, { count: number; resetTime: number }> = new Map();

  private constructor(config: EventBusConfig = {}) {
    super();
    this.config = {
      enableTracing: process.env.NODE_ENV === 'development',
      enableStats: true,
      ...config,
    };

    if (this.config.enableTracing) {
      logger.debug('EventBus initialized (tracing enabled)');
    }
  }

  /**
   * 获取事件总线单例
   */
  static getInstance(config?: EventBusConfig): EventBus {
    if (!EventBus.instance) {
      EventBus.instance = new EventBus(config);
    }
    return EventBus.instance;
  }

  /**
   * 重置单例（仅用于测试）
   */
  static resetInstance(): void {
    if (EventBus.instance) {
      EventBus.instance.removeAllListeners();
      EventBus.instance = null;
    }
  }

  /**
   * 发射事件（带限流和统计）
   */
  emit(event: string | symbol, ...args: any[]): boolean {
    const eventName = typeof event === 'string' ? event : event.toString();

    // 限流检查
    if (this.config.rateLimits?.[eventName]) {
      if (!this.checkRateLimit(eventName)) {
        if (this.config.enableTracing) {
          logger.debug(`Event ${eventName} rate-limited`);
        }
        return false;
      }
    }

    // 更新统计
    if (this.config.enableStats) {
      this.updateStats(eventName);
    }

    // 事件追踪
    if (this.config.enableTracing) {
      this.traceEvent(eventName, args);
    }

    // 发射事件
    return super.emit(event as any, ...args);
  }

  /**
   * 检查限流
   */
  private checkRateLimit(eventName: string): boolean {
    const limit = this.config.rateLimits?.[eventName];
    if (!limit) return true;

    const now = Date.now();
    const state = this.rateLimitState.get(eventName);

    if (!state || now >= state.resetTime) {
      // 重置计数器
      this.rateLimitState.set(eventName, {
        count: 1,
        resetTime: now + 1000, // 1秒后重置
      });
      return true;
    }

    if (state.count < limit.maxPerSecond) {
      state.count++;
      return true;
    }

    return false; // 超过限流
  }

  /**
   * 更新事件统计
   */
  private updateStats(eventName: string): void {
    const now = Date.now();
    const stats = this.eventStats.get(eventName);

    if (!stats) {
      this.eventStats.set(eventName, {
        eventName,
        count: 1,
        lastEmitTime: now,
        avgInterval: 0,
      });
    } else {
      const interval = now - stats.lastEmitTime;
      stats.avgInterval = (stats.avgInterval * stats.count + interval) / (stats.count + 1);
      stats.count++;
      stats.lastEmitTime = now;
    }
  }

  /**
   * 事件追踪（开发环境）
   */
  private traceEvent(eventName: string, args: any[]): void {
    // 对于高频事件，使用采样日志（每10次记录一次）
    const stats = this.eventStats.get(eventName);
    const shouldLog = !stats || stats.count % 10 === 0;

    if (shouldLog) {
      const dataSize = JSON.stringify(args).length;
      logger.debug(
        `${eventName} (#${stats?.count || 1}, ${dataSize} bytes, ${stats?.avgInterval.toFixed(1) || 0}ms avg)`
      );
    }
  }

  /**
   * 获取事件统计报告
   */
  getStats(): EventStats[] {
    return Array.from(this.eventStats.values()).sort((a, b) => b.count - a.count);
  }

  /**
   * 打印统计报告
   */
  printStatsReport(): void {
    const stats = this.getStats();
    if (stats.length === 0) {
      logger.debug('No event stats available');
      return;
    }

    logger.debug('Event stats report:');
    logger.debug('━'.repeat(80));
    logger.debug(
      `${'Event name'.padEnd(30)} | ${'Count'.padEnd(10)} | ${'Avg interval'.padEnd(15)} | ${'Frequency'.padEnd(10)}`
    );
    logger.debug('━'.repeat(80));

    stats.forEach((stat) => {
      const frequency = stat.avgInterval > 0 ? (1000 / stat.avgInterval).toFixed(2) : 'N/A';
      logger.debug(
        `${stat.eventName.padEnd(30)} | ${String(stat.count).padEnd(10)} | ${stat.avgInterval.toFixed(1).padEnd(15)} | ${frequency.padEnd(10)}`
      );
    });

    logger.debug('━'.repeat(80));
  }

  /**
   * 清空统计数据
   */
  clearStats(): void {
    this.eventStats.clear();
    this.rateLimitState.clear();
    logger.debug('Stats cleared');
  }
}

/**
 * 导出全局事件总线实例
 */
export const globalEventBus = EventBus.getInstance();
