import { createLogger } from '../utils/logger.js';
import type { FlushableKVStore } from './types.js';
import { JsonFileStore, PersistenceCoordinator } from '../utils/persistence/index.js';

const logger = createLogger('PluginStorage');

/**
 * JSON 文件 KV 存储
 * 写入有 300ms debounce，防止频繁 I/O
 */
export class PluginStorageProvider implements FlushableKVStore {
  private data: Record<string, unknown> = {};
  private filePath: string;
  private store: JsonFileStore<Record<string, unknown>> | null = null;
  private loaded = false;
  private unregisterPersistence: (() => void) | null = null;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async init(): Promise<void> {
    if (this.loaded) return;
    this.store = new JsonFileStore<Record<string, unknown>>(this.filePath, {
      defaultValue: () => ({}),
      validate: (value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('plugin storage root must be an object');
        }
        return value as Record<string, unknown>;
      },
      backups: 3,
      debounceMs: 300,
    });
    this.data = await this.store.load();
    this.unregisterPersistence = PersistenceCoordinator.getInstance().register({
      name: `plugin-storage:${this.filePath}`,
      flush: async () => this.flush(),
    });
    this.loaded = true;
  }

  get<T = unknown>(key: string, defaultValue?: T): T {
    const val = this.data[key];
    return (val !== undefined ? val : defaultValue) as T;
  }

  set(key: string, value: unknown): void {
    PersistenceCoordinator.getInstance().assertMutationsAllowed(`plugin-storage:${this.filePath}`);
    this.data[key] = value;
    this.scheduleSave();
  }

  delete(key: string): void {
    PersistenceCoordinator.getInstance().assertMutationsAllowed(`plugin-storage:${this.filePath}`);
    delete this.data[key];
    this.scheduleSave();
  }

  getAll(): Record<string, unknown> {
    return { ...this.data };
  }

  async flush(): Promise<void> {
    await this.persist(false);
  }

  private scheduleSave(): void {
    this.persist(true).catch(err => logger.error('Failed to persist plugin storage', err));
  }

  private async persist(defer: boolean): Promise<void> {
    try {
      if (!this.store) return;
      await this.store.set(this.data, { defer });
    } catch (err) {
      logger.error(`Failed to save plugin storage: ${this.filePath}`, err);
    }
  }

  dispose(): void {
    this.unregisterPersistence?.();
    this.unregisterPersistence = null;
  }
}
