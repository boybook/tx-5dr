/* eslint-disable @typescript-eslint/no-explicit-any */
// ConsoleLogger - 日志参数需要使用any以接受任意类型

import * as fs from 'fs/promises';
import * as path from 'path';
import { getLogFilePath } from './app-paths.js';

/**
 * Console 日志重定向器
 * 将所有的console输出重定向到系统日志文件，同时保留控制台输出
 */
export class ConsoleLogger {
  private static instance: ConsoleLogger | null = null;
  private logFilePath: string = '';
  private isInitialized: boolean = false;
  private logQueue: string[] = [];
  private isWriting: boolean = false;
  
  // 原始的console方法引用
  private originalConsole = {
    log: console.log,
    error: console.error,
    warn: console.warn,
    info: console.info,
    debug: console.debug
  };

  private constructor() {}

  static getInstance(): ConsoleLogger {
    if (!ConsoleLogger.instance) {
      ConsoleLogger.instance = new ConsoleLogger();
    }
    return ConsoleLogger.instance;
  }

  /**
   * 初始化日志重定向
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    // 获取日志文件路径
    this.logFilePath = await getLogFilePath('tx5dr-server.log');
    
    // 确保日志文件存在
    await this.ensureLogFile();

    // 重写console方法
    this.overrideConsole();
    
    this.isInitialized = true;
    
    // 记录启动信息
    this.writeLogEntry('INFO', '日志系统已初始化', `日志文件: ${this.logFilePath}`);
  }

  /**
   * 确保日志文件存在
   */
  private async ensureLogFile(): Promise<void> {
    try {
      await fs.access(this.logFilePath);
    } catch {
      // 文件不存在，创建它
      const dir = path.dirname(this.logFilePath);
      await fs.mkdir(dir, { recursive: true });
      
      // 创建带有头信息的日志文件
      const header = this.formatLogEntry('INFO', '系统启动', 'TX-5DR Server 日志文件创建');
      await fs.writeFile(this.logFilePath, header + '\n', 'utf-8');
    }
  }

  /**
   * 重写console方法
   */
  private overrideConsole(): void {
    console.log = (...args: any[]) => {
      this.originalConsole.log(...args);
      this.writeLogEntry('INFO', 'CONSOLE', this.formatArgs(args));
    };

    console.error = (...args: any[]) => {
      this.originalConsole.error(...args);
      this.writeLogEntry('ERROR', 'CONSOLE', this.formatArgs(args));
    };

    console.warn = (...args: any[]) => {
      this.originalConsole.warn(...args);
      this.writeLogEntry('WARN', 'CONSOLE', this.formatArgs(args));
    };

    console.info = (...args: any[]) => {
      this.originalConsole.info(...args);
      this.writeLogEntry('INFO', 'CONSOLE', this.formatArgs(args));
    };

    console.debug = (...args: any[]) => {
      this.originalConsole.debug(...args);
      this.writeLogEntry('DEBUG', 'CONSOLE', this.formatArgs(args));
    };
  }

  /**
   * 格式化参数为字符串
   */
  private formatArgs(args: any[]): string {
    return args.map(arg => {
      if (typeof arg === 'object') {
        try {
          return JSON.stringify(arg, null, 2);
        } catch {
          return String(arg);
        }
      }
      return String(arg);
    }).join(' ');
  }

  /**
   * 格式化日志条目
   */
  private formatLogEntry(level: string, category: string, message: string): string {
    const timestamp = new Date().toISOString();
    return `[${timestamp}] [${level.padEnd(5)}] [${category.padEnd(8)}] ${message}`;
  }

  /**
   * 写入日志条目
   */
  private writeLogEntry(level: string, category: string, message: string): void {
    if (!this.isInitialized) return;

    const logEntry = this.formatLogEntry(level, category, message);
    this.logQueue.push(logEntry);
    this.processLogQueue();
  }

