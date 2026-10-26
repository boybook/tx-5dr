import { SyncBusyError } from '../_shared/sync-operation-gate.js';
import type { LogbookSyncProvider, PluginContextFor, SyncUploadOptions, SyncDownloadOptions, SyncUploadResult, SyncDownloadResult, SyncTestResult, SyncStatus } from '@tx5dr/plugin-api';
import { createSyncFailure, normalizeCallsign } from '@tx5dr/plugin-api';
import { WavelogProtocol, protocolVersion, type WaveLogPluginConfig } from './protocol.js';
import { WavelogSyncService } from './sync-service.js';

export { buildWavelogQslStatusUpdates } from './qso-identity.js';
export type { WaveLogPluginConfig } from './protocol.js';
type Context = PluginContextFor<readonly ['network', 'logbook:read', 'logbook:write']>;

/** Public Provider remains a thin bridge; Wavelog policy and checkpoints live in the plugin. */
export class WaveLogSyncProvider implements LogbookSyncProvider {
  readonly id = 'wavelog';
  readonly displayName = 'WaveLog';
  readonly color = 'secondary' as const;
  readonly accessScope = 'operator' as const;
  readonly settingsPageId = 'settings';
  readonly actions = [
    { id: 'download', label: 'Download', icon: 'download' as const, pageId: 'sync', pageParams: { operation: 'download', intent: 'start' } },
    { id: 'upload', label: 'Upload', icon: 'upload' as const, pageId: 'sync', pageParams: { operation: 'upload', intent: 'start' } },
    { id: 'full_sync', label: 'Full Sync', icon: 'sync' as const, pageId: 'sync', pageParams: { operation: 'full_sync', intent: 'start' } },
  ];
  readonly sync: WavelogSyncService;
  constructor(private ctx: Context) { this.sync = new WavelogSyncService(ctx, callsign => this.getConfig(callsign)); }
  getConfig(callsign: string): WaveLogPluginConfig | null {
    const value = this.ctx.store.global.get<unknown>(`config:${normalizeCallsign(callsign)}`);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const config = value as WaveLogPluginConfig;
    if (typeof config.url !== 'string' || typeof config.apiKey !== 'string' || typeof config.stationId !== 'string'
      || typeof config.autoUploadQSO !== 'boolean' || config.apiVersion !== undefined && !['v1', 'v2'].includes(config.apiVersion)) return null;
    return config;
  }
  getPublicConfig(callsign: string): Omit<WaveLogPluginConfig, 'apiKey'> & { hasApiKey: boolean } | null {
    const config = this.getConfig(callsign);
    if (!config) return null;
    return { url: config.url, stationId: config.stationId, autoUploadQSO: config.autoUploadQSO,
      apiVersion: protocolVersion(config), hasApiKey: !!config.apiKey,
      ...(config.schemaVersion ? { schemaVersion: config.schemaVersion } : {}),
      ...(typeof config.radioName === 'string' ? { radioName: config.radioName } : {}),
      ...(Number.isFinite(config.lastSyncTime) ? { lastSyncTime: config.lastSyncTime } : {}) };
  }
  setConfig(callsign: string, config: WaveLogPluginConfig): void {
    if (this.sync.isActive(callsign) || this.sync.hasUnfinishedSession(callsign)) {
      throw new Error('Finish the current sync before changing its configuration');
    }
    const previous = this.getConfig(callsign);
    const apiKey = config.apiKey || previous?.apiKey || '';
    const url = new URL(config.url.trim());
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid Wavelog URL');
    if (!apiKey || /\s/.test(apiKey) || !/^\d+$/.test(config.stationId.trim()) || typeof config.autoUploadQSO !== 'boolean') throw new Error('Invalid Wavelog configuration');
    const next: WaveLogPluginConfig = { schemaVersion: 2, url: url.toString().replace(/\/+$/, ''), apiKey,
      apiVersion: config.apiVersion ?? (apiKey.startsWith('wl2_') ? 'v2' : 'v1'), stationId: config.stationId.trim(),
      autoUploadQSO: config.autoUploadQSO, radioName: previous?.radioName ?? config.radioName };
    this.ctx.store.global.set(`config:${normalizeCallsign(callsign)}`, next);
  }
  saveDraft(callsign: string, value: unknown): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid configuration request');
    const data = value as Record<string, unknown>;
    if (typeof data.url !== 'string' || typeof data.apiKey !== 'string' || typeof data.stationId !== 'string' || typeof data.autoUploadQSO !== 'boolean'
      || data.apiVersion !== undefined && data.apiVersion !== 'v1' && data.apiVersion !== 'v2') throw new Error('Invalid configuration fields');
    this.setConfig(callsign, { url: data.url, apiKey: data.apiKey, stationId: data.stationId, autoUploadQSO: data.autoUploadQSO, apiVersion: data.apiVersion });
  }
  isConfigured(callsign: string): boolean {
    const config = this.getConfig(callsign); return !!(config?.url && config.apiKey && config.stationId);
  }
  isAutoUploadEnabled(callsign: string): boolean { return this.isConfigured(callsign) && !!this.getConfig(callsign)?.autoUploadQSO; }
  getStatus(callsign: string): Promise<SyncStatus | null> { return this.sync.getStatus(callsign); }
  async fetchStationList(url: string, apiKey: string, apiVersion?: 'v1' | 'v2') {
    if (!this.ctx.fetch) throw new Error('Network permission is unavailable');
    return new WavelogProtocol(this.ctx.fetch, { url, apiKey, apiVersion, stationId: '', autoUploadQSO: false }).stations();
  }
  async testConnection(callsign: string): Promise<SyncTestResult> {
    const config = this.getConfig(callsign);
    try {
      if (!config) throw new Error('Wavelog is not configured');
      const stations = await this.fetchStationList(config.url, config.apiKey, config.apiVersion);
      return { success: true, message: 'Connection successful', details: { stations } };
    } catch (error) {
      const failure = createSyncFailure({ code: 'wavelog_connection_failed', message: error instanceof Error ? error.message : 'Connection failed', secrets: [config?.apiKey], providerId: this.id });
      return { success: false, message: failure.message, failures: [failure] };
    }
  }
  async upload(callsign: string, options?: SyncUploadOptions): Promise<SyncUploadResult> {
    try {
      if (options?.records) return await this.sync.automaticUpload(callsign, options.records);
      const status = await this.sync.run(callsign, 'upload');
      return { uploaded: status.uploaded, skipped: status.skipped, failed: status.failed,
        failures: status.errors.length ? status.errors.map(error => createSyncFailure({ ...error, providerId: this.id, operation: 'upload' }))
          : status.resumable ? [createSyncFailure({ code: 'wavelog_sync_paused', message: 'Sync is waiting. Open the plugin page to continue.', providerId: this.id, retryable: true })] : undefined };
    } catch (error) { return { uploaded: 0, skipped: 0, failed: options?.records?.length ?? 0, failures: [this.failure(error, callsign, 'upload')] }; }
  }
  async download(callsign: string, _options?: SyncDownloadOptions): Promise<SyncDownloadResult> {
    try { return this.sync.downloadResult(await this.sync.run(callsign, 'download')); }
    catch (error) { return { downloaded: 0, matched: 0, updated: 0, imported: 0, failures: [this.failure(error, callsign, 'download')] }; }
  }
  private failure(error: unknown, callsign: string, operation: 'upload' | 'download') {
    return createSyncFailure({ code: error instanceof SyncBusyError ? 'sync_busy' : 'wavelog_sync_failed', retryable: error instanceof SyncBusyError, message: error instanceof Error ? error.message : 'Sync failed', providerId: this.id, operation, secrets: [this.getConfig(callsign)?.apiKey] });
  }
}
