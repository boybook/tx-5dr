import { ILogProvider, CallsignAnalysis } from '@tx5dr/core';

import { ADIFLogProvider } from './ADIFLogProvider.js';
import { getDataFilePath } from '../utils/app-paths.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('LogManager');

/**
 * 日志本实例
 */
export interface LogBookInstance {
  id: string;
  name: string;
  description?: string;
  filePath: string;
  provider: ILogProvider;
  createdAt: number;
  lastUsed: number;
  isActive: boolean;
}

/**
 * 日志本配置
 */
export interface LogBookConfig {
  id: string;
  name: string;
  description?: string;
  filePath?: string;
  logFileName?: string;
  autoCreateFile?: boolean;
}

/**
 * 日志管理器 - 简化版本，只负责管理LogBookInstance
 * 外部通过LogBookInstance直接调用provider方法
 */
export class LogManager {
  private static instance: LogManager | null = null;
  private logBooks: Map<string, LogBookInstance> = new Map();
  private callsignLogBookMap: Map<string, string> = new Map(); // callsign -> logBookId
  private operatorCallsignMap: Map<string, string> = new Map(); // operatorId -> callsign
  private isInitialized: boolean = false;
  // 已移除默认日志本概念，只有基于呼号的日志本
  
  private constructor() {}
  
  /**
   * 获取单例实例
   */
  static getInstance(): LogManager {
    if (!LogManager.instance) {
      LogManager.instance = new LogManager();
    }
    return LogManager.instance;
  }
  
  /**
   * 初始化日志管理器
   * 不再创建默认日志本，仅准备基础环境
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      logger.info('Already initialized');
      return;
    }

    logger.info('Initializing');
    
    // 确保logbook目录存在
    const logbookDir = await getDataFilePath('logbook');
    const path = await import('path');
    const fs = await import('fs/promises');
    try {
      await fs.mkdir(logbookDir, { recursive: true });
      logger.info(`Logbook directory ready: ${logbookDir}`);
    } catch (error) {
      logger.error('Failed to create logbook directory', error);
    }

    this.isInitialized = true;
    logger.info('Initialization complete - callsign-based log system ready');
  }

  /**
   * 为所有已注册的操作员初始化日志本
   * 应该在所有操作员注册完成后调用
   */
  async initializeLogBooksForExistingOperators(): Promise<void> {
    if (!this.isInitialized) {
      logger.warn('Not initialized, skipping operator logbook initialization');
      return;
    }

    logger.info('Initializing logbooks for existing operators');
    
    const callsigns = Array.from(this.operatorCallsignMap.values());
    const uniqueCallsigns = [...new Set(callsigns)]; // 去重
    
    for (const callsign of uniqueCallsigns) {
      try {
        await this.getOrCreateLogBookByCallsign(callsign);
        logger.info(`Logbook initialized for callsign ${callsign}`);
      } catch (error) {
        logger.error(`Failed to initialize logbook for callsign ${callsign}`, error);
      }
    }
    
    logger.info(`Completed logbook initialization for ${uniqueCallsigns.length} callsigns`);
  }
  
  /**
   * 创建新的日志本
   */
  async createLogBook(config: LogBookConfig): Promise<LogBookInstance> {
    if (this.logBooks.has(config.id)) {
      throw new Error(`logbook ${config.id} already exists`);
    }
    
    logger.info(`Creating logbook: ${config.name} (${config.id})`);
    
    // 确定日志文件路径
    let logFilePath: string;
    if (config.filePath) {
      logFilePath = config.filePath;
    } else {
      // 如果没有指定路径，使用标准用户数据目录
      const fileName = config.logFileName ?? `${config.id}.adi`;
      logFilePath = await getDataFilePath(fileName);
    }
    
    logger.debug(`Log file path: ${logFilePath}`);
    
    // 创建ADIF日志Provider
    const provider = new ADIFLogProvider({
      logFilePath,
      autoCreateFile: config.autoCreateFile ?? true,
      logFileName: config.logFileName ?? 'tx5dr.adi'
    });
    
    await provider.initialize();
    
    const logBook: LogBookInstance = {
      id: config.id,
      name: config.name,
      description: config.description,
      filePath: (provider as ADIFLogProvider).getLogFilePath(),
      provider,
      createdAt: Date.now(),
      lastUsed: Date.now(),
      isActive: true
    };
    
    this.logBooks.set(config.id, logBook);
    logger.info(`Logbook created: ${config.name} -> ${logBook.filePath}`);
    
    return logBook;
  }
  
