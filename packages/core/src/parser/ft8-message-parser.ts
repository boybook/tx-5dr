import { FT8Message, FT8MessageType } from '@tx5dr/contracts';

// 呼号正则表达式（支持标准呼号格式）
const CALLSIGN_REGEX = /^[A-Z0-9]{1,3}[0-9][A-Z0-9]{0,3}[A-Z]$/;

// 网格定位正则表达式（4位或6位）
const GRID_REGEX = /^[A-R]{2}[0-9]{2}([A-X]{2})?$/;

// 信号报告正则表达式
const REPORT_REGEX = /^[+-]?\d{1,2}$/;

// FT8消息解析器类
export class FT8MessageParser {
  
  /**
   * 解析FT8消息字符串
   * @param message 原始消息字符串
   * @returns 解析后的FT8消息对象
   */
  static parseMessage(message: string): FT8Message {
    const trimmedMessage = message.trim().toUpperCase();
    const parts = trimmedMessage.split(/\s+/);
    
    // 检查CQ消息
    if (this.isCQMessage(parts)) {
      return this.parseCQMessage(parts, message);
    }

    // 检查73消息（优先于信号报告，避免73被误识别为报告）
    if (this.is73Message(parts)) {
      return this.parse73Message(parts, message);
    }

    // 检查信号报告消息（优先于响应消息，因为格式更具体）
    if (this.isSignalReportMessage(parts)) {
      return this.parseSignalReportMessage(parts, message);
    }

    // 检查确认消息（RRR/RR73，优先于响应消息）
    if (this.isConfirmationMessage(parts)) {
      return this.parseConfirmationMessage(parts, message);
    }

    // 检查响应消息（最后检查，因为格式最宽泛）
    if (this.isResponseMessage(parts)) {
      return this.parseResponseMessage(parts, message);
    }

    // 如果都不匹配，返回未知类型
    return {
      type: FT8MessageType.UNKNOWN
    };
  }

  /**
   * 检查是否为CQ消息
   */
  private static isCQMessage(parts: string[]): boolean {
    return parts[0] === 'CQ' && parts.length >= 2;
  }

  /**
   * 解析CQ消息
   * 格式: CQ [DX] CALLSIGN [GRID]
   */
  private static parseCQMessage(parts: string[], rawMessage: string): FT8Message {
    let callsignIndex = 1;
    let flag: string | undefined;
    
    // 检查是否为CQ DX
    if (parts[1] === 'DX') {
      flag = 'DX';
      callsignIndex = 2;
    }

    if (parts.length <= callsignIndex) {
      return {
        type: FT8MessageType.UNKNOWN
      };
    }

    const callsign = parts[callsignIndex];
    if (!callsign || !this.isValidCallsign(callsign)) {
      return {
        type: FT8MessageType.UNKNOWN
      };
    }

    const result: FT8Message = {
      type: FT8MessageType.CQ,
      senderCallsign: callsign,
    };

    if (flag) {
      result.flag = flag;
    }

    // 检查是否有网格定位
    if (parts.length > callsignIndex + 1) {
      const grid = parts[callsignIndex + 1];
      if (grid && this.isValidGrid(grid)) {
        result.grid = grid;
      }
    }

    return result;
  }

  /**
   * 检查是否为响应消息
   */
  private static isResponseMessage(parts: string[]): boolean {
    return parts.length >= 2 && 
           this.isValidCallsign(parts[0]) && 
           this.isValidCallsign(parts[1]);
  }

  /**
   * 解析响应消息
   * 格式: CALLSIGN1 CALLSIGN2 [GRID]
   */
  private static parseResponseMessage(parts: string[], rawMessage: string): FT8Message {
    const targetCallsign = parts[0];
    const senderCallsign = parts[1];
    
    if (!targetCallsign || !senderCallsign) {
      return {
        type: FT8MessageType.UNKNOWN
      };
    }

    const result: FT8Message = {
      type: FT8MessageType.CALL,
      senderCallsign,
      targetCallsign,
    };

    // 检查是否有网格定位
    if (parts.length > 2) {
      const grid = parts[2];
      if (grid && this.isValidGrid(grid)) {
        result.grid = grid;
      }
    }

    return result;
  }

  /**
   * 检查是否为信号报告消息
   */
  private static isSignalReportMessage(parts: string[]): boolean {
    return parts.length >= 3 && 
           this.isValidCallsign(parts[0]) && 
           this.isValidCallsign(parts[1]) && 
           parts[2] !== undefined &&
           this.isValidReport(parts[2]);
  }

  /**
   * 解析信号报告消息
   * 格式: CALLSIGN1 CALLSIGN2 REPORT
   */
  private static parseSignalReportMessage(parts: string[], rawMessage: string): FT8Message {
    const targetCallsign = parts[0];
    const senderCallsign = parts[1];
    const report = parts[2];
    
    if (!targetCallsign || !senderCallsign || !report) {
      return {
        type: FT8MessageType.UNKNOWN
      };
    }

    return {
      type: FT8MessageType.SIGNAL_REPORT,
      senderCallsign,
      targetCallsign,
      report: parseInt(report, 10),
    };
  }

