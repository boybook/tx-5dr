import dxccData from './callsign/dxcc.json' with { type: 'json' };
import ctyCsvText from './callsign/cty-data.js';
import { CtyIndex, parseCTYCsv } from './callsign/cty.js';
import { gridToCoordinates } from './callsign/callsign.js';

export type LoTWLocationIssueSeverity = 'error' | 'warning' | 'info';
export type LoTWSuggestionSource = 'cty' | 'dxcc' | 'grid' | 'current' | 'adif';

export interface LoTWStationLocationInput {
  callsign?: string;
  dxccId?: number;
  gridSquare?: string;
  cqZone?: string;
  ituZone?: string;
  iota?: string;
  state?: string;
  county?: string;
}

export interface LoTWSubdivisionOption {
  code: string;
  name: string;
  aliases?: string[];
}

export interface LoTWLocationRule {
  dxccId: number;
  stateField?: string;
  stateLabel: string;
  countyField?: string;
  countyLabel?: string;
  stateOptions?: LoTWSubdivisionOption[];
}

export interface LoTWLocationIssue {
  code: string;
  severity: LoTWLocationIssueSeverity;
  message: string;
  field?: string;
  value?: string;
  suggested?: string;
  detail?: string;
}

export interface LoTWCanonicalStationLocation extends Required<Pick<LoTWStationLocationInput, 'callsign' | 'gridSquare' | 'cqZone' | 'ituZone'>> {
  dxccId: number;
  iota?: string;
  state?: string;
  county?: string;
  stateField?: string;
  countyField?: string;
}

export interface LoTWStationSuggestion {
  field: 'dxccId' | 'cqZone' | 'ituZone' | 'state' | 'county';
  value: string | number;
  label?: string;
  source: LoTWSuggestionSource;
  confidence: 'high' | 'medium' | 'low';
}

export interface LoTWStationSuggestionResult {
  suggestions: LoTWStationSuggestion[];
  issues: LoTWLocationIssue[];
}

export interface LoTWDXCCOption {
  entityCode: number;
  name: string;
  flag?: string;
  deleted?: boolean;
  cqZone?: number;
  ituZone?: number;
  cq?: number[];
  itu?: number[];
  continent?: string[];
}

interface DxccJsonEntity {
  entityCode?: number;
  name?: string;
  flag?: string;
  deleted?: boolean;
  cqZone?: number;
  ituZone?: number;
  cq?: number[];
  itu?: number[];
  continent?: string[];
}

const dxccEntities = ((dxccData as { dxcc?: DxccJsonEntity[] }).dxcc ?? [])
  .filter((entity): entity is DxccJsonEntity & { entityCode: number; name: string } => (
    typeof entity.entityCode === 'number' && !!entity.name
  ));

const dxccById = new Map(dxccEntities.map((entity) => [entity.entityCode, entity]));
let ctyIndex: CtyIndex | null = null;

