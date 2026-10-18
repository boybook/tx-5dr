import { describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { QSORecord } from '@tx5dr/contracts';
import type { LogbookSyncProvider, SyncUploadOptions, SyncUploadResult } from '@tx5dr/plugin-api';
import { LogbookSyncHost, type LogbookSyncProviderOwner } from '../LogbookSyncHost.js';
import { resolvePluginPaths } from '../paths.js';

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
  it('validates neutral page actions and projects declared dialog sizes by value', () => {
    const host = new LogbookSyncHost(); const provider = createProvider();
    Object.assign(provider, { actions: [{ id: 'run', label: 'Run', pageId: 'progress', pageParams: { intent: 'start' } }] });
    host.register('generic-fixture', provider, createOwner(), [{ id: 'progress', title: 'Progress', entry: 'progress.html', dialogSize: '3xl', accessScope: 'admin', resourceBinding: 'none' }]);
    const info = host.getProviderInfo(provider.id)!;
    expect(info.pageDialogSizes).toEqual({ progress: '3xl' });
    info.actions![0]!.pageParams!.intent = 'inspect';
    expect(host.getProviderInfo(provider.id)!.actions![0]!.pageParams!.intent).toBe('start');
    provider.actions![0]!.pageParams = { callsign: 'override' };
    const invalidHost = new LogbookSyncHost();
    const invalidProvider = { ...createProvider(), id: 'invalid', actions: [{ id: 'run', label: 'Run', pageId: 'progress', pageParams: { callsign: 'override' } }] };
    invalidHost.register('bad-fixture', invalidProvider, createOwner());
    // One malformed action is dropped; it must not reject the provider or the plugin load.
    expect(invalidHost.getProviderInfo('invalid')!.actions).toEqual([]);
  });
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

  it('passes a retrospective batch to the enabled provider once', async () => {
    const host = new LogbookSyncHost();
    const provider = createProvider();
    host.register('wavelog-sync', provider, createOwner());
    const first = createQso('review-1');
    const second = createQso('review-2');

    await expect(host.onQSOsComplete('BG5DRB', [first, second])).resolves.toBe(true);
    await flushAsyncWork();

    expect(provider.upload).toHaveBeenCalledWith('BG5DRB', {
      trigger: 'auto', records: [first, second],
    });
  });

  it('serializes a replacement provider behind an in-flight upload across a reload', async () => {
    const host = new LogbookSyncHost();
    const gate = deferred<void>();
    const started: string[] = [];
    const first = createProvider(async () => {
      started.push('first');
      await gate.promise;
      return { uploaded: 1, skipped: 0, failed: 0 };
    });
    const firstOwner = createOwner(1);
    host.register('wavelog-sync', first, firstOwner);

    host.onQSOComplete('BG5DRB', createQso('reload-1'));
    await flushAsyncWork();
    expect(started).toEqual(['first']);

    firstOwner.active = false;
    host.unregisterByPlugin('wavelog-sync', 1);
    const second = createProvider(async () => {
      started.push('second');
      return { uploaded: 1, skipped: 0, failed: 0 };
    });
    host.register('wavelog-sync', second, createOwner(2));
    host.onQSOComplete('BG5DRB', createQso('reload-2'));
    await flushAsyncWork();

    // The replacement must not POST while the retired generation is still uploading.
    expect(started).toEqual(['first']);
    gate.resolve();
    await flushAsyncWork();
    await flushAsyncWork();

    expect(started).toEqual(['first', 'second']);
    expect(second.upload).toHaveBeenCalledTimes(1);
  });

  it('reports a QSO as not queued when a provider cannot be evaluated', async () => {
    const host = new LogbookSyncHost();
    const owner = createOwner();
    host.register('wavelog-sync', createProvider(), owner);
    owner.active = false;
    await expect(host.onQSOsComplete('BG5DRB', [createQso('lost')])).resolves.toBe(false);
  });

  it('normalizes the callsign so one logbook keeps a single upload queue', async () => {
    const host = new LogbookSyncHost();
    const gate = deferred<void>();
    const provider = createProvider(async (_callsign, options) => {
      await gate.promise;
      return { uploaded: options?.records?.length ?? 0, skipped: 0, failed: 0 };
    });
    host.register('wavelog-sync', provider, createOwner());
    void host.onQSOsComplete('bg5drb', [createQso('norm-1')]);
    await flushAsyncWork();
    void host.onQSOsComplete('BG5DRB', [createQso('norm-2')]);
    await flushAsyncWork();
    // A separate queue key for the other spelling would start a second concurrent upload.
    expect(provider.upload).toHaveBeenCalledTimes(1);
    gate.resolve();
    await flushAsyncWork();
    await flushAsyncWork();
  });

  it('bounds the auto-upload backlog and drops the oldest records', async () => {
    const host = new LogbookSyncHost();
    const provider = createProvider(async (_callsign, options) => ({
      uploaded: options?.records?.length ?? 0, skipped: 0, failed: 0,
    }));
    host.register('wavelog-sync', provider, createOwner());
    const records = Array.from({ length: 1_001 }, (_, index) => createQso(`cap-${index}`));
    await host.onQSOsComplete('BG5DRB', records);
    const uploadedIds = () => provider.upload.mock.calls.flatMap(call => (call[1]?.records ?? []).map(record => record.id));
    for (let i = 0; i < 50 && uploadedIds().length < 1_000; i++) await flushAsyncWork();
    expect(uploadedIds()).toHaveLength(1_000);
    expect(uploadedIds()).not.toContain('cap-0');
  });

  it('rejects a second plugin that claims an active provider id', async () => {
    const host = new LogbookSyncHost();
    host.register('plugin-a', createProvider(), createOwner(1));
    expect(() => host.register('plugin-b', createProvider(), createOwner(2))).toThrow(/already owned/);
  });

  it('drops a previous owner backlog when another plugin reuses the provider id', async () => {
    const host = new LogbookSyncHost();
    const gate = deferred<void>();
    const first = createProvider(async (_callsign, options) => {
      await gate.promise;
      return { uploaded: options?.records?.length ?? 0, skipped: 0, failed: 0 };
    });
    const firstOwner = createOwner(1);
    host.register('plugin-a', first, firstOwner);
    host.onQSOsComplete('BG5DRB', [createQso('old-backlog')]);
    await flushAsyncWork();
    firstOwner.active = false;
    host.unregisterByPlugin('plugin-a', 1);
    const second = createProvider();
    host.register('plugin-b', second, createOwner(2));
    gate.resolve();
    await flushAsyncWork();
    await flushAsyncWork();
    expect(second.upload).not.toHaveBeenCalled();
  });

  it('starts with an empty queue when the persisted queue is unreadable', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tx5dr-sync-queue-'));
    const queuePath = path.join(resolvePluginPaths(dir).pluginDataDir, 'logbook-sync-auto-queue.json');
    try {
      await fs.mkdir(path.dirname(queuePath), { recursive: true });
      await fs.writeFile(queuePath, '{not-json');
      const host = new LogbookSyncHost();
      await expect(host.initialize(dir)).resolves.toBeUndefined();
      const entries = await fs.readdir(path.dirname(queuePath));
      expect(entries.some(name => name.includes('.corrupt-'))).toBe(true);
      await host.shutdown();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('audits structured auto-upload failures returned without rejection', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const host = new LogbookSyncHost();
      const provider = createProvider(async () => ({
        uploaded: 0,
        skipped: 0,
        failed: 1,
        failures: [{
          code: 'wavelog_upload_failed',
          message: 'Network request failed',
          source: 'network',
          operation: 'upload',
          providerId: 'wavelog',
          retryable: true,
        }],
      }));
      host.register('wavelog-sync', provider, createOwner());

      host.onQSOComplete('BG5DRB', createQso('qso-failed'));
      await flushAsyncWork();

      expect(warn.mock.calls).toContainEqual([
        '[LogbookSyncHost] Auto-upload completed with failures',
        expect.objectContaining({
          providerId: 'wavelog',
          recordCount: 1,
          recordIds: ['qso-failed'],
          uploaded: 0,
          failed: 1,
          failureCount: 1,
          failureCodes: ['wavelog_upload_failed'],
          retryableFailureCount: 1,
        }),
      ]);
    } finally {
      warn.mockRestore();
    }
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

  it('reads optional preflight handlers inside the invocation and detaches options', async () => {
    const host = new LogbookSyncHost();
    const gate = deferred<void>();
    let insideInvocation = false;
    let observedSince: number | undefined;
    const provider = createProvider();
    Object.defineProperty(provider, 'getUploadPreflight', {
      configurable: true,
      get() {
        expect(insideInvocation).toBe(true);
        return async (_callsign: string, options?: { since?: number }) => {
          await gate.promise;
          observedSince = options?.since;
          return { ready: true, pendingCount: 0, uploadableCount: 0, blockedCount: 0 };
        };
      },
    });
    const owner = createOwner();
    owner.invoke = async (_operation, callback) => {
      insideInvocation = true;
      try {
        return await callback();
      } finally {
        insideInvocation = false;
      }
    };
    host.register('wavelog-sync', provider, owner);
    const options = { since: 1, includeAlreadyUploaded: false };

    const result = host.getUploadPreflight('wavelog', 'BG5DRB', options);
    options.since = 2;
    gate.resolve();

    await expect(result).resolves.toMatchObject({ ready: true });
    expect(observedSince).toBe(1);
  });

  it('detaches download range options before provider use', async () => {
    const host = new LogbookSyncHost();
    const gate = deferred<void>();
    let observedSince: number | undefined;
    const provider = createProvider();
    provider.download = vi.fn(async (_callsign, options) => {
      await gate.promise;
      observedSince = options?.since;
      return { downloaded: 0, matched: 0, updated: 0 };
    });
    host.register('wavelog-sync', provider, createOwner());
    const options = { since: 1 };

    const result = host.download('wavelog', 'BG5DRB', options);
    options.since = 2;
    gate.resolve();

    await expect(result).resolves.toMatchObject({ downloaded: 0 });
    expect(observedSince).toBe(1);
  });
});

describe('provider-owned status projection', () => {
  const status = { operationId: 'generic-operation', revision: 1, operation: 'full_sync' as const, state: 'paused' as const,
    stage: 'downloading' as const, startedAt: 1, updatedAt: 2, processed: 0, downloaded: 0, imported: 0, updated: 0,
    uploaded: 0, skipped: 0, failed: 0, conflicts: 0, rejected: 0, resumable: true, errors: [] };
  it('validates and detaches status without uploading, downloading or exposing hidden providers', async () => {
    const host = new LogbookSyncHost(); const provider = { ...createProvider(), id: 'generic', getStatus: vi.fn(async () => status) };
    host.register('generic-plugin', provider, createOwner());
    const result = await host.getStatuses('BG5DRB', ['generic']);
    expect(result.generic).toEqual({ supported: true, available: true, status });
    result.generic!.status!.downloaded = 50;
    expect(status.downloaded).toBe(0); expect(provider.upload).not.toHaveBeenCalled(); expect(provider.download).not.toHaveBeenCalled();
    expect(await host.getStatuses('BG5DRB', [])).toEqual({});
  });
  it('keeps old providers compatible and exposes invalid state as unavailable', async () => {
    const host = new LogbookSyncHost(); const old = createProvider(); host.register('old', old, createOwner());
    expect((await host.getStatuses('BG5DRB', [old.id]))[old.id]).toEqual({ supported: false, available: true, status: null });
    const invalid = { ...createProvider(), id: 'generic', getStatus: vi.fn(async () => ({ ...status, token: 'must-not-cross-boundary' })) };
    host.register('generic', invalid, createOwner());
    expect((await host.getStatuses('BG5DRB', ['generic'])).generic).toEqual({ supported: true, available: false, status: null });
  });
  it('discards a projection whose plugin was unloaded while it was being read', async () => {
    const pending = deferred<typeof status>(); const host = new LogbookSyncHost(); const owner = createOwner();
    const provider = { ...createProvider(), id: 'generic', getStatus: () => pending.promise };
    host.register('generic', provider, owner); const result = host.getStatuses('BG5DRB', ['generic']);
    owner.active = false; pending.resolve(status);
    expect((await result).generic?.available).toBe(false);
  });
});
