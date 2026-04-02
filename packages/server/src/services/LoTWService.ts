/* eslint-disable @typescript-eslint/no-explicit-any */

import { createSign } from 'crypto';
import { gzipSync } from 'zlib';
import {
  getLoTWLocationRule,
  type LoTWCertificateSummary,
  type LoTWConfig,
  type LoTWUploadIssue,
  type LoTWUploadPreflightResponse,
  type LoTWSyncResponse,
  type QSORecord,
} from '@tx5dr/contracts';
import { getBandFromFrequency } from '@tx5dr/core';
import { parseADIFContent } from '../utils/adif-utils.js';
import { createLogger } from '../utils/logger.js';
import { LoTWCertificateStore, type StoredLoTWCertificate } from './LoTWCertificateStore.js';

const logger = createLogger('LoTWService');
const LOTW_UPLOAD_URL = 'https://lotw.arrl.org/lotw/upload';
const LOTW_CONNECTION_SUCCESS = 'lotw_connection_success';

type LoTWErrorCode =
  | 'lotw_credentials_missing'
  | 'lotw_auth_failed'
  | 'lotw_response_invalid'
  | 'lotw_network_timeout'
  | 'lotw_network_failed'
  | 'lotw_connection_failed'
  | 'lotw_upload_sign_failed'
  | 'lotw_upload_rejected'
  | 'lotw_upload_batch_failed';

type PreparedBatch = {
  certificate: StoredLoTWCertificate;
  qsos: QSORecord[];
};

type UploadPreparation = {
  issues: LoTWUploadIssue[];
  guidance: string[];
  matchedCertificates: LoTWCertificateSummary[];
  batches: PreparedBatch[];
  uploadableCount: number;
  blockedCount: number;
};

export class LoTWService {
  private config: LoTWConfig;
  private certificateStore: LoTWCertificateStore;

  constructor(config: LoTWConfig) {
    this.config = config;
    this.certificateStore = new LoTWCertificateStore();
  }