const CHINA_SUBDIVISIONS: LoTWSubdivisionOption[] = [
  { code: 'AH', name: 'Anhui', aliases: ['ANHUI', 'ANHUI SHENG', '安徽', '安徽省'] },
  { code: 'BJ', name: 'Beijing', aliases: ['BEIJING', 'BEIJING SHI', 'PEKING', '北京', '北京市'] },
  { code: 'CQ', name: 'Chongqing', aliases: ['CHONGQING', 'CHONGQING SHI', '重庆', '重庆市'] },
  { code: 'FJ', name: 'Fujian', aliases: ['FUJIAN', 'FUJIAN SHENG', '福建', '福建省'] },
  { code: 'GD', name: 'Guangdong', aliases: ['GUANGDONG', 'GUANGDONG SHENG', '广东', '广东省'] },
  { code: 'GS', name: 'Gansu', aliases: ['GANSU', 'GANSU SHENG', '甘肃', '甘肃省'] },
  { code: 'GX', name: 'Guangxi Zhuangzu', aliases: ['GUANGXI', 'GUANGXI ZHUANGZU', 'GUANGXI ZHUANG', '广西', '广西壮族自治区'] },
  { code: 'GZ', name: 'Guizhou', aliases: ['GUIZHOU', 'GUIZHOU SHENG', '贵州', '贵州省'] },
  { code: 'HA', name: 'Henan', aliases: ['HENAN', 'HENAN SHENG', '河南', '河南省'] },
  { code: 'HB', name: 'Hubei', aliases: ['HUBEI', 'HUBEI SHENG', '湖北', '湖北省'] },
  { code: 'HE', name: 'Hebei', aliases: ['HEBEI', 'HEBEI SHENG', '河北', '河北省'] },
  { code: 'HI', name: 'Hainan', aliases: ['HAINAN', 'HAINAN SHENG', '海南', '海南省'] },
  { code: 'HL', name: 'Heilongjiang', aliases: ['HEILONGJIANG', 'HEILONGJIANG SHENG', '黑龙江', '黑龙江省'] },
  { code: 'HN', name: 'Hunan', aliases: ['HUNAN', 'HUNAN SHENG', '湖南', '湖南省'] },
  { code: 'JL', name: 'Jilin', aliases: ['JILIN', 'JILIN SHENG', '吉林', '吉林省'] },
  { code: 'JS', name: 'Jiangsu', aliases: ['JIANGSU', 'JIANGSU SHENG', '江苏', '江苏省'] },
  { code: 'JX', name: 'Jiangxi', aliases: ['JIANGXI', 'JIANGXI SHENG', '江西', '江西省'] },
  { code: 'LN', name: 'Liaoning', aliases: ['LIAONING', 'LIAONING SHENG', '辽宁', '辽宁省'] },
  { code: 'NM', name: 'Nei Mongol', aliases: ['NEI MONGOL', 'INNER MONGOLIA', 'NEIMENGGU', '内蒙古', '内蒙古自治区'] },
  { code: 'NX', name: 'Ningxia Huizu', aliases: ['NINGXIA', 'NINGXIA HUIZU', 'NINGXIA HUI', '宁夏', '宁夏回族自治区'] },
  { code: 'QH', name: 'Qinghai', aliases: ['QINGHAI', 'QINGHAI SHENG', '青海', '青海省'] },
  { code: 'SC', name: 'Sichuan', aliases: ['SICHUAN', 'SICHUAN SHENG', '四川', '四川省'] },
  { code: 'SD', name: 'Shandong', aliases: ['SHANDONG', 'SHANDONG SHENG', '山东', '山东省'] },
  { code: 'SH', name: 'Shanghai', aliases: ['SHANGHAI', 'SHANGHAI SHI', '上海', '上海市'] },
  { code: 'SN', name: 'Shaanxi', aliases: ['SHAANXI', 'SHAANXI SHENG', '陕西', '陕西省'] },
  { code: 'SX', name: 'Shanxi', aliases: ['SHANXI', 'SHANXI SHENG', '山西', '山西省'] },
  { code: 'TJ', name: 'Tianjin', aliases: ['TIANJIN', 'TIANJIN SHI', '天津', '天津市'] },
  { code: 'XJ', name: 'Xinjiang Uygur', aliases: ['XINJIANG', 'XINJIANG UYGUR', '新疆', '新疆维吾尔自治区'] },
  { code: 'XZ', name: 'Xizang', aliases: ['XIZANG', 'TIBET', '西藏', '西藏自治区'] },
  { code: 'YN', name: 'Yunnan', aliases: ['YUNNAN', 'YUNNAN SHENG', '云南', '云南省'] },
  { code: 'ZJ', name: 'Zhejiang', aliases: ['ZHEJIANG', 'ZHEJIANG SHENG', '浙江', '浙江省'] },
];

