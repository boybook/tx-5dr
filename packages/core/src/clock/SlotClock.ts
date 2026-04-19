import { EventEmitter } from 'eventemitter3';
import type { ClockSource } from './ClockSource.js';
import type { ModeDescriptor, SlotInfo } from '@tx5dr/contracts';
import { CycleUtils } from '../utils/cycleUtils.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('SlotClock');

export interface SlotClockEvents {
  'slotStart': (slotInfo: SlotInfo) => void;
  'encodeStart': (slotInfo: SlotInfo) => void;  // 提前触发编码准备
  'transmitStart': (slotInfo: SlotInfo) => void; // 目标播放时间
  'subWindow': (slotInfo: SlotInfo, windowIdx: number) => void;
  'error': (error: Error) => void;
}

/**
 * 时隙时钟 - 根据模式描述符生成精确的时隙事件
 */
export class SlotClock extends EventEmitter<SlotClockEvents> {
  private clockSource: ClockSource;
  private mode: ModeDescriptor;
  private _isRunning = false;
  public get isRunning() {
    return this._isRunning;
  }
  private timerId: NodeJS.Timeout | undefined;
  private lastSlotStartMs: number | null = null;
  private compensationMs: number = 0; // 发射时序补偿（毫秒）
  private pendingEventTimers = new Set<NodeJS.Timeout>();
  private runGeneration = 0;

  constructor(clockSource: ClockSource, mode: ModeDescriptor, compensationMs: number = 0) {
    super();
    this.clockSource = clockSource;
    this.mode = mode;
    this.compensationMs = compensationMs;
  }
  
  /**
   * 启动时隙时钟
   */
  start(): void {
    if (this.isRunning) {
      return;
    }
    
    this._isRunning = true;
    this.runGeneration++;
    this.lastSlotStartMs = null;
    this.scheduleNextSlot();
  }
  
  /**
   * 停止时隙时钟
   */
  stop(): void {
    this._isRunning = false;
    this.lastSlotStartMs = null;
    this.clearPendingTimers();
  }
  
  /**
   * 获取当前模式
   */
  getMode(): ModeDescriptor {
    return { ...this.mode };
  }
  
  /**
   * 更新模式（会重新同步时钟）
   */
  setMode(mode: ModeDescriptor): void {
    this.mode = mode;
    if (this.isRunning) {
      this.stop();
      this.start();
    }
  }

  /**
   * 设置发射时序补偿（毫秒）
   * @param compensationMs 补偿值，正值表示提前发射，负值表示延后发射
   */
  setCompensation(compensationMs: number): void {
    this.compensationMs = compensationMs;
    logger.info(`Transmit compensation updated to ${compensationMs}ms`);
  }

  /**
   * 获取当前的发射时序补偿值
   */
  getCompensation(): number {
    return this.compensationMs;
  }
  
  private scheduleNextSlot(): void {
    if (!this.isRunning) return;
    
    try {
      const now = this.clockSource.now();
      const nextSlotStart = this.lastSlotStartMs === null
        ? this.calculateNextSlotStart(now)
        : this.lastSlotStartMs + this.mode.slotMs;
      const delay = Math.max(0, nextSlotStart - now);
      const generation = this.runGeneration;
      
      this.timerId = setTimeout(() => {
        this.timerId = undefined;
        if (!this.isRunning || this.runGeneration !== generation) {
          return;
        }
        this.handleSlotStart(nextSlotStart);
      }, delay);
      
    } catch (error) {
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
    }
  }
  
  private calculateNextSlotStart(currentTime: number): number {
    // 计算下一个时隙的开始时间
    // 对于 FT8：每 15 秒对齐到 UTC 时间
    // 对于 FT4：每 7.5 秒对齐
    
    const slotMs = this.mode.slotMs;
    const utcMs = currentTime % (24 * 60 * 60 * 1000); // 当天的毫秒数
    const currentSlot = Math.floor(utcMs / slotMs);
    const nextSlot = currentSlot + 1;
    
    return Math.floor(currentTime / (24 * 60 * 60 * 1000)) * (24 * 60 * 60 * 1000) + nextSlot * slotMs;
  }
  
