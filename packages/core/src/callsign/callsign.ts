/**
 * 呼号解析工具
 * 用于从FT8消息中解析呼号、国家和国旗信息
 */

import { FT8MessageParser } from '../parser/ft8-message-parser.js';
import { FT8MessageType } from '@tx5dr/contracts';
import dxccData from './dxcc.json' with { type: 'json' };

// 中文地名映射表
const COUNTRY_ZH_MAP: Record<string, string> = {
  'Canada': '加拿大',
  'Asiatic Russia': '俄罗斯',
  'Afghanistan': '阿富汗',
  'Agaléga and Saint Brandon': '阿加莱加和圣布兰登',
  'Åland Islands': '奥兰群岛',
  'Alaska': '阿拉斯加',
  'Albania': '阿尔巴尼亚',
  'Aldabra': '阿尔达布拉',
  'American Samoa': '美属萨摩亚',
  'Andorra': '安道尔',
  'Angola': '安哥拉',
  'Anguilla': '安圭拉',
  'Antarctica': '南极洲',
  'Antigua and Barbuda': '安提瓜和巴布达',
  'Argentina': '阿根廷',
  'Armenia': '亚美尼亚',
  'Aruba': '阿鲁巴',
  'Australia': '澳大利亚',
  'Austria': '奥地利',
  'Azerbaijan': '阿塞拜疆',
  'Bahamas': '巴哈马',
  'Bahrain': '巴林',
  'Bangladesh': '孟加拉国',
  'Barbados': '巴巴多斯',
  'Belarus': '白俄罗斯',
  'Belgium': '比利时',
  'Belize': '伯利兹',
  'Benin': '贝宁',
  'Bermuda': '百慕大',
  'Bhutan': '不丹',
  'Bolivia': '玻利维亚',
  'Bosnia and Herzegovina': '波斯尼亚和黑塞哥维那',
  'Botswana': '博茨瓦纳',
  'Brazil': '巴西',
  'British Virgin Islands': '英属维尔京群岛',
  'Brunei': '文莱',
  'Bulgaria': '保加利亚',
  'Burkina Faso': '布基纳法索',
  'Burundi': '布隆迪',
  'Cambodia': '柬埔寨',
  'Cameroon': '喀麦隆',
  'Cape Verde': '佛得角',
  'Cayman Islands': '开曼群岛',
  'Central African Republic': '中非共和国',
  'Chad': '乍得',
  'Chile': '智利',
  'China': '中国',
  'Christmas Island': '圣诞岛',
  'Cocos (Keeling) Islands': '科科斯群岛',
  'Colombia': '哥伦比亚',
  'Comoros': '科摩罗',
  'Congo': '刚果',
  'Cook Islands': '库克群岛',
  'Costa Rica': '哥斯达黎加',
  'Croatia': '克罗地亚',
  'Cuba': '古巴',
  'Cyprus': '塞浦路斯',
  'Czech Republic': '捷克共和国',
  'Corsica': '科西嘉岛',
  'Denmark': '丹麦',
  'Djibouti': '吉布提',
  'Dominica': '多米尼克',
  'Dominican Republic': '多米尼加共和国',
  'Ecuador': '厄瓜多尔',
  'Egypt': '埃及',
  'El Salvador': '萨尔瓦多',
  'Equatorial Guinea': '赤道几内亚',
  'Eritrea': '厄立特里亚',
  'Estonia': '爱沙尼亚',
  'Ethiopia': '埃塞俄比亚',
  'European Russia': '俄罗斯',
  'East Malaysia': '东马来西亚',
  'West Malaysia': '西马来西亚',
  'Falkland Islands': '福克兰群岛',
  'Faroe Islands': '法罗群岛',
  'Fiji': '斐济',
  'Finland': '芬兰',
  'France': '法国',
  'French Guiana': '法属圭亚那',
  'French Polynesia': '法属波利尼西亚',
  'Gabon': '加蓬',
  'Gambia': '冈比亚',
  'Georgia': '格鲁吉亚',
  'Germany': '德国',
  'Ghana': '加纳',
  'Gibraltar': '直布罗陀',
  'Greece': '希腊',
  'Greenland': '格陵兰',
  'Grenada': '格林纳达',
  'Guadeloupe': '瓜德罗普',
  'Guam': '关岛',
  'Guatemala': '危地马拉',
  'Guinea': '几内亚',
  'Guinea-Bissau': '几内亚比绍',
  'Guyana': '圭亚那',
  'Gilbert Islands': '吉尔伯特群岛',
  'Haiti': '海地',
  'Honduras': '洪都拉斯',
  'Hong Kong': '中国香港',
  'Hungary': '匈牙利',
  'Hawaii': '夏威夷',
  'Iceland': '冰岛',
  'India': '印度',
  'Indonesia': '印度尼西亚',
  'Iran': '伊朗',
  'Iraq': '伊拉克',
  'Ireland': '爱尔兰',
  'Israel': '以色列',
  'Italy': '意大利',
  'Jamaica': '牙买加',
  'Japan': '日本',
  'Jordan': '约旦',
  'Kazakhstan': '哈萨克斯坦',
  'Kenya': '肯尼亚',
  'Kiribati': '基里巴斯',
  'Korea': '韩国',
  'Kuwait': '科威特',
  'Kyrgyzstan': '吉尔吉斯斯坦',
  'Laos': '老挝',
  'Latvia': '拉脱维亚',
  'Lebanon': '黎巴嫩',
  'Lesotho': '莱索托',
  'Liberia': '利比里亚',
  'Libya': '利比亚',
  'Liechtenstein': '列支敦士登',
  'Lithuania': '立陶宛',
  'Luxembourg': '卢森堡',
  'Macao': '中国澳门',
  'Macedonia': '马其顿',
  'Madagascar': '马达加斯加',
  'Malawi': '马拉维',
  'Malaysia': '马来西亚',
  'Maldives': '马尔代夫',
  'Mali': '马里',
  'Malta': '马耳他',
  'Marshall Islands': '马绍尔群岛',
  'Martinique': '马提尼克',
  'Mauritania': '毛里塔尼亚',
  'Mauritius': '毛里求斯',
  'Mayotte': '马约特',
  'Mexico': '墨西哥',
  'Micronesia': '密克罗尼西亚',
  'Moldova': '摩尔多瓦',
  'Monaco': '摩纳哥',
  'Mongolia': '蒙古',
  'Montenegro': '黑山',
  'Montserrat': '蒙特塞拉特',
  'Morocco': '摩洛哥',
  'Mozambique': '莫桑比克',
  'Myanmar': '缅甸',
  'Namibia': '纳米比亚',
  'Nauru': '瑙鲁',
  'Nepal': '尼泊尔',
  'Netherlands': '荷兰',
  'Netherlands Antilles': '荷属安的列斯',
  'New Caledonia': '新喀里多尼亚',
  'New Zealand': '新西兰',
  'Nicaragua': '尼加拉瓜',
  'Niger': '尼日尔',
  'Nigeria': '尼日利亚',
  'Niue': '纽埃',
  'Norfolk Island': '诺福克岛',
  'Northern Mariana Islands': '北马里亚纳群岛',
  'Norway': '挪威',
  'Oman': '阿曼',
  'Pakistan': '巴基斯坦',
  'Palau': '帕劳',
  'Palestine': '巴勒斯坦',
  'Panama': '巴拿马',
  'Papua New Guinea': '巴布亚新几内亚',
  'Paraguay': '巴拉圭',
  'Peru': '秘鲁',
  'Philippines': '菲律宾',
  'Pitcairn': '皮特凯恩',
  'Poland': '波兰',
  'Portugal': '葡萄牙',
  'Puerto Rico': '波多黎各',
  'Qatar': '卡塔尔',
  'Réunion': '留尼汪',
  'Romania': '罗马尼亚',
  'Russian Federation': '俄罗斯',
  'Rwanda': '卢旺达',
  'Saint Helena': '圣赫勒拿',
  'Saint Kitts and Nevis': '圣基茨和尼维斯',
  'Saint Lucia': '圣卢西亚',
  'Saint Pierre and Miquelon': '圣皮埃尔和密克隆',
  'Saint Vincent and the Grenadines': '圣文森特和格林纳丁斯',
  'Samoa': '萨摩亚',
  'San Marino': '圣马力诺',
  'Sao Tome and Principe': '圣多美和普林西比',
  'Saudi Arabia': '沙特阿拉伯',
  'Senegal': '塞内加尔',
  'Serbia': '塞尔维亚',
  'Seychelles': '塞舌尔',
  'Sierra Leone': '塞拉利昂',
  'Singapore': '新加坡',
  'Slovakia': '斯洛伐克',
  'Slovenia': '斯洛文尼亚',
  'Solomon Islands': '所罗门群岛',
  'Somalia': '索马里',
  'South Africa': '南非',
  'South Georgia and the South Sandwich Islands': '南乔治亚和南桑威奇群岛',
  'Spain': '西班牙',
  'Sri Lanka': '斯里兰卡',
  'Sudan': '苏丹',
  'Suriname': '苏里南',
  'Svalbard and Jan Mayen': '斯瓦尔巴和扬马延',
  'Swaziland': '斯威士兰',
  'Sweden': '瑞典',
  'Switzerland': '瑞士',
  'Syrian Arab Republic': '叙利亚',
  'South Korea': '韩国',
  'Taiwan': '中国台湾',
  'Tajikistan': '塔吉克斯坦',
  'Tanzania': '坦桑尼亚',
  'Thailand': '泰国',
  'Timor-Leste': '东帝汶',
  'Togo': '多哥',
  'Tokelau': '托克劳',
  'Tonga': '汤加',
  'Trinidad and Tobago': '特立尼达和多巴哥',
  'Tunisia': '突尼斯',
  'Turkey': '土耳其',
  'Turkmenistan': '土库曼斯坦',
  'Turks and Caicos Islands': '特克斯和凯科斯群岛',
  'Tuvalu': '图瓦卢',
  'Uganda': '乌干达',
  'Ukraine': '乌克兰',
  'United Arab Emirates': '阿联酋',
  'United Kingdom': '英国',
  'United States': '美国',
  'United States of America': '美国',
  'States of America': '美国',
  'Uruguay': '乌拉圭',
  'Uzbekistan': '乌兹别克斯坦',
  'Vanuatu': '瓦努阿图',
  'Venezuela': '委内瑞拉',
  'Vietnam': '越南',
  'Virgin Islands, British': '英属维尔京群岛',
  'Virgin Islands, U.S.': '美属维尔京群岛',
  'Wallis and Futuna': '瓦利斯和富图纳',
  'Western Sahara': '西撒哈拉',
  'Yemen': '也门',
  'Zambia': '赞比亚',
  'Zimbabwe': '津巴布韦'
};

