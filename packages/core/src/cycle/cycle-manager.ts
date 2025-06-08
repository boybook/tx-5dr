import { EventEmitter } from 'events';
import { ModeDescriptor } from '@tx5dr/contracts';
import { CycleUtils } from '../utils/cycleUtils.js';

/**
 * 周期信息
 */
export interface CycleInfo {
  cycle: number;
  isTransmit: boolean;
  startTime: number;
  endTime: number;
}

/**
 * 周期管理器
 * 负责管理FT8/FT4的时隙周期
 */
export class CycleManager extends EventEmitter {
  private _currentCycle: number = 0;
  private _currentMode: ModeDescriptor;
  private _timer: NodeJS.Timeout | null = null;
  private _transmitCycles: number[] = [];

  constructor(mode: ModeDescriptor, transmitCycles: number[] = []) {
    super();
    this._currentMode = mode;
    this._transmitCycles = transmitCycles;
    this.initializeCycle();
  }

  /**
   * 初始化周期
   */
  private initializeCycle(): void {
    const now = Date.now();
    const utcSeconds = Math.floor(now / 1000);
    // 使用统一的周期计算方法
    this._currentCycle = CycleUtils.calculateCycleNumber(utcSeconds, this._currentMode.slotMs);
  }

  /**
   * 设置模式
   */
  public setMode(mode: ModeDescriptor): void {
    this._currentMode = mode;
    this.initializeCycle();
    this.startTimer();
  }

  /**
   * 设置发射周期
   */
  public setTransmitCycles(cycles: number[]): void {
    this._transmitCycles = cycles;
  }

  /**
   * 启动定时器
   */
  public startTimer(): void {
    if (this._timer) {
      clearTimeout(this._timer);
    }

    const now = Date.now();
    const slotMs = this._currentMode.slotMs;
    
    // 计算下一个时隙的开始时间
    const nextSlotStart = Math.ceil(now / slotMs) * slotMs;
    const delay = nextSlotStart - now;
    
    this._timer = setTimeout(() => {
      this.handleCycleEnd();
    }, delay);
  }

  /**
   * 处理周期结束
   */
  private handleCycleEnd(): void {
    // 重新计算当前周期
    const now = Date.now();
    const utcSeconds = Math.floor(now / 1000);
    this._currentCycle = CycleUtils.calculateCycleNumber(utcSeconds, this._currentMode.slotMs);

    this.emit('cycleEnd', this.getCycleInfo());
    this.startTimer();
  }

  /**
   * 获取当前周期信息
   */
  public getCycleInfo(): CycleInfo {
    const now = Date.now();
    const slotMs = this._currentMode.slotMs;
    const startTime = Math.floor(now / slotMs) * slotMs;
    const endTime = startTime + slotMs;

    return {
      cycle: this._currentCycle,
      isTransmit: this.isTransmitCycle(),
      startTime,
      endTime
    };
  }

  /**
   * 检查当前是否为发射周期
   */
  public isTransmitCycle(): boolean {
    return this._transmitCycles.includes(this._currentCycle);
  }

  /**
   * 停止定时器
   */
  public stopTimer(): void {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  /**
   * 获取当前周期
   */
  public getCurrentCycle(): number {
    return this._currentCycle;
  }

  /**
   * 获取周期开始时间
   */
  public getCycleStartTime(): number {
    const now = Date.now();
    const slotMs = this._currentMode.slotMs;
    return Math.floor(now / slotMs) * slotMs;
  }

  /**
   * 销毁定时器
   */
  public destroy(): void {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  /**
   * 获取当前周期信息
   */
  public getCurrentCycleInfo(): CycleInfo {
    return this.getCycleInfo();
  }

  /**
   * 获取距离下一个周期的毫秒数
   */
  public getTimeToNextCycle(): number {
    const now = Date.now();
    const elapsed = now - this.getCycleStartTime();
    return Math.max(0, this._currentMode.slotMs - elapsed);
  }

  /**
   * 获取当前周期进度（0-1）
   */
  public getCycleProgress(): number {
    const now = Date.now();
    const elapsed = now - this.getCycleStartTime();
    return Math.min(1, elapsed / this._currentMode.slotMs);
  }

  /**
   * 等待指定周期
   */
  public async waitForCycle(targetCycle: number): Promise<void> {
    if (this._currentCycle === targetCycle) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const listener = (cycleInfo: CycleInfo) => {
        if (cycleInfo.cycle === targetCycle) {
          this.removeListener('cycleEnd', listener);
          resolve();
        }
      };
      this.on('cycleEnd', listener);
    });
  }

  /**
   * 添加周期变化监听器
   */
  public onCycleChange(listener: (cycleInfo: CycleInfo) => void): void {
    this.on('cycleEnd', listener);
  }

  /**
   * 移除周期变化监听器
   */
  public removeCycleListener(listener: (cycleInfo: CycleInfo) => void): void {
    this.removeListener('cycleEnd', listener);
  }
} 