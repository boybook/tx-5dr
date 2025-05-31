/**
 * 呼号解析工具
 * 用于从FT8消息中解析呼号、国家和国旗信息
 */

import { FT8MessageParser } from '../parser/ft8-message-parser.js';
import { FT8MessageType } from '@tx5dr/contracts';

export interface CallsignInfo {
  callsign: string;
  country?: string | undefined;
  flag?: string | undefined;
  prefix?: string | undefined;
}

/**
 * FT8消息位置信息
 */
export interface FT8LocationInfo {
  country?: string;
  countryZh?: string;
  flag?: string;
  callsign?: string;
  grid?: string;
}

/**
 * 呼号前缀到国家的映射表
 */
const CALLSIGN_PREFIX_MAP: Record<string, { country: string; flag: string; countryZh?: string }> = {
  // 日本
  'JA': { country: 'Japan', flag: '🇯🇵', countryZh: '日本' },
  'JH': { country: 'Japan', flag: '🇯🇵', countryZh: '日本' },
  'JR': { country: 'Japan', flag: '🇯🇵', countryZh: '日本' },
  'JE': { country: 'Japan', flag: '🇯🇵', countryZh: '日本' },
  'JF': { country: 'Japan', flag: '🇯🇵', countryZh: '日本' },
  'JG': { country: 'Japan', flag: '🇯🇵', countryZh: '日本' },
  'JI': { country: 'Japan', flag: '🇯🇵', countryZh: '日本' },
  'JJ': { country: 'Japan', flag: '🇯🇵', countryZh: '日本' },
  'JK': { country: 'Japan', flag: '🇯🇵', countryZh: '日本' },
  'JL': { country: 'Japan', flag: '🇯🇵', countryZh: '日本' },
  'JM': { country: 'Japan', flag: '🇯🇵', countryZh: '日本' },
  'JN': { country: 'Japan', flag: '🇯🇵', countryZh: '日本' },
  'JO': { country: 'Japan', flag: '🇯🇵', countryZh: '日本' },
  'JP': { country: 'Japan', flag: '🇯🇵', countryZh: '日本' },
  'JQ': { country: 'Japan', flag: '🇯🇵', countryZh: '日本' },
  'JS': { country: 'Japan', flag: '🇯🇵', countryZh: '日本' },
  
  // 中国
  'BG': { country: 'China', flag: '🇨🇳', countryZh: '中国' },
  'BD': { country: 'China', flag: '🇨🇳', countryZh: '中国' },
  'BA': { country: 'China', flag: '🇨🇳', countryZh: '中国' },
  'BB': { country: 'China', flag: '🇨🇳', countryZh: '中国' },
  'BC': { country: 'China', flag: '🇨🇳', countryZh: '中国' },
  'BE': { country: 'China', flag: '🇨🇳', countryZh: '中国' },
  'BF': { country: 'China', flag: '🇨🇳', countryZh: '中国' },
  'BH': { country: 'China', flag: '🇨🇳', countryZh: '中国' },
  'BI': { country: 'China', flag: '🇨🇳', countryZh: '中国' },
  'BJ': { country: 'China', flag: '🇨🇳', countryZh: '中国' },
  'BL': { country: 'China', flag: '🇨🇳', countryZh: '中国' },
  'BM': { country: 'China', flag: '🇨🇳', countryZh: '中国' },
  'BN': { country: 'China', flag: '🇨🇳', countryZh: '中国' },
  'BO': { country: 'China', flag: '🇨🇳', countryZh: '中国' },
  'BP': { country: 'China', flag: '🇨🇳', countryZh: '中国' },
  'BQ': { country: 'China', flag: '🇨🇳', countryZh: '中国' },
  'BR': { country: 'China', flag: '🇨🇳', countryZh: '中国' },
  'BS': { country: 'China', flag: '🇨🇳', countryZh: '中国' },
  'BT': { country: 'China', flag: '🇨🇳', countryZh: '中国' },
  'BU': { country: 'China', flag: '🇨🇳', countryZh: '中国' },
  'BV': { country: 'China', flag: '🇨🇳', countryZh: '中国' },
  'BW': { country: 'China', flag: '🇨🇳', countryZh: '中国' },
  'BX': { country: 'China', flag: '🇨🇳', countryZh: '中国' },
  'BY': { country: 'China', flag: '🇨🇳', countryZh: '中国' },
  'BZ': { country: 'China', flag: '🇨🇳', countryZh: '中国' },
  
  // 韩国
  'HL': { country: 'South Korea', flag: '🇰🇷', countryZh: '韩国' },
  'HM': { country: 'South Korea', flag: '🇰🇷', countryZh: '韩国' },
  'DS': { country: 'South Korea', flag: '🇰🇷', countryZh: '韩国' },
  'DT': { country: 'South Korea', flag: '🇰🇷', countryZh: '韩国' },
  
  // 澳大利亚
  'VK': { country: 'Australia', flag: '🇦🇺', countryZh: '澳大利亚' },
  'VH': { country: 'Australia', flag: '🇦🇺', countryZh: '澳大利亚' },
  'VI': { country: 'Australia', flag: '🇦🇺', countryZh: '澳大利亚' },
  'VJ': { country: 'Australia', flag: '🇦🇺', countryZh: '澳大利亚' },
  'VL': { country: 'Australia', flag: '🇦🇺', countryZh: '澳大利亚' },
  'VM': { country: 'Australia', flag: '🇦🇺', countryZh: '澳大利亚' },
  'VN': { country: 'Australia', flag: '🇦🇺', countryZh: '澳大利亚' },
  
  // 美国
  'W': { country: 'United States', flag: '🇺🇸', countryZh: '美国' },
  'K': { country: 'United States', flag: '🇺🇸', countryZh: '美国' },
  'N': { country: 'United States', flag: '🇺🇸', countryZh: '美国' },
  'AA': { country: 'United States', flag: '🇺🇸', countryZh: '美国' },
  'AB': { country: 'United States', flag: '🇺🇸', countryZh: '美国' },
  'AC': { country: 'United States', flag: '🇺🇸', countryZh: '美国' },
  'AD': { country: 'United States', flag: '🇺🇸', countryZh: '美国' },
  'AE': { country: 'United States', flag: '🇺🇸', countryZh: '美国' },
  'AF': { country: 'United States', flag: '🇺🇸', countryZh: '美国' },
  'AG': { country: 'United States', flag: '🇺🇸', countryZh: '美国' },
  'AH': { country: 'United States', flag: '🇺🇸', countryZh: '美国' },
  'AI': { country: 'United States', flag: '🇺🇸', countryZh: '美国' },
  'AJ': { country: 'United States', flag: '🇺🇸', countryZh: '美国' },
  'AK': { country: 'United States', flag: '🇺🇸', countryZh: '美国' },
  'AL': { country: 'United States', flag: '🇺🇸', countryZh: '美国' },
  'AM': { country: 'United States', flag: '🇺🇸', countryZh: '美国' },
  'AN': { country: 'United States', flag: '🇺🇸', countryZh: '美国' },
  'AO': { country: 'United States', flag: '🇺🇸', countryZh: '美国' },
  'AP': { country: 'United States', flag: '🇺🇸', countryZh: '美国' },
  'AQ': { country: 'United States', flag: '🇺🇸', countryZh: '美国' },
  'AR': { country: 'United States', flag: '🇺🇸', countryZh: '美国' },
  'AS': { country: 'United States', flag: '🇺🇸', countryZh: '美国' },
  'AT': { country: 'United States', flag: '🇺🇸', countryZh: '美国' },
  'AU': { country: 'United States', flag: '🇺🇸', countryZh: '美国' },
  'AV': { country: 'United States', flag: '🇺🇸', countryZh: '美国' },
  'AW': { country: 'United States', flag: '🇺🇸', countryZh: '美国' },
  'AX': { country: 'United States', flag: '🇺🇸', countryZh: '美国' },
  
  // 加拿大
  'VE': { country: 'Canada', flag: '🇨🇦', countryZh: '加拿大' },
  'VA': { country: 'Canada', flag: '🇨🇦', countryZh: '加拿大' },
  'VB': { country: 'Canada', flag: '🇨🇦', countryZh: '加拿大' },
  'VC': { country: 'Canada', flag: '🇨🇦', countryZh: '加拿大' },
  'VD': { country: 'Canada', flag: '🇨🇦', countryZh: '加拿大' },
  'VF': { country: 'Canada', flag: '🇨🇦', countryZh: '加拿大' },
  'VG': { country: 'Canada', flag: '🇨🇦', countryZh: '加拿大' },
  'VO': { country: 'Canada', flag: '🇨🇦', countryZh: '加拿大' },
  'VX': { country: 'Canada', flag: '🇨🇦', countryZh: '加拿大' },
  'VY': { country: 'Canada', flag: '🇨🇦', countryZh: '加拿大' },
  
  // 德国
  'DL': { country: 'Germany', flag: '🇩🇪', countryZh: '德国' },
  'DA': { country: 'Germany', flag: '🇩🇪', countryZh: '德国' },
  'DB': { country: 'Germany', flag: '🇩🇪', countryZh: '德国' },
  'DC': { country: 'Germany', flag: '🇩🇪', countryZh: '德国' },
  'DD': { country: 'Germany', flag: '🇩🇪', countryZh: '德国' },
  'DE': { country: 'Germany', flag: '🇩🇪', countryZh: '德国' },
  'DF': { country: 'Germany', flag: '🇩🇪', countryZh: '德国' },
  'DG': { country: 'Germany', flag: '🇩🇪', countryZh: '德国' },
  'DH': { country: 'Germany', flag: '🇩🇪', countryZh: '德国' },
  'DI': { country: 'Germany', flag: '🇩🇪', countryZh: '德国' },
  'DJ': { country: 'Germany', flag: '🇩🇪', countryZh: '德国' },
  'DK': { country: 'Germany', flag: '🇩🇪', countryZh: '德国' },
  'DM': { country: 'Germany', flag: '🇩🇪', countryZh: '德国' },
  'DN': { country: 'Germany', flag: '🇩🇪', countryZh: '德国' },
  'DO': { country: 'Germany', flag: '🇩🇪', countryZh: '德国' },
  'DP': { country: 'Germany', flag: '🇩🇪', countryZh: '德国' },
  'DQ': { country: 'Germany', flag: '🇩🇪', countryZh: '德国' },
  'DR': { country: 'Germany', flag: '🇩🇪', countryZh: '德国' },
  
  // 英国
  'G': { country: 'United Kingdom', flag: '🇬🇧', countryZh: '英国' },
  'M': { country: 'United Kingdom', flag: '🇬🇧', countryZh: '英国' },
  '2E': { country: 'United Kingdom', flag: '🇬🇧', countryZh: '英国' },
  
  // 法国
  'F': { country: 'France', flag: '🇫🇷', countryZh: '法国' },
  
  // 意大利
  'I': { country: 'Italy', flag: '🇮🇹', countryZh: '意大利' },
  
  // 俄罗斯
  'R': { country: 'Russia', flag: '🇷🇺', countryZh: '俄罗斯' },
  'U': { country: 'Russia', flag: '🇷🇺', countryZh: '俄罗斯' },
  
  // 巴西
  'PY': { country: 'Brazil', flag: '🇧🇷', countryZh: '巴西' },
  'PP': { country: 'Brazil', flag: '🇧🇷', countryZh: '巴西' },
  'PQ': { country: 'Brazil', flag: '🇧🇷', countryZh: '巴西' },
  'PR': { country: 'Brazil', flag: '🇧🇷', countryZh: '巴西' },
  'PS': { country: 'Brazil', flag: '🇧🇷', countryZh: '巴西' },
  'PT': { country: 'Brazil', flag: '🇧🇷', countryZh: '巴西' },
  'PU': { country: 'Brazil', flag: '🇧🇷', countryZh: '巴西' },
  'PV': { country: 'Brazil', flag: '🇧🇷', countryZh: '巴西' },
  'PW': { country: 'Brazil', flag: '🇧🇷', countryZh: '巴西' },
  'PX': { country: 'Brazil', flag: '🇧🇷', countryZh: '巴西' },
  
  // 阿根廷
  'LU': { country: 'Argentina', flag: '🇦🇷', countryZh: '阿根廷' },
  'L2': { country: 'Argentina', flag: '🇦🇷', countryZh: '阿根廷' },
  'L3': { country: 'Argentina', flag: '🇦🇷', countryZh: '阿根廷' },
  'L4': { country: 'Argentina', flag: '🇦🇷', countryZh: '阿根廷' },
  'L5': { country: 'Argentina', flag: '🇦🇷', countryZh: '阿根廷' },
  'L6': { country: 'Argentina', flag: '🇦🇷', countryZh: '阿根廷' },
  'L7': { country: 'Argentina', flag: '🇦🇷', countryZh: '阿根廷' },
  'L8': { country: 'Argentina', flag: '🇦🇷', countryZh: '阿根廷' },
  'L9': { country: 'Argentina', flag: '🇦🇷', countryZh: '阿根廷' },
};

