import path from 'node:path';

import type {
  LogbookSyncProvider,
  SyncAction,
  SyncTestResult,
  SyncUploadResult,
  SyncUploadOptions,
  SyncUploadPreflightResult,
  SyncDownloadResult,
  SyncDownloadOptions,
} from '@tx5dr/plugin-api';
import { createSyncFailure } from '@tx5dr/plugin-api';
import { QSORecordSchema, type QSORecord } from '@tx5dr/contracts';
import { createLogger } from '../utils/logger.js';
import { JsonFileStore, PersistenceCoordinator } from '../utils/persistence/index.js';
import { resolvePluginPaths } from './paths.js';
import { snapshotPluginData } from './plugin-data-boundary.js';

const logger = createLogger('LogbookSyncHost');

interface RegisteredProvider {
  pluginName: string;
  provider: LogbookSyncProvider;
  owner: LogbookSyncProviderOwner;
  info: LogbookSyncProviderInfo;
}

interface PendingAutoUpload {
  providerId: string;
  callsign: string;
  records: QSORecord[];
}

export interface LogbookSyncProviderOwner {
  generation: number;
  isCurrent(): boolean;
  invoke<T>(operation: string, callback: () => T | Promise<T>): Promise<T>;
  invokeSync<T>(operation: string, callback: () => T): T;
}

/**
 * Serializable provider info exposed to the frontend.
 */
export interface LogbookSyncProviderInfo {
  id: string;
  pluginName: string;
  displayName: string;
  icon?: string;
  color?: string;
  settingsPageId: string;
  accessScope?: 'admin' | 'operator';
  actions?: SyncAction[];
}

/**
 * Host-side manager for logbook sync providers registered by plugins.
 *
 * Responsibilities:
 * - Maintains a registry of active sync providers
 * - Exposes provider info for the frontend sync settings modal
 * - Routes sync operations (test-connection, upload, download) to providers
 * - Handles auto-upload on QSO completion
 */
export class LogbookSyncHost {
  private providers = new Map<string, RegisteredProvider>();
  /** Tracks the currently running upload promise per (providerId, callsign). */
  private activeUploads = new Map<string, Promise<SyncUploadResult>>();
  /** Serializes all upload work per (providerId, callsign). */
  private uploadQueueTails = new Map<string, Promise<void>>();
  /** Coalesces auto-uploaded QSOs while another upload is already queued/running. */
  private pendingAutoRecords = new Map<string, Map<string, QSORecord>>();
  /** Marks keys that already have an auto-drain job queued or running. */
  private scheduledAutoDrains = new Set<string>();
  private pendingQueueStore: JsonFileStore<PendingAutoUpload[]> | null = null;
  private pendingQueueFlushTail: Promise<void> = Promise.resolve();
  private unregisterPendingQueuePersistence: (() => void) | undefined;
  private pendingQueueReady = false;

  async initialize(dataDir: string): Promise<void> {
    if (this.pendingQueueStore) return;
    const queuePath = path.join(resolvePluginPaths(dataDir).pluginDataDir, 'logbook-sync-auto-queue.json');
    const store = new JsonFileStore<PendingAutoUpload[]>(queuePath, {
      defaultValue: () => [],
      validate: (value) => {
        if (!Array.isArray(value)) throw new Error('logbook sync queue must be an array');
        return value.map((item) => {
          if (!item || typeof item !== 'object') throw new Error('logbook sync queue item must be an object');
          const candidate = item as { providerId?: unknown; callsign?: unknown; records?: unknown };
          if (typeof candidate.providerId !== 'string' || typeof candidate.callsign !== 'string') {
            throw new Error('logbook sync queue item identity is invalid');
          }
          if (!Array.isArray(candidate.records)) throw new Error('logbook sync queue records must be an array');
          return {
            providerId: candidate.providerId,
            callsign: candidate.callsign,
            records: candidate.records.map((record) => QSORecordSchema.parse(record)),
          };
        });
      },
      backups: 3,
      createIfMissing: true,
    });
    await store.load();
    this.pendingQueueStore = store;
    this.pendingQueueReady = true;
    this.unregisterPendingQueuePersistence = PersistenceCoordinator.getInstance().register({
      name: `logbook-sync-auto-queue:${queuePath}`,
      flush: async () => this.flushPendingQueue(),
    });
    for (const item of store.get()) {
      if (!item || typeof item.providerId !== 'string' || typeof item.callsign !== 'string') continue;
      const key = LogbookSyncHost.uploadKey(item.providerId, item.callsign);
      const records = this.pendingAutoRecords.get(key) ?? new Map<string, QSORecord>();
      for (const record of item.records ?? []) {
        if (record && typeof record.id === 'string') records.set(record.id, snapshotPluginData(record, 'structured'));
      }
      if (records.size > 0) this.pendingAutoRecords.set(key, records);
    }
    for (const [id, entry] of this.providers) {
      this.resumePendingForProvider(id, entry);
    }
  }

