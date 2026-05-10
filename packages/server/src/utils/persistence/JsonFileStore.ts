import { SafeFileWriter, loadJsonWithRecovery, type SafeWriteOptions } from './SafeFileWriter.js';

export interface JsonFileStoreOptions<T> {
  defaultValue: () => T;
  validate?: (value: unknown) => T;
  backups?: number;
  debounceMs?: number;
  mode?: number;
  createIfMissing?: boolean;
}

export class JsonFileStore<T> {
  private readonly writer: SafeFileWriter;
  private value: T | null = null;
  private lastSerialized = '';
  private saveTimer: NodeJS.Timeout | null = null;
  private pendingSave: Promise<void> | null = null;

  constructor(
    private readonly filePath: string,
    private readonly options: JsonFileStoreOptions<T>,
  ) {
    this.writer = new SafeFileWriter({ backups: options.backups ?? 3, mode: options.mode });
  }

  async load(): Promise<T> {
    const loaded = await loadJsonWithRecovery(this.filePath, {
      defaultValue: this.options.defaultValue,
      validate: this.options.validate ?? ((value) => value as T),
      writer: this.writer,
      backups: this.options.backups ?? 3,
      createIfMissing: this.options.createIfMissing,
    });
    this.value = loaded.value;
    this.lastSerialized = loaded.serialized || `${JSON.stringify(loaded.value, null, 2)}\n`;
    return loaded.value;
  }

  get(): T {
    if (this.value === null) {
      throw new Error(`JsonFileStore not loaded: ${this.filePath}`);
    }
    return this.value;
  }

  set(value: T, options: { defer?: boolean } = {}): Promise<void> {
    this.value = value;
    const shouldDefer = options.defer === true || (options.defer !== false && this.options.debounceMs);
    if (shouldDefer) {
      this.scheduleSave();
      return Promise.resolve();
    }
    return this.saveNow();
  }

  update(mutator: (value: T) => T | void, options: { defer?: boolean } = {}): Promise<void> {
    const current = this.get();
    const next = mutator(current) ?? current;
    return this.set(next, options);
  }

  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.saveNow();
    await this.writer.flush();
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow().catch(() => undefined);
    }, this.options.debounceMs ?? 0);
  }

  private async saveNow(): Promise<void> {
    if (this.value === null) return;
    if (this.pendingSave) {
      await this.pendingSave;
      if (this.value === null) return;
    }

    const serialized = `${JSON.stringify(this.value, null, 2)}\n`;
    if (serialized === this.lastSerialized) return;

    const writeOptions: SafeWriteOptions = {
      backups: this.options.backups ?? 3,
      mode: this.options.mode,
    };

    this.pendingSave = this.writer.writeFile(this.filePath, serialized, writeOptions)
      .then(() => {
        this.lastSerialized = serialized;
      })
      .finally(() => {
        this.pendingSave = null;
      });

    await this.pendingSave;
  }
}