  private handleSlotStart(slotStartTime: number): void {
    if (!this.isRunning) {
      return;
    }
    const generation = this.runGeneration;

    if (this.lastSlotStartMs === slotStartTime) {
      logger.debug(`duplicate slot start suppressed: ${slotStartTime}`);
      return;
    }
    this.lastSlotStartMs = slotStartTime;

    // 用 ms 直接算 cycleNumber，避免 FT4 亚秒级时隙（7.5/22.5/...s）被截断到上一秒
    const cycleNumber = CycleUtils.calculateCycleNumberFromMs(slotStartTime, this.mode.slotMs);
    const utcSeconds = Math.floor(slotStartTime / 1000); // 仅用于显示/日志，不要再用于周期判断
    const slotId = `${this.mode.name}-${cycleNumber}-${slotStartTime}`;
    const now = this.clockSource.now();
    const phaseMs = now - slotStartTime;
    
    if (phaseMs > 100) {
      logger.warn(`Slot trigger drift ${phaseMs.toFixed(1)}ms (possible CPU throttle), sub-event timing corrected automatically`);
    }

    const slotInfo: SlotInfo = {
      id: slotId,
      startMs: slotStartTime,
      phaseMs,
      driftMs: phaseMs,
      cycleNumber,
      utcSeconds,
      mode: this.mode.name
    };
    
    // 发出时隙开始事件
    this.emit('slotStart', slotInfo);
    if (!this.isRunning || this.runGeneration !== generation) {
      return;
    }

    // 计算编码和发射时机
    const transmitDelay = this.mode.transmitTiming || 0;
    const encodeAdvance = this.mode.encodeAdvance || 400; // 默认提前400ms
    const encodeDelay = transmitDelay - encodeAdvance; // 原始编码延迟

    // 应用时序补偿（正值表示提前发射，负值表示延后发射）
    // 同时减去 phaseMs（时隙触发漂移），使子事件仍在绝对时间正确位置触发
    // 独立计算两个延迟的补偿，避免级联效应
    const adjustedTransmitDelay = Math.max(0, transmitDelay - this.compensationMs - phaseMs);
    const adjustedEncodeDelay = Math.max(0, encodeDelay - this.compensationMs - phaseMs);

    if (this.compensationMs !== 0) {
      logger.debug(`Applying transmit compensation: ${this.compensationMs}ms, adjusted encode delay=${adjustedEncodeDelay}ms, transmit delay=${adjustedTransmitDelay}ms`);

      // 警告：补偿值超出编码缓冲时间
      if (adjustedEncodeDelay === 0 && encodeDelay > 0) {
        logger.warn(`Compensation ${this.compensationMs}ms exceeds encode buffer ${encodeDelay}ms, encoding starts immediately, timing may be tight`);
      }
    }

    // 先发射 encodeStart 事件（提前开始编码）
    if (adjustedEncodeDelay > 0) {
      this.scheduleEvent(adjustedEncodeDelay, generation, () => {
        logger.debug(`encodeStart fired: slot=${slotInfo.id}, delay=${adjustedEncodeDelay}ms, before transmit=${encodeAdvance}ms`);
        this.emit('encodeStart', slotInfo);
      });
    } else if (this.runGeneration === generation) {
      // 如果没有足够时间，立即触发
      logger.debug(`encodeStart fired immediately: slot=${slotInfo.id}`);
      this.emit('encodeStart', slotInfo);
    }

    // 然后发射 transmitStart 事件（目标播放时间）
    if (adjustedTransmitDelay > 0) {
      this.scheduleEvent(adjustedTransmitDelay, generation, () => {
        logger.debug(`transmitStart fired: slot=${slotInfo.id}, delay=${adjustedTransmitDelay}ms`);
        this.emit('transmitStart', slotInfo);
      });
    } else if (this.runGeneration === generation) {
      // 如果没有延迟，立即发射
      logger.debug(`transmitStart fired immediately: slot=${slotInfo.id}`);
      this.emit('transmitStart', slotInfo);
    }
    
    // 计算窗口时机 - 使用 windowTiming 数组
    const windowTimings = this.mode.windowTiming;
    
    if (!windowTimings || windowTimings.length === 0) {
      logger.warn(`Mode ${this.mode.name} has no window timings defined`);
      this.scheduleNextSlot();
      return;
    }
    
    // 计算时隙结束时间
    const slotEndTime = slotStartTime + this.mode.slotMs;
    
    // 为每个子窗口发出事件 - 以时隙结束时间为基准进行偏移
    for (let windowIdx = 0; windowIdx < windowTimings.length; windowIdx++) {
      const windowOffset = windowTimings[windowIdx];
      
      if (windowOffset === undefined) {
        logger.warn(`Window ${windowIdx} offset is undefined`);
        continue;
      }
      
      // 计算窗口触发时间 = 时隙结束时间 + 偏移
      const windowTriggerTime = slotEndTime + windowOffset;
      const currentTime = this.clockSource.now();
      const delayMs = windowTriggerTime - currentTime;

      if (delayMs <= 0) {
        // 立即发出（包括负偏移，即在时隙结束前触发）
        if (this.runGeneration === generation) {
          this.emit('subWindow', slotInfo, windowIdx);
        }
      } else {
        // 延迟发出
        this.scheduleEvent(delayMs, generation, () => {
          this.emit('subWindow', slotInfo, windowIdx);
        });
      }
    }
    
    // 调度下一个时隙
    this.scheduleNextSlot();
  }
  
  /**
   * 获取下一个时隙的倒计时（毫秒）
   */
  public getNextSlotIn(): number {
    if (!this.isRunning) {
      return 0;
    }
    
    const now = this.clockSource.now();
    const slotMs = this.mode.slotMs;
    const nextSlot = Math.ceil(now / slotMs) * slotMs;
    return nextSlot - now;
  }
  
  /**
   * 获取当前时隙信息
   */
  public getCurrentSlotInfo(): SlotInfo | null {
    if (!this.isRunning) {
      return null;
    }
    
    const now = this.clockSource.now();
    const slotMs = this.mode.slotMs;
    const currentSlotStart = Math.floor(now / slotMs) * slotMs;
    const cycleNumber = CycleUtils.calculateCycleNumberFromMs(currentSlotStart, this.mode.slotMs);
    const utcSeconds = Math.floor(currentSlotStart / 1000); // 显示/日志用
    
    return {
      id: `${this.mode.name}-${cycleNumber}-${currentSlotStart}`,
      startMs: currentSlotStart,
      phaseMs: now - currentSlotStart,
      driftMs: 0,
      cycleNumber,
      utcSeconds,
      mode: this.mode.name
    };
  }
  
  private scheduleEvent(delayMs: number, generation: number, callback: () => void): void {
    const timer = setTimeout(() => {
      this.pendingEventTimers.delete(timer);
      if (!this.isRunning || this.runGeneration !== generation) {
        return;
      }
      callback();
    }, delayMs);

    this.pendingEventTimers.add(timer);
  }

  private clearPendingTimers(): void {
    if (this.timerId) {
      clearTimeout(this.timerId);
      this.timerId = undefined;
    }

    for (const timer of this.pendingEventTimers) {
      clearTimeout(timer);
    }
    this.pendingEventTimers.clear();
  }

  // EventEmitter3 已经提供了类型安全的方法
} 
