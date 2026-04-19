/**
 * 呼号解析工具
 * 用于从FT8消息中解析呼号、国家和国旗信息
 */

import { FT8MessageParser } from '../parser/ft8-message-parser.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('Callsign');
import { FT8MessageType } from '@tx5dr/contracts';
import dxccData from './dxcc.json' with { type: 'json' };

// 中文地名映射表
const COUNTRY_ZH_MAP: Record<string, string> = {
  'Canada': '加拿大',
  'Asiatic Russia': '俄罗斯·亚洲',
  'European Russia': '俄罗斯·欧洲',
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
  'East Malaysia': '东马来西亚',
  'West Malaysia': '西马来西亚',
  'Falkland Islands': '福克兰群岛',
  'Faroe Islands': '法罗群岛',
  'Fiji': '斐济',
  'Finland': '芬兰',
  'France': '法国',
  'Amsterdam and Saint-Paul Islands': '阿姆斯特丹岛和圣保罗岛',
  'Andaman and Nicobar Islands': '安达曼-尼科巴群岛',
  'Annobón': '安诺邦岛',
  'Ascension Island': '阿森松岛',
  'Azores': '亚速尔群岛',
  'Balearic Islands': '巴利阿里群岛',
  'Banaba': '巴纳巴岛',
  'Bonaire': '博奈尔',
  'Bouvet Island': '布韦岛',
  'Brunei Darussalam': '文莱',
  'British Virgin Is.': '英属维尔京群岛',
  'Canary Islands': '加那利群岛',
  'Ceuta and Melilla': '休达和梅利利亚',
  'Chagos Islands': '查戈斯群岛',
  'Chatham Islands': '查塔姆群岛',
  'Chesterfield Islands': '切斯特菲尔德群岛',
  'Clipperton Island': '克利珀顿岛',
  'Cocos Island': '科科斯岛',
  'Conway Reef': '康威礁',
  'Crete': '克里特岛',
  'Crozet Islands': '克罗泽群岛',
  'Curaçao': '库拉索',
  "Côte d'Ivoire": '科特迪瓦',
  'Bosnia-Herzegovina': '波斯尼亚-黑塞哥维那',
  "Democratic People's Republic of Korea": '朝鲜',
  'Democratic Republic of the Congo': '刚果民主共和国',
  'Desventuradas Islands': '绝望群岛',
  'Desecheo Island': '德塞切奥岛',
  'Dodecanese': '多德卡尼斯群岛',
  'Ducie Island': '杜西岛',
  'French Guiana': '法属圭亚那',
  'French Polynesia': '法属波利尼西亚',
  'England': '英格兰',
  'Easter Island': '复活节岛',
  'Eswatini': '斯威士兰',
  'Fernando de Noronha': '费尔南多-迪诺罗尼亚',
  'Franz Josef Land': '弗朗茨约瑟夫地',
  'Galápagos Islands': '加拉帕戈斯群岛',
  'Glorioso Islands': '格洛里奥索群岛',
  'Guantanamo Bay': '关塔那摩湾',
  'Guernsey': '根西岛',
  'Heard Island and McDonald Islands': '赫德岛和麦克唐纳群岛',
  'Howland and Baker Islands': '豪兰岛和贝克岛',
  'International Telecommunication Union Headquarters': '国际电联总部',
  'Isla de Aves': '阿维斯岛',
  'Isle of Man': '马恩岛',
  'Jan Mayen': '扬马延岛',
  'Jersey': '泽西岛',
  'Johnston Atoll': '约翰斯顿环礁',
  'Juan Fernández Islands': '胡安·费尔南德斯群岛',
  'Kaliningrad': '加里宁格勒',
  'Kerguelen Islands': '凯尔盖朗群岛',
  'Kermadec Islands': '克马德克群岛',
  'Kosovo': '科索沃',
  'Kure Atoll': '库雷环礁',
  'Lakshadweep': '拉克沙群岛',
  'Line Islands': '莱恩群岛',
  'Lord Howe Island': '豪勋爵岛',
  'Macquarie Island': '麦夸里岛',
  'Madeira': '马德拉群岛',
  'Malpelo Island': '马尔佩洛岛',
  'Mariana Islands': '马里亚纳群岛',
  'Märket Island': '梅凯特岛',
  'Mellish Reef': '梅利什礁',
  'Midway Atoll': '中途岛',
  'Minami-Tori-shima': '南鸟岛',
  'Mount Athos': '阿陀斯山',
  'Navassa Island': '纳瓦萨岛',
  'New Zealand Subantarctic Islands': '新西兰亚南极群岛',
  'North Cook Islands': '北库克群岛',
  'North Macedonia': '北马其顿',
  'Northern Ireland': '北爱尔兰',
  'Ogasawara Islands': '小笠原群岛',
  'Palmyra and Jarvis Islands': '帕尔米拉和贾维斯群岛',
  'Peter I Island': '彼得一世岛',
  'Phoenix Islands': '菲尼克斯群岛',
  'Pitcairn Islands': '皮特凯恩群岛',
  'Prince Edward and Marion Islands': '爱德华王子群岛和马里昂岛',
  'Pratas Island': '东沙岛',
  'Republic of the Congo': '刚果共和国',
  'Revillagigedo Islands': '雷维利亚希赫多群岛',
  'Rodrigues Island': '罗德里格斯岛',
  'Rotuma Island': '罗图马岛',
  'Saba and Sint Eustatius': '萨巴和圣尤斯特歇',
  'Sable Island': '萨布尔岛',
  'Saint Barthélemy': '圣巴泰勒米',
  'Saint Martin': '圣马丁',
  'Saint Peter and Saint Paul Archipelago': '圣彼得和圣保罗岩礁',
  'San Andrés and Providencia': '圣安德烈斯和普罗维登西亚',
  'Sardinia': '撒丁岛',
  'Scarborough Shoal': '黄岩岛',
  'Scotland': '苏格兰',
  'Sint Maarten': '荷属圣马丁',
  'South Cook Islands': '南库克群岛',
  'South Georgia Island': '南乔治亚岛',
  'South Orkney Islands': '南奥克尼群岛',
  'South Sandwich Islands': '南桑威奇群岛',
  'South Shetland Islands': '南设得兰群岛',
  'South Sudan': '南苏丹',
  'Sovereign Base Areas of Akrotiri and Dhekelia': '阿克罗蒂里与德凯利亚主权基地区',
  'Sovereign Military Order of Malta': '马耳他主权军事修会',
  'Spratly Islands': '南沙群岛',
  'St. Helena': '圣赫勒拿',
  'St. Paul Island': '圣保罗岛',
  'Swains Island': '斯韦恩斯岛',
  'Svalbard': '斯瓦尔巴群岛',
  'Syria': '叙利亚',
  'Temotu Province': '泰莫图省',
  'The Gambia': '冈比亚',
  'Austral Islands': '奥斯特拉尔群岛',
  'Marquesas Islands': '马克萨斯群岛',
  'Trindade and Martin Vaz': '特林达德和马廷瓦斯群岛',
  'Tristan da Cunha and Gough Islands': '特里斯坦-达库尼亚和戈夫岛',
  'Tromelin Island': '特罗梅林岛',
  'US Virgin Islands': '美属维尔京群岛',
  'United Nations Headquarters': '联合国总部',
  'Vatican': '梵蒂冈',
  'Viet Nam': '越南',
  'Wales': '威尔士',
  'Wake Island': '威克岛',
  'Wallis and Futuna Islands': '瓦利斯和富图纳群岛',
  'Willis Island': '威利斯岛',
  'Algeria': '阿尔及利亚',
  'Republic of Korea': '韩国',
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
  'Juan de Nova and Europa Islands': '胡安德诺瓦和欧罗巴',
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

// 简单的 LRU 缓存实现（用于高频呼号/前缀查询）
class LRU<K, V> {
  private map: Map<K, V>;
  private limit: number;
  constructor(limit = 1000) {
    this.map = new Map();
    this.limit = limit;
  }
  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key)!;
    // 刷新最近使用
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }
  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.limit) {
      const firstKey = this.map.keys().next().value as K;
      this.map.delete(firstKey);
    }
  }
}

