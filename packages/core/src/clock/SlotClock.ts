import { EventEmitter } from 'eventemitter3';
import type { ClockSource } from './ClockSource.js';
import type { ModeDescriptor, SlotInfo, SlotInfoSchema } from '@tx5dr/contracts';
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
  
  constructor(clockSource: ClockSource, mode: ModeDescriptor) {
    super();
    this.clockSource = clockSource;
    this.mode = mode;
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
    
    const slotInfo: SlotInfo = {
      id: slotId,
      startMs: slotStartTime,
      phaseMs,
      driftMs: 0, // 可以在后续版本中实现漂移检测
      cycleNumber,
      utcSeconds,
      mode: this.mode.name
    };
    
    // 发出时隙开始事件
    this.emit('slotStart', slotInfo);

    // 计算编码和发射时机
    const transmitDelay = this.mode.transmitTiming || 0;
    const encodeAdvance = this.mode.encodeAdvance || 400; // 默认提前400ms
    const encodeDelay = Math.max(0, transmitDelay - encodeAdvance);

    // 先发射 encodeStart 事件（提前开始编码）
    if (encodeDelay > 0) {
      setTimeout(() => {
        if (this.isRunning) {
          console.log(`🔧 [SlotClock] encodeStart 事件触发: 时隙=${slotInfo.id}, 延迟=${encodeDelay}ms, 距离目标播放=${encodeAdvance}ms`);
          this.emit('encodeStart', slotInfo);
        }
      }, encodeDelay);
    } else {
      // 如果没有足够时间，立即触发
      console.log(`🔧 [SlotClock] encodeStart 事件立即触发: 时隙=${slotInfo.id}`);
      this.emit('encodeStart', slotInfo);
    }

    // 然后发射 transmitStart 事件（目标播放时间）
    if (transmitDelay > 0) {
      setTimeout(() => {
        if (this.isRunning) {
          console.log(`📡 [SlotClock] transmitStart 事件触发: 时隙=${slotInfo.id}, 延迟=${transmitDelay}ms`);
          this.emit('transmitStart', slotInfo);
        }
      }, transmitDelay);
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