import { describe, expect, it } from 'vitest';
import type { PluginFileStore } from '@tx5dr/plugin-api';
import { ScopedPluginFileStoreProvider } from '../ScopedPluginFileStoreProvider.js';

function createMockFileStore(): PluginFileStore {
  const storage = new Map<string, Buffer>();
  return {
    async write(filePath: string, data: Buffer) {
      storage.set(filePath, data);
    },
    async read(filePath: string) {
      return storage.get(filePath) ?? null;
    },
    async delete(filePath: string) {
      return storage.delete(filePath);
    },
    async list(prefix?: string) {
      const keys = Array.from(storage.keys());
      return prefix ? keys.filter((key) => key.startsWith(prefix)) : keys;
    },
  };
}

describe('ScopedPluginFileStoreProvider', () => {
  it('reads and writes inside the scoped prefix only', async () => {
    const backingStore = createMockFileStore();
    const scopedStore = new ScopedPluginFileStoreProvider(
      backingStore,
      'callsigns/BG4IAJ',
    );

    await scopedStore.write('certificates/a.json', Buffer.from('test', 'utf-8'));

    expect(await backingStore.read('callsigns/BG4IAJ/certificates/a.json'))
      .toEqual(Buffer.from('test', 'utf-8'));
    expect(await scopedStore.read('certificates/a.json'))
      .toEqual(Buffer.from('test', 'utf-8'));
  });

  it('rejects traversal outside the scoped prefix', async () => {
    const backingStore = createMockFileStore();
    const scopedStore = new ScopedPluginFileStoreProvider(
      backingStore,
      'callsigns/BG4IAJ',
    );

    await expect(scopedStore.write('../escape.txt', Buffer.from('x')))
      .rejects
      .toThrow('Path traversal rejected');
  });

  it('lists scope-relative file paths', async () => {
    const backingStore = createMockFileStore();
    await backingStore.write('callsigns/BG4IAJ/a.txt', Buffer.from('a'));
    await backingStore.write('callsigns/BG4IAJ/nested/b.txt', Buffer.from('b'));
    await backingStore.write('callsigns/BG5DRB/other.txt', Buffer.from('c'));

    const scopedStore = new ScopedPluginFileStoreProvider(
      backingStore,
      'callsigns/BG4IAJ',
    );

    expect(await scopedStore.list()).toEqual(['a.txt', 'nested/b.txt']);
  });
});
