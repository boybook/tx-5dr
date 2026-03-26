/* eslint-disable @typescript-eslint/no-explicit-any */
// ADIFLogProvider - 日志解析需要使用any

import { QSORecord } from '@tx5dr/contracts';
import {
  ILogProvider,
  LogQueryOptions,
  LogStatistics,
  CallsignAnalysis,
  getBandFromFrequency,
  extractPrefix,
  getPrefixInfo,
  getCQZone,
  getITUZone
} from '@tx5dr/core';
import { AdifParser } from 'adif-parser-ts';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { getDataFilePath } from '../utils/app-paths.js';
import { createLogger } from '../utils/logger.js';

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
  perCallsign: Map<string, PerCallsignInfo>;
  // 每个呼号对应已通联过的频段集合（用于O(1)按频段判重）
  perCallsignBands: Map<string, Set<string>>;
}

function createEmptyOperatorIndex(): OperatorIndex {
  return {
    prefixes: new Set<string>(),
    cqZones: new Set<number>(),
    ituZones: new Set<number>(),
    perCallsign: new Map<string, PerCallsignInfo>(),
    perCallsignBands: new Map<string, Set<string>>()
  };
}

function addQSOToIndex(index: OperatorIndex, qso: QSORecord): void {
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

  // 按呼号的统计
  const key = qso.callsign.toUpperCase();
  const existing = index.perCallsign.get(key);
  if (!existing) {
    index.perCallsign.set(key, {
      count: 1,
      lastQSO: qso,
      grids: new Set(qso.grid ? [qso.grid] : [])
    });
  } else {
    existing.count += 1;
    if (!existing.lastQSO || qso.startTime > existing.lastQSO.startTime) {
      existing.lastQSO = qso;
    }
    if (qso.grid) existing.grids.add(qso.grid);
  }

  // 按呼号的频段集合（用于快速判重）
  try {
    const band = getBandFromFrequency(qso.frequency);
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
  private getOperatorKey(operatorId?: string): string {
    return operatorId || ADIFLogProvider.ALL_KEY;
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

  private buildIndexForOperator(operatorId: string): OperatorIndex {
    const idx = createEmptyOperatorIndex();
    for (const qso of this.qsoCache.values()) {
      if (this.isQSOBelongsToOperator(qso.id, operatorId)) {
        addQSOToIndex(idx, qso);
      }
    }
    return idx;
  }

  private ensureIndex(operatorId?: string): OperatorIndex {
    const key = this.getOperatorKey(operatorId);
    let idx = this.operatorIndexMap.get(key);
    if (!idx) {
      idx = key === ADIFLogProvider.ALL_KEY ? this.buildIndexForAll() : this.buildIndexForOperator(key);
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
      const endTimeStr = fields.time_off;
      const endHour = parseInt(endTimeStr.substring(0, 2));
      const endMinute = parseInt(endTimeStr.substring(2, 4));
      const endSecond = endTimeStr.length >= 6 ? parseInt(endTimeStr.substring(4, 6)) : 0;
      endTime = new Date(Date.UTC(year, month, day, endHour, endMinute, endSecond)).getTime();
    }
    
    // 解析频率（MHz转Hz）
    const frequency = fields.freq ? parseFloat(fields.freq) * 1000000 : 0;
    
    return {
      id,
      callsign,
      grid: fields.gridsquare,
      myGrid: fields.my_gridsquare ?? undefined,
      myCallsign: fields.station_callsign ?? undefined,
      frequency,
      mode: fields.mode || 'FT8',
      startTime,
      endTime,
      reportSent: fields.rst_sent,
      reportReceived: fields.rst_rcvd,
      messages: fields.comment ? [fields.comment] : [],
      qth: fields.qth ?? undefined,
      remarks: fields.note ?? undefined,
    };
  }
  
  /**
   * 将QSORecord转换为ADIF记录
   * @param overrideMyGrid 覆盖 qso.myGrid（用于导出时注入兜底网格）
   */
  private qsoRecordToADIF(qso: QSORecord, operatorId?: string, overrideMyGrid?: string): string {
    const startDate = new Date(qso.startTime);
    const dateStr = startDate.toISOString().slice(0, 10).replace(/-/g, '');
    const timeOnStr = startDate.toISOString().slice(11, 19).replace(/:/g, '');
    
    let adifRecord = '';
    
    // 必需字段
    adifRecord += `<CALL:${qso.callsign.length}>${qso.callsign}`;
    adifRecord += `<QSO_DATE:8>${dateStr}`;
    adifRecord += `<TIME_ON:${timeOnStr.length}>${timeOnStr}`;
    adifRecord += `<MODE:${qso.mode.length}>${qso.mode}`;
    adifRecord += `<FREQ:${((qso.frequency / 1000000).toFixed(6)).length}>${(qso.frequency / 1000000).toFixed(6)}`;
    
    const band = getBandFromFrequency(qso.frequency);
    adifRecord += `<BAND:${band.length}>${band}`;
    
    // 可选字段
    if (qso.grid) {
      adifRecord += `<GRIDSQUARE:${qso.grid.length}>${qso.grid}`;
    }
    
    if (qso.endTime) {
      const endDate = new Date(qso.endTime);
      const timeOffStr = endDate.toISOString().slice(11, 19).replace(/:/g, '');
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
      adifRecord += `<NOTE:${qso.remarks.length}>${qso.remarks}`;
    }

    const effectiveMyGrid = overrideMyGrid ?? qso.myGrid;
    if (effectiveMyGrid) {
      adifRecord += `<MY_GRIDSQUARE:${effectiveMyGrid.length}>${effectiveMyGrid}`;
    }

    if (qso.myCallsign) {
      adifRecord += `<STATION_CALLSIGN:${qso.myCallsign.length}>${qso.myCallsign}`;
    }

    if (operatorId) {
      adifRecord += `<OPERATOR:${operatorId.length}>${operatorId}`;
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
      const parts = qso.id.split('_');
      const operatorId = parts.length > 3 ? parts[3] : undefined;
      adifContent += this.qsoRecordToADIF(qso, operatorId);
    }
    
    await fs.writeFile(this.logFilePath, adifContent, 'utf-8');
  }
  
  async addQSO(record: QSORecord, operatorId?: string): Promise<void> {
    this.ensureInitialized();
    
    // 生成唯一ID
    if (!record.id || this.qsoCache.has(record.id)) {
      record.id = `${record.callsign}_${record.startTime}_${Date.now()}_${operatorId || 'unknown'}`;
    }
    
    this.qsoCache.set(record.id, record);
    // 增量更新 ALL 索引
    const allIdx = this.operatorIndexMap.get(ADIFLogProvider.ALL_KEY);
    if (allIdx) addQSOToIndex(allIdx, record);
    // 增量更新指定 operator 的索引（如果已构建）
    if (operatorId) {
      const opIdx = this.operatorIndexMap.get(this.getOperatorKey(operatorId));
      if (opIdx) addQSOToIndex(opIdx, record);
    }
    await this.saveCache();
  }
  
  async updateQSO(id: string, updates: Partial<QSORecord>): Promise<void> {
    this.ensureInitialized();
    
    const existing = this.qsoCache.get(id);
    if (!existing) {
      throw new Error(`QSO with id ${id} not found`);
    }
    
    const updated = { ...existing, ...updates, id };
    this.qsoCache.set(id, updated);
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
  
  /**
   * 检查QSO记录是否属于指定的操作员
   * @param qsoId QSO记录的ID
   * @param operatorId 操作员ID
   * @returns 是否匹配
   */
  private isQSOBelongsToOperator(qsoId: string, operatorId?: string): boolean {
    if (!operatorId) {
      return true;
    }
    
    // 检查ID中是否包含operatorId
    if (qsoId.includes(operatorId)) {
      return true;
    }
    
    // 向后兼容：如果记录ID没有operatorId部分（旧格式），也认为匹配
    const parts = qsoId.split('_');
    if (parts.length === 3) {
      // 旧格式，没有operatorId，认为匹配所有operator
      return true;
    }
    
    return false;
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
        results = results.filter(qso => qso.grid === options.grid);
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

      // 操作员过滤
      if (options.operatorId) {
        results = results.filter(qso => this.isQSOBelongsToOperator(qso.id, options.operatorId));
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
    const prefixInfo = getPrefixInfo(upper);
    const cqZone = getCQZone(upper);
    const ituZone = getITUZone(upper);

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
    // 只有在"有网格 且 是新呼号"时才标记为新网格
    // 根据需求：只要呼号不是新的，就不提示新网格
    const isNewGrid = !!grid && !info;
    const isNewPrefix = !idx.prefixes.has(prefix);
    const isNewCQZone = cqZone !== null && !idx.cqZones.has(cqZone);
    const isNewITUZone = ituZone !== null && !idx.ituZones.has(ituZone);

    return {
      isNewCallsign,
      lastQSO,
      qsoCount,
      isNewGrid,
      isNewPrefix,
      isNewCQZone,
      isNewITUZone,
      prefix,
      cqZone: cqZone || undefined,
      ituZone: ituZone || undefined,
      dxccEntity: prefixInfo?.name
    };
  }
  
  async getStatistics(operatorId?: string): Promise<LogStatistics> {
    this.ensureInitialized();
    
    const qsos = await this.queryQSOs({ operatorId });
    
    const uniqueCallsigns = new Set<string>();
    const uniqueGrids = new Set<string>();
    const byMode = new Map<string, number>();
    const byBand = new Map<string, number>();
    let lastQSOTime: number | undefined;
    
    for (const qso of qsos) {
      uniqueCallsigns.add(qso.callsign);
      
      if (qso.grid) {
        uniqueGrids.add(qso.grid);
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
    }
    
    return {
      totalQSOs: qsos.length,
      uniqueCallsigns: uniqueCallsigns.size,
      uniqueGrids: uniqueGrids.size,
      byMode,
      byBand,
      lastQSOTime
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
      const parts = qso.id.split('_');
      const operatorId = parts.length > 3 ? parts[3] : undefined;
      const effectiveMyGrid = qso.myGrid || exportOptions?.fallbackGrid;
      adifContent += this.qsoRecordToADIF(qso, operatorId, effectiveMyGrid);
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
  
  async importADIF(adifContent: string, operatorId?: string): Promise<void> {
    this.ensureInitialized();
    
    const adif = AdifParser.parseAdi(adifContent);
    
    if (adif.records) {
      for (const record of adif.records) {
        const qso = this.adifToQSORecord(record);
        
        // 添加operatorId到ID中
        if (operatorId) {
          qso.id = `${qso.id}_${operatorId}`;
        }
        
        // 避免重复导入
        if (!this.qsoCache.has(qso.id)) {
          this.qsoCache.set(qso.id, qso);
        }
      }
    }
    
    await this.saveCache();
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
