import { createLogger } from '../utils/logger.js';
import type { FlushableKVStore } from './types.js';
import { JsonFileStore, PersistenceCoordinator } from '../utils/persistence/index.js';
import { markDetachedPluginData, snapshotPluginData } from './plugin-data-boundary.js';

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
    return (val !== undefined
      ? markDetachedPluginData(snapshotPluginData(val, 'json'))
      : defaultValue) as T;
  }

  set(key: string, value: unknown): void {
    PersistenceCoordinator.getInstance().assertMutationsAllowed(`plugin-storage:${this.filePath}`);
    const clonedEntry = snapshotPluginData({ [key]: value }, 'json');
    if (!Object.prototype.hasOwnProperty.call(clonedEntry, key)) {
      delete this.data[key];
    } else {
      this.data[key] = clonedEntry[key];
    }
    this.scheduleSave();
  }

  update<T = unknown>(
    key: string,
    reducer: (current: T | undefined) => T | undefined,
  ): T | undefined {
    PersistenceCoordinator.getInstance().assertMutationsAllowed(`plugin-storage:${this.filePath}`);
    const current = this.get<T | undefined>(key);
    const next = reducer(current);
    this.set(key, next);
    return this.get<T | undefined>(key);
  }

  delete(key: string): void {
    PersistenceCoordinator.getInstance().assertMutationsAllowed(`plugin-storage:${this.filePath}`);
    delete this.data[key];
    this.scheduleSave();
  }

  getAll(): Record<string, unknown> {
    return markDetachedPluginData(snapshotPluginData(this.data, 'json'));
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
      if (!defer) throw err;
    }
  }

  dispose(): void {
    this.unregisterPersistence?.();
    this.unregisterPersistence = null;
  }
}

interface SharedStorageEntry {
  provider: PluginStorageProvider;
  ready: Promise<void>;
  references: number;
}

const sharedStorageProviders = new Map<string, SharedStorageEntry>();

class SharedPluginStorageLease implements FlushableKVStore {
  private released = false;

  constructor(
    private readonly filePath: string,
    private readonly provider: PluginStorageProvider,
  ) {}

  get<T = unknown>(key: string, defaultValue?: T): T {
    return this.provider.get(key, defaultValue);
  }

  set(key: string, value: unknown): void {
    this.provider.set(key, value);
  }

  update<T = unknown>(key: string, reducer: (current: T | undefined) => T | undefined): T | undefined {
    return this.provider.update(key, reducer);
  }

  delete(key: string): void {
    this.provider.delete(key);
  }

  getAll(): Record<string, unknown> {
    return this.provider.getAll();
  }

  flush(): Promise<void> {
    return this.provider.flush();
  }

  dispose(): void {
    if (this.released) return;
    this.released = true;
    const entry = sharedStorageProviders.get(this.filePath);
    if (!entry || entry.provider !== this.provider) return;
    entry.references -= 1;
    if (entry.references > 0) return;
    entry.provider.dispose();
    sharedStorageProviders.delete(this.filePath);
  }
}

/** Acquires one process-wide store for a plugin global-storage file. */
export async function acquireSharedPluginStorage(filePath: string): Promise<FlushableKVStore> {
  let entry = sharedStorageProviders.get(filePath);
  if (!entry) {
    const provider = new PluginStorageProvider(filePath);
    entry = { provider, ready: provider.init(), references: 0 };
    sharedStorageProviders.set(filePath, entry);
  }
  entry.references += 1;
  try {
    await entry.ready;
    return new SharedPluginStorageLease(filePath, entry.provider);
  } catch (error) {
    entry.references -= 1;
    if (entry.references === 0) sharedStorageProviders.delete(filePath);
    throw error;
  }
}
