/**
 * 呼号解析工具
 * 用于从FT8消息中解析呼号、国家和国旗信息
 */

import { FT8MessageParser } from '../parser/ft8-message-parser.js';
import { FT8MessageType } from '@tx5dr/contracts';
import ctyCsvText from './cty-data.js';
import { CtyIndex, parseCTYCsv, type CtyLookupRecord } from './cty.js';
import { CTY_ENTITY_METADATA } from './cty-metadata.js';

// 中文地名映射表
export const COUNTRY_ZH_MAP: Record<string, string> = {
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
  // Current BigCTY/CTY short names and abbreviations not covered by older display-name variants.
  'Agalega & St. Brandon': '阿加莱加和圣布兰登',
  'African Italy': '非洲意大利',
  'Aland Islands': '奥兰群岛',
  'Amsterdam & St. Paul Is.': '阿姆斯特丹岛和圣保罗岛',
  'Andaman & Nicobar Is.': '安达曼-尼科巴群岛',
  'Annobon Island': '安诺邦岛',
  'Antigua & Barbuda': '安提瓜和巴布达',
  'Asiatic Turkey': '土耳其·亚洲',
  'Aves Island': '阿维斯岛',
  'Baker & Howland Islands': '贝克岛和豪兰岛',
  'Banaba Island': '巴纳巴岛',
  'Bear Island': '熊岛',
  'Bouvet': '布韦岛',
  'Ceuta & Melilla': '休达和梅利利亚',
  'Central Kiribati': '中基里巴斯',
  "Cote d'Ivoire": '科特迪瓦',
  'Crozet Island': '克罗泽群岛',
  'Curacao': '库拉索',
  'Dem. Rep. of the Congo': '刚果民主共和国',
  'DPR of Korea': '朝鲜',
  'Eastern Kiribati': '东基里巴斯',
  'European Turkey': '土耳其·欧洲',
  'Fed. Rep. of Germany': '德国',
  'Galapagos Islands': '加拉帕戈斯群岛',
  'Heard Island': '赫德岛',
  'ITU HQ': '国际电联总部',
  'Johnston Island': '约翰斯顿岛',
  'Juan de Nova & Europa': '胡安德诺瓦和欧罗巴',
  'Juan Fernandez Islands': '胡安·费尔南德斯群岛',
  'Kingdom of Eswatini': '斯威士兰',
  'Kure Island': '库雷岛',
  'Lakshadweep Islands': '拉克沙群岛',
  'Madeira Islands': '马德拉群岛',
  'Market Reef': '梅凯特礁',
  'Midway Island': '中途岛',
  'Minami Torishima': '南鸟岛',
  'N.Z. Subantarctic Is.': '新西兰亚南极群岛',
  'Ogasawara': '小笠原群岛',
  'Palmyra & Jarvis Islands': '帕尔米拉和贾维斯群岛',
  'Peter 1 Island': '彼得一世岛',
  'Pitcairn Island': '皮特凯恩岛',
  'Pr. Edward & Marion Is.': '爱德华王子群岛和马里恩岛',
  'Republic of Kosovo': '科索沃',
  'Republic of South Sudan': '南苏丹',
  'Reunion Island': '留尼汪岛',
  'Revillagigedo': '雷维利亚希赫多群岛',
  'Rodriguez Island': '罗德里格斯岛',
  'Saba & St. Eustatius': '萨巴和圣尤斯特歇斯',
  'San Andres & Providencia': '圣安德烈斯和普罗维登西亚',
  'San Felix & San Ambrosio': '圣费利克斯和圣安布罗西奥群岛',
  'Sao Tome & Principe': '圣多美和普林西比',
  'Scarborough Reef': '黄岩岛',
  'Shetland Islands': '设得兰群岛',
  'Sicily': '西西里',
  'Slovak Republic': '斯洛伐克',
  'Sov Mil Order of Malta': '马耳他主权军事修会',
  'St. Barthelemy': '圣巴泰勒米',
  'St. Kitts & Nevis': '圣基茨和尼维斯',
  'St. Lucia': '圣卢西亚',
  'St. Martin': '圣马丁',
  'St. Peter & St. Paul': '圣彼得和圣保罗岩礁',
  'St. Pierre & Miquelon': '圣皮埃尔和密克隆',
  'St. Vincent': '圣文森特',
  'Timor - Leste': '东帝汶',
  'Tokelau Islands': '托克劳群岛',
  'Trindade & Martim Vaz': '特林达德和马丁瓦斯群岛',
  'Trinidad & Tobago': '特立尼达和多巴哥',
  'Tristan da Cunha & Gough Islands': '特里斯坦-达库尼亚和戈夫岛',
  'Turks & Caicos Islands': '特克斯和凯科斯群岛',
  'UK Base Areas on Cyprus': '塞浦路斯英属基地区',
  'United Nations HQ': '联合国总部',
  'Vatican City': '梵蒂冈',
  'Vienna Intl Ctr': '维也纳国际中心',
  'Wallis & Futuna Islands': '瓦利斯和富图纳群岛',
  'Western Kiribati': '西基里巴斯',
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

// DXCC 实体接口定义。英文展示名直接来自 CTY 原始数据。
export interface DXCCEntity {
  entityCode?: number;
  name: string;
  prefix?: string;
  flag?: string;
  countryCode?: string;
  continent?: string[];
  cqZone?: number;
  ituZone?: number;
  countryZh?: string;
  countryEn?: string;
  waeOnly?: boolean;
  latitude?: number;
  longitude?: number;
  utcOffsetHours?: number;
}

export type DXCCMatchKind = 'prefix' | 'exact' | 'heuristic' | 'unknown';
export type DXCCDataSource = 'local' | 'hamqth';

export interface DXCCResolutionResult {
  entity: DXCCEntity | null;
  matchedPrefix?: string;
  confidence: 'exception' | 'prefix' | 'heuristic' | 'unknown';
  needsReview: boolean;
  matchKind: DXCCMatchKind;
  dataSource: DXCCDataSource;
}

const CTY_PARSE_RESULT = parseCTYCsv(ctyCsvText);

export const DXCC_RESOLVER_VERSION = CTY_PARSE_RESULT.version || 'bigcty-runtime';

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
  dxccMatchKind?: DXCCMatchKind;
  dxccDataSource?: DXCCDataSource;
  dxccResolverVersion?: string;
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

export interface GridPath {
  /** Great-circle distance in kilometers. */
  distanceKm: number;
  /** Initial true bearing clockwise from north, in degrees (0-359). */
  bearingDegrees: number;
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

const US_ENTITY_STATE_MAP: Record<string, USStateInfo> = {
  'Alaska': { state: 'AK', confidence: 'high' },
  'American Samoa': { state: 'AS', confidence: 'high' },
  'Guam': { state: 'GU', confidence: 'high' },
  'Hawaii': { state: 'HI', confidence: 'high' },
  'Mariana Islands': { state: 'MP', confidence: 'high' },
  'Puerto Rico': { state: 'PR', confidence: 'high' },
  'US Virgin Islands': { state: 'VI', confidence: 'high' },
  'Virgin Islands': { state: 'VI', confidence: 'high' },
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

  if (entity.name !== 'United States' || entity.countryCode !== 'US') {
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

const CTY_NAME_ZH_OVERRIDES: Record<string, string> = {
  '390:Asiatic Turkey': '土耳其·亚洲',
  '390:European Turkey': '土耳其·欧洲',
  '248:Sicily': '西西里',
  '291:United States': '美国',
  '105:Guantanamo Bay': '关塔那摩湾',
  '517:Kingdom of Eswatini': '斯威士兰',
  '24:Bouvet': '布韦岛',
  '192:Ogasawara': '小笠原群岛',
  '197:Revillagigedo': '雷维利亚希赫多群岛',
};

const ENTITY_CODE_ZH_FALLBACK: Record<number, string> = {
  390: '土耳其',
  291: '美国',
  318: '中国',
  339: '日本',
  248: '意大利',
  225: '撒丁岛',
  279: '苏格兰',
  259: '斯瓦尔巴群岛',
  15: '俄罗斯·亚洲',
  54: '俄罗斯·欧洲',
};

function resolveCtyChineseName(entityCode: number | undefined, ctyName: string): string {
  const keyed = entityCode === undefined ? undefined : CTY_NAME_ZH_OVERRIDES[`${entityCode}:${ctyName}`];
  if (keyed) return keyed;
  const direct = COUNTRY_ZH_MAP[ctyName];
  if (direct) return direct;
  if (entityCode !== undefined && ENTITY_CODE_ZH_FALLBACK[entityCode]) {
    return ENTITY_CODE_ZH_FALLBACK[entityCode];
  }
  return ctyName;
}

function ctyRecordToEntity(record: CtyLookupRecord): DXCCEntity {
  const metadata = record.entityCode === undefined ? undefined : CTY_ENTITY_METADATA[record.entityCode];
  return {
    entityCode: record.entityCode,
    name: record.entityName,
    countryZh: resolveCtyChineseName(record.entityCode, record.entityName),
    countryEn: record.entityName,
    countryCode: metadata?.countryCode,
    flag: metadata?.flag,
    prefix: record.matchedPrefix,
    continent: record.continent ? [record.continent] : undefined,
    cqZone: Number.isFinite(record.cqZone) ? record.cqZone : undefined,
    ituZone: Number.isFinite(record.ituZone) ? record.ituZone : undefined,
    waeOnly: record.waeOnly,
    latitude: Number.isFinite(record.latitude) ? record.latitude : undefined,
    longitude: Number.isFinite(record.longitude) ? record.longitude : undefined,
    utcOffsetHours: Number.isFinite(record.utcOffsetHours) ? record.utcOffsetHours : undefined,
  };
}

// DXCC 数据索引：直接按 BigCTY/CTY 官方 token 语义运行时解析。
class DXCCIndex {
  private readonly ctyIndex = new CtyIndex(CTY_PARSE_RESULT, 'bigcty-runtime');
  private readonly entityLRU = new LRU<string, DXCCResolutionResult>(5000);

  public resolveCallsign(callsign: string, _timestamp: number = Date.now()): DXCCResolutionResult {
    const upperCallsign = callsign?.toUpperCase().trim();
    if (!upperCallsign) {
      return {
        entity: null,
        confidence: 'unknown',
        needsReview: false,
        matchKind: 'unknown',
        dataSource: 'local',
      };
    }

    const cached = this.entityLRU.get(upperCallsign);
    if (cached !== undefined) {
      return {
        entity: cached.entity ? { ...cached.entity } : null,
        matchedPrefix: cached.matchedPrefix,
        confidence: cached.confidence,
        needsReview: cached.needsReview,
        matchKind: cached.matchKind,
        dataSource: cached.dataSource,
      };
    }

    const record = this.ctyIndex.lookup(upperCallsign);
    if (!record) {
      return {
        entity: null,
        confidence: 'unknown',
        needsReview: false,
        matchKind: 'unknown',
        dataSource: 'local',
      };
    }

    const result: DXCCResolutionResult = {
      entity: ctyRecordToEntity(record),
      matchedPrefix: record.matchedPrefix,
      confidence: record.matchKind === 'exact' ? 'exception' : 'prefix',
      needsReview: record.needsReview,
      matchKind: record.matchKind,
      dataSource: 'local',
    };
    this.entityLRU.set(upperCallsign, result);
    return {
      ...result,
      entity: result.entity ? { ...result.entity } : null,
    };
  }

  public findEntityByCallsign(callsign: string, timestamp: number = Date.now()): DXCCEntity | null {
    return this.resolveCallsign(callsign, timestamp).entity;
  }

  public getEntityByCode(code: number): DXCCEntity | undefined {
    const row = this.ctyIndex.getAllRows().find((candidate) => candidate.entityCode === code);
    if (!row) return undefined;
    const metadata = CTY_ENTITY_METADATA[code];
    return {
      entityCode: row.entityCode,
      name: row.entityName,
      countryZh: resolveCtyChineseName(row.entityCode, row.entityName),
      countryEn: row.entityName,
      countryCode: metadata?.countryCode,
      flag: metadata?.flag,
      prefix: row.primaryPrefix,
      continent: row.continent ? [row.continent] : undefined,
      cqZone: row.cqZone,
      ituZone: row.ituZone,
      waeOnly: row.waeOnly,
      latitude: row.latitude,
      longitude: row.longitude,
      utcOffsetHours: row.utcOffsetHours,
    };
  }

  public getEntityByName(name: string): DXCCEntity | undefined {
    const row = this.ctyIndex.getAllRows().find((candidate) => candidate.entityName === name);
    if (!row?.entityCode) return undefined;
    return this.getEntityByCode(row.entityCode);
  }

  public getAllEntities(): DXCCEntity[] {
    const seen = new Set<string>();
    const entities: DXCCEntity[] = [];
    for (const row of this.ctyIndex.getAllRows()) {
      const key = `${row.entityCode ?? 'unknown'}:${row.entityName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const metadata = row.entityCode === undefined ? undefined : CTY_ENTITY_METADATA[row.entityCode];
      entities.push({
        entityCode: row.entityCode,
        name: row.entityName,
        countryZh: resolveCtyChineseName(row.entityCode, row.entityName),
        countryEn: row.entityName,
        countryCode: metadata?.countryCode,
        flag: metadata?.flag,
        prefix: row.primaryPrefix,
        continent: row.continent ? [row.continent] : undefined,
        cqZone: row.cqZone,
        ituZone: row.ituZone,
        waeOnly: row.waeOnly,
      });
    }
    return entities;
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
  const chinaInfo = entity.entityCode === 318
    ? ChinaCallsignParser.parseChinaCallsign(callsign.toUpperCase())
    : null;
  const japanInfo = entity.entityCode === 339
    ? JapanCallsignParser.parseJapanCallsign(callsign)
    : null;
  const usStateInfo = resolveUSStateInfo(callsign, entity);
  const usSubdivisionZh = usStateInfo?.state ? US_SUBDIVISION_ZH_MAP[usStateInfo.state] : undefined;
  const usSubdivisionEn = usStateInfo?.state ? US_SUBDIVISION_EN_MAP[usStateInfo.state] : undefined;
  const prefix = japanInfo?.matchedPrefix || resolution.matchedPrefix || extractCallsignPrefix(callsign);

  return {
    callsign,
    country: entity.name,
    countryZh: chinaInfo?.countryZh
      ?? japanInfo?.countryZh
      ?? (entity.name === 'United States' && usSubdivisionZh ? `美国·${usSubdivisionZh}` : entity.countryZh),
    countryEn: chinaInfo?.countryEn
      ?? japanInfo?.countryEn
      ?? (entity.name === 'United States' && usSubdivisionEn ? `United States·${usSubdivisionEn}` : entity.countryEn ?? entity.name),
    countryCode: chinaInfo?.countryCode ?? japanInfo?.countryCode ?? entity.countryCode,
    flag: entity.flag,
    prefix,
    state: usStateInfo?.state,
    stateConfidence: usStateInfo?.confidence,
    entityCode: entity.entityCode,
    continent: entity.continent,
    cqZone: entity.cqZone,
    ituZone: entity.ituZone,
    dxccStatus: 'current',
    dxccConfidence: resolution.confidence,
    dxccNeedsReview: resolution.needsReview,
    dxccMatchKind: resolution.matchKind,
    dxccDataSource: resolution.dataSource,
    dxccResolverVersion: DXCC_RESOLVER_VERSION,
  };
}

/**
 * 提取呼号前缀
 * @param callsign 呼号
 * @returns 前缀
 */
export function extractCallsignPrefix(callsign: string): string {
  if (!callsign) return '';
  const resolution = dxccIndex.resolveCallsign(callsign);
  if (resolution.matchedPrefix) {
    return resolution.matchedPrefix;
  }

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
  
  if (lon1 < 0 || lon1 > 17 || lat1 < 0 || lat1 > 17 || isNaN(lon2) || isNaN(lat2)) return null;
  
  // 计算经纬度
  let lon = (lon1 * 20 + lon2 * 2) - 180 + 1;
  let lat = (lat1 * 10 + lat2) - 90 + 0.5;
  
  // 如果有子网格（6位网格）
  if (grid.length >= 6) {
    const lon3 = upperGrid.charCodeAt(4) - 65;
    const lat3 = upperGrid.charCodeAt(5) - 65;
    if (lon3 < 0 || lon3 > 23 || lat3 < 0 || lat3 > 23) return null;
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
 * 计算从一个网格指向另一个网格的初始真方位角（度，0-359）
 * @param fromGrid 起点网格
 * @param toGrid 目标网格
 * @returns 真北顺时针方位角
 */
export function calculateGridBearing(fromGrid: string, toGrid: string): number | null {
  const from = gridToCoordinates(fromGrid);
  const to = gridToCoordinates(toGrid);

  if (!from || !to) return null;

  return initialBearing(from, to);
}

/**
 * 一次性计算两个网格之间的距离和初始真方位角
 * @param fromGrid 起点网格
 * @param toGrid 目标网格
 * @returns 距离（公里）和方位角（度）
 */
export function calculateGridPath(fromGrid: string, toGrid: string): GridPath | null {
  const from = gridToCoordinates(fromGrid);
  const to = gridToCoordinates(toGrid);

  if (!from || !to) return null;

  return {
    distanceKm: haversineDistance(from, to),
    bearingDegrees: initialBearing(from, to),
  };
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

function initialBearing(
  from: GridCoordinates,
  to: GridCoordinates
): number {
  const lat1 = toRadians(from.lat);
  const lat2 = toRadians(to.lat);
  const dLon = toRadians(to.lon - from.lon);

  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) -
            Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);

  return normalizeDegrees(toDegrees(Math.atan2(y, x)));
}

function normalizeDegrees(degrees: number): number {
  return (degrees + 360) % 360;
}

/**
 * 角度转弧度
 * @param degrees 角度
 * @returns 弧度
 */
function toRadians(degrees: number): number {
  return degrees * (Math.PI / 180);
}

function toDegrees(radians: number): number {
  return radians * (180 / Math.PI);
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
  }

  // 降级处理:如果FT8消息解析失败或无法识别发送者,尝试从原始消息中提取呼号
  if (!callsignInfo && !message.includes('RR73;')) {
    const words = message.trim().toUpperCase().split(/\s+/);
    // 常见的 CQ 区域/活动标记，在降级扫描时应忽略，避免被误当作呼号
    const CQ_FLAGS = new Set([
      'DX','NA','EU','AS','AF','OC','SA','JA','RU','UP','TEST','POTA','WW'
    ]);
    const wordsToScan = msg.type === FT8MessageType.FOX_RR73 ? [] : words;

    for (const word of wordsToScan) {
      // 跳过网格坐标和信号报告
      if (GRID_REGEX_LOCAL.test(word) || REPORT_REGEX_LOCAL.test(word)) continue;

      // 跳过常见的FT8关键字
      if (word === 'CQ' || word === 'RRR' || word === 'RR73' || word === 'RR73;' || word === '73' || CQ_FLAGS.has(word)) continue;

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
    .filter(entity => entity.prefix)
    .flatMap(entity => entity.prefix!.split(',').map((p: string) => p.trim()));
}

/**
 * 获取所有支持的国家
 * @returns 国家信息数组
 */
export function getSupportedCountries(): Array<{ country: string; flag: string; prefixes: string[] }> {
  return Array.from(dxccIndex.getAllEntities())
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

export function listDXCCEntities(): DXCCEntity[] {
  const byCode = new Map<number, DXCCEntity>();
  for (const entity of dxccIndex.getAllEntities()) {
    if (typeof entity.entityCode === 'number' && !byCode.has(entity.entityCode)) {
      byCode.set(entity.entityCode, entity);
    }
  }

  return Array.from(byCode.values())
    .sort((left, right) => {
      const leftName = left.name.toLocaleLowerCase();
      const rightName = right.name.toLocaleLowerCase();
      if (leftName !== rightName) return leftName.localeCompare(rightName);
      return (left.entityCode ?? 0) - (right.entityCode ?? 0);
    })
    .map((entity) => ({ ...entity }));
}
