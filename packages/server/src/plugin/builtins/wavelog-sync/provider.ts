/* eslint-disable @typescript-eslint/no-explicit-any */
// WaveLogSyncProvider — HTTP response handling requires any

import type { PluginContext, LogbookSyncProvider, SyncAction, SyncTestResult, SyncUploadResult, SyncDownloadResult, SyncDownloadOptions } from '@tx5dr/plugin-api';
import type { QSORecord } from '@tx5dr/contracts';
import { convertQSOToADIF, parseADIFContent } from '../../../utils/adif-utils.js';

/**
 * Per-callsign WaveLog configuration stored in plugin KVStore.
 */
export interface WaveLogPluginConfig {
  url: string;
  apiKey: string;
  stationId: string;
  radioName: string;
  autoUploadQSO: boolean;
  lastSyncTime?: number;
}

type UploadStatus = 'created' | 'duplicate' | 'failed';

interface UploadResult {
  success: boolean;
  status: UploadStatus;
  message: string;
}

const CONFIG_KEY_PREFIX = 'config:';

/**
 * WaveLog sync provider — implements LogbookSyncProvider.
 *
 * Manages per-callsign configuration in the plugin's global KVStore
 * and communicates with WaveLog HTTP API for QSO upload/download.
 */
export class WaveLogSyncProvider implements LogbookSyncProvider {
  readonly id = 'wavelog';
  readonly displayName = 'WaveLog';
  readonly color = 'secondary' as const;
  readonly settingsPageId = 'settings';
  readonly actions: SyncAction[] = [
    { id: 'download', label: 'Download', icon: 'download', operation: 'download' },
    { id: 'upload', label: 'Upload', icon: 'upload', operation: 'upload' },
    { id: 'full_sync', label: 'Full Sync', icon: 'sync', operation: 'full_sync' },
  ];

  constructor(private ctx: PluginContext) {}

  // ===== Config helpers =====

  private configKey(callsign: string): string {
    return `${CONFIG_KEY_PREFIX}${callsign.toUpperCase()}`;
  }

  /** Read per-callsign config from KVStore (synchronous — KVStore is in-memory). */
  getConfig(callsign: string): WaveLogPluginConfig | null {
    return this.ctx.store.global.get<WaveLogPluginConfig | undefined>(this.configKey(callsign)) ?? null;
  }

  /** Write per-callsign config to KVStore (synchronous write, async flush). */
  setConfig(callsign: string, config: WaveLogPluginConfig): void {
    this.ctx.store.global.set(this.configKey(callsign), config);
  }

  // ===== LogbookSyncProvider implementation =====

  isConfigured(callsign: string): boolean {
    const config = this.getConfig(callsign);
    return !!(config?.url && config.apiKey && config.stationId);
  }

  isAutoUploadEnabled(callsign: string): boolean {
    const config = this.getConfig(callsign);
    return !!(config?.url && config.apiKey && config.stationId && config.autoUploadQSO);
  }

