import { ILogProvider, CallsignAnalysis } from '@tx5dr/core';
import { QSORecord } from '@tx5dr/contracts';
import { ADIFLogProvider } from './ADIFLogProvider';

/**
 * 日志管理器 - 单例模式
 * 负责管理所有日志Provider实例
 */
export class LogManager {
  private static instance: LogManager | null = null;
  private logProvider: ILogProvider | null = null;
  private isInitialized: boolean = false;
  
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
   * @param logFilePath 日志文件路径（可选）
   */
  async initialize(logFilePath?: string): Promise<void> {
    if (this.isInitialized) {
      console.log('📋 [日志管理器] 已经初始化');
      return;
    }
    
    console.log('📋 [日志管理器] 正在初始化...');
    
    // 创建ADIF日志Provider
    this.logProvider = new ADIFLogProvider({
      logFilePath,
      autoCreateFile: true,
      logFileName: 'tx5dr.adi'
    });
    
    await this.logProvider.initialize();
    
    const filePath = (this.logProvider as ADIFLogProvider).getLogFilePath();
    console.log(`📋 [日志管理器] 日志文件路径: ${filePath}`);
    
    this.isInitialized = true;
    console.log('✅ [日志管理器] 初始化完成');
  }
  
  /**
   * 记录QSO
   */
  async recordQSO(qsoRecord: QSORecord, operatorId?: string): Promise<void> {
    this.ensureInitialized();
    
    console.log(`📝 [日志管理器] 记录QSO: ${qsoRecord.callsign} @ ${new Date(qsoRecord.startTime).toISOString()}`);
    await this.logProvider!.addQSO(qsoRecord, operatorId);
  }
  
  /**
   * 分析呼号
   */
  async analyzeCallsign(callsign: string, grid?: string, operatorId?: string): Promise<CallsignAnalysis> {
    this.ensureInitialized();
    return await this.logProvider!.analyzeCallsign(callsign, grid, operatorId);
  }
  
  /**
   * 检查是否已经与某呼号通联过
   */
  async hasWorkedCallsign(callsign: string, operatorId?: string): Promise<boolean> {
    this.ensureInitialized();
    return await this.logProvider!.hasWorkedCallsign(callsign, operatorId);
  }
  
  /**
   * 获取与某呼号的最后一次通联记录
   */
  async getLastQSOWithCallsign(callsign: string, operatorId?: string): Promise<QSORecord | null> {
    this.ensureInitialized();
    return await this.logProvider!.getLastQSOWithCallsign(callsign, operatorId);
  }
  
  /**
   * 获取日志统计信息
   */
  async getStatistics(operatorId?: string): Promise<any> {
    this.ensureInitialized();
    return await this.logProvider!.getStatistics(operatorId);
  }
  
  /**
   * 查询QSO记录
   */
  async queryQSOs(options?: any): Promise<QSORecord[]> {
    this.ensureInitialized();
    return await this.logProvider!.queryQSOs(options);
  }
  
  /**
   * 导出ADIF格式日志
   */
  async exportADIF(options?: any): Promise<string> {
    this.ensureInitialized();
    return await this.logProvider!.exportADIF(options);
  }
  
  /**
   * 导入ADIF格式日志
   */
  async importADIF(adifContent: string, operatorId?: string): Promise<void> {
    this.ensureInitialized();
    return await this.logProvider!.importADIF(adifContent, operatorId);
  }
  
  /**
   * 获取日志Provider
   */
  getLogProvider(): ILogProvider | null {
    return this.logProvider;
  }
  
  /**
   * 关闭日志管理器
   */
  async close(): Promise<void> {
    if (this.logProvider) {
      await this.logProvider.close();
      this.logProvider = null;
      this.isInitialized = false;
    }
  }
  
  /**
   * 确保已初始化
   */
  private ensureInitialized(): void {
    if (!this.isInitialized || !this.logProvider) {
      throw new Error('LogManager not initialized. Call initialize() first.');
    }
  }
} 