export interface CallsignInfo {
  callsign: string;
  country?: string;
  countryZh?: string;
  flag?: string;
  prefix?: string;
  entityCode?: number;
  continent?: string[];
  cqZone?: number;
  ituZone?: number;
}

export interface FT8LocationInfo {
  country?: string;
  countryZh?: string;
  flag?: string;
  callsign?: string;
  grid?: string;
}

export interface GridCoordinates {
  lat: number;
  lon: number;
}

// 中国呼号分区信息
interface ChinaRegionInfo {
  regionCode: number;
  provinces: string[];
  suffixRanges: Array<{
    start: string;
    end: string;
  }>;
}

// 中国呼号解析器
class ChinaCallsignParser {
  private static readonly REGION_INFO: ChinaRegionInfo[] = [
    {
      regionCode: 1,
      provinces: ['北京'],
      suffixRanges: [{ start: 'AA', end: 'XZ' }]
    },
    {
      regionCode: 2,
      provinces: ['黑龙江', '吉林', '辽宁'],
      suffixRanges: [
        { start: 'AA', end: 'HZ' },
        { start: 'IA', end: 'PZ' },
        { start: 'QA', end: 'XZ' }
      ]
    },
    {
      regionCode: 3,
      provinces: ['天津', '内蒙古', '河北', '山西'],
      suffixRanges: [
        { start: 'AA', end: 'FZ' },
        { start: 'GA', end: 'LZ' },
        { start: 'MA', end: 'RZ' },
        { start: 'SA', end: 'XZ' }
      ]
    },
    {
      regionCode: 4,
      provinces: ['上海', '山东', '江苏'],
      suffixRanges: [
        { start: 'AA', end: 'HZ' },
        { start: 'IA', end: 'PZ' },
        { start: 'QA', end: 'XZ' }
      ]
    },
    {
      regionCode: 5,
      provinces: ['浙江', '江西', '福建'],
      suffixRanges: [
        { start: 'AA', end: 'HZ' },
        { start: 'IA', end: 'PZ' },
        { start: 'QA', end: 'XZ' }
      ]
    },
    {
      regionCode: 6,
      provinces: ['安徽', '河南', '湖北'],
      suffixRanges: [
        { start: 'AA', end: 'HZ' },
        { start: 'IA', end: 'PZ' },
        { start: 'QA', end: 'XZ' }
      ]
    },
    {
      regionCode: 7,
      provinces: ['湖南', '广东', '广西', '海南'],
      suffixRanges: [
        { start: 'AA', end: 'HZ' },
        { start: 'IA', end: 'PZ' },
        { start: 'QA', end: 'XZ' },
        { start: 'YA', end: 'ZZ' }
      ]
    },
    {
      regionCode: 8,
      provinces: ['四川', '重庆', '贵州', '云南'],
      suffixRanges: [
        { start: 'AA', end: 'FZ' },
        { start: 'GA', end: 'LZ' },
        { start: 'MA', end: 'RZ' },
        { start: 'SA', end: 'XZ' }
      ]
    },
    {
      regionCode: 9,
      provinces: ['陕西', '甘肃', '宁夏', '青海'],
      suffixRanges: [
        { start: 'AA', end: 'FZ' },
        { start: 'GA', end: 'LZ' },
        { start: 'MA', end: 'RZ' },
        { start: 'SA', end: 'XZ' }
      ]
    },
    {
      regionCode: 0,
      provinces: ['新疆', '西藏'],
      suffixRanges: [
        { start: 'AA', end: 'FZ' },
        { start: 'GA', end: 'LZ' }
      ]
    }
  ];