// DXCC 实体接口定义
interface DXCCEntity {
  entityCode: number;
  name: string;
  prefix?: string;
  prefixRegex?: string;
  flag?: string;
  countryCode?: string;
  continent?: string[];
  cqZone?: number;
  ituZone?: number;
  deleted?: boolean;
  countryZh?: string;
  countryEn?: string;
  validStart?: string;
  validEnd?: string;
}

export interface DXCCResolutionResult {
  entity: DXCCEntity | null;
  matchedPrefix?: string;
  confidence: 'exception' | 'prefix' | 'heuristic' | 'unknown';
  needsReview: boolean;
}

export const DXCC_RESOLVER_VERSION = '2026.04.14';

// 前缀Trie结构（字符图）
interface PrefixTrieNode {
  c: Map<string, PrefixTrieNode>; // children
  e?: DXCCEntity | DXCCEntity[]; // entity or entities at terminal (支持单个或多个实体)
  p?: string; // prefix at terminal
}
function createTrieNode(): PrefixTrieNode {
  return { c: new Map() };
}

export interface CallsignInfo {
  callsign: string;
  country?: string;
  countryZh?: string;
  countryEn?: string;
  countryCode?: string;
  flag?: string;
  prefix?: string;
  state?: string;
  stateConfidence?: 'high' | 'low';
  entityCode?: number;
  continent?: string[];
  cqZone?: number;
  ituZone?: number;
  dxccStatus?: 'current' | 'deleted' | 'unknown';
  dxccConfidence?: DXCCResolutionResult['confidence'];
  dxccNeedsReview?: boolean;
}

