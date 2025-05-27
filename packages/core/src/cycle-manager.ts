import { FT8Cycle, CycleInfo } from '@tx5dr/contracts';

// FT8周期管理器
export class CycleManager {
  private listeners: Array<(cycleInfo: CycleInfo) => void> = [];
  private currentCycle: FT8Cycle = FT8Cycle.EVEN;
  private cycleStartTime: number = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor() {
    this.initializeCycle();
  }

  /**
   * 初始化周期，同步到FT8标准时间
   */
  private initializeCycle(): void {
    const now = Date.now();
    
    // FT8使用15秒周期，从UTC时间的整分钟开始
    // 偶数周期：0-15秒，30-45秒
    // 奇数周期：15-30秒，45-60秒
    const secondsInMinute = Math.floor((now / 1000) % 60);
    const cycleInMinute = Math.floor(secondsInMinute / 15);
    
    this.currentCycle = (cycleInMinute % 2) as FT8Cycle;
    
    // 计算当前周期的开始时间
    const cycleStartSeconds = Math.floor(secondsInMinute / 15) * 15;
    this.cycleStartTime = now - ((secondsInMinute - cycleStartSeconds) * 1000);
    
    this.startTimer();
  }

  /**
   * 启动定时器
   */
  private startTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }

    // 计算到下一个周期的时间
    const timeToNextCycle = this.getTimeToNextCycle();
    
    // 设置定时器在下一个周期开始时触发
    setTimeout(() => {
      this.onCycleChange();
      
      // 然后每15秒触发一次
      this.timer = setInterval(() => {
        this.onCycleChange();
      }, 15000);
    }, timeToNextCycle);
  }

  /**
   * 周期变化处理
   */
  private onCycleChange(): void {
    // 切换到下一个周期
    this.currentCycle = this.currentCycle === FT8Cycle.EVEN ? FT8Cycle.ODD : FT8Cycle.EVEN;
    this.cycleStartTime = Date.now();
    
    // 通知监听器
    const cycleInfo = this.getCurrentCycleInfo();
    this.notifyListeners(cycleInfo);
  }

  /**
   * 获取当前周期信息
   */
  getCurrentCycleInfo(): CycleInfo {
    return {
      cycle: this.currentCycle,
      startTime: this.cycleStartTime,
      endTime: this.cycleStartTime + 15000,
      isTransmitting: false, // 这个值需要外部设置
    };
  }

  /**
   * 获取当前周期
   */
  getCurrentCycle(): FT8Cycle {
    return this.currentCycle;
  }

  /**
   * 获取到下一个周期的剩余时间（毫秒）
   */
  getTimeToNextCycle(): number {
    const now = Date.now();
    const elapsed = now - this.cycleStartTime;
    return Math.max(0, 15000 - elapsed);
  }

  /**
   * 获取当前周期的剩余时间（毫秒）
   */
  getRemainingTimeInCycle(): number {
    return this.getTimeToNextCycle();
  }

  /**
   * 获取当前周期的进度（0-1）
   */
  getCycleProgress(): number {
    const now = Date.now();
    const elapsed = now - this.cycleStartTime;
    return Math.min(1, elapsed / 15000);
  }

  /**
   * 检查是否为发射周期
   * 通常奇数周期用于发射，偶数周期用于接收
   */
  isTransmitCycle(): boolean {
    return this.currentCycle === FT8Cycle.ODD;
  }

  /**
   * 检查是否为接收周期
   */
  isReceiveCycle(): boolean {
    return this.currentCycle === FT8Cycle.EVEN;
  }

  /**
   * 等待到指定周期
   */
  async waitForCycle(targetCycle: FT8Cycle): Promise<void> {
    if (this.currentCycle === targetCycle) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const listener = (cycleInfo: CycleInfo) => {
        if (cycleInfo.cycle === targetCycle) {
          this.removeListener(listener);
          resolve();
        }
      };
      this.addListener(listener);
    });
  }

  /**
   * 等待到下一个周期
   */
  async waitForNextCycle(): Promise<CycleInfo> {
    return new Promise((resolve) => {
      const listener = (cycleInfo: CycleInfo) => {
        this.removeListener(listener);
        resolve(cycleInfo);
      };
      this.addListener(listener);
    });
  }

  /**
   * 添加周期变化监听器
   */
  addListener(listener: (cycleInfo: CycleInfo) => void): void {
    this.listeners.push(listener);
  }

  /**
   * 移除周期变化监听器
   */
  removeListener(listener: (cycleInfo: CycleInfo) => void): void {
    const index = this.listeners.indexOf(listener);
    if (index > -1) {
      this.listeners.splice(index, 1);
    }
  }

  /**
   * 通知所有监听器
   */
  private notifyListeners(cycleInfo: CycleInfo): void {
    this.listeners.forEach(listener => {
      try {
        listener(cycleInfo);
      } catch (error) {
        console.error('Error in cycle change listener:', error);
      }
    });
  }

  /**
   * 停止周期管理器
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.listeners = [];
  }

  /**
   * 重新同步周期
   */
  resync(): void {
    this.stop();
    this.initializeCycle();
  }

  /**
   * 获取UTC时间的秒数（用于调试）
   */
  static getUTCSeconds(): number {
    return Math.floor(Date.now() / 1000) % 60;
  }

  /**
   * 获取当前应该是哪个周期（基于UTC时间）
   */
  static getCurrentCycleFromUTC(): FT8Cycle {
    const secondsInMinute = this.getUTCSeconds();
    const cycleInMinute = Math.floor(secondsInMinute / 15);
    return (cycleInMinute % 2) as FT8Cycle;
  }

  /**
   * 格式化周期信息为字符串
   */
  static formatCycleInfo(cycleInfo: CycleInfo): string {
    const cycleType = cycleInfo.cycle === FT8Cycle.EVEN ? 'EVEN' : 'ODD';
    const startTime = new Date(cycleInfo.startTime).toISOString();
    const endTime = new Date(cycleInfo.endTime).toISOString();
    
    return `Cycle: ${cycleType}, Start: ${startTime}, End: ${endTime}, TX: ${cycleInfo.isTransmitting}`;
  }
} 