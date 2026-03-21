/* eslint-disable @typescript-eslint/no-explicit-any */
// SlotPackPersistence - JSON序列化需要使用any

import { promises as fs } from 'fs';
import { join } from 'path';
import type { SlotPack } from '@tx5dr/contracts';
import { tx5drPaths } from '../utils/app-paths.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('SlotPackPersistence');

/**
 * SlotPack持久化存储接口
 */
export interface SlotPackStorageRecord {
  /** 存储时间戳 */
  storedAt: number;
  /** 操作类型 */
  operation: 'updated' | 'created';
  /** SlotPack数据 */
  slotPack: SlotPack;
  /** 存储时的模式信息 */
  mode?: string;
  /** 存储版本（用于格式升级） */
  version: string;
}

/**
 * SlotPack持久化管理器
 * 使用JSON Lines格式存储数据，按日期分文件
 */
export class SlotPackPersistence {
  private currentDateStr: string | null = null;
  private currentFileHandle: fs.FileHandle | null = null;
  private isWriting = false;
  private writeQueue: SlotPackStorageRecord[] = [];
  private readonly maxRetries = 3;
  private readonly version = '1.0.0';

  constructor() {}

  /**
   * 存储SlotPack数据
   */
  async store(slotPack: SlotPack, operation: 'updated' | 'created' = 'updated', mode?: string): Promise<void> {
    const record: SlotPackStorageRecord = {
      storedAt: Date.now(),
      operation,
      slotPack: { ...slotPack }, // 深拷贝避免引用问题
      mode,
      version: this.version
    };

    // 添加到写入队列
    this.writeQueue.push(record);
    
    // 异步处理写入队列
    this.processWriteQueue().catch(error => {
      console.error('[SlotPackPersistence] Failed to process write queue:', error);
    });
  }

  /**
   * 处理写入队列
   */
  private async processWriteQueue(): Promise<void> {
    if (this.isWriting || this.writeQueue.length === 0) {
      return;
    }

    this.isWriting = true;

    try {
      while (this.writeQueue.length > 0) {
        const record = this.writeQueue.shift();
        if (record) {
          await this.writeRecord(record);
        }
      }
    } catch (error) {
      console.error('[SlotPackPersistence] Batch write failed:', error);
    } finally {
      this.isWriting = false;
    }
  }