function normalizeDXCCDateBound(value?: string, endOfDay = false): number | null {
  if (!value) return null;
  const suffix = endOfDay ? 'T23:59:59.999Z' : 'T00:00:00.000Z';
  const parsed = new Date(`${value}${suffix}`).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function isEntityActiveAt(entity: DXCCEntity, timestamp: number): boolean {
  const start = normalizeDXCCDateBound(entity.validStart);
  const end = normalizeDXCCDateBound(entity.validEnd, true);
  if (start !== null && timestamp < start) return false;
  if (end !== null && timestamp > end) return false;
  return true;
}

function createCandidateCallsigns(callsign: string): string[] {
  const upper = callsign.toUpperCase().trim();
  if (!upper.includes('/')) {
    return [upper];
  }

  const seen = new Set<string>();
  const candidates: Array<{ value: string; index: number }> = [];
  const pushCandidate = (value: string) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    candidates.push({ value, index: candidates.length });
  };

  const segments = upper.split('/').map((segment) => segment.trim()).filter(Boolean);
  pushCandidate(upper);
  for (const segment of segments) {
    pushCandidate(segment);
  }

  const longest = segments
    .filter((segment) => /[A-Z]/.test(segment) && /\d/.test(segment))
    .sort((left, right) => right.length - left.length)[0];
  if (longest) {
    pushCandidate(longest);
  }

  candidates.sort((left, right) => {
    const leftPrefixLength = dxccIndex.getLongestPrefix(left.value)?.length ?? 0;
    const rightPrefixLength = dxccIndex.getLongestPrefix(right.value)?.length ?? 0;
    if (leftPrefixLength !== rightPrefixLength) {
      return rightPrefixLength - leftPrefixLength;
    }

    const leftRegexLike = left.value.includes('/') ? 1 : 0;
    const rightRegexLike = right.value.includes('/') ? 1 : 0;
    if (leftRegexLike !== rightRegexLike) {
      return rightRegexLike - leftRegexLike;
    }

    if (left.value.length !== right.value.length) {
      return left.value.length - right.value.length;
    }

    return left.index - right.index;
  });

  return candidates.map((candidate) => candidate.value);
}

export interface FT8LocationInfo {
  country?: string;
  countryZh?: string;
  countryEn?: string;
  countryCode?: string;
  flag?: string;
  state?: string;
  stateConfidence?: 'high' | 'low';
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

  private static readonly PROVINCE_EN_MAP: Record<string, string> = {
    '北京': 'Beijing', '黑龙江': 'Heilongjiang', '吉林': 'Jilin', '辽宁': 'Liaoning',
    '天津': 'Tianjin', '内蒙古': 'Inner Mongolia', '河北': 'Hebei', '山西': 'Shanxi',
    '上海': 'Shanghai', '江苏': 'Jiangsu', '山东': 'Shandong',
    '浙江': 'Zhejiang', '江西': 'Jiangxi', '福建': 'Fujian',
    '安徽': 'Anhui', '河南': 'Henan', '湖北': 'Hubei',
    '湖南': 'Hunan', '广东': 'Guangdong', '广西': 'Guangxi', '海南': 'Hainan',
    '四川': 'Sichuan', '重庆': 'Chongqing', '贵州': 'Guizhou', '云南': 'Yunnan',
    '陕西': 'Shaanxi', '甘肃': 'Gansu', '宁夏': 'Ningxia', '青海': 'Qinghai',
    '新疆': 'Xinjiang', '西藏': 'Tibet'
  };

  public static parseChinaCallsign(callsign: string): { country: string; countryZh: string; countryEn: string; countryCode: string } | null {
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

    const provinceEn = this.PROVINCE_EN_MAP[province] || province;
    return {
      country: 'China',
      countryZh: `中国·${province}`,
      countryEn: `China·${provinceEn}`,
      countryCode: 'CN'
    };
  }
}

interface JapanCallsignInfo {
  country: string;
  countryZh: string;
  countryEn: string;
  countryCode: string;
  matchedPrefix: string;
}

interface USStateInfo {
  state: string;
  confidence: 'high' | 'low';
}

// 日本呼号解析器（在当前 DXCC 为 Japan 时补充 call area）
class JapanCallsignParser {
  private static readonly STANDARD_AREA_REGEX = /^(J[A-S]|7J|8[JN])([0-9])/;
  private static readonly KANTO_SPECIAL_REGEX = /^(7[K-N])([1-4])/;

  private static readonly AREA_MAP: Record<string, string> = {
    '0': '信越',
    '1': '关东',
    '2': '东海',
    '3': '关西',
    '4': '中国地方',
    '5': '四国',
    '6': '九州/冲绳',
    '7': '东北',
    '8': '北海道',
    '9': '北陆'
  };

  private static readonly AREA_MAP_EN: Record<string, string> = {
    '0': 'Kōshinetsu', '1': 'Kantō',    '2': 'Tōkai',
    '3': 'Kansai',      '4': 'Chūgoku', '5': 'Shikoku',
    '6': 'Kyūshū',      '7': 'Tōhoku',  '8': 'Hokkaido', '9': 'Hokuriku'
  };

  private static extractPortableArea(callsign: string): string | null {
    const segments = callsign.split('/').map((segment) => segment.trim()).filter(Boolean);
    for (let i = segments.length - 1; i >= 1; i--) {
      if (/^[0-9]$/.test(segments[i])) {
        return segments[i];
      }
    }
    return null;
  }