  async testConnection(callsign: string): Promise<SyncTestResult> {
    const config = this.getConfig(callsign);
    if (!config?.url || !config?.apiKey) {
      return { success: false, message: 'URL and API key are required' };
    }

    try {
      const stations = await this.fetchStationList(config.url, config.apiKey);
      return {
        success: true,
        message: 'Connection successful',
        details: { stations },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Connection failed';
      this.ctx.log.error('Connection test failed', err);
      return { success: false, message };
    }
  }

  async upload(callsign: string): Promise<SyncUploadResult> {
    const config = this.getConfig(callsign);
    if (!config?.url || !config?.apiKey || !config?.stationId) {
      return { uploaded: 0, skipped: 0, failed: 0, errors: ['WaveLog not configured'] };
    }

    // Query recent QSOs from logbook (last 7 days by default)
    const since = config.lastSyncTime ?? (Date.now() - 7 * 24 * 60 * 60 * 1000);
    const qsos = await this.ctx.logbook.queryQSOs({
      timeRange: { start: since, end: Date.now() },
    });

    let uploaded = 0;
    let skipped = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const qso of qsos) {
      try {
        const result = await this.uploadSingleQSO(config, qso);
        if (result.status === 'created') {
          uploaded++;
        } else if (result.status === 'duplicate') {
          skipped++;
        } else {
          failed++;
          errors.push(`${qso.callsign}: ${result.message}`);
        }
      } catch (err) {
        failed++;
        errors.push(`${qso.callsign}: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    }

    // Update lastSyncTime on success
    if (uploaded > 0) {
      this.setConfig(callsign, { ...config, lastSyncTime: Date.now() });
    }

    return {
      uploaded,
      skipped,
      failed,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  async download(callsign: string, _options?: SyncDownloadOptions): Promise<SyncDownloadResult> {
    const config = this.getConfig(callsign);
    if (!config?.url || !config?.apiKey || !config?.stationId) {
      return { downloaded: 0, matched: 0, updated: 0, errors: ['WaveLog not configured'] };
    }

    try {
      const records = await this.downloadQSOs(config);
      let stored = 0;
      let skipped = 0;

      for (const remoteQSO of records) {
        try {
          // Check for existing QSO with same callsign and time
          const existing = await this.ctx.logbook.queryQSOs({
            callsign: remoteQSO.callsign,
            timeRange: {
              start: remoteQSO.startTime,
              end: remoteQSO.endTime || remoteQSO.startTime,
            },
            limit: 1,
          });

          if (existing.length > 0) {
            skipped++;
          } else {
            await this.ctx.logbook.addQSO(remoteQSO);
            stored++;
          }
        } catch (err) {
          this.ctx.log.warn('Failed to process downloaded QSO', {
            callsign: remoteQSO.callsign,
            error: err instanceof Error ? err.message : String(err),
          });
          skipped++;
        }
      }

      if (stored > 0) {
        this.ctx.logbook.notifyUpdated();
      }

      return {
        downloaded: records.length,
        matched: skipped,
        updated: stored,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Download failed';
      return { downloaded: 0, matched: 0, updated: 0, errors: [message] };
    }
  }

  // ===== HTTP client methods (extracted from WaveLogService) =====

  async fetchStationList(url: string, apiKey: string): Promise<any[]> {
    const endpoint = `${url.replace(/\/$/, '')}/index.php/api/station_info/${apiKey}`;

    let response: Response;
    try {
      response = await this.doFetch(endpoint, { method: 'GET', timeout: 10000 });
    } catch (err) {
      throw this.wrapNetworkError(err, endpoint);
    }

    if (!response.ok) {
      if (response.status === 401) throw new Error('Invalid API key');
      if (response.status === 404) throw new Error('WaveLog API endpoint not found, check URL');
      throw new Error(`HTTP error ${response.status}: ${response.statusText}`);
    }

    const stations = await response.json();
    if (!Array.isArray(stations)) {
      throw new Error('WaveLog returned invalid station data format');
    }

    return stations.map((s: any) => ({
      station_id: s.station_id?.toString() ?? '',
      station_profile_name: s.station_profile_name ?? '',
      station_callsign: s.station_callsign ?? '',
      station_gridsquare: s.station_gridsquare ?? '',
      station_city: s.station_city ?? '',
      station_country: s.station_country ?? '',
    }));
  }

  private async uploadSingleQSO(config: WaveLogPluginConfig, qso: QSORecord): Promise<UploadResult> {
    const adifString = convertQSOToADIF(qso);

    const payload = {
      key: config.apiKey,
      station_profile_id: config.stationId,
      type: 'adif',
      string: adifString,
    };

    this.ctx.log.debug('Uploading QSO', {
      callsign: qso.callsign,
      mode: qso.mode,
      frequency: qso.frequency,
    });

    const url = `${config.url.replace(/\/$/, '')}/index.php/api/qso`;
    let response: Response;
    try {
      response = await this.doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        timeout: 10000,
      });
    } catch (err) {
      throw this.wrapNetworkError(err, url);
    }

    const text = await response.text();
    this.ctx.log.debug('Upload response', { status: response.status, body: text });

    let result: any;
    try {
      result = JSON.parse(text);
    } catch {
      if (text.includes('<html>')) throw new Error('WaveLog URL error or server returned HTML');
      throw new Error('WaveLog returned invalid response format');
    }

    if (response.ok && result.status === 'created') {
      return { success: true, status: 'created', message: 'Upload successful' };
    }

    const message = this.extractMessage(result, `HTTP error ${response.status}`);

    if (this.isDuplicate(result, message)) {
      this.ctx.log.info('Duplicate QSO', { callsign: qso.callsign, message });
      return { success: true, status: 'duplicate', message };
    }

    this.ctx.log.warn('QSO upload rejected', { callsign: qso.callsign, message });
    return { success: false, status: 'failed', message };
  }

  private async downloadQSOs(config: WaveLogPluginConfig): Promise<QSORecord[]> {
    const url = `${config.url.replace(/\/$/, '')}/index.php/api/get_contacts_adif`;
    const payload = {
      key: config.apiKey,
      station_id: config.stationId,
      fetchfromid: 0,
    };

    let response: Response;
    try {
      response = await this.doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        timeout: 15000,
      });
    } catch (err) {
      throw this.wrapNetworkError(err, url);
    }

    if (!response.ok) {
      if (response.status === 401) throw new Error('Invalid API key');
      if (response.status === 404) throw new Error('WaveLog export API endpoint not found');
      throw new Error(`HTTP error ${response.status}: ${response.statusText}`);
    }

    const text = await response.text();
    let result: any;
    try {
      result = JSON.parse(text);
    } catch {
      throw new Error('WaveLog returned invalid JSON response');
    }

    if (result?.message?.toLowerCase().includes('error')) {
      throw new Error(result.message);
    }

    const adifContent = result.adif ?? '';
    if (!adifContent || adifContent.trim().length === 0) {
      return [];
    }

    const records = parseADIFContent(adifContent, 'wavelog');
    this.ctx.log.info('Downloaded QSO records', {
      count: records.length,
      exportedQsos: result.exported_qsos ?? 0,
    });
    return records;
  }

  // ===== Network helpers =====

  private async doFetch(url: string, options: {
    method: string;
    headers?: Record<string, string>;
    body?: string;
    timeout?: number;
  }): Promise<Response> {
    const fetchFn = this.ctx.fetch;
    if (!fetchFn) {
      throw new Error('Network access not available (missing "network" permission)');
    }

    return fetchFn(url, {
      method: options.method,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'TX5DR-WaveLogSync/1.0',
        ...options.headers,
      },
      body: options.body,
      signal: AbortSignal.timeout(options.timeout ?? 10000),
    });
  }

  private wrapNetworkError(err: unknown, url: string): Error {
    const e = err as any;
    if (e?.name === 'AbortError' || e?.code === 'ABORT_ERR') {
      return new Error('Connection timeout: WaveLog server response too slow');
    }
    if (e?.code === 'UND_ERR_SOCKET') {
      if (e.cause?.message?.includes('ECONNREFUSED')) {
        return new Error(`Connection refused: cannot connect to ${url}`);
      }
      if (e.cause?.message?.includes('ENOTFOUND')) {
        return new Error(`DNS resolution failed: ${url} not found`);
      }
      return new Error(`Network error: ${e.cause?.message ?? e.message}`);
    }
    if (e?.message?.includes('fetch failed')) {
      return new Error('Network request failed: check URL, network, and firewall');
    }
    return new Error(`WaveLog connection failed: ${e?.message ?? 'Unknown error'}`);
  }

  private extractMessage(result: any, fallback: string): string {
    const parts: string[] = [];
    if (typeof result?.reason === 'string') parts.push(result.reason);
    if (typeof result?.message === 'string') parts.push(result.message);
    if (Array.isArray(result?.messages)) {
      for (const item of result.messages) {
        if (typeof item === 'string') parts.push(item);
      }
    }
    const normalized = parts
      .map(m => m.replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim())
      .filter(m => m.length > 0);
    return normalized.length > 0 ? normalized.join(' | ') : fallback;
  }

  private isDuplicate(result: any, message: string): boolean {
    if (typeof message !== 'string' || !message.toLowerCase().includes('duplicate')) return false;
    return result?.status === 'abort' || result?.status === 'duplicate';
  }
}
