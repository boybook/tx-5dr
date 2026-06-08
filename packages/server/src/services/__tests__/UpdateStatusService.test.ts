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
    vi.doMock('../../generated/buildInfo.js', () => ({
      SERVER_BUILD_INFO: {
        channel: 'nightly',
        version: '1.0.0-nightly.202605181200+abcdef1',
        commit: 'abcdef1234567890',
        commitShort: 'abcdef1',
        buildTimestamp: '2026-05-18T12:00:00Z',
      },
    }));

    const { getSystemUpdateStatus } = await import('../UpdateStatusService.js');
    const status = await getSystemUpdateStatus();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://downloads.example.test/tx-5dr/android-runtime/nightly/latest.json',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(status.distribution).toBe('android-bridge');
    expect(status.target).toBe('android-runtime');
    expect(status.metadataSource).toBe('oss');
    expect(status.currentCommit).toBe('abcdef1');
    expect(status.currentPublishedAt).toBe('2026-05-18T12:00:00Z');
    expect(status.latestCommit).toBe('abcdef1234567890');
    expect(status.updateAvailable).toBe(false);
  });

  it('marks Android runtime nightly as outdated when the remote commit differs', async () => {
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
        commit: '1234567890abcdef',
        commit_title: 'Android runtime nightly',
        published_at: '2026-05-19T00:01:00Z',
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    vi.doMock('../../generated/buildInfo.js', () => ({
      SERVER_BUILD_INFO: {
        channel: 'nightly',
        version: '1.0.0-nightly.202605181200+abcdef1',
        commit: 'abcdef1234567890',
        commitShort: 'abcdef1',
        buildTimestamp: '2026-05-18T12:00:00Z',
      },
    }));

    const { getSystemUpdateStatus } = await import('../UpdateStatusService.js');
    const status = await getSystemUpdateStatus();

    expect(status.target).toBe('android-runtime');
    expect(status.currentCommit).toBe('abcdef1');
    expect(status.latestCommit).toBe('1234567890abcdef');
    expect(status.updateAvailable).toBe(true);
  });
});