  private static readonly CHINA_PREFIX = 'B';
  private static readonly CHINA_STATION_TYPES = ['G', 'H', 'I', 'D', 'A', 'B', 'C', 'E', 'F', 'K', 'L', 'R'];

  public static parseChinaCallsign(callsign: string): { country: string; countryZh: string } | null {
    if (!callsign || !callsign.startsWith(this.CHINA_PREFIX)) {
      return null;
    }

    // 解析呼号结构
    const match = callsign.match(/^B([GHIDABCEFKL])([0-9])([A-Z]{2,3})$/);
    if (!match) {
      return null;
    }

    const [, stationType, regionCode, suffix] = match;

    // 验证电台类型
    if (!this.CHINA_STATION_TYPES.includes(stationType)) {
      return null;
    }

    // 查找对应的区域信息
    const regionInfo = this.REGION_INFO.find(r => r.regionCode === parseInt(regionCode));
    if (!regionInfo) {
      return null;
    }

    // 验证后缀是否在有效范围内
    const isValidSuffix = regionInfo.suffixRanges.some(range => {
      const suffixUpper = suffix.toUpperCase();
      return suffixUpper >= range.start && suffixUpper <= range.end;
    });

    if (!isValidSuffix) {
      return null;
    }

    // 根据后缀范围确定具体省份
    let provinceIndex = 0;
    for (const range of regionInfo.suffixRanges) {
      if (suffix.toUpperCase() >= range.start && suffix.toUpperCase() <= range.end) {
        break;
      }
      provinceIndex++;
    }

    const province = regionInfo.provinces[provinceIndex];
    if (!province) {
      return null;
    }

    return {
      country: 'China',
      countryZh: `中国·${province}`
    };
  }
}

