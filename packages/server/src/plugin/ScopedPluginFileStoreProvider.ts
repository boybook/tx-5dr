import path from 'path';
import type { PluginFileStore } from '@tx5dr/plugin-api';

export class ScopedPluginFileStoreProvider implements PluginFileStore {
  constructor(
    private readonly backingStore: PluginFileStore,
    private readonly scopePrefix: string,
  ) {}

  async write(filePath: string, data: Buffer): Promise<void> {
    await this.backingStore.write(this.resolve(filePath), data);
  }

  async read(filePath: string): Promise<Buffer | null> {
    return this.backingStore.read(this.resolve(filePath));
  }

  async delete(filePath: string): Promise<boolean> {
    return this.backingStore.delete(this.resolve(filePath));
  }

  async list(prefix?: string): Promise<string[]> {
    const scopedPrefix = this.resolve(prefix ?? '');
    const files = await this.backingStore.list(scopedPrefix);
    const normalizedScope = `${this.scopePrefix}/`;
    return files
      .filter((filePath) => filePath === this.scopePrefix || filePath.startsWith(normalizedScope))
      .map((filePath) => {
        if (filePath === this.scopePrefix) {
          return '';
        }
        return filePath.slice(normalizedScope.length);
      })
      .filter((filePath) => filePath.length > 0);
  }

  private resolve(filePath: string): string {
    const normalized = path.posix.normalize(filePath || '.');
    if (path.posix.isAbsolute(normalized) || normalized.startsWith('..')) {
      throw new Error(`Path traversal rejected: ${filePath}`);
    }
    if (normalized === '.') {
      return this.scopePrefix;
    }
    return path.posix.join(this.scopePrefix, normalized);
  }
}