  async shutdown(): Promise<void> {
    await this.flushPendingQueue();
    this.unregisterPendingQueuePersistence?.();
    this.unregisterPendingQueuePersistence = undefined;
    this.pendingQueueStore = null;
    this.pendingQueueReady = false;
  }

  private static uploadKey(providerId: string, callsign: string): string {
    return `${providerId}\0${callsign}`;
  }

  /**
   * Registers a sync provider. Called from PluginContextFactory when a plugin
   * invokes `ctx.logbookSync.register()`.
   */
  register(
    pluginName: string,
    provider: LogbookSyncProvider,
    owner: LogbookSyncProviderOwner,
  ): void {
    if (this.providers.has(provider.id)) {
      logger.warn('Overwriting existing sync provider', {
        id: provider.id,
        previousPlugin: this.providers.get(provider.id)!.pluginName,
        newPlugin: pluginName,
      });
    }
    const entry: RegisteredProvider = {
      pluginName,
      provider,
      owner,
      info: {
        id: provider.id,
        pluginName,
        displayName: provider.displayName,
        icon: provider.icon,
        color: provider.color,
        settingsPageId: provider.settingsPageId,
        accessScope: provider.accessScope ?? 'admin',
        actions: provider.actions ? structuredClone(provider.actions) : undefined,
      },
    };
    this.providers.set(provider.id, entry);
    this.resumePendingForProvider(provider.id, entry);
    logger.info('Logbook sync provider registered', {
      id: provider.id,
      pluginName,
      displayName: provider.displayName,
    });
  }

  /**
   * Unregisters all providers from a specific plugin. Called during plugin
   * unload/reload.
   */
  unregisterByPlugin(pluginName: string, generation?: number): void {
    for (const [id, entry] of this.providers) {
      if (entry.pluginName === pluginName
          && (generation === undefined || entry.owner.generation === generation)) {
        this.providers.delete(id);
        // Clean up any active upload entries for this provider to avoid dangling references.
        for (const key of this.activeUploads.keys()) {
          if (key.startsWith(`${id}\0`)) {
            this.activeUploads.delete(key);
            this.uploadQueueTails.delete(key);
            this.scheduledAutoDrains.delete(key);
          }
        }
        logger.info('Logbook sync provider unregistered', { id, pluginName });
      }
    }
  }

  private toProviderInfo(entry: RegisteredProvider): LogbookSyncProviderInfo {
    return structuredClone(entry.info);
  }

  private isCurrent(entry: RegisteredProvider): boolean {
    return entry.owner.isCurrent()
      && this.providers.get(entry.info.id) === entry;
  }

  private async invoke<T>(
    entry: RegisteredProvider,
    operation: string,
    callback: () => T | Promise<T>,
  ): Promise<T> {
    if (!this.isCurrent(entry)) {
      throw new Error('PLUGIN_INVOCATION_EXPIRED: logbook sync provider is no longer active');
    }
    const result = await entry.owner.invoke(`logbook-sync:${operation}`, callback);
    if (!this.isCurrent(entry)) {
      throw new Error('PLUGIN_INVOCATION_EXPIRED: stale logbook sync result discarded');
    }
    return result;
  }

