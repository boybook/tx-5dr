import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ImageTemplateStore } from '../ImageTemplateStore.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const layer = {
  id: 'call', text: '{MYCALL}', x: 0.1, y: 0.1, width: 0.8, height: 0.2,
  fontSize: 0.1, color: '#ffffff', strokeWidth: 0.12, align: 'center' as const, rotation: 0,
};

describe('ImageTemplateStore', () => {
  it('scopes identical template ids to their owning operator', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tx5dr-image-template-'));
    dirs.push(dir);
    const store = new ImageTemplateStore(dir);
    await store.save('operator-a', { id: 'shared-id', name: 'A', layers: [layer] });
    await store.save('operator-b', { id: 'shared-id', name: 'B', layers: [layer] });
    await store.save('operator-a', { id: 'shared-id', name: 'A updated', layers: [layer] });

    expect(store.list('operator-a').find((item) => item.id === 'shared-id')?.name).toBe('A updated');
    expect(store.list('operator-b').find((item) => item.id === 'shared-id')?.name).toBe('B');
  });
});