/**
 * 从FT8消息中提取呼号
 * @param message FT8消息文本
 * @returns 提取到的呼号数组
 */
export function extractCallsigns(message: string): string[] {
  // FT8呼号的正则表达式：3-8个字符，包含字母和数字
  // 通常格式为：前缀(1-2个字母) + 数字 + 后缀(1-3个字母)
  const callsignRegex = /\b[A-Z0-9]{1,2}[0-9][A-Z0-9]{0,3}\b/g;
  const matches = message.match(callsignRegex) || [];
  
  // 过滤掉一些明显不是呼号的模式
  return matches.filter(match => {
    // 排除纯数字
    if (/^\d+$/.test(match)) return false;
    // 排除太短的匹配（少于3个字符）
    if (match.length < 3) return false;
    // 排除一些常见的非呼号词汇
    const excludeWords = ['CQ', 'DE', 'TNX', '73', 'RR73', 'RRR'];
    if (excludeWords.includes(match)) return false;
    
    return true;
  });
}

/**
 * 根据呼号前缀查找国家信息
 * @param callsign 呼号
 * @returns 国家信息，如果找不到则返回undefined
 */
export function getCountryInfoByCallsign(callsign: string): { country: string; flag: string; countryZh?: string } | undefined {
  if (!callsign) return undefined;
  
  const upperCallsign = callsign.toUpperCase();
  
  // 尝试匹配不同长度的前缀（从长到短）
  for (let i = Math.min(upperCallsign.length, 3); i >= 1; i--) {
    const prefix = upperCallsign.substring(0, i);
    if (CALLSIGN_PREFIX_MAP[prefix]) {
      return CALLSIGN_PREFIX_MAP[prefix];
    }
  }
  
  return undefined;
}

