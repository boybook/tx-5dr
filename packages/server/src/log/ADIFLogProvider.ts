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
  getCallsignInfo,
  resolveDXCCEntity,
  DXCC_RESOLVER_VERSION,
  normalizeQsoModeForStorage,
  toAdifMode,
} from '@tx5dr/core';
import { AdifParser } from 'adif-parser-ts';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { createHash } from 'node:crypto';
import { getDataFilePath } from '../utils/app-paths.js';
import { createLogger } from '../utils/logger.js';
import { JsonFileStore, PersistenceCoordinator, SafeFileWriter, fsyncDirectoryBestEffort, safeWriteFile } from '../utils/persistence/index.js';
import {
  buildImportedQsoFingerprint,
  parseTx5drCsvContent,
} from './logImportUtils.js';
import {
  buildCommentFromMessageHistory,
  normalizeMessageHistory,
  parseQsoTextFields,
  resolveQsoComment,
  sanitizeAdifFieldValue,
} from '@tx5dr/plugin-api';

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

type LogJournalOperation = 'add' | 'update' | 'delete' | 'import';

interface LogJournalEntry {
  txId: string;
  timestamp: number;
  operation: LogJournalOperation;
  payload: Record<string, unknown>;
  checksum: string;
}

interface LogbookMeta {
  lastCheckpointTxId?: string;
  checkpointedAt?: number;
}

interface SnapshotCacheBuildResult {
  qsoCache: Map<string, QSORecord>;
  foreignRecordLines: Map<string, string>;
  unparseableLines: string[];
  normalizedLegacyVoiceModes: boolean;
}

interface SnapshotLoadResult {
  content: string;
  recoveredFrom?: string;
}

interface ReplayJournalOptions {
  truncateCorruptTail?: boolean;
}

interface RawAdifLineEntry {
  line: string;
  index: number;
  matchKey: string | null;
}