// DXCC 数据索引
class DXCCIndex {
  private entityMap: Map<number, any>;
  private prefixRegexMap: Map<RegExp, any>;
  private prefixMap: Map<string, any>;
  private countryNameMap: Map<string, any>;

  constructor() {
    this.entityMap = new Map();
    this.prefixRegexMap = new Map();
    this.prefixMap = new Map();
    this.countryNameMap = new Map();

    // 初始化索引
    this.initializeIndex();
  }

  private initializeIndex() {
    dxccData.dxcc.forEach(entity => {
      if (entity.deleted) return;

      // 实体代码索引
      this.entityMap.set(entity.entityCode, entity);

      // 国家名称索引
      this.countryNameMap.set(entity.name, entity);

      // 前缀正则表达式索引
      if (entity.prefixRegex) {
        try {
          const regex = new RegExp(entity.prefixRegex);
          this.prefixRegexMap.set(regex, entity);
        } catch (e) {
          console.warn(`Invalid prefix regex for ${entity.name}: ${entity.prefixRegex}`);
        }
      }

      // 前缀索引
      if (entity.prefix) {
        entity.prefix.split(',').forEach(prefix => {
          this.prefixMap.set(prefix.trim(), entity);
        });
      }
    });
  }

  public findEntityByCallsign(callsign: string): any {
    if (!callsign) return null;

    const upperCallsign = callsign.toUpperCase();

    // 首先尝试中国呼号解析
    const chinaInfo = ChinaCallsignParser.parseChinaCallsign(upperCallsign);
    if (chinaInfo) {
      return {
        name: chinaInfo.country,
        countryZh: chinaInfo.countryZh,
        flag: '🇨🇳',
        prefix: upperCallsign.substring(0, 2),
        entityCode: 318, // 中国的 DXCC 实体代码
        continent: ['AS'],
        cqZone: 24,
        ituZone: 44
      };
    }

    // 1. 首先尝试前缀匹配
    for (const [prefix, entity] of this.prefixMap) {
      if (upperCallsign.startsWith(prefix)) {
        return {
          ...entity,
          countryZh: COUNTRY_ZH_MAP[entity.name] || entity.name
        };
      }
    }

    // 2. 然后尝试正则表达式匹配
    for (const [regex, entity] of this.prefixRegexMap) {
      if (regex.test(upperCallsign)) {
        return {
          ...entity,
          countryZh: COUNTRY_ZH_MAP[entity.name] || entity.name
        };
      }
    }

    return null;
  }