const US_STATES: LoTWSubdivisionOption[] = [
  'AL Alabama','AK Alaska','AZ Arizona','AR Arkansas','CA California','CO Colorado','CT Connecticut','DE Delaware','FL Florida','GA Georgia','HI Hawaii','ID Idaho','IL Illinois','IN Indiana','IA Iowa','KS Kansas','KY Kentucky','LA Louisiana','ME Maine','MD Maryland','MA Massachusetts','MI Michigan','MN Minnesota','MS Mississippi','MO Missouri','MT Montana','NE Nebraska','NV Nevada','NH New Hampshire','NJ New Jersey','NM New Mexico','NY New York','NC North Carolina','ND North Dakota','OH Ohio','OK Oklahoma','OR Oregon','PA Pennsylvania','RI Rhode Island','SC South Carolina','SD South Dakota','TN Tennessee','TX Texas','UT Utah','VT Vermont','VA Virginia','WA Washington','WV West Virginia','WI Wisconsin','WY Wyoming','DC District of Columbia'
].map((item) => {
  const [code, ...name] = item.split(' ');
  return { code: code!, name: name.join(' ') };
});

const CANADA_PROVINCES: LoTWSubdivisionOption[] = [
  { code: 'AB', name: 'Alberta' }, { code: 'BC', name: 'British Columbia' },
  { code: 'MB', name: 'Manitoba' }, { code: 'NB', name: 'New Brunswick' },
  { code: 'NF', name: 'Newfoundland and Labrador', aliases: ['NL', 'NEWFOUNDLAND', 'NEWFOUNDLAND AND LABRADOR'] },
  { code: 'NS', name: 'Nova Scotia' }, { code: 'NT', name: 'Northwest Territories' },
  { code: 'NU', name: 'Nunavut' }, { code: 'ON', name: 'Ontario' },
  { code: 'PE', name: 'Prince Edward Island' },
  { code: 'PQ', name: 'Quebec', aliases: ['QC', 'QUEBEC'] },
  { code: 'SK', name: 'Saskatchewan' }, { code: 'YT', name: 'Yukon' },
];

const AU_STATES: LoTWSubdivisionOption[] = [
  { code: 'ACT', name: 'Australian Capital Territory' }, { code: 'NSW', name: 'New South Wales' },
  { code: 'NT', name: 'Northern Territory' }, { code: 'QLD', name: 'Queensland' },
  { code: 'SA', name: 'South Australia' }, { code: 'TAS', name: 'Tasmania' },
  { code: 'VIC', name: 'Victoria' }, { code: 'WA', name: 'Western Australia' },
];

const JA_PREFECTURES: LoTWSubdivisionOption[] = [
  '01 Hokkaido','02 Aomori','03 Iwate','04 Akita','05 Yamagata','06 Miyagi','07 Fukushima','08 Niigata','09 Nagano','10 Tokyo','11 Kanagawa','12 Chiba','13 Saitama','14 Ibaraki','15 Tochigi','16 Gunma','17 Yamanashi','18 Shizuoka','19 Gifu','20 Aichi','21 Mie','22 Kyoto','23 Shiga','24 Nara','25 Osaka','26 Wakayama','27 Hyogo','28 Toyama','29 Fukui','30 Ishikawa','31 Okayama','32 Shimane','33 Yamaguchi','34 Tottori','35 Hiroshima','36 Kagawa','37 Tokushima','38 Ehime','39 Kochi','40 Fukuoka','41 Saga','42 Nagasaki','43 Kumamoto','44 Oita','45 Miyazaki','46 Kagoshima','47 Okinawa'
].map((item) => {
  const [code, ...name] = item.split(' ');
  return { code: code!, name: name.join(' ') };
});

