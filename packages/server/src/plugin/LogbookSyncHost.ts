import type {
  LogbookSyncProvider,
  SyncAction,
  SyncTestResult,
  SyncUploadResult,
  SyncUploadPreflightResult,
  SyncDownloadResult,
  SyncDownloadOptions,
} from '@tx5dr/plugin-api';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('LogbookSyncHost');

interface RegisteredProvider {
  pluginName: string;
  provider: LogbookSyncProvider;
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
  /** Tracks in-progress upload promises per (providerId, callsign) to prevent concurrent uploads. */
  private activeUploads = new Map<string, Promise<SyncUploadResult>>();

  private static uploadKey(providerId: string, callsign: string): string {
    return `${providerId}\0${callsign}`;
  }

  /**
   * Registers a sync provider. Called from PluginContextFactory when a plugin
   * invokes `ctx.logbookSync.register()`.
   */
  register(pluginName: string, provider: LogbookSyncProvider): void {
    if (this.providers.has(provider.id)) {
      logger.warn('Overwriting existing sync provider', {
        id: provider.id,
        previousPlugin: this.providers.get(provider.id)!.pluginName,
        newPlugin: pluginName,
      });
    }
    this.providers.set(provider.id, { pluginName, provider });
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
  unregisterByPlugin(pluginName: string): void {
    for (const [id, entry] of this.providers) {
      if (entry.pluginName === pluginName) {
        this.providers.delete(id);
        // Clean up any active upload entries for this provider to avoid dangling references.
        for (const key of this.activeUploads.keys()) {
          if (key.startsWith(`${id}\0`)) {
            this.activeUploads.delete(key);
          }
        }
        logger.info('Logbook sync provider unregistered', { id, pluginName });
      }
    }
  }

  private toProviderInfo(entry: RegisteredProvider): LogbookSyncProviderInfo {
    const { pluginName, provider } = entry;
    return {
      id: provider.id,
      pluginName,
      displayName: provider.displayName,
      icon: provider.icon,
      color: provider.color,
      settingsPageId: provider.settingsPageId,
      accessScope: provider.accessScope ?? 'admin',
      actions: provider.actions,
    };
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
      return { success: false, message: `Provider not found: ${providerId}` };
    }
    return entry.provider.testConnection(callsign);
  }

  /**
   * Triggers an upload for a specific provider and callsign.
   *
   * If an upload is already in progress for the same (provider, callsign),
   * waits for it to finish then runs a fresh upload to ensure the caller
   * receives an up-to-date result.
   */
  async upload(
    providerId: string,
    callsign: string,
  ): Promise<SyncUploadResult> {
    const entry = this.providers.get(providerId);
    if (!entry) {
      return { uploaded: 0, skipped: 0, failed: 0, errors: [`Provider not found: ${providerId}`] };
    }

    const key = LogbookSyncHost.uploadKey(providerId, callsign);
    const existing = this.activeUploads.get(key);
    if (existing) {
      // Wait for the in-progress upload to finish, then run our own so the
      // caller gets a result that reflects the current logbook state.
      await existing.catch(() => {});
    }

    return this.runUpload(key, entry.provider, callsign);
  }

  async getUploadPreflight(
    providerId: string,
    callsign: string,
  ): Promise<SyncUploadPreflightResult | null> {
    const entry = this.providers.get(providerId);
    if (!entry?.provider.getUploadPreflight) {
      return null;
    }
    return entry.provider.getUploadPreflight(callsign);
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
      return { downloaded: 0, matched: 0, updated: 0, errors: [`Provider not found: ${providerId}`] };
    }
    return entry.provider.download(callsign, options);
  }

  /**
   * Called when a QSO is completed. Checks each registered provider's
   * auto-upload setting and triggers upload if enabled.
   *
   * If an upload for the same (provider, callsign) is already running, the
   * new trigger is silently skipped — the un-uploaded QSO will be picked up
   * by the next upload because providers use idempotent per-QSO flags or
   * time cursors that are only advanced on success.
   *
   * Runs asynchronously and does not block the caller.
   */
  onQSOComplete(callsign: string): void {
    for (const [id, { provider, pluginName }] of this.providers) {
      try {
        if (!provider.isAutoUploadEnabled(callsign)) {
          continue;
        }

        const key = LogbookSyncHost.uploadKey(id, callsign);
        if (this.activeUploads.has(key)) {
          logger.debug('Auto-upload skipped, upload already in progress', {
            providerId: id,
            pluginName,
            callsign,
          });
          continue;
        }

        this.runUpload(key, provider, callsign).catch((err) => {
          logger.warn('Auto-upload failed', {
            providerId: id,
            pluginName,
            callsign,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      } catch (err) {
        logger.warn('Auto-upload check failed', {
          providerId: id,
          pluginName,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Executes a provider upload while holding the active-upload lock for the
   * given key. The lock is always released in `finally` so subsequent calls
   * can proceed even if the upload throws.
   */
  private async runUpload(
    key: string,
    provider: LogbookSyncProvider,
    callsign: string,
  ): Promise<SyncUploadResult> {
    const promise = provider.upload(callsign);
    this.activeUploads.set(key, promise);
    try {
      return await promise;
    } finally {
      // Only delete if the map still points to *our* promise (another call
      // may have replaced it between await-resume and this cleanup).
      if (this.activeUploads.get(key) === promise) {
        this.activeUploads.delete(key);
      }
    }
  }

  /** Checks if a specific provider is configured for the given callsign. */
  isConfigured(providerId: string, callsign: string): boolean {
    const entry = this.providers.get(providerId);
    return entry?.provider.isConfigured(callsign) ?? false;
  }

  /** Returns configuration status for all providers (provider.isConfigured). */
  getConfiguredStatus(callsign: string): Record<string, boolean> {
    const result: Record<string, boolean> = {};
    for (const [id, { provider }] of this.providers) {
      result[id] = provider.isConfigured(callsign);
    }
    return result;
  }
}
