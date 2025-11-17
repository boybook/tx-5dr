import { FT8Message, FT8MessageType } from '@tx5dr/contracts';

// 基础呼号正则表达式（更宽松的匹配）
const BASE_CALLSIGN_REGEX = /^[A-Z0-9]{1,6}$/;

// 完整呼号正则表达式（包括前缀和后缀）
const FULL_CALLSIGN_REGEX = /^[A-Z0-9]{1,8}(\/[A-Z0-9]{1,8})*$/;

// 网格定位正则表达式（4位或6位）
const GRID_REGEX = /^[A-R]{2}[0-9]{2}([A-X]{2})?$/;

// 信号报告正则表达式
const REPORT_REGEX = /^[+-]?\d{1,2}$/;

// FT8消息解析器类
export class FT8MessageParser {
  
  /**
   * 判断是否为标准呼号
   *
   * 根据 FT8 协议的 28-bit 编码规则：
   * 1. 找到最后一个（或唯一的）数字，将其对齐到第 3 位
   * 2. 数字前最多 2 个字符
   * 3. 数字后最多 3 个字符
   * 4. 数字后的字符必须都是字母（第 4-6 位只允许字母或空格）
   *
   * 示例：
   * - ✅ Z33Z → Z 3 3 Z _ _ (位置: 1字母, 2数字, 3数字, 4字母)
   * - ✅ 4U1ITU → 4 U 1 I T U (位置: 1数字, 2字母, 3数字, 4-6字母)
   * - ✅ BA1ABC → _ B A 1 A B C (位置: 1空格, 2字母, 3数字, 4-6字母)
   * - ❌ Z3Z3Z → Z 3 Z 3 Z (最后数字后有 2 个字符，但倒数第二个是数字)
   */
  private static isStandardCallsign(callsign: string): boolean {
    // 移除可能存在的 <>
    let cleanCallsign = callsign.replace(/[<>]/g, '');

    // 检查后缀：只允许标准后缀（如 /P, /1），不允许复合呼号（如 /K1ABC）
    const slashIndex = cleanCallsign.indexOf('/');
    if (slashIndex !== -1) {
      const suffix = cleanCallsign.substring(slashIndex + 1);
      // 标准后缀只能是单个数字或单个字母
      if (!/^[A-Z0-9]$/.test(suffix)) {
        return false; // 复合呼号，非标准
      }
      cleanCallsign = cleanCallsign.substring(0, slashIndex);
    }

    // 基本格式检查：2-6位，只包含字母和数字
    if (!/^[A-Z0-9]{2,6}$/.test(cleanCallsign)) {
      return false;
    }

    // 找到最后一个数字的位置（FT8 对齐规则）
    const lastDigitIndex = cleanCallsign.search(/\d(?=\D*$)/);
    if (lastDigitIndex === -1) {
      return false;
    }

    // 计算对齐后的位置
    const beforeDigit = lastDigitIndex; // 数字前的字符数
    const afterDigit = cleanCallsign.length - lastDigitIndex - 1; // 数字后的字符数

    // 检查对齐规则：数字前最多 2 个字符，数字后最多 3 个字符
    if (beforeDigit > 2 || afterDigit > 3) {
      return false;
    }

    // 检查数字后的字符必须都是字母（FT8 协议第 4-6 位不允许数字）
    const suffixAfterDigit = cleanCallsign.slice(lastDigitIndex + 1);
    if (suffixAfterDigit && !/^[A-Z]+$/.test(suffixAfterDigit)) {
      return false;
    }

    return true;
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
        return !!('grid' in message && message.grid);

      case FT8MessageType.CALL:
      case FT8MessageType.SIGNAL_REPORT:
      case FT8MessageType.ROGER_REPORT:
      case FT8MessageType.RRR:
      case FT8MessageType.SEVENTY_THREE:
        // 其他消息类型中，如果包含网格或报告，非标准呼号需要包裹
        return !!(('grid' in message && message.grid) || ('report' in message && message.report));

      default:
        return false;
    }
  }

  /**
   * 清理呼号，移除可能存在的尖括号
   * 尖括号只是FT8协议的格式标记，不应成为呼号数据的一部分
   */
  private static cleanCallsign(callsign: string): string {
    if (callsign.startsWith('<') && callsign.endsWith('>')) {
      return callsign.slice(1, -1);
    }
    return callsign;
  }

  /**
   * 解析FT8消息字符串
   * @param message 原始消息字符串
   * @returns 解析后的FT8消息对象
   */
  static parseMessage(message: string): FT8Message {
    const trimmedMessage = message.trim().toUpperCase();
    
    // 首先处理<...>格式
    const parts = trimmedMessage.split(/\s+/);
    const processedParts = parts.map(part => {
      // 如果是<...>格式，保持原样
      if (part.startsWith('<') && part.endsWith('>')) {
        return part;
      }
      // 如果是普通呼号，检查是否需要包裹
      if (this.isValidCallsign(part)) {
        return part;
      }
      return part;
    });

    // 检查CQ消息
    if (this.isCQMessage(processedParts)) {
      return this.parseCQMessage(processedParts, message);
    }

    // 检查73消息（优先于信号报告，避免73被误识别为报告）
    if (this.is73Message(processedParts)) {
      return this.parse73Message(processedParts, message);
    }

    // 检查信号报告消息（优先于响应消息，因为格式更具体）
    if (this.isSignalReportMessage(processedParts)) {
      return this.parseSignalReportMessage(processedParts, message);
    }

    // 检查确认消息（RRR/RR73，优先于响应消息）
    if (this.isConfirmationMessage(processedParts)) {
      return this.parseConfirmationMessage(processedParts, message);
    }

    // 检查响应消息（最后检查，因为格式最宽泛）
    if (this.isResponseMessage(processedParts)) {
      return this.parseResponseMessage(processedParts, message);
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
   * 格式: CQ [FLAG] CALLSIGN [GRID]
   * 说明: FLAG 常见为 DX/NA/EU/AS/AF/OC/SA/JA/TEST/POTA 等，仅由字母组成
   */
  private static parseCQMessage(parts: string[], _rawMessage: string): FT8Message {
    let callsignIndex = 1;
    let flag: string | undefined;

    // 连续吸收 CQ 后面出现的字母标记（不含数字，长度1-5），直到遇到有效呼号为止
    // 例如：CQ NA BI1ABC PM95、CQ EU BI1ABC、CQ TEST BG5DRB PL09
    const isLettersOnlyFlag = (token: string) => /^[A-Z]{1,5}$/.test(token);

    // 逐个检查可能的FLAG，但在遇到有效呼号时停止
    while (parts.length > callsignIndex && isLettersOnlyFlag(parts[callsignIndex]) && !this.isValidCallsign(parts[callsignIndex])) {
      // 仅保留第一个标记作为 flag（协议字段目前只有一个）
      if (!flag) flag = parts[callsignIndex];
      callsignIndex += 1;
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
      senderCallsign: this.cleanCallsign(callsign),
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
  private static parseResponseMessage(parts: string[], _rawMessage: string): FT8Message {
    const targetCallsign = parts[0];
    const senderCallsign = parts[1];

    if (!targetCallsign || !senderCallsign) {
      return {
        type: FT8MessageType.UNKNOWN
      };
    }

    const result: FT8Message = {
      type: FT8MessageType.CALL,
      senderCallsign: this.cleanCallsign(senderCallsign),
      targetCallsign: this.cleanCallsign(targetCallsign),
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
  private static parseSignalReportMessage(parts: string[], _rawMessage: string): FT8Message {
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
      senderCallsign: this.cleanCallsign(senderCallsign),
      targetCallsign: this.cleanCallsign(targetCallsign),
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
  private static parseConfirmationMessage(parts: string[], _rawMessage: string): FT8Message {
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
        senderCallsign: this.cleanCallsign(senderCallsign),
        targetCallsign: this.cleanCallsign(targetCallsign),
      };
    } else if (lastPart === 'RRR') {
      return {
        type: FT8MessageType.RRR,
        senderCallsign: this.cleanCallsign(senderCallsign),
        targetCallsign: this.cleanCallsign(targetCallsign),
      };
    } else if (/^R[+-]?\d{1,2}$/.test(lastPart)) {
      // R-01, R+05等，解析为ROGER_REPORT
      return {
        type: FT8MessageType.ROGER_REPORT,
        senderCallsign: this.cleanCallsign(senderCallsign),
        targetCallsign: this.cleanCallsign(targetCallsign),
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
  private static parse73Message(parts: string[], _rawMessage: string): FT8Message {
    const targetCallsign = parts[0];
    const senderCallsign = parts[1];

    if (!targetCallsign || !senderCallsign) {
      return {
        type: FT8MessageType.UNKNOWN
      };
    }

    return {
      type: FT8MessageType.SEVENTY_THREE,
      senderCallsign: this.cleanCallsign(senderCallsign),
      targetCallsign: this.cleanCallsign(targetCallsign),
    };
  }

  /**
   * 验证呼号格式
   */
  private static isValidCallsign(callsign: string): boolean {
    if (!callsign) return false;
    
    // 如果是<...>格式，支持特殊情况
    if (callsign.startsWith('<') && callsign.endsWith('>')) {
      const innerCallsign = callsign.slice(1, -1);
      // 特殊情况：<...> 是FT8协议中的占位符
      if (innerCallsign === '...') {
        return true;
      }
      // 其他尖括号包裹的呼号需要符合基本格式
      return innerCallsign.length > 0 && FULL_CALLSIGN_REGEX.test(innerCallsign);
    }
    
    // 检查是否包含/
    if (callsign.includes('/')) {
      return this.isValidCallsignWithSlash(callsign);
    }
    
    // 基本呼号格式检查
    return this.isBasicValidCallsign(callsign);
  }

  /**
   * 验证带有斜杠的呼号格式
   * 支持前缀/基础呼号 和 基础呼号/后缀 两种格式
   */
  private static isValidCallsignWithSlash(callsign: string): boolean {
    const parts = callsign.split('/');
    if (parts.length !== 2) return false;
    
    const [part1, part2] = parts;
    
    // 检查每个部分都不为空且符合基本格式
    if (!part1 || !part2 || !BASE_CALLSIGN_REGEX.test(part1) || !BASE_CALLSIGN_REGEX.test(part2)) {
      return false;
    }
    
    // 情况1：前缀/基础呼号（如 OY/K4LT）
    // 前缀通常是1-3个字符，基础呼号包含数字
    if (part1.length <= 3 && /\d/.test(part2)) {
      return true;
    }
    
    // 情况2：基础呼号/后缀（如 JA1ABC/1）
    // 基础呼号包含数字，后缀通常是1个字符或数字
    if (/\d/.test(part1) && part2.length <= 3) {
      return true;
    }
    
    // 情况3：基础呼号/移动标识（如 JA1ABC/MM）
    // 基础呼号包含数字，后缀是移动标识
    if (/\d/.test(part1) && /^(P|M|MM|AM|QRP|[0-9])$/.test(part2)) {
      return true;
    }
    
    return false;
  }

  /**
   * 验证基础呼号格式
   * 支持更广泛的呼号格式
   */
  private static isBasicValidCallsign(callsign: string): boolean {
    // 基本长度检查
    if (callsign.length < 3 || callsign.length > 8) return false;

    // 必须包含至少一个数字
    if (!/\d/.test(callsign)) return false;

    // 只能包含字母和数字
    if (!/^[A-Z0-9]+$/.test(callsign)) return false;

    // 数字不能在结尾(但允许在开头,如韩国的6K5SPI、6L等)
    if (/\d$/.test(callsign)) return false;

    return true;
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
        if (message.report !== undefined) {
          return `${wrapCallsign(message.targetCallsign)} ${wrapCallsign(message.senderCallsign)} ${this.generateSignalReport(message.report)}`;
        } else {
          return `${wrapCallsign(message.targetCallsign)} ${wrapCallsign(message.senderCallsign)}`;
        }
      case FT8MessageType.ROGER_REPORT:
        if (message.report !== undefined) {
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