const LOCATION_RULES = new Map<number, LoTWLocationRule>([
  [1, { dxccId: 1, stateField: 'CA_PROVINCE', stateLabel: 'Province', stateOptions: CANADA_PROVINCES }],
  [5, { dxccId: 5, stateField: 'FI_KUNTA', stateLabel: 'Kunta' }],
  [6, { dxccId: 6, stateField: 'US_STATE', stateLabel: 'State', countyField: 'US_COUNTY', countyLabel: 'County', stateOptions: US_STATES }],
  [15, { dxccId: 15, stateField: 'RU_OBLAST', stateLabel: 'Oblast' }],
  [54, { dxccId: 54, stateField: 'RU_OBLAST', stateLabel: 'Oblast' }],
  [61, { dxccId: 61, stateField: 'RU_OBLAST', stateLabel: 'Oblast' }],
  [110, { dxccId: 110, stateField: 'US_STATE', stateLabel: 'State', countyField: 'US_COUNTY', countyLabel: 'County', stateOptions: US_STATES }],
  [125, { dxccId: 125, stateField: 'RU_OBLAST', stateLabel: 'Oblast' }],
  [150, { dxccId: 150, stateField: 'AU_STATE', stateLabel: 'State', stateOptions: AU_STATES }],
  [151, { dxccId: 151, stateField: 'RU_OBLAST', stateLabel: 'Oblast' }],
  [224, { dxccId: 224, stateField: 'FI_KUNTA', stateLabel: 'Kunta' }],
  [291, { dxccId: 291, stateField: 'US_STATE', stateLabel: 'State', countyField: 'US_COUNTY', countyLabel: 'County', stateOptions: US_STATES }],
  [318, { dxccId: 318, stateField: 'CN_PROVINCE', stateLabel: 'Province', stateOptions: CHINA_SUBDIVISIONS }],
  [339, { dxccId: 339, stateField: 'JA_PREFECTURE', stateLabel: 'Prefecture', countyField: 'JA_CITY_GUN_KU', countyLabel: 'City / Gun / Ku', stateOptions: JA_PREFECTURES }],
]);

const CHINA_GRID_BOUNDS: Array<{ code: string; latMin: number; latMax: number; lonMin: number; lonMax: number }> = [
  { code: 'ZJ', latMin: 27.0, latMax: 31.5, lonMin: 118.0, lonMax: 123.5 },
  { code: 'SH', latMin: 30.6, latMax: 31.9, lonMin: 120.8, lonMax: 122.2 },
  { code: 'JS', latMin: 30.7, latMax: 35.2, lonMin: 116.2, lonMax: 122.3 },
  { code: 'AH', latMin: 29.3, latMax: 34.7, lonMin: 114.8, lonMax: 119.8 },
  { code: 'FJ', latMin: 23.5, latMax: 28.4, lonMin: 115.5, lonMax: 120.8 },
  { code: 'GD', latMin: 20.0, latMax: 25.6, lonMin: 109.5, lonMax: 117.5 },
  { code: 'BJ', latMin: 39.4, latMax: 41.1, lonMin: 115.3, lonMax: 117.6 },
  { code: 'TJ', latMin: 38.5, latMax: 40.3, lonMin: 116.7, lonMax: 118.1 },
  { code: 'HE', latMin: 36.0, latMax: 42.7, lonMin: 113.3, lonMax: 119.9 },
  { code: 'SD', latMin: 34.3, latMax: 38.4, lonMin: 114.8, lonMax: 122.8 },
  { code: 'LN', latMin: 38.7, latMax: 43.5, lonMin: 118.5, lonMax: 125.8 },
  { code: 'JL', latMin: 40.8, latMax: 46.4, lonMin: 121.6, lonMax: 131.3 },
  { code: 'HL', latMin: 43.4, latMax: 53.6, lonMin: 121.1, lonMax: 135.2 },
  { code: 'HA', latMin: 31.3, latMax: 36.4, lonMin: 110.3, lonMax: 116.7 },
  { code: 'HB', latMin: 29.0, latMax: 33.3, lonMin: 108.4, lonMax: 116.1 },
  { code: 'HN', latMin: 24.6, latMax: 30.2, lonMin: 108.8, lonMax: 114.3 },
  { code: 'JX', latMin: 24.5, latMax: 30.1, lonMin: 113.5, lonMax: 118.5 },
  { code: 'GX', latMin: 20.8, latMax: 26.4, lonMin: 104.3, lonMax: 112.1 },
  { code: 'HI', latMin: 18.0, latMax: 20.3, lonMin: 108.6, lonMax: 111.1 },
  { code: 'SC', latMin: 26.0, latMax: 34.3, lonMin: 97.3, lonMax: 108.6 },
  { code: 'CQ', latMin: 28.1, latMax: 32.3, lonMin: 105.2, lonMax: 110.2 },
  { code: 'GZ', latMin: 24.5, latMax: 29.2, lonMin: 103.6, lonMax: 109.6 },
  { code: 'YN', latMin: 21.0, latMax: 29.3, lonMin: 97.5, lonMax: 106.2 },
  { code: 'SN', latMin: 31.7, latMax: 39.6, lonMin: 105.3, lonMax: 111.3 },
  { code: 'SX', latMin: 34.5, latMax: 40.8, lonMin: 110.2, lonMax: 114.6 },
  { code: 'GS', latMin: 32.0, latMax: 42.8, lonMin: 92.0, lonMax: 108.8 },
  { code: 'QH', latMin: 31.4, latMax: 39.2, lonMin: 89.4, lonMax: 103.1 },
  { code: 'NX', latMin: 35.2, latMax: 39.4, lonMin: 104.0, lonMax: 107.8 },
  { code: 'NM', latMin: 37.2, latMax: 53.4, lonMin: 97.1, lonMax: 126.1 },
  { code: 'XJ', latMin: 34.2, latMax: 49.3, lonMin: 73.3, lonMax: 96.4 },
  { code: 'XZ', latMin: 26.7, latMax: 36.5, lonMin: 78.3, lonMax: 99.1 },
];

