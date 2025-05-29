import { ParsedFT8Message, FT8MessageType } from '@tx5dr/contracts';

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
  static parseMessage(message: string): ParsedFT8Message {
    const trimmedMessage = message.trim().toUpperCase();
    const parts = trimmedMessage.split(/\s+/);
    
    // 基础结果对象
    const result: ParsedFT8Message = {
      type: FT8MessageType.UNKNOWN,
      rawMessage: message,
      isValid: false,
    };

    if (parts.length === 0) {
      return result;
    }

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

    // 如果都不匹配，标记为自定义消息
    result.type = FT8MessageType.CUSTOM;
    result.isValid = true;
    
    return result;
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
  private static parseCQMessage(parts: string[], rawMessage: string): ParsedFT8Message {
    const result: ParsedFT8Message = {
      type: FT8MessageType.CQ,
      rawMessage,
      isValid: false,
    };

    let callsignIndex = 1;
    
    // 检查是否为CQ DX
    if (parts[1] === 'DX') {
      result.type = FT8MessageType.CQ_DX;
      callsignIndex = 2;
    }

    if (parts.length <= callsignIndex) {
      return result;
    }

    const callsign = parts[callsignIndex];
    if (!callsign || !this.isValidCallsign(callsign)) {
      return result;
    }

    result.callsign1 = callsign;
    result.isValid = true;

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
  private static parseResponseMessage(parts: string[], rawMessage: string): ParsedFT8Message {
    const callsign1 = parts[0];
    const callsign2 = parts[1];
    
    if (!callsign1 || !callsign2) {
      return {
        type: FT8MessageType.UNKNOWN,
        rawMessage,
        isValid: false,
      };
    }

    const result: ParsedFT8Message = {
      type: FT8MessageType.RESPONSE,
      rawMessage,
      callsign1,
      callsign2,
      isValid: true,
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
  private static parseSignalReportMessage(parts: string[], rawMessage: string): ParsedFT8Message {
    const callsign1 = parts[0];
    const callsign2 = parts[1];
    const report = parts[2];
    
    if (!callsign1 || !callsign2 || !report) {
      return {
        type: FT8MessageType.UNKNOWN,
        rawMessage,
        isValid: false,
      };
    }

    return {
      type: FT8MessageType.SIGNAL_REPORT,
      rawMessage,
      callsign1,
      callsign2,
      report,
      isValid: true,
    };
  }

  /**
   * 检查是否为确认消息
   */
  private static isConfirmationMessage(parts: string[]): boolean {
    if (parts.length < 3) return false;
    
    const lastPart = parts[parts.length - 1];
    return (lastPart === 'RRR' || lastPart === 'RR73') &&
           this.isValidCallsign(parts[0]) && 
           this.isValidCallsign(parts[1]);
  }

  /**
   * 解析确认消息
   * 格式: CALLSIGN1 CALLSIGN2 RRR 或 CALLSIGN1 CALLSIGN2 RR73
   */
  private static parseConfirmationMessage(parts: string[], rawMessage: string): ParsedFT8Message {
    const callsign1 = parts[0];
    const callsign2 = parts[1];
    const lastPart = parts[parts.length - 1];
    
    if (!callsign1 || !callsign2) {
      return {
        type: FT8MessageType.UNKNOWN,
        rawMessage,
        isValid: false,
      };
    }
    
    return {
      type: lastPart === 'RR73' ? FT8MessageType.SEVENTY_THREE : FT8MessageType.RRR,
      rawMessage,
      callsign1,
      callsign2,
      isValid: true,
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
  private static parse73Message(parts: string[], rawMessage: string): ParsedFT8Message {
    const callsign1 = parts[0];
    const callsign2 = parts[1];
    
    if (!callsign1 || !callsign2) {
      return {
        type: FT8MessageType.UNKNOWN,
        rawMessage,
        isValid: false,
      };
    }

    return {
      type: FT8MessageType.SEVENTY_THREE,
      rawMessage,
      callsign1,
      callsign2,
      isValid: true,
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
  static generateMessage(type: FT8MessageType, params: {
    myCallsign: string;
    targetCallsign?: string;
    grid?: string;
    report?: string;
  }): string {
    const { myCallsign, targetCallsign, grid, report } = params;

    switch (type) {
      case FT8MessageType.CQ:
        return `CQ ${myCallsign} ${grid}`;
        
      case FT8MessageType.CQ_DX:
        return `CQ DX ${myCallsign}${grid ? ' ' + grid : ''}`;
        
      case FT8MessageType.RESPONSE:
        if (!targetCallsign || !grid) {
          throw new Error('响应消息需要目标呼号和网格');
        }
        return `${targetCallsign} ${myCallsign} ${grid}`;
        
      case FT8MessageType.SIGNAL_REPORT:
        if (!targetCallsign || !report) {
          throw new Error('信号报告消息需要目标呼号和报告');
        }
        return `${targetCallsign} ${myCallsign} ${report}`;
        
      case FT8MessageType.RRR:
        if (!targetCallsign) {
          throw new Error('RRR 消息需要目标呼号');
        }
        return `${targetCallsign} ${myCallsign} RRR`;
        
      case FT8MessageType.SEVENTY_THREE:
        if (!targetCallsign) {
          throw new Error('73 消息需要目标呼号');
        }
        return `${targetCallsign} ${myCallsign} 73`;
        
      default:
        throw new Error(`不支持的消息类型: ${type}`);
    }
  }

  /**
   * 检查消息是否包含指定呼号
   * @param message 解析后的FT8消息对象
   * @param callsign 要检查的呼号
   * @returns 如果消息包含该呼号则返回 true，否则返回 false
   */
  static messageContainsCallsign(message: ParsedFT8Message, callsign: string): boolean {
    return message.callsign1 === callsign || message.callsign2 === callsign;
  }

  /**
   * 获取消息中的对方呼号（相对于指定的本地呼号）
   * @param message 解析后的FT8消息对象
   * @param myCallsign 我方呼号
   * @returns 对方呼号，如果消息与我方呼号无关则返回 undefined
   */
  static getOtherCallsign(message: ParsedFT8Message, myCallsign: string): string | undefined {
    if (message.callsign1 === myCallsign) {
      return message.callsign2;
    } else if (message.callsign2 === myCallsign) {
      return message.callsign1;
    }
    return undefined;
  }

  /**
   * 根据SNR值生成标准的FT8信号报告字符串。
   * @param snr 信号噪声比 (dB)。
   * @returns 格式化的信号报告字符串 (例如, "-15", "+05")。
   */
  static generateSignalReport(snr: number): string {
    // 将 SNR 四舍五入到最接近的整数
    return Math.round(snr).toString();
  }
} 