import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PluginStorageProvider } from '../PluginStorageProvider.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('PluginStorageProvider', () => {
  it('persists data into the dedicated plugin-data directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tx5dr-plugin-storage-'));
    tempDirs.push(root);

    const stateFile = join(root, 'plugin-data', 'example-plugin', 'global.json');
    const storage = new PluginStorageProvider(stateFile);

    await storage.init();
    storage.set('count', 3);
    await storage.flush();

    expect(storage.get('count', 0)).toBe(3);
    expect(JSON.parse(await readFile(stateFile, 'utf-8'))).toEqual({ count: 3 });
  });

  it('isolates stored values from caller-owned references', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tx5dr-plugin-storage-'));
    tempDirs.push(root);

    const stateFile = join(root, 'global.json');
    const storage = new PluginStorageProvider(stateFile);
    await storage.init();

    const input = { nested: { count: 1 }, omitted: undefined, invalidNumber: Number.NaN };
    storage.set('config', input);
    storage.set('removed', { stale: true });
    storage.set('removed', undefined);
    input.nested.count = 2;
    await storage.flush();

    expect(storage.get('config')).toEqual({ nested: { count: 1 }, invalidNumber: null });
    expect(storage.getAll()).toEqual({ config: { nested: { count: 1 }, invalidNumber: null } });
    expect(JSON.parse(await readFile(stateFile, 'utf-8'))).toEqual({
      config: { nested: { count: 1 }, invalidNumber: null },
    });
  });

  it('returns independent snapshots from get and getAll', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tx5dr-plugin-storage-'));
    tempDirs.push(root);

    const storage = new PluginStorageProvider(join(root, 'global.json'));
    await storage.init();
    storage.set('config', { nested: { count: 1 } });

    const value = storage.get<{ nested: { count: number } }>('config');
    value.nested.count = 2;
    expect(storage.get('config')).toEqual({ nested: { count: 1 } });

    const all = storage.getAll() as { config: { nested: { count: number } } };
    all.config.nested.count = 3;
    expect(storage.getAll()).toEqual({ config: { nested: { count: 1 } } });
  });

  it('returns a missing key default without cloning it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tx5dr-plugin-storage-'));
    tempDirs.push(root);

    const storage = new PluginStorageProvider(join(root, 'global.json'));
    await storage.init();

    const defaultValue = { nested: { count: 1 } };
    expect(storage.get('missing', defaultValue)).toBe(defaultValue);
  });
});
