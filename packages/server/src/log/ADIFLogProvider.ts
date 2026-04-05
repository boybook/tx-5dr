/* eslint-disable @typescript-eslint/no-explicit-any */
// ADIFLogProvider - 日志解析需要使用any

import {
  type LogBookDxccSummary,
  type LogBookImportResult,
  type QSORecord,
} from '@tx5dr/contracts';
import {
  ILogProvider,
  LogQueryOptions,
  LogStatistics,
  CallsignAnalysis,
  getBandFromFrequency,
  extractPrefix,
  getCQZone,
  getITUZone,
  resolveDXCCEntity,
  DXCC_RESOLVER_VERSION,
} from '@tx5dr/core';
import { AdifParser } from 'adif-parser-ts';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { getDataFilePath } from '../utils/app-paths.js';
import { createLogger } from '../utils/logger.js';
import {
  buildImportedQsoFingerprint,
  parseTx5drCsvContent,
} from './logImportUtils.js';

const logger = createLogger('ADIFLogProvider');

// —— 索引数据结构 ——
interface PerCallsignInfo {
  count: number;
  lastQSO: QSORecord;
  grids: Set<string>;
}

interface OperatorIndex {
  prefixes: Set<string>;
  cqZones: Set<number>;
  ituZones: Set<number>;
  workedDxccEntities: Set<number>;
  confirmedDxccEntities: Set<number>;
  workedBandDxcc: Map<string, Set<number>>;
  workedBandGrids: Map<string, Set<string>>;
  confirmedBandDxcc: Map<string, Set<number>>;
  workedModeDxcc: Map<string, Set<number>>;
  confirmedModeDxcc: Map<string, Set<number>>;
  perCallsign: Map<string, PerCallsignInfo>;
  // 每个呼号对应已通联过的频段集合（用于O(1)按频段判重）
  perCallsignBands: Map<string, Set<string>>;
}

function createEmptyOperatorIndex(): OperatorIndex {
  return {
    prefixes: new Set<string>(),
    cqZones: new Set<number>(),
    ituZones: new Set<number>(),
    workedDxccEntities: new Set<number>(),
    confirmedDxccEntities: new Set<number>(),
    workedBandDxcc: new Map<string, Set<number>>(),
    workedBandGrids: new Map<string, Set<string>>(),
    confirmedBandDxcc: new Map<string, Set<number>>(),
    workedModeDxcc: new Map<string, Set<number>>(),
    confirmedModeDxcc: new Map<string, Set<number>>(),
    perCallsign: new Map<string, PerCallsignInfo>(),
    perCallsignBands: new Map<string, Set<string>>()
  };
}

function formatADIFDateOnly(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10).replace(/-/g, '');
}

function addEntityToBucket(bucket: Map<string, Set<number>>, key: string, dxccId: number): void {
  let entitySet = bucket.get(key);
  if (!entitySet) {
    entitySet = new Set<number>();
    bucket.set(key, entitySet);
  }
  entitySet.add(dxccId);
}

function addStringToBucket(bucket: Map<string, Set<string>>, key: string, value: string): void {
  let valueSet = bucket.get(key);
  if (!valueSet) {
    valueSet = new Set<string>();
    bucket.set(key, valueSet);
  }
  valueSet.add(value);
}

function normalizeGridKey(grid?: string): string | undefined {
  if (!grid) {
    return undefined;
  }

  const normalized = grid.trim().toUpperCase();
  if (normalized.length < 4) {
    return undefined;
  }

  const gridKey = normalized.slice(0, 4);
  return /^[A-R]{2}[0-9]{2}$/.test(gridKey) ? gridKey : undefined;
}