  /**
   * 删除日志本
   */
  async deleteLogBook(logBookId: string): Promise<void> {
    const logBook = this.logBooks.get(logBookId);
    if (!logBook) {
      throw new Error(`logbook ${logBookId} not found`);
    }

    // 检查是否有呼号正在使用此日志本
    const usingCallsigns = Array.from(this.callsignLogBookMap.entries())
      .filter(([_, bookId]) => bookId === logBookId)
      .map(([callsign]) => callsign);
    
    if (usingCallsigns.length > 0) {
      throw new Error(`logbook ${logBookId} is in use by callsigns: ${usingCallsigns.join(', ')}`);
    }
    
    await logBook.provider.close();
    this.logBooks.delete(logBookId);
    
    logger.info(`Logbook deleted: ${logBook.name}`);
  }
  
  /**
   * 获取所有日志本
   */
  getLogBooks(): LogBookInstance[] {
    return Array.from(this.logBooks.values());
  }
  
  /**
   * 获取指定ID的日志本
   */
  getLogBook(logBookId: string): LogBookInstance | null {
    const logBook = this.logBooks.get(logBookId);
    if (logBook) {
      logBook.lastUsed = Date.now();
    }
    return logBook || null;
  }
  
  /**
   * 获取操作员的呼号
   */
  getOperatorCallsign(operatorId: string): string | null {
    return this.operatorCallsignMap.get(operatorId) || null;
  }
  
  /**
   * 根据呼号自动创建或获取日志本
   */
  async getOrCreateLogBookByCallsign(callsign: string): Promise<LogBookInstance> {
    const normalizedCallsign = callsign.toUpperCase();
    let logBookId = this.callsignLogBookMap.get(normalizedCallsign);
    
    if (!logBookId) {
      // 为该呼号创建新的日志本 - 存储在logbook子目录
      logBookId = `logbook-${normalizedCallsign}`;
      const logFileName = `logbook/${normalizedCallsign}.adi`;
      
      logger.info(`Creating logbook for callsign ${normalizedCallsign}`);
      
      const logBook = await this.createLogBook({
        id: logBookId,
        name: `${normalizedCallsign} QSO Log`,
        description: `QSO records for ${normalizedCallsign}`,
        logFileName: logFileName,
        autoCreateFile: true
      });
      
      this.callsignLogBookMap.set(normalizedCallsign, logBookId);
      return logBook;
    }
    
    const logBook = this.logBooks.get(logBookId);
    if (!logBook) {
      throw new Error(`logbook ${logBookId} not found (callsign: ${normalizedCallsign})`);
    }
    
    logBook.lastUsed = Date.now();
    return logBook;
  }
  
  /**
   * 注册操作员的呼号
   */
  registerOperatorCallsign(operatorId: string, callsign: string): void {
    const normalizedCallsign = callsign.toUpperCase();
    this.operatorCallsignMap.set(operatorId, normalizedCallsign);
    logger.info(`Operator ${operatorId} registered callsign: ${normalizedCallsign}`);
  }

  /**
   * 将操作员连接到指定日志本（向后兼容方法）
   */
  async connectOperatorToLogBook(operatorId: string, logBookId: string): Promise<void> {
    const logBook = this.logBooks.get(logBookId);
    if (!logBook) {
      throw new Error(`logbook ${logBookId} not found`);
    }

    // 获取操作员呼号
    const callsign = this.operatorCallsignMap.get(operatorId);
    if (callsign) {
      // 将呼号映射到指定的日志本
      this.callsignLogBookMap.set(callsign, logBookId);
      logBook.lastUsed = Date.now();
      logger.info(`Operator ${operatorId} (callsign: ${callsign}) connected to logbook ${logBook.name}`);
    } else {
      logger.warn(`Operator ${operatorId} has no registered callsign, cannot connect to logbook`);
    }
  }

