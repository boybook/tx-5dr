/* eslint-disable @typescript-eslint/no-explicit-any */
// QRZSyncProvider — HTTP response handling requires any

import type {
  PluginContext,
  LogbookSyncProvider,
  SyncAction,
  SyncTestResult,
  SyncUploadResult,
  SyncDownloadResult,
  SyncDownloadOptions,
  SyncUploadOptions,
} from '@tx5dr/plugin-api';
import type { QSORecord } from '@tx5dr/contracts';
import { convertQSOToADIF, parseADIFFields, parseADIFRecord, normalizeCallsign } from '@tx5dr/plugin-api';

const QRZ_API_URL = 'https://logbook.qrz.com/api';
const QRZ_USER_AGENT = 'TX5DR-QRZSync/1.0';
const QRZ_REQUEST_TIMEOUT_MS = 15000;
const QRZ_FETCH_TIMEOUT_MS = 30000;
const QRZ_FETCH_PAGE_SIZE = 250;

/**
 * Per-callsign QRZ configuration stored in plugin KVStore.
 */
export interface QRZPluginConfig {
  apiKey: string;
  autoUploadQSO: boolean;
  lastSyncTime?: number;
}

type UploadStatus = 'created' | 'replaced' | 'failed';

interface UploadResult {
  success: boolean;
  status: UploadStatus;
  message: string;
}

type QRZFetchPage = {
  count: number;
  records: QSORecord[];
  nextAfterLogId: number | null;
};

const CONFIG_KEY_PREFIX = 'config:';

/**
 * QRZ.com sync provider — implements LogbookSyncProvider.
 *
 * Manages per-callsign configuration in the plugin's global KVStore
 * and communicates with QRZ.com Logbook API for QSO upload/download.
 */
