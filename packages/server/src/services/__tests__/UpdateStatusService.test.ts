import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('UpdateStatusService', () => {
  it('checks the Android runtime manifest when Android bridge flavor is active', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'tx5dr-android-runtime-'));
    process.env = {
      ...originalEnv,
      TX5DR_RUNTIME_FLAVOR: 'android-bridge',
      TX5DR_DATA_DIR: dataDir,
      TX5DR_DOWNLOAD_BASE_URL: 'https://downloads.example.test/',
    };

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        version: '1.0.0-nightly.202605190001',
        commit: 'abcdef1234567890',
        commit_title: 'Android runtime nightly',
        published_at: '2026-05-19T00:01:00Z',
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const { getSystemUpdateStatus } = await import('../UpdateStatusService.js');
    const status = await getSystemUpdateStatus();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://downloads.example.test/tx-5dr/android-runtime/nightly/latest.json',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(status.distribution).toBe('android-bridge');
    expect(status.target).toBe('android-runtime');
    expect(status.metadataSource).toBe('oss');
    expect(status.latestCommit).toBe('abcdef1234567890');
  });
});
