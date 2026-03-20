import { EventEmitter } from 'eventemitter3';
import type { ClockSource } from './ClockSource.js';
import type { ModeDescriptor, SlotInfo } from '@tx5dr/contracts';
import { CycleUtils } from '../utils/cycleUtils.js';

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
  private lastSlotId = 0;
  private compensationMs: number = 0; // 发射时序补偿（毫秒）

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
    this.scheduleNextSlot();
  }
  
  /**
   * 停止时隙时钟
   */
  stop(): void {
    this._isRunning = false;
    if (this.timerId) {
      clearTimeout(this.timerId);
      this.timerId = undefined;
    }
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
    console.log(`⚙️ [SlotClock] 发射补偿已更新为 ${compensationMs}ms`);
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
      const nextSlotStart = this.calculateNextSlotStart(now);
      const delay = Math.max(0, nextSlotStart - now);
      
      this.timerId = setTimeout(() => {
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
    const utcSeconds = Math.floor(slotStartTime / 1000);
    // 使用统一的周期计算方法
    const cycleNumber = CycleUtils.calculateCycleNumber(utcSeconds, this.mode.slotMs);
    const slotId = `${this.mode.name}-${cycleNumber}-${slotStartTime}`;
    const now = this.clockSource.now();
    const phaseMs = now - slotStartTime;
    
    if (phaseMs > 100) {
      console.warn(`⚠️ [SlotClock] 时隙触发漂移 ${phaseMs.toFixed(1)}ms（可能受 CPU 节流影响），已自动修正子事件时序`);
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
      console.log(`⚙️ [SlotClock] 应用发射补偿: ${this.compensationMs}ms, 调整后编码延迟=${adjustedEncodeDelay}ms, 发射延迟=${adjustedTransmitDelay}ms`);

      // 警告：补偿值超出编码缓冲时间
      if (adjustedEncodeDelay === 0 && encodeDelay > 0) {
        console.warn(`⚠️ [SlotClock] 补偿值 ${this.compensationMs}ms 超过编码缓冲时间 ${encodeDelay}ms，编码将立即开始，可能导致时序紧张`);
      }
    }

    // 先发射 encodeStart 事件（提前开始编码）
    if (adjustedEncodeDelay > 0) {
      setTimeout(() => {
        if (this.isRunning) {
          console.log(`🔧 [SlotClock] encodeStart 事件触发: 时隙=${slotInfo.id}, 延迟=${adjustedEncodeDelay}ms, 距离目标播放=${encodeAdvance}ms`);
          this.emit('encodeStart', slotInfo);
        }
      }, adjustedEncodeDelay);
    } else {
      // 如果没有足够时间，立即触发
      console.log(`🔧 [SlotClock] encodeStart 事件立即触发: 时隙=${slotInfo.id}`);
      this.emit('encodeStart', slotInfo);
    }

    // 然后发射 transmitStart 事件（目标播放时间）
    if (adjustedTransmitDelay > 0) {
      setTimeout(() => {
        if (this.isRunning) {
          console.log(`📡 [SlotClock] transmitStart 事件触发: 时隙=${slotInfo.id}, 延迟=${adjustedTransmitDelay}ms`);
          this.emit('transmitStart', slotInfo);
        }
      }, adjustedTransmitDelay);
    } else {
      // 如果没有延迟，立即发射
      console.log(`📡 [SlotClock] transmitStart 事件立即触发: 时隙=${slotInfo.id}`);
      this.emit('transmitStart', slotInfo);
    }
    
    // 计算窗口时机 - 使用 windowTiming 数组
    const windowTimings = this.mode.windowTiming;
    
    if (!windowTimings || windowTimings.length === 0) {
      console.warn(`⚠️ [SlotClock] 模式 ${this.mode.name} 没有定义窗口时机`);
      this.scheduleNextSlot();
      return;
    }
    
    // 计算时隙结束时间
    const slotEndTime = slotStartTime + this.mode.slotMs;
    
    // 为每个子窗口发出事件 - 以时隙结束时间为基准进行偏移
    for (let windowIdx = 0; windowIdx < windowTimings.length; windowIdx++) {
      const windowOffset = windowTimings[windowIdx];
      
      if (windowOffset === undefined) {
        console.warn(`⚠️ [SlotClock] 窗口 ${windowIdx} 的偏移时间未定义`);
        continue;
      }
      
      // 计算窗口触发时间 = 时隙结束时间 + 偏移
      const windowTriggerTime = slotEndTime + windowOffset;
      const currentTime = this.clockSource.now();
      const delayMs = windowTriggerTime - currentTime;

      if (delayMs <= 0) {
        // 立即发出（包括负偏移，即在时隙结束前触发）
        this.emit('subWindow', slotInfo, windowIdx);
      } else {
        // 延迟发出
        setTimeout(() => {
          if (this.isRunning) {
            this.emit('subWindow', slotInfo, windowIdx);
          }
        }, delayMs);
      }
    }
    
    // 调度下一个时隙
    this.scheduleNextSlot();
  }
  
  /**
   * 计算窗口时机
   * @returns 每个窗口相对于时隙开始的延迟时间（毫秒）
   * @deprecated 不再需要，直接使用 mode.windowTiming
   */
  private calculateWindowTimings(): number[] {
    return this.mode.windowTiming || [];
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
    const utcSeconds = Math.floor(currentSlotStart / 1000);
    const cycleNumber = CycleUtils.calculateCycleNumber(utcSeconds, this.mode.slotMs);
    
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
  
  // EventEmitter3 已经提供了类型安全的方法
} 