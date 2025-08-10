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
  async initialize(options?: any): Promise<void> {
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
        console.log(`📋 [ADIFLogProvider] 发现旧日志文件: ${legacyPath}`);
        console.log(`📋 [ADIFLogProvider] 将迁移到用户数据目录: ${standardPath}`);
        
        // 迁移文件到新位置
        const dir = path.dirname(standardPath);
        await fs.mkdir(dir, { recursive: true });
        await fs.copyFile(legacyPath, standardPath);
        
        console.log(`✅ [ADIFLogProvider] 文件迁移完成`);
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
      console.log(`[ADIFLogProvider] 读取文件内容长度: ${content.length}`);
      
      const adif = AdifParser.parseAdi(content);
      console.log(`[ADIFLogProvider] 解析到 ${adif.records?.length || 0} 条记录`);
      
      this.qsoCache.clear();
      
      if (adif.records) {
        for (const record of adif.records) {
          try {
            // 直接传递record，而不是record.fields
            const qso = this.adifToQSORecord(record);
            this.qsoCache.set(qso.id, qso);
            console.log(`[ADIFLogProvider] 加载QSO: ${qso.id} - ${qso.callsign}`);
          } catch (err) {
            console.error(`[ADIFLogProvider] 加载记录失败:`, err, record);
          }
        }
      }
      
      console.log(`[ADIFLogProvider] 缓存中现有 ${this.qsoCache.size} 条记录`);
    } catch (error) {
      console.error('Failed to load ADIF log cache:', error);
    }
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
      frequency,
      mode: fields.mode || 'FT8',
      startTime,
      endTime,
      reportSent: fields.rst_sent,
      reportReceived: fields.rst_rcvd,
      messages: fields.comment ? [fields.comment] : []
    };
  }
  
  /**
   * 将QSORecord转换为ADIF记录
   */
  private qsoRecordToADIF(qso: QSORecord, operatorId?: string): string {
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
    await this.saveCache();
  }
  
  async deleteQSO(id: string): Promise<void> {
    this.ensureInitialized();
    
    if (!this.qsoCache.delete(id)) {
      throw new Error(`QSO with id ${id} not found`);
    }
    
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
      
      // 限制返回数量
      if (options.limit) {
        results = results.slice(0, options.limit);
      }
    }
    
    return results;
  }
  
  async hasWorkedCallsign(callsign: string, operatorId?: string): Promise<boolean> {
    this.ensureInitialized();
    
    const upperCallsign = callsign.toUpperCase();
    
    for (const qso of this.qsoCache.values()) {
      if (qso.callsign.toUpperCase() === upperCallsign) {
        // 如果没有指定operatorId，返回true
        if (!operatorId) {
          return true;
        }
        
        // 检查ID中是否包含operatorId
        if (qso.id.includes(operatorId)) {
          return true;
        }
        
        // 向后兼容：如果记录ID没有operatorId部分（旧格式），也认为匹配
        // ID格式可能是：callsign_date_time 或 callsign_timestamp_timestamp_operatorId
        const parts = qso.id.split('_');
        if (parts.length === 3) {
          // 旧格式，没有operatorId，认为匹配所有operator
          return true;
        }
      }
    }
    
    return false;
  }
  
  async getLastQSOWithCallsign(callsign: string, operatorId?: string): Promise<QSORecord | null> {
    this.ensureInitialized();
    
    const qsos = await this.queryQSOs({
      callsign,
      operatorId,
      orderBy: 'time',
      orderDirection: 'desc',
      limit: 1
    });
    
    return qsos.length > 0 ? qsos[0] : null;
  }
  
  async analyzeCallsign(callsign: string, grid?: string, operatorId?: string): Promise<CallsignAnalysis> {
    this.ensureInitialized();
    
    const upperCallsign = callsign.toUpperCase();
    const prefix = extractPrefix(upperCallsign);
    const prefixInfo = getPrefixInfo(upperCallsign);
    
    // 查找所有与该呼号的QSO
    const qsos = await this.queryQSOs({ callsign: upperCallsign, operatorId });
    const isNewCallsign = qsos.length === 0;
    const lastQSO = qsos.length > 0 ? qsos[0] : undefined;
    
    // 检查是否是新网格
    let isNewGrid = !!grid;
    if (grid && !isNewCallsign) {
      isNewGrid = !qsos.some(qso => qso.grid === grid);
    }
    
    // 检查是否是新前缀
    const allPrefixes = new Set<string>();
    for (const qso of this.qsoCache.values()) {
      if (this.isQSOBelongsToOperator(qso.id, operatorId)) {
        allPrefixes.add(extractPrefix(qso.callsign));
      }
    }
    const isNewPrefix = !allPrefixes.has(prefix);
    
    // 检查是否是新CQ/ITU分区
    const cqZone = getCQZone(upperCallsign);
    const ituZone = getITUZone(upperCallsign);
    
    const allCQZones = new Set<number>();
    const allITUZones = new Set<number>();
    
    for (const qso of this.qsoCache.values()) {
      if (this.isQSOBelongsToOperator(qso.id, operatorId)) {
        const qsoCQ = getCQZone(qso.callsign);
        const qsoITU = getITUZone(qso.callsign);
        if (qsoCQ !== null) allCQZones.add(qsoCQ);
        if (qsoITU !== null) allITUZones.add(qsoITU);
      }
    }
    
    const isNewCQZone = cqZone !== null && !allCQZones.has(cqZone);
    const isNewITUZone = ituZone !== null && !allITUZones.has(ituZone);
    
    return {
      isNewCallsign,
      lastQSO,
      qsoCount: qsos.length,
      isNewGrid,
      isNewPrefix,
      isNewCQZone,
      isNewITUZone,
      prefix,
      cqZone: cqZone || undefined,
      ituZone: ituZone || undefined,
      dxccEntity: prefixInfo?.dxccEntity
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
  
  async exportADIF(options?: LogQueryOptions): Promise<string> {
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
      adifContent += this.qsoRecordToADIF(qso, operatorId);
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