  private static extractAssignedArea(baseCallsign: string): { area: string; matchedPrefix: string } | null {
    if (/^JD1/.test(baseCallsign)) {
      return null;
    }

    const kantoPortableSeries = baseCallsign.match(this.KANTO_SPECIAL_REGEX);
    if (kantoPortableSeries) {
      return {
        area: '1',
        matchedPrefix: kantoPortableSeries[1]
      };
    }

    const standardSeries = baseCallsign.match(this.STANDARD_AREA_REGEX);
    if (!standardSeries) {
      return null;
    }

    return {
      matchedPrefix: standardSeries[1],
      area: standardSeries[2]
    };
  }

  public static parseJapanCallsign(callsign: string): JapanCallsignInfo | null {
    if (!callsign) return null;
    const upper = callsign.toUpperCase().trim();
    const baseCallsign = extractBaseCallsign(upper);
    const assignedArea = this.extractAssignedArea(baseCallsign);
    if (!assignedArea) return null;

    const area = this.extractPortableArea(upper) || assignedArea.area;
    const region = this.AREA_MAP[area];
    if (!region) return null;

    const regionEn = this.AREA_MAP_EN[area] || region;
    return {
      country: 'Japan',
      countryZh: `日本·${region}`,
      countryEn: `Japan·${regionEn}`,
      countryCode: 'JP',
      matchedPrefix: assignedArea.matchedPrefix
    };
  }
}

// 俄罗斯呼号解析器（区分欧洲俄罗斯和亚洲俄罗斯）
class RussiaCallsignParser {
  // 俄罗斯呼号前缀：UA-UI 系列和 R 系列
  private static readonly RUSSIA_PREFIX_REGEX = /^(U[A-I]|R[A-Z0-9])/;

  /**
   * 解析俄罗斯呼号，区分欧洲和亚洲部分
   *
   * 规则说明:
   * 欧洲俄罗斯:
   * - UA1-7, UB1-7, UC1-7, UD1-7, UE1-7, UF1-7, UG1-7, UH1-7, UI1-7
   * - R0-7, RA0-7, RB0-7, ..., RZ0-7
   * - 特殊: UA2/UI2 带 F 或 K 后缀 = 加里宁格勒
   * - 特殊: R8/R9/UA8-9/UI8-9 带 F/G/X 开头的后缀 = 欧洲俄罗斯
   *
   * 亚洲俄罗斯:
   * - UA8-9-0, UB8-9-0, UC8-9-0, ..., UI8-9-0
   * - R8-9-0 系列（除特殊后缀外）
   */
  public static parseRussiaCallsign(callsign: string): { country: string; countryZh: string; countryEn: string; countryCode: string; entityCode: number; continent: string[]; cqZone: number; ituZone: number } | null {
    if (!callsign) return null;
    const upper = callsign.toUpperCase();

    // 检查是否为俄罗斯呼号
    if (!this.RUSSIA_PREFIX_REGEX.test(upper)) return null;

    // 提取数字和后缀
    const digitMatch = upper.match(/\d/);
    if (!digitMatch) return null;

    const digit = parseInt(digitMatch[0]);
    const digitIndex = upper.indexOf(digitMatch[0]);
    const suffix = digitIndex < upper.length - 1 ? upper.substring(digitIndex + 1) : '';

    // 判断是 UA-UI 系列还是 R 系列
    const isUASeries = /^U[A-I]/.test(upper);
    const isRSeries = /^R/.test(upper);

    if (!isUASeries && !isRSeries) return null;

    // 欧洲俄罗斯判定
    let isEuropean = false;

    if (isUASeries) {
      // UA-UI 系列
      if (digit >= 1 && digit <= 7) {
        isEuropean = true;
      } else if ((digit === 8 || digit === 9) && suffix.length > 0) {
        // 检查后缀是否以 F, G, X 开头（欧洲俄罗斯特例）
        const firstLetter = suffix[0];
        if (firstLetter === 'F' || firstLetter === 'G' || firstLetter === 'X') {
          isEuropean = true;
        }
      }
    } else if (isRSeries) {
      // R 系列（RA-RZ, R0-R9）
      if (digit >= 0 && digit <= 7) {
        isEuropean = true;
      } else if ((digit === 8 || digit === 9) && suffix.length > 0) {
        // 检查后缀是否以 F, G, X 开头
        const firstLetter = suffix[0];
        if (firstLetter === 'F' || firstLetter === 'G' || firstLetter === 'X') {
          isEuropean = true;
        }
      }
    }

    if (isEuropean) {
      // 欧洲俄罗斯
      return {
        country: 'European Russia',
        countryZh: '俄罗斯·欧洲',
        countryEn: 'European Russia',
        countryCode: 'RU',
        entityCode: 54,
        continent: ['EU'],
        cqZone: 16,
        ituZone: 29
      };
    } else {
      // 亚洲俄罗斯
      return {
        country: 'Asiatic Russia',
        countryZh: '俄罗斯·亚洲',
        countryEn: 'Asiatic Russia',
        countryCode: 'RU',
        entityCode: 15,
        continent: ['AS'],
        cqZone: 18,
        ituZone: 30
      };
    }
  }
}