  updateConfig(config: LoTWConfig): void {
    this.config = config;
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    if (!this.config.username || !this.config.password) {
      return {
        success: false,
        message: 'lotw_credentials_missing',
      };
    }

    try {
      const params = new URLSearchParams({
        login: this.config.username,
        password: this.config.password,
        qso_query: '1',
        qso_qsldetail: 'yes',
        qso_qsl: 'yes',
        qso_qslsince: '2099-01-01',
      });
      const url = 'https://lotw.arrl.org/lotwuser/lotwreport.adi?' + params.toString();
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'User-Agent': 'TX5DR-LoTWSync/2.0' },
        signal: AbortSignal.timeout(15000),
      });
      const responseText = await response.text();
      const lowerText = responseText.toLowerCase();

      if (lowerText.includes('<eoh>')) {
        return {
          success: true,
          message: LOTW_CONNECTION_SUCCESS,
        };
      }

      if (lowerText.includes('password') || lowerText.includes('incorrect') || lowerText.includes('invalid')) {
        return {
          success: false,
          message: 'lotw_auth_failed',
        };
      }

      return {
        success: false,
        message: 'lotw_response_invalid',
      };
    } catch (error) {
      logger.error('Connection test failed:', error);
      const networkError = this.handleNetworkError(error, 'https://lotw.arrl.org');
      return {
        success: false,
        message: networkError.message,
      };
    }
  }

  async getUploadPreflight(qsos: QSORecord[], fallbackCallsign: string): Promise<LoTWUploadPreflightResponse> {
    const preparation = await this.prepareUpload(qsos, fallbackCallsign);
    const location = this.getUploadLocation(fallbackCallsign);
    const hasBlockingIssue = preparation.issues.some((issue) => issue.severity === 'error');

    return {
      ready: !hasBlockingIssue && preparation.uploadableCount > 0,
      pendingCount: qsos.length,
      uploadableCount: preparation.uploadableCount,
      blockedCount: preparation.blockedCount,
      matchedCertificateIds: preparation.matchedCertificates.map((item) => item.id),
      selectedCertificates: preparation.matchedCertificates,
      locationSummary: {
        callsign: location.callsign,
        dxccId: location.dxccId,
        gridSquare: location.gridSquare,
        cqZone: location.cqZone,
        ituZone: location.ituZone,
        state: location.state,
        county: location.county,
      },
      issues: preparation.issues,
      guidance: Array.from(new Set(preparation.guidance)),
    };
  }

  async uploadQSOs(qsos: QSORecord[], fallbackCallsign: string): Promise<LoTWSyncResponse> {
    if (qsos.length === 0) {
      return {
        success: true,
        message: 'No QSO records to upload',
        uploadedCount: 0,
        downloadedCount: 0,
        confirmedCount: 0,
        updatedCount: 0,
        importedCount: 0,
        errorCount: 0,
        syncTime: Date.now(),
      };
    }

    const preparation = await this.prepareUpload(qsos, fallbackCallsign);
    const blockingIssue = preparation.issues.find((issue) => issue.severity === 'error');
    if (blockingIssue) {
      return {
        success: false,
        message: blockingIssue.message,
        errorCode: blockingIssue.code,
        uploadedCount: 0,
        downloadedCount: 0,
        confirmedCount: 0,
        updatedCount: 0,
        importedCount: 0,
        errorCount: preparation.issues.filter((issue) => issue.severity === 'error').length || 1,
        errors: preparation.issues.map((issue) => issue.message),
        syncTime: Date.now(),
      };
    }

    const location = this.getUploadLocation(fallbackCallsign);
    let uploadedCount = 0;
    const errors: string[] = [];

    for (const batch of preparation.batches) {
      try {
        await this.uploadBatch(batch, location);
        uploadedCount += batch.qsos.length;
      } catch (error) {
        const errorCode = this.getErrorCode(error, 'lotw_upload_batch_failed');
        errors.push(batch.certificate.callsign + ': ' + errorCode);
      }
    }

    const uniqueErrorCodes = Array.from(new Set(errors.map((item) => item.split(': ').pop() || 'lotw_upload_batch_failed')));
    const errorCode = uniqueErrorCodes.length === 1 ? uniqueErrorCodes[0] : 'lotw_upload_batch_failed';

    return {
      success: errors.length === 0,
      message: errors.length === 0
        ? 'Successfully uploaded ' + uploadedCount + ' QSO records to LoTW'
        : 'Uploaded ' + uploadedCount + ' QSO records, ' + errors.length + ' upload batch failed',
      errorCode: errors.length > 0 ? errorCode : undefined,
      uploadedCount,
      downloadedCount: 0,
      confirmedCount: 0,
      updatedCount: 0,
      importedCount: 0,
      errorCount: errors.length,
      errors: errors.length > 0 ? errors : undefined,
      syncTime: Date.now(),
    };
  }

  async downloadConfirmations(since?: string): Promise<{ records: QSORecord[]; confirmedCount: number }> {
    if (!this.config.username || !this.config.password) {
      throw new Error('lotw_credentials_missing');
    }

    const sinceDate = since || this.getDateDaysAgo(30);
    const params = new URLSearchParams({
      login: this.config.username,
      password: this.config.password,
      qso_query: '1',
      qso_qsl: 'yes',
      qso_qsldetail: 'yes',
      qso_qslsince: sinceDate,
    });

    const url = 'https://lotw.arrl.org/lotwuser/lotwreport.adi?' + params.toString();

    try {
      logger.debug('Downloading confirmations since ' + sinceDate + '...');
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'User-Agent': 'TX5DR-LoTWSync/2.0' },
        signal: AbortSignal.timeout(30000),
      });
      const responseText = await response.text();
      const lowerText = responseText.toLowerCase();

      if (lowerText.includes('password') || lowerText.includes('incorrect') || lowerText.includes('invalid')) {
        throw new Error('lotw_auth_failed');
      }
      if (!lowerText.includes('<eoh>')) {
        throw new Error('lotw_response_invalid');
      }

      const records = parseADIFContent(responseText, 'lotw');
      logger.info('Downloaded ' + records.length + ' confirmation records');
      return {
        records,
        confirmedCount: records.length,
      };
    } catch (error) {
      logger.error('Failed to download confirmation records:', error);
      throw this.handleNetworkError(error, url);
    }
  }

  private async prepareUpload(qsos: QSORecord[], fallbackCallsign: string): Promise<UploadPreparation> {
    const issues: LoTWUploadIssue[] = [];
    const guidance: string[] = [
      'export_unprotected_p12',
      'configure_station_location',
    ];
    const location = this.getUploadLocation(fallbackCallsign);
    const rule = getLoTWLocationRule(location.dxccId ?? null);

    if ((this.config.certificates || []).length === 0) {
      issues.push({
        code: 'certificate_missing',
        severity: 'error',
        message: 'No LoTW certificate has been uploaded yet',
      });
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

    const certificateCache = new Map<string, StoredLoTWCertificate>();
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

      const summary = this.selectCertificateForQSO(qso, qsoCallsign, location.dxccId);
      if (!summary) {
        blockedCount += 1;
        issues.push({ code: 'certificate_date_range_mismatch', severity: 'error', message: 'Some QSOs do not match any uploaded certificate by callsign, DXCC, and QSO date range' });
        continue;
      }

      let stored = certificateCache.get(summary.id);
      if (!stored) {
        try {
          stored = await this.certificateStore.readCertificate(summary.id);
          certificateCache.set(summary.id, stored);
        } catch {
          blockedCount += 1;
          issues.push({ code: 'certificate_missing', severity: 'error', message: 'An uploaded certificate metadata entry exists, but the certificate file is missing on disk' });
          continue;
        }
      }

      matchedCertificates.set(summary.id, this.certificateStore.toSummary(stored));
      const existingBatch = batches.get(summary.id);
      if (existingBatch) {
        existingBatch.qsos.push(qso);
      } else {
        batches.set(summary.id, {
          certificate: stored,
          qsos: [qso],
        });
      }
    }

    return {
      issues: this.dedupeIssues(issues),
      guidance,
      matchedCertificates: Array.from(matchedCertificates.values()),
      batches: Array.from(batches.values()),
      uploadableCount: qsos.length - blockedCount,
      blockedCount,
    };
  }

  private selectCertificateForQSO(qso: QSORecord, callsign: string, dxccId?: number): LoTWCertificateSummary | null {
    const qsoTime = qso.startTime;
    const candidates = (this.config.certificates || [])
      .filter((certificate) => certificate.callsign === callsign)
      .filter((certificate) => !dxccId || certificate.dxccId === dxccId)
      .filter((certificate) => qsoTime >= certificate.qsoStartDate && qsoTime <= certificate.qsoEndDate)
      .sort((left, right) => {
        const leftRange = left.qsoEndDate - left.qsoStartDate;
        const rightRange = right.qsoEndDate - right.qsoStartDate;
        if (leftRange !== rightRange) {
          return leftRange - rightRange;
        }
        return right.validTo - left.validTo;
      });

    return candidates[0] || null;
  }

  private async uploadBatch(batch: PreparedBatch, location: ReturnType<LoTWService['getUploadLocation']>): Promise<void> {
    const tq8Content = this.buildTq8Content(batch.qsos, batch.certificate, location);
    const compressed = gzipSync(Buffer.from(tq8Content, 'utf-8'), { level: 9 });
    const form = new FormData();
    const fileName = batch.certificate.callsign.toLowerCase() + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '-tx5dr.tq8';
    form.append('upfile', new Blob([compressed], { type: 'application/octet-stream' }), fileName);

    const response = await fetch(LOTW_UPLOAD_URL, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(30000),
    });
    const body = await response.text();

    if (!/<!--\s*\.UPL\.\s*accepted\s*-->/i.test(body)) {
      logger.warn('LoTW server rejected upload payload', {
        responseSnippet: this.extractUploadFailure(body),
      });
      throw new Error('lotw_upload_rejected');
    }
  }

  private buildTq8Content(
    qsos: QSORecord[],
    certificate: StoredLoTWCertificate,
    location: ReturnType<LoTWService['getUploadLocation']>
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
      const date = this.formatLoTWDate(qso.startTime);
      const time = this.formatLoTWTime(qso.startTime);
      const band = this.resolveBand(qso);
      const mode = (qso.mode || 'FT8').toUpperCase();
      const frequency = this.formatFrequencyMHz(qso.frequency);
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
        ''
      );
    }

    return lines.join('\n');
  }

  private buildStationFields(location: ReturnType<LoTWService['getUploadLocation']>, dxccId: number): string[] {
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

    const state = this.normalizeLocationValue(location.state);
    const county = this.normalizeLocationValue(location.county);

    switch (dxccId) {
      case 1:
        if (state) fields.push('<CA_PROVINCE:' + String(state.length) + '>' + this.mapCanadaProvince(state));
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
          const oblast = this.mapRussiaOblast(state);
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
    location: ReturnType<LoTWService['getUploadLocation']>;
    dxccId: number;
    band: string;
    mode: string;
    frequency: string;
    date: string;
    time: string;
  }): string {
    const parts: string[] = [];
    const state = this.normalizeLocationValue(input.location.state);
    const county = this.normalizeLocationValue(input.location.county);

    if (input.dxccId === 150 && state) parts.push(state);
    if (input.dxccId === 1 && state) parts.push(this.mapCanadaProvince(state));
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
    if ((input.dxccId === 15 || input.dxccId === 54 || input.dxccId === 61 || input.dxccId === 125 || input.dxccId === 151) && state) {
      parts.push(this.mapRussiaOblast(state));
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
      const signer = createSign('RSA-SHA1');
      signer.update(signData, 'utf8');
      signer.end();
      return signer.sign(privateKeyPem).toString('base64');
    } catch (error) {
      logger.error('Failed to sign LoTW payload:', error);
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

  private getUploadLocation(fallbackCallsign: string) {
    const location = this.config.uploadLocation || {
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

  private normalizeLocationValue(value?: string): string {
    return (value || '').trim().toUpperCase();
  }

  private resolveBand(qso: QSORecord): string {
    const band = getBandFromFrequency(qso.frequency);
    return band === 'Unknown' ? '20M' : band.toUpperCase();
  }

  private formatLoTWDate(timestamp: number): string {
    return new Date(timestamp).toISOString().slice(0, 10);
  }

  private formatLoTWTime(timestamp: number): string {
    return new Date(timestamp).toISOString().slice(11, 19) + 'Z';
  }

  private formatFrequencyMHz(frequencyHz: number): string {
    const value = Number((frequencyHz / 1000000).toFixed(6));
    return value.toString();
  }

  private mapCanadaProvince(value: string): string {
    if (value === 'QC') return 'PQ';
    if (value === 'NL') return 'NF';
    return value;
  }

  private mapRussiaOblast(value: string): string {
    if (value === 'YR') return 'JA';
    if (value === 'YN') return 'JN';
    return value;
  }

  private extractUploadFailure(body: string): string {
    const firstLine = body
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean);
    return firstLine || 'LoTW server rejected the upload payload';
  }

  private dedupeIssues(issues: LoTWUploadIssue[]): LoTWUploadIssue[] {
    const seen = new Set<string>();
    return issues.filter((issue) => {
      const key = issue.code + ':' + issue.message;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  private getDateDaysAgo(days: number): string {
    const date = new Date();
    date.setDate(date.getDate() - days);
    return date.toISOString().split('T')[0];
  }

  private handleNetworkError(error: any, url: string): Error {
    const errorCode = error.code || error.cause?.code;
    const sanitizedUrl = this.sanitizeLoTWUrl(url);

    logger.error('Network error:', {
      message: error.message,
      code: errorCode,
      cause: error.cause,
      url: sanitizedUrl,
    });

    if (error instanceof Error && this.isKnownErrorCode(error.message)) {
      return error;
    }
    if (error.name === 'AbortError' || errorCode === 'ABORT_ERR' || errorCode === 'UND_ERR_CONNECT_TIMEOUT') {
      return new Error('lotw_network_timeout');
    }
    if (error.message?.includes('fetch failed')) {
      return new Error('lotw_network_failed');
    }

    return new Error('lotw_connection_failed');
  }

  private getErrorCode(error: unknown, fallback: LoTWErrorCode): LoTWErrorCode | string {
    if (error instanceof Error && this.isKnownErrorCode(error.message)) {
      return error.message as LoTWErrorCode;
    }
    return fallback;
  }

  private isKnownErrorCode(message: string): message is LoTWErrorCode | typeof LOTW_CONNECTION_SUCCESS {
    return new Set<string>([
      LOTW_CONNECTION_SUCCESS,
      'lotw_credentials_missing',
      'lotw_auth_failed',
      'lotw_response_invalid',
      'lotw_network_timeout',
      'lotw_network_failed',
      'lotw_connection_failed',
      'lotw_upload_sign_failed',
      'lotw_upload_rejected',
      'lotw_upload_batch_failed',
    ]).has(message);
  }

  private sanitizeLoTWUrl(url: string): string {
    try {
      const parsed = new URL(url);
      if (parsed.searchParams.has('login')) parsed.searchParams.set('login', '***');
      if (parsed.searchParams.has('password')) parsed.searchParams.set('password', '***');
      return parsed.toString();
    } catch {
      return url;
    }
  }
}
