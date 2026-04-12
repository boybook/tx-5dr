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
   * The provider is responsible for querying the logbook internally.
   */
  async upload(
    providerId: string,
    callsign: string,
  ): Promise<SyncUploadResult> {
    const entry = this.providers.get(providerId);
    if (!entry) {
      return { uploaded: 0, skipped: 0, failed: 0, errors: [`Provider not found: ${providerId}`] };
    }
    return entry.provider.upload(callsign);
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
   * Runs asynchronously and does not block the caller.
   */
  onQSOComplete(callsign: string): void {
    for (const [id, { provider, pluginName }] of this.providers) {
      try {
        if (provider.isAutoUploadEnabled(callsign)) {
          provider.upload(callsign).catch((err) => {
            logger.warn('Auto-upload failed', {
              providerId: id,
              pluginName,
              callsign,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
      } catch (err) {
        logger.warn('Auto-upload check failed', {
          providerId: id,
          pluginName,
          error: err instanceof Error ? err.message : String(err),
        });
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