  public getEntityByCode(code: number): any {
    return this.entityMap.get(code);
  }

  public getEntityByName(name: string): any {
    return this.countryNameMap.get(name);
  }

  public getAllEntities(): any[] {
    return Array.from(this.entityMap.values());
  }
}

// 创建全局索引实例
const dxccIndex = new DXCCIndex();

/**
 * 根据呼号查找国家信息
 * @param callsign 呼号
 * @returns 呼号信息，如果找不到则返回undefined
 */
export function getCallsignInfo(callsign: string): CallsignInfo | undefined {
  if (!callsign) return undefined;

  const entity = dxccIndex.findEntityByCallsign(callsign);
  if (!entity) return undefined;

  return {
    callsign,
    country: entity.name,
    countryZh: entity.countryZh,
    flag: entity.flag,
    prefix: callsign.match(/^[A-Z]+/)?.[0],
    entityCode: entity.entityCode,
    continent: entity.continent,
    cqZone: entity.cqZone,
    ituZone: entity.ituZone
  };
}

/**
 * 提取呼号前缀
 * @param callsign 呼号
 * @returns 前缀
 */
export function extractCallsignPrefix(callsign: string): string {
  if (!callsign) return '';
  
  // 移除常见的后缀标识符（如 /P, /M, /MM, /AM, /QRP等）
  const cleanCallsign = callsign.split('/')[0].toUpperCase();
  
  // 查找最长匹配的前缀
  let longestMatch = '';
  const allEntities = dxccIndex.getAllEntities();
  
  for (const entity of allEntities) {
    if (entity.prefix) {
      const prefixes = entity.prefix.split(',').map((p: string) => p.trim());
      for (const prefix of prefixes) {
        if (cleanCallsign.startsWith(prefix) && prefix.length > longestMatch.length) {
          longestMatch = prefix;
        }
      }
    }
  }
  
  // 如果没有找到匹配的前缀，尝试提取前1-2个字符作为前缀
  if (!longestMatch) {
    // 如果第二个字符是数字，通常前缀只有一个字母
    if (cleanCallsign.length >= 2 && /\d/.test(cleanCallsign[1])) {
      longestMatch = cleanCallsign[0];
    } else if (cleanCallsign.length >= 2) {
      // 否则取前两个字符
      longestMatch = cleanCallsign.substring(0, 2);
    } else {
      longestMatch = cleanCallsign;
    }
  }
  
  return longestMatch;
}