function normalizeGridSearch(grid?: string): string | undefined {
  if (!grid) {
    return undefined;
  }

  const normalized = grid.trim().toUpperCase();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeMode(mode?: string): string {
  return (mode || 'UNKNOWN').toUpperCase();
}

function mapAdifModeToInternal(mode?: string, submode?: string): Pick<QSORecord, 'mode' | 'submode'> {
  const normalizedMode = mode?.trim().toUpperCase();
  const normalizedSubmode = submode?.trim().toUpperCase();

  if (normalizedMode === 'MFSK' && normalizedSubmode === 'FT4') {
    return { mode: 'FT4', submode: 'FT4' };
  }

  return {
    mode: mode || 'FT8',
    submode: submode || undefined,
  };
}

function mapInternalModeToAdif(mode?: string, submode?: string): { mode: string; submode?: string } {
  const normalizedMode = mode?.trim().toUpperCase();
  const normalizedSubmode = submode?.trim().toUpperCase();

  if (normalizedMode === 'FT4') {
    return { mode: 'MFSK', submode: 'FT4' };
  }

  if (normalizedMode === 'MFSK' && normalizedSubmode) {
    return { mode: 'MFSK', submode: normalizedSubmode };
  }

  return {
    mode: mode || 'FT8',
    submode: submode || undefined,
  };
}

function hasLegacyTx5drFields(fields: Record<string, unknown>): boolean {
  return [
    'note',
    'app_tx5dr_station_location_id',
    'app_tx5dr_dxcc_status',
    'app_tx5dr_qrz_qsl_sent',
    'app_tx5dr_qrz_qsl_rcvd',
    'app_tx5dr_qrz_qslsdate',
    'app_tx5dr_qrz_qslrdate',
  ].some((key) => key in fields);
}

function isQSOConfirmed(qso: QSORecord): boolean {
  return qso.lotwQslReceived === 'Y'
    || qso.lotwQslReceived === 'V'
    || qso.qrzQslReceived === 'Y';
}

function enrichQSOWithDXCC(qso: QSORecord): QSORecord {
  if (qso.dxccSource === 'manual_override' && qso.dxccId) {
    return qso;
  }

  const resolution = resolveDXCCEntity(qso.callsign, qso.startTime);
  const info = resolution.entity;
  if (!info) {
    return {
      ...qso,
      dxccId: undefined,
      dxccEntity: undefined,
      countryCode: undefined,
      cqZone: undefined,
      ituZone: undefined,
      dxccStatus: 'unknown',
      dxccSource: 'resolver',
      dxccConfidence: resolution.confidence,
      dxccResolvedAt: Date.now(),
      dxccResolverVersion: DXCC_RESOLVER_VERSION,
      dxccNeedsReview: true,
    };
  }

  return {
    ...qso,
    dxccId: info.entityCode,
    dxccEntity: info.name,
    dxccStatus: info.deleted ? 'deleted' : 'current',
    countryCode: info.countryCode,
    cqZone: info.cqZone,
    ituZone: info.ituZone,
    dxccSource: 'resolver',
    dxccConfidence: resolution.confidence,
    dxccResolvedAt: Date.now(),
    dxccResolverVersion: DXCC_RESOLVER_VERSION,
    dxccNeedsReview: resolution.needsReview,
  };
}

const IMPORT_MERGE_FIELDS: Array<keyof QSORecord> = [
  'grid',
  'myGrid',
  'myCallsign',
  'qth',
  'remarks',
  'reportSent',
  'reportReceived',
  'submode',
  'endTime',
  'frequency',
  'dxccId',
  'dxccEntity',
  'dxccStatus',
  'countryCode',
  'cqZone',
  'ituZone',
  'dxccSource',
  'dxccConfidence',
  'dxccResolvedAt',
  'dxccResolverVersion',
  'dxccNeedsReview',
  'stationLocationId',
  'myDxccId',
  'myCqZone',
  'myItuZone',
  'myState',
  'myCounty',
  'myIota',
];

const LOTW_SENT_PRIORITY: Record<string, number> = {
  I: 1,
  N: 2,
  R: 3,
  Q: 4,
  Y: 5,
};

const LOTW_RECEIVED_PRIORITY: Record<string, number> = {
  I: 1,
  N: 2,
  R: 3,
  Y: 4,
  V: 5,
};

const QRZ_PRIORITY: Record<string, number> = {
  N: 1,
  Y: 2,
};

function isMissingValue(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  if (typeof value === 'string') {
    return value.trim().length === 0;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  if (typeof value === 'number') {
    return Number.isNaN(value);
  }
  return false;
}

function mergeStatusValue<T extends string | undefined>(
  current: T,
  incoming: T,
  priority: Record<string, number>
): T {
  if (!incoming) {
    return current;
  }
  if (!current) {
    return incoming;
  }
  return (priority[incoming] || 0) > (priority[current] || 0) ? incoming : current;
}

function mergeTimestampValue(current?: number, incoming?: number): number | undefined {
  if (!Number.isFinite(incoming)) {
    return current;
  }
  if (!Number.isFinite(current)) {
    return incoming;
  }
  return Math.max(current!, incoming!);
}

function addQSOToIndex(index: OperatorIndex, qso: QSORecord): void {
  const band = getBandFromFrequency(qso.frequency);
  const gridKey = normalizeGridKey(qso.grid);

  // 前缀/CQ/ITU（使用 core 的高效实现）
  try {
    const prefix = extractPrefix(qso.callsign.toUpperCase());
    if (prefix) index.prefixes.add(prefix);
  } catch {}
  try {
    const cq = getCQZone(qso.callsign.toUpperCase());
    if (cq !== null) index.cqZones.add(cq);
  } catch {}
  try {
    const itu = getITUZone(qso.callsign.toUpperCase());
    if (itu !== null) index.ituZones.add(itu);
  } catch {}
  if (qso.dxccId) {
    index.workedDxccEntities.add(qso.dxccId);
    if (band && band !== 'Unknown') {
      addEntityToBucket(index.workedBandDxcc, band, qso.dxccId);
    }
    addEntityToBucket(index.workedModeDxcc, normalizeMode(qso.mode), qso.dxccId);

    if (isQSOConfirmed(qso)) {
      index.confirmedDxccEntities.add(qso.dxccId);
      if (band && band !== 'Unknown') {
        addEntityToBucket(index.confirmedBandDxcc, band, qso.dxccId);
      }
      addEntityToBucket(index.confirmedModeDxcc, normalizeMode(qso.mode), qso.dxccId);
    }
  }

  if (gridKey && band && band !== 'Unknown') {
    addStringToBucket(index.workedBandGrids, band, gridKey);
  }

  // 按呼号的统计
  const key = qso.callsign.toUpperCase();
  const existing = index.perCallsign.get(key);
  if (!existing) {
    index.perCallsign.set(key, {
      count: 1,
      lastQSO: qso,
      grids: new Set(gridKey ? [gridKey] : [])
    });
  } else {
    existing.count += 1;
    if (!existing.lastQSO || qso.startTime > existing.lastQSO.startTime) {
      existing.lastQSO = qso;
    }
    if (gridKey) existing.grids.add(gridKey);
  }

  // 按呼号的频段集合（用于快速判重）
  try {
    if (band && band !== 'Unknown') {
      let bands = index.perCallsignBands.get(key);
      if (!bands) {
        bands = new Set<string>();
        index.perCallsignBands.set(key, bands);
      }
      bands.add(band);
    }
  } catch {}
}

/**
 * ADIF日志Provider选项
 */
export interface ADIFLogProviderOptions {
  /**
   * 日志文件路径（如果不提供，将自动查找）
   */
  logFilePath?: string;
  
  /**
   * 是否自动创建不存在的日志文件
   */
  autoCreateFile?: boolean;
  
  /**
   * 日志文件名（默认为 "tx5dr.adi"）
   */
  logFileName?: string;
}

/**
 * ADIF格式的日志Provider实现
 */
export class ADIFLogProvider implements ILogProvider {
  private logFilePath: string = '';
  private options: ADIFLogProviderOptions;
  private qsoCache: Map<string, QSORecord> = new Map();
  private isInitialized: boolean = false;
  private static readonly ALL_KEY = '__ALL__';
  private operatorIndexMap: Map<string, OperatorIndex> = new Map();
  
  constructor(options: ADIFLogProviderOptions = {}) {
    this.options = {
      autoCreateFile: true,
      logFileName: 'tx5dr.adi',
      ...options
    };
  }
  
  /**
   * 初始化Provider
   */
  async initialize(_options?: Record<string, unknown>): Promise<void> {
    if (this.isInitialized) return;
    
    // 确定日志文件路径
    if (this.options.logFilePath) {
      this.logFilePath = this.options.logFilePath;
    } else {
      this.logFilePath = await this.findOrCreateLogPath();
    }
    
    // 如果文件不存在且autoCreateFile为true，创建空文件
    try {
      await fs.access(this.logFilePath);
    } catch {
      if (this.options.autoCreateFile) {
        await this.createEmptyLogFile();
      }
    }
    
    // 加载现有日志到缓存
    await this.loadCache();
    // 构建/重建索引
    this.rebuildIndexes();
    
    this.isInitialized = true;
  }
  
  /**
   * 查找或创建日志文件路径
   */
  private async findOrCreateLogPath(): Promise<string> {
    // 使用新的跨平台路径管理器 - 通联日志本应存储在用户数据目录
    const standardPath = await getDataFilePath(this.options.logFileName!);
    
    // 尝试旧的位置查找现有文件
    const legacyPaths = [
      // 用户文档目录
      path.join(os.homedir(), 'Documents', 'TX-5DR', this.options.logFileName!),
      // 用户主目录下的.tx5dr目录
      path.join(os.homedir(), '.tx5dr', this.options.logFileName!),
      // 当前工作目录
      path.join(process.cwd(), 'logs', this.options.logFileName!),
    ];
    
    // 查找是否有旧的日志文件存在
    for (const legacyPath of legacyPaths) {
      try {
        await fs.access(legacyPath);
        logger.info(`Found legacy log file: ${legacyPath}`);
        logger.info(`Migrating to user data directory: ${standardPath}`);
        
        // 迁移文件到新位置
        const dir = path.dirname(standardPath);
        await fs.mkdir(dir, { recursive: true });
        await fs.copyFile(legacyPath, standardPath);
        
        logger.info('File migration complete');
        return standardPath;
      } catch {
        // 文件不存在，继续下一个
      }
    }
    
    // 没有发现旧文件，使用标准路径
    const dir = path.dirname(standardPath);
    await fs.mkdir(dir, { recursive: true });
    
    return standardPath;
  }
  
  /**
   * 创建空的ADIF日志文件
   */
  private async createEmptyLogFile(): Promise<void> {
    const header = `TX-5DR Log File
<ADIF_VER:5>3.1.4
<PROGRAMID:6>TX-5DR
<PROGRAMVERSION:5>1.0.0
<EOH>
`;
    await fs.writeFile(this.logFilePath, header, 'utf-8');
  }
  
  /**
   * 加载日志到缓存
   */
  private async loadCache(): Promise<void> {
    try {
      const content = await fs.readFile(this.logFilePath, 'utf-8');
      logger.debug(`File content length: ${content.length}`);

      const adif = AdifParser.parseAdi(content);
      logger.debug(`Parsed ${adif.records?.length || 0} records`);
      
      this.qsoCache.clear();
      
      if (adif.records) {
        for (const record of adif.records) {
          try {
            // 直接传递record，而不是record.fields
            const qso = this.adifToQSORecord(record);
            this.qsoCache.set(qso.id, qso);
            logger.debug(`Loaded QSO: ${qso.id} - ${qso.callsign}`);
          } catch (err) {
            logger.error('Failed to load record', { err, record });
          }
        }
      }
      
      logger.debug(`Cache loaded: ${this.qsoCache.size} records`);
    } catch (error) {
      logger.error('Failed to load ADIF log cache', error);
    }
  }

  // —— 索引维护 ——
  private getOperatorKey(_operatorId?: string): string {
    // 单个 provider 始终代表一个呼号日志本；判重和统计按整个日志本计算，
    // 不再依赖运行时 operator UUID 做二次过滤。
    return ADIFLogProvider.ALL_KEY;
  }

  private rebuildIndexes(): void {
    this.operatorIndexMap.clear();
    // 仅预构建 ALL 索引；按需构建其它 operator 索引
    const all = this.buildIndexForAll();
    this.operatorIndexMap.set(ADIFLogProvider.ALL_KEY, all);
  }

  private buildIndexForAll(): OperatorIndex {
    const idx = createEmptyOperatorIndex();
    for (const qso of this.qsoCache.values()) {
      addQSOToIndex(idx, qso);
    }
    return idx;
  }

  private ensureIndex(_operatorId?: string): OperatorIndex {
    const key = this.getOperatorKey();
    let idx = this.operatorIndexMap.get(key);
    if (!idx) {
      idx = this.buildIndexForAll();
      this.operatorIndexMap.set(key, idx);
    }
    return idx;
  }
  
  /**
   * 将ADIF记录转换为QSORecord
   */
  private adifToQSORecord(fields: any): QSORecord {
    // 直接使用小写字段名，因为adif-parser-ts返回的是小写
    const callsign = fields.call;
    const qsoDate = fields.qso_date;
    const timeOn = fields.time_on;
    
    if (!callsign || !qsoDate || !timeOn) {
      throw new Error(`Required fields missing: call=${callsign}, qso_date=${qsoDate}, time_on=${timeOn}`);
    }
    
    // 生成ID（使用呼号+日期+时间+操作员ID）
    let id = `${callsign}_${qsoDate}_${timeOn}`;
    if (fields.operator) {
      id += `_${fields.operator}`;
    }
    
    // 解析日期和时间
    const dateStr = qsoDate; // YYYYMMDD
    const timeStr = timeOn;  // HHMM or HHMMSS
    const year = parseInt(dateStr.substring(0, 4));
    const month = parseInt(dateStr.substring(4, 6)) - 1;
    const day = parseInt(dateStr.substring(6, 8));
    const hour = parseInt(timeStr.substring(0, 2));
    const minute = parseInt(timeStr.substring(2, 4));
    const second = timeStr.length >= 6 ? parseInt(timeStr.substring(4, 6)) : 0;

    const startTime = new Date(Date.UTC(year, month, day, hour, minute, second)).getTime();
    
    // 如果有结束时间，解析它
    let endTime: number | undefined;
    if (fields.time_off) {
      const endDateStr = fields.qso_date_off || qsoDate;
      const endTimeStr = fields.time_off;
      const endYear = parseInt(endDateStr.substring(0, 4));
      const endMonth = parseInt(endDateStr.substring(4, 6)) - 1;
      const endDay = parseInt(endDateStr.substring(6, 8));
      const endHour = parseInt(endTimeStr.substring(0, 2));
      const endMinute = parseInt(endTimeStr.substring(2, 4));
      const endSecond = endTimeStr.length >= 6 ? parseInt(endTimeStr.substring(4, 6)) : 0;
      endTime = new Date(Date.UTC(endYear, endMonth, endDay, endHour, endMinute, endSecond)).getTime();
    }
    
    // 解析频率（MHz转Hz）
    const frequency = fields.freq ? parseFloat(fields.freq) * 1000000 : 0;
    const modeInfo = mapAdifModeToInternal(fields.mode, fields.submode);
    const legacyMyLocationFallback = hasLegacyTx5drFields(fields)
      && !fields.my_state
      && !fields.my_cnty
      && !fields.my_iota;
    
    const record: QSORecord = {
      id,
      callsign,
      grid: fields.gridsquare,
      myGrid: fields.my_gridsquare ?? undefined,
      myCallsign: fields.station_callsign ?? undefined,
      frequency,
      mode: modeInfo.mode,
      submode: modeInfo.submode,
      startTime,
      endTime,
      reportSent: fields.rst_sent,
      reportReceived: fields.rst_rcvd,
      messages: fields.comment ? [fields.comment] : [],
      qth: fields.qth ?? undefined,
      remarks: fields.notes ?? fields.note ?? undefined,
    };

    if (fields.dxcc) {
      const parsedDxcc = Number.parseInt(fields.dxcc, 10);
      if (Number.isFinite(parsedDxcc)) {
        record.dxccId = parsedDxcc;
      }
    }
    if (fields.country) {
      record.dxccEntity = fields.country;
    }
    if (fields.cqz) {
      const parsedCqz = Number.parseInt(fields.cqz, 10);
      if (Number.isFinite(parsedCqz)) {
        record.cqZone = parsedCqz;
      }
    }
    if (fields.ituz) {
      const parsedItuz = Number.parseInt(fields.ituz, 10);
      if (Number.isFinite(parsedItuz)) {
        record.ituZone = parsedItuz;
      }
    }
    if (fields.app_tx5dr_dxcc_status) {
      record.dxccStatus = fields.app_tx5dr_dxcc_status;
    }
    if (fields.app_tx5dr_dxcc_source) {
      record.dxccSource = fields.app_tx5dr_dxcc_source;
    }
    if (fields.app_tx5dr_dxcc_confidence) {
      record.dxccConfidence = fields.app_tx5dr_dxcc_confidence;
    }
    if (fields.app_tx5dr_dxcc_needs_review) {
      record.dxccNeedsReview = fields.app_tx5dr_dxcc_needs_review === 'Y';
    }
    if (fields.app_tx5dr_station_location_id) {
      record.stationLocationId = fields.app_tx5dr_station_location_id;
    }
    if (fields.my_dxcc) {
      const parsedMyDxcc = Number.parseInt(fields.my_dxcc, 10);
      if (Number.isFinite(parsedMyDxcc)) {
        record.myDxccId = parsedMyDxcc;
      }
    }
    if (fields.my_cq_zone) {
      const parsedMyCq = Number.parseInt(fields.my_cq_zone, 10);
      if (Number.isFinite(parsedMyCq)) {
        record.myCqZone = parsedMyCq;
      }
    }
    if (fields.my_itu_zone) {
      const parsedMyItu = Number.parseInt(fields.my_itu_zone, 10);
      if (Number.isFinite(parsedMyItu)) {
        record.myItuZone = parsedMyItu;
      }
    }
    if (fields.my_state) {
      record.myState = fields.my_state;
    } else if (legacyMyLocationFallback && fields.state) {
      record.myState = fields.state;
    }
    if (fields.my_cnty) {
      record.myCounty = fields.my_cnty;
    } else if (legacyMyLocationFallback && fields.cnty) {
      record.myCounty = fields.cnty;
    }
    if (fields.my_iota) {
      record.myIota = fields.my_iota;
    } else if (legacyMyLocationFallback && fields.iota) {
      record.myIota = fields.iota;
    }

    const lotwSent = fields.lotw_qsl_sent?.toUpperCase();
    if (lotwSent && ['Y', 'N', 'R', 'Q', 'I'].includes(lotwSent)) {
      record.lotwQslSent = lotwSent as QSORecord['lotwQslSent'];
    }

    const lotwReceived = fields.lotw_qsl_rcvd?.toUpperCase();
    if (lotwReceived && ['Y', 'N', 'R', 'I', 'V'].includes(lotwReceived)) {
      record.lotwQslReceived = lotwReceived as QSORecord['lotwQslReceived'];
    }

    if (fields.lotw_qslsdate) {
      record.lotwQslSentDate = new Date(`${fields.lotw_qslsdate.slice(0, 4)}-${fields.lotw_qslsdate.slice(4, 6)}-${fields.lotw_qslsdate.slice(6, 8)}T00:00:00Z`).getTime();
    }
    if (fields.lotw_qslrdate) {
      record.lotwQslReceivedDate = new Date(`${fields.lotw_qslrdate.slice(0, 4)}-${fields.lotw_qslrdate.slice(4, 6)}-${fields.lotw_qslrdate.slice(6, 8)}T00:00:00Z`).getTime();
    }

    const qrzSent = fields.app_tx5dr_qrz_qsl_sent?.toUpperCase();
    if (qrzSent && ['Y', 'N'].includes(qrzSent)) {
      record.qrzQslSent = qrzSent as QSORecord['qrzQslSent'];
    }

    const qrzReceived = fields.app_tx5dr_qrz_qsl_rcvd?.toUpperCase() || fields.app_qrzlog_status?.toUpperCase();
    if (qrzReceived === 'C' || qrzReceived === 'Y') {
      record.qrzQslReceived = 'Y';
    } else if (qrzReceived === 'N') {
      record.qrzQslReceived = 'N';
    }

    if (fields.app_tx5dr_qrz_qslsdate) {
      record.qrzQslSentDate = new Date(`${fields.app_tx5dr_qrz_qslsdate.slice(0, 4)}-${fields.app_tx5dr_qrz_qslsdate.slice(4, 6)}-${fields.app_tx5dr_qrz_qslsdate.slice(6, 8)}T00:00:00Z`).getTime();
    }
    if (fields.app_tx5dr_qrz_qslrdate) {
      record.qrzQslReceivedDate = new Date(`${fields.app_tx5dr_qrz_qslrdate.slice(0, 4)}-${fields.app_tx5dr_qrz_qslrdate.slice(4, 6)}-${fields.app_tx5dr_qrz_qslrdate.slice(6, 8)}T00:00:00Z`).getTime();
    }

    return enrichQSOWithDXCC(record);
  }
  
  /**
   * 将QSORecord转换为ADIF记录
   * @param overrideMyGrid 覆盖 qso.myGrid（用于导出时注入兜底网格）
   */
  private qsoRecordToADIF(qso: QSORecord, overrideMyGrid?: string): string {
    const startDate = new Date(qso.startTime);
    const dateStr = startDate.toISOString().slice(0, 10).replace(/-/g, '');
    const timeOnStr = startDate.toISOString().slice(11, 19).replace(/:/g, '');
    const adifMode = mapInternalModeToAdif(qso.mode, qso.submode);
    
    let adifRecord = '';
    
    // 必需字段
    adifRecord += `<CALL:${qso.callsign.length}>${qso.callsign}`;
    adifRecord += `<QSO_DATE:8>${dateStr}`;
    adifRecord += `<TIME_ON:${timeOnStr.length}>${timeOnStr}`;
    adifRecord += `<MODE:${adifMode.mode.length}>${adifMode.mode}`;
    if (adifMode.submode) {
      adifRecord += `<SUBMODE:${adifMode.submode.length}>${adifMode.submode}`;
    }
    adifRecord += `<FREQ:${((qso.frequency / 1000000).toFixed(6)).length}>${(qso.frequency / 1000000).toFixed(6)}`;
    
    const band = getBandFromFrequency(qso.frequency);
    adifRecord += `<BAND:${band.length}>${band}`;
    
    // 可选字段
    if (qso.grid) {
      adifRecord += `<GRIDSQUARE:${qso.grid.length}>${qso.grid}`;
    }
    if (qso.dxccId) {
      const value = String(qso.dxccId);
      adifRecord += `<DXCC:${value.length}>${value}`;
    }
    if (qso.dxccEntity) {
      adifRecord += `<COUNTRY:${qso.dxccEntity.length}>${qso.dxccEntity}`;
    }
    if (qso.cqZone) {
      const value = String(qso.cqZone);
      adifRecord += `<CQZ:${value.length}>${value}`;
    }
    if (qso.ituZone) {
      const value = String(qso.ituZone);
      adifRecord += `<ITUZ:${value.length}>${value}`;
    }

    if (qso.endTime) {
      const endDate = new Date(qso.endTime);
      const endDateStr = endDate.toISOString().slice(0, 10).replace(/-/g, '');
      const timeOffStr = endDate.toISOString().slice(11, 19).replace(/:/g, '');
      adifRecord += `<QSO_DATE_OFF:8>${endDateStr}`;
      adifRecord += `<TIME_OFF:${timeOffStr.length}>${timeOffStr}`;
    }
    
    if (qso.reportSent) {
      adifRecord += `<RST_SENT:${qso.reportSent.length}>${qso.reportSent}`;
    }
    
    if (qso.reportReceived) {
      adifRecord += `<RST_RCVD:${qso.reportReceived.length}>${qso.reportReceived}`;
    }
    
    if (qso.messages && qso.messages.length > 0) {
      const comment = qso.messages.join(' | ');
      adifRecord += `<COMMENT:${comment.length}>${comment}`;
    }

    if (qso.qth) {
      adifRecord += `<QTH:${qso.qth.length}>${qso.qth}`;
    }

    if (qso.remarks) {
      adifRecord += `<NOTES:${qso.remarks.length}>${qso.remarks}`;
    }

    const effectiveMyGrid = overrideMyGrid ?? qso.myGrid;
    if (effectiveMyGrid) {
      adifRecord += `<MY_GRIDSQUARE:${effectiveMyGrid.length}>${effectiveMyGrid}`;
    }

    if (qso.myCallsign) {
      adifRecord += `<STATION_CALLSIGN:${qso.myCallsign.length}>${qso.myCallsign}`;
    }
    if (qso.myDxccId) {
      const value = String(qso.myDxccId);
      adifRecord += `<MY_DXCC:${value.length}>${value}`;
    }
    if (qso.myCqZone) {
      const value = String(qso.myCqZone);
      adifRecord += `<MY_CQ_ZONE:${value.length}>${value}`;
    }
    if (qso.myItuZone) {
      const value = String(qso.myItuZone);
      adifRecord += `<MY_ITU_ZONE:${value.length}>${value}`;
    }
    if (qso.myState) {
      adifRecord += `<MY_STATE:${qso.myState.length}>${qso.myState}`;
    }
    if (qso.myCounty) {
      adifRecord += `<MY_CNTY:${qso.myCounty.length}>${qso.myCounty}`;
    }
    if (qso.myIota) {
      adifRecord += `<MY_IOTA:${qso.myIota.length}>${qso.myIota}`;
    }
    if (qso.stationLocationId) {
      adifRecord += `<APP_TX5DR_STATION_LOCATION_ID:${qso.stationLocationId.length}>${qso.stationLocationId}`;
    }
    if (qso.dxccStatus) {
      adifRecord += `<APP_TX5DR_DXCC_STATUS:${qso.dxccStatus.length}>${qso.dxccStatus}`;
    }
    if (qso.dxccSource) {
      adifRecord += `<APP_TX5DR_DXCC_SOURCE:${qso.dxccSource.length}>${qso.dxccSource}`;
    }
    if (qso.dxccConfidence) {
      adifRecord += `<APP_TX5DR_DXCC_CONFIDENCE:${qso.dxccConfidence.length}>${qso.dxccConfidence}`;
    }
    if (qso.dxccNeedsReview !== undefined) {
      adifRecord += `<APP_TX5DR_DXCC_NEEDS_REVIEW:1>${qso.dxccNeedsReview ? 'Y' : 'N'}`;
    }

    if (qso.lotwQslSent) {
      adifRecord += `<LOTW_QSL_SENT:${qso.lotwQslSent.length}>${qso.lotwQslSent}`;
    }
    if (qso.lotwQslReceived) {
      adifRecord += `<LOTW_QSL_RCVD:${qso.lotwQslReceived.length}>${qso.lotwQslReceived}`;
    }
    if (qso.lotwQslSentDate) {
      adifRecord += `<LOTW_QSLSDATE:8>${formatADIFDateOnly(qso.lotwQslSentDate)}`;
    }
    if (qso.lotwQslReceivedDate) {
      adifRecord += `<LOTW_QSLRDATE:8>${formatADIFDateOnly(qso.lotwQslReceivedDate)}`;
    }

    if (qso.qrzQslSent) {
      adifRecord += `<APP_TX5DR_QRZ_QSL_SENT:${qso.qrzQslSent.length}>${qso.qrzQslSent}`;
    }
    if (qso.qrzQslReceived) {
      adifRecord += `<APP_TX5DR_QRZ_QSL_RCVD:${qso.qrzQslReceived.length}>${qso.qrzQslReceived}`;
      if (qso.qrzQslReceived === 'Y') {
        adifRecord += `<APP_QRZLOG_STATUS:1>C`;
      }
    }
    if (qso.qrzQslSentDate) {
      adifRecord += `<APP_TX5DR_QRZ_QSLSDATE:8>${formatADIFDateOnly(qso.qrzQslSentDate)}`;
    }
    if (qso.qrzQslReceivedDate) {
      adifRecord += `<APP_TX5DR_QRZ_QSLRDATE:8>${formatADIFDateOnly(qso.qrzQslReceivedDate)}`;
    }

    if (qso.myCallsign) {
      adifRecord += `<OPERATOR:${qso.myCallsign.length}>${qso.myCallsign}`;
    }

    adifRecord += '<EOR>\n';
    
    return adifRecord;
  }
  
  /**
   * 保存缓存到文件
   */
  private async saveCache(): Promise<void> {
    let adifContent = `TX-5DR Log File
<ADIF_VER:5>3.1.4
<PROGRAMID:6>TX-5DR
<PROGRAMVERSION:5>1.0.0
<EOH>

`;
    
    for (const qso of this.qsoCache.values()) {
      // 从ID中提取operatorId（如果存在）
      adifContent += this.qsoRecordToADIF(qso);
    }
    
    await fs.writeFile(this.logFilePath, adifContent, 'utf-8');
  }
  
  async addQSO(record: QSORecord, operatorId?: string): Promise<void> {
    this.ensureInitialized();
    record = enrichQSOWithDXCC(record);
    
    // 生成唯一ID
    if (!record.id || this.qsoCache.has(record.id)) {
      record.id = `${record.callsign}_${record.startTime}_${Date.now()}_${operatorId || 'unknown'}`;
    }
    
    this.qsoCache.set(record.id, record);
    // 增量更新 ALL 索引
    const allIdx = this.operatorIndexMap.get(ADIFLogProvider.ALL_KEY);
    if (allIdx) addQSOToIndex(allIdx, record);
    await this.saveCache();
  }
  
  async updateQSO(id: string, updates: Partial<QSORecord>): Promise<void> {
    this.ensureInitialized();
    
    const existing = this.qsoCache.get(id);
    if (!existing) {
      throw new Error(`QSO with id ${id} not found`);
    }
    
    const updated = { ...existing, ...updates, id };
    this.qsoCache.set(id, enrichQSOWithDXCC(updated));
    // 简化处理：更新后重建索引（更新频率低，成本可接受）
    this.rebuildIndexes();
    await this.saveCache();
  }
  
  async deleteQSO(id: string): Promise<void> {
    this.ensureInitialized();
    
    if (!this.qsoCache.delete(id)) {
      throw new Error(`QSO with id ${id} not found`);
    }
    
    // 删除后重建索引
    this.rebuildIndexes();
    await this.saveCache();
  }
  
  async getQSO(id: string): Promise<QSORecord | null> {
    this.ensureInitialized();
    return this.qsoCache.get(id) || null;
  }
  
  async queryQSOs(options?: LogQueryOptions): Promise<QSORecord[]> {
    this.ensureInitialized();
    
    let results = Array.from(this.qsoCache.values());
    
    if (options) {
      // 呼号过滤
      if (options.callsign) {
        const searchCallsign = options.callsign.toUpperCase();
        results = results.filter(qso => 
          qso.callsign.toUpperCase().includes(searchCallsign)
        );
      }
      
      // 网格过滤
      if (options.grid) {
        const searchGrid = normalizeGridSearch(options.grid);
        if (searchGrid) {
          results = results.filter((qso) => {
            const qsoGrid = normalizeGridSearch(qso.grid);
            return qsoGrid?.startsWith(searchGrid) ?? false;
          });
        }
      }
      
      // 频率范围过滤
      if (options.frequencyRange) {
        results = results.filter(qso => 
          qso.frequency >= options.frequencyRange!.min &&
          qso.frequency <= options.frequencyRange!.max
        );
      }
      
      // 时间范围过滤
      if (options.timeRange) {
        results = results.filter(qso => 
          qso.startTime >= options.timeRange!.start &&
          qso.startTime <= options.timeRange!.end
        );
      }
      
      // 模式过滤
      if (options.mode) {
        results = results.filter(qso => qso.mode === options.mode);
      }

      // 排除模式过滤
      if (options.excludeModes && options.excludeModes.length > 0) {
        const excluded = new Set(options.excludeModes.map(m => m.toUpperCase()));
        results = results.filter(qso => !excluded.has((qso.mode || '').toUpperCase()));
      }
      
      // QSL 确认状态过滤
      if (options.qslStatus) {
        results = results.filter(qso => {
          const isConfirmed =
            (qso.lotwQslReceived === 'Y' || qso.lotwQslReceived === 'V') ||
            qso.qrzQslReceived === 'Y';
          const isUploaded =
            qso.lotwQslSent === 'Y' || qso.qrzQslSent === 'Y';

          switch (options.qslStatus) {
            case 'confirmed':
              return isConfirmed;
            case 'uploaded':
              return isUploaded && !isConfirmed;
            case 'none':
              return !isUploaded && !isConfirmed;
            default:
              return true;
          }
        });
      }

      // 排序
      const orderBy = options.orderBy || 'time';
      const orderDir = options.orderDirection || 'desc';
      
      results.sort((a, b) => {
        let comparison = 0;
        
        switch (orderBy) {
          case 'time':
            comparison = a.startTime - b.startTime;
            break;
          case 'callsign':
            comparison = a.callsign.localeCompare(b.callsign);
            break;
          case 'frequency':
            comparison = a.frequency - b.frequency;
            break;
        }
        
        return orderDir === 'asc' ? comparison : -comparison;
      });
      
      // 限制/分页
      if (options.offset) {
        results = results.slice(options.offset);
      }
      if (options.limit) {
        results = results.slice(0, options.limit);
      }
    }
    
    return results;
  }
  
  async hasWorkedCallsign(
    callsign: string,
    options?: { operatorId?: string; band?: string }
  ): Promise<boolean> {
    this.ensureInitialized();
    const operatorId = options?.operatorId;
    const band = options?.band;
    const idx = this.ensureIndex(operatorId);
    const key = callsign.toUpperCase();

    if (band) {
      // 若传入的band不可识别，则视为未通联（保守回复）
      if (band === 'Unknown') return false;
      const bandSet = idx.perCallsignBands.get(key);
      return !!bandSet && bandSet.has(band);
    }

    // 未提供band时，退回到“呼号是否出现过”的宽判定
    const info = idx.perCallsign.get(key);
    return !!info && info.count > 0;
  }
  
  async getLastQSOWithCallsign(callsign: string, operatorId?: string): Promise<QSORecord | null> {
    this.ensureInitialized();
    const idx = this.ensureIndex(operatorId);
    const info = idx.perCallsign.get(callsign.toUpperCase());
    return info ? info.lastQSO : null;
  }
  
  async analyzeCallsign(callsign: string, grid?: string, options?: { operatorId?: string; band?: string }): Promise<CallsignAnalysis> {
    this.ensureInitialized();
    const upper = callsign.toUpperCase();
    const operatorId = options?.operatorId;
    const band = options?.band;
    const idx = this.ensureIndex(operatorId);
    const info = idx.perCallsign.get(upper);

    const prefix = extractPrefix(upper);
    const resolution = resolveDXCCEntity(upper, Date.now());
    const dxccEntity = resolution.entity;
    const cqZone = dxccEntity?.cqZone ?? getCQZone(upper);
    const ituZone = dxccEntity?.ituZone ?? getITUZone(upper);
    const dxccId = dxccEntity?.entityCode;
    const dxccStatus = dxccEntity ? (dxccEntity.deleted ? 'deleted' : 'current') : 'unknown';

    let isNewCallsign: boolean;
    if (band && band !== 'Unknown') {
      const bandSet = idx.perCallsignBands.get(upper);
      isNewCallsign = !(bandSet && bandSet.has(band));
    } else {
      // 未指定band时，退回到宽判定（是否见过该呼号）
      isNewCallsign = !info;
    }
    const lastQSO = info?.lastQSO;
    const qsoCount = info?.count || 0;
    const gridKey = normalizeGridKey(grid);
    const isNewGrid = !!gridKey
      && !!band
      && band !== 'Unknown'
      && !(idx.workedBandGrids.get(band)?.has(gridKey));
    const isNewDxccEntity = dxccId ? !idx.workedDxccEntities.has(dxccId) : false;
    const isNewBandDxccEntity = dxccId && band && band !== 'Unknown'
      ? !(idx.workedBandDxcc.get(band)?.has(dxccId))
      : false;
    const isConfirmedDxcc = dxccId ? idx.confirmedDxccEntities.has(dxccId) : false;
    const isNewCQZone = cqZone !== null && !idx.cqZones.has(cqZone);
    const isNewITUZone = ituZone !== null && !idx.ituZones.has(ituZone);

    return {
      isNewCallsign,
      lastQSO,
      qsoCount,
      isNewGrid,
      isNewDxccEntity,
      isNewBandDxccEntity,
      isConfirmedDxcc,
      isNewCQZone,
      isNewITUZone,
      prefix,
      cqZone: cqZone || undefined,
      ituZone: ituZone || undefined,
      dxccEntity: dxccEntity?.name,
      dxccId,
      dxccStatus,
      dxccNeedsReview: resolution.needsReview,
    };
  }
  
  async getStatistics(_operatorId?: string): Promise<LogStatistics> {
    this.ensureInitialized();
    
    const qsos = await this.queryQSOs();
    
    const uniqueCallsigns = new Set<string>();
    const uniqueGrids = new Set<string>();
    const byMode = new Map<string, number>();
    const byBand = new Map<string, number>();
    let lastQSOTime: number | undefined;
    let firstQSOTime: number | undefined;
    
    for (const qso of qsos) {
      uniqueCallsigns.add(qso.callsign);
      
      const gridKey = normalizeGridKey(qso.grid);
      if (gridKey) {
        uniqueGrids.add(gridKey);
      }
      
      // 按模式统计
      const modeCount = byMode.get(qso.mode) || 0;
      byMode.set(qso.mode, modeCount + 1);
      
      // 按频段统计
      const band = getBandFromFrequency(qso.frequency);
      const bandCount = byBand.get(band) || 0;
      byBand.set(band, bandCount + 1);
      
      // 更新最后QSO时间
      if (!lastQSOTime || qso.startTime > lastQSOTime) {
        lastQSOTime = qso.startTime;
      }
      if (!firstQSOTime || qso.startTime < firstQSOTime) {
        firstQSOTime = qso.startTime;
      }
    }
    const dxcc = await this.getDXCCSummary();

    return {
      totalQSOs: qsos.length,
      uniqueCallsigns: uniqueCallsigns.size,
      uniqueGrids: uniqueGrids.size,
      byMode,
      byBand,
      lastQSOTime,
      firstQSOTime,
      dxcc,
    };
  }

  async getDXCCSummary(_operatorId?: string): Promise<LogBookDxccSummary> {
    this.ensureInitialized();

    const qsos = await this.queryQSOs();
    const workedCurrent = new Set<number>();
    const workedDeleted = new Set<number>();
    const confirmedCurrent = new Set<number>();
    const confirmedDeleted = new Set<number>();
    const byBand = new Map<string, { worked: Set<number>; confirmed: Set<number> }>();
    const byMode = new Map<string, { worked: Set<number>; confirmed: Set<number> }>();
    let reviewCount = 0;

    for (const qso of qsos) {
      if (qso.dxccNeedsReview) {
        reviewCount += 1;
      }
      if (!qso.dxccId) {
        continue;
      }

      const isDeleted = qso.dxccStatus === 'deleted';
      const isConfirmed = isQSOConfirmed(qso);
      const band = getBandFromFrequency(qso.frequency);
      const mode = normalizeMode(qso.mode);

      (isDeleted ? workedDeleted : workedCurrent).add(qso.dxccId);
      if (isConfirmed) {
        (isDeleted ? confirmedDeleted : confirmedCurrent).add(qso.dxccId);
      }

      if (band && band !== 'Unknown') {
        let bandEntry = byBand.get(band);
        if (!bandEntry) {
          bandEntry = { worked: new Set<number>(), confirmed: new Set<number>() };
          byBand.set(band, bandEntry);
        }
        bandEntry.worked.add(qso.dxccId);
        if (isConfirmed) {
          bandEntry.confirmed.add(qso.dxccId);
        }
      }

      let modeEntry = byMode.get(mode);
      if (!modeEntry) {
        modeEntry = { worked: new Set<number>(), confirmed: new Set<number>() };
        byMode.set(mode, modeEntry);
      }
      modeEntry.worked.add(qso.dxccId);
      if (isConfirmed) {
        modeEntry.confirmed.add(qso.dxccId);
      }
    }

    return {
      worked: {
        current: workedCurrent.size,
        total: workedCurrent.size + workedDeleted.size,
        deleted: workedDeleted.size,
      },
      confirmed: {
        current: confirmedCurrent.size,
        total: confirmedCurrent.size + confirmedDeleted.size,
        deleted: confirmedDeleted.size,
      },
      reviewCount,
      byBand: Array.from(byBand.entries())
        .map(([key, value]) => ({ key, worked: value.worked.size, confirmed: value.confirmed.size }))
        .sort((left, right) => left.key.localeCompare(right.key)),
      byMode: Array.from(byMode.entries())
        .map(([key, value]) => ({ key, worked: value.worked.size, confirmed: value.confirmed.size }))
        .sort((left, right) => left.key.localeCompare(right.key)),
    };
  }
  
  async exportADIF(options?: LogQueryOptions, exportOptions?: { fallbackGrid?: string }): Promise<string> {
    this.ensureInitialized();

    const qsos = await this.queryQSOs(options);

    let adifContent = `TX-5DR Export
<ADIF_VER:5>3.1.4
<PROGRAMID:6>TX-5DR
<PROGRAMVERSION:5>1.0.0
<EOH>

`;

    for (const qso of qsos) {
      const effectiveMyGrid = qso.myGrid || exportOptions?.fallbackGrid;
      adifContent += this.qsoRecordToADIF(qso, effectiveMyGrid);
    }

    return adifContent;
  }

  async exportCSV(options?: LogQueryOptions): Promise<string> {
    this.ensureInitialized();
    
    const qsos = await this.queryQSOs(options);
    
    // CSV 标题行
    const headers = [
      'Date',
      'Time',
      'Callsign',
      'Grid',
      'Frequency (MHz)',
      'Mode',
      'Report Sent',
      'Report Received',
      'My Callsign',
      'My Grid',
      'Comments'
    ];

    let csvContent = headers.join(',') + '\n';

    for (const qso of qsos) {
      const startDate = new Date(qso.startTime);
      const date = startDate.toISOString().slice(0, 10); // YYYY-MM-DD
      const time = startDate.toISOString().slice(11, 19); // HH:MM:SS

      const row = [
        date,
        time,
        this.escapeCsvField(qso.callsign),
        this.escapeCsvField(qso.grid || ''),
        (qso.frequency / 1000000).toFixed(6), // 转换为MHz
        this.escapeCsvField(qso.mode),
        this.escapeCsvField(qso.reportSent || ''),
        this.escapeCsvField(qso.reportReceived || ''),
        this.escapeCsvField(qso.myCallsign || ''),
        this.escapeCsvField(qso.myGrid || ''),
        this.escapeCsvField(qso.messages?.join(' | ') || '')
      ];
      
      csvContent += row.join(',') + '\n';
    }
    
    return csvContent;
  }

  /**
   * 转义CSV字段中的特殊字符
   */
  private escapeCsvField(field: string): string {
    if (!field) return '';
    
    // 如果包含逗号、双引号或换行符，需要用双引号包围并转义内部的双引号
    if (field.includes(',') || field.includes('"') || field.includes('\n') || field.includes('\r')) {
      return '"' + field.replace(/"/g, '""') + '"';
    }
    
    return field;
  }

  private buildImportId(record: QSORecord): string {
    const ownerKey = record.myCallsign?.trim()
      ? record.myCallsign.trim().toUpperCase()
      : 'import';
    return `${record.callsign}_${record.startTime}_${Date.now()}_${ownerKey}`;
  }

  private buildFingerprintIndex(): Map<string, string> {
    const index = new Map<string, string>();
    for (const [id, qso] of this.qsoCache.entries()) {
      index.set(buildImportedQsoFingerprint(qso), id);
    }
    return index;
  }

  private mergeImportedRecord(existing: QSORecord, incoming: QSORecord): { changed: boolean; record: QSORecord } {
    let changed = false;
    const merged: QSORecord = { ...existing };

    for (const field of IMPORT_MERGE_FIELDS) {
      const currentValue = merged[field];
      const incomingValue = incoming[field];
      if (isMissingValue(currentValue) && !isMissingValue(incomingValue)) {
        merged[field] = incomingValue as never;
        changed = true;
      }
    }

    if ((merged.messages?.length || 0) === 0 && (incoming.messages?.length || 0) > 0) {
      merged.messages = [...incoming.messages];
      changed = true;
    }

    const nextLotwSent = mergeStatusValue(merged.lotwQslSent, incoming.lotwQslSent, LOTW_SENT_PRIORITY);
    if (nextLotwSent !== merged.lotwQslSent) {
      merged.lotwQslSent = nextLotwSent;
      changed = true;
    }

    const nextLotwReceived = mergeStatusValue(merged.lotwQslReceived, incoming.lotwQslReceived, LOTW_RECEIVED_PRIORITY);
    if (nextLotwReceived !== merged.lotwQslReceived) {
      merged.lotwQslReceived = nextLotwReceived;
      changed = true;
    }

    const nextQrzSent = mergeStatusValue(merged.qrzQslSent, incoming.qrzQslSent, QRZ_PRIORITY);
    if (nextQrzSent !== merged.qrzQslSent) {
      merged.qrzQslSent = nextQrzSent;
      changed = true;
    }

    const nextQrzReceived = mergeStatusValue(merged.qrzQslReceived, incoming.qrzQslReceived, QRZ_PRIORITY);
    if (nextQrzReceived !== merged.qrzQslReceived) {
      merged.qrzQslReceived = nextQrzReceived;
      changed = true;
    }

    const nextLotwSentDate = mergeTimestampValue(merged.lotwQslSentDate, incoming.lotwQslSentDate);
    if (nextLotwSentDate !== merged.lotwQslSentDate) {
      merged.lotwQslSentDate = nextLotwSentDate;
      changed = true;
    }

    const nextLotwReceivedDate = mergeTimestampValue(merged.lotwQslReceivedDate, incoming.lotwQslReceivedDate);
    if (nextLotwReceivedDate !== merged.lotwQslReceivedDate) {
      merged.lotwQslReceivedDate = nextLotwReceivedDate;
      changed = true;
    }

    const nextQrzSentDate = mergeTimestampValue(merged.qrzQslSentDate, incoming.qrzQslSentDate);
    if (nextQrzSentDate !== merged.qrzQslSentDate) {
      merged.qrzQslSentDate = nextQrzSentDate;
      changed = true;
    }

    const nextQrzReceivedDate = mergeTimestampValue(merged.qrzQslReceivedDate, incoming.qrzQslReceivedDate);
    if (nextQrzReceivedDate !== merged.qrzQslReceivedDate) {
      merged.qrzQslReceivedDate = nextQrzReceivedDate;
      changed = true;
    }

    return changed
      ? { changed: true, record: enrichQSOWithDXCC(merged) }
      : { changed: false, record: existing };
  }

  private async importRecords(
    records: QSORecord[],
    detectedFormat: LogBookImportResult['detectedFormat'],
    totalRead: number,
    initialSkipped: number
  ): Promise<LogBookImportResult> {
    this.ensureInitialized();

    const result: LogBookImportResult = {
      detectedFormat,
      totalRead,
      imported: 0,
      merged: 0,
      skipped: initialSkipped,
    };
    const fingerprintIndex = this.buildFingerprintIndex();
    let didMutate = false;

    for (const record of records) {
      try {
        if (!record.callsign || !Number.isFinite(record.startTime) || !record.mode || !Number.isFinite(record.frequency)) {
          result.skipped += 1;
          continue;
        }

        const fingerprint = buildImportedQsoFingerprint(record);
        const existingId = fingerprintIndex.get(fingerprint);

        if (!existingId) {
          const insertedRecord = enrichQSOWithDXCC({
            ...record,
            id: this.buildImportId(record),
          });
          this.qsoCache.set(insertedRecord.id, insertedRecord);
          fingerprintIndex.set(fingerprint, insertedRecord.id);
          result.imported += 1;
          didMutate = true;
          continue;
        }

        const existingRecord = this.qsoCache.get(existingId);
        if (!existingRecord) {
          result.skipped += 1;
          continue;
        }

        const merged = this.mergeImportedRecord(existingRecord, record);
        if (merged.changed) {
          this.qsoCache.set(existingId, merged.record);
          result.merged += 1;
          didMutate = true;
        } else {
          result.skipped += 1;
        }
      } catch (error) {
        logger.warn('Failed to import QSO record', { error, detectedFormat });
        result.skipped += 1;
      }
    }

    if (didMutate) {
      this.rebuildIndexes();
      await this.saveCache();
    }

    return result;
  }

  async importADIF(adifContent: string): Promise<LogBookImportResult> {
    this.ensureInitialized();

    const adif = AdifParser.parseAdi(adifContent);
    const records: QSORecord[] = [];
    let skipped = 0;
    const totalRead = adif.records?.length || 0;

    if (adif.records) {
      for (const record of adif.records) {
        try {
          records.push(this.adifToQSORecord(record));
        } catch (error) {
          logger.warn('Failed to parse ADIF record during import', { error });
          skipped += 1;
        }
      }
    }

    return this.importRecords(records, 'adif', totalRead, skipped);
  }

  async importCSV(csvContent: string): Promise<LogBookImportResult> {
    this.ensureInitialized();
    const parsed = parseTx5drCsvContent(csvContent);
    return this.importRecords(parsed.records, 'csv', parsed.totalRead, parsed.skipped);
  }
  
  async close(): Promise<void> {
    // 保存任何未保存的更改
    if (this.isInitialized) {
      await this.saveCache();
    }
    
    this.qsoCache.clear();
    this.isInitialized = false;
  }
  
  /**
   * 确保Provider已初始化
   */
  private ensureInitialized(): void {
    if (!this.isInitialized) {
      throw new Error('ADIFLogProvider not initialized. Call initialize() first.');
    }
  }
  
  /**
   * 获取日志文件路径
   */
  getLogFilePath(): string {
    return this.logFilePath;
  }
} 
