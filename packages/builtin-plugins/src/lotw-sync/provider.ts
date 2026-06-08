/* eslint-disable @typescript-eslint/no-explicit-any */
// LoTWSyncProvider — certificate parsing and HTTP response handling requires any

import { constants, createHash, privateEncrypt, randomUUID, X509Certificate } from 'crypto';
import { gzipSync } from 'zlib';
import forge from 'node-forge';
import type {
  PluginContext,
  LogbookSyncProvider,
  SyncAction,
  SyncTestResult,
  SyncUploadResult,
  SyncUploadPreflightResult,
  SyncDownloadResult,
  SyncDownloadOptions,
  SyncUploadOptions,
  SyncUploadPreflightOptions,
  SyncFailure,
  SyncUploadProgress,
  SyncDownloadProgress,
} from '@tx5dr/plugin-api';
import type { QSORecord } from '@tx5dr/contracts';
import {
  getBandFromFrequency,
  toLotwContactMode,
  normalizeLoTWStationLocation,
  suggestStationLocation,
  type LoTWLocationIssue,
  type LoTWStationLocationInput,
} from '@tx5dr/core';
import {
  createSyncFailure,
  errorToSyncFailure,
  getPluginPageScopePath,
  normalizeCallsign as normalizeCallsignBase,
  parseADIFContent,
  sanitizeSyncFailureText,
} from '@tx5dr/plugin-api';

// ===== Types (plugin-internal, formerly in contracts/lotw.schema.ts) =====

type LoTWCertificateStatus = 'valid' | 'expired' | 'not_yet_valid';

interface LoTWCertificateSummary {
  id: string;
  callsign: string;
  dxccId?: number;
  serial?: string;
  status: LoTWCertificateStatus;
  validFrom: number;
  validTo: number;
  qsoStartDate: number;
  qsoEndDate: number;
  fingerprint: string;
}

interface LoTWUploadIssue {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  detail?: string;
  qsoId?: string;
  qsoCallsign?: string;
}

interface LoTWUploadPreflightResponse extends SyncUploadPreflightResult {
  ready: boolean;
  pendingCount: number;
  uploadableCount: number;
  blockedCount: number;
  issues: LoTWUploadIssue[];
  selectedCertificates: LoTWCertificateSummary[];
  matchedCertificateIds: string[];
  locationSummary?: Record<string, unknown>;
  guidance: string[];
}

// ===== OIDs used in LoTW certificates =====

const LOTW_CALLSIGN_OID = '1.3.6.1.4.1.12348.1.1';
const LOTW_QSO_START_OID = '1.3.6.1.4.1.12348.1.2';
const LOTW_QSO_END_OID = '1.3.6.1.4.1.12348.1.3';
const LOTW_DXCC_OID = '1.3.6.1.4.1.12348.1.4';

const LOTW_UPLOAD_URL = 'https://lotw.arrl.org/lotw/upload';
const LOTW_REPORT_URL = 'https://lotw.arrl.org/lotwuser/lotwreport.adi';
// ASN.1 DigestInfo prefix for SHA-1, used by RSASSA-PKCS1-v1_5 signatures.
const SHA1_DIGEST_INFO_PREFIX = Buffer.from('3021300906052b0e03021a05000414', 'hex');

function isLotwAdifResponse(responseText: string): boolean {
  return responseText.toLowerCase().includes('<eoh>');
}

function classifyLotwErrorResponse(responseText: string): 'lotw_auth_failed' | 'lotw_rate_limited' | 'lotw_response_invalid' {
  const normalized = responseText.toLowerCase().replace(/\s+/g, ' ');
  const authFailurePatterns = [
    /\bincorrect\b.{0,80}\bpassword\b/,
    /\bpassword\b.{0,80}\bincorrect\b/,
    /\binvalid\b.{0,80}\bpassword\b/,
    /\bpassword\b.{0,80}\binvalid\b/,
    /\blogin\b.{0,80}\bpassword\b/,
    /\bpassword\b.{0,80}\blogin\b/,
    /\bauthentication\b.{0,80}\bfailed\b/,
    /\blogin\b.{0,80}\bfailed\b/,
  ];

  if (authFailurePatterns.some(pattern => pattern.test(normalized))) {
    return 'lotw_auth_failed';
  }

  if (/\bpage request limit\b|\brate limit\b|\btoo many requests\b/.test(normalized)) {
    return 'lotw_rate_limited';
  }

  return 'lotw_response_invalid';
}

function summarizeLotwResponse(responseText: string): string {
  return sanitizeSyncFailureText(
    responseText
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500) || 'empty response',
  );
}

function describeLotwErrorResponse(responseText: string): Pick<SyncFailure, 'code' | 'message' | 'detail'> {
  const code = classifyLotwErrorResponse(responseText);
  const detail = summarizeLotwResponse(responseText);
  if (code === 'lotw_auth_failed') {
    return {
      code,
      message: detail || 'LoTW authentication failed. Check your username and password.',
      detail,
    };
  }
  if (code === 'lotw_rate_limited') {
    return {
      code,
      message: detail || 'LoTW rate limit reached. Please retry later.',
      detail,
    };
  }
  return {
    code,
    message: detail || 'LoTW returned a response that was not valid ADIF.',
    detail,
  };
}

// ===== Types =====

/**
 * Per-callsign LoTW configuration stored in plugin KVStore.
 */
export interface LoTWPluginConfig {
  username: string;
  password: string;
  uploadLocation: {
    callsign: string;
    dxccId?: number;
    gridSquare: string;
    cqZone: string;
    ituZone: string;
    iota?: string;
    state?: string;
    county?: string;
  };
  autoUploadQSO: boolean;
  lastUploadTime?: number;
  lastDownloadTime?: number;
}

type LoTWResolvedUploadLocation = LoTWStationLocationInput & {
  callsign: string;
  gridSquare: string;
  cqZone: string;
  ituZone: string;
};

export interface LoTWCertificateImportResult {
  certificate: LoTWCertificateSummary;
  duplicate: boolean;
  configUpdated: boolean;
}

/**
 * Full certificate data stored as JSON in plugin file store.
 */
interface StoredCertificateFile {
  id: string;
  callsign: string;
  dxccId: number;
  serial: string;
  validFrom: number;
  validTo: number;
  qsoStartDate: number;
  qsoEndDate: number;
  fingerprint: string;
  certPem: string;
  privateKeyPem: string;
}

interface StoredCertificate extends StoredCertificateFile {
  status: LoTWCertificateStatus;
}

interface CertificateInventoryEntry {
  filePath: string;
  canonicalId: string;
  storedId?: string;
  certificate: StoredCertificate;
}

interface CertificateAttribute {
  name?: string;
  shortName?: string;
  type?: string;
  value?: string | unknown[];
}

interface PreparedBatch {
  certificate: StoredCertificate;
  qsos: QSORecord[];
}

interface UploadBatchAcceptedResult {
  acceptedAt: number;
  responseSummary: string;
}

interface DownloadWindow {
  start: number;
  end: number;
  startDate: string;
  endDate: string;
  startTime?: string;
  endTime?: string;
  splitDepth: number;
}

interface DownloadCounters {
  downloaded: number;
  matched: number;
  updated: number;
  imported: number;
  failed: number;
  failureCount: number;
}

interface DownloadWindowFetchResult {
  records: QSORecord[];
  failures: SyncFailure[];
  shouldSplit?: boolean;
}


function lotwLocationIssueToUploadIssue(issue: LoTWLocationIssue): LoTWUploadIssue {
  return {
    code: issue.code,
    severity: issue.severity,
    message: issue.message,
    detail: issue.detail ?? ([
      issue.field ? `field=${issue.field}` : '',
      issue.value ? `value=${issue.value}` : '',
      issue.suggested ? `suggested=${issue.suggested}` : '',
    ].filter(Boolean).join('; ') || undefined),
  };
}

interface UploadPreparation {
  issues: LoTWUploadIssue[];
  guidance: string[];
  matchedCertificates: LoTWCertificateSummary[];
  batches: PreparedBatch[];
  uploadableCount: number;
  blockedCount: number;
}

function isUploadPreflightOptions(value: unknown): value is SyncUploadPreflightOptions {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return ('since' in candidate || 'until' in candidate || 'includeAlreadyUploaded' in candidate)
    && !('uploadLocation' in candidate)
    && !('username' in candidate)
    && !('password' in candidate);
}

function isUploadCandidate(qso: QSORecord, options?: Pick<SyncUploadOptions, 'since' | 'until' | 'includeAlreadyUploaded'>): boolean {
  if (options?.includeAlreadyUploaded !== true && qso.lotwQslSent === 'Y') {
    return false;
  }
  const startTime = qso.startTime;
  if (typeof options?.since === 'number' && Number.isFinite(options.since) && startTime < options.since) {
    return false;
  }
  if (typeof options?.until === 'number' && Number.isFinite(options.until) && startTime > options.until) {
    return false;
  }
  return true;
}

class LoTWRemoteError extends Error {
  constructor(
    message: string,
    readonly httpStatus?: number,
    readonly retryable?: boolean,
    readonly remoteDetail?: string,
  ) {
    super(message);
    this.name = 'LoTWRemoteError';
  }
}

// ===== Helpers =====

const CONFIG_KEY_PREFIX = 'config:';
const LOTW_DOWNLOAD_WINDOW_DAYS = 7;
const LOTW_DOWNLOAD_MIN_TIME_WINDOW_MS = 3 * 60 * 60 * 1000;
const LOTW_DOWNLOAD_REQUEST_TIMEOUT_MS = 45000;
const LOTW_DOWNLOAD_MAX_RETRIES = 2;
const LOTW_DOWNLOAD_REQUEST_INTERVAL_MS = process.env.NODE_ENV === 'test' || process.env.VITEST ? 0 : 3000;
const LOTW_DOWNLOAD_RETRY_BACKOFF_MS = process.env.NODE_ENV === 'test' || process.env.VITEST
  ? [0, 0, 0]
  : [30000, 60000, 120000];
const LOTW_UPLOAD_BATCH_SIZE = 100;
const LOTW_PREFLIGHT_DETAIL_LIMIT = 20;
const LOTW_DOWNLOAD_MATCH_TOLERANCE_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function toMillis(dateLike: string): number {
  return new Date(dateLike).getTime();
}

function toEndOfDayMillis(dateLike: string): number {
  return new Date(`${dateLike}T23:59:59.000Z`).getTime();
}

function normalizeCallsign(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeForgeValue(value: unknown): string {
  if (typeof value === 'string') {
    return value.replace(/\0/g, '').trim();
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForgeValue(item)).join('').trim();
  }
  return '';
}