/**
 * 提取呼号前缀（向后兼容别名）
 * @param callsign 呼号
 * @returns 前缀
 */
export const extractPrefix = extractCallsignPrefix;

/**
 * 验证呼号格式是否有效
 * @param callsign 呼号
 * @returns 是否有效
 */
export function isValidCallsign(callsign: string): boolean {
  if (!callsign || callsign.length < 3) return false;
  
  // 基本的呼号格式验证
  // 呼号通常包含字母和数字，可能有/分隔符
  const callsignPattern = /^[A-Z0-9]{1,3}[0-9][A-Z0-9]{1,4}(\/[A-Z0-9]+)?$/i;
  return callsignPattern.test(callsign);
}

/**
 * 根据频率获取频段
 * @param frequency 频率（Hz）
 * @returns 频段信息
 */
export function getBandFromFrequency(frequency: number): string {
  const freqMHz = frequency / 1000000;
  
  if (freqMHz >= 1.8 && freqMHz <= 2.0) return '160m';
  if (freqMHz >= 3.5 && freqMHz <= 4.0) return '80m';
  if (freqMHz >= 5.0 && freqMHz <= 5.5) return '60m';
  if (freqMHz >= 7.0 && freqMHz <= 7.3) return '40m';
  if (freqMHz >= 10.1 && freqMHz <= 10.15) return '30m';
  if (freqMHz >= 14.0 && freqMHz <= 14.35) return '20m';
  if (freqMHz >= 18.068 && freqMHz <= 18.168) return '17m';
  if (freqMHz >= 21.0 && freqMHz <= 21.45) return '15m';
  if (freqMHz >= 24.89 && freqMHz <= 24.99) return '12m';
  if (freqMHz >= 28.0 && freqMHz <= 29.7) return '10m';
  if (freqMHz >= 50 && freqMHz <= 54) return '6m';
  if (freqMHz >= 144 && freqMHz <= 148) return '2m';
  if (freqMHz >= 420 && freqMHz <= 450) return '70cm';
  
  return 'Unknown';
}

/**
 * 将网格定位符转换为经纬度坐标
 * @param grid 网格定位符（如 "FN31"）
 * @returns 经纬度坐标
 */
export function gridToCoordinates(grid: string): GridCoordinates | null {
  if (!grid || grid.length < 4) return null;
  
  const upperGrid = grid.toUpperCase();
  
  // 提取字段
  const lon1 = upperGrid.charCodeAt(0) - 65; // A=0, R=17
  const lat1 = upperGrid.charCodeAt(1) - 65; // A=0, R=17
  const lon2 = parseInt(upperGrid[2]);
  const lat2 = parseInt(upperGrid[3]);
  
  if (isNaN(lon2) || isNaN(lat2)) return null;
  
  // 计算经纬度
  let lon = (lon1 * 20 + lon2 * 2) - 180 + 1;
  let lat = (lat1 * 10 + lat2) - 90 + 0.5;
  
  // 如果有子网格（6位网格）
  if (grid.length >= 6) {
    const lon3 = upperGrid.charCodeAt(4) - 65;
    const lat3 = upperGrid.charCodeAt(5) - 65;
    lon += lon3 * 5 / 60;
    lat += lat3 * 2.5 / 60;
  }
  
  return { lat, lon };
}

