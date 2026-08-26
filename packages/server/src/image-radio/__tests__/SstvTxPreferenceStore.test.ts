import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SstvTxPreferenceStore } from '../SstvTxPreferenceStore.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('SstvTxPreferenceStore', () => {
  it('defaults to FSK and persists operators independently', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tx5dr-sstv-preferences-'));
    dirs.push(dir);
    const store = new SstvTxPreferenceStore(dir);
    await store.initialize();
    expect(store.get('op-a')).toMatchObject({
      operatorId: 'op-a', enhancedPreamble: true, stationIdMode: 'fsk', updatedAt: 0,
    });
    await store.save('op-a', { enhancedPreamble: true, stationIdMode: 'cw' });
    await store.save('op-b', { enhancedPreamble: false, stationIdMode: 'none' });

    const restored = new SstvTxPreferenceStore(dir);
    await restored.initialize();
    expect(restored.get('op-a')).toMatchObject({ enhancedPreamble: true, stationIdMode: 'cw' });
    expect(restored.get('op-b')).toMatchObject({ enhancedPreamble: false, stationIdMode: 'none' });
    expect(JSON.parse(await readFile(path.join(dir, 'sstv-tx-preferences.json'), 'utf8')).preferences).toHaveLength(2);
  });
});
