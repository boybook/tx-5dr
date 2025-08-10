import { ILogProvider, CallsignAnalysis } from '@tx5dr/core';
import { QSORecord } from '@tx5dr/contracts';
import { ADIFLogProvider } from './ADIFLogProvider.js';
import { getDataFilePath } from '../utils/app-paths.js';

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
      console.log('📋 [日志管理器] 已经初始化');
      return;
    }
    
    console.log('📋 [日志管理器] 正在初始化...');
    
    // 确保logbook目录存在
    const logbookDir = await getDataFilePath('logbook');
    const path = await import('path');
    const fs = await import('fs/promises');
    try {
      await fs.mkdir(logbookDir, { recursive: true });
      console.log(`📋 [日志管理器] logbook目录已准备: ${logbookDir}`);
    } catch (error) {
      console.error('📋 [日志管理器] 创建logbook目录失败:', error);
    }
    
    this.isInitialized = true;
    console.log('✅ [日志管理器] 初始化完成 - 基于呼号的日志系统已就绪');
  }

  /**
   * 为所有已注册的操作员初始化日志本
   * 应该在所有操作员注册完成后调用
   */
  async initializeLogBooksForExistingOperators(): Promise<void> {
    if (!this.isInitialized) {
      console.warn('📋 [日志管理器] 尚未初始化，跳过操作员日志本初始化');
      return;
    }

    console.log('📋 [日志管理器] 开始为现有操作员初始化日志本...');
    
    const callsigns = Array.from(this.operatorCallsignMap.values());
    const uniqueCallsigns = [...new Set(callsigns)]; // 去重
    
    for (const callsign of uniqueCallsigns) {
      try {
        await this.getOrCreateLogBookByCallsign(callsign);
        console.log(`📋 [日志管理器] 已为呼号 ${callsign} 初始化日志本`);
      } catch (error) {
        console.error(`📋 [日志管理器] 为呼号 ${callsign} 初始化日志本失败:`, error);
      }
    }
    
    console.log(`✅ [日志管理器] 完成 ${uniqueCallsigns.length} 个呼号的日志本初始化`);
  }
  
  /**
   * 创建新的日志本
   */
  async createLogBook(config: LogBookConfig): Promise<LogBookInstance> {
    if (this.logBooks.has(config.id)) {
      throw new Error(`日志本 ${config.id} 已存在`);
    }
    
    console.log(`📋 [日志管理器] 创建日志本: ${config.name} (${config.id})`);
    
    // 确定日志文件路径
    let logFilePath: string;
    if (config.filePath) {
      logFilePath = config.filePath;
    } else {
      // 如果没有指定路径，使用标准用户数据目录
      const fileName = config.logFileName ?? `${config.id}.adi`;
      logFilePath = await getDataFilePath(fileName);
    }
    
    console.log(`📋 [日志管理器] 日志文件路径: ${logFilePath}`);
    
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
    console.log(`📋 [日志管理器] 日志本创建完成: ${config.name} -> ${logBook.filePath}`);
    
    return logBook;
  }
  
  /**
   * 删除日志本
   */
  async deleteLogBook(logBookId: string): Promise<void> {
    const logBook = this.logBooks.get(logBookId);
    if (!logBook) {
      throw new Error(`日志本 ${logBookId} 不存在`);
    }
    
    // 检查是否有呼号正在使用此日志本
    const usingCallsigns = Array.from(this.callsignLogBookMap.entries())
      .filter(([_, bookId]) => bookId === logBookId)
      .map(([callsign]) => callsign);
    
    if (usingCallsigns.length > 0) {
      throw new Error(`日志本 ${logBookId} 正在被呼号使用: ${usingCallsigns.join(', ')}`);
    }
    
    await logBook.provider.close();
    this.logBooks.delete(logBookId);
    
    console.log(`📋 [日志管理器] 日志本已删除: ${logBook.name}`);
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
      
      console.log(`📋 [日志管理器] 为呼号 ${normalizedCallsign} 创建日志本`);
      
      const logBook = await this.createLogBook({
        id: logBookId,
        name: `${normalizedCallsign} 通联日志`,
        description: `${normalizedCallsign} 电台的通联记录`,
        logFileName: logFileName,
        autoCreateFile: true
      });
      
      this.callsignLogBookMap.set(normalizedCallsign, logBookId);
      return logBook;
    }
    
    const logBook = this.logBooks.get(logBookId);
    if (!logBook) {
      throw new Error(`日志本 ${logBookId} 不存在（呼号: ${normalizedCallsign}）`);
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
    console.log(`📋 [日志管理器] 操作员 ${operatorId} 注册呼号: ${normalizedCallsign}`);
  }

  /**
   * 将操作员连接到指定日志本（向后兼容方法）
   */
  async connectOperatorToLogBook(operatorId: string, logBookId: string): Promise<void> {
    const logBook = this.logBooks.get(logBookId);
    if (!logBook) {
      throw new Error(`日志本 ${logBookId} 不存在`);
    }
    
    // 获取操作员呼号
    const callsign = this.operatorCallsignMap.get(operatorId);
    if (callsign) {
      // 将呼号映射到指定的日志本
      this.callsignLogBookMap.set(callsign, logBookId);
      logBook.lastUsed = Date.now();
      console.log(`📋 [日志管理器] 操作员 ${operatorId} (呼号: ${callsign}) 已连接到日志本 ${logBook.name}`);
    } else {
      console.warn(`📋 [日志管理器] 警告：操作员 ${operatorId} 未注册呼号，无法连接到日志本`);
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
        console.log(`📋 [日志管理器] 操作员 ${operatorId} (呼号: ${callsign}) 已断开与日志本的连接`);
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
   * 获取操作员对应的日志本
   */
  async getOperatorLogBook(operatorId: string): Promise<LogBookInstance | null> {
    const callsign = this.operatorCallsignMap.get(operatorId);
    if (!callsign) {
      // 没有注册呼号的操作员没有日志本
      console.warn(`📋 [日志管理器] 操作员 ${operatorId} 未注册呼号，无法获取日志本`);
      return null;
    }
    
    try {
      return await this.getOrCreateLogBookByCallsign(callsign);
    } catch (error) {
      console.error(`📋 [日志管理器] 获取操作员 ${operatorId} (呼号: ${callsign}) 的日志本失败:`, error);
      return null;
    }
  }
  
  /**
   * 获取日志Provider（已废弃，不再支持默认日志本）
   */
  getLogProvider(): ILogProvider | null {
    console.warn('📋 [日志管理器] getLogProvider() 已废弃，请使用 getOperatorLogBook() 替代');
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