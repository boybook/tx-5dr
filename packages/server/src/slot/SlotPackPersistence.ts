import { promises as fs } from 'fs';
import { join } from 'path';
import type { SlotPack } from '@tx5dr/contracts';
import { tx5drPaths } from '../utils/app-paths.js';

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
      console.error('💾 [SlotPack存储] 处理写入队列失败:', error);
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
      console.error('💾 [SlotPack存储] 批量写入失败:', error);
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

      // 计算数据大小用于日志
      const dataSizeKB = (Buffer.byteLength(jsonLine, 'utf8') / 1024).toFixed(2);
      
      console.log(`💾 [SlotPack存储] 已保存: ${record.slotPack.slotId} (${record.operation}, ${record.slotPack.frames.length}帧, ${dataSizeKB}KB)`);
      
    } catch (error) {
      console.error(`💾 [SlotPack存储] 写入失败 (尝试 ${retryCount + 1}/${this.maxRetries}):`, error);
      
      // 关闭可能有问题的文件句柄
      await this.closeCurrentFile();
      
      // 重试机制
      if (retryCount < this.maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1))); // 指数退避
        await this.writeRecord(record, retryCount + 1);
      } else {
        console.error(`💾 [SlotPack存储] 达到最大重试次数，丢弃数据:`, record.slotPack.slotId);
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
      
      console.log(`💾 [SlotPack存储] 打开存储文件: ${filePath}`);
      
    } catch (error) {
      console.error(`💾 [SlotPack存储] 无法打开文件:`, error);
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
        console.log(`💾 [SlotPack存储] 已关闭文件: ${this.currentDateStr}`);
      } catch (error) {
        console.error(`💾 [SlotPack存储] 关闭文件失败:`, error);
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
        console.error('获取当前文件路径失败:', error);
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
        console.log(`💾 [SlotPack存储] 强制刷新完成`);
      } catch (error) {
        console.error(`💾 [SlotPack存储] 强制刷新失败:`, error);
      }
    }
    
    // 处理剩余的写入队列
    await this.processWriteQueue();
  }

  /**
   * 清理资源
   */
  async cleanup(): Promise<void> {
    console.log('💾 [SlotPack存储] 正在清理资源...');
    
    // 处理剩余的写入队列
    await this.processWriteQueue();
    
    // 关闭文件句柄
    await this.closeCurrentFile();
    
    // 清空队列
    this.writeQueue.length = 0;
    
    console.log('💾 [SlotPack存储] 资源清理完成');
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
            console.warn(`💾 [SlotPack存储] 跳过损坏的行: ${line.substring(0, 100)}...`);
          }
        }
      }
      
      console.log(`💾 [SlotPack存储] 读取 ${dateStr} 的记录: ${records.length} 条`);
      return records;
      
    } catch (error) {
      if ((error as any).code === 'ENOENT') {
        console.log(`💾 [SlotPack存储] 日期 ${dateStr} 的文件不存在`);
        return [];
      }
      console.error(`💾 [SlotPack存储] 读取记录失败:`, error);
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
      console.error('💾 [SlotPack存储] 获取可用日期失败:', error);
      return [];
    }
  }
} 