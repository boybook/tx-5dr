/* eslint-disable @typescript-eslint/no-explicit-any */
import * as fs from 'fs/promises';
import * as path from 'path';
import { getLogFilePath } from './app-paths.js';

/**
 * File logger with console interception.
 * Overrides console.* methods to write all output to a local log file,
 * while passing through to the original console unchanged.
 * Level filtering is handled upstream by createLogger — this layer only persists.
 */
export class ConsoleLogger {
  private static instance: ConsoleLogger | null = null;
  private logFilePath: string = '';
  private isInitialized: boolean = false;
  private logQueue: string[] = [];
  private isWriting: boolean = false;

  // Keep references to original console methods to avoid infinite recursion
  private readonly originalConsole = {
    log:   console.log.bind(console),
    error: console.error.bind(console),
    warn:  console.warn.bind(console),
    info:  console.info.bind(console),
    debug: console.debug.bind(console),
  };

  private constructor() {}

  static getInstance(): ConsoleLogger {
    if (!ConsoleLogger.instance) {
      ConsoleLogger.instance = new ConsoleLogger();
    }
    return ConsoleLogger.instance;
  }

  /**
   * Initialize: resolve log file path, ensure file exists, install console override.
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    this.logFilePath = await getLogFilePath('tx5dr-server.log');
    await this.ensureLogFile();
    this.overrideConsole();
    this.isInitialized = true;
    this.writeLogEntry('INFO', 'FileLogger', 'Log system initialized, file: ' + this.logFilePath);
  }

  private async ensureLogFile(): Promise<void> {
    try {
      await fs.access(this.logFilePath);
    } catch {
      const dir = path.dirname(this.logFilePath);
      await fs.mkdir(dir, { recursive: true });
      const header = this.formatLogEntry('INFO', 'FileLogger', 'TX-5DR Server log file created');
      await fs.writeFile(this.logFilePath, header + '\n', 'utf-8');
    }
  }

  /**
   * Override console methods to intercept output for file writing.
   * No level filtering here — filtering is done by createLogger upstream.
   */
  private overrideConsole(): void {
    const self = this;
    const orig = this.originalConsole;

    console.log = (...args: any[]) => {
      orig.log(...args);
      self.writeLogEntry('INFO', 'console', self.formatArgs(args));
    };
    console.debug = (...args: any[]) => {
      orig.debug(...args);
      self.writeLogEntry('DEBUG', 'console', self.formatArgs(args));
    };
    console.warn = (...args: any[]) => {
      orig.warn(...args);
      self.writeLogEntry('WARN', 'console', self.formatArgs(args));
    };
    console.error = (...args: any[]) => {
      orig.error(...args);
      self.writeLogEntry('ERROR', 'console', self.formatArgs(args));
    };
    console.info = (...args: any[]) => {
      orig.info(...args);
      self.writeLogEntry('INFO', 'console', self.formatArgs(args));
    };
  }

  /**
   * Restore original console methods (called on process exit).
   */
  restore(): void {
    console.log   = this.originalConsole.log;
    console.error = this.originalConsole.error;
    console.warn  = this.originalConsole.warn;
    console.info  = this.originalConsole.info;
    console.debug = this.originalConsole.debug;
    this.writeLogEntry('INFO', 'FileLogger', 'Console restored, log system shutting down');
    this.isInitialized = false;
  }

  private formatArgs(args: any[]): string {
    return args.map(arg => {
      if (typeof arg === 'object' && arg !== null) {
        try { return JSON.stringify(arg); } catch { return String(arg); }
      }
      return String(arg);
    }).join(' ');
  }

  private formatLogEntry(level: string, category: string, message: string): string {
    const timestamp = new Date().toISOString();
    return `[${timestamp}] [${level.padEnd(5)}] [${category.padEnd(20)}] ${message}`;
  }

  private writeLogEntry(level: string, category: string, message: string): void {
    if (!this.isInitialized) return;
    const logEntry = this.formatLogEntry(level, category, message);
    this.logQueue.push(logEntry);
    this.processLogQueue();
  }

  private async processLogQueue(): Promise<void> {
    if (this.isWriting || this.logQueue.length === 0) return;
    this.isWriting = true;
    try {
      const entries = this.logQueue.splice(0);
      await fs.appendFile(this.logFilePath, entries.join('\n') + '\n', 'utf-8');
    } catch (error) {
      this.originalConsole.error('[FileLogger] Failed to write log:', error);
    } finally {
      this.isWriting = false;
      if (this.logQueue.length > 0) setImmediate(() => this.processLogQueue());
    }
  }

  /**
   * Direct file write (used for internal FileLogger messages only).
   */
  writeLog(level: 'INFO' | 'ERROR' | 'WARN' | 'DEBUG', category: string, message: string): void {
    this.writeLogEntry(level, category, message);
  }

  getLogFilePath(): string { return this.logFilePath; }

  async getLogFileSize(): Promise<number> {
    try { return (await fs.stat(this.logFilePath)).size; } catch { return 0; }
  }

  async cleanupOldLogs(daysToKeep: number = 7): Promise<void> {
    try {
      const logDir = path.dirname(this.logFilePath);
      const files = await fs.readdir(logDir);
      const cutoffTime = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);
      for (const file of files.filter(f => f.startsWith('tx5dr-server') && f.endsWith('.log'))) {
        const filePath = path.join(logDir, file);
        try {
          const stats = await fs.stat(filePath);
          if (stats.mtime.getTime() < cutoffTime) {
            await fs.unlink(filePath);
            this.writeLogEntry('INFO', 'FileLogger', `Deleted old log file: ${file}`);
          }
        } catch (error) {
          this.writeLogEntry('WARN', 'FileLogger', `Failed to delete log file: ${file}, ${error}`);
        }
      }
    } catch (error) {
      this.writeLogEntry('ERROR', 'FileLogger', `Log cleanup error: ${error}`);
    }
  }

  async rotateLogIfNeeded(maxSizeBytes: number = 10 * 1024 * 1024): Promise<void> {
    if ((await this.getLogFileSize()) <= maxSizeBytes) return;
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:-]/g, '');
    const rotatedPath = this.logFilePath.replace('.log', `_${timestamp}.log`);
    try {
      await fs.rename(this.logFilePath, rotatedPath);
      await this.ensureLogFile();
      this.writeLogEntry('INFO', 'FileLogger', `Log rotated to: ${path.basename(rotatedPath)}`);
    } catch (error) {
      this.writeLogEntry('ERROR', 'FileLogger', `Log rotation failed: ${error}`);
    }
  }
}

export async function initializeConsoleLogger(): Promise<ConsoleLogger> {
  const logger = ConsoleLogger.getInstance();
  await logger.initialize();
  return logger;
}