function inferStatus(validFrom: number, validTo: number): LoTWCertificateStatus {
  const now = Date.now();
  if (now < validFrom) return 'not_yet_valid';
  if (now > validTo) return 'expired';
  return 'valid';
}

function normalizeLocationValue(value?: string): string {
  return (value || '').trim().toUpperCase();
}

function formatLoTWDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function formatLoTWTime(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(11, 19) + 'Z';
}

function formatFrequencyMHz(frequencyHz: number): string {
  const value = Number((frequencyHz / 1000000).toFixed(6));
  return value.toString();
}

function mapCanadaProvince(value: string): string {
  if (value === 'QC') return 'PQ';
  if (value === 'NL') return 'NF';
  return value;
}

function mapRussiaOblast(value: string): string {
  if (value === 'YR') return 'JA';
  if (value === 'YN') return 'JN';
  return value;
}

function getDateDaysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().split('T')[0];
}

function startOfUtcDay(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function endOfUtcDay(timestamp: number): number {
  return startOfUtcDay(timestamp) + DAY_MS - 1;
}

function formatLotwQueryDate(timestamp: number): string {
  return new Date(timestamp).toISOString().split('T')[0];
}

function formatLotwQueryTime(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(11, 19).replace(/:/g, '');
}

function formatIssueTimestamp(timestamp: number): string {
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : 'unknown time';
}

function createDownloadWindow(start: number, end: number, splitDepth = 0): DownloadWindow {
  const startDate = formatLotwQueryDate(start);
  const endDate = formatLotwQueryDate(end);
  const fullStartOfDay = start === startOfUtcDay(start);
  const fullEndOfDay = end === endOfUtcDay(end);
  const includeTimes = startDate === endDate && (!fullStartOfDay || !fullEndOfDay);
  return {
    start,
    end,
    startDate,
    endDate,
    startTime: includeTimes ? formatLotwQueryTime(start) : undefined,
    endTime: includeTimes ? formatLotwQueryTime(end) : undefined,
    splitDepth,
  };
}

function formatDownloadWindowRange(window: DownloadWindow): string {
  const startTime = window.startTime ? ` ${window.startTime}` : '';
  const endTime = window.endTime ? ` ${window.endTime}` : '';
  return `${window.startDate}${startTime}..${window.endDate}${endTime}`;
}

function buildDateWindows(since: number, until: number, windowDays = LOTW_DOWNLOAD_WINDOW_DAYS): DownloadWindow[] {
  const windows: DownloadWindow[] = [];
  let cursor = startOfUtcDay(since);
  const finalEnd = endOfUtcDay(until);
  const windowLengthMs = Math.max(1, windowDays) * DAY_MS;

  while (cursor <= finalEnd) {
    const end = Math.min(cursor + windowLengthMs - 1, finalEnd);
    windows.push(createDownloadWindow(cursor, end));
    cursor = end + 1;
  }

  return windows;
}

function canSplitDownloadWindow(window: DownloadWindow): boolean {
  return (window.end - window.start + 1) > LOTW_DOWNLOAD_MIN_TIME_WINDOW_MS;
}

function splitDownloadWindow(window: DownloadWindow): DownloadWindow[] {
  if (!canSplitDownloadWindow(window)) {
    return [window];
  }

  const startDay = startOfUtcDay(window.start);
  const endDay = startOfUtcDay(window.end);
  const dayCount = Math.floor((endDay - startDay) / DAY_MS) + 1;
  if (dayCount > 1) {
    const firstDayCount = Math.max(1, Math.floor(dayCount / 2));
    const firstEnd = Math.min(endOfUtcDay(startDay + (firstDayCount - 1) * DAY_MS), window.end);
    return [
      createDownloadWindow(window.start, firstEnd, window.splitDepth + 1),
      createDownloadWindow(firstEnd + 1, window.end, window.splitDepth + 1),
    ];
  }

  if (!window.startTime && !window.endTime) {
    return [0, 6, 12, 18].map((hour) => {
      const start = window.start + hour * 60 * 60 * 1000;
      const end = Math.min(start + 6 * 60 * 60 * 1000 - 1, window.end);
      return createDownloadWindow(start, end, window.splitDepth + 1);
    });
  }

  const midpoint = window.start + Math.floor((window.end - window.start) / 2);
  return [
    createDownloadWindow(window.start, midpoint, window.splitDepth + 1),
    createDownloadWindow(midpoint + 1, window.end, window.splitDepth + 1),
  ];
}

function normalizeQsoCallsign(value?: string): string {
  return (value || '').trim().toUpperCase();
}

function normalizeQsoMode(value?: string): string {
  const mode = (value || '').trim().toUpperCase();
  if (mode === 'USB' || mode === 'LSB') return 'SSB';
  return mode;
}

function lotwMatchBand(qso: QSORecord): string {
  const band = getBandFromFrequency(qso.frequency);
  return band === 'Unknown' ? '' : band.toUpperCase();
}

function lotwMatchMode(qso: QSORecord): string {
  return normalizeQsoMode(toLotwContactMode(qso));
}

function lotwQsoKey(qso: QSORecord, fallbackStationCallsign?: string): string {
  const station = normalizeQsoCallsign(qso.myCallsign || fallbackStationCallsign);
  const call = normalizeQsoCallsign(qso.callsign);
  const band = lotwMatchBand(qso);
  const mode = lotwMatchMode(qso);
  const minute = Math.floor(qso.startTime / 60000);
  return [station, call, band, mode, String(minute)].join('|');
}

function dedupeIssues(issues: LoTWUploadIssue[]): LoTWUploadIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = [issue.code, issue.message, issue.qsoId || '', issue.detail || ''].join(':');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isSkippableUploadIssue(issue: LoTWUploadIssue): boolean {
  return [
    'certificate_date_range_mismatch',
    'qso_callsign_missing',
    'qso_callsign_mismatch',
  ].includes(issue.code);
}

// ===== Provider =====

/**
 * LoTW sync provider — implements LogbookSyncProvider.
 *
 * Manages per-callsign configuration in the plugin's global KVStore,
 * certificate storage via ctx.files, and communicates with ARRL LoTW
 * for QSO upload (TQ8 format with RSA-SHA1 signing) and download.
 */
export class LoTWSyncProvider implements LogbookSyncProvider {
  private static readonly reportRequestQueues = new Map<string, Promise<unknown>>();
  private static readonly lastReportRequestAt = new Map<string, number>();

  readonly id = 'lotw';
  readonly displayName = 'LoTW';
  readonly color = 'success' as const;
  readonly accessScope = 'operator' as const;
  readonly settingsPageId = 'settings';
  readonly actions: SyncAction[] = [
    { id: 'download', label: 'Download', icon: 'download', pageId: 'download-wizard' },
    { id: 'upload', label: 'Upload', icon: 'upload', pageId: 'upload-wizard' },
  ];

  constructor(private ctx: PluginContext) {}

  // ========== Config helpers ==========

  private configKey(callsign: string): string {
    // Use the plugin-api normalizer (which also strips suffixes like "/P")
    // so that save (via requireBoundCallsign, which uses the same function)
    // and read paths resolve to the same key. The local normalizeCallsign
    // above is intentionally simpler (trim+uppercase) and used for matching
    // raw certificate attribute values.
    return `${CONFIG_KEY_PREFIX}${normalizeCallsignBase(callsign)}`;
  }

  /** Read per-callsign config from KVStore (synchronous). */
  getConfig(callsign: string): LoTWPluginConfig | null {
    return this.ctx.store.global.get<LoTWPluginConfig | undefined>(this.configKey(callsign)) ?? null;
  }

  /** Write per-callsign config to KVStore (synchronous write, async flush). */
  setConfig(callsign: string, config: LoTWPluginConfig): void {
    this.ctx.store.global.set(this.configKey(callsign), config);
  }

  private getCertificateDir(callsign: string): string {
    return `${getPluginPageScopePath({ kind: 'callsign', value: callsign })}/certificates`;
  }

  private getCertificateFilePath(callsign: string, certId: string): string {
    return `${this.getCertificateDir(callsign)}/${certId}.json`;
  }

  private getDefaultConfig(callsign: string): LoTWPluginConfig {
    const normalized = normalizeCallsign(callsign);
    return {
      username: '',
      password: '',
      uploadLocation: {
        callsign: normalized,
        dxccId: undefined,
        gridSquare: '',
        cqZone: '',
        ituZone: '',
      },
      autoUploadQSO: false,
    };
  }

  private getEffectiveConfig(callsign: string, override?: LoTWPluginConfig | null): LoTWPluginConfig {
    return override ?? this.getConfig(callsign) ?? this.getDefaultConfig(callsign);
  }

  private applyCertificateDefaults(
    callsign: string,
    certificate: LoTWCertificateSummary,
  ): boolean {
    const normalizedCallsign = normalizeCallsign(callsign);
    const current = this.getConfig(normalizedCallsign);
    const base = current ?? this.getDefaultConfig(normalizedCallsign);
    const nextLocation = {
      ...base.uploadLocation,
    };

    let changed = false;
    if (!nextLocation.callsign?.trim()) {
      nextLocation.callsign = certificate.callsign;
      changed = true;
    }
    if (!nextLocation.dxccId && certificate.dxccId) {
      nextLocation.dxccId = certificate.dxccId;
      changed = true;
    }

    if (!changed) {
      return false;
    }

    this.setConfig(normalizedCallsign, {
      ...base,
      uploadLocation: nextLocation,
    });
    return true;
  }

  // ========== Certificate management ==========

  /**
   * Import a .p12 certificate from a raw buffer.
   * Parses PKCS#12, extracts callsign/DXCC/dates, and stores as JSON via ctx.files.
   */
  async importCertificate(callsign: string, fileBuffer: Buffer): Promise<LoTWCertificateImportResult> {
    let p12: forge.pkcs12.Pkcs12Pfx;

    try {
      const der = forge.util.createBuffer(fileBuffer.toString('binary'));
      const asn1 = forge.asn1.fromDer(der);
      p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, '');
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : '';
      if (message.includes('mac could not be verified') || message.includes('invalid password') || message.includes('password')) {
        throw new Error('certificate_password_protected');
      }
      throw new Error('certificate_invalid');
    }

    const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
    const keyBags = [
      ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || []),
      ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || []),
    ];

    const cert = certBags[0]?.cert;
    const privateKey = keyBags[0]?.key;

    if (!cert || !privateKey) {
      throw new Error('certificate_invalid');
    }

    const certPem = forge.pki.certificateToPem(cert);
    const privateKeyPem = forge.pki.privateKeyToPem(privateKey);
    const x509 = new X509Certificate(certPem);
    const subjectAttrs = (cert.subject.attributes || []) as CertificateAttribute[];
    const extMap = new Map(
      (cert.extensions || []).map((ext: any) => [ext.id, normalizeForgeValue(ext.value)]),
    );

    const certificateCallsign = this.extractCallsign(subjectAttrs, x509.subject);
    const dxccId = Number.parseInt(extMap.get(LOTW_DXCC_OID) || '', 10);
    const qsoStartDate = extMap.get(LOTW_QSO_START_OID) || '';
    const qsoEndDate = extMap.get(LOTW_QSO_END_OID) || '';

    if (!certificateCallsign || !Number.isFinite(dxccId) || !qsoStartDate || !qsoEndDate) {
      throw new Error('certificate_invalid');
    }

    const id = randomUUID();
    const stored: StoredCertificateFile = {
      id,
      callsign: certificateCallsign,
      dxccId,
      serial: x509.serialNumber || 'unknown',
      validFrom: toMillis(x509.validFrom),
      validTo: toMillis(x509.validTo),
      qsoStartDate: toMillis(`${qsoStartDate}T00:00:00.000Z`),
      qsoEndDate: toEndOfDayMillis(qsoEndDate),
      fingerprint: createHash('sha256').update(x509.raw).digest('hex').toUpperCase(),
      certPem,
      privateKeyPem,
    };

    // Store as JSON via plugin file store
    const normalizedCallsign = normalizeCallsign(callsign);
    if (normalizedCallsign !== stored.callsign) {
      throw new Error('certificate_callsign_mismatch');
    }

    const existingCertificates = await this.getCertificates(normalizedCallsign);
    const duplicate = existingCertificates.find((item) => item.fingerprint === stored.fingerprint);
    if (duplicate) {
      const configUpdated = this.applyCertificateDefaults(normalizedCallsign, duplicate);
      this.ctx.log.info('Certificate import skipped due to duplicate fingerprint', {
        callsign: certificateCallsign,
        existingId: duplicate.id,
      });
      return {
        certificate: duplicate,
        duplicate: true,
        configUpdated,
      };
    }

    const filePath = this.getCertificateFilePath(normalizedCallsign, id);
    await this.ctx.files.write(filePath, Buffer.from(JSON.stringify(stored, null, 2), 'utf-8'));

    const status = inferStatus(stored.validFrom, stored.validTo);
    const summary = this.toSummary({ ...stored, status });
    const configUpdated = this.applyCertificateDefaults(normalizedCallsign, summary);
    this.ctx.log.info('Certificate imported', { id, callsign: certificateCallsign, dxccId, status, configUpdated });

    return {
      certificate: summary,
      duplicate: false,
      configUpdated,
    };
  }

  /** List all stored certificates. */
  async getCertificates(callsign: string): Promise<LoTWCertificateSummary[]> {
    const inventory = await this.listCertificateInventory(callsign);
    return inventory.map((entry) => this.toSummary(entry.certificate));
  }

  /** Delete a certificate by ID. */
  async deleteCertificate(callsign: string, certId: string): Promise<boolean> {
    const inventory = await this.listCertificateInventory(callsign);
    const entry = inventory.find((item) => item.canonicalId === certId || item.storedId === certId);
    const filePath = entry?.filePath ?? this.getCertificateFilePath(callsign, certId);
    const deleted = await this.ctx.files.delete(filePath);
    if (deleted) {
      this.ctx.log.info('Certificate deleted', { id: certId, canonicalId: entry?.canonicalId ?? certId });
      return true;
    }

    this.ctx.log.info('Certificate delete skipped because certificate file is already absent', {
      id: certId,
      canonicalId: entry?.canonicalId ?? certId,
    });
    return true;
  }

  private extractCertificateIdFromPath(filePath: string): string | undefined {
    const fileName = filePath.split('/').pop() ?? '';
    return fileName.endsWith('.json') ? fileName.slice(0, -'.json'.length) : undefined;
  }

  private toSummary(cert: StoredCertificate): LoTWCertificateSummary {
    return {
      id: cert.id,
      callsign: cert.callsign,
      dxccId: cert.dxccId,
      serial: cert.serial,
      validFrom: cert.validFrom,
      validTo: cert.validTo,
      qsoStartDate: cert.qsoStartDate,
      qsoEndDate: cert.qsoEndDate,
      fingerprint: cert.fingerprint,
      status: cert.status,
    };
  }

  private async listCertificateInventory(callsign: string): Promise<CertificateInventoryEntry[]> {
    const files = await this.ctx.files.list(this.getCertificateDir(callsign));
    const entries: CertificateInventoryEntry[] = [];

    for (const filePath of files) {
      if (!filePath.endsWith('.json')) continue;
      const canonicalId = this.extractCertificateIdFromPath(filePath);
      if (!canonicalId) continue;

      try {
        const data = await this.ctx.files.read(filePath);
        if (!data) continue;

        const parsed = JSON.parse(data.toString('utf-8')) as Partial<StoredCertificateFile>;
        const storedId = typeof parsed.id === 'string' && parsed.id.trim() ? parsed.id : undefined;
        const certificate = {
          ...parsed,
          id: canonicalId,
          status: inferStatus(parsed.validFrom as number, parsed.validTo as number),
        } as StoredCertificate;

        entries.push({
          filePath,
          canonicalId,
          storedId,
          certificate,
        });

        if (storedId !== canonicalId) {
          await this.repairCertificateId(filePath, parsed, canonicalId, storedId);
        }
      } catch (error) {
        this.ctx.log.warn('Failed to read certificate file', {
          filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return entries;
  }

  private async repairCertificateId(
    filePath: string,
    parsed: Partial<StoredCertificateFile>,
    canonicalId: string,
    storedId?: string,
  ): Promise<void> {
    try {
      await this.ctx.files.write(
        filePath,
        Buffer.from(JSON.stringify({ ...parsed, id: canonicalId }, null, 2), 'utf-8'),
      );
      this.ctx.log.info('Repaired LoTW certificate ID to match file name', {
        filePath,
        oldId: storedId ?? null,
        canonicalId,
      });
    } catch (error) {
      this.ctx.log.warn('Failed to repair LoTW certificate ID', {
        filePath,
        oldId: storedId ?? null,
        canonicalId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private extractCallsign(attributes: CertificateAttribute[], subjectText: string): string {
    // Try LOTW-specific OID first
    const preferred = attributes.find(
      (attr) => attr.type === LOTW_CALLSIGN_OID && normalizeForgeValue(attr.value),
    );
    const preferredValue = normalizeForgeValue(preferred?.value);
    if (preferredValue) return normalizeCallsign(preferredValue);

    // Try any 12348 OID
    const unknown = attributes.find(
      (attr) => normalizeForgeValue(attr.value) && attr.name === undefined && attr.type?.startsWith('1.3.6.1.4.1.12348.'),
    );
    const unknownValue = normalizeForgeValue(unknown?.value);
    if (unknownValue) return normalizeCallsign(unknownValue);

    // Try callsign-shaped attribute value
    const candidate = attributes.find((attr) => {
      const value = normalizeForgeValue(attr.value);
      return value && /^[A-Z0-9/]{3,20}$/i.test(value);
    });
    const candidateValue = normalizeForgeValue(candidate?.value);
    if (candidateValue) return normalizeCallsign(candidateValue);

    // Try subject CN
    const match = subjectText.match(/(?:^|,|\s)(?:CN=)?([A-Z0-9/]{3,20})(?:,|$)/i);
    if (match?.[1]) return normalizeCallsign(match[1]);

    return '';
  }

  // ========== LogbookSyncProvider implementation ==========

  isConfigured(callsign: string): boolean {
    const config = this.getConfig(callsign);
    if (config?.username) return true;
    // Also considered configured if certificates exist (check via sync KV)
    // We can't do async here, so just check if config exists with any meaningful data
    return !!config;
  }

  isAutoUploadEnabled(callsign: string): boolean {
    const config = this.getConfig(callsign);
    if (!config?.autoUploadQSO) return false;
    const loc = config.uploadLocation;
    // Must have upload location essentials configured
    return !!(loc?.callsign && loc.dxccId && loc.gridSquare && loc.cqZone && loc.ituZone);
  }

  async testConnection(callsign: string, overrideConfig?: LoTWPluginConfig | null): Promise<SyncTestResult> {
    const config = this.getEffectiveConfig(callsign, overrideConfig);
    if (!config?.username || !config?.password) {
      const failure = this.createFailure('lotw_credentials_missing', 'Username and password are required', {
        operation: 'test_connection',
      });
      return { success: false, message: failure.message, failures: [failure] };
    }

    try {
      const params = new URLSearchParams({
        login: config.username,
        password: config.password,
        qso_query: '1',
        qso_qsldetail: 'yes',
        qso_qsl: 'yes',
        qso_qslsince: '2099-01-01',
      });
      const url = LOTW_REPORT_URL + '?' + params.toString();

      const response = await this.withReportRequestSlot(config.username, () => undefined, () => (
        this.doFetch(url, { method: 'GET', timeout: 15000 })
      ));
      const responseText = await response.text();

      if (isLotwAdifResponse(responseText)) {
        return { success: true, message: 'lotw_connection_success' };
      }

      const described = describeLotwErrorResponse(responseText);
      const failure = this.createFailure(described.code, described.message, {
        source: described.code === 'lotw_auth_failed' ? 'provider' : 'remote',
        operation: 'test_connection',
        detail: described.detail,
      });
      return { success: false, message: failure.message, failures: [failure] };
    } catch (error) {
      this.ctx.log.error('Connection test failed', error);
      const failure = this.errorFailure(error, 'test_connection', 'lotw_connection_failed', config);
      return { success: false, message: failure.message, failures: [failure] };
    }
  }

  async upload(callsign: string, options?: SyncUploadOptions): Promise<SyncUploadResult> {
    const config = this.getConfig(callsign);
    if (!config) {
      return {
        uploaded: 0,
        skipped: 0,
        failed: 0,
        failures: [
          this.createFailure('lotw_not_configured', 'LoTW not configured', {
            operation: 'upload',
          }),
        ],
      };
    }
    const logbook = this.ctx.logbook.forCallsign(callsign);
    this.emitUploadProgress(options, {
      stage: 'preparing',
      callsign,
      message: 'Preparing LoTW upload',
    });

    const pendingQsos = options?.records
      ? options.records.filter((qso) => isUploadCandidate(qso, options))
      : await this.queryPendingQsos(logbook, options);

    if (pendingQsos.length === 0) {
      this.emitUploadProgress(options, {
        stage: 'finished',
        callsign,
        pendingCount: 0,
        submitted: 0,
        uploaded: 0,
        skipped: 0,
        failed: 0,
        failureCount: 0,
      });
      return { uploaded: 0, skipped: 0, failed: 0 };
    }

    const preparation = await this.prepareUpload(config, pendingQsos, callsign);
    const blockingIssues = preparation.issues.filter((i) => i.severity === 'error');
    const nonSkippableBlockingIssue = blockingIssues.find((issue) => !isSkippableUploadIssue(issue));
    const canSkipBlocked = options?.skipBlockedQsos
      && preparation.batches.length > 0
      && !nonSkippableBlockingIssue;
    if (blockingIssues.length > 0 && !canSkipBlocked) {
      return {
        uploaded: 0,
        skipped: 0,
        failed: pendingQsos.length,
        failures: blockingIssues
          .map((issue) => this.createFailure(issue.code, issue.message, {
            operation: 'preflight',
            qsoId: issue.qsoId,
            qsoCallsign: issue.qsoCallsign,
            detail: issue.detail,
          })),
      };
    }

    const canonicalLocation = normalizeLoTWStationLocation(this.resolveUploadLocation(config, callsign));
    if (!canonicalLocation.location) {
      return {
        uploaded: 0,
        skipped: 0,
        failed: pendingQsos.length,
        failures: canonicalLocation.issues.map((issue) => this.createFailure(issue.code, issue.message, {
          operation: 'preflight',
          detail: issue.detail,
        })),
      };
    }
    const location = canonicalLocation.location;
    this.ctx.log.info('LoTW upload station location canonicalized', {
      callsign: location.callsign,
      dxccId: location.dxccId,
      gridSquare: location.gridSquare,
      cqZone: location.cqZone,
      ituZone: location.ituZone,
      stateField: location.stateField,
      state: location.state,
      countyField: location.countyField,
      county: location.county,
    });
    let submitted = 0;
    let rejected = 0;
    let updateFailed = 0;
    const acceptedQsoIds: string[] = [];
    const failures: SyncFailure[] = [];
    const uploadBatches = this.splitPreparedBatches(preparation.batches);
    this.emitUploadProgress(options, {
      stage: 'prepared',
      callsign,
      pendingCount: pendingQsos.length,
      uploadableCount: preparation.uploadableCount,
      blockedCount: preparation.blockedCount,
      batchCount: uploadBatches.length,
      skipped: preparation.blockedCount,
    });

    this.ctx.log.info('LoTW upload prepared', {
      callsign,
      pendingCount: pendingQsos.length,
      uploadableCount: preparation.uploadableCount,
      blockedCount: preparation.blockedCount,
      skipBlockedQsos: options?.skipBlockedQsos === true,
      batchCount: uploadBatches.length,
    });

    for (const [batchIndex, batch] of uploadBatches.entries()) {
      try {
        this.ctx.log.info('LoTW upload batch starting', {
          callsign,
          batchIndex: batchIndex + 1,
          batchCount: uploadBatches.length,
          qsoCount: batch.qsos.length,
          certificateCallsign: batch.certificate.callsign,
        });
        this.emitUploadProgress(options, {
          stage: 'batch_uploading',
          callsign,
          batchIndex: batchIndex + 1,
          batchCount: uploadBatches.length,
          qsoCount: batch.qsos.length,
          submitted,
          skipped: preparation.blockedCount,
        });
        const accepted = await this.uploadBatch(batch, location);
        submitted += batch.qsos.length;
        acceptedQsoIds.push(...batch.qsos.map((qso) => qso.id));
        this.ctx.log.info('LoTW upload batch accepted', {
          callsign,
          batchIndex: batchIndex + 1,
          batchCount: uploadBatches.length,
          qsoCount: batch.qsos.length,
          responseSummary: accepted.responseSummary,
        });
        this.emitUploadProgress(options, {
          stage: 'batch_accepted',
          callsign,
          batchIndex: batchIndex + 1,
          batchCount: uploadBatches.length,
          qsoCount: batch.qsos.length,
          submitted,
          skipped: preparation.blockedCount,
          message: accepted.responseSummary,
        });
      } catch (error) {
        rejected += batch.qsos.length;
        const msg = error instanceof Error ? error.message : 'Upload failed';
        const remoteError = error instanceof LoTWRemoteError ? error : null;
        this.ctx.log.warn('LoTW upload batch failed', {
          callsign,
          batchIndex: batchIndex + 1,
          batchCount: uploadBatches.length,
          qsoCount: batch.qsos.length,
          error: msg,
        });
        this.emitUploadProgress(options, {
          stage: 'batch_failed',
          callsign,
          batchIndex: batchIndex + 1,
          batchCount: uploadBatches.length,
          qsoCount: batch.qsos.length,
          submitted,
          skipped: preparation.blockedCount,
          failureCount: failures.length + 1,
          message: msg,
        });
        failures.push(this.createFailure('lotw_upload_rejected', msg, {
          source: this.isNetworkError(error) ? 'network' : 'remote',
          operation: 'upload',
          qsoCallsign: batch.certificate.callsign,
          httpStatus: remoteError?.httpStatus,
          retryable: remoteError?.retryable ?? this.isNetworkError(error),
          detail: remoteError?.remoteDetail ?? msg,
          secrets: [config.username, config.password],
        }));
      }
    }

    // LoTW accepted means the batch was received. Confirmation is handled by download sync.
    this.emitUploadProgress(options, {
      stage: 'updating_local',
      callsign,
      submitted,
      skipped: preparation.blockedCount,
      failureCount: failures.length,
    });
    for (const qsoId of acceptedQsoIds) {
      try {
        await logbook.updateQSO(qsoId, {
          lotwQslSent: 'Y',
          lotwQslSentDate: Date.now(),
        });
      } catch (err) {
        updateFailed += 1;
        failures.push(this.createFailure('lotw_update_qsl_status_failed', err instanceof Error ? err.message : 'Failed to update QSL sent status', {
          source: 'logbook',
          operation: 'upload',
          qsoId,
        }));
        this.ctx.log.warn('Failed to update QSL sent status', {
          qsoId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Update lastUploadTime
    if (submitted > 0) {
      this.setConfig(callsign, { ...config, lastUploadTime: Date.now() });
      await logbook.notifyUpdated();
    }

    const uploaded = Math.max(0, acceptedQsoIds.length - updateFailed);
    const failed = rejected + updateFailed;

    this.ctx.log.info('LoTW upload finished', {
      callsign,
      submitted,
      uploaded,
      skipped: preparation.blockedCount,
      failed,
      failureCount: failures.length,
    });
    this.emitUploadProgress(options, {
      stage: 'finished',
      callsign,
      submitted,
      skipped: preparation.blockedCount,
      uploaded,
      failed,
      failureCount: failures.length,
    });

    return {
      submitted,
      uploaded,
      skipped: preparation.blockedCount,
      failed,
      failures: failures.length > 0 ? failures : undefined,
    };
  }

  private async queryPendingQsos(
    logbook: ReturnType<PluginContext['logbook']['forCallsign']>,
    options?: Pick<SyncUploadOptions, 'since' | 'until' | 'includeAlreadyUploaded'>,
  ): Promise<QSORecord[]> {
    // Manual upload scans the whole logbook so historical unsent records stay recoverable.
    const allQsos = await logbook.queryQSOs({});
    return allQsos.filter((qso) => isUploadCandidate(qso, options));
  }

  private emitUploadProgress(options: SyncUploadOptions | undefined, progress: SyncUploadProgress): void {
    try {
      options?.onProgress?.(progress);
    } catch (error) {
      this.ctx.log.warn('LoTW upload progress push failed', {
        stage: progress.stage,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private emitDownloadProgress(options: SyncDownloadOptions | undefined, progress: SyncDownloadProgress): void {
    try {
      options?.onProgress?.(progress);
    } catch (error) {
      this.ctx.log.warn('LoTW download progress push failed', {
        stage: progress.stage,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async sleep(ms: number): Promise<void> {
    if (ms <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async withReportRequestSlot<T>(
    username: string,
    onWait: (waitMs: number) => void,
    task: () => Promise<T>,
  ): Promise<T> {
    const key = normalizeQsoCallsign(username || 'anonymous');
    const previous = LoTWSyncProvider.reportRequestQueues.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      const lastRequestAt = LoTWSyncProvider.lastReportRequestAt.get(key) ?? 0;
      const waitMs = Math.max(0, LOTW_DOWNLOAD_REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt));
      if (waitMs > 0) {
        onWait(waitMs);
        await this.sleep(waitMs);
      }
      LoTWSyncProvider.lastReportRequestAt.set(key, Date.now());
      return task();
    });

    const queued = run.catch(() => undefined);
    LoTWSyncProvider.reportRequestQueues.set(key, queued);
    try {
      return await run;
    } finally {
      if (LoTWSyncProvider.reportRequestQueues.get(key) === queued) {
        LoTWSyncProvider.reportRequestQueues.delete(key);
      }
    }
  }

  private async downloadWindow(
    config: LoTWPluginConfig,
    callsign: string,
    window: DownloadWindow,
    qslSinceDate: string,
    options: SyncDownloadOptions | undefined,
    progressBase: {
      windowIndex: number;
      windowCount: number;
      counters: DownloadCounters;
    },
  ): Promise<DownloadWindowFetchResult> {
    const params = new URLSearchParams({
      login: config.username,
      password: config.password,
      qso_query: '1',
      qso_qsl: 'yes',
      qso_qsldetail: 'yes',
      qso_mydetail: 'yes',
      qso_withown: 'yes',
      qso_qslsince: qslSinceDate,
      qso_startdate: window.startDate,
      qso_enddate: window.endDate,
    });
    if (window.startTime && window.endTime) {
      params.set('qso_starttime', window.startTime);
      params.set('qso_endtime', window.endTime);
    }
    const ownCall = this.resolveUploadLocation(config, callsign).callsign || callsign;
    if (ownCall) {
      params.set('qso_owncall', ownCall);
    }

    const range = formatDownloadWindowRange(window);
    const rangeDetail = `range=${range}`;
    const makeProgress = (stage: SyncDownloadProgress['stage'], extra: Partial<SyncDownloadProgress> = {}) => {
      this.emitDownloadProgress(options, {
        stage,
        callsign,
        windowIndex: progressBase.windowIndex,
        windowCount: progressBase.windowCount,
        range,
        downloaded: progressBase.counters.downloaded,
        matched: progressBase.counters.matched,
        updated: progressBase.counters.updated,
        imported: progressBase.counters.imported,
        failed: progressBase.counters.failed,
        failureCount: progressBase.counters.failureCount,
        ...extra,
      });
    };

    let lastRetryableFailure: SyncFailure | null = null;
    for (let attempt = 1; attempt <= LOTW_DOWNLOAD_MAX_RETRIES + 1; attempt++) {
      try {
        makeProgress('window_downloading', { attempt });
        const response = await this.withReportRequestSlot(config.username, (waitMs) => {
          makeProgress('window_waiting', {
            waitSeconds: Math.ceil(waitMs / 1000),
            attempt,
          });
        }, () => this.doFetch(LOTW_REPORT_URL + '?' + params.toString(), {
          method: 'GET',
          timeout: LOTW_DOWNLOAD_REQUEST_TIMEOUT_MS,
        }));
        const responseText = await response.text();

        if (!response.ok) {
          const described = describeLotwErrorResponse(responseText);
          const isRateLimited = described.code === 'lotw_rate_limited' || response.status === 429;
          const code = isRateLimited ? described.code : 'lotw_http_error';
          const message = isRateLimited ? described.message : `LoTW HTTP ${response.status}`;
          const detail = `${rangeDetail}; attempt=${attempt}; remote=${described.detail ?? summarizeLotwResponse(responseText)}`;
          lastRetryableFailure = this.createFailure(code, message, {
            source: 'remote',
            operation: 'download',
            httpStatus: response.status,
            detail,
            retryable: response.status >= 500 || response.status === 429,
            secrets: [config.username, config.password],
          });
        } else if (!isLotwAdifResponse(responseText)) {
          const described = describeLotwErrorResponse(responseText);
          const detail = `${rangeDetail}; attempt=${attempt}; remote=${described.detail ?? described.message}`;
          const failure = this.createFailure(described.code, described.message, {
            source: described.code === 'lotw_auth_failed' ? 'provider' : 'remote',
            operation: 'download',
            detail,
            retryable: described.code === 'lotw_rate_limited',
            secrets: [config.username, config.password],
          });
          if (!failure.retryable) {
            return { records: [], failures: [failure] };
          }
          lastRetryableFailure = failure;
        } else {
          try {
            return { records: parseADIFContent(responseText, 'lotw'), failures: [] };
          } catch (error) {
            const detail = `${rangeDetail}; attempt=${attempt}; remote=${summarizeLotwResponse(responseText)}`;
            return {
              records: [],
              failures: [
                this.createFailure('lotw_adif_parse_failed', error instanceof Error ? error.message : 'LoTW ADIF parse failed', {
                  source: 'remote',
                  operation: 'download',
                  detail,
                  retryable: false,
                  secrets: [config.username, config.password],
                }),
              ],
            };
          }
        }
      } catch (error) {
        const failureCode = this.isTimeoutError(error) ? 'lotw_download_timeout' : 'lotw_download_window_failed';
        const failure = this.errorFailure(error, 'download', failureCode, config);
        lastRetryableFailure = {
          ...failure,
          code: failureCode,
          retryable: true,
          detail: failure.detail ? `${rangeDetail}; attempt=${attempt}; ${failure.detail}` : `${rangeDetail}; attempt=${attempt}`,
        };
      }

      if (!lastRetryableFailure?.retryable || attempt > LOTW_DOWNLOAD_MAX_RETRIES) {
        break;
      }

      const waitMs = LOTW_DOWNLOAD_RETRY_BACKOFF_MS[Math.min(attempt - 1, LOTW_DOWNLOAD_RETRY_BACKOFF_MS.length - 1)] ?? 0;
      makeProgress('window_retrying', {
        attempt,
        waitSeconds: Math.ceil(waitMs / 1000),
        message: lastRetryableFailure.message,
      });
      await this.sleep(waitMs);
    }

    const failure = lastRetryableFailure ?? this.createFailure('lotw_download_window_failed', 'LoTW download window failed', {
      source: 'remote',
      operation: 'download',
      detail: rangeDetail,
      retryable: true,
      secrets: [config.username, config.password],
    });
    const shouldSplit = failure.retryable === true
      && failure.code !== 'lotw_rate_limited'
      && canSplitDownloadWindow(window);
    return { records: [], failures: [failure], shouldSplit };
  }

  private async findLotwLocalMatch(
    logbook: ReturnType<PluginContext['logbook']['forCallsign']>,
    remote: QSORecord,
    fallbackCallsign: string,
  ): Promise<QSORecord | null> {
    const candidates = await logbook.queryQSOs({
      callsign: remote.callsign,
      timeRange: {
        start: remote.startTime - LOTW_DOWNLOAD_MATCH_TOLERANCE_MS,
        end: (remote.endTime || remote.startTime) + LOTW_DOWNLOAD_MATCH_TOLERANCE_MS,
      },
      limit: 25,
    });

    if (candidates.length === 0) {
      return null;
    }

    const remoteStation = normalizeQsoCallsign(remote.myCallsign || fallbackCallsign);
    const remoteBand = lotwMatchBand(remote);
    const remoteMode = lotwMatchMode(remote);

    const scored = candidates
      .map((local) => {
        let score = 0;
        const localStation = normalizeQsoCallsign(local.myCallsign || fallbackCallsign);
        if (remoteStation && localStation === remoteStation) score += 8;
        if (remoteBand && lotwMatchBand(local) === remoteBand) score += 5;
        if (remoteMode && lotwMatchMode(local) === remoteMode) score += 5;
        const frequencyDelta = Math.abs((local.frequency || 0) - (remote.frequency || 0));
        if (frequencyDelta <= 3000) score += 2;
        const timeDelta = Math.abs((local.startTime || 0) - (remote.startTime || 0));
        score += Math.max(0, 3 - Math.floor(timeDelta / (5 * 60 * 1000)));
        return { local, score, timeDelta };
      })
      .filter(({ local }) => {
        const localStation = normalizeQsoCallsign(local.myCallsign || fallbackCallsign);
        if (remoteStation && localStation && localStation !== remoteStation) return false;
        if (remoteBand && lotwMatchBand(local) && lotwMatchBand(local) !== remoteBand) return false;
        if (remoteMode && lotwMatchMode(local) && lotwMatchMode(local) !== remoteMode) return false;
        return true;
      })
      .sort((left, right) => right.score - left.score || left.timeDelta - right.timeDelta);

    return scored[0]?.local ?? null;
  }

  private async processDownloadedRecords(
    logbook: ReturnType<PluginContext['logbook']['forCallsign']>,
    callsign: string,
    records: QSORecord[],
    importedKeys: Set<string>,
    failures: SyncFailure[],
  ): Promise<{ matched: number; updated: number; imported: number }> {
    let matched = 0;
    let updated = 0;
    let imported = 0;

    for (const remote of records) {
      try {
        const localMatch = await this.findLotwLocalMatch(logbook, remote, callsign);

        if (localMatch) {
          // Download sync is the source of truth for LoTW confirmation and
          // also backfills sent status for records uploaded elsewhere.
          await logbook.updateQSO(localMatch.id, {
            lotwQslSent: 'Y',
            lotwQslSentDate: localMatch.lotwQslSentDate ?? remote.lotwQslSentDate ?? remote.lotwQslReceivedDate ?? Date.now(),
            lotwQslReceived: 'Y',
            lotwQslReceivedDate: remote.lotwQslReceivedDate ?? Date.now(),
          });
          matched++;
          updated++;
        } else {
          const remoteKey = lotwQsoKey(remote, callsign);
          if (importedKeys.has(remoteKey)) {
            continue;
          }
          await logbook.addQSO(remote);
          importedKeys.add(remoteKey);
          imported++;
        }
      } catch (err) {
        failures.push(this.createFailure('lotw_download_logbook_failed', err instanceof Error ? err.message : 'Failed to process downloaded LoTW record', {
          source: 'logbook',
          operation: 'download',
          qsoId: remote.id,
          qsoCallsign: remote.callsign,
        }));
        this.ctx.log.warn('Failed to process downloaded LoTW record', {
          callsign: remote.callsign,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { matched, updated, imported };
  }

  async download(callsign: string, options?: SyncDownloadOptions): Promise<SyncDownloadResult> {
    const config = this.getConfig(callsign);
    if (!config?.username || !config?.password) {
      return {
        downloaded: 0,
        matched: 0,
        updated: 0,
        failures: [
          this.createFailure('lotw_credentials_missing', 'LoTW credentials not configured', {
            operation: 'download',
          }),
        ],
      };
    }
    const logbook = this.ctx.logbook.forCallsign(callsign);

    try {
      const since = options?.since
        ? startOfUtcDay(options.since)
        : (config.lastDownloadTime
          ? startOfUtcDay(config.lastDownloadTime)
          : startOfUtcDay(Date.parse(`${getDateDaysAgo(30)}T00:00:00.000Z`)));
      const until = options?.until ? endOfUtcDay(options.until) : endOfUtcDay(Date.now());

      if (!Number.isFinite(since) || !Number.isFinite(until) || since > until) {
        const failure = this.createFailure('lotw_download_range_invalid', 'LoTW download date range is invalid', {
          source: 'provider',
          operation: 'download',
          detail: `since=${options?.since ?? 'default'}; until=${options?.until ?? 'now'}`,
        });
        return { downloaded: 0, matched: 0, updated: 0, imported: 0, windowCount: 0, failures: [failure] };
      }

      const pendingWindows = buildDateWindows(since, until);
      let totalWindows = pendingWindows.length;
      let completedWindows = 0;
      const counters: DownloadCounters = {
        downloaded: 0,
        matched: 0,
        updated: 0,
        imported: 0,
        failed: 0,
        failureCount: 0,
      };
      const failures: SyncFailure[] = [];
      const importedKeys = new Set<string>();

      this.emitDownloadProgress(options, {
        stage: 'preparing',
        callsign,
        windowCount: totalWindows,
        downloaded: counters.downloaded,
        matched: counters.matched,
        updated: counters.updated,
        imported: counters.imported,
        failed: counters.failed,
        failureCount: counters.failureCount,
      });

      while (pendingWindows.length > 0) {
        const window = pendingWindows.shift()!;
        const windowIndex = completedWindows + 1;
        const range = formatDownloadWindowRange(window);
        const result = await this.downloadWindow(config, callsign, window, formatLotwQueryDate(since), options, {
          windowIndex,
          windowCount: totalWindows,
          counters,
        });

        if (result.records.length > 0) {
          counters.downloaded += result.records.length;
          this.emitDownloadProgress(options, {
            stage: 'window_processing',
            callsign,
            windowIndex,
            windowCount: totalWindows,
            range,
            recordCount: result.records.length,
            downloaded: counters.downloaded,
            matched: counters.matched,
            updated: counters.updated,
            imported: counters.imported,
            failed: counters.failed,
            failureCount: counters.failureCount,
          });
          const processed = await this.processDownloadedRecords(logbook, callsign, result.records, importedKeys, failures);
          counters.matched += processed.matched;
          counters.updated += processed.updated;
          counters.imported += processed.imported;
        }

        if (result.failures.length > 0 && result.shouldSplit && canSplitDownloadWindow(window)) {
          const splitWindows = splitDownloadWindow(window);
          totalWindows += splitWindows.length - 1;
          pendingWindows.unshift(...splitWindows);
          this.ctx.log.info('Splitting LoTW download window after retryable failure', {
            callsign,
            range,
            splitCount: splitWindows.length,
            reason: result.failures[0]?.code,
          });
          continue;
        }

        completedWindows++;
        if (result.failures.length > 0) {
          failures.push(...result.failures);
          counters.failureCount = failures.length;
          counters.failed += 1;
          this.emitDownloadProgress(options, {
            stage: 'window_failed',
            callsign,
            windowIndex: completedWindows,
            windowCount: totalWindows,
            range,
            downloaded: counters.downloaded,
            matched: counters.matched,
            updated: counters.updated,
            imported: counters.imported,
            failed: counters.failed,
            failureCount: counters.failureCount,
            message: result.failures[0]?.message,
          });
        } else {
          this.emitDownloadProgress(options, {
            stage: 'window_done',
            callsign,
            windowIndex: completedWindows,
            windowCount: totalWindows,
            range,
            recordCount: result.records.length,
            downloaded: counters.downloaded,
            matched: counters.matched,
            updated: counters.updated,
            imported: counters.imported,
            failed: counters.failed,
            failureCount: counters.failureCount,
          });
        }
      }

      this.ctx.log.info('Downloaded confirmation records', { count: counters.downloaded });

      // Update lastDownloadTime and notify
      if (failures.length === 0) {
        this.setConfig(callsign, { ...config, lastDownloadTime: Date.now() });
      }
      if (counters.matched > 0 || counters.imported > 0) {
        await logbook.notifyUpdated();
      }

      this.emitDownloadProgress(options, {
        stage: 'finished',
        callsign,
        windowCount: totalWindows,
        downloaded: counters.downloaded,
        matched: counters.matched,
        updated: counters.updated,
        imported: counters.imported,
        failed: counters.failed,
        failureCount: failures.length,
      });

      return {
        downloaded: counters.downloaded,
        matched: counters.matched,
        updated: counters.updated,
        imported: counters.imported,
        windowCount: totalWindows,
        failures: failures.length > 0 ? failures : undefined,
      };
    } catch (error) {
      this.ctx.log.error('Download failed', error);
      return {
        downloaded: 0,
        matched: 0,
        updated: 0,
        imported: 0,
        failures: [this.errorFailure(error, 'download', 'lotw_download_failed', config)],
      };
    }
  }

  // ========== Upload Preflight ==========

  async getUploadPreflight(
    callsign: string,
    optionsOrOverrideConfig?: SyncUploadPreflightOptions | LoTWPluginConfig | null,
    maybeOptions?: SyncUploadPreflightOptions,
  ): Promise<LoTWUploadPreflightResponse> {
    const overrideConfig = isUploadPreflightOptions(optionsOrOverrideConfig)
      ? null
      : optionsOrOverrideConfig;
    const options = isUploadPreflightOptions(optionsOrOverrideConfig)
      ? optionsOrOverrideConfig
      : maybeOptions;
    const config = this.getEffectiveConfig(callsign, overrideConfig);
    const certificates = await this.getCertificates(callsign);
    const validCerts = certificates.filter((item) => item.status === 'valid');
    const logbook = this.ctx.logbook.forCallsign(callsign);
    const allQsos = await logbook.queryQSOs({});
    const pendingQsos = allQsos.filter((qso) => isUploadCandidate(qso, options));
    const preparation = await this.prepareUpload(config, pendingQsos, callsign);
    const issues: LoTWUploadIssue[] = [...preparation.issues];

    if (!config.username || !config.password) {
      issues.push({
        code: 'credentials_missing',
        severity: 'info',
        message: 'LoTW login credentials not configured (needed for download only)',
      });
    }

    const selectedCertificates = preparation.matchedCertificates.length > 0
      ? preparation.matchedCertificates
      : (pendingQsos.length === 0 ? validCerts : []);
    const location = this.resolveUploadLocation(config, callsign);
    const hasBlockingIssue = issues.some((issue) => issue.severity === 'error');
    const blockingIssues = issues.filter((issue) => issue.severity === 'error');
    const canSkipBlocked = preparation.uploadableCount > 0
      && preparation.blockedCount > 0
      && blockingIssues.length > 0
      && blockingIssues.every(isSkippableUploadIssue);

    return {
      ready: !hasBlockingIssue,
      pendingCount: pendingQsos.length,
      uploadableCount: preparation.uploadableCount,
      blockedCount: preparation.blockedCount,
      canSkipBlocked,
      matchedCertificateIds: selectedCertificates.map((item) => item.id),
      selectedCertificates,
      locationSummary: {
        callsign: location.callsign,
        dxccId: location.dxccId,
        gridSquare: location.gridSquare,
        cqZone: location.cqZone,
        ituZone: location.ituZone,
        state: location.state,
        county: location.county,
      },
      issues: dedupeIssues(issues),
      guidance: Array.from(new Set(preparation.guidance)),
    };
  }

  // ========== Upload internals ==========

  private async prepareUpload(
    config: LoTWPluginConfig,
    qsos: QSORecord[],
    fallbackCallsign: string,
  ): Promise<UploadPreparation> {
    const issues: LoTWUploadIssue[] = [];
    const guidance: string[] = ['export_unprotected_p12', 'configure_station_location'];
    const location = this.resolveUploadLocation(config, fallbackCallsign);
    const certificateInventory = await this.listCertificateInventory(fallbackCallsign);
    const certificates = certificateInventory.map((entry) => this.toSummary(entry.certificate));
    const certificateById = new Map<string, StoredCertificate>(
      certificateInventory.map((entry) => [entry.canonicalId, entry.certificate] as [string, StoredCertificate]),
    );

    if (certificates.length === 0) {
      issues.push({ code: 'certificate_missing', severity: 'error', message: 'No LoTW certificate has been uploaded yet' });
      guidance.push('open_settings_and_upload_certificate');
    }

    const normalizedLocation = normalizeLoTWStationLocation(location);
    issues.push(...normalizedLocation.issues.map(lotwLocationIssueToUploadIssue));

    const suggestions = suggestStationLocation({
      callsign: location.callsign || fallbackCallsign,
      dxccId: location.dxccId,
      gridSquare: location.gridSquare,
      current: location,
    });
    for (const suggestion of suggestions.suggestions) {
      const currentValue = String((location as Record<string, unknown>)[suggestion.field] ?? '').trim();
      const suggestedValue = String(suggestion.value);
      if (currentValue && currentValue.toUpperCase() !== suggestedValue.toUpperCase()) {
        issues.push({
          code: suggestion.field === 'state' ? 'lotw_location_state_suggested' : 'lotw_location_zone_mismatch',
          severity: 'warning',
          message: `LoTW station ${suggestion.field} differs from the suggested ${suggestedValue}`,
          detail: `field=${suggestion.field}; value=${currentValue}; suggested=${suggestedValue}; source=${suggestion.source}; confidence=${suggestion.confidence}`,
        });
      }
    }
    issues.push(...this.createQsoLocationMismatchIssues(qsos, normalizedLocation.location ?? location));

    if (qsos.length === 0) {
      issues.push({ code: 'no_pending_qsos', severity: 'info', message: 'No pending QSOs need to be uploaded right now' });
    }

    const batches = new Map<string, PreparedBatch>();
    const matchedCertificates = new Map<string, LoTWCertificateSummary>();
    let blockedCount = 0;
    let certificateMismatchDetails = 0;
    let omittedCertificateMismatchDetails = 0;

    const pushCertificateMismatchIssue = (
      qso: QSORecord,
      stationCallsign: string,
      reasonOverride?: string,
    ): void => {
      if (certificateMismatchDetails >= LOTW_PREFLIGHT_DETAIL_LIMIT) {
        omittedCertificateMismatchDetails += 1;
        return;
      }
      certificateMismatchDetails += 1;
      issues.push(this.createCertificateMismatchIssue(
        qso,
        stationCallsign,
        location.dxccId,
        certificates,
        reasonOverride,
      ));
    };

    for (const qso of qsos) {
      const qsoCallsign = (qso.myCallsign || fallbackCallsign || '').trim().toUpperCase();
      if (!qsoCallsign) {
        blockedCount += 1;
        issues.push({ code: 'qso_callsign_missing', severity: 'error', message: 'Some QSO records are missing station callsign information' });
        continue;
      }

      if (qsoCallsign !== location.callsign) {
        blockedCount += 1;
        issues.push({ code: 'qso_callsign_mismatch', severity: 'error', message: 'Some QSOs belong to a different station callsign than the active LoTW upload configuration' });
        continue;
      }

      const summary = this.selectCertificateForQSO(qso, qsoCallsign, location.dxccId, certificates);
      if (!summary) {
        blockedCount += 1;
        pushCertificateMismatchIssue(qso, qsoCallsign);
        continue;
      }

      const stored = certificateById.get(summary.id);
      if (!stored) {
        blockedCount += 1;
        pushCertificateMismatchIssue(qso, qsoCallsign, `Matched certificate ${summary.id} but its backing file is missing`);
        continue;
      }

      matchedCertificates.set(summary.id, this.toSummary(stored));
      const existingBatch = batches.get(summary.id);
      if (existingBatch) {
        existingBatch.qsos.push(qso);
      } else {
        batches.set(summary.id, { certificate: stored, qsos: [qso] });
      }
    }

    if (omittedCertificateMismatchDetails > 0) {
      issues.push({
        code: 'certificate_date_range_mismatch',
        severity: 'error',
        message: `${omittedCertificateMismatchDetails} more QSO(s) do not match any uploaded LoTW certificate`,
        detail: `Only the first ${LOTW_PREFLIGHT_DETAIL_LIMIT} certificate mismatch QSO(s) are listed. Narrow the upload range or fix the station location/certificate mismatch and retry.`,
      });
    }

    return {
      issues: dedupeIssues(issues),
      guidance,
      matchedCertificates: Array.from(matchedCertificates.values()),
      batches: Array.from(batches.values()),
      uploadableCount: qsos.length - blockedCount,
      blockedCount,
    };
  }

  private createQsoLocationMismatchIssues(
    qsos: QSORecord[],
    location: LoTWResolvedUploadLocation,
  ): LoTWUploadIssue[] {
    const issues: LoTWUploadIssue[] = [];
    let omitted = 0;
    for (const qso of qsos) {
      const mismatches = this.describeQsoLocationMismatches(qso, location);
      if (mismatches.length === 0) continue;
      if (issues.length >= LOTW_PREFLIGHT_DETAIL_LIMIT) {
        omitted += 1;
        continue;
      }
      const workedCallsign = normalizeQsoCallsign(qso.callsign) || '(unknown)';
      const firstCode = mismatches.some((item) => item.field === 'MY_GRIDSQUARE')
        ? 'lotw_location_grid_mismatch'
        : 'lotw_location_zone_mismatch';
      issues.push({
        code: firstCode,
        severity: 'warning',
        message: `${workedCallsign} has MY_* fields that differ from the LoTW upload station location`,
        detail: [
          `qsoId=${qso.id || '(missing)'}`,
          `workedCallsign=${workedCallsign}`,
          ...mismatches.map((item) => `${item.field}: qso=${item.qsoValue}, station=${item.stationValue}`),
        ].join('; '),
        qsoId: qso.id,
        qsoCallsign: workedCallsign,
      });
    }
    if (omitted > 0) {
      issues.push({
        code: 'lotw_location_grid_mismatch',
        severity: 'warning',
        message: `${omitted} more QSO(s) have MY_* fields that differ from the LoTW upload station location`,
        detail: `Only the first ${LOTW_PREFLIGHT_DETAIL_LIMIT} QSO location mismatch warning(s) are listed. Narrow the upload range or update the station location/QSO MY_* fields.`,
      });
    }
    return issues;
  }

  private describeQsoLocationMismatches(
    qso: QSORecord,
    location: LoTWResolvedUploadLocation,
  ): Array<{ field: string; qsoValue: string; stationValue: string }> {
    const mismatches: Array<{ field: string; qsoValue: string; stationValue: string }> = [];
    const compare = (field: string, qsoValue: unknown, stationValue: unknown) => {
      const qsoText = normalizeLocationValue(String(qsoValue ?? ''));
      const stationText = normalizeLocationValue(String(stationValue ?? ''));
      if (qsoText && stationText && qsoText !== stationText) {
        mismatches.push({ field, qsoValue: qsoText, stationValue: stationText });
      }
    };

    compare('MY_GRIDSQUARE', qso.myGrid, location.gridSquare);
    compare('MY_DXCC', qso.myDxccId, location.dxccId);
    compare('MY_CQ_ZONE', qso.myCqZone, location.cqZone);
    compare('MY_ITU_ZONE', qso.myItuZone, location.ituZone);
    compare('MY_COUNTY', qso.myCounty, location.county);

    const qsoState = this.normalizeQsoStateForLocation(qso.myState, qso.myDxccId ?? location.dxccId, location);
    const stationState = normalizeLocationValue(location.state);
    if (qsoState && stationState && qsoState !== stationState) {
      mismatches.push({ field: 'MY_STATE', qsoValue: qsoState, stationValue: stationState });
    }
    return mismatches;
  }

  private normalizeQsoStateForLocation(
    state: string | undefined,
    dxccId: number | undefined,
    location: LoTWResolvedUploadLocation,
  ): string {
    if (!state) return '';
    const normalized = normalizeLoTWStationLocation({
      ...location,
      dxccId,
      state,
    }).location?.state;
    return normalizeLocationValue(normalized ?? state);
  }

  private selectCertificateForQSO(
    qso: QSORecord,
    callsign: string,
    dxccId: number | undefined,
    certificates: LoTWCertificateSummary[],
  ): LoTWCertificateSummary | null {
    const qsoTime = qso.startTime;
    const candidates = certificates
      .filter((c) => c.callsign === callsign)
      .filter((c) => !dxccId || c.dxccId === dxccId)
      .filter((c) => qsoTime >= c.qsoStartDate && qsoTime <= c.qsoEndDate)
      .sort((left, right) => {
        const leftRange = left.qsoEndDate - left.qsoStartDate;
        const rightRange = right.qsoEndDate - right.qsoStartDate;
        if (leftRange !== rightRange) return leftRange - rightRange;
        return right.validTo - left.validTo;
      });

    return candidates[0] || null;
  }

  private createCertificateMismatchIssue(
    qso: QSORecord,
    stationCallsign: string,
    dxccId: number | undefined,
    certificates: LoTWCertificateSummary[],
    reasonOverride?: string,
  ): LoTWUploadIssue {
    const qsoTime = qso.startTime;
    const workedCallsign = normalizeQsoCallsign(qso.callsign) || '(unknown)';
    const when = formatIssueTimestamp(qsoTime);
    const reason = reasonOverride || this.describeCertificateMismatch(qso, stationCallsign, dxccId, certificates);
    const certificateSummary = this.formatCertificateCandidates(certificates, stationCallsign);
    const detailParts = [
      `reason=${reason}`,
      `qsoId=${qso.id || '(missing)'}`,
      `workedCallsign=${workedCallsign}`,
      `stationCallsign=${stationCallsign || '(missing)'}`,
      `qsoTime=${when}`,
      `uploadDxcc=${dxccId ?? '(missing)'}`,
      `availableCertificates=${certificateSummary}`,
    ];

    return {
      code: 'certificate_date_range_mismatch',
      severity: 'error',
      message: `${workedCallsign} at ${when} does not match any uploaded LoTW certificate by station callsign, DXCC, and QSO date range`,
      detail: detailParts.join('; '),
      qsoId: qso.id,
      qsoCallsign: workedCallsign,
    };
  }

  private describeCertificateMismatch(
    qso: QSORecord,
    stationCallsign: string,
    dxccId: number | undefined,
    certificates: LoTWCertificateSummary[],
  ): string {
    if (certificates.length === 0) {
      return 'No LoTW certificates are uploaded';
    }

    const stationMatches = certificates.filter((cert) => cert.callsign === stationCallsign);
    if (stationMatches.length === 0) {
      return `No certificate matches station callsign ${stationCallsign || '(missing)'}`;
    }

    const dxccMatches = stationMatches.filter((cert) => !dxccId || cert.dxccId === dxccId);
    if (dxccId && dxccMatches.length === 0) {
      const availableDxcc = Array.from(new Set(stationMatches.map((cert) => cert.dxccId ?? 'missing'))).join(',');
      return `Station callsign matches, but configured upload DXCC ${dxccId} does not match certificate DXCC (${availableDxcc})`;
    }

    const qsoTime = qso.startTime;
    const dateMatches = dxccMatches.filter((cert) => qsoTime >= cert.qsoStartDate && qsoTime <= cert.qsoEndDate);
    if (dateMatches.length === 0) {
      return `Station callsign and DXCC match, but QSO time ${formatIssueTimestamp(qsoTime)} is outside certificate QSO date range`;
    }

    return 'No usable LoTW certificate could be selected for this QSO';
  }

  private formatCertificateCandidates(certificates: LoTWCertificateSummary[], stationCallsign: string): string {
    if (certificates.length === 0) {
      return 'none';
    }

    const relevant = certificates
      .filter((cert) => cert.callsign === stationCallsign)
      .slice(0, 10);
    const list = (relevant.length > 0 ? relevant : certificates.slice(0, 10)).map((cert) => (
      `${cert.id}{callsign=${cert.callsign},dxcc=${cert.dxccId ?? 'missing'},qsoRange=${formatLotwQueryDate(cert.qsoStartDate)}..${formatLotwQueryDate(cert.qsoEndDate)},status=${cert.status}}`
    ));
    const omitted = Math.max(0, (relevant.length > 0 ? certificates.filter((cert) => cert.callsign === stationCallsign).length : certificates.length) - list.length);
    return omitted > 0 ? `${list.join('|')}|and ${omitted} more` : list.join('|');
  }

  private splitPreparedBatches(batches: PreparedBatch[]): PreparedBatch[] {
    const split: PreparedBatch[] = [];
    for (const batch of batches) {
      for (let index = 0; index < batch.qsos.length; index += LOTW_UPLOAD_BATCH_SIZE) {
        split.push({
          certificate: batch.certificate,
          qsos: batch.qsos.slice(index, index + LOTW_UPLOAD_BATCH_SIZE),
        });
      }
    }
    return split;
  }

  private async uploadBatch(
    batch: PreparedBatch,
    location: LoTWResolvedUploadLocation,
  ): Promise<UploadBatchAcceptedResult> {
    const tq8Content = this.buildTq8Content(batch.qsos, batch.certificate, location);
    const compressed = gzipSync(Buffer.from(tq8Content, 'utf-8'), { level: 9 });
    const form = new FormData();
    const fileName = batch.certificate.callsign.toLowerCase() + '-' +
      new Date().toISOString().replace(/[:.]/g, '-') + '-tx5dr.tq8';
    form.append('upfile', new Blob([compressed], { type: 'application/octet-stream' }), fileName);

    const response = await this.doFetch(LOTW_UPLOAD_URL, {
      method: 'POST',
      body: form,
      timeout: 30000,
    });
    const body = await response.text();

    if (!response.ok || !/<!--\s*\.UPL\.\s*accepted\s*-->/i.test(body)) {
      const firstLine = summarizeLotwResponse(body) || 'LoTW server rejected the upload payload';
      this.ctx.log.warn('LoTW server rejected upload', { responseSnippet: firstLine });
      throw new LoTWRemoteError(
        `LoTW server rejected the upload payload: ${firstLine}`,
        response.ok ? undefined : response.status,
        response.status >= 500 || response.status === 429,
        firstLine,
      );
    }

    return {
      acceptedAt: Date.now(),
      responseSummary: summarizeLotwResponse(body),
    };
  }

  // ========== TQ8 generation ==========

  private buildTq8Content(
    qsos: QSORecord[],
    certificate: StoredCertificate,
    location: LoTWResolvedUploadLocation,
  ): string {
    const certBody = certificate.certPem
      .replace('-----BEGIN CERTIFICATE-----', '')
      .replace('-----END CERTIFICATE-----', '')
      .replace(/\s+/g, '');

    const lines = [
      '<TQSL_IDENT:54>TQSL V2.8.2 Lib: V2.6 Config: V11.34 AllowDupes: false',
      '',
      '<Rec_Type:5>tCERT',
      '<CERT_UID:1>1',
      '<CERTIFICATE:' + String(certBody.length + 1) + '>' + certBody,
      '',
      '<eor>',
      '',
      '<Rec_Type:8>tSTATION',
      '<STATION_UID:1>1',
      '<CERT_UID:1>1',
      '<CALL:' + String(location.callsign.length) + '>' + location.callsign,
      '<DXCC:' + String(String(location.dxccId || certificate.dxccId).length) + '>' + String(location.dxccId || certificate.dxccId),
      ...this.buildStationFields(location, certificate.dxccId),
      '<eor>',
      '',
    ];

    for (const qso of qsos) {
      const date = formatLoTWDate(qso.startTime);
      const time = formatLoTWTime(qso.startTime);
      const band = this.resolveBand(qso);
      const mode = toLotwContactMode(qso);
      const frequency = formatFrequencyMHz(qso.frequency);
      const signData = this.buildSignData({ qso, location, dxccId: certificate.dxccId, band, mode, frequency, date, time });
      const signature = this.signLog(certificate.privateKeyPem, signData);
      const wrappedSignature = this.wrapSignature(signature);
      const signatureLength = signature.length + Math.floor(signature.length / 64) + 1;

      lines.push(
        '<Rec_Type:8>tCONTACT',
        '<STATION_UID:1>1',
        '<CALL:' + String(qso.callsign.length) + '>' + qso.callsign.toUpperCase(),
        '<BAND:' + String(band.length) + '>' + band,
        '<MODE:' + String(mode.length) + '>' + mode,
        '<FREQ:' + String(frequency.length) + '>' + frequency,
        '<QSO_DATE:' + String(date.length) + '>' + date,
        '<QSO_TIME:' + String(time.length) + '>' + time,
        '<SIGN_LOTW_V2.0:' + String(signatureLength) + ':6>' + wrappedSignature,
        '<SIGNDATA:' + String(signData.length) + '>' + signData,
        '<eor>',
        '',
      );
    }

    return lines.join('\n');
  }

  private buildStationFields(
    location: LoTWResolvedUploadLocation,
    dxccId: number,
  ): string[] {
    const fields: string[] = [];
    if (location.gridSquare) {
      fields.push('<GRIDSQUARE:' + String(location.gridSquare.length) + '>' + location.gridSquare);
    }
    if (location.ituZone) {
      fields.push('<ITUZ:' + String(location.ituZone.length) + '>' + location.ituZone);
    }
    if (location.cqZone) {
      fields.push('<CQZ:' + String(location.cqZone.length) + '>' + location.cqZone);
    }
    if (location.iota) {
      fields.push('<IOTA:' + String(location.iota.length) + '>' + location.iota);
    }

    const canonical = normalizeLoTWStationLocation({ ...location, dxccId: location.dxccId ?? dxccId }).location;
    const state = normalizeLocationValue(canonical?.state ?? location.state);
    const county = normalizeLocationValue(canonical?.county ?? location.county);

    switch (dxccId) {
      case 1:
        if (state) fields.push('<CA_PROVINCE:' + String(state.length) + '>' + mapCanadaProvince(state));
        break;
      case 6:
      case 110:
      case 291:
        if (state) fields.push('<US_STATE:' + String(state.length) + '>' + state);
        if (county) fields.push('<US_COUNTY:' + String(county.length) + '>' + county);
        break;
      case 15:
      case 54:
      case 61:
      case 125:
      case 151:
        if (state) {
          const oblast = mapRussiaOblast(state);
          fields.push('<RU_OBLAST:' + String(oblast.length) + '>' + oblast);
        }
        break;
      case 150:
        if (state) fields.push('<AU_STATE:' + String(state.length) + '>' + state);
        break;
      case 318:
        if (state) fields.push('<CN_PROVINCE:' + String(state.length) + '>' + state);
        break;
      case 339:
        if (state) fields.push('<JA_PREFECTURE:' + String(state.length) + '>' + state);
        if (county) fields.push('<JA_CITY_GUN_KU:' + String(county.length) + '>' + county);
        break;
      case 5:
      case 224:
        if (state) fields.push('<FI_KUNTA:' + String(state.length) + '>' + state);
        break;
      default:
        break;
    }

    return fields;
  }

  private buildSignData(input: {
    qso: QSORecord;
    location: LoTWResolvedUploadLocation;
    dxccId: number;
    band: string;
    mode: string;
    frequency: string;
    date: string;
    time: string;
  }): string {
    const parts: string[] = [];
    const canonical = normalizeLoTWStationLocation({ ...input.location, dxccId: input.location.dxccId ?? input.dxccId }).location;
    const state = normalizeLocationValue(canonical?.state ?? input.location.state);
    const county = normalizeLocationValue(canonical?.county ?? input.location.county);

    if (input.dxccId === 150 && state) parts.push(state);
    if (input.dxccId === 1 && state) parts.push(mapCanadaProvince(state));
    if (input.dxccId === 318 && state) parts.push(state);
    if (input.location.cqZone) parts.push(input.location.cqZone);
    if ((input.dxccId === 5 || input.dxccId === 224) && state) parts.push(state);
    if (input.location.gridSquare) parts.push(input.location.gridSquare);
    if (input.location.iota) parts.push(input.location.iota);
    if (input.location.ituZone) parts.push(input.location.ituZone);
    if (input.dxccId === 339) {
      if (county) parts.push(county);
      if (state) parts.push(state);
    }
    if (input.dxccId === 15 || input.dxccId === 54 || input.dxccId === 61 || input.dxccId === 125 || input.dxccId === 151) {
      if (state) parts.push(mapRussiaOblast(state));
    }
    if (input.dxccId === 6 || input.dxccId === 110 || input.dxccId === 291) {
      if (county) parts.push(county);
      if (state) parts.push(state);
    }

    parts.push(
      input.band,
      input.qso.callsign.toUpperCase(),
      input.frequency,
      input.mode,
      input.date,
      input.time,
    );

    return parts.join('').toUpperCase();
  }

  private signLog(privateKeyPem: string, signData: string): string {
    try {
      const sha1Digest = createHash('sha1').update(signData, 'utf8').digest();
      const digestInfo = Buffer.concat([SHA1_DIGEST_INFO_PREFIX, sha1Digest]);
      return privateEncrypt(
        { key: privateKeyPem, padding: constants.RSA_PKCS1_PADDING },
        digestInfo,
      ).toString('base64');
    } catch (error) {
      this.ctx.log.error('Failed to sign LoTW payload', error);
      throw new Error(error instanceof Error ? `LoTW upload signing failed: ${error.message}` : 'LoTW upload signing failed');
    }
  }

  private wrapSignature(signature: string): string {
    const lines: string[] = [];
    for (let index = 0; index < signature.length; index += 64) {
      lines.push(signature.slice(index, index + 64));
    }
    return lines.join('\n') + '\n';
  }

  // ========== Location helpers ==========

  private resolveUploadLocation(config: LoTWPluginConfig, fallbackCallsign: string) {
    const location = config.uploadLocation || {
      callsign: '',
      gridSquare: '',
      cqZone: '',
      ituZone: '',
      iota: '',
      state: '',
      county: '',
    };
    return {
      callsign: (location.callsign || fallbackCallsign || '').trim().toUpperCase(),
      dxccId: location.dxccId,
      gridSquare: (location.gridSquare || '').trim().toUpperCase(),
      cqZone: (location.cqZone || '').trim(),
      ituZone: (location.ituZone || '').trim(),
      iota: (location.iota || '').trim().toUpperCase(),
      state: (location.state || '').trim().toUpperCase(),
      county: (location.county || '').trim().toUpperCase(),
    };
  }

  private resolveBand(qso: QSORecord): string {
    const band = getBandFromFrequency(qso.frequency);
    return band === 'Unknown' ? '20M' : band.toUpperCase();
  }

  // ========== Network helpers ==========

  private async doFetch(url: string, options: {
    method: string;
    headers?: Record<string, string>;
    body?: string | FormData;
    timeout?: number;
  }): Promise<Response> {
    const fetchFn = this.ctx.fetch;
    if (!fetchFn) {
      throw new Error('Network access not available (missing "network" permission)');
    }

    const init: RequestInit = {
      method: options.method,
      headers: {
        'User-Agent': 'TX5DR-LoTWSync/2.0',
        ...options.headers,
      },
      signal: AbortSignal.timeout(options.timeout ?? 15000),
    };

    if (options.body) {
      init.body = options.body;
    }

    return fetchFn(url, init);
  }

  private handleNetworkError(error: unknown): string {
    const e = error as any;
    if (e?.name === 'AbortError' || e?.code === 'ABORT_ERR' || e?.code === 'UND_ERR_CONNECT_TIMEOUT') {
      return 'Connection timeout: LoTW server response too slow';
    }
    if (e?.message?.includes('fetch failed')) {
      return 'Network request failed: check network connection and firewall';
    }
    return `LoTW connection failed: ${e?.message ?? 'Unknown error'}`;
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
      qsoId: options.qsoId,
      qsoCallsign: options.qsoCallsign,
      httpStatus: options.httpStatus,
      retryable: options.retryable,
      detail: options.detail,
      secrets: options.secrets,
    });
  }

  private errorFailure(
    error: unknown,
    operation: NonNullable<SyncFailure['operation']>,
    code: string,
    config?: LoTWPluginConfig,
  ): SyncFailure {
    const message = this.isNetworkError(error)
      ? this.handleNetworkError(error)
      : (error instanceof Error ? error.message : 'LoTW sync failed');
    return errorToSyncFailure(new Error(message), {
      code,
      message,
      source: this.isNetworkError(error) ? 'network' : 'remote',
      operation,
      providerId: this.id,
      retryable: this.isNetworkError(error),
      secrets: [config?.username, config?.password],
    });
  }

  private isNetworkError(error: unknown): boolean {
    const e = error as any;
    return e?.name === 'AbortError'
      || e?.code === 'ABORT_ERR'
      || e?.code === 'UND_ERR_CONNECT_TIMEOUT'
      || (typeof e?.message === 'string' && /fetch failed|network|timeout|connection/i.test(e.message));
  }

  private isTimeoutError(error: unknown): boolean {
    const e = error as any;
    return e?.name === 'AbortError'
      || e?.code === 'ABORT_ERR'
      || e?.code === 'UND_ERR_CONNECT_TIMEOUT'
      || (typeof e?.message === 'string' && /timeout|timed out|aborted/i.test(e.message));
  }
}