  /**
   * 检查是否为确认消息
   */
  private static isConfirmationMessage(parts: string[]): boolean {
    if (parts.length < 3) return false;
    const lastPart = parts[parts.length - 1];
    // 新增对R-xx的识别
    return (
      lastPart === 'RRR' || lastPart === 'RR73' || /^R[+-]?\d{1,2}$/.test(lastPart)
    ) &&
      this.isValidCallsign(parts[0]) &&
      this.isValidCallsign(parts[1]);
  }

  /**
   * 解析确认消息
   * 格式: CALLSIGN1 CALLSIGN2 RRR / RR73 / R-01 / R+05
   */
  private static parseConfirmationMessage(parts: string[], rawMessage: string): FT8Message {
    const targetCallsign = parts[0];
    const senderCallsign = parts[1];
    const lastPart = parts[parts.length - 1];
    if (!targetCallsign || !senderCallsign) {
      return {
        type: FT8MessageType.UNKNOWN
      };
    }
    if (lastPart === 'RR73') {
      return {
        type: FT8MessageType.RRR,
        senderCallsign,
        targetCallsign,
      };
    } else if (lastPart === 'RRR') {
      return {
        type: FT8MessageType.RRR,
        senderCallsign,
        targetCallsign,
      };
    } else if (/^R[+-]?\d{1,2}$/.test(lastPart)) {
      // R-01, R+05等，解析为ROGER_REPORT
      return {
        type: FT8MessageType.ROGER_REPORT,
        senderCallsign,
        targetCallsign,
        report: parseInt(lastPart.slice(1), 10)
      };
    }
    return {
      type: FT8MessageType.UNKNOWN
    };
  }

  /**
   * 检查是否为73消息
   */
  private static is73Message(parts: string[]): boolean {
    return parts.length >= 3 && 
           this.isValidCallsign(parts[0]) && 
           this.isValidCallsign(parts[1]) && 
           parts[2] === '73';
  }

  /**
   * 解析73消息
   * 格式: CALLSIGN1 CALLSIGN2 73
   */
  private static parse73Message(parts: string[], rawMessage: string): FT8Message {
    const targetCallsign = parts[0];
    const senderCallsign = parts[1];
    
    if (!targetCallsign || !senderCallsign) {
      return {
        type: FT8MessageType.UNKNOWN
      };
    }

    return {
      type: FT8MessageType.SEVENTY_THREE,
      senderCallsign,
      targetCallsign,
    };
  }

  /**
   * 验证呼号格式
   */
  private static isValidCallsign(callsign?: string): boolean {
    if (!callsign) return false;
    return CALLSIGN_REGEX.test(callsign);
  }

  /**
   * 验证网格定位格式
   */
  private static isValidGrid(grid: string): boolean {
    return GRID_REGEX.test(grid);
  }

  /**
   * 验证信号报告格式
   */
  private static isValidReport(report: string): boolean {
    return REPORT_REGEX.test(report);
  }

  /**
   * 生成标准FT8消息
   * @param type 消息类型
   * @param params 消息参数，包括我方呼号、目标呼号、网格、报告等
   * @returns 生成的消息字符串
   */
  static generateMessage(message: FT8Message): string {
    switch (message.type) {
      case FT8MessageType.CQ:
        if (message.flag && message.grid) {
          return `CQ ${message.flag} ${message.senderCallsign} ${message.grid}`;
        } else if (message.flag) {
          return `CQ ${message.flag} ${message.senderCallsign}`;
        } else if (message.grid) {
          return `CQ ${message.senderCallsign} ${message.grid}`;
        } else {
          return `CQ ${message.senderCallsign}`;
        }
      case FT8MessageType.CALL:
        if (message.grid) {
          return `${message.targetCallsign} ${message.senderCallsign} ${message.grid}`;
        } else {
          return `${message.targetCallsign} ${message.senderCallsign}`;
        }
      case FT8MessageType.SIGNAL_REPORT:
        if (message.report) {
          return `${message.targetCallsign} ${message.senderCallsign} ${this.generateSignalReport(message.report)}`;
        } else {
          return `${message.targetCallsign} ${message.senderCallsign}`;
        }
      case FT8MessageType.ROGER_REPORT:
        if (message.report) {
          return `${message.targetCallsign} ${message.senderCallsign} R${this.generateSignalReport(message.report)}`;
        } else {
          return `${message.targetCallsign} ${message.senderCallsign} R`;
        }
      case FT8MessageType.RRR:
        return `${message.targetCallsign} ${message.senderCallsign} RR73`;
      case FT8MessageType.SEVENTY_THREE:
        return `${message.targetCallsign} ${message.senderCallsign} 73`;
      default:
        return '';
    }
  }

  /**
   * 根据SNR值生成标准的FT8信号报告字符串。
   * @param snr 信号噪声比 (dB)。
   * @returns 格式化的信号报告字符串 (例如, "-15", "+05")。
   */
  static generateSignalReport(snr: number): string {
    // 将 SNR 四舍五入到最接近的整数
    const roundedSnr = Math.round(snr);
    const absSnr = Math.abs(roundedSnr);
    // 格式化为两位数,添加正负号
    return `${roundedSnr < 0 ? '-' : '+'}${absSnr.toString().padStart(2, '0')}`;
  }
}