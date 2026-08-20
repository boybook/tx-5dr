import { describe, expect, it, vi } from 'vitest';

import type { QSORecord } from '@tx5dr/contracts';
import type { LogbookSyncProvider, SyncUploadOptions, SyncUploadResult } from '@tx5dr/plugin-api';
import { LogbookSyncHost, type LogbookSyncProviderOwner } from '../LogbookSyncHost.js';

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

function createOwner(generation = 1): LogbookSyncProviderOwner & { active: boolean } {
  return {
    generation,
    active: true,
    isCurrent() {
      return this.active;
    },
    async invoke(_operation, callback) {
      if (!this.active) throw new Error('PLUGIN_INVOCATION_EXPIRED');
      return callback();
    },
    invokeSync(_operation, callback) {
      if (!this.active) throw new Error('PLUGIN_INVOCATION_EXPIRED');
      return callback();
    },
  };
}

describe('LogbookSyncHost', () => {
  it('returns structured failures when a provider is not registered', async () => {
    const host = new LogbookSyncHost();

    await expect(host.upload('missing', 'BG5DRB')).resolves.toMatchObject({
      failures: [
        expect.objectContaining({
          code: 'sync_provider_not_found',
          message: 'Provider not found: missing',
          providerId: 'missing',
          operation: 'upload',
        }),
      ],
    });
    await expect(host.download('missing', 'BG5DRB')).resolves.toMatchObject({
      failures: [
        expect.objectContaining({
          code: 'sync_provider_not_found',
          providerId: 'missing',
          operation: 'download',
        }),
      ],
    });
  });

  it('passes only the completed QSO record to auto-upload providers', async () => {
    const host = new LogbookSyncHost();
    const provider = createProvider();
    host.register('wavelog-sync', provider, createOwner());

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
    host.register('wavelog-sync', provider, createOwner());

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
    host.register('wavelog-sync', provider, createOwner());

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

  it('does not run queued provider work after its plugin generation is revoked', async () => {
    const host = new LogbookSyncHost();
    const firstUpload = deferred<SyncUploadResult>();
    const provider = createProvider(async () => firstUpload.promise);
    const owner = createOwner(7);
    host.register('wavelog-sync', provider, owner);

    host.onQSOComplete('BG5DRB', createQso('qso-1'));
    await flushAsyncWork();
    host.onQSOComplete('BG5DRB', createQso('qso-2'));
    await flushAsyncWork();
    expect(provider.upload).toHaveBeenCalledTimes(1);

    owner.active = false;
    host.unregisterByPlugin('wavelog-sync', 7);
    firstUpload.resolve({ uploaded: 1, skipped: 0, failed: 0 });
    await flushAsyncWork();

    expect(provider.upload).toHaveBeenCalledTimes(1);
    expect(host.getProviderInfo('wavelog')).toBeNull();
  });
});