const US_ENTITY_STATE_MAP: Record<string, USStateInfo> = {
  'Alaska': { state: 'AK', confidence: 'high' },
  'American Samoa': { state: 'AS', confidence: 'high' },
  'Guam': { state: 'GU', confidence: 'high' },
  'Hawaii': { state: 'HI', confidence: 'high' },
  'Mariana Islands': { state: 'MP', confidence: 'high' },
  'Puerto Rico': { state: 'PR', confidence: 'high' },
  'US Virgin Islands': { state: 'VI', confidence: 'high' },
};

const US_SUBDIVISION_EN_MAP: Record<string, string> = {
  'AK': 'Alaska',
  'AS': 'American Samoa',
  'CA': 'California',
  'GU': 'Guam',
  'HI': 'Hawaii',
  'MP': 'Northern Mariana Islands',
  'PR': 'Puerto Rico',
  'VI': 'U.S. Virgin Islands',
};

const US_SUBDIVISION_ZH_MAP: Record<string, string> = {
  'AK': '阿拉斯加',
  'AS': '美属萨摩亚',
  'CA': '加州',
  'GU': '关岛',
  'HI': '夏威夷',
  'MP': '北马里亚纳群岛',
  'PR': '波多黎各',
  'VI': '美属维尔京群岛',
};

function resolveUSStateInfo(callsign: string, entity: DXCCEntity | null): USStateInfo | null {
  if (!entity) {
    return null;
  }

  const mappedEntity = US_ENTITY_STATE_MAP[entity.name];
  if (mappedEntity) {
    return mappedEntity;
  }

  if (entity.name !== 'United States of America' || entity.countryCode !== 'US') {
    return null;
  }

  const upper = callsign.toUpperCase().trim();
  const segments = upper.split('/').map((segment) => segment.trim()).filter(Boolean);
  const portableArea = segments.find((segment) => /^[0-9]$/.test(segment));
  if (portableArea === '6') {
    return { state: 'CA', confidence: 'low' };
  }

  const baseCallsign = extractBaseCallsign(upper);
  const districtMatch = baseCallsign.match(/\d/);
  if (districtMatch?.[0] === '6') {
    return { state: 'CA', confidence: 'low' };
  }

  return null;
}

// DXCC 数据索引
class DXCCIndex {
  private entityMap: Map<number, DXCCEntity>;
  private prefixRegexMap: Map<RegExp, DXCCEntity>;
  private prefixMap: Map<string, DXCCEntity>;
  private countryNameMap: Map<string, DXCCEntity>;
  // 基于字符的前缀Trie，用于最长前缀匹配（比遍历更高效）
  private prefixTrie: PrefixTrieNode;
  // 结果缓存，减少重复解析成本
  private prefixLRU: LRU<string, string>;
  private entityLRU: LRU<string, DXCCResolutionResult>;
  // 实体优先级评分缓存（用于前缀冲突时的优先级排序）
  private entityPriorityScores: Map<number, number>;

  constructor() {
    this.entityMap = new Map();
    this.prefixRegexMap = new Map();
    this.prefixMap = new Map();
    this.countryNameMap = new Map();
    this.prefixTrie = createTrieNode();
    this.prefixLRU = new LRU(5000);
    this.entityLRU = new LRU(5000);
    this.entityPriorityScores = new Map();

    // 初始化索引
    this.initializeIndex();
  }

  /**
   * 预计算所有实体的优先级评分
   * 用于解决前缀冲突时的优先级排序
   *
   * 核心原理：前缀越少的实体，每个前缀对它越重要（前缀独占度）
   *
   * 评分维度：
   * 1. 前缀独占度 (60%)：前缀越少 = 该前缀越重要（反向权重）
   * 2. 正则表达式复杂度 (20%)：越简单/宽松 = 主要使用范围
   * 3. 实体代码权重 (10%)：代码越小 = 越早分配（参考性）
   * 4. JSON顺序 (10%)：先出现的实体优先
   */
  private calculateEntityPriorities(): void {
    const entities = dxccData.dxcc as DXCCEntity[];

    // 计算归一化所需的最大最小值
    const prefixCounts = entities.map((e) =>
      e.prefix ? e.prefix.split(',').length : 0
    );
    const maxPrefixes = Math.max(...prefixCounts);

    const entityCodes = entities.map((e) => e.entityCode);
    const maxCode = Math.max(...entityCodes);
    const minCode = Math.min(...entityCodes);

    const regexLengths = entities
      .map((e) => e.prefixRegex?.length || 0)
      .filter((l) => l > 0);
    const maxRegexLength = Math.max(...regexLengths);
    const minRegexLength = Math.min(...regexLengths);

    // 为每个实体计算优先级评分
    entities.forEach((entity, index: number) => {
      const prefixCount = entity.prefix ? entity.prefix.split(',').length : 0;

      // 1. 前缀得分 (0-60)，混合策略
      // - 主要国家（前缀≥10）：前缀越多得分越高，满分60（Argentina, France等）
      // - 小实体（前缀<10）：前缀越少得分越高，但上限10，仅用于同级别实体间打破平局
      let prefixScore = 0;
      if (prefixCount >= 10) {
        // 主要国家：正向评分，使用对数尺度，权重最高
        prefixScore = 60 * Math.log(1 + prefixCount) / Math.log(1 + maxPrefixes);
      } else if (prefixCount > 0) {
        // 小实体：反向评分（前缀越少越专一），但限制上限为10分
        // 确保主要国家的对数得分能够显著超过小实体
        prefixScore = 10 * (1 - prefixCount / 10);
      }

      // 2. 正则表达式复杂度得分 (0-20)，长度越短（越简单）得分越高
      const regexLength = entity.prefixRegex?.length || maxRegexLength;
      const regexScore = maxRegexLength === minRegexLength ? 20 :
        20 * (1 - (regexLength - minRegexLength) / (maxRegexLength - minRegexLength));

      // 3. 实体代码得分 (0-10)，代码越小得分越高
      const codeScore = maxCode === minCode ? 10 :
        10 * (1 - (entity.entityCode - minCode) / (maxCode - minCode));

      // 4. JSON顺序得分 (0-10)，先出现的得分越高
      const orderScore = 10 * (1 - index / entities.length);

      // 总分
      const totalScore = prefixScore + regexScore + codeScore + orderScore;
      this.entityPriorityScores.set(entity.entityCode, totalScore);
    });
  }