  private invokeSync<T>(entry: RegisteredProvider, operation: string, callback: () => T): T {
    if (!this.isCurrent(entry)) {
      throw new Error('PLUGIN_INVOCATION_EXPIRED: logbook sync provider is no longer active');
    }
    return entry.owner.invokeSync(`logbook-sync:${operation}`, callback);
  }

  /** Returns info about all registered providers for the frontend. */
  getProviders(accessScope?: 'admin' | 'operator'): LogbookSyncProviderInfo[] {
    return Array.from(this.providers.values())
      .map((entry) => this.toProviderInfo(entry))
      .filter((provider) => {
        if (accessScope !== 'operator') {
          return true;
        }
        return provider.accessScope === 'operator';
      });
  }

  getProviderInfo(providerId: string): LogbookSyncProviderInfo | null {
    const entry = this.providers.get(providerId);
    return entry ? this.toProviderInfo(entry) : null;
  }

  /** Tests the connection for a specific provider and callsign. */
  async testConnection(providerId: string, callsign: string): Promise<SyncTestResult> {
    const entry = this.providers.get(providerId);
    if (!entry) {
      const failure = createSyncFailure({
        code: 'sync_provider_not_found',
        message: `Provider not found: ${providerId}`,
        source: 'host',
        operation: 'test_connection',
        providerId,
      });
      return { success: false, message: failure.message, failures: [failure] };
    }
    return this.invoke(entry, 'test-connection', () => entry.provider.testConnection(callsign));
  }

  /**
   * Triggers an upload for a specific provider and callsign.
   *
   * Upload work is serialized per (provider, callsign) so manual actions do
   * not overlap with any queued auto-upload batch for the same logbook.
   */
  async upload(
    providerId: string,
    callsign: string,
    options?: Pick<SyncUploadOptions, 'skipBlockedQsos' | 'since' | 'until' | 'includeAlreadyUploaded'>,
  ): Promise<SyncUploadResult> {
    const entry = this.providers.get(providerId);
    if (!entry) {
      return {
        uploaded: 0,
        skipped: 0,
        failed: 0,
        failures: [
          createSyncFailure({
            code: 'sync_provider_not_found',
            message: `Provider not found: ${providerId}`,
            source: 'host',
            operation: 'upload',
            providerId,
          }),
        ],
      };
    }

    const key = LogbookSyncHost.uploadKey(providerId, callsign);
    return this.enqueueUpload(key, () => this.invoke(entry, 'upload', () => entry.provider.upload(callsign, {
      trigger: 'manual',
      since: options?.since,
      until: options?.until,
      includeAlreadyUploaded: options?.includeAlreadyUploaded,
      skipBlockedQsos: options?.skipBlockedQsos,
    })));
  }

  async getUploadPreflight(
    providerId: string,
    callsign: string,
    options?: Pick<SyncUploadOptions, 'since' | 'until' | 'includeAlreadyUploaded'>,
  ): Promise<SyncUploadPreflightResult | null> {
    const entry = this.providers.get(providerId);
    if (!entry) return null;
    const detachedOptions = options
      ? snapshotPluginData(options, 'structured')
      : undefined;
    return this.invoke(entry, 'upload-preflight', () => {
      const getUploadPreflight = entry.provider.getUploadPreflight;
      return getUploadPreflight
        ? getUploadPreflight.call(entry.provider, callsign, detachedOptions)
        : null;
    });
  }

