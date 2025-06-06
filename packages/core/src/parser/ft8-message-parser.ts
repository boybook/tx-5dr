import { FT8Message, FT8MessageType } from '@tx5dr/contracts';

// 呼号正则表达式（支持标准呼号格式和<>包裹的格式）
const CALLSIGN_REGEX = /^[A-Z0-9]{1,3}[0-9][A-Z0-9]{0,3}[A-Z]$/;

// 标准呼号正则表达式（2-6位，最多一个数字位于第2-4位）
const STANDARD_CALLSIGN_REGEX = /^[A-Z0-9]{2,6}$/;

// 网格定位正则表达式（4位或6位）
const GRID_REGEX = /^[A-R]{2}[0-9]{2}([A-X]{2})?$/;

// 信号报告正则表达式
const REPORT_REGEX = /^[+-]?\d{1,2}$/;

// FT8消息解析器类
export class FT8MessageParser {
  
  /**
   * 判断是否为标准呼号
   * 标准呼号规则：
   * 1. 长度在2-6位之间
   * 2. 只包含字母A-Z和数字0-9
   * 3. 最多一个数字，且位于第2-4位
   */
  private static isStandardCallsign(callsign: string): boolean {
    // 移除可能存在的 <>
    const cleanCallsign = callsign.replace(/[<>]/g, '');
    
    // 基本格式检查
    if (!STANDARD_CALLSIGN_REGEX.test(cleanCallsign)) {
      return false;
    }

    // 检查数字位置
    const digits = cleanCallsign.match(/\d/g);
    if (!digits || digits.length > 1) {
      return false;
    }

    const digitIndex = cleanCallsign.search(/\d/);
    return digitIndex >= 1 && digitIndex <= 3;
  }

  /**
   * 判断是否需要使用 <> 包裹呼号
   * 规则：
   * 1. 如果消息中包含网格或数字讯报，且有两个呼号，则非标准呼号需要用 <> 包裹
   * 2. 如果消息中只有一个呼号，且是非标准呼号，则需要用 <> 包裹
   */
  private static shouldWrapCallsign(callsign: string, message: FT8Message): boolean {
    // 如果是标准呼号，不需要包裹
    if (this.isStandardCallsign(callsign)) {
      return false;
    }

    // 根据消息类型判断是否需要包裹
    switch (message.type) {
      case FT8MessageType.CQ:
        // CQ 消息中，如果包含网格，非标准呼号需要包裹
        return !!(message as any).grid;
      
      case FT8MessageType.CALL:
      case FT8MessageType.SIGNAL_REPORT:
      case FT8MessageType.ROGER_REPORT:
      case FT8MessageType.RRR:
      case FT8MessageType.SEVENTY_THREE:
        // 其他消息类型中，如果包含网格或报告，非标准呼号需要包裹
        return !!((message as any).grid || (message as any).report);
      
      default:
        return false;
    }
  }

  /**
   * 解析FT8消息字符串
   * @param message 原始消息字符串
   * @returns 解析后的FT8消息对象
   */
  static parseMessage(message: string): FT8Message {
    const trimmedMessage = message.trim().toUpperCase();
    // 移除所有呼号周围的 <>
    const cleanedMessage = trimmedMessage.replace(/<([A-Z0-9]+)>/g, '$1');
    const parts = cleanedMessage.split(/\s+/);
    
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
  private static isValidCallsign(callsign: string): boolean {
    // 移除可能存在的 <>
    const cleanCallsign = callsign.replace(/[<>]/g, '');
    return CALLSIGN_REGEX.test(cleanCallsign);
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
    // 包装呼号（如果需要）
    const wrapCallsign = (callsign: string) => {
      if (this.shouldWrapCallsign(callsign, message)) {
        return `<${callsign}>`;
      }
      return callsign;
    };

    switch (message.type) {
      case FT8MessageType.CQ:
        if (message.flag && message.grid) {
          return `CQ ${message.flag} ${wrapCallsign(message.senderCallsign)} ${message.grid}`;
        } else if (message.flag) {
          return `CQ ${message.flag} ${wrapCallsign(message.senderCallsign)}`;
        } else if (message.grid) {
          return `CQ ${wrapCallsign(message.senderCallsign)} ${message.grid}`;
        } else {
          return `CQ ${wrapCallsign(message.senderCallsign)}`;
        }
      case FT8MessageType.CALL:
        if (message.grid) {
          return `${wrapCallsign(message.targetCallsign)} ${wrapCallsign(message.senderCallsign)} ${message.grid}`;
        } else {
          return `${wrapCallsign(message.targetCallsign)} ${wrapCallsign(message.senderCallsign)}`;
        }
      case FT8MessageType.SIGNAL_REPORT:
        if (message.report) {
          return `${wrapCallsign(message.targetCallsign)} ${wrapCallsign(message.senderCallsign)} ${this.generateSignalReport(message.report)}`;
        } else {
          return `${wrapCallsign(message.targetCallsign)} ${wrapCallsign(message.senderCallsign)}`;
        }
      case FT8MessageType.ROGER_REPORT:
        if (message.report) {
          return `${wrapCallsign(message.targetCallsign)} ${wrapCallsign(message.senderCallsign)} R${this.generateSignalReport(message.report)}`;
        } else {
          return `${wrapCallsign(message.targetCallsign)} ${wrapCallsign(message.senderCallsign)} R`;
        }
      case FT8MessageType.RRR:
        return `${wrapCallsign(message.targetCallsign)} ${wrapCallsign(message.senderCallsign)} RR73`;
      case FT8MessageType.SEVENTY_THREE:
        return `${wrapCallsign(message.targetCallsign)} ${wrapCallsign(message.senderCallsign)} 73`;
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