  private initializeIndex() {
    // 第一步：预计算所有实体的优先级评分
    this.calculateEntityPriorities();

    // 第二步：构建索引和 Trie
    dxccData.dxcc.forEach(entity => {
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
          logger.warn(`Invalid prefix regex for ${entity.name}: ${entity.prefixRegex}`);
        }
      }

      // 前缀索引（在初始化阶段完成 split/trim 并构建 Trie）
      if (entity.prefix) {
        const prefixes = entity.prefix.split(',').map((p) => p.trim()).filter(Boolean);
        for (const prefix of prefixes) {
          this.prefixMap.set(prefix, entity);
          this.insertIntoTrie(prefix, entity);
        }
      }
    });
  }

  /**
   * 向 Trie 中插入前缀和对应的实体
   * 支持多实体共享同一前缀，使用优先级评分进行排序
   */
  private insertIntoTrie(prefix: string, entity: DXCCEntity): void {
    let node = this.prefixTrie;
    for (let i = 0; i < prefix.length; i++) {
      const ch = prefix[i];
      let next = node.c.get(ch);
      if (!next) {
        next = createTrieNode();
        node.c.set(ch, next);
      }
      node = next;
    }

    // 在终止节点记录命中的实体（支持单实体或多实体数组）
    if (!node.e) {
      // 第一个实体，直接赋值
      node.e = entity;
    } else if (Array.isArray(node.e)) {
      // 已经是数组，添加新实体并按优先级排序
      node.e.push(entity);
      this.sortEntitiesByPriority(node.e);
    } else {
      // 第二个实体，转为数组并排序
      node.e = [node.e, entity];
      this.sortEntitiesByPriority(node.e);
    }
    node.p = prefix;
  }

  /**
   * 按优先级评分对实体数组进行排序（降序）
   */
  private sortEntitiesByPriority(entities: DXCCEntity[]): void {
    entities.sort((a, b) => {
      const scoreA = this.entityPriorityScores.get(a.entityCode) || 0;
      const scoreB = this.entityPriorityScores.get(b.entityCode) || 0;
      return scoreB - scoreA; // 降序排序，得分高的在前
    });
  }

  /**
   * 在 Trie 中进行最长前缀匹配
   * 如果节点包含多个实体（数组），返回优先级最高的（数组第一个元素）
   */
  private longestTrieMatch(callsign: string): { prefix: string | null; entities: DXCCEntity[] } {
    const upper = callsign.toUpperCase();
    const clean = upper.trim();

    let node = this.prefixTrie;
    let lastPrefix: string | null = null;
    let lastEntities: DXCCEntity[] = [];

    for (let i = 0; i < clean.length; i++) {
      const ch = clean[i];
      const next = node.c.get(ch);
      if (!next) break;
      node = next;
      if (node.e) {
        lastPrefix = node.p || null;
        lastEntities = Array.isArray(node.e) ? [...node.e] : [node.e];
      }
    }

    this.prefixLRU.set(clean, lastPrefix || '');
    return { prefix: lastPrefix, entities: lastEntities };
  }

  public getLongestPrefix(callsign: string): string | null {
    const { prefix } = this.longestTrieMatch(callsign);
    return prefix || null;
  }

  public resolveCallsign(callsign: string, timestamp: number = Date.now()): DXCCResolutionResult {
    if (!callsign) {
      return {
        entity: null,
        confidence: 'unknown',
        needsReview: false,
      };
    }

    const upperCallsign = callsign.toUpperCase();
    const cacheKey = `${upperCallsign}|${new Date(timestamp).toISOString().slice(0, 10)}`;

    // LRU 缓存命中
    const cached = this.entityLRU.get(cacheKey);
    if (cached !== undefined) {
      return {
        entity: cached.entity ? { ...cached.entity } : null,
        matchedPrefix: cached.matchedPrefix,
        confidence: cached.confidence,
        needsReview: cached.needsReview,
      };
    }

    // 首先尝试中国呼号解析
    const chinaInfo = ChinaCallsignParser.parseChinaCallsign(upperCallsign);
    if (chinaInfo) {
      const result: DXCCResolutionResult = {
        entity: {
          name: chinaInfo.country,
          countryZh: chinaInfo.countryZh,
          countryEn: chinaInfo.countryEn,
          countryCode: chinaInfo.countryCode,
          flag: '🇨🇳',
          prefix: upperCallsign.substring(0, 2),
          entityCode: 318, // 中国的 DXCC 实体代码
          continent: ['AS'],
          cqZone: 24,
          ituZone: 44,
        },
        matchedPrefix: upperCallsign.substring(0, 2),
        confidence: 'heuristic',
        needsReview: false,
      };
      this.entityLRU.set(cacheKey, result);
      return result;
    }

    // 尝试俄罗斯呼号解析（区分欧洲和亚洲部分）
    const russiaInfo = RussiaCallsignParser.parseRussiaCallsign(upperCallsign);
    if (russiaInfo) {
      const result: DXCCResolutionResult = {
        entity: {
          name: russiaInfo.country,
          countryZh: russiaInfo.countryZh,
          countryEn: russiaInfo.countryEn,
          countryCode: russiaInfo.countryCode,
          flag: '🇷🇺',
          prefix: upperCallsign.match(/^[A-Z]+/)?.[0],
          entityCode: russiaInfo.entityCode,
          continent: russiaInfo.continent,
          cqZone: russiaInfo.cqZone,
          ituZone: russiaInfo.ituZone,
        },
        matchedPrefix: upperCallsign.match(/^[A-Z]+/)?.[0],
        confidence: 'heuristic' as const,
        needsReview: false,
      };
      this.entityLRU.set(cacheKey, result);
      return result;
    }

    for (const candidate of createCandidateCallsigns(upperCallsign)) {
      const trieHit = this.longestTrieMatch(candidate);
      if (trieHit.entities.length > 0) {
        const activeEntities = trieHit.entities.filter((entity) => isEntityActiveAt(entity, timestamp));
        const chosen = (activeEntities[0] || trieHit.entities[0]);
        const result = {
          entity: {
            ...chosen,
            countryZh: COUNTRY_ZH_MAP[chosen.name] || chosen.name,
            countryEn: chosen.name,
          },
          matchedPrefix: trieHit.prefix || undefined,
          confidence: activeEntities.length > 0 ? 'prefix' as const : 'exception' as const,
          needsReview: activeEntities.length > 1,
        };
        this.entityLRU.set(cacheKey, result);
        return result;
      }
    }

    for (const candidate of createCandidateCallsigns(upperCallsign)) {
      for (const [regex, entity] of this.prefixRegexMap) {
        if (regex.test(candidate) && isEntityActiveAt(entity, timestamp)) {
          const result = {
            entity: {
              ...entity,
              countryZh: COUNTRY_ZH_MAP[entity.name] || entity.name,
              countryEn: entity.name,
            },
            matchedPrefix: entity.prefix?.split(',')[0]?.trim(),
            confidence: 'exception' as const,
            needsReview: false,
          };
          this.entityLRU.set(cacheKey, result);
          return result;
        }
      }
    }

    // 不缓存负结果，避免数据或规则更新后“粘住”未命中
    return {
      entity: null,
      confidence: 'unknown',
      needsReview: false,
    };
  }

  public findEntityByCallsign(callsign: string, timestamp: number = Date.now()): DXCCEntity | null {
    return this.resolveCallsign(callsign, timestamp).entity;
  }

  public getEntityByCode(code: number): DXCCEntity | undefined {
    return this.entityMap.get(code);
  }

  public getEntityByName(name: string): DXCCEntity | undefined {
    return this.countryNameMap.get(name);
  }

  public getAllEntities(): DXCCEntity[] {
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
export function getCallsignInfo(callsign: string, timestamp: number = Date.now()): CallsignInfo | undefined {
  if (!callsign) return undefined;

  const resolution = dxccIndex.resolveCallsign(callsign, timestamp);
  const entity = resolution.entity;
  if (!entity) return undefined;
  const japanInfo = entity.entityCode === 339 && !entity.deleted
    ? JapanCallsignParser.parseJapanCallsign(callsign)
    : null;
  const usStateInfo = resolveUSStateInfo(callsign, entity);
  const usSubdivisionZh = usStateInfo?.state ? US_SUBDIVISION_ZH_MAP[usStateInfo.state] : undefined;
  const usSubdivisionEn = usStateInfo?.state ? US_SUBDIVISION_EN_MAP[usStateInfo.state] : undefined;
  const prefix = japanInfo?.matchedPrefix || resolution.matchedPrefix || extractCallsignPrefix(callsign);

  return {
    callsign,
    country: entity.name,
    countryZh: japanInfo?.countryZh
      ?? (entity.name === 'United States of America' && usSubdivisionZh ? `美国·${usSubdivisionZh}` : entity.countryZh),
    countryEn: japanInfo?.countryEn
      ?? (entity.name === 'United States of America' && usSubdivisionEn ? `United States·${usSubdivisionEn}` : entity.countryEn ?? entity.name),
    countryCode: entity.countryCode,
    flag: entity.flag,
    prefix,
    state: usStateInfo?.state,
    stateConfidence: usStateInfo?.confidence,
    entityCode: entity.entityCode,
    continent: entity.continent,
    cqZone: entity.cqZone,
    ituZone: entity.ituZone,
    dxccStatus: entity.deleted ? 'deleted' : 'current',
    dxccConfidence: resolution.confidence,
    dxccNeedsReview: resolution.needsReview,
  };
}

/**
 * 提取呼号前缀
 * @param callsign 呼号
 * @returns 前缀
 */
export function extractCallsignPrefix(callsign: string): string {
  if (!callsign) return '';
  // 使用Trie获取最长DXCC前缀
  const prefix = dxccIndex.getLongestPrefix(callsign);
  if (prefix) return prefix;

  // 回退：快速推断 1-2 个字符作为前缀（无需 split/match）
  const upper = callsign.toUpperCase();
  const slashIdx = upper.indexOf('/');
  const clean = slashIdx === -1 ? upper : upper.slice(0, slashIdx);

  if (clean.length >= 2 && /\d/.test(clean[1])) return clean[0];
  if (clean.length >= 2) return clean.slice(0, 2);
  return clean;
}

/**
 * 提取呼号前缀（向后兼容别名）
 * @param callsign 呼号
 * @returns 前缀
 */
export const extractPrefix = extractCallsignPrefix;

/**
 * 从带前后缀的呼号中提取基础呼号（身份标识）
 * BG5DRB/QRP → BG5DRB, VK2/BG5DRB → BG5DRB, BG5DRB → BG5DRB
 * 规则：按 / 分割后，取最长的、符合呼号格式（含字母和数字，长度>=3）的部分
 * @param callsign 可能带前后缀的呼号
 * @returns 基础呼号（大写）
 */
export function extractBaseCallsign(callsign: string): string {
  if (!callsign) return '';
  const upper = callsign.toUpperCase().trim();
  if (!upper.includes('/')) return upper;

  const parts = upper.split('/');
  let best = parts[0];
  for (const part of parts) {
    if (part.length > best.length && /[A-Z]/.test(part) && /\d/.test(part)) {
      best = part;
    }
  }
  return best;
}

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

// 网格定位正则表达式（从 ft8-message-parser 导入）
const GRID_REGEX_LOCAL = /^[A-R]{2}[0-9]{2}([A-X]{2})?$/;
// 信号报告正则表达式
const REPORT_REGEX_LOCAL = /^[+-]?\d{1,2}$/;

/**
 * 从FT8消息中解析位置信息
 * @param message FT8消息文本
 * @returns 位置信息
 */
export function parseFT8LocationInfo(message: string): FT8LocationInfo {
  const msg = FT8MessageParser.parseMessage(message);
  let callsignInfo;

  // 尝试从解析后的消息中获取呼号信息
  if ('senderCallsign' in msg && typeof msg.senderCallsign === 'string') {
    callsignInfo = getCallsignInfo(msg.senderCallsign);
  } else if (msg.type === FT8MessageType.FOX_RR73) {
    // 某些解码器只给出短哈希，此时仍退回到 nextCallsign 以保留旧行为。
    callsignInfo = getCallsignInfo(msg.nextCallsign);
  }

  // 降级处理:如果FT8消息解析失败或无法识别发送者,尝试从原始消息中提取呼号
  if (!callsignInfo) {
    const words = message.trim().toUpperCase().split(/\s+/);
    // 常见的 CQ 区域/活动标记，在降级扫描时应忽略，避免被误当作呼号
    const CQ_FLAGS = new Set([
      'DX','NA','EU','AS','AF','OC','SA','JA','RU','UP','TEST','POTA','WW'
    ]);
    for (const word of words) {
      // 跳过网格坐标和信号报告
      if (GRID_REGEX_LOCAL.test(word) || REPORT_REGEX_LOCAL.test(word)) continue;

      // 跳过常见的FT8关键字
      if (word === 'CQ' || word === 'RRR' || word === 'RR73' || word === '73' || CQ_FLAGS.has(word)) continue;

      const info = getCallsignInfo(word);
      if (info) {
        callsignInfo = info;
        break; // 找到第一个有效呼号即返回
      }
    }
  }

  if (!callsignInfo) return {};

  return {
    callsign: callsignInfo.callsign,
    country: callsignInfo.country,
    countryZh: callsignInfo.countryZh,
    countryEn: callsignInfo.countryEn,
    countryCode: callsignInfo.countryCode,
    flag: callsignInfo.flag,
    state: callsignInfo.state,
    stateConfidence: callsignInfo.stateConfidence,
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
    .flatMap(entity => entity.prefix!.split(',').map((p: string) => p.trim()));
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
      flag: entity.flag || '',
      prefixes: entity.prefix ? entity.prefix.split(',').map((p) => p.trim()) : []
    }));
}

/**
 * 获取呼号的前缀信息
 * @param callsign 呼号
 * @returns 前缀信息
 */
export function getPrefixInfo(callsign: string): DXCCEntity | null {
  if (!callsign) return null;
  return dxccIndex.findEntityByCallsign(callsign);
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

export function resolveDXCCEntity(callsign: string, timestamp: number = Date.now()): DXCCResolutionResult {
  return dxccIndex.resolveCallsign(callsign, timestamp);
}