  /**
   * Triggers a download for a specific provider and callsign.
   *
   * The provider is responsible for writing QSOs into the logbook internally.
   */
  async download(
    providerId: string,
    callsign: string,
    options?: SyncDownloadOptions,
  ): Promise<SyncDownloadResult> {
    const entry = this.providers.get(providerId);
    if (!entry) {
      return {
        downloaded: 0,
        matched: 0,
        updated: 0,
        failures: [
          createSyncFailure({
            code: 'sync_provider_not_found',
            message: `Provider not found: ${providerId}`,
            source: 'host',
            operation: 'download',
            providerId,
          }),
        ],
      };
    }
    const detachedOptions = options
      ? {
          ...snapshotPluginData({ since: options.since, until: options.until }, 'structured'),
          ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        }
      : undefined;
    return this.invoke(entry, 'download', () => entry.provider.download(callsign, detachedOptions));
  }

  /**
   * Called when a QSO is completed. Checks each registered provider's
   * auto-upload setting and triggers upload if enabled.
   *
   * Auto-upload batches only the newly completed QSOs. If another upload is
   * already queued/running for the same (provider, callsign), new QSOs are
   * buffered and drained in the next serialized auto batch.
   */
  onQSOComplete(callsign: string, qsoRecord: QSORecord): Promise<void> {
    return this.onQSOCompleteAsync(callsign, qsoRecord);
  }

