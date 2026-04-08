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
});