/**
 * 从FT8消息中解析呼号信息
 * @param message FT8消息文本
 * @returns 解析到的呼号信息数组
 */
export function parseCallsignInfo(message: string): CallsignInfo[] {
  const callsigns = extractCallsigns(message);
  
  return callsigns.map(callsign => {
    const countryInfo = getCountryInfoByCallsign(callsign);
    const prefix = callsign.match(/^[A-Z]+/)?.[0];
    
    return {
      callsign,
      country: countryInfo?.country,
      flag: countryInfo?.flag,
      prefix
    };
  });
}

/**
 * 从FT8消息中解析位置信息（国家和网格）
 * 根据FT8协议规则，优先取第二个呼号的国家信息
 * @param message FT8消息文本
 * @returns 位置信息对象
 */
export function parseFT8LocationInfo(message: string): FT8LocationInfo {
  const result: FT8LocationInfo = {};
  
  // 使用FT8消息解析器解析消息结构
  const parsedMessage = FT8MessageParser.parseMessage(message);
  
  if (parsedMessage.type === FT8MessageType.UNKNOWN) {
    // 如果解析失败，回退到简单的呼号提取
    const callsignInfos = parseCallsignInfo(message);
    if (callsignInfos.length > 0) {
      const firstCallsign = callsignInfos[0];
      if (firstCallsign) {
        if (firstCallsign.country) {
          result.country = firstCallsign.country;
        }
        if (firstCallsign.flag) {
          result.flag = firstCallsign.flag;
        }
        result.callsign = firstCallsign.callsign;
        
        // 获取中文国家名称
        const countryInfo = getCountryInfoByCallsign(firstCallsign.callsign);
        if (countryInfo?.countryZh) {
          result.countryZh = countryInfo.countryZh;
        }
      }
    }
    return result;
  }

  // 根据消息类型确定位置信息来源
  let targetCallsign: string | undefined;
  
  switch (parsedMessage.type) {
    case FT8MessageType.CQ:
      // CQ消息：位置信息来自发起者
      targetCallsign = parsedMessage.senderCallsign;
      break;
      
    case FT8MessageType.CALL:
    case FT8MessageType.SIGNAL_REPORT:
    case FT8MessageType.RRR:
    case FT8MessageType.SEVENTY_THREE:
      // 响应类消息：位置信息来自第二个呼号（响应者）
      targetCallsign = parsedMessage.targetCallsign;
      break;
      
    default:
      // 其他类型：尝试第二个呼号，如果没有则用第一个
      targetCallsign = 'targetCallsign' in parsedMessage ? parsedMessage.targetCallsign as string : 
                      'senderCallsign' in parsedMessage ? parsedMessage.senderCallsign as string : undefined;
      break;
  }

  // 获取目标呼号的国家信息
  if (targetCallsign) {
    const countryInfo = getCountryInfoByCallsign(targetCallsign);
    if (countryInfo) {
      result.country = countryInfo.country;
      result.flag = countryInfo.flag;
      result.callsign = targetCallsign;
      if (countryInfo.countryZh) {
        result.countryZh = countryInfo.countryZh;
      }
    }
  }

  // 添加网格信息（如果有）
  if ('grid' in parsedMessage && parsedMessage.grid) {
    result.grid = parsedMessage.grid;
  }

  return result;
}

