import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';

import { ImageComposerBackgroundStore } from '../ImageComposerBackgroundStore.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('ImageComposerBackgroundStore', () => {
  it('persists and restores the latest background independently per operator', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tx5dr-composer-background-'));
    dirs.push(dir);
    const store = new ImageComposerBackgroundStore(dir);
    const first = PNG.sync.write(new PNG({ width: 3, height: 2 }));
    const second = PNG.sync.write(new PNG({ width: 2, height: 4 }));

    await store.save('operator-a', first);
    await store.save('operator-b', second);

    const restored = new ImageComposerBackgroundStore(dir);
    await restored.initialize();
    expect(restored.get('operator-a')).toMatchObject({ operatorId: 'operator-a', width: 3, height: 2 });
    expect(restored.get('operator-b')).toMatchObject({ operatorId: 'operator-b', width: 2, height: 4 });
    expect(PNG.sync.read(await restored.read('operator-a'))).toMatchObject({ width: 3, height: 2 });
  });

  it('rejects hostile dimensions before PNG decompression', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tx5dr-composer-background-'));
    dirs.push(dir);
    const store = new ImageComposerBackgroundStore(dir);
    const png = PNG.sync.write(new PNG({ width: 2, height: 2 }));
    png.writeUInt32BE(100_000, 16);

    await expect(store.save('operator-a', png)).rejects.toThrow('IMAGE_COMPOSER_BACKGROUND_DIMENSIONS');
  });
});