  private async onQSOCompleteAsync(callsign: string, qsoRecord: QSORecord): Promise<void> {
    let changed = false;
    for (const [id, entry] of this.providers) {
      const { provider, pluginName } = entry;
      try {
        if (!this.invokeSync(entry, 'is-auto-upload-enabled', () => provider.isAutoUploadEnabled(callsign))) {
          continue;
        }

        const key = LogbookSyncHost.uploadKey(id, callsign);
        const queuedRecords = this.pendingAutoRecords.get(key) ?? new Map<string, QSORecord>();
        queuedRecords.set(qsoRecord.id, snapshotPluginData(qsoRecord, 'structured'));
        this.pendingAutoRecords.set(key, queuedRecords);
        changed = true;
      } catch (err) {
        logger.warn('Auto-upload check failed', {
          providerId: id,
          pluginName,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (!changed || !await this.persistPendingQueue()) return;
    for (const [id, entry] of this.providers) {
      this.resumePendingForProvider(id, entry);
    }
  }

  private resumePendingForProvider(providerId: string, entry: RegisteredProvider): void {
    if (!this.pendingQueueReady && this.pendingQueueStore) return;
    for (const key of this.pendingAutoRecords.keys()) {
      if (!key.startsWith(`${providerId}\0`)) continue;
      const callsign = key.slice(providerId.length + 1);
      this.scheduleAutoDrain(key, entry, callsign);
    }
  }

  private snapshotPendingQueue(): PendingAutoUpload[] {
    return [...this.pendingAutoRecords.entries()].map(([key, records]) => {
      const separator = key.indexOf('\0');
      return {
        providerId: key.slice(0, separator),
        callsign: key.slice(separator + 1),
        records: [...records.values()].map((record) => snapshotPluginData(record, 'structured')),
      };
    }).filter((item) => item.records.length > 0);
  }

  private async persistPendingQueue(): Promise<boolean> {
    if (!this.pendingQueueStore) return true;
    if (!this.pendingQueueReady) return false;
    const snapshot = this.snapshotPendingQueue();
    const run = this.pendingQueueFlushTail
      .catch(() => undefined)
      .then(() => this.pendingQueueStore!.set(snapshot));
    this.pendingQueueFlushTail = run.catch(() => undefined);
    try {
      await run;
      return true;
    } catch (error) {
      logger.error('Failed to persist logbook sync auto-upload queue', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private async flushPendingQueue(): Promise<void> {
    if (!this.pendingQueueStore || !this.pendingQueueReady) return;
    await this.persistPendingQueue();
    await this.pendingQueueStore.flush();
  }

  /**
   * Queues upload work behind any existing upload for the same key while still
   * exposing the active promise for callers/tests.
   */
  private enqueueUpload(
    key: string,
    task: () => Promise<SyncUploadResult>,
  ): Promise<SyncUploadResult> {
    const previous = this.uploadQueueTails.get(key) ?? Promise.resolve();
    const run = previous
      .catch(() => {})
      .then(async () => {
        const promise = task();
        this.activeUploads.set(key, promise);
        try {
          return await promise;
        } finally {
          if (this.activeUploads.get(key) === promise) {
            this.activeUploads.delete(key);
          }
        }
      });

    const tail = run.then(() => undefined, () => undefined);
    this.uploadQueueTails.set(key, tail);
    void tail.finally(() => {
      if (this.uploadQueueTails.get(key) === tail) {
        this.uploadQueueTails.delete(key);
      }
    });

    return run;
  }

  private scheduleAutoDrain(
    key: string,
    entry: RegisteredProvider,
    callsign: string,
  ): void {
    if (this.scheduledAutoDrains.has(key)) {
      return;
    }

    this.scheduledAutoDrains.add(key);
    let drainedSuccessfully = false;
    void this.enqueueUpload(key, async () => {
      const queuedRecords = this.pendingAutoRecords.get(key);
      if (!queuedRecords || queuedRecords.size === 0) {
        return { uploaded: 0, skipped: 0, failed: 0 };
      }

      const records = Array.from(queuedRecords.values());
      const result = await this.invoke(entry, 'auto-upload', () => entry.provider.upload(callsign, {
        trigger: 'auto',
        records,
      }));
      const failures = result.failures ?? [];
      const audit = {
        providerId: entry.info.id,
        pluginName: entry.pluginName,
        callsign,
        recordCount: records.length,
        recordIds: records.slice(0, 20).map(record => record.id),
        recordIdsTruncated: records.length > 20,
        uploaded: result.uploaded,
        skipped: result.skipped,
        failed: result.failed,
        failureCount: failures.length,
        failureCodes: [...new Set(failures.map(failure => failure.code))],
        retryableFailureCount: failures.filter(failure => failure.retryable === true).length,
      };
      if (result.failed > 0 || failures.length > 0) {
        logger.warn('Auto-upload completed with failures', audit);
      } else {
        logger.info('Auto-upload completed', audit);
      }
      if (result.failed === 0 && failures.length === 0) {
        const remaining = this.pendingAutoRecords.get(key);
        if (remaining) {
          for (const record of records) remaining.delete(record.id);
          if (remaining.size === 0) this.pendingAutoRecords.delete(key);
        }
        drainedSuccessfully = await this.persistPendingQueue();
      }
      return result;
    }).catch((err) => {
      logger.warn('Auto-upload failed', {
        providerId: entry.info.id,
        pluginName: entry.pluginName,
        callsign,
        error: err instanceof Error ? err.message : String(err),
      });
    }).finally(() => {
      this.scheduledAutoDrains.delete(key);
      const remainingRecords = this.pendingAutoRecords.get(key);
      if (drainedSuccessfully && remainingRecords && remainingRecords.size > 0 && this.isCurrent(entry)) {
        this.scheduleAutoDrain(key, entry, callsign);
      } else if (!this.pendingQueueStore) {
        this.pendingAutoRecords.delete(key);
      }
    });
  }

  /** Checks if a specific provider is configured for the given callsign. */
  isConfigured(providerId: string, callsign: string): boolean {
    const entry = this.providers.get(providerId);
    if (!entry) return false;
    try {
      return this.invokeSync(entry, 'is-configured', () => entry.provider.isConfigured(callsign));
    } catch {
      return false;
    }
  }

  /** Returns configuration status for all providers (provider.isConfigured). */
  getConfiguredStatus(callsign: string): Record<string, boolean> {
    const result: Record<string, boolean> = {};
    for (const [id, entry] of this.providers) {
      try {
        result[id] = this.invokeSync(entry, 'is-configured', () => entry.provider.isConfigured(callsign));
      } catch {
        result[id] = false;
      }
    }
    return result;
  }
}
