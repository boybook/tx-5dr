import { promises as fs } from 'fs';
import path from 'path';
import { createLogger } from '../utils/logger.js';
import type { FlushableKVStore } from './types.js';

const logger = createLogger('PluginStorage');

/**
 * JSON 文件 KV 存储
 * 写入有 300ms debounce，防止频繁 I/O
 */
export class PluginStorageProvider implements FlushableKVStore {
  private data: Record<string, unknown> = {};
  private filePath: string;
  private saveTimer: NodeJS.Timeout | null = null;
  private loaded = false;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async init(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      this.data = JSON.parse(raw);
    } catch {
      // 文件不存在或解析失败，使用空对象
      this.data = {};
    }
    this.loaded = true;
  }

  get<T = unknown>(key: string, defaultValue?: T): T {
    const val = this.data[key];
    return (val !== undefined ? val : defaultValue) as T;
  }

  set(key: string, value: unknown): void {
    this.data[key] = value;
    this.scheduleSave();
  }

  delete(key: string): void {
    delete this.data[key];
    this.scheduleSave();
  }

  getAll(): Record<string, unknown> {
    return { ...this.data };
  }

  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.persist();
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.persist().catch(err => logger.error('Failed to persist plugin storage', err));
    }, 300);
  }

  private async persist(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (err) {
      logger.error(`Failed to save plugin storage: ${this.filePath}`, err);
    }
  }
}