  /**
   * 写入单条记录
   */
  private async writeRecord(record: SlotPackStorageRecord, retryCount = 0): Promise<void> {
    try {
      // 确保文件句柄有效
      await this.ensureFileHandle(record.storedAt);
      
      if (!this.currentFileHandle) {
        throw new Error('无法获取文件句柄');
      }

      // 转换为JSON Lines格式（每行一个JSON对象）
      const jsonLine = JSON.stringify(record) + '\n';
      
      // 写入文件
      await this.currentFileHandle.write(jsonLine, null, 'utf8');
      
      // 强制刷新到磁盘（确保数据不丢失）
      await this.currentFileHandle.sync();

      const dataSizeKB = (Buffer.byteLength(jsonLine, 'utf8') / 1024).toFixed(2);
      logger.info(`Saved: ${record.slotPack.slotId} (${record.operation}, ${record.slotPack.frames.length} frames, ${dataSizeKB}KB)`);

    } catch (error) {
      console.error(`[SlotPackPersistence] Write failed (attempt ${retryCount + 1}/${this.maxRetries}):`, error);
      
      // 关闭可能有问题的文件句柄
      await this.closeCurrentFile();
      
      // 重试机制
      if (retryCount < this.maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1))); // 指数退避
        await this.writeRecord(record, retryCount + 1);
      } else {
        console.error('[SlotPackPersistence] Max retries reached, dropping data:', record.slotPack.slotId);
      }
    }
  }

  /**
   * 确保文件句柄有效（按日期轮转文件）
   */
  private async ensureFileHandle(timestamp: number): Promise<void> {
    const dateStr = this.getDateString(timestamp);
    
    // 如果日期没有变化且文件句柄有效，直接返回
    if (this.currentDateStr === dateStr && this.currentFileHandle) {
      return;
    }
    
    // 关闭当前文件句柄
    await this.closeCurrentFile();
    
    // 打开新的文件
    try {
      const filePath = await this.getFilePath(dateStr);
      
      // 确保目录存在
      const dirPath = join(filePath, '..');
      await fs.mkdir(dirPath, { recursive: true });
      
      // 打开文件（追加模式）
      this.currentFileHandle = await fs.open(filePath, 'a');
      this.currentDateStr = dateStr;
      
      logger.info(`Opened storage file: ${filePath}`);

    } catch (error) {
      console.error('[SlotPackPersistence] Cannot open file:', error);
      throw error;
    }
  }

  /**
   * 关闭当前文件句柄
   */
  private async closeCurrentFile(): Promise<void> {
    if (this.currentFileHandle) {
      try {
        await this.currentFileHandle.close();
        logger.info(`Closed file: ${this.currentDateStr}`);
      } catch (error) {
        console.error('[SlotPackPersistence] Failed to close file:', error);
      } finally {
        this.currentFileHandle = null;
        this.currentDateStr = null;
      }
    }
  }

  /**
   * 获取日期字符串 (YYYY-MM-DD)
   */
  private getDateString(timestamp: number): string {
    const date = new Date(timestamp);
    return date.toISOString().split('T')[0]; // YYYY-MM-DD
  }

  /**
   * 获取存储文件路径
   */
  private async getFilePath(dateStr: string): Promise<string> {
    const dataDir = await tx5drPaths.getDataDir();
    const logsDir = join(dataDir, 'frames-logs');
    return join(logsDir, `frames-${dateStr}.jsonl`);
  }

  /**
   * 获取存储统计信息
   */
  async getStorageStats(): Promise<{
    currentFile: string | null;
    queueSize: number;
    isWriting: boolean;
    currentDate: string | null;
  }> {
    let currentFilePath: string | null = null;
    
    if (this.currentDateStr) {
      try {
        currentFilePath = await this.getFilePath(this.currentDateStr);
      } catch (error) {
        console.error('[SlotPackPersistence] Failed to get current file path:', error);
      }
    }
    
    return {
      currentFile: currentFilePath,
      queueSize: this.writeQueue.length,
      isWriting: this.isWriting,
      currentDate: this.currentDateStr
    };
  }

  /**
   * 手动强制刷新缓冲区
   */
  async flush(): Promise<void> {
    if (this.currentFileHandle) {
      try {
        await this.currentFileHandle.sync();
        logger.info('Forced flush complete');
      } catch (error) {
        console.error('[SlotPackPersistence] Forced flush failed:', error);
      }
    }
    
    // 处理剩余的写入队列
    await this.processWriteQueue();
  }

  /**
   * 清理资源
   */
  async cleanup(): Promise<void> {
    logger.info('Cleaning up resources');
    
    // 处理剩余的写入队列
    await this.processWriteQueue();
    
    // 关闭文件句柄
    await this.closeCurrentFile();
    
    // 清空队列
    this.writeQueue.length = 0;
    
    logger.info('Resource cleanup complete');
  }

  /**
   * 读取指定日期的存储记录（用于数据恢复或分析）
   */
  async readRecords(dateStr: string): Promise<SlotPackStorageRecord[]> {
    try {
      const filePath = await this.getFilePath(dateStr);
      const content = await fs.readFile(filePath, 'utf8');
      
      const records: SlotPackStorageRecord[] = [];
      const lines = content.trim().split('\n');
      
      for (const line of lines) {
        if (line.trim()) {
          try {
            const record = JSON.parse(line) as SlotPackStorageRecord;
            records.push(record);
          } catch (error) {
            logger.warn(`Skipping corrupted line: ${line.substring(0, 100)}...`);
          }
        }
      }
      
      logger.info(`Read ${records.length} records for ${dateStr}`);
      return records;

    } catch (error) {
      if ((error as any).code === 'ENOENT') {
        logger.info(`No file found for date ${dateStr}`);
        return [];
      }
      console.error('[SlotPackPersistence] Failed to read records:', error);
      throw error;
    }
  }

  /**
   * 获取可用的存储日期列表
   */
  async getAvailableDates(): Promise<string[]> {
    try {
      const dataDir = await tx5drPaths.getDataDir();
      const logsDir = join(dataDir, 'ft8-logs');
      
      try {
        const files = await fs.readdir(logsDir);
        const dates = files
          .filter(file => file.startsWith('ft8-decodes-') && file.endsWith('.jsonl'))
          .map(file => file.replace('ft8-decodes-', '').replace('.jsonl', ''))
          .sort();
        
        return dates;
      } catch (error) {
        if ((error as any).code === 'ENOENT') {
          return [];
        }
        throw error;
      }
    } catch (error) {
      console.error('[SlotPackPersistence] Failed to get available dates:', error);
      return [];
    }
  }
} 