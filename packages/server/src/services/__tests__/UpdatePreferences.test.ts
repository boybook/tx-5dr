import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { it, expect, vi } from 'vitest';
it('persists a channel, recovers a damaged file, and rejects invalid writes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tx5dr-update-prefs-'));
  vi.doMock('../../utils/app-paths.js', () => ({ tx5drPaths: { getConfigDir: async () => directory } }));
  try {
    const { getUpdatePreferences, setUpdatePreferences } = await import('../UpdatePreferences.js');
    await setUpdatePreferences({ channel: 'release' });
    expect((await getUpdatePreferences()).channel).toBe('release');
    await expect(setUpdatePreferences({ channel: 'preview' })).rejects.toThrow();
    expect((await getUpdatePreferences()).channel).toBe('release');
    await setUpdatePreferences({ channel: 'nightly' });
    await writeFile(path.join(directory, 'update-preferences.json'), '{broken');
    expect((await getUpdatePreferences()).channel).toBe('release');
    expect(JSON.parse(await readFile(path.join(directory, 'update-preferences.json'), 'utf8')).channel).toBe('release');
  } finally { vi.doUnmock('../../utils/app-paths.js'); vi.resetModules(); await rm(directory, { recursive: true, force: true }); }
});