export class QRZSyncProvider implements LogbookSyncProvider {
  readonly id = 'qrz';
  readonly displayName = 'QRZ.com';
  readonly color = 'warning' as const;
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
    // Use normalizeCallsign so save (via requireBoundCallsign) and read paths
    // resolve to the same key for suffixed callsigns like "W1ABC/P".
    return `${CONFIG_KEY_PREFIX}${normalizeCallsign(callsign)}`;
  }

  /** Read per-callsign config from KVStore (synchronous — KVStore is in-memory). */
  getConfig(callsign: string): QRZPluginConfig | null {
    return this.ctx.store.global.get<QRZPluginConfig | undefined>(this.configKey(callsign)) ?? null;
  }

  /** Write per-callsign config to KVStore (synchronous write, async flush). */
  setConfig(callsign: string, config: QRZPluginConfig): void {
    this.ctx.store.global.set(this.configKey(callsign), config);
  }

  // ===== LogbookSyncProvider implementation =====

  isConfigured(callsign: string): boolean {
    const config = this.getConfig(callsign);
    return !!config?.apiKey;
  }

  isAutoUploadEnabled(callsign: string): boolean {
    const config = this.getConfig(callsign);
    return !!(config?.apiKey && config.autoUploadQSO);
  }

  async testConnection(callsign: string): Promise<SyncTestResult> {
    const config = this.getConfig(callsign);
    if (!config?.apiKey) {
      return { success: false, message: 'API key is required' };
    }

    try {
      const result = await this.fetchStatus(config.apiKey);
      return {
        success: true,
        message: 'Connection successful',
        details: {
          callsign: result.callsign,
          logbookCount: result.logbookCount,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Connection failed';
      this.ctx.log.error('Connection test failed', err);
      return { success: false, message };
    }
  }

  async upload(callsign: string, options?: SyncUploadOptions): Promise<SyncUploadResult> {
    const config = this.getConfig(callsign);
    if (!config?.apiKey) {
      return { uploaded: 0, skipped: 0, failed: 0, errors: ['QRZ not configured'] };
    }
    const logbook = this.ctx.logbook.forCallsign(callsign);

    const qsos = options?.records
      ? options.records.filter((qso) => qso.qrzQslSent !== 'Y')
      : await this.queryPendingQsos(logbook);

    if (qsos.length === 0) {
      return { uploaded: 0, skipped: 0, failed: 0 };
    }

    let uploaded = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const qso of qsos) {
      try {
        const result = await this.uploadSingleQSO(config.apiKey, qso);
        if (result.status === 'created' || result.status === 'replaced') {
          uploaded++;
          // Update QSL sent status
          await logbook.updateQSO(qso.id, {
            qrzQslSent: 'Y',
            qrzQslSentDate: Date.now(),
          });
        } else {
          failed++;
          errors.push(`${qso.callsign}: ${result.message}`);
        }
      } catch (err) {
        failed++;
        errors.push(`${qso.callsign}: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    }

    if (uploaded > 0) {
      this.setConfig(callsign, { ...config, lastSyncTime: Date.now() });
      await logbook.notifyUpdated();
    }

    return {
      uploaded,
      skipped: 0,
      failed,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  private async queryPendingQsos(
    logbook: ReturnType<PluginContext['logbook']['forCallsign']>,
  ): Promise<QSORecord[]> {
    // Manual upload scans the logbook so historical unsent records are still covered.
    const allQsos = await logbook.queryQSOs({});
    return allQsos.filter((qso) => qso.qrzQslSent !== 'Y');
  }

  async download(callsign: string, _options?: SyncDownloadOptions): Promise<SyncDownloadResult> {
    const config = this.getConfig(callsign);
    if (!config?.apiKey) {
      return { downloaded: 0, matched: 0, updated: 0, errors: ['QRZ not configured'] };
    }
    const logbook = this.ctx.logbook.forCallsign(callsign);

    try {
      const records = await this.downloadQSOs(config.apiKey);
      let stored = 0;
      let matched = 0;

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
            // Update QSL received status on matched QSO
            await logbook.updateQSO(existing[0].id, {
              qrzQslReceived: 'Y',
              qrzQslReceivedDate: Date.now(),
            });
            matched++;
          } else {
            await logbook.addQSO(remoteQSO);
            stored++;
          }
        } catch (err) {
          this.ctx.log.warn('Failed to process downloaded QSO', {
            callsign: remoteQSO.callsign,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (stored > 0 || matched > 0) {
        await logbook.notifyUpdated();
      }

      return {
        downloaded: records.length,
        matched,
        updated: stored,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Download failed';
      return { downloaded: 0, matched: 0, updated: 0, errors: [message] };
    }
  }

  // ===== QRZ API methods =====

  /**
   * Test connection using ACTION=STATUS.
   * Exposed for use by the page handler's testConnection action.
   */
  async fetchStatus(apiKey: string): Promise<{ callsign?: string; logbookCount?: number }> {
    const params = {
      KEY: apiKey,
      ACTION: 'STATUS',
    };

    let response: Response;
    try {
      response = await this.postToQRZ(params, QRZ_REQUEST_TIMEOUT_MS);
    } catch (err) {
      throw this.wrapNetworkError(err);
    }

    if (!response.ok) {
      throw new Error(`HTTP error ${response.status}: ${response.statusText}`);
    }

    const responseText = await response.text();
    this.ctx.log.debug('STATUS response', { body: responseText });

    const parsed = this.parseQRZResponse(responseText);

    if (parsed.RESULT === 'OK') {
      return {
        callsign: parsed.CALLSIGN,
        logbookCount: parsed.COUNT ? parseInt(parsed.COUNT, 10) : undefined,
      };
    } else if (parsed.RESULT === 'AUTH' || parsed.RESULT === 'FAIL') {
      throw new Error(parsed.REASON || 'Invalid API key or request failed');
    } else {
      throw new Error(`Unknown response: ${responseText}`);
    }
  }

  private async uploadSingleQSO(apiKey: string, qso: QSORecord): Promise<UploadResult> {
    const adifString = convertQSOToADIF(qso);

    this.ctx.log.debug('Uploading QSO', {
      callsign: qso.callsign,
      mode: qso.mode,
      frequency: qso.frequency,
    });

    const params = {
      KEY: apiKey,
      ACTION: 'INSERT',
      ADIF: adifString,
    };

    let response: Response;
    try {
      response = await this.postToQRZ(params, QRZ_REQUEST_TIMEOUT_MS);
    } catch (err) {
      throw this.wrapNetworkError(err);
    }

    const responseText = await response.text();
    this.ctx.log.debug('INSERT response', { status: response.status, body: responseText });

    const parsed = this.parseQRZResponse(responseText);

    if (parsed.RESULT === 'OK') {
      return { success: true, status: 'created', message: 'Upload successful' };
    } else if (parsed.RESULT === 'REPLACE') {
      return { success: true, status: 'replaced', message: 'Existing record replaced' };
    } else {
      const message = parsed.REASON || `Upload failed: ${responseText}`;
      this.ctx.log.warn('QSO upload rejected', { callsign: qso.callsign, message });
      return { success: false, status: 'failed', message };
    }
  }

  private async downloadQSOs(apiKey: string): Promise<QSORecord[]> {
    const records: QSORecord[] = [];
    let afterLogId = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const option = this.buildFetchOption({ afterLogId, max: QRZ_FETCH_PAGE_SIZE });
      const params: Record<string, string> = {
        KEY: apiKey,
        ACTION: 'FETCH',
        OPTION: option,
      };

      this.ctx.log.debug('Fetching QRZ page', {
        afterLogId,
        pageSize: QRZ_FETCH_PAGE_SIZE,
      });

      let response: Response;
      try {
        response = await this.postToQRZ(params, QRZ_FETCH_TIMEOUT_MS);
      } catch (err) {
        throw this.wrapNetworkError(err);
      }

      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}: ${response.statusText}`);
      }

      const responseText = await response.text();
      this.ctx.log.debug('FETCH response length', { bytes: responseText.length });

      const parsed = this.parseQRZResponse(responseText);

      if (parsed.RESULT === 'FAIL' || parsed.RESULT === 'AUTH') {
        throw new Error(parsed.REASON || 'QRZ API request failed');
      }

      if (parsed.RESULT !== 'OK') {
        throw new Error(`Unknown QRZ response: ${responseText}`);
      }

      const adifData = parsed.ADIF || '';
      if (!adifData || adifData.trim().length === 0) {
        this.ctx.log.debug('No QSO data returned for current page', {
          afterLogId,
          totalCount: parsed.COUNT ? Number.parseInt(parsed.COUNT, 10) : undefined,
        });
        break;
      }

      const page = this.parseFetchAdifPage(adifData);
      records.push(...page.records);

      this.ctx.log.info('Downloaded QRZ page', {
        pageCount: page.count,
        totalCount: parsed.COUNT ? Number.parseInt(parsed.COUNT, 10) : undefined,
        nextAfterLogId: page.nextAfterLogId,
      });

      if (page.count < QRZ_FETCH_PAGE_SIZE) {
        break;
      }

      if (page.nextAfterLogId === null || page.nextAfterLogId <= afterLogId) {
        throw new Error('QRZ paging failed: missing or invalid app_qrzlog_logid');
      }

      afterLogId = page.nextAfterLogId;
    }

    this.ctx.log.info('Downloaded QSO records from QRZ', { count: records.length });
    return records;
  }

  // ===== QRZ response parsing =====

  /**
   * Parse QRZ response format.
   * QRZ responses are name-value pairs separated by &, e.g.: RESULT=OK&COUNT=5&LOGIDS=123,456
   * Responses may also contain newlines and a nested DATA field.
   */
  private parseQRZResponse(text: string): Record<string, string> {
    const result = this.parseNameValuePairs(text);
    const nestedData = result.DATA;

    if (nestedData?.includes('=')) {
      const nestedPairs = this.parseNameValuePairs(nestedData);
      for (const [key, value] of Object.entries(nestedPairs)) {
        if (!(key in result)) {
          result[key] = value;
        }
      }
    }

    return result;
  }

  private parseNameValuePairs(text: string): Record<string, string> {
    const result: Record<string, string> = {};
    const cleaned = text.trim();
    const keyRegex = /(?:^|&)([A-Z_]+)=/g;
    const matches = Array.from(cleaned.matchAll(keyRegex));

    for (let index = 0; index < matches.length; index += 1) {
      const match = matches[index];
      const key = match[1];
      const valueStart = (match.index ?? 0) + match[0].length;
      const nextMatch = matches[index + 1];
      const valueEnd = nextMatch ? (nextMatch.index ?? cleaned.length) : cleaned.length;
      const value = cleaned.substring(valueStart, valueEnd).trim();
      result[key] = value;
    }

    return result;
  }

  private buildFetchOption(options: {
    afterLogId?: number;
    max?: number;
  }): string {
    return [
      'TYPE:ADIF',
      `MAX:${options.max ?? QRZ_FETCH_PAGE_SIZE}`,
      `AFTERLOGID:${options.afterLogId ?? 0}`,
    ].join(',');
  }

  private parseFetchAdifPage(adifData: string): QRZFetchPage {
    const eohIndex = adifData.search(/<eoh>/i);
    const body = eohIndex >= 0 ? adifData.substring(eohIndex + 5) : adifData;
    const recordStrings = body.split(/<eor>/i).filter(record => record.trim().length > 0);
    const records: QSORecord[] = [];
    let highestLogId: number | null = null;

    for (const recordStr of recordStrings) {
      const parsedRecord = parseADIFRecord(recordStr, 'qrz');
      if (!parsedRecord) {
        continue;
      }

      records.push(parsedRecord);

      const fields = parseADIFFields(recordStr);
      const rawLogId = fields.app_qrzlog_logid;
      if (!rawLogId) {
        continue;
      }

      const parsedLogId = Number.parseInt(rawLogId, 10);
      if (Number.isFinite(parsedLogId) && (highestLogId === null || parsedLogId > highestLogId)) {
        highestLogId = parsedLogId;
      }
    }

    return {
      count: records.length,
      records,
      nextAfterLogId: highestLogId === null ? null : highestLogId + 1,
    };
  }

  // ===== Network helpers =====

  private async postToQRZ(params: Record<string, string>, timeoutMs: number): Promise<Response> {
    const fetchFn = this.ctx.fetch;
    if (!fetchFn) {
      throw new Error('Network access not available (missing "network" permission)');
    }

    return fetchFn(QRZ_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': QRZ_USER_AGENT,
      },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  private wrapNetworkError(err: unknown): Error {
    const e = err as any;
    if (e?.name === 'AbortError' || e?.name === 'TimeoutError' || e?.code === 'ABORT_ERR') {
      return new Error('Connection timeout: QRZ server response too slow');
    }
    if (e?.code === 'UND_ERR_SOCKET') {
      if (e.cause?.message?.includes('ECONNREFUSED')) {
        return new Error('Connection refused: cannot connect to QRZ server');
      }
      if (e.cause?.message?.includes('ENOTFOUND')) {
        return new Error('DNS resolution failed: QRZ server not found');
      }
      return new Error(`Network error: ${e.cause?.message ?? e.message}`);
    }
    if (e?.message?.includes('fetch failed')) {
      return new Error('Network request failed: check network connection and firewall');
    }
    return new Error(`QRZ connection failed: ${e?.message ?? 'Unknown error'}`);
  }
}
