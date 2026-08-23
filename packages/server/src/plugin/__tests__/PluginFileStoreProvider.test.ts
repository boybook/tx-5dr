import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PluginFileStoreProvider } from '../PluginFileStoreProvider.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('PluginFileStoreProvider data ownership', () => {
  it('copies buffers at both write and read boundaries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tx5dr-plugin-files-'));
    tempDirs.push(root);
    const store = new PluginFileStoreProvider(root);
    const input = Buffer.from('original');

    const write = store.write('state/value.bin', input);
    input.fill(0);
    await write;

    const first = await store.read('state/value.bin');
    expect(Buffer.isBuffer(first)).toBe(true);
    expect(first?.toString()).toBe('original');
    first?.fill(1);
    const second = await store.read('state/value.bin');
    expect(second?.toString()).toBe('original');
  });
});
