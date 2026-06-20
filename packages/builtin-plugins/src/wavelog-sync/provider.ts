/* eslint-disable @typescript-eslint/no-explicit-any */
// WaveLogSyncProvider — HTTP response handling requires any

import type {
  PluginContext,
  LogbookSyncProvider,
  SyncAction,
  SyncTestResult,
  SyncUploadResult,
  SyncDownloadResult,
  SyncDownloadOptions,
  SyncUploadOptions,
  SyncFailure,
} from '@tx5dr/plugin-api';
import type { QSORecord } from '@tx5dr/contracts';
import {
  convertQSOToADIF,
  createSyncFailure,
  errorToSyncFailure,
  parseADIFContent,
  normalizeCallsign,
  sanitizeSyncFailureText,
} from '@tx5dr/plugin-api';

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

type BatchUploadStatus = 'created' | 'fallback' | 'failed';

interface BatchUploadResult {
  success: boolean;
  status: BatchUploadStatus;
  message: string;
}

const CONFIG_KEY_PREFIX = 'config:';
const WAVELOG_BATCH_MAX_QSOS = 100;
const WAVELOG_BATCH_MAX_PAYLOAD_BYTES = 512 * 1024;

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
  readonly accessScope = 'operator' as const;
  readonly settingsPageId = 'settings';
  readonly actions: SyncAction[] = [
    { id: 'download', label: 'Download', icon: 'download', operation: 'download' },
    { id: 'upload', label: 'Upload', icon: 'upload', operation: 'upload' },
    { id: 'full_sync', label: 'Full Sync', icon: 'sync', operation: 'full_sync' },
  ];

  constructor(private ctx: PluginContext) {}

  // ===== Config helpers =====

  private configKey(callsign: string): string {
    // Use normalizeCallsign so writes (via requireBoundCallsign in index.ts,
    // which already normalizes) and reads always resolve to the same key,
    // regardless of suffixes like "/P" or "/MM".
    return `${CONFIG_KEY_PREFIX}${normalizeCallsign(callsign)}`;
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
      const failure = this.createFailure('wavelog_not_configured', 'URL and API key are required', {
        operation: 'test_connection',
      });
      return { success: false, message: failure.message, failures: [failure] };
    }

    try {
      const stations = await this.fetchStationList(config.url, config.apiKey);
      return {
        success: true,
        message: 'Connection successful',
        details: { stations },
      };
    } catch (err) {
      const failure = this.errorFailure(err, 'test_connection', 'wavelog_connection_failed', config);
      this.ctx.log.error('Connection test failed', err);
      return { success: false, message: failure.message, failures: [failure] };
    }
  }

  async upload(callsign: string, options?: SyncUploadOptions): Promise<SyncUploadResult> {
    const config = this.getConfig(callsign);
    if (!config?.url || !config?.apiKey || !config?.stationId) {
      return {
        uploaded: 0,
        skipped: 0,
        failed: 0,
        failures: [
          this.createFailure('wavelog_not_configured', 'WaveLog not configured', {
            operation: 'upload',
          }),
        ],
      };
    }
    const logbook = this.ctx.logbook.forCallsign(callsign);

    const qsos = options?.records
      ? options.records
      : await this.queryPendingQsos(logbook, config.lastSyncTime);

    let uploaded = 0;
    let skipped = 0;
    let failed = 0;
    const failures: SyncFailure[] = [];

    if (qsos.length === 1) {
      const result = await this.uploadQsosIndividually(config, qsos, failures);
      uploaded += result.uploaded;
      skipped += result.skipped;
      failed += result.failed;
    } else {
      for (const chunk of this.chunkQsos(config, qsos)) {
        try {
          const result = await this.uploadQsoBatch(config, chunk);
          if (result.status === 'created') {
            uploaded += chunk.length;
          } else if (result.status === 'fallback') {
            const fallbackResult = await this.uploadQsosIndividually(config, chunk, failures);
            uploaded += fallbackResult.uploaded;
            skipped += fallbackResult.skipped;
            failed += fallbackResult.failed;
          } else {
            failed += chunk.length;
            this.pushBatchFailures(chunk, failures, 'wavelog_upload_rejected', result.message, config);
          }
        } catch (err) {
          failed += chunk.length;
          this.pushBatchFailures(
            chunk,
            failures,
            'wavelog_upload_failed',
            err instanceof Error ? err.message : 'Unknown error',
            config,
          );
        }
      }
    }

    // Advance cursor only when the whole batch has no failed records.
    if (failed === 0 && (uploaded > 0 || skipped > 0)) {
      this.setConfig(callsign, { ...config, lastSyncTime: Date.now() });
    }

    return {
      uploaded,
      skipped,
      failed,
      failures: failures.length > 0 ? failures : undefined,
    };
  }

  private async queryPendingQsos(
    logbook: ReturnType<PluginContext['logbook']['forCallsign']>,
    lastSyncTime?: number,
  ): Promise<QSORecord[]> {
    // Manual upload keeps the existing cursor-based history scan.
    const since = typeof lastSyncTime === 'number' ? lastSyncTime : 0;
    return logbook.queryQSOs({
      timeRange: { start: since, end: Date.now() },
    });
  }

  async download(callsign: string, _options?: SyncDownloadOptions): Promise<SyncDownloadResult> {
    const config = this.getConfig(callsign);
    if (!config?.url || !config?.apiKey || !config?.stationId) {
      return {
        downloaded: 0,
        matched: 0,
        updated: 0,
        failures: [
          this.createFailure('wavelog_not_configured', 'WaveLog not configured', {
            operation: 'download',
          }),
        ],
      };
    }
    const logbook = this.ctx.logbook.forCallsign(callsign);

    try {
      const records = await this.downloadQSOs(config);
      let stored = 0;
      let skipped = 0;
      const failures: SyncFailure[] = [];

      for (const remoteQSO of records) {
        try {
          // Check for existing QSO with same callsign and time
          const existing = await logbook.queryQSOs({
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
            await logbook.addQSO(remoteQSO);
            stored++;
          }
        } catch (err) {
          failures.push(createSyncFailure({
            code: 'wavelog_download_logbook_failed',
            message: err instanceof Error ? err.message : 'Failed to process downloaded QSO',
            source: 'logbook',
            operation: 'download',
            providerId: this.id,
            qsoId: remoteQSO.id,
            qsoCallsign: remoteQSO.callsign,
            secrets: [config.apiKey],
          }));
          this.ctx.log.warn('Failed to process downloaded QSO', {
            callsign: remoteQSO.callsign,
            error: err instanceof Error ? err.message : String(err),
          });
          skipped++;
        }
      }

      if (stored > 0) {
        await logbook.notifyUpdated();
      }

      return {
        downloaded: records.length,
        matched: skipped,
        updated: stored,
        failures: failures.length > 0 ? failures : undefined,
      };
    } catch (err) {
      return {
        downloaded: 0,
        matched: 0,
        updated: 0,
        failures: [this.errorFailure(err, 'download', 'wavelog_download_failed', config)],
      };
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
      throw new Error(await this.extractHttpErrorMessage(response, {
        fallback: `HTTP error ${response.status}: ${response.statusText}`,
        unauthorized: 'Invalid API key',
        notFound: 'WaveLog API endpoint not found, check URL',
        secrets: [apiKey],
      }));
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

  private async uploadQsosIndividually(
    config: WaveLogPluginConfig,
    qsos: QSORecord[],
    failures: SyncFailure[],
  ): Promise<Pick<SyncUploadResult, 'uploaded' | 'skipped' | 'failed'>> {
    let uploaded = 0;
    let skipped = 0;
    let failed = 0;

    for (const qso of qsos) {
      try {
        const result = await this.uploadSingleQSO(config, qso);
        if (result.status === 'created') {
          uploaded++;
        } else if (result.status === 'duplicate') {
          skipped++;
        } else {
          failed++;
          failures.push(this.createQsoFailure(qso, 'wavelog_upload_rejected', result.message, config));
        }
      } catch (err) {
        failed++;
        failures.push(this.createQsoFailure(
          qso,
          'wavelog_upload_failed',
          err instanceof Error ? err.message : 'Unknown error',
          config,
        ));
      }
    }

    return { uploaded, skipped, failed };
  }

  private buildBatchAdif(qsos: QSORecord[]): string {
    return qsos.map(qso => convertQSOToADIF(qso)).join('\n');
  }

  private chunkQsos(config: WaveLogPluginConfig, qsos: QSORecord[]): QSORecord[][] {
    const chunks: QSORecord[][] = [];
    let current: QSORecord[] = [];
    let currentAdifParts: string[] = [];

    for (const qso of qsos) {
      const adif = convertQSOToADIF(qso);
      const candidateAdifParts = [...currentAdifParts, adif];
      const candidatePayloadBytes = this.estimateBatchPayloadBytes(config, candidateAdifParts.join('\n'));
      const shouldStartNextChunk = current.length > 0
        && (current.length >= WAVELOG_BATCH_MAX_QSOS || candidatePayloadBytes > WAVELOG_BATCH_MAX_PAYLOAD_BYTES);

      if (shouldStartNextChunk) {
        chunks.push(current);
        current = [qso];
        currentAdifParts = [adif];
      } else {
        current.push(qso);
        currentAdifParts = candidateAdifParts;
      }
    }

    if (current.length > 0) {
      chunks.push(current);
    }

    return chunks;
  }

  private estimateBatchPayloadBytes(config: WaveLogPluginConfig, adifString: string): number {
    return new TextEncoder().encode(JSON.stringify({
      key: config.apiKey,
      station_profile_id: config.stationId,
      type: 'adif',
      string: adifString,
    })).length;
  }

  private pushBatchFailures(
    qsos: QSORecord[],
    failures: SyncFailure[],
    code: string,
    message: string,
    config: WaveLogPluginConfig,
  ): void {
    for (const qso of qsos) {
      failures.push(this.createQsoFailure(qso, code, message, config));
    }
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
      const detail = this.sanitizeResponseText(text, [config.apiKey]);
      if (text.includes('<html>')) throw new Error(`WaveLog URL error or server returned HTML: ${detail}`);
      throw new Error(`WaveLog returned invalid response format: ${detail}`);
    }

    if (response.ok && result.status === 'created') {
      return { success: true, status: 'created', message: 'Upload successful' };
    }

    const message = this.extractMessage(result, `HTTP error ${response.status}: ${response.statusText}`);

    if (this.isDuplicate(result, message)) {
      this.ctx.log.info('Duplicate QSO', { callsign: qso.callsign, message });
      return { success: true, status: 'duplicate', message };
    }

    this.ctx.log.warn('QSO upload rejected', { callsign: qso.callsign, message });
    return { success: false, status: 'failed', message };
  }

  private async uploadQsoBatch(config: WaveLogPluginConfig, qsos: QSORecord[]): Promise<BatchUploadResult> {
    const adifString = this.buildBatchAdif(qsos);
    const payload = {
      key: config.apiKey,
      station_profile_id: config.stationId,
      type: 'adif',
      string: adifString,
    };

    this.ctx.log.debug('Uploading QSO batch', {
      count: qsos.length,
      payloadBytes: this.estimateBatchPayloadBytes(config, adifString),
    });

    const url = `${config.url.replace(/\/$/, '')}/index.php/api/qso`;
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

    const text = await response.text();
    this.ctx.log.debug('Batch upload response', { status: response.status, body: text });

    let result: any;
    try {
      result = JSON.parse(text);
    } catch {
      const detail = this.sanitizeResponseText(text, [config.apiKey]);
      if (text.includes('<html>')) throw new Error(`WaveLog URL error or server returned HTML: ${detail}`);
      throw new Error(`WaveLog returned invalid response format: ${detail}`);
    }

    const message = this.extractMessage(result, `HTTP error ${response.status}: ${response.statusText}`);
    const adifCount = this.toNumber(result?.adif_count);
    const adifErrors = this.toNumber(result?.adif_errors);

    if (response.ok && result.status === 'created' && adifErrors === 0 && adifCount === qsos.length) {
      return { success: true, status: 'created', message: 'Upload successful' };
    }

    if (
      (response.ok && result.status === 'created')
      || (response.status === 400 && result.status === 'abort')
    ) {
      const detail = response.ok
        ? `WaveLog parsed ${adifCount ?? 'unknown'} of ${qsos.length} QSOs`
        : message;
      this.ctx.log.warn('QSO batch needs single-record fallback', { count: qsos.length, message: detail });
      return { success: false, status: 'fallback', message: detail };
    }

    this.ctx.log.warn('QSO batch upload rejected', { count: qsos.length, message });
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
      throw new Error(await this.extractHttpErrorMessage(response, {
        fallback: `HTTP error ${response.status}: ${response.statusText}`,
        unauthorized: 'Invalid API key',
        notFound: 'WaveLog export API endpoint not found',
        secrets: [config.apiKey],
      }));
    }

    const text = await response.text();
    let result: any;
    try {
      result = JSON.parse(text);
    } catch {
      throw new Error(`WaveLog returned invalid JSON response: ${this.sanitizeResponseText(text, [config.apiKey])}`);
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
    const safeUrl = sanitizeSyncFailureText(url);
    if (e?.name === 'AbortError' || e?.code === 'ABORT_ERR') {
      return new Error('Connection timeout: WaveLog server response too slow');
    }
    if (e?.code === 'UND_ERR_SOCKET') {
      if (e.cause?.message?.includes('ECONNREFUSED')) {
        return new Error(`Connection refused: cannot connect to ${safeUrl}`);
      }
      if (e.cause?.message?.includes('ENOTFOUND')) {
        return new Error(`DNS resolution failed: ${safeUrl} not found`);
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

  private toNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
  }

  private isDuplicate(result: any, message: string): boolean {
    if (typeof message !== 'string' || !message.toLowerCase().includes('duplicate')) return false;
    return result?.status === 'abort' || result?.status === 'duplicate';
  }

  private createFailure(
    code: string,
    message: string,
    options: Partial<SyncFailure> & { secrets?: Array<string | undefined | null> } = {},
  ): SyncFailure {
    return createSyncFailure({
      code,
      message,
      source: options.source ?? 'provider',
      operation: options.operation,
      providerId: this.id,
      httpStatus: options.httpStatus,
      retryable: options.retryable,
      detail: options.detail,
      secrets: options.secrets,
    });
  }

  private errorFailure(
    err: unknown,
    operation: NonNullable<SyncFailure['operation']>,
    code: string,
    config?: WaveLogPluginConfig,
  ): SyncFailure {
    return errorToSyncFailure(err, {
      code,
      message: 'WaveLog sync failed',
      source: this.isNetworkError(err) ? 'network' : 'remote',
      operation,
      providerId: this.id,
      retryable: this.isNetworkError(err),
      secrets: [config?.apiKey],
    });
  }

  private createQsoFailure(
    qso: QSORecord,
    code: string,
    message: string,
    config: WaveLogPluginConfig,
  ): SyncFailure {
    return createSyncFailure({
      code,
      message,
      source: this.isNetworkMessage(message) ? 'network' : 'remote',
      operation: 'upload',
      providerId: this.id,
      qsoId: qso.id,
      qsoCallsign: qso.callsign,
      retryable: this.isNetworkMessage(message),
      secrets: [config.apiKey],
    });
  }

  private async extractHttpErrorMessage(
    response: Response,
    options: {
      fallback: string;
      unauthorized?: string;
      notFound?: string;
      secrets?: Array<string | undefined | null>;
    },
  ): Promise<string> {
    if (response.status === 401 && options.unauthorized) return options.unauthorized;
    if (response.status === 404 && options.notFound) return options.notFound;

    const text = await response.text().catch(() => '');
    let message = options.fallback;
    if (text) {
      try {
        message = this.extractMessage(JSON.parse(text), options.fallback);
      } catch {
        message = `${options.fallback}: ${this.sanitizeResponseText(text, options.secrets)}`;
      }
    }
    return sanitizeSyncFailureText(message, options.secrets);
  }

  private sanitizeResponseText(text: string, secrets: Array<string | undefined | null> = []): string {
    const stripped = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return sanitizeSyncFailureText(stripped.slice(0, 500) || 'empty response', secrets);
  }

  private isNetworkError(err: unknown): boolean {
    const e = err as any;
    return e?.name === 'AbortError'
      || e?.code === 'ABORT_ERR'
      || e?.code === 'UND_ERR_SOCKET'
      || this.isNetworkMessage(e?.message);
  }

  private isNetworkMessage(message: unknown): boolean {
    return typeof message === 'string'
      && /network|timeout|connection|dns|fetch failed|refused/i.test(message);
  }
}
