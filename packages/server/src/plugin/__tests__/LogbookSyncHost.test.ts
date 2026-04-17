import { describe, expect, it, vi } from 'vitest';

import type { QSORecord } from '@tx5dr/contracts';
import type { LogbookSyncProvider, SyncUploadOptions, SyncUploadResult } from '@tx5dr/plugin-api';
import { LogbookSyncHost } from '../LogbookSyncHost.js';

function createQso(id: string): QSORecord {
  return {
    id,
    callsign: 'N0CALL',
    frequency: 14_074_000,
    mode: 'FT8',
    startTime: Date.parse('2026-04-17T12:00:00.000Z'),
    endTime: Date.parse('2026-04-17T12:01:00.000Z'),
    messageHistory: [],
    myCallsign: 'BG5DRB',
    myGrid: 'PM01AA',
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

function createProvider(
  uploadImpl?: (callsign: string, options?: SyncUploadOptions) => Promise<SyncUploadResult>,
): LogbookSyncProvider & { upload: ReturnType<typeof vi.fn> } {
  return {
    id: 'wavelog',
    displayName: 'WaveLog',
    settingsPageId: 'settings',
    accessScope: 'operator',
    testConnection: vi.fn(async () => ({ success: true })),
    upload: vi.fn(uploadImpl ?? (async () => ({ uploaded: 1, skipped: 0, failed: 0 }))) as any,
    download: vi.fn(async () => ({ downloaded: 0, matched: 0, updated: 0 })),
    isConfigured: vi.fn(() => true),
    isAutoUploadEnabled: vi.fn(() => true),
  } as LogbookSyncProvider & { upload: ReturnType<typeof vi.fn> };
}

describe('LogbookSyncHost', () => {
  it('passes only the completed QSO record to auto-upload providers', async () => {
    const host = new LogbookSyncHost();
    const provider = createProvider();
    host.register('wavelog-sync', provider);

    const qso = createQso('qso-1');
    host.onQSOComplete('BG5DRB', qso);
    await flushAsyncWork();

    expect(provider.upload).toHaveBeenCalledTimes(1);
    expect(provider.upload).toHaveBeenCalledWith('BG5DRB', {
      trigger: 'auto',
      records: [qso],
    });
  });

  it('buffers later auto-upload QSOs until the current upload finishes', async () => {
    const host = new LogbookSyncHost();
    const firstUpload = deferred<SyncUploadResult>();
    const provider = createProvider(async (_callsign, options) => {
      if (provider.upload.mock.calls.length === 1) {
        return firstUpload.promise;
      }
      return {
        uploaded: options?.records?.length ?? 0,
        skipped: 0,
        failed: 0,
      };
    });
    host.register('wavelog-sync', provider);

    const qso1 = createQso('qso-1');
    const qso2 = createQso('qso-2');

    host.onQSOComplete('BG5DRB', qso1);
    await flushAsyncWork();
    expect(provider.upload).toHaveBeenCalledTimes(1);

    host.onQSOComplete('BG5DRB', qso2);
    host.onQSOComplete('BG5DRB', qso2);
    await flushAsyncWork();
    expect(provider.upload).toHaveBeenCalledTimes(1);

    firstUpload.resolve({ uploaded: 1, skipped: 0, failed: 0 });
    await flushAsyncWork();

    expect(provider.upload).toHaveBeenCalledTimes(2);
    expect(provider.upload.mock.calls[1]?.[1]).toEqual({
      trigger: 'auto',
      records: [qso2],
    });
  });

  it('serializes a manual upload behind the active auto-upload', async () => {
    const host = new LogbookSyncHost();
    const firstUpload = deferred<SyncUploadResult>();
    const provider = createProvider(async () => {
      if (provider.upload.mock.calls.length === 1) {
        return firstUpload.promise;
      }
      return { uploaded: 0, skipped: 0, failed: 0 };
    });
    host.register('wavelog-sync', provider);

    host.onQSOComplete('BG5DRB', createQso('qso-1'));
    await flushAsyncWork();
    expect(provider.upload).toHaveBeenCalledTimes(1);

    const manualPromise = host.upload('wavelog', 'BG5DRB');
    await flushAsyncWork();
    expect(provider.upload).toHaveBeenCalledTimes(1);

    firstUpload.resolve({ uploaded: 1, skipped: 0, failed: 0 });
    await manualPromise;
    await flushAsyncWork();

    expect(provider.upload).toHaveBeenCalledTimes(2);
    expect(provider.upload.mock.calls[1]?.[1]).toEqual({ trigger: 'manual' });
  });
});