function getCtyIndex(): CtyIndex {
  ctyIndex ??= new CtyIndex(parseCTYCsv(ctyCsvText), 'cty-runtime');
  return ctyIndex;
}

function normalizeText(value?: string | number | null): string {
  return String(value ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
}

function normalizeGrid(value?: string): string {
  return normalizeText(value).replace(/\s+/g, '');
}

function normalizeZone(value?: string): string {
  return normalizeText(value).replace(/^0+([1-9])$/, '$1');
}

function optionMatches(option: LoTWSubdivisionOption, raw: string): boolean {
  const normalized = normalizeText(raw);
  const compact = normalized.replace(/[\s._-]+/g, '');
  const candidates = [option.code, option.name, ...(option.aliases ?? [])];
  return candidates.some((candidate) => {
    const candidateNorm = normalizeText(candidate);
    return normalized === candidateNorm || compact === candidateNorm.replace(/[\s._-]+/g, '');
  });
}

function normalizeSubdivision(rule: LoTWLocationRule | undefined, value?: string): { value?: string; suggested?: string; label?: string; valid: boolean } {
  const raw = normalizeText(value);
  if (!raw) return { valid: true };
  const options = rule?.stateOptions;
  if (!options?.length) return { value: raw, valid: true };
  const match = options.find((option) => optionMatches(option, raw));
  if (!match) return { value: raw, valid: false };
  return { value: match.code, suggested: match.code === raw ? undefined : match.code, label: match.name, valid: true };
}

function allowedDetail(options?: LoTWSubdivisionOption[]): string {
  return options?.map((option) => `${option.code}=${option.name}`).join('|') ?? '';
}

function defaultZoneSuggestion(dxccId?: number): { cqZone?: number; ituZone?: number; source: LoTWSuggestionSource } {
  const entity = dxccId ? dxccById.get(dxccId) : undefined;
  return { cqZone: entity?.cqZone, ituZone: entity?.ituZone, source: 'dxcc' };
}

function ctyZoneSuggestion(callsign?: string, dxccId?: number): { cqZone?: number; ituZone?: number; source: LoTWSuggestionSource } | null {
  const normalized = normalizeText(callsign);
  if (!normalized) return null;
  const match = getCtyIndex().lookup(normalized);
  if (!match) return null;
  if (dxccId && match.entityCode && match.entityCode !== dxccId) return null;
  return { cqZone: match.cqZone, ituZone: match.ituZone, source: 'cty' };
}

function suggestChinaSubdivisionFromGrid(gridSquare?: string): LoTWSubdivisionOption | null {
  const coords = gridToCoordinates(normalizeGrid(gridSquare));
  if (!coords) return null;
  const match = CHINA_GRID_BOUNDS.find((bounds) => (
    coords.lat >= bounds.latMin && coords.lat <= bounds.latMax
    && coords.lon >= bounds.lonMin && coords.lon <= bounds.lonMax
  ));
  return match ? CHINA_SUBDIVISIONS.find((option) => option.code === match.code) ?? null : null;
}

export function getLoTWDXCCOptions(): LoTWDXCCOption[] {
  return dxccEntities
    .filter((entity) => entity.deleted !== true)
    .map((entity) => ({
      entityCode: entity.entityCode,
      name: entity.name,
      flag: entity.flag,
      deleted: entity.deleted,
      cqZone: entity.cqZone,
      ituZone: entity.ituZone,
      cq: entity.cq,
      itu: entity.itu,
      continent: entity.continent,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function getLoTWLocationRule(dxccId?: number | null): LoTWLocationRule | null {
  return dxccId ? LOCATION_RULES.get(dxccId) ?? null : null;
}

export function getLoTWSubdivisionOptions(dxccId?: number | null): LoTWSubdivisionOption[] {
  return getLoTWLocationRule(dxccId)?.stateOptions ?? [];
}

export function getLoTWDXCCEntity(dxccId?: number | null): LoTWDXCCOption | null {
  if (!dxccId) return null;
  const entity = dxccById.get(dxccId);
  if (!entity?.entityCode || !entity.name) return null;
  return {
    entityCode: entity.entityCode,
    name: entity.name,
    flag: entity.flag,
    deleted: entity.deleted,
    cqZone: entity.cqZone,
    ituZone: entity.ituZone,
    cq: entity.cq,
    itu: entity.itu,
    continent: entity.continent,
  };
}

export function normalizeLoTWStationLocation(location: LoTWStationLocationInput): { location: LoTWCanonicalStationLocation | null; issues: LoTWLocationIssue[] } {
  const issues: LoTWLocationIssue[] = [];
  const callsign = normalizeText(location.callsign);
  const dxccId = location.dxccId;
  const gridSquare = normalizeGrid(location.gridSquare);
  const cqZone = normalizeZone(location.cqZone);
  const ituZone = normalizeZone(location.ituZone);
  const rule = getLoTWLocationRule(dxccId);

  if (!callsign) issues.push({ code: 'lotw_location_callsign_missing', severity: 'error', message: 'LoTW upload callsign is not configured', field: 'callsign' });
  if (!dxccId) issues.push({ code: 'lotw_location_dxcc_missing', severity: 'error', message: 'LoTW upload DXCC is not configured', field: 'dxccId' });
  if (!gridSquare) issues.push({ code: 'lotw_location_grid_missing', severity: 'error', message: 'LoTW upload grid square is not configured', field: 'gridSquare' });
  if (!cqZone) issues.push({ code: 'lotw_location_cq_missing', severity: 'error', message: 'LoTW upload CQ zone is not configured', field: 'cqZone' });
  if (!ituZone) issues.push({ code: 'lotw_location_itu_missing', severity: 'error', message: 'LoTW upload ITU zone is not configured', field: 'ituZone' });

  const state = normalizeSubdivision(rule ?? undefined, location.state);
  if (rule?.stateField && !state.value) {
    issues.push({ code: 'lotw_location_state_missing', severity: 'error', message: `${rule.stateLabel} is required for this DXCC`, field: rule.stateField });
  } else if (rule?.stateField && state.value && !state.valid) {
    issues.push({
      code: 'lotw_location_state_invalid',
      severity: 'error',
      message: `${rule.stateLabel} is not a valid ADIF value for this DXCC`,
      field: rule.stateField,
      value: normalizeText(location.state),
      detail: `dxccId=${dxccId}; field=${rule.stateField}; value=${normalizeText(location.state)}; allowed=${allowedDetail(rule.stateOptions)}`,
    });
  } else if (rule?.stateField && state.suggested) {
    issues.push({
      code: 'lotw_location_state_suggested',
      severity: 'warning',
      message: `${rule.stateLabel} will be normalized to ${state.suggested}`,
      field: rule.stateField,
      value: normalizeText(location.state),
      suggested: state.suggested,
      detail: `dxccId=${dxccId}; field=${rule.stateField}; value=${normalizeText(location.state)}; suggested=${state.suggested}`,
    });
  }

  const county = normalizeText(location.county);
  if (rule?.countyField && !county) {
    issues.push({ code: 'lotw_location_county_missing', severity: 'error', message: `${rule.countyLabel ?? 'County'} is required for this DXCC`, field: rule.countyField });
  }

  if (issues.some((issue) => issue.severity === 'error')) {
    return { location: null, issues };
  }

  return {
    location: {
      callsign,
      dxccId: dxccId!,
      gridSquare,
      cqZone,
      ituZone,
      iota: normalizeText(location.iota) || undefined,
      state: state.value,
      county: county || undefined,
      stateField: rule?.stateField,
      countyField: rule?.countyField,
    },
    issues,
  };
}

export function validateStationLocation(location: LoTWStationLocationInput): LoTWLocationIssue[] {
  return normalizeLoTWStationLocation(location).issues;
}

export function suggestStationLocation(input: { callsign?: string; dxccId?: number; gridSquare?: string; current?: LoTWStationLocationInput }): LoTWStationSuggestionResult {
  const issues: LoTWLocationIssue[] = [];
  const suggestions: LoTWStationSuggestion[] = [];
  const zoneSuggestion = ctyZoneSuggestion(input.callsign, input.dxccId) ?? defaultZoneSuggestion(input.dxccId);
  const current = input.current ?? {};

  if (zoneSuggestion.cqZone && normalizeZone(current.cqZone) !== String(zoneSuggestion.cqZone)) {
    suggestions.push({ field: 'cqZone', value: String(zoneSuggestion.cqZone), source: zoneSuggestion.source, confidence: zoneSuggestion.source === 'cty' ? 'high' : 'medium' });
  }
  if (zoneSuggestion.ituZone && normalizeZone(current.ituZone) !== String(zoneSuggestion.ituZone)) {
    suggestions.push({ field: 'ituZone', value: String(zoneSuggestion.ituZone), source: zoneSuggestion.source, confidence: zoneSuggestion.source === 'cty' ? 'high' : 'medium' });
  }

  const rule = getLoTWLocationRule(input.dxccId);
  if (input.dxccId === 318) {
    const fromGrid = suggestChinaSubdivisionFromGrid(input.gridSquare);
    const currentState = normalizeSubdivision(rule ?? undefined, current.state);
    if (fromGrid && currentState.value !== fromGrid.code) {
      suggestions.push({ field: 'state', value: fromGrid.code, label: fromGrid.name, source: 'grid', confidence: 'medium' });
    }
  }

  if (current.state) {
    const normalized = normalizeSubdivision(rule ?? undefined, current.state);
    if (normalized.suggested) {
      suggestions.push({ field: 'state', value: normalized.suggested, label: normalized.label, source: 'adif', confidence: 'high' });
    }
  }

  for (const issue of validateStationLocation({ ...current, dxccId: input.dxccId ?? current.dxccId, gridSquare: input.gridSquare ?? current.gridSquare, callsign: input.callsign ?? current.callsign })) {
    if (issue.code === 'lotw_location_state_invalid' || issue.code === 'lotw_location_state_suggested') {
      issues.push(issue);
    }
  }

  const seen = new Set<string>();
  return {
    suggestions: suggestions.filter((suggestion) => {
      const key = `${suggestion.field}:${suggestion.value}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
    issues,
  };
}
