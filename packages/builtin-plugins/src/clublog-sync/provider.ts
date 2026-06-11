import type {
  LogbookSyncProvider,
  PluginContext,
  SyncAction,
  SyncDownloadResult,
  SyncFailure,
  SyncFailureOperation,
  SyncTestResult,
  SyncUploadOptions,
  SyncUploadPreflightOptions,
  SyncUploadPreflightResult,
  SyncUploadProgress,
  SyncUploadResult,
} from '@tx5dr/plugin-api';
import type { QSORecord } from '@tx5dr/contracts';
import {
  convertQSOToADIF,
  createSyncFailure,
  errorToSyncFailure,
  generateADIFFile,
  normalizeCallsign,
  sanitizeSyncFailureText,
} from '@tx5dr/plugin-api';
import { BUILTIN_CLUBLOG_API_KEY } from './generated/api-key.js';

const CONFIG_KEY_PREFIX = 'config:';
const LEDGER_KEY_PREFIX = 'ledger:';
const CLUBLOG_REALTIME_URL = 'https://clublog.org/realtime.php';
const CLUBLOG_BATCH_URL = 'https://clublog.org/putlogs.php';
const CLUBLOG_USER_AGENT = 'TX5DR-ClubLogSync/1.0';
const CLUBLOG_REQUEST_TIMEOUT_MS = 30000;

export interface ClubLogPluginConfig {
  email: string;
  password: string;
  autoUploadQSO: boolean;
  lastRealtimeUploadTime?: number;
  lastBatchUploadTime?: number;
}

type ClubLogLedgerStatus = 'realtime_ok' | 'duplicate' | 'modified' | 'batch_submitted';

type ClubLogUploadLedger = Record<string, {
  status: ClubLogLedgerStatus;
  uploadedAt: number;
  method: 'realtime' | 'batch';
  qsoId?: string;
  startTime: number;
  callsign: string;
}>;

type RealtimeStatus = 'ok' | 'duplicate' | 'modified' | 'rejected' | 'failed' | 'forbidden';

interface RealtimeResult {
  status: RealtimeStatus;
  message: string;
  retryable: boolean;
  httpStatus: number;
}

interface PreparedUpload {
  allQsos: QSORecord[];
  uploadableQsos: QSORecord[];
  skippedCount: number;
  blockedIssues: SyncUploadPreflightResult['issues'];
}

function normalizeLedgerPart(value: unknown): string {
  return String(value ?? '').trim().toUpperCase();
}

function qsoFingerprint(qso: QSORecord, fallbackCallsign: string): string {
  const station = normalizeLedgerPart(qso.myCallsign || fallbackCallsign);
  const call = normalizeLedgerPart(qso.callsign);
  const frequency = Number.isFinite(qso.frequency) ? String(Math.round(qso.frequency)) : '';
  const mode = normalizeLedgerPart(qso.mode);
  const submode = normalizeLedgerPart(qso.submode);
  return [station, call, String(qso.startTime || 0), frequency, mode, submode].join('|');
}

function secretsFor(config: ClubLogPluginConfig | null | undefined, apiKey?: string): string[] {
  return [config?.password, config?.email, apiKey].filter((value): value is string => !!value);
}