/**
 * 计算网格距离（公里）
 * @param grid1 网格1
 * @param grid2 网格2
 * @returns 距离（公里）
 */
export function calculateGridDistance(grid1: string, grid2: string): number | null {
  const coord1 = gridToCoordinates(grid1);
  const coord2 = gridToCoordinates(grid2);
  
  if (!coord1 || !coord2) return null;
  
  return haversineDistance(coord1, coord2);
}

/**
 * 使用Haversine公式计算两点间的距离
 * @param coord1 坐标1
 * @param coord2 坐标2
 * @returns 距离（公里）
 */
function haversineDistance(
  coord1: GridCoordinates,
  coord2: GridCoordinates
): number {
  const R = 6371; // 地球半径（公里）
  const dLat = toRadians(coord2.lat - coord1.lat);
  const dLon = toRadians(coord2.lon - coord1.lon);
  
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRadians(coord1.lat)) * Math.cos(toRadians(coord2.lat)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * 角度转弧度
 * @param degrees 角度
 * @returns 弧度
 */
function toRadians(degrees: number): number {
  return degrees * (Math.PI / 180);
}

/**
 * 从FT8消息中解析位置信息
 * @param message FT8消息文本
 * @returns 位置信息
 */
export function parseFT8LocationInfo(message: string): FT8LocationInfo {
  const msg = FT8MessageParser.parseMessage(message);
  let callsignInfo;
  if (msg.type !== FT8MessageType.UNKNOWN && msg.type !== FT8MessageType.CUSTOM) {
    callsignInfo = getCallsignInfo(msg.senderCallsign);
  }
  
  if (!callsignInfo) return {};

  return {
    callsign: callsignInfo.callsign,
    country: callsignInfo.country,
    countryZh: callsignInfo.countryZh,
    flag: callsignInfo.flag
  };
}

/**
 * 从消息中解析国家名称
 * @param message FT8消息文本
 * @returns 国家名称，如果找不到则返回undefined
 */
export function parseCountryFromMessage(message: string): string | undefined {
  const locationInfo = parseFT8LocationInfo(message);
  return locationInfo.country;
}

/**
 * 从消息中解析国旗
 * @param message FT8消息文本
 * @returns 国旗，如果找不到则返回undefined
 */
export function parseCountryFlag(message: string): string | undefined {
  const locationInfo = parseFT8LocationInfo(message);
  return locationInfo.flag;
}

/**
 * 获取所有支持的前缀
 * @returns 前缀数组
 */
export function getSupportedPrefixes(): string[] {
  return Array.from(dxccIndex.getAllEntities())
    .filter(entity => !entity.deleted && entity.prefix)
    .flatMap(entity => entity.prefix.split(',').map((p: string) => p.trim()));
}

/**
 * 获取所有支持的国家
 * @returns 国家信息数组
 */
export function getSupportedCountries(): Array<{ country: string; flag: string; prefixes: string[] }> {
  return Array.from(dxccIndex.getAllEntities())
    .filter(entity => !entity.deleted)
    .map(entity => ({
      country: entity.name,
      flag: entity.flag,
      prefixes: entity.prefix ? entity.prefix.split(',').map((p: string) => p.trim()) : []
    }));
}

/**
 * 获取呼号的前缀信息
 * @param callsign 呼号
 * @returns 前缀信息
 */
export function getPrefixInfo(callsign: string): any | null {
  if (!callsign) return null;
  const entity = dxccIndex.findEntityByCallsign(callsign);
  return entity;
}

/**
 * 获取CQ分区
 * @param callsign 呼号
 * @returns CQ分区号
 */
export function getCQZone(callsign: string): number | null {
  const info = getCallsignInfo(callsign);
  return info?.cqZone || null;
}

/**
 * 获取ITU分区
 * @param callsign 呼号
 * @returns ITU分区号
 */
export function getITUZone(callsign: string): number | null {
  const info = getCallsignInfo(callsign);
  return info?.ituZone || null;
} 