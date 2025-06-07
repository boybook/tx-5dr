import { ILogProvider, CallsignAnalysis } from '@tx5dr/core';
import { QSORecord } from '@tx5dr/contracts';
import { ADIFLogProvider } from './ADIFLogProvider.js';
import { getDataFilePath, getLogFilePath } from '../utils/app-paths.js';

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
  private operatorLogBookMap: Map<string, string> = new Map(); // operatorId -> logBookId
  private isInitialized: boolean = false;
  private defaultLogBookId: string = 'default';
  
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
   * 会自动创建一个默认日志本
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      console.log('📋 [日志管理器] 已经初始化');
      return;
    }
    
    console.log('📋 [日志管理器] 正在初始化...');
    
    // 创建默认日志本
    const defaultLogPath = await getLogFilePath('tx5dr.adi');
    await this.createLogBook({
      id: this.defaultLogBookId,
      name: '默认日志本',
      description: 'TX-5DR默认日志本',
      filePath: defaultLogPath,
      autoCreateFile: true,
      logFileName: 'tx5dr.adi'
    });
    
    this.isInitialized = true;
    console.log('✅ [日志管理器] 初始化完成');
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
      // 如果没有指定路径，使用标准日志目录
      const fileName = config.logFileName ?? `${config.id}.adi`;
      logFilePath = await getLogFilePath(fileName);
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
    if (logBookId === this.defaultLogBookId) {
      throw new Error('不能删除默认日志本');
    }
    
    const logBook = this.logBooks.get(logBookId);
    if (!logBook) {
      throw new Error(`日志本 ${logBookId} 不存在`);
    }
    
    // 检查是否有操作员正在使用此日志本
    const usingOperators = Array.from(this.operatorLogBookMap.entries())
      .filter(([_, bookId]) => bookId === logBookId)
      .map(([operatorId]) => operatorId);
    
    if (usingOperators.length > 0) {
      throw new Error(`日志本 ${logBookId} 正在被操作员使用: ${usingOperators.join(', ')}`);
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
   * 获取默认日志本
   */
  getDefaultLogBook(): LogBookInstance | null {
    return this.getLogBook(this.defaultLogBookId);
  }
  
  /**
   * 将操作员连接到指定日志本
   */
  async connectOperatorToLogBook(operatorId: string, logBookId: string): Promise<void> {
    const logBook = this.logBooks.get(logBookId);
    if (!logBook) {
      throw new Error(`日志本 ${logBookId} 不存在`);
    }
    
    this.operatorLogBookMap.set(operatorId, logBookId);
    logBook.lastUsed = Date.now();
    
    console.log(`📋 [日志管理器] 操作员 ${operatorId} 已连接到日志本 ${logBook.name}`);
  }
  
  /**
   * 断开操作员与日志本的连接
   */
  disconnectOperatorFromLogBook(operatorId: string): void {
    const logBookId = this.operatorLogBookMap.get(operatorId);
    if (logBookId) {
      this.operatorLogBookMap.delete(operatorId);
      console.log(`📋 [日志管理器] 操作员 ${operatorId} 已断开与日志本的连接`);
    }
  }
  
  /**
   * 获取操作员当前连接的日志本ID
   */
  getOperatorLogBookId(operatorId: string): string {
    return this.operatorLogBookMap.get(operatorId) || this.defaultLogBookId;
  }
  
  /**
   * 获取操作员当前连接的日志本
   */
  getOperatorLogBook(operatorId: string): LogBookInstance | null {
    const logBookId = this.getOperatorLogBookId(operatorId);
    return this.getLogBook(logBookId);
  }
  
  /**
   * 获取日志Provider（向后兼容）
   */
  getLogProvider(): ILogProvider | null {
    const defaultLogBook = this.getLogBook(this.defaultLogBookId);
    return defaultLogBook?.provider || null;
  }
  
  /**
   * 关闭日志管理器
   */
  async close(): Promise<void> {
    for (const logBook of this.logBooks.values()) {
      await logBook.provider.close();
    }
    
    this.logBooks.clear();
    this.operatorLogBookMap.clear();
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