function sanitizeResponseText(value: string, secrets: string[]): string {
  return sanitizeSyncFailureText(value, secrets)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function ensureUppercaseEor(adif: string): string {
  return adif.replace(/<eor>\s*$/i, '<EOR>');
}

function isNetworkMessage(message: string): boolean {
  return /fetch failed|network|timeout|aborted|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT/i.test(message);
}

function forbiddenMessage(): string {
  return 'Club Log returned 403 Forbidden. Check the developer API key, account email, application password, callsign ownership, and whether Club Log has temporarily blocked this IP after repeated failed requests.';
}

function dateRangeFilter(options?: Pick<SyncUploadOptions | SyncUploadPreflightOptions, 'since' | 'until'>) {
  if (!options?.since && !options?.until) return undefined;
  return {
    start: options.since ?? 0,
    end: options.until ?? Date.now(),
  };
}

function missingQsoIssues(qso: QSORecord, boundCallsign: string): NonNullable<SyncUploadPreflightResult['issues']> {
  const issues: NonNullable<SyncUploadPreflightResult['issues']> = [];
  if (!qso.callsign?.trim()) {
    issues.push({ code: 'clublog_qso_callsign_missing', severity: 'error', message: 'QSO callsign is required', qsoId: qso.id });
  }
  if (!Number.isFinite(qso.startTime) || qso.startTime <= 0) {
    issues.push({ code: 'clublog_qso_time_missing', severity: 'error', message: 'QSO start time is required', qsoId: qso.id, qsoCallsign: qso.callsign });
  }
  if (!Number.isFinite(qso.frequency) || qso.frequency <= 0) {
    issues.push({ code: 'clublog_qso_frequency_missing', severity: 'error', message: 'QSO frequency is required', qsoId: qso.id, qsoCallsign: qso.callsign });
  }
  if (!qso.mode?.trim()) {
    issues.push({ code: 'clublog_qso_mode_missing', severity: 'error', message: 'QSO mode is required', qsoId: qso.id, qsoCallsign: qso.callsign });
  }
  if (qso.myCallsign && normalizeCallsign(qso.myCallsign) !== normalizeCallsign(boundCallsign)) {
    issues.push({
      code: 'clublog_qso_callsign_mismatch',
      severity: 'error',
      message: 'QSO station callsign does not match the selected logbook callsign',
      detail: `${qso.myCallsign} != ${boundCallsign}`,
      qsoId: qso.id,
      qsoCallsign: qso.callsign,
    });
  }
  return issues;
}

export class ClubLogSyncProvider implements LogbookSyncProvider {
  readonly id = 'clublog';
  readonly displayName = 'Club Log';
  readonly color = 'warning' as const;
  readonly accessScope = 'operator' as const;
  readonly settingsPageId = 'settings';
  readonly actions: SyncAction[] = [
    { id: 'upload', label: 'Upload', icon: 'upload', pageId: 'upload-wizard' },
  ];

  constructor(private ctx: PluginContext) {}

  private configKey(callsign: string): string {
    return `${CONFIG_KEY_PREFIX}${normalizeCallsign(callsign)}`;
  }

  private ledgerKey(callsign: string): string {
    return `${LEDGER_KEY_PREFIX}${normalizeCallsign(callsign)}`;
  }

  getConfig(callsign: string): ClubLogPluginConfig | null {
    return this.ctx.store.global.get<ClubLogPluginConfig | undefined>(this.configKey(callsign)) ?? null;
  }

  setConfig(callsign: string, config: ClubLogPluginConfig): void {
    this.ctx.store.global.set(this.configKey(callsign), config);
  }

  getApiKeyStatus(): { available: boolean } {
    return { available: this.resolveApiKey().length > 0 };
  }

  private resolveApiKey(): string {
    return process.env.TX5DR_CLUBLOG_API_KEY || BUILTIN_CLUBLOG_API_KEY || '';
  }

  private getLedger(callsign: string): ClubLogUploadLedger {
    return this.ctx.store.global.get<ClubLogUploadLedger | undefined>(this.ledgerKey(callsign)) ?? {};
  }

  private setLedger(callsign: string, ledger: ClubLogUploadLedger): void {
    this.ctx.store.global.set(this.ledgerKey(callsign), ledger);
  }

  private markUploaded(
    callsign: string,
    ledger: ClubLogUploadLedger,
    qso: QSORecord,
    status: ClubLogLedgerStatus,
    method: 'realtime' | 'batch',
  ): void {
    ledger[qsoFingerprint(qso, callsign)] = {
      status,
      uploadedAt: Date.now(),
      method,
      qsoId: qso.id,
      startTime: qso.startTime,
      callsign: qso.callsign,
    };
  }

  isConfigured(callsign: string): boolean {
    const config = this.getConfig(callsign);
    return !!(config?.email && config.password && this.resolveApiKey());
  }

  isAutoUploadEnabled(callsign: string): boolean {
    const config = this.getConfig(callsign);
    return !!(config?.email && config.password && config.autoUploadQSO && this.resolveApiKey());
  }

  async testConnection(callsign: string, overrideConfig?: ClubLogPluginConfig | null): Promise<SyncTestResult> {
    const config = overrideConfig ?? this.getConfig(callsign);
    const apiKey = this.resolveApiKey();
    if (!config?.email || !config.password) {
      const failure = this.createFailure('clublog_not_configured', 'Email and application password are required', {
        operation: 'test_connection',
        config,
        apiKey,
      });
      return { success: false, message: failure.message, failures: [failure], details: { apiKeyAvailable: !!apiKey } };
    }
    if (!apiKey) {
      const failure = this.createFailure('clublog_api_key_unavailable', 'Club Log API key is not available in this build', {
        operation: 'test_connection',
        config,
      });
      return { success: false, message: failure.message, failures: [failure], details: { apiKeyAvailable: false } };
    }

    try {
      const response = await this.doFetch(CLUBLOG_REALTIME_URL, { method: 'HEAD', timeout: 10000 });
      return {
        success: response.ok || response.status === 405 || response.status === 400,
        message: 'Club Log endpoint reachable. Credentials will be verified on first upload.',
        details: { apiKeyAvailable: true, httpStatus: response.status },
      };
    } catch (error) {
      this.ctx.log.error('Connection test failed', error);
      const failure = this.errorFailure(error, 'test_connection', 'clublog_connection_failed', config, apiKey);
      return { success: false, message: failure.message, failures: [failure], details: { apiKeyAvailable: true } };
    }
  }

  async getUploadPreflight(callsign: string, options?: SyncUploadPreflightOptions): Promise<SyncUploadPreflightResult> {
    const config = this.getConfig(callsign);
    const apiKey = this.resolveApiKey();
    const issues: NonNullable<SyncUploadPreflightResult['issues']> = [];

    if (!config?.email || !config.password) {
      issues.push({ code: 'clublog_not_configured', severity: 'error', message: 'Email and application password are required' });
    }
    if (!apiKey) {
      issues.push({ code: 'clublog_api_key_unavailable', severity: 'error', message: 'Club Log API key is not available in this build' });
    }

    const prepared = await this.prepareUpload(callsign, options);
    issues.push(...(prepared.blockedIssues ?? []));
    return {
      ready: issues.filter((issue) => issue.severity === 'error').length === 0 && prepared.uploadableQsos.length > 0,
      pendingCount: prepared.allQsos.length,
      uploadableCount: prepared.uploadableQsos.length,
      blockedCount: prepared.blockedIssues?.length ?? 0,
      issues: issues.length > 0 ? issues : undefined,
      canSkipBlocked: (prepared.blockedIssues?.length ?? 0) > 0 && prepared.uploadableQsos.length > 0,
      guidance: ['Batch uploads are queued by Club Log; check Club Log for final import results.'],
    };
  }

  async upload(callsign: string, options?: SyncUploadOptions): Promise<SyncUploadResult> {
    const config = this.getConfig(callsign);
    const apiKey = this.resolveApiKey();
    if (!config?.email || !config.password) {
      return this.failureUploadResult(this.createFailure('clublog_not_configured', 'Club Log not configured', {
        operation: 'upload',
        config,
        apiKey,
      }));
    }
    if (!apiKey) {
      return this.failureUploadResult(this.createFailure('clublog_api_key_unavailable', 'Club Log API key is not available in this build', {
        operation: 'upload',
        config,
      }));
    }

    if (options?.trigger === 'auto' && options.records) {
      return this.uploadRealtime(callsign, config, apiKey, options);
    }

    return this.uploadBatch(callsign, config, apiKey, options);
  }

  async download(_callsign: string): Promise<SyncDownloadResult> {
    return {
      downloaded: 0,
      matched: 0,
      updated: 0,
      failures: [this.createFailure('clublog_download_unsupported', 'Club Log download sync is not supported', {
        operation: 'download',
      })],
    };
  }

  private async uploadRealtime(
    callsign: string,
    config: ClubLogPluginConfig,
    apiKey: string,
    options: SyncUploadOptions,
  ): Promise<SyncUploadResult> {
    const ledger = this.getLedger(callsign);
    const records = options.records ?? [];
    let uploaded = 0;
    let skipped = 0;
    let failed = 0;
    const failures: SyncFailure[] = [];

    for (const qso of records) {
      const key = qsoFingerprint(qso, callsign);
      if (!options.includeAlreadyUploaded && ledger[key]) {
        skipped++;
        continue;
      }

      const issues = missingQsoIssues(qso, callsign);
      if (issues.length > 0) {
        failed++;
        failures.push(...issues.map((issue) => this.createFailure(issue.code, issue.message, {
          operation: 'preflight',
          qsoId: issue.qsoId,
          qsoCallsign: issue.qsoCallsign,
          detail: issue.detail,
          config,
          apiKey,
        })));
        continue;
      }

      try {
        const result = await this.uploadSingleRealtime(callsign, config, apiKey, qso);
        if (result.status === 'ok' || result.status === 'modified') {
          uploaded++;
          this.markUploaded(callsign, ledger, qso, result.status === 'modified' ? 'modified' : 'realtime_ok', 'realtime');
        } else if (result.status === 'duplicate') {
          skipped++;
          this.markUploaded(callsign, ledger, qso, 'duplicate', 'realtime');
        } else {
          failed++;
          failures.push(this.createQsoFailure(qso, this.codeForRealtimeStatus(result.status), result.message, {
            httpStatus: result.httpStatus,
            retryable: result.retryable,
            config,
            apiKey,
          }));
          if (result.status === 'forbidden') break;
        }
      } catch (error) {
        failed++;
        failures.push(this.createQsoFailure(qso, 'clublog_upload_failed', error instanceof Error ? error.message : 'Upload failed', {
          source: this.sourceForError(error),
          retryable: this.isRetryableError(error),
          config,
          apiKey,
        }));
      }
    }

    if (uploaded > 0 || skipped > 0) {
      this.setLedger(callsign, ledger);
      this.setConfig(callsign, { ...config, lastRealtimeUploadTime: Date.now() });
    }

    return { uploaded, skipped, failed, failures: failures.length > 0 ? failures : undefined };
  }

  private async uploadBatch(
    callsign: string,
    config: ClubLogPluginConfig,
    apiKey: string,
    options?: SyncUploadOptions,
  ): Promise<SyncUploadResult> {
    this.emitUploadProgress(options, { stage: 'preparing', callsign, message: 'Preparing Club Log upload' });
    const prepared = await this.prepareUpload(callsign, options);
    const blockingIssues = prepared.blockedIssues ?? [];
    if (blockingIssues.length > 0 && !options?.skipBlockedQsos) {
      return {
        submitted: 0,
        uploaded: 0,
        skipped: prepared.skippedCount,
        failed: prepared.allQsos.length - prepared.skippedCount,
        failures: blockingIssues.map((issue) => this.createFailure(issue.code, issue.message, {
          operation: 'preflight',
          qsoId: issue.qsoId,
          qsoCallsign: issue.qsoCallsign,
          detail: issue.detail,
          config,
          apiKey,
        })),
      };
    }

    const qsos = prepared.uploadableQsos;
    this.emitUploadProgress(options, {
      stage: 'prepared',
      callsign,
      pendingCount: prepared.allQsos.length,
      uploadableCount: qsos.length,
      blockedCount: blockingIssues.length,
      skipped: prepared.skippedCount,
      batchCount: qsos.length > 0 ? 1 : 0,
    });

    if (qsos.length === 0) {
      this.emitUploadProgress(options, {
        stage: 'finished',
        callsign,
        submitted: 0,
        uploaded: 0,
        skipped: prepared.skippedCount,
        failed: 0,
        failureCount: 0,
      });
      return { submitted: 0, uploaded: 0, skipped: prepared.skippedCount, failed: 0 };
    }

    try {
      this.emitUploadProgress(options, {
        stage: 'batch_uploading',
        callsign,
        batchIndex: 1,
        batchCount: 1,
        qsoCount: qsos.length,
        skipped: prepared.skippedCount,
      });
      const responseSummary = await this.submitBatch(callsign, config, apiKey, qsos);
      const ledger = this.getLedger(callsign);
      for (const qso of qsos) {
        this.markUploaded(callsign, ledger, qso, 'batch_submitted', 'batch');
      }
      this.setLedger(callsign, ledger);
      this.setConfig(callsign, { ...config, lastBatchUploadTime: Date.now() });
      this.ctx.log.info('Club Log batch upload accepted', { callsign, qsoCount: qsos.length, responseSummary });
      this.emitUploadProgress(options, {
        stage: 'batch_accepted',
        callsign,
        batchIndex: 1,
        batchCount: 1,
        qsoCount: qsos.length,
        submitted: qsos.length,
        uploaded: qsos.length,
        skipped: prepared.skippedCount,
      });
      this.emitUploadProgress(options, {
        stage: 'finished',
        callsign,
        submitted: qsos.length,
        uploaded: qsos.length,
        skipped: prepared.skippedCount,
        failed: 0,
        failureCount: 0,
      });
      return { submitted: qsos.length, uploaded: qsos.length, skipped: prepared.skippedCount, failed: 0 };
    } catch (error) {
      const failure = this.errorFailure(error, 'upload', 'clublog_batch_submit_failed', config, apiKey);
      this.emitUploadProgress(options, {
        stage: 'batch_failed',
        callsign,
        batchIndex: 1,
        batchCount: 1,
        qsoCount: qsos.length,
        failed: qsos.length,
        failureCount: 1,
        message: failure.message,
      });
      this.emitUploadProgress(options, {
        stage: 'finished',
        callsign,
        submitted: 0,
        uploaded: 0,
        skipped: prepared.skippedCount,
        failed: qsos.length,
        failureCount: 1,
      });
      return { submitted: 0, uploaded: 0, skipped: prepared.skippedCount, failed: qsos.length, failures: [failure] };
    }
  }

  private async prepareUpload(
    callsign: string,
    options?: SyncUploadOptions | SyncUploadPreflightOptions,
  ): Promise<PreparedUpload> {
    const logbook = this.ctx.logbook.forCallsign(callsign);
    const query: Parameters<typeof logbook.queryQSOs>[0] = {};
    const timeRange = dateRangeFilter(options);
    if (timeRange) query.timeRange = timeRange;
    const allQsos = await logbook.queryQSOs(query);
    const ledger = this.getLedger(callsign);
    const uploadableQsos: QSORecord[] = [];
    const blockedIssues: NonNullable<SyncUploadPreflightResult['issues']> = [];
    let skippedCount = 0;

    for (const qso of allQsos) {
      const key = qsoFingerprint(qso, callsign);
      if (!options?.includeAlreadyUploaded && ledger[key]) {
        skippedCount++;
        continue;
      }
      const issues = missingQsoIssues(qso, callsign);
      if (issues.length > 0) {
        blockedIssues.push(...issues);
        continue;
      }
      uploadableQsos.push(qso);
    }

    return { allQsos, uploadableQsos, skippedCount, blockedIssues };
  }

  private async uploadSingleRealtime(
    callsign: string,
    config: ClubLogPluginConfig,
    apiKey: string,
    qso: QSORecord,
  ): Promise<RealtimeResult> {
    const adif = ensureUppercaseEor(convertQSOToADIF(qso, { includeStationCallsign: true }));
    const body = new URLSearchParams({
      email: config.email,
      password: config.password,
      callsign: normalizeCallsign(callsign),
      adif,
      api: apiKey,
    });

    this.ctx.log.debug('Uploading QSO to Club Log', { callsign: qso.callsign, mode: qso.mode, frequency: qso.frequency });
    const response = await this.doFetch(CLUBLOG_REALTIME_URL, {
      method: 'POST',
      body,
      timeout: CLUBLOG_REQUEST_TIMEOUT_MS,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const responseText = await response.text();
    const summary = sanitizeResponseText(responseText, secretsFor(config, apiKey));
    this.ctx.log.debug('Club Log realtime response', { status: response.status, body: summary });

    if (response.status === 403) {
      return { status: 'forbidden', message: forbiddenMessage(), retryable: false, httpStatus: response.status };
    }
    if (response.status >= 500) {
      return { status: 'failed', message: summary || `HTTP ${response.status}`, retryable: true, httpStatus: response.status };
    }
    if (!response.ok) {
      return {
        status: response.status === 400 ? 'rejected' : 'failed',
        message: summary || `HTTP ${response.status}`,
        retryable: false,
        httpStatus: response.status,
      };
    }
    if (/QSO\s+Duplicate/i.test(responseText)) {
      return { status: 'duplicate', message: summary || 'QSO Duplicate', retryable: false, httpStatus: response.status };
    }
    if (/QSO\s+Modified/i.test(responseText)) {
      return { status: 'modified', message: summary || 'QSO Modified', retryable: false, httpStatus: response.status };
    }
    if (/QSO\s+OK/i.test(responseText)) {
      return { status: 'ok', message: summary || 'QSO OK', retryable: false, httpStatus: response.status };
    }
    if (/QSO\s+Rejected/i.test(responseText)) {
      return { status: 'rejected', message: summary || 'QSO Rejected', retryable: false, httpStatus: response.status };
    }
    return { status: 'failed', message: summary || 'Unexpected Club Log response', retryable: false, httpStatus: response.status };
  }

  private async submitBatch(callsign: string, config: ClubLogPluginConfig, apiKey: string, qsos: QSORecord[]): Promise<string> {
    const adif = generateADIFFile(qsos, {
      programId: 'TX5DR',
      programVersion: '1.0',
      includeStationCallsign: true,
    });
    const form = new FormData();
    form.set('email', config.email);
    form.set('password', config.password);
    form.set('callsign', normalizeCallsign(callsign));
    form.set('clear', '0');
    form.set('api', apiKey);
    form.set('file', new Blob([adif], { type: 'application/octet-stream' }), `tx5dr-clublog-${normalizeCallsign(callsign)}.adi`);

    const response = await this.doFetch(CLUBLOG_BATCH_URL, {
      method: 'POST',
      body: form,
      timeout: CLUBLOG_REQUEST_TIMEOUT_MS,
    });
    const responseText = await response.text();
    const summary = sanitizeResponseText(responseText, secretsFor(config, apiKey));
    if (response.status === 403) {
      throw new ClubLogRemoteError(forbiddenMessage(), response.status, false);
    }
    if (!response.ok) {
      throw new ClubLogRemoteError(summary || `HTTP ${response.status}`, response.status, response.status >= 500 || response.status === 429);
    }
    return summary;
  }

  private async doFetch(url: string, init: RequestInit & { timeout: number }): Promise<Response> {
    if (!this.ctx.fetch) {
      throw new Error('Network permission is required');
    }
    const { timeout, headers, ...rest } = init;
    return this.ctx.fetch(url, {
      ...rest,
      headers: {
        'User-Agent': CLUBLOG_USER_AGENT,
        ...headers,
      },
      signal: AbortSignal.timeout(timeout),
    });
  }

  private failureUploadResult(failure: SyncFailure): SyncUploadResult {
    return { uploaded: 0, skipped: 0, failed: 0, failures: [failure] };
  }

  private codeForRealtimeStatus(status: RealtimeStatus): string {
    if (status === 'forbidden') return 'clublog_upload_forbidden';
    if (status === 'rejected') return 'clublog_upload_rejected';
    return 'clublog_upload_failed';
  }

  private createFailure(
    code: string,
    message: string,
    options: {
      operation: SyncFailureOperation;
      source?: SyncFailure['source'];
      detail?: string;
      httpStatus?: number;
      retryable?: boolean;
      qsoId?: string;
      qsoCallsign?: string;
      config?: ClubLogPluginConfig | null;
      apiKey?: string;
    },
  ): SyncFailure {
    return createSyncFailure({
      code,
      message,
      source: options.source ?? 'provider',
      operation: options.operation,
      providerId: this.id,
      detail: options.detail,
      httpStatus: options.httpStatus,
      retryable: options.retryable,
      qsoId: options.qsoId,
      qsoCallsign: options.qsoCallsign,
      secrets: secretsFor(options.config, options.apiKey),
    });
  }

  private createQsoFailure(
    qso: QSORecord,
    code: string,
    message: string,
    options: {
      source?: SyncFailure['source'];
      retryable?: boolean;
      httpStatus?: number;
      config: ClubLogPluginConfig;
      apiKey: string;
    },
  ): SyncFailure {
    return this.createFailure(code, message, {
      operation: 'upload',
      source: options.source ?? 'remote',
      retryable: options.retryable,
      httpStatus: options.httpStatus,
      qsoId: qso.id,
      qsoCallsign: qso.callsign,
      config: options.config,
      apiKey: options.apiKey,
    });
  }

  private errorFailure(
    error: unknown,
    operation: SyncFailureOperation,
    code: string,
    config: ClubLogPluginConfig,
    apiKey: string,
  ): SyncFailure {
    const remoteError = error instanceof ClubLogRemoteError ? error : null;
    return errorToSyncFailure(error, {
      code,
      source: remoteError ? 'remote' : this.sourceForError(error),
      operation,
      providerId: this.id,
      httpStatus: remoteError?.httpStatus,
      retryable: remoteError?.retryable ?? this.isRetryableError(error),
      secrets: secretsFor(config, apiKey),
    });
  }

  private sourceForError(error: unknown): SyncFailure['source'] {
    const message = error instanceof Error ? error.message : String(error ?? '');
    if (isNetworkMessage(message)) return 'network';
    return 'provider';
  }

  private isRetryableError(error: unknown): boolean {
    if (error instanceof ClubLogRemoteError) return error.retryable;
    const message = error instanceof Error ? error.message : String(error ?? '');
    return isNetworkMessage(message);
  }

  private emitUploadProgress(options: SyncUploadOptions | undefined, progress: SyncUploadProgress): void {
    try {
      options?.onProgress?.(progress);
    } catch (error) {
      this.ctx.log.warn('Club Log upload progress callback failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

class ClubLogRemoteError extends Error {
  constructor(message: string, readonly httpStatus: number, readonly retryable: boolean) {
    super(message);
    this.name = 'ClubLogRemoteError';
  }
}
