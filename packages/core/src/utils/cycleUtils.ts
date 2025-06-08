import type { ModeDescriptor } from '@tx5dr/contracts';

/**
 * 统一的周期计算工具函数
 */
export class CycleUtils {
  /**
   * 根据UTC时间戳计算周期编号
   * @param utcSeconds UTC时间戳（秒）
   * @param slotMs 时隙长度（毫秒）
   * @returns 周期编号（整数）
   */
  static calculateCycleNumber(utcSeconds: number, slotMs: number): number {
    return Math.floor(utcSeconds / (slotMs / 1000));
  }

  /**
   * 根据时间戳毫秒计算周期编号
   * @param timestampMs 时间戳（毫秒）
   * @param slotMs 时隙长度（毫秒）
   * @returns 周期编号（整数）
   */
  static calculateCycleNumberFromMs(timestampMs: number, slotMs: number): number {
    return Math.floor(timestampMs / slotMs);
  }

  /**
   * 判断周期是否为偶数周期（用于颜色显示）
   * @param cycleNumber 周期编号
   * @returns 是否为偶数周期
   */
  static isEvenCycle(cycleNumber: number): boolean {
    return cycleNumber % 2 === 0;
  }

  /**
   * 判断操作员是否在发射周期内
   * @param operatorTransmitCycles 操作员配置的发射周期（0=偶数，1=奇数）
   * @param utcSeconds UTC时间戳（秒）
   * @param slotMs 时隙长度（毫秒）
   * @returns 是否在发射周期内
   */
  static isOperatorTransmitCycle(operatorTransmitCycles: number[], utcSeconds: number, slotMs: number): boolean {
    if (!operatorTransmitCycles || operatorTransmitCycles.length === 0) {
      return false;
    }

    const cycleNumber = this.calculateCycleNumber(utcSeconds, slotMs);
    const isEvenCycle = this.isEvenCycle(cycleNumber);
    const currentCycleType = isEvenCycle ? 0 : 1; // 0=偶数周期, 1=奇数周期
    
    return operatorTransmitCycles.includes(currentCycleType);
  }

  /**
   * 判断操作员是否在发射周期内（基于毫秒时间戳）
   * @param operatorTransmitCycles 操作员配置的发射周期（0=偶数，1=奇数）
   * @param timestampMs 时间戳（毫秒）
   * @param slotMs 时隙长度（毫秒）
   * @returns 是否在发射周期内
   */
  static isOperatorTransmitCycleFromMs(operatorTransmitCycles: number[], timestampMs: number, slotMs: number): boolean {
    const utcSeconds = Math.floor(timestampMs / 1000);
    return this.isOperatorTransmitCycle(operatorTransmitCycles, utcSeconds, slotMs);
  }

  /**
   * 生成时隙显示名称
   * @param utcSeconds UTC时间戳（秒）
   * @param mode 模式描述符
   * @returns 显示名称
   */
  static generateSlotDisplayName(utcSeconds: number, mode: ModeDescriptor): string {
    if (mode.name === 'FT8') {
      // FT8特殊显示：00/30, 15/45
      const seconds = utcSeconds % 60;
      const slotInMinute = Math.floor(seconds / 15);
      switch (slotInMinute) {
        case 0: return '00/30';
        case 1: return '15/45';
        case 2: return '00/30';
        case 3: return '15/45';
        default: return '00/30';
      }
    } else {
      // 其他模式显示通用周期ID
      const cycleNumber = this.calculateCycleNumber(utcSeconds, mode.slotMs);
      return `周期${cycleNumber}`;
    }
  }

  /**
   * 生成时隙组键（用于前端分组显示）
   * @param timestampMs 时间戳（毫秒）
   * @param slotMs 时隙长度（毫秒）
   * @returns 组键字符串
   */
  static generateSlotGroupKey(timestampMs: number, slotMs: number): string {
    const alignedMs = Math.floor(timestampMs / slotMs) * slotMs;
    const alignedTime = new Date(alignedMs);
    return alignedTime.toISOString().slice(11, 19).replace(/:/g, '');
  }
} 