/**
 * 从FT8消息中解析国家名称（兼容旧接口）
 * @param message FT8消息文本
 * @returns 第一个找到的国家名称，如果没有找到则返回undefined
 */
export function parseCountryFromMessage(message: string): string | undefined {
  const locationInfo = parseFT8LocationInfo(message);
  return locationInfo.country;
}

/**
 * 从FT8消息中解析国旗emoji（兼容旧接口）
 * @param message FT8消息文本
 * @returns 第一个找到的国旗emoji，如果没有找到则返回undefined
 */
export function parseCountryFlag(message: string): string | undefined {
  const locationInfo = parseFT8LocationInfo(message);
  return locationInfo.flag;
}

/**
 * 获取所有支持的呼号前缀
 * @returns 支持的呼号前缀数组
 */
export function getSupportedPrefixes(): string[] {
  return Object.keys(CALLSIGN_PREFIX_MAP);
}

/**
 * 获取所有支持的国家列表
 * @returns 支持的国家信息数组
 */
export function getSupportedCountries(): Array<{ country: string; flag: string; prefixes: string[] }> {
  const countryMap = new Map<string, { country: string; flag: string; prefixes: string[] }>();
  
  Object.entries(CALLSIGN_PREFIX_MAP).forEach(([prefix, info]) => {
    const key = `${info.country}-${info.flag}`;
    if (!countryMap.has(key)) {
      countryMap.set(key, {
        country: info.country,
        flag: info.flag,
        prefixes: []
      });
    }
    countryMap.get(key)!.prefixes.push(prefix);
  });
  
  return Array.from(countryMap.values()).sort((a, b) => a.country.localeCompare(b.country));
} 