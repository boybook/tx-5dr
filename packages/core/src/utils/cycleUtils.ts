import type { ModeDescriptor } from '@tx5dr/contracts';

/**
 * 统一的周期计算工具函数
 */
export class CycleUtils {
  /**
   * 根据UTC时间戳（秒）计算周期编号。
   *
   * ⚠️ FT4（slotMs=7500）等亚秒级时隙不要用这个。整数 utcSeconds 会把 7.5/22.5/37.5/52.5
   * 这种 .5 秒边界截断到上一秒，导致周期号算错（例：slotStart=7500ms → utcSeconds=7
   * → floor(7/7.5)=0，应为 1）。一律改用 {@link calculateCycleNumberFromMs}。
   *
   * @deprecated FT4 不安全；新代码请使用 calculateCycleNumberFromMs。
   */
  static calculateCycleNumber(utcSeconds: number, slotMs: number): number {
    return Math.floor(utcSeconds / (slotMs / 1000));
  }

  /**
   * 根据时间戳毫秒计算周期编号（FT4/FT8 通用）。
   * @param timestampMs 时间戳（毫秒），通常传时隙起点
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
   * 判断操作员是否在发射周期内（基于秒级 utcSeconds）。
   *
   * ⚠️ FT4 不安全。理由同 {@link calculateCycleNumber}。新代码请使用
   * {@link isOperatorTransmitCycleFromMs}。
   *
   * @deprecated 请使用 isOperatorTransmitCycleFromMs，避免亚秒级时隙截断。
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
   * 判断操作员是否在发射周期内（基于毫秒时间戳，FT4/FT8 通用）
   * @param operatorTransmitCycles 操作员配置的发射周期（0=偶数，1=奇数）
   * @param timestampMs 时间戳（毫秒），通常传时隙起点
   * @param slotMs 时隙长度（毫秒）
   */
  static isOperatorTransmitCycleFromMs(operatorTransmitCycles: number[], timestampMs: number, slotMs: number): boolean {
    if (!operatorTransmitCycles || operatorTransmitCycles.length === 0) {
      return false;
    }
    const cycleNumber = this.calculateCycleNumberFromMs(timestampMs, slotMs);
    const currentCycleType = this.isEvenCycle(cycleNumber) ? 0 : 1;
    return operatorTransmitCycles.includes(currentCycleType);
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
      // 其他模式显示通用周期ID（用 FromMs 避免 FT4 亚秒级截断）
      const cycleNumber = this.calculateCycleNumberFromMs(utcSeconds * 1000, mode.slotMs);
      return `Cycle ${cycleNumber}`;
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