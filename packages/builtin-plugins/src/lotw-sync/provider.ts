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
} from '@tx5dr/plugin-api';
import type { QSORecord } from '@tx5dr/contracts';
import { getBandFromFrequency, toLotwContactMode } from '@tx5dr/core';
import { getPluginPageScopePath, normalizeCallsign as normalizeCallsignBase } from '@tx5dr/plugin-api';

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

interface LoTWLocationRule {
  requiresState: boolean;
  requiresCounty: boolean;
  stateLabel: string;
  countyLabel: string;
}

/** DXCC location rules — determines which fields are required for upload signing. */
function getLoTWLocationRule(dxccId?: number | null): LoTWLocationRule {
  const defaults: LoTWLocationRule = { requiresState: false, requiresCounty: false, stateLabel: 'State/Province', countyLabel: 'County' };
  if (!dxccId) return defaults;
  // US (291), Alaska (6), Hawaii (110)
  if ([291, 6, 110].includes(dxccId)) return { requiresState: true, requiresCounty: true, stateLabel: 'US State', countyLabel: 'US County' };
  // Canada (1)
  if (dxccId === 1) return { requiresState: true, requiresCounty: false, stateLabel: 'Province', countyLabel: 'County' };
  // Russia (15, 54)
  if ([15, 54].includes(dxccId)) return { requiresState: true, requiresCounty: false, stateLabel: 'Oblast', countyLabel: 'County' };
  return defaults;
}
import { parseADIFContent } from '@tx5dr/plugin-api';

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