  /**
   * 处理日志队列（异步写入，避免阻塞）
   */
  private async processLogQueue(): Promise<void> {
    if (this.isWriting || this.logQueue.length === 0) return;
    
    this.isWriting = true;
    
    try {
      const entries = this.logQueue.splice(0); // 取出所有待写入的条目
      const logData = entries.join('\n') + '\n';
      
      await fs.appendFile(this.logFilePath, logData, 'utf-8');
    } catch (error) {
      // 如果写入失败，使用原始console输出错误（避免无限递归）
      this.originalConsole.error('日志写入失败:', error);
    } finally {
      this.isWriting = false;
      
      // 如果还有新的日志条目，继续处理
      if (this.logQueue.length > 0) {
        setImmediate(() => this.processLogQueue());
      }
    }
  }

  /**
   * 手动写入日志（用于非console的日志）
   */
  writeLog(level: 'INFO' | 'ERROR' | 'WARN' | 'DEBUG', category: string, message: string): void {
    this.writeLogEntry(level, category, message);
  }

  /**
   * 恢复原始的console方法
   */
  restore(): void {
    console.log = this.originalConsole.log;
    console.error = this.originalConsole.error;
    console.warn = this.originalConsole.warn;
    console.info = this.originalConsole.info;
    console.debug = this.originalConsole.debug;
    
    this.writeLogEntry('INFO', '系统关闭', '日志系统已恢复原始console方法');
    this.isInitialized = false;
  }

  /**
   * 获取当前日志文件路径
   */
  getLogFilePath(): string {
    return this.logFilePath;
  }

  /**
   * 获取日志文件大小（字节）
   */
  async getLogFileSize(): Promise<number> {
    try {
      const stats = await fs.stat(this.logFilePath);
      return stats.size;
    } catch {
      return 0;
    }
  }

  /**
   * 清理旧日志（保留最近N天的日志）
   */
  async cleanupOldLogs(daysToKeep: number = 7): Promise<void> {
    try {
      const logDir = path.dirname(this.logFilePath);
      const files = await fs.readdir(logDir);
      const logFiles = files.filter(f => f.startsWith('tx5dr-server') && f.endsWith('.log'));
      
      const cutoffTime = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);
      
      for (const file of logFiles) {
        const filePath = path.join(logDir, file);
        try {
          const stats = await fs.stat(filePath);
          if (stats.mtime.getTime() < cutoffTime) {
            await fs.unlink(filePath);
            this.writeLogEntry('INFO', '日志清理', `已删除旧日志文件: ${file}`);
          }
        } catch (error) {
          this.writeLogEntry('WARN', '日志清理', `删除文件失败: ${file}, ${error}`);
        }
      }
    } catch (error) {
      this.writeLogEntry('ERROR', '日志清理', `清理过程出错: ${error}`);
    }
  }

  /**
   * 日志轮转（当文件超过指定大小时）
   */
  async rotateLogIfNeeded(maxSizeBytes: number = 10 * 1024 * 1024): Promise<void> { // 默认10MB
    const currentSize = await this.getLogFileSize();
    
    if (currentSize > maxSizeBytes) {
      const timestamp = new Date().toISOString().slice(0, 19).replace(/[:-]/g, '');
      const rotatedPath = this.logFilePath.replace('.log', `_${timestamp}.log`);
      
      try {
        await fs.rename(this.logFilePath, rotatedPath);
        await this.ensureLogFile(); // 创建新的日志文件
        
        this.writeLogEntry('INFO', '日志轮转', `日志文件已轮转: ${path.basename(rotatedPath)}`);
      } catch (error) {
        this.writeLogEntry('ERROR', '日志轮转', `轮转失败: ${error}`);
      }
    }
  }
}

/**
 * 便捷函数：初始化Console日志系统
 */
export async function initializeConsoleLogger(): Promise<ConsoleLogger> {
  const logger = ConsoleLogger.getInstance();
  await logger.initialize();
  return logger;
}