interface ImportedRecordInput {
  record: QSORecord;
  rawLine?: string;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesModeFilter(qso: QSORecord, modeFilter: string): boolean {
  const normalizedQso = normalizeQsoModeForStorage(qso);
  const normalizedFilter = normalizeQsoModeForStorage({ mode: modeFilter });

  if (!normalizedFilter.mode) {
    return true;
  }

  if ((normalizedQso.mode || '').toUpperCase() !== normalizedFilter.mode) {
    return false;
  }

  return !normalizedFilter.submode
    || (normalizedQso.submode || '').toUpperCase() === normalizedFilter.submode;
}

function mapAdifModeToInternal(mode?: string, submode?: string): Pick<QSORecord, 'mode' | 'submode'> {
  const normalizedMode = mode?.trim().toUpperCase();
  const normalizedSubmode = submode?.trim().toUpperCase();

  if (normalizedMode === 'MFSK' && normalizedSubmode === 'FT4') {
    return { mode: 'FT4', submode: 'FT4' };
  }

  return normalizeQsoModeForStorage({
    mode: mode || 'FT8',
    submode: submode || undefined,
  });
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

function isQSOTwoWayConfirmed(qso: QSORecord): boolean {
  const lotwConfirmed = qso.lotwQslSent === 'Y'
    && (qso.lotwQslReceived === 'Y' || qso.lotwQslReceived === 'V');
  const qrzConfirmed = qso.qrzQslSent === 'Y'
    && qso.qrzQslReceived === 'Y';

  return lotwConfirmed || qrzConfirmed;
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
    dxccStatus: 'current',
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
  'comment',
  'notes',
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
 * 从 ADIF 原始内容中提取每条记录的原始行。
 * 保留原始字段及 <EOR> 标记的大小写、内部空白，仅去除行首的行分隔符。
 * 写盘时统一追加 \n 作为行分隔。
 * 大小写不敏感匹配 <EOH> 和 <EOR>（WSJT-X 使用小写，标准 ADIF 使用大写）。
 */
function extractRawAdifLines(content: string): string[] {
  const eohMatch = content.match(/<EOH>/i);
  if (!eohMatch) return [];
  const body = content.slice(content.indexOf(eohMatch[0]) + eohMatch[0].length);

  const eorRegex = /<EOR>/gi;
  const lines: string[] = [];
  let prevEnd = 0;
  let match: RegExpExecArray | null;
  while ((match = eorRegex.exec(body)) !== null) {
    const segEnd = match.index + match[0].length;
    const segment = body.slice(prevEnd, segEnd).replace(/^\s+/, '');
    if (segment.trim()) {
      lines.push(segment);
    }
    prevEnd = segEnd;
  }
  return lines;
}

function parseAdifFieldsFromLine(line: string): Record<string, string> {
  const fields: Record<string, string> = {};
  let cursor = 0;

  while (cursor < line.length) {
    const openIndex = line.indexOf('<', cursor);
    if (openIndex < 0) break;
    const closeIndex = line.indexOf('>', openIndex + 1);
    if (closeIndex < 0) break;

    const header = line.slice(openIndex + 1, closeIndex).trim();
    const [rawName, rawLength] = header.split(':');
    const name = rawName?.trim().toLowerCase();
    if (!name) {
      cursor = closeIndex + 1;
      continue;
    }
    if (name === 'eor' || name === 'eoh') {
      break;
    }

    const length = Number.parseInt(rawLength || '', 10);
    if (!Number.isFinite(length) || length < 0) {
      cursor = closeIndex + 1;
      continue;
    }

    const valueStart = closeIndex + 1;
    const valueEnd = Math.min(line.length, valueStart + length);
    fields[name] = line.slice(valueStart, valueEnd);
    cursor = valueEnd;
  }

  return fields;
}

function normalizeAdifDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const digits = value.trim().replace(/\D/g, '');
  return digits.length >= 8 ? digits.slice(0, 8) : null;
}

function normalizeAdifTime(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const digits = value.trim().replace(/\D/g, '');
  if (digits.length < 4) return null;
  return digits.slice(0, 6).padEnd(6, '0');
}

function normalizeAdifFrequencyHz(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const frequencyMHz = Number.parseFloat(value.trim());
  if (!Number.isFinite(frequencyMHz)) return null;
  return String(Math.round(frequencyMHz * 1_000_000));
}

/**
 * 用更强的 ADIF 业务键匹配原始 record 文本，避免同一天同呼号多条 QSO 覆盖。
 */
function buildAdifRecordMatchKey(fields: Record<string, unknown>): string | null {
  const callsign = typeof fields.call === 'string' ? fields.call.trim().toUpperCase() : '';
  const qsoDate = normalizeAdifDate(fields.qso_date);
  const timeOn = normalizeAdifTime(fields.time_on);
  const mode = typeof fields.mode === 'string' ? fields.mode.trim().toUpperCase() : '';
  const submode = typeof fields.submode === 'string' ? fields.submode.trim().toUpperCase() : '';
  const frequency = normalizeAdifFrequencyHz(fields.freq);

  if (!callsign || !qsoDate || !timeOn || !mode || !frequency) {
    return null;
  }

  return [callsign, qsoDate, timeOn, mode, submode, frequency].join('|');
}

function parseAdifStartTimeFromFields(fields: Record<string, unknown>): number | undefined {
  const qsoDate = normalizeAdifDate(fields.qso_date);
  const timeOn = normalizeAdifTime(fields.time_on);
  if (!qsoDate || !timeOn) return undefined;

  const year = Number.parseInt(qsoDate.slice(0, 4), 10);
  const month = Number.parseInt(qsoDate.slice(4, 6), 10) - 1;
  const day = Number.parseInt(qsoDate.slice(6, 8), 10);
  const hour = Number.parseInt(timeOn.slice(0, 2), 10);
  const minute = Number.parseInt(timeOn.slice(2, 4), 10);
  const second = Number.parseInt(timeOn.slice(4, 6), 10);
  const timestamp = Date.UTC(year, month, day, hour, minute, second);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function buildRawAdifLineEntries(content: string): RawAdifLineEntry[] {
  return extractRawAdifLines(content).map((line, index) => {
    const fields = parseAdifFieldsFromLine(line);
    return {
      line,
      index,
      matchKey: buildAdifRecordMatchKey(fields),
    };
  });
}

function createRawAdifLineQueues(entries: RawAdifLineEntry[]): Map<string, RawAdifLineEntry[]> {
  const queues = new Map<string, RawAdifLineEntry[]>();
  for (const entry of entries) {
    if (!entry.matchKey) continue;
    const queue = queues.get(entry.matchKey) || [];
    queue.push(entry);
    queues.set(entry.matchKey, queue);
  }
  return queues;
}

function takeRawAdifLineForRecord(
  fields: Record<string, unknown>,
  queues: Map<string, RawAdifLineEntry[]>,
  consumedIndexes: Set<number>,
  fallbackEntry?: RawAdifLineEntry,
): RawAdifLineEntry | undefined {
  const matchKey = buildAdifRecordMatchKey(fields);
  const queue = matchKey ? queues.get(matchKey) : undefined;
  while (queue && queue.length > 0) {
    const entry = queue.shift()!;
    if (!consumedIndexes.has(entry.index)) {
      consumedIndexes.add(entry.index);
      return entry;
    }
  }

  if (fallbackEntry && !consumedIndexes.has(fallbackEntry.index)) {
    consumedIndexes.add(fallbackEntry.index);
    return fallbackEntry;
  }

  return undefined;
}

function logbookSidecarBase(filePath: string): string {
  return filePath.replace(/\.adi$/i, '');
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
  private needsFullRewrite: boolean = false;
  private foreignRecordLines: Map<string, string> = new Map();
  private unparseableLines: string[] = [];
  private journalPath: string = '';
  private metaPath: string = '';
  private writerTail: Promise<unknown> = Promise.resolve();
  private safeWriter = new SafeFileWriter({ backups: 3 });
  private metaStore: JsonFileStore<LogbookMeta> | null = null;
  private lastJournalTxId: string | undefined;
  private unregisterPersistence: (() => void) | null = null;

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
    const startedAt = Date.now();
    logger.info('Initializing ADIF log provider');

    const timed = async <T>(phase: string, operation: () => Promise<T>): Promise<T> => {
      const phaseStartedAt = Date.now();
      try {
        const result = await operation();
        logger.info(`ADIF log provider phase complete: ${phase}`, { durationMs: Date.now() - phaseStartedAt });
        return result;
      } catch (error) {
        logger.error(`ADIF log provider phase failed: ${phase}`, {
          durationMs: Date.now() - phaseStartedAt,
          error: (error as Error).message,
        });
        throw error;
      }
    };
    
    // 确定日志文件路径
    await timed('resolve-path', async () => {
      if (this.options.logFilePath) {
        this.logFilePath = this.options.logFilePath;
      } else {
        this.logFilePath = await this.findOrCreateLogPath();
      }
      logger.info('ADIF log provider path resolved', { logFilePath: this.logFilePath });
    });
    const sidecarBase = logbookSidecarBase(this.logFilePath);
    this.journalPath = `${sidecarBase}.journal.jsonl`;
    this.metaPath = `${sidecarBase}.meta.json`;
    this.metaStore = new JsonFileStore<LogbookMeta>(this.metaPath, {
      defaultValue: () => ({}),
      validate: (value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('logbook meta root must be an object');
        }
        return value as LogbookMeta;
      },
      backups: 2,
      createIfMissing: false,
    });
    await timed('meta-load', async () => {
      await this.metaStore!.load();
    });
    
    // 如果文件不存在且autoCreateFile为true，创建空文件
    await timed('empty-file-create', async () => {
      try {
        await fs.access(this.logFilePath);
      } catch {
        if (this.options.autoCreateFile) {
          await this.createEmptyLogFile();
        }
      }
    });
    
    // 加载现有日志到缓存
    const snapshotLoad = await timed('snapshot-load', async () => this.loadCache());
    if (snapshotLoad.recoveredFrom) {
      await timed('archived-journal-replay', async () => this.replayArchivedJournals());
    }
    await timed('journal-replay', async () => this.replayJournal());
    if (snapshotLoad.recoveredFrom) {
      this.needsFullRewrite = true;
      await timed('snapshot-rewrite', async () => this.saveCache());
    }
    // 构建/重建索引
    await timed('index-rebuild', async () => {
      this.rebuildIndexes();
    });

    this.needsFullRewrite = false;
    this.isInitialized = true;
    this.unregisterPersistence = PersistenceCoordinator.getInstance().register({
      name: `logbook:${this.logFilePath}`,
      flush: async () => this.flush(),
    });
    logger.info('ADIF log provider initialized', {
      logFilePath: this.logFilePath,
      qsoCount: this.qsoCache.size,
      durationMs: Date.now() - startedAt,
    });
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
    await this.atomicWriteFile(this.logFilePath, header, { fsync: false });
  }
  
  /**
   * 加载日志到缓存。主 ADIF 损坏时尝试从安全写备份恢复；无法恢复则 fail closed。
   */
  private async loadCache(): Promise<SnapshotLoadResult> {
    const loaded = await this.loadSnapshotWithRecovery();
    if (loaded.content !== null) {
      this.applySnapshotCache(this.buildCacheFromSnapshotContent(loaded.content));
      if (this.needsFullRewrite) {
        await this.saveCache();
      }
      return { content: loaded.content, recoveredFrom: loaded.recoveredFrom };
    }

    if (await this.hasJournalRecoveryCandidates()) {
      logger.warn('ADIF snapshot unavailable; recovering logbook from journal files only', { logFilePath: this.logFilePath });
      this.qsoCache.clear();
      this.foreignRecordLines.clear();
      this.unparseableLines = [];
      return { content: '', recoveredFrom: 'journal-only' };
    }

    throw new Error(`Unable to recover ADIF log snapshot: ${this.logFilePath}`);
  }

  private async loadSnapshotWithRecovery(): Promise<{ content: string | null; recoveredFrom?: string }> {
    const failures: string[] = [];
    const tryCandidate = async (candidatePath: string): Promise<string | null> => {
      try {
        const content = await fs.readFile(candidatePath, 'utf-8');
        this.buildCacheFromSnapshotContent(content);
        return content;
      } catch (error) {
        failures.push(`${candidatePath}: ${(error as Error).message}`);
        return null;
      }
    };

    const mainContent = await tryCandidate(this.logFilePath);
    if (mainContent !== null) {
      return { content: mainContent };
    }

    const candidates = await this.listSnapshotRecoveryCandidates();
    for (const candidatePath of candidates) {
      const content = await tryCandidate(candidatePath);
      if (content === null) continue;

      const corruptPath = `${this.logFilePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      await fs.rename(this.logFilePath, corruptPath).catch((error) => {
        logger.warn('failed to move corrupt ADIF snapshot aside', { filePath: this.logFilePath, corruptPath, error: (error as Error).message });
      });
      await this.atomicWriteFile(this.logFilePath, content);
      logger.warn('ADIF snapshot recovered from backup', { logFilePath: this.logFilePath, recoveredFrom: candidatePath });
      return { content, recoveredFrom: candidatePath };
    }

    logger.error('ADIF snapshot recovery failed', { logFilePath: this.logFilePath, failures });
    return { content: null };
  }

  private async listSnapshotRecoveryCandidates(): Promise<string[]> {
    const dir = path.dirname(this.logFilePath);
    const base = path.basename(this.logFilePath);
    const candidates = [
      ...(await fs.readdir(dir, { withFileTypes: true }).then(entries => entries
        .filter(entry => entry.isFile() && entry.name.startsWith(`${base}.tmp-`))
        .map(entry => path.join(dir, entry.name))).catch(() => [])),
      ...[1, 2, 3].map(index => `${this.logFilePath}.bak.${index}`),
    ];
    const withStats = await Promise.all(candidates.map(async (candidatePath, order) => {
      const stat = await fs.stat(candidatePath).catch(() => null);
      return stat ? { path: candidatePath, mtimeMs: stat.mtimeMs, order } : null;
    }));
    return withStats
      .filter((entry): entry is { path: string; mtimeMs: number; order: number } => Boolean(entry))
      .sort((a, b) => b.mtimeMs - a.mtimeMs || a.order - b.order)
      .map(entry => entry.path);
  }

  private buildCacheFromSnapshotContent(content: string): SnapshotCacheBuildResult {
    if (!/<EOH>/i.test(content)) {
      throw new Error('ADIF header <EOH> missing');
    }

    logger.debug(`File content length: ${content.length}`);
    const adif = AdifParser.parseAdi(content);
    logger.debug(`Parsed ${adif.records?.length || 0} records`);

    const rawEntries = buildRawAdifLineEntries(content);
    const rawLineQueues = createRawAdifLineQueues(rawEntries);
    const consumedRawLineIndexes = new Set<number>();

    const qsoCache = new Map<string, QSORecord>();
    const foreignRecordLines = new Map<string, string>();
    const unparseableLines: string[] = [];
    let normalizedLegacyVoiceModes = false;

    if (adif.records) {
      const parsedQsos: QSORecord[] = [];
      for (let recordIndex = 0; recordIndex < adif.records.length; recordIndex += 1) {
        const record = adif.records[recordIndex];
        try {
          const qso = this.adifToQSORecord(record);
          parsedQsos.push(qso);
          const isLegacyVoiceMode = ['USB', 'LSB'].includes((record.mode || '').trim().toUpperCase());
          if (isLegacyVoiceMode) {
            normalizedLegacyVoiceModes = true;
          }
          const rawEntry = takeRawAdifLineForRecord(
            record as Record<string, unknown>,
            rawLineQueues,
            consumedRawLineIndexes,
            rawEntries[recordIndex],
          );
          const hasTx5drEnrichment =
            record.app_tx5dr_id !== undefined ||
            record.app_tx5dr_dxcc_status !== undefined ||
            record.app_tx5dr_dxcc_source !== undefined ||
            record.app_tx5dr_dxcc_confidence !== undefined ||
            record.app_tx5dr_dxcc_needs_review !== undefined ||
            record.app_tx5dr_station_location_id !== undefined;
          if (!hasTx5drEnrichment && !isLegacyVoiceMode) {
            if (rawEntry?.line) {
              foreignRecordLines.set(qso.id, rawEntry.line);
            }
          }
          logger.debug(`Parsed QSO: ${qso.id} - ${qso.callsign}`);
        } catch (err) {
          logger.error('Failed to load record', { err, record });
        }
      }
      parsedQsos.sort((a, b) => a.startTime - b.startTime);
      for (const qso of parsedQsos) {
        qsoCache.set(qso.id, qso);
      }
    }

    for (const rawEntry of rawEntries) {
      if (!consumedRawLineIndexes.has(rawEntry.index)) {
        unparseableLines.push(rawEntry.line);
      }
    }

    return { qsoCache, foreignRecordLines, unparseableLines, normalizedLegacyVoiceModes };
  }

  private applySnapshotCache(result: SnapshotCacheBuildResult): void {
    this.qsoCache = result.qsoCache;
    this.foreignRecordLines = result.foreignRecordLines;
    this.unparseableLines = result.unparseableLines;
    this.needsFullRewrite = result.normalizedLegacyVoiceModes;
    logger.debug(`Cache loaded: ${this.qsoCache.size} records, ${this.foreignRecordLines.size} foreign, ${this.unparseableLines.length} unparseable`);
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
    
    // 生成ID（优先保留 TX-5DR 内部 ID；旧 ADIF 则回退到呼号+日期+时间+操作员）
    let id = typeof fields.app_tx5dr_id === 'string' && fields.app_tx5dr_id.trim()
      ? fields.app_tx5dr_id.trim()
      : `${callsign}_${qsoDate}_${timeOn}`;
    if (!fields.app_tx5dr_id && fields.operator) {
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
    
    const { comment, messageHistory } = parseQsoTextFields(
      fields.comment,
      fields.app_tx5dr_message_history,
    );

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
      messageHistory,
      comment,
      qth: fields.qth ?? undefined,
      notes: fields.notes ?? fields.note ?? undefined,
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
    const adifMode = toAdifMode(qso);
    
    let adifRecord = '';
    
    // 必需字段
    adifRecord += `<CALL:${qso.callsign.length}>${qso.callsign}`;
    if (qso.id) {
      adifRecord += `<APP_TX5DR_ID:${qso.id.length}>${qso.id}`;
    }
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
    
    const messageHistory = sanitizeAdifFieldValue(buildCommentFromMessageHistory(qso.messageHistory) ?? '') || undefined;
    if (messageHistory) {
      adifRecord += `<APP_TX5DR_MESSAGE_HISTORY:${messageHistory.length}>${messageHistory}`;
    }

    const comment = sanitizeAdifFieldValue(resolveQsoComment(qso) ?? '') || undefined;
    if (comment) {
      adifRecord += `<COMMENT:${comment.length}>${comment}`;
    }

    if (qso.qth) {
      const qth = sanitizeAdifFieldValue(qso.qth);
      if (qth) {
        adifRecord += `<QTH:${qth.length}>${qth}`;
      }
    }

    if (qso.notes) {
      const notes = sanitizeAdifFieldValue(qso.notes);
      if (notes) {
        adifRecord += `<NOTES:${notes.length}>${notes}`;
      }
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
   * 原子写入文件：先写临时文件再 rename，防止进程崩溃时文件截断
   */
  private async atomicWriteFile(filePath: string, content: string, options: { fsync?: boolean } = {}): Promise<void> {
    await this.safeWriter.writeFile(filePath, content, { backups: 3, fsync: options.fsync });
  }

  private buildJournalEntry(operation: LogJournalOperation, payload: Record<string, unknown>): LogJournalEntry {
    const entryWithoutChecksum = {
      txId: `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
      timestamp: Date.now(),
      operation,
      payload,
    };
    return {
      ...entryWithoutChecksum,
      checksum: this.hashJournalPayload(entryWithoutChecksum),
    };
  }

  private hashJournalPayload(value: Omit<LogJournalEntry, 'checksum'>): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }

  private verifyJournalEntry(entry: LogJournalEntry): boolean {
    if (!entry || typeof entry !== 'object') return false;
    const { checksum, ...rest } = entry;
    return typeof checksum === 'string'
      && checksum === this.hashJournalPayload(rest as Omit<LogJournalEntry, 'checksum'>);
  }

  private async enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.writerTail.catch(() => undefined).then(operation);
    this.writerTail = run.catch(() => undefined);
    return run;
  }

  private async appendJournal(operation: LogJournalOperation, payload: Record<string, unknown>): Promise<LogJournalEntry> {
    const entry = this.buildJournalEntry(operation, payload);
    const line = `${JSON.stringify(entry)}\n`;
    const journalExisted = await fs.access(this.journalPath).then(() => true).catch(() => false);
    await fs.mkdir(path.dirname(this.journalPath), { recursive: true });
    const handle = await fs.open(this.journalPath, 'a');
    try {
      await handle.writeFile(line, 'utf-8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (!journalExisted) {
      await fsyncDirectoryBestEffort(path.dirname(this.journalPath));
    }
    this.lastJournalTxId = entry.txId;
    return entry;
  }

  private async replayJournal(): Promise<void> {
    await this.replayJournalFile(this.journalPath, { truncateCorruptTail: true });
  }

  private async replayArchivedJournals(): Promise<void> {
    const archivedPaths = await this.listArchivedJournalPaths();
    for (const archivedPath of archivedPaths) {
      await this.replayJournalFile(archivedPath, { truncateCorruptTail: true });
    }
  }

  private async hasJournalRecoveryCandidates(): Promise<boolean> {
    const candidates = [
      ...(await this.listArchivedJournalPaths()),
      this.journalPath,
    ];
    for (const candidatePath of candidates) {
      if (await this.journalFileHasValidTransaction(candidatePath)) {
        return true;
      }
    }
    return false;
  }

  private async listArchivedJournalPaths(): Promise<string[]> {
    const dir = path.dirname(this.journalPath);
    const base = path.basename(this.journalPath);
    const archivePrefix = `${base}.`;
    const archiveNamePattern = new RegExp(`^${escapeRegExp(archivePrefix)}\\d{4}-\\d{2}-\\d{2}T`);
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const candidates = await Promise.all(entries
      .filter(entry => entry.isFile() && archiveNamePattern.test(entry.name))
      .map(async (entry) => {
        const filePath = path.join(dir, entry.name);
        const stat = await fs.stat(filePath).catch(() => null);
        return stat ? { filePath, name: entry.name, mtimeMs: stat.mtimeMs } : null;
      }));
    return candidates
      .filter((entry): entry is { filePath: string; name: string; mtimeMs: number } => Boolean(entry))
      .sort((a, b) => a.name.localeCompare(b.name) || a.mtimeMs - b.mtimeMs)
      .map(entry => entry.filePath);
  }

  private async journalFileHasValidTransaction(journalPath: string): Promise<boolean> {
    let content: string;
    try {
      content = await fs.readFile(journalPath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }

    if (!content.trim()) return false;

    const replayContent = content.endsWith('\n')
      ? content
      : content.slice(0, Math.max(0, content.lastIndexOf('\n') + 1));
    const lines = replayContent.split('\n');
    for (let index = 0; index < lines.length - 1; index += 1) {
      const line = lines[index];
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as LogJournalEntry;
        if (this.verifyJournalEntry(entry)) {
          return true;
        }
      } catch {
        return false;
      }
    }
    return false;
  }

  private async replayJournalFile(journalPath: string, options: ReplayJournalOptions = {}): Promise<void> {
    let content: string;
    try {
      content = await fs.readFile(journalPath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }

    if (!content.trim()) return;

    const hasPartialTail = !content.endsWith('\n');
    const replayContent = hasPartialTail
      ? content.slice(0, Math.max(0, content.lastIndexOf('\n') + 1))
      : content;
    const lines = replayContent.split('\n');
    let validBytes = 0;
    let didTruncate = hasPartialTail;
    for (let index = 0; index < lines.length - 1; index += 1) {
      const line = lines[index];
      if (!line.trim()) {
        validBytes += Buffer.byteLength(`${line}\n`, 'utf8');
        continue;
      }

      try {
        const entry = JSON.parse(line) as LogJournalEntry;
        if (!this.verifyJournalEntry(entry)) {
          throw new Error('journal checksum mismatch');
        }
        this.applyJournalEntry(entry);
        this.lastJournalTxId = entry.txId;
        validBytes += Buffer.byteLength(`${line}\n`, 'utf8');
      } catch (error) {
        logger.error('Corrupt logbook journal entry detected; truncating journal to last valid transaction', {
          journalPath,
          line: index + 1,
          error: (error as Error).message,
        });
        didTruncate = true;
        break;
      }
    }

    if (didTruncate && options.truncateCorruptTail !== false) {
      const corruptPath = `${journalPath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      await safeWriteFile(corruptPath, content, { backups: 0 }).catch(() => undefined);
      await fs.truncate(journalPath, validBytes);
      await fsyncDirectoryBestEffort(path.dirname(journalPath));
    }
  }

  private removeSnapshotDuplicateForJournalRecord(record: QSORecord): void {
    const fingerprint = buildImportedQsoFingerprint(record);
    for (const [existingId, existingRecord] of this.qsoCache.entries()) {
      if (existingId === record.id) {
        continue;
      }
      if (buildImportedQsoFingerprint(existingRecord) === fingerprint) {
        this.qsoCache.delete(existingId);
        this.foreignRecordLines.delete(existingId);
      }
    }
  }

  private applyJournalEntry(entry: LogJournalEntry): void {
    switch (entry.operation) {
      case 'add':
      case 'update': {
        const record = entry.payload.record as QSORecord | undefined;
        if (record?.id) {
          this.removeSnapshotDuplicateForJournalRecord(record);
          this.qsoCache.set(record.id, record);
          this.foreignRecordLines.delete(record.id);
        }
        break;
      }
      case 'delete': {
        const id = entry.payload.id;
        if (typeof id === 'string') {
          this.qsoCache.delete(id);
          this.foreignRecordLines.delete(id);
        }
        break;
      }
      case 'import': {
        const operations = Array.isArray(entry.payload.operations) ? entry.payload.operations : [];
        for (const op of operations as Array<{ type: string; record?: QSORecord; id?: string; rawLine?: string }>) {
          if ((op.type === 'add' || op.type === 'update') && op.record?.id) {
            this.removeSnapshotDuplicateForJournalRecord(op.record);
            this.qsoCache.set(op.record.id, op.record);
            if (op.rawLine) {
              this.foreignRecordLines.set(op.record.id, op.rawLine);
            } else {
              this.foreignRecordLines.delete(op.record.id);
            }
          } else if (op.type === 'delete' && op.id) {
            this.qsoCache.delete(op.id);
            this.foreignRecordLines.delete(op.id);
          } else if (op.type === 'raw' && op.rawLine && !this.unparseableLines.includes(op.rawLine)) {
            this.unparseableLines.push(op.rawLine);
          }
        }
        break;
      }
    }
  }

  private async checkpointJournal(): Promise<void> {
    let stat: Awaited<ReturnType<typeof fs.stat>> | null = null;
    try {
      stat = await fs.stat(this.journalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!stat || stat.size === 0) return;

    this.needsFullRewrite = true;
    await this.saveCache();
    await this.metaStore?.set({
      lastCheckpointTxId: this.lastJournalTxId,
      checkpointedAt: Date.now(),
    });
    await this.metaStore?.flush();

    const archivedPath = `${this.journalPath}.${new Date().toISOString().replace(/[:.]/g, '-')}`;
    let rotated = false;
    await fs.rename(this.journalPath, archivedPath).then(() => {
      rotated = true;
    }).catch(async (error) => {
      logger.warn('failed to rotate checkpointed journal; truncating instead', { error: (error as Error).message });
      await fs.truncate(this.journalPath, 0);
    });
    if (rotated) {
      await fsyncDirectoryBestEffort(path.dirname(this.journalPath));
    }
    await safeWriteFile(this.journalPath, '', { backups: 0 }).catch(() => undefined);
  }

  private buildAdifOutputBody(
    qsos: Iterable<QSORecord>,
    options: { includeUnparseableLines?: boolean; fallbackGrid?: string } = {},
  ): string {
    const entries: Array<{
      content: string;
      sortTime: number;
      stableKey: string;
      sourceOrder: number;
    }> = [];
    let sourceOrder = 0;

    for (const qso of qsos) {
      const cached = this.foreignRecordLines.get(qso.id);
      const effectiveMyGrid = qso.myGrid || options.fallbackGrid;
      entries.push({
        content: cached
          ? (cached.endsWith('\n') ? cached : `${cached}\n`)
          : this.qsoRecordToADIF(qso, effectiveMyGrid),
        sortTime: Number.isFinite(qso.startTime) ? qso.startTime : Number.NEGATIVE_INFINITY,
        stableKey: [
          qso.id || '',
          qso.callsign || '',
          String(qso.frequency || 0),
        ].join('|'),
        sourceOrder,
      });
      sourceOrder += 1;
    }

    if (options.includeUnparseableLines) {
      for (const line of this.unparseableLines) {
        const fields = parseAdifFieldsFromLine(line);
        entries.push({
          content: line.endsWith('\n') ? line : `${line}\n`,
          sortTime: parseAdifStartTimeFromFields(fields) ?? Number.NEGATIVE_INFINITY,
          stableKey: `raw|${buildAdifRecordMatchKey(fields) || line}`,
          sourceOrder,
        });
        sourceOrder += 1;
      }
    }

    entries.sort((left, right) => {
      if (left.sortTime !== right.sortTime) return left.sortTime - right.sortTime;
      const stableComparison = left.stableKey.localeCompare(right.stableKey);
      if (stableComparison !== 0) return stableComparison;
      return left.sourceOrder - right.sourceOrder;
    });

    return entries.map(entry => entry.content).join('');
  }

  private async writeFullAdifSnapshot(): Promise<void> {
    const header = `TX-5DR Log File
<ADIF_VER:5>3.1.4
<PROGRAMID:6>TX-5DR
<PROGRAMVERSION:5>1.0.0
<EOH>

`;
    await this.atomicWriteFile(
      this.logFilePath,
      header + this.buildAdifOutputBody(this.qsoCache.values(), { includeUnparseableLines: true }),
    );
  }

  /**
   * 立即刷盘，等待完成
   */
  async flush(): Promise<void> {
    await this.enqueueWrite(async () => {
      await this.checkpointJournal();
    });
  }

  /**
   * 保存缓存到文件。
   * checkpoint/recovery 需要重建快照时，始终按 ADIF 正序原子写入。
   */
  private async saveCache(): Promise<void> {
    if (this.needsFullRewrite) {
      await this.writeFullAdifSnapshot();
      this.needsFullRewrite = false;
    }
  }
  
  async addQSO(record: QSORecord, operatorId?: string): Promise<void> {
    this.ensureInitialized();
    PersistenceCoordinator.getInstance().assertMutationsAllowed('logbook:add');
    await this.enqueueWrite(async () => {
      const messageHistory = normalizeMessageHistory(record.messageHistory);
      const normalizedTextRecord = {
        ...record,
        messageHistory,
      };
      const persisted = enrichQSOWithDXCC(normalizeQsoModeForStorage({
        ...normalizedTextRecord,
        comment: resolveQsoComment(normalizedTextRecord),
      }));

      // 生成唯一ID
      if (!persisted.id || this.qsoCache.has(persisted.id)) {
        persisted.id = `${persisted.callsign}_${persisted.startTime}_${Date.now()}_${operatorId || 'unknown'}`;
      }

      await this.appendJournal('add', { record: persisted });

      record.id = persisted.id;
      this.qsoCache.set(persisted.id, persisted);
      // 增量更新 ALL 索引
      const allIdx = this.operatorIndexMap.get(ADIFLogProvider.ALL_KEY);
      if (allIdx) addQSOToIndex(allIdx, persisted);
      this.foreignRecordLines.delete(persisted.id);
    });
  }

  async updateQSO(id: string, updates: Partial<QSORecord>): Promise<void> {
    this.ensureInitialized();
    PersistenceCoordinator.getInstance().assertMutationsAllowed('logbook:update');
    await this.enqueueWrite(async () => {
      const existing = this.qsoCache.get(id);
      if (!existing) {
        throw new Error(`QSO with id ${id} not found`);
      }

      const nextSubmode = updates.mode !== undefined && updates.submode === undefined
        ? undefined
        : updates.submode ?? existing.submode;
      const messageHistory = normalizeMessageHistory(updates.messageHistory ?? existing.messageHistory);
      const normalizedTextRecord = {
        ...existing,
        ...updates,
        id,
        submode: nextSubmode,
        messageHistory,
      };
      const updated = normalizeQsoModeForStorage({
        ...normalizedTextRecord,
        comment: resolveQsoComment(normalizedTextRecord),
      });
      const persisted = enrichQSOWithDXCC(updated);
      await this.appendJournal('update', {
        id,
        updates,
        record: persisted,
        afterHash: createHash('sha256').update(JSON.stringify(persisted)).digest('hex'),
      });
      this.qsoCache.set(id, persisted);
      this.foreignRecordLines.delete(id);
      // 简化处理：更新后重建索引（更新频率低，成本可接受）
      this.rebuildIndexes();
    });
  }

  async deleteQSO(id: string): Promise<void> {
    this.ensureInitialized();
    PersistenceCoordinator.getInstance().assertMutationsAllowed('logbook:delete');
    await this.enqueueWrite(async () => {
      if (!this.qsoCache.has(id)) {
        throw new Error(`QSO with id ${id} not found`);
      }

      await this.appendJournal('delete', { id, tombstone: true });
      this.qsoCache.delete(id);
      this.foreignRecordLines.delete(id);
      // 删除后重建索引
      this.rebuildIndexes();
    });
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
        results = results.filter(qso => matchesModeFilter(qso, options.mode!));
      }

      // 波段过滤（按频率派生波段后比较）
      if (options.band) {
        const targetBand = options.band.toUpperCase();
        results = results.filter(qso => getBandFromFrequency(qso.frequency).toUpperCase() === targetBand);
      }

      if (options.dxccStatus) {
        results = results.filter(qso => qso.dxccStatus === options.dxccStatus);
      }

      if (options.qslFlow) {
        results = results.filter((qso) => {
          const twoWayConfirmed = isQSOTwoWayConfirmed(qso);
          return options.qslFlow === 'two_way_confirmed'
            ? twoWayConfirmed
            : !twoWayConfirmed;
        });
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

  async countQSOs(options?: LogQueryOptions): Promise<number> {
    this.ensureInitialized();
    let count = 0;
    for (const qso of this.qsoCache.values()) {
      if (options?.callsign && !qso.callsign.toUpperCase().includes(options.callsign.toUpperCase())) continue;
      if (options?.grid) {
        const sg = normalizeGridSearch(options.grid);
        if (sg && !normalizeGridSearch(qso.grid)?.startsWith(sg)) continue;
      }
      if (options?.frequencyRange && (qso.frequency < options.frequencyRange.min || qso.frequency > options.frequencyRange.max)) continue;
      if (options?.timeRange && (qso.startTime < options.timeRange.start || qso.startTime > options.timeRange.end)) continue;
      if (options?.mode && !matchesModeFilter(qso, options.mode)) continue;
      if (options?.dxccStatus && qso.dxccStatus !== options.dxccStatus) continue;
      if (options?.qslFlow) {
        const twoWay = isQSOTwoWayConfirmed(qso);
        if (options.qslFlow === 'two_way_confirmed' ? !twoWay : twoWay) continue;
      }
      if (options?.excludeModes?.length) {
        const excluded = new Set(options.excludeModes.map(m => m.toUpperCase()));
        if (excluded.has((qso.mode || '').toUpperCase())) continue;
      }
      if (options?.qslStatus) {
        const isConfirmed = (qso.lotwQslReceived === 'Y' || qso.lotwQslReceived === 'V') || qso.qrzQslReceived === 'Y';
        const isUploaded = qso.lotwQslSent === 'Y' || qso.qrzQslSent === 'Y';
        let matches = true;
        switch (options.qslStatus) {
          case 'confirmed': matches = isConfirmed; break;
          case 'uploaded': matches = isUploaded && !isConfirmed; break;
          case 'none': matches = !isUploaded && !isConfirmed; break;
        }
        if (!matches) continue;
      }
      count++;
    }
    return count;
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
    const callsignInfo = getCallsignInfo(upper);
    const dxccEntity = resolution.entity;
    const cqZone = dxccEntity?.cqZone ?? getCQZone(upper);
    const ituZone = dxccEntity?.ituZone ?? getITUZone(upper);
    const dxccId = dxccEntity?.entityCode;
    const dxccStatus = dxccEntity ? 'current' : 'unknown';

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
      state: callsignInfo?.state,
      stateConfidence: callsignInfo?.stateConfidence,
      dxccNeedsReview: resolution.needsReview,
      dxccMatchKind: resolution.matchKind,
      dxccDataSource: resolution.dataSource,
      dxccResolverVersion: DXCC_RESOLVER_VERSION,
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

  private shouldIncludeUnparseableLinesInAdifExport(options?: LogQueryOptions): boolean {
    if (!options) return true;
    return !options.callsign
      && !options.grid
      && !options.frequencyRange
      && !options.timeRange
      && !options.mode
      && !options.band
      && !options.dxccStatus
      && !options.qslFlow
      && (!options.excludeModes || options.excludeModes.length === 0)
      && !options.qslStatus
      && options.limit === undefined
      && options.offset === undefined;
  }
  
  async exportADIF(options?: LogQueryOptions, exportOptions?: { fallbackGrid?: string }): Promise<string> {
    this.ensureInitialized();

    const qsos = await this.queryQSOs({
      ...(options || {}),
      orderBy: 'time',
      orderDirection: 'asc',
    });

    let adifContent = `TX-5DR Export
<ADIF_VER:5>3.1.4
<PROGRAMID:6>TX-5DR
<PROGRAMVERSION:5>1.0.0
<EOH>

`;

    adifContent += this.buildAdifOutputBody(qsos, {
      includeUnparseableLines: this.shouldIncludeUnparseableLinesInAdifExport(options),
      fallbackGrid: exportOptions?.fallbackGrid,
    });

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
        this.escapeCsvField(resolveQsoComment(qso) || '')
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

    if ((merged.messageHistory?.length || 0) === 0 && (incoming.messageHistory?.length || 0) > 0) {
      merged.messageHistory = [...incoming.messageHistory];
      changed = true;
    }

    const nextComment = resolveQsoComment(merged);
    const incomingComment = resolveQsoComment(incoming);
    if (isMissingValue(nextComment) && !isMissingValue(incomingComment)) {
      merged.comment = incomingComment;
      changed = true;
    } else if (isMissingValue(merged.comment) && !isMissingValue(nextComment)) {
      merged.comment = nextComment;
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
    records: ImportedRecordInput[],
    detectedFormat: LogBookImportResult['detectedFormat'],
    totalRead: number,
    initialSkipped: number,
    unparseableRawLines: string[] = [],
  ): Promise<LogBookImportResult> {
    this.ensureInitialized();
    PersistenceCoordinator.getInstance().assertMutationsAllowed(`logbook:import:${detectedFormat}`);

    return this.enqueueWrite(async () => {
    const result: LogBookImportResult = {
      detectedFormat,
      totalRead,
      imported: 0,
      merged: 0,
      skipped: initialSkipped,
    };
    const fingerprintIndex = this.buildFingerprintIndex();
    let didMutate = false;
    const journalOperations: Array<{ type: 'add' | 'update' | 'raw'; record?: QSORecord; rawLine?: string }> = [];
    const beforeCache = new Map(this.qsoCache);
    const beforeForeign = new Map(this.foreignRecordLines);
    const beforeUnparseable = [...this.unparseableLines];

    for (const input of records) {
      try {
        const record = normalizeQsoModeForStorage(input.record);
        if (!record.callsign || !Number.isFinite(record.startTime) || !record.mode || !Number.isFinite(record.frequency)) {
          result.skipped += 1;
          continue;
        }

        const fingerprint = buildImportedQsoFingerprint(record);
        const existingId = fingerprintIndex.get(fingerprint);

        if (!existingId) {
          const id = this.buildImportId(record);
          const insertedRecord = enrichQSOWithDXCC({
            ...record,
            id,
          });
          this.qsoCache.set(insertedRecord.id, insertedRecord);
          // 仅 ADIF 导入且能匹配原始行时，导出才保持外部原文。
          if (input.rawLine) {
            this.foreignRecordLines.set(insertedRecord.id, input.rawLine);
          }
          journalOperations.push({ type: 'add', record: insertedRecord, rawLine: input.rawLine });
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
          this.foreignRecordLines.delete(existingId);
          journalOperations.push({ type: 'update', record: merged.record });
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

    for (const rawLine of unparseableRawLines) {
      if (this.unparseableLines.includes(rawLine)) {
        continue;
      }
      this.unparseableLines.push(rawLine);
      journalOperations.push({ type: 'raw', rawLine });
      didMutate = true;
    }

    if (didMutate) {
      try {
        await this.appendJournal('import', {
          detectedFormat,
          result,
          operations: journalOperations,
        });
        this.rebuildIndexes();
      } catch (error) {
        this.qsoCache = beforeCache;
        this.foreignRecordLines = beforeForeign;
        this.unparseableLines = beforeUnparseable;
        this.rebuildIndexes();
        throw error;
      }
    }

    return result;
    });
  }

  async importADIF(adifContent: string): Promise<LogBookImportResult> {
    this.ensureInitialized();

    const adif = AdifParser.parseAdi(adifContent);
    const rawEntries = buildRawAdifLineEntries(adifContent);
    const rawLineQueues = createRawAdifLineQueues(rawEntries);
    const consumedRawLineIndexes = new Set<number>();
    const records: ImportedRecordInput[] = [];
    let skipped = 0;
    const totalRead = Math.max(adif.records?.length || 0, rawEntries.length);

    if (adif.records) {
      for (let recordIndex = 0; recordIndex < adif.records.length; recordIndex += 1) {
        const record = adif.records[recordIndex];
        try {
          const qsoRecord = this.adifToQSORecord(record);
          const rawEntry = takeRawAdifLineForRecord(
            record as Record<string, unknown>,
            rawLineQueues,
            consumedRawLineIndexes,
            rawEntries[recordIndex],
          );
          records.push({
            record: qsoRecord,
            rawLine: rawEntry?.line,
          });
        } catch (error) {
          logger.warn('Failed to parse ADIF record during import', { error });
          skipped += 1;
        }
      }
    }

    const unparseableRawLines = rawEntries
      .filter(entry => !consumedRawLineIndexes.has(entry.index))
      .map(entry => entry.line);
    return this.importRecords(records, 'adif', totalRead, skipped, unparseableRawLines);
  }

  async importCSV(csvContent: string): Promise<LogBookImportResult> {
    this.ensureInitialized();
    const parsed = parseTx5drCsvContent(csvContent);
    return this.importRecords(
      parsed.records.map(record => ({ record })),
      'csv',
      parsed.totalRead,
      parsed.skipped,
    );
  }
  
  async close(): Promise<void> {
    if (this.isInitialized) {
      await this.flush();
    }
    this.unregisterPersistence?.();
    this.unregisterPersistence = null;
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