function classifyLotwErrorResponse(responseText: string): 'lotw_auth_failed' | 'lotw_response_invalid' {
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

  return authFailurePatterns.some(pattern => pattern.test(normalized))
    ? 'lotw_auth_failed'
    : 'lotw_response_invalid';
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

interface UploadPreparation {
  issues: LoTWUploadIssue[];
  guidance: string[];
  matchedCertificates: LoTWCertificateSummary[];
  batches: PreparedBatch[];
  uploadableCount: number;
  blockedCount: number;
}

// ===== Helpers =====

const CONFIG_KEY_PREFIX = 'config:';

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

function dedupeIssues(issues: LoTWUploadIssue[]): LoTWUploadIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = issue.code + ':' + issue.message;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  readonly id = 'lotw';
  readonly displayName = 'LoTW';
  readonly color = 'success' as const;
  readonly accessScope = 'operator' as const;
  readonly settingsPageId = 'settings';
  readonly actions: SyncAction[] = [
    { id: 'download', label: 'Download', icon: 'download', pageId: 'download-wizard' },
    { id: 'upload', label: 'Upload', icon: 'upload', operation: 'upload' },
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
      return { success: false, message: 'Username and password are required' };
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

      const response = await this.doFetch(url, { method: 'GET', timeout: 15000 });
      const responseText = await response.text();

      if (isLotwAdifResponse(responseText)) {
        return { success: true, message: 'lotw_connection_success' };
      }

      return { success: false, message: classifyLotwErrorResponse(responseText) };
    } catch (error) {
      this.ctx.log.error('Connection test failed', error);
      const message = this.handleNetworkError(error);
      return { success: false, message };
    }
  }

  async upload(callsign: string, options?: SyncUploadOptions): Promise<SyncUploadResult> {
    const config = this.getConfig(callsign);
    if (!config) {
      return { uploaded: 0, skipped: 0, failed: 0, errors: ['LoTW not configured'] };
    }
    const logbook = this.ctx.logbook.forCallsign(callsign);

    const pendingQsos = options?.records
      ? options.records.filter((qso) => qso.lotwQslSent !== 'Y')
      : await this.queryPendingQsos(logbook);

    if (pendingQsos.length === 0) {
      return { uploaded: 0, skipped: 0, failed: 0 };
    }

    const preparation = await this.prepareUpload(config, pendingQsos, callsign);
    const blockingIssue = preparation.issues.find((i) => i.severity === 'error');
    if (blockingIssue) {
      return {
        uploaded: 0,
        skipped: 0,
        failed: pendingQsos.length,
        errors: preparation.issues.filter((i) => i.severity === 'error').map((i) => i.message),
      };
    }

    const location = this.resolveUploadLocation(config, callsign);
    let uploaded = 0;
    const uploadedQsoIds: string[] = [];
    const errors: string[] = [];

    for (const batch of preparation.batches) {
      try {
        await this.uploadBatch(batch, location);
        uploaded += batch.qsos.length;
        uploadedQsoIds.push(...batch.qsos.map(q => q.id));
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Upload failed';
        errors.push(batch.certificate.callsign + ': ' + msg);
      }
    }

    // Mark uploaded QSOs with LoTW QSL sent status
    for (const qsoId of uploadedQsoIds) {
      try {
        await logbook.updateQSO(qsoId, {
          lotwQslSent: 'Y',
          lotwQslSentDate: Date.now(),
        });
      } catch (err) {
        this.ctx.log.warn('Failed to update QSL sent status', {
          qsoId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Update lastUploadTime
    if (uploaded > 0) {
      this.setConfig(callsign, { ...config, lastUploadTime: Date.now() });
      await logbook.notifyUpdated();
    }

    return {
      uploaded,
      skipped: preparation.blockedCount,
      failed: errors.length > 0 ? pendingQsos.length - uploaded - preparation.blockedCount : 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  private async queryPendingQsos(
    logbook: ReturnType<PluginContext['logbook']['forCallsign']>,
  ): Promise<QSORecord[]> {
    // Manual upload scans the whole logbook so historical unsent records stay recoverable.
    const allQsos = await logbook.queryQSOs({});
    return allQsos.filter((qso) => qso.lotwQslSent !== 'Y');
  }

  async download(callsign: string, options?: SyncDownloadOptions): Promise<SyncDownloadResult> {
    const config = this.getConfig(callsign);
    if (!config?.username || !config?.password) {
      return { downloaded: 0, matched: 0, updated: 0, errors: ['LoTW credentials not configured'] };
    }
    const logbook = this.ctx.logbook.forCallsign(callsign);

    try {
      const sinceDate = options?.since
        ? new Date(options.since).toISOString().split('T')[0]
        : (config.lastDownloadTime
          ? new Date(config.lastDownloadTime).toISOString().split('T')[0]
          : getDateDaysAgo(30));

      const params = new URLSearchParams({
        login: config.username,
        password: config.password,
        qso_query: '1',
        qso_qsl: 'yes',
        qso_qsldetail: 'yes',
        qso_qslsince: sinceDate,
      });
      const url = LOTW_REPORT_URL + '?' + params.toString();

      const response = await this.doFetch(url, { method: 'GET', timeout: 30000 });
      const responseText = await response.text();

      if (!isLotwAdifResponse(responseText)) {
        return { downloaded: 0, matched: 0, updated: 0, errors: [classifyLotwErrorResponse(responseText)] };
      }

      const remoteRecords = parseADIFContent(responseText, 'lotw');
      this.ctx.log.info('Downloaded confirmation records', { count: remoteRecords.length });

      let matched = 0;
      let imported = 0;
      const TIME_TOLERANCE_MS = 2 * 60 * 1000; // 2 minutes

      for (const remote of remoteRecords) {
        try {
          // Fuzzy match: same callsign, time within 2 minutes
          const candidates = await logbook.queryQSOs({
            callsign: remote.callsign,
            timeRange: {
              start: remote.startTime - TIME_TOLERANCE_MS,
              end: (remote.endTime || remote.startTime) + TIME_TOLERANCE_MS,
            },
            limit: 5,
          });

          // Find best match considering frequency proximity (3kHz tolerance)
          const FREQ_TOLERANCE_HZ = 3000;
          const localMatch = candidates.find(local =>
            Math.abs(local.frequency - remote.frequency) <= FREQ_TOLERANCE_HZ,
          ) ?? (candidates.length > 0 ? candidates[0] : null);

          if (localMatch) {
            // Update QSL confirmation status
            await logbook.updateQSO(localMatch.id, {
              lotwQslReceived: 'Y',
              lotwQslReceivedDate: remote.lotwQslReceivedDate ?? Date.now(),
            });
            matched++;
          } else {
            // Import as new record
            await logbook.addQSO(remote);
            imported++;
          }
        } catch (err) {
          this.ctx.log.warn('Failed to process downloaded LoTW record', {
            callsign: remote.callsign,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Update lastDownloadTime and notify
      if (matched > 0 || imported > 0) {
        this.setConfig(callsign, { ...config, lastDownloadTime: Date.now() });
        await logbook.notifyUpdated();
      }

      return {
        downloaded: remoteRecords.length,
        matched,
        updated: imported,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Download failed';
      this.ctx.log.error('Download failed', error);
      return { downloaded: 0, matched: 0, updated: 0, errors: [message] };
    }
  }

  // ========== Upload Preflight ==========

  async getUploadPreflight(
    callsign: string,
    overrideConfig?: LoTWPluginConfig | null,
  ): Promise<LoTWUploadPreflightResponse> {
    const config = this.getEffectiveConfig(callsign, overrideConfig);
    const certificates = await this.getCertificates(callsign);
    const validCerts = certificates.filter((item) => item.status === 'valid');
    const logbook = this.ctx.logbook.forCallsign(callsign);
    const allQsos = await logbook.queryQSOs({});
    const pendingQsos = allQsos.filter((qso) => qso.lotwQslSent !== 'Y');
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

    return {
      ready: !hasBlockingIssue,
      pendingCount: pendingQsos.length,
      uploadableCount: preparation.uploadableCount,
      blockedCount: preparation.blockedCount,
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
    const rule = getLoTWLocationRule(location.dxccId ?? null);

    const certificateInventory = await this.listCertificateInventory(fallbackCallsign);
    const certificates = certificateInventory.map((entry) => this.toSummary(entry.certificate));
    const certificateById = new Map<string, StoredCertificate>(
      certificateInventory.map((entry) => [entry.canonicalId, entry.certificate] as [string, StoredCertificate]),
    );

    if (certificates.length === 0) {
      issues.push({ code: 'certificate_missing', severity: 'error', message: 'No LoTW certificate has been uploaded yet' });
      guidance.push('open_settings_and_upload_certificate');
    }

    if (!location.callsign) {
      issues.push({ code: 'upload_location_callsign_missing', severity: 'error', message: 'LoTW upload callsign is not configured' });
    }
    if (!location.dxccId) {
      issues.push({ code: 'upload_location_dxcc_missing', severity: 'error', message: 'LoTW upload DXCC is not configured' });
    }
    if (!location.gridSquare) {
      issues.push({ code: 'upload_location_grid_missing', severity: 'error', message: 'LoTW upload grid square is not configured' });
    }
    if (!location.cqZone) {
      issues.push({ code: 'upload_location_cq_missing', severity: 'error', message: 'LoTW upload CQ zone is not configured' });
    }
    if (!location.ituZone) {
      issues.push({ code: 'upload_location_itu_missing', severity: 'error', message: 'LoTW upload ITU zone is not configured' });
    }
    if (rule.requiresState && !location.state) {
      issues.push({ code: 'upload_location_state_missing', severity: 'error', message: rule.stateLabel + ' is required for this DXCC' });
    }
    if (rule.requiresCounty && !location.county) {
      issues.push({ code: 'upload_location_county_missing', severity: 'error', message: (rule.countyLabel || 'County') + ' is required for this DXCC' });
    }

    if (qsos.length === 0) {
      issues.push({ code: 'no_pending_qsos', severity: 'info', message: 'No pending QSOs need to be uploaded right now' });
    }

    const batches = new Map<string, PreparedBatch>();
    const matchedCertificates = new Map<string, LoTWCertificateSummary>();
    let blockedCount = 0;

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
        issues.push({ code: 'certificate_date_range_mismatch', severity: 'error', message: 'Some QSOs do not match any uploaded certificate by callsign, DXCC, and QSO date range' });
        continue;
      }

      const stored = certificateById.get(summary.id);
      if (!stored) {
        blockedCount += 1;
        issues.push({ code: 'certificate_date_range_mismatch', severity: 'error', message: 'Some QSOs do not match any uploaded certificate by callsign, DXCC, and QSO date range' });
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

    return {
      issues: dedupeIssues(issues),
      guidance,
      matchedCertificates: Array.from(matchedCertificates.values()),
      batches: Array.from(batches.values()),
      uploadableCount: qsos.length - blockedCount,
      blockedCount,
    };
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

  private async uploadBatch(
    batch: PreparedBatch,
    location: ReturnType<LoTWSyncProvider['resolveUploadLocation']>,
  ): Promise<void> {
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

    if (!/<!--\s*\.UPL\.\s*accepted\s*-->/i.test(body)) {
      const firstLine = body.split('\n').map((l) => l.trim()).find(Boolean) || 'LoTW server rejected the upload payload';
      this.ctx.log.warn('LoTW server rejected upload', { responseSnippet: firstLine });
      throw new Error('lotw_upload_rejected');
    }
  }

  // ========== TQ8 generation ==========

  private buildTq8Content(
    qsos: QSORecord[],
    certificate: StoredCertificate,
    location: ReturnType<LoTWSyncProvider['resolveUploadLocation']>,
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
    location: ReturnType<LoTWSyncProvider['resolveUploadLocation']>,
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

    const state = normalizeLocationValue(location.state);
    const county = normalizeLocationValue(location.county);

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
    location: ReturnType<LoTWSyncProvider['resolveUploadLocation']>;
    dxccId: number;
    band: string;
    mode: string;
    frequency: string;
    date: string;
    time: string;
  }): string {
    const parts: string[] = [];
    const state = normalizeLocationValue(input.location.state);
    const county = normalizeLocationValue(input.location.county);

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
      throw new Error('lotw_upload_sign_failed');
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
      return 'lotw_network_timeout';
    }
    if (e?.message?.includes('fetch failed')) {
      return 'lotw_network_failed';
    }
    return 'lotw_connection_failed';
  }
}