  /**
   * 断开操作员与日志本的连接（向后兼容方法）
   */
  disconnectOperatorFromLogBook(operatorId: string): void {
    const callsign = this.operatorCallsignMap.get(operatorId);
    if (callsign) {
      const logBookId = this.callsignLogBookMap.get(callsign);
      if (logBookId) {
        this.callsignLogBookMap.delete(callsign);
        logger.info(`Operator ${operatorId} (callsign: ${callsign}) disconnected from logbook`);
      }
    }
  }
  
  /**
   * 获取操作员对应的日志本ID
   */
  getOperatorLogBookId(operatorId: string): string | null {
    const callsign = this.operatorCallsignMap.get(operatorId);
    if (!callsign) {
      return null; // 没有注册呼号的操作员没有日志本
    }
    return this.callsignLogBookMap.get(callsign) || null;
  }
  
  /**
   * 反向查找：给定 logBookId，找出所有关联的 operatorId
   */
  getOperatorIdsForLogBook(logBookId: string): string[] {
    const matchingCallsigns: string[] = [];
    for (const [callsign, bookId] of this.callsignLogBookMap.entries()) {
      if (bookId === logBookId) matchingCallsigns.push(callsign);
    }
    const result: string[] = [];
    for (const [operatorId, callsign] of this.operatorCallsignMap.entries()) {
      if (matchingCallsigns.includes(callsign)) result.push(operatorId);
    }
    return result;
  }

  /**
   * 根据真实 ID 或呼号字符串解析 logBookId，仅查询不创建，找不到返回 null
   */
  resolveLogBookId(idOrCallsign: string): string | null {
    if (this.logBooks.has(idOrCallsign)) return idOrCallsign;
    const normalized = idOrCallsign.toUpperCase();
    return this.callsignLogBookMap.get(normalized) ?? null;
  }

  /**
   * 返回与 operatorIds 有交集的日志本列表（孤儿日志本不包含，admin 另走 getLogBooks）
   */
  getAccessibleLogBooks(operatorIds: string[]): LogBookInstance[] {
    const result: LogBookInstance[] = [];
    for (const logBook of this.logBooks.values()) {
      const associated = this.getOperatorIdsForLogBook(logBook.id);
      if (associated.length === 0) continue;
      if (associated.some(id => operatorIds.includes(id))) result.push(logBook);
    }
    return result;
  }

  /**
   * 获取操作员对应的日志本
   */
  async getOperatorLogBook(operatorId: string): Promise<LogBookInstance | null> {
    const callsign = this.operatorCallsignMap.get(operatorId);
    if (!callsign) {
      // 没有注册呼号的操作员没有日志本
      logger.warn(`Operator ${operatorId} has no registered callsign, cannot get logbook`);
      return null;
    }
    
    try {
      return await this.getOrCreateLogBookByCallsign(callsign);
    } catch (error) {
      logger.error(`Failed to get logbook for operator ${operatorId} (callsign: ${callsign})`, error);
      return null;
    }
  }
  
  /**
   * 获取日志Provider（已废弃，不再支持默认日志本）
   */
  getLogProvider(): ILogProvider | null {
    logger.warn('getLogProvider() is deprecated, use getOperatorLogBook() instead');
    return null;
  }
  
  /**
   * 关闭日志管理器
   */
  async close(): Promise<void> {
    for (const logBook of this.logBooks.values()) {
      await logBook.provider.close();
    }
    
    this.logBooks.clear();
    this.callsignLogBookMap.clear();
    this.operatorCallsignMap.clear();
    this.isInitialized = false;
  }
  
  /**
   * 确保已初始化
   */
  private ensureInitialized(): void {
    if (!this.isInitialized) {
      throw new Error('LogManager not initialized. Call initialize() first.');
    }
  }
} 