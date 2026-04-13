/**
 * ADIF (Amateur Data Interchange Format) utilities
 *
 * Provides parsing, generation and conversion of ADIF format records.
 * Used by logbook sync plugins (WaveLog, QRZ, LoTW).
 */

import type { QSORecord } from '@tx5dr/contracts';
import { getBandFromFrequency, resolveDXCCEntity, DXCC_RESOLVER_VERSION } from '@tx5dr/core';
import { parseLegacyComment, resolveQsoComment } from './qso-text-fields.js';

function mapAdifModeToInternal(mode?: string, submode?: string): Pick<QSORecord, 'mode' | 'submode'> {
  const normalizedMode = mode?.trim().toUpperCase();
  const normalizedSubmode = submode?.trim().toUpperCase();

  if (normalizedMode === 'MFSK' && normalizedSubmode === 'FT4') {
    return { mode: 'FT4', submode: 'FT4' };
  }

  return {
    mode: mode || 'FT8',
    submode: submode || undefined,
  };
}

function mapInternalModeToAdif(mode?: string, submode?: string): { mode: string; submode?: string } {
  const normalizedMode = mode?.trim().toUpperCase();
  const normalizedSubmode = submode?.trim().toUpperCase();

  if (normalizedMode === 'FT4') {
    return { mode: 'MFSK', submode: 'FT4' };
  }

  if (normalizedMode === 'MFSK' && normalizedSubmode) {
    return { mode: 'MFSK', submode: normalizedSubmode };
  }

  return {
    mode: mode || 'FT8',
    submode: submode || undefined,
  };
}

/**
 * Format a Date as ADIF date string (YYYYMMDD).
 */
export function formatADIFDate(date: Date): string {
  const year = date.getUTCFullYear().toString().padStart(4, '0');
  const month = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = date.getUTCDate().toString().padStart(2, '0');
  return `${year}${month}${day}`;
}

/**
 * Format a Date as ADIF time string (HHMMSS).
 */
export function formatADIFTime(date: Date): string {
  const hours = date.getUTCHours().toString().padStart(2, '0');
  const minutes = date.getUTCMinutes().toString().padStart(2, '0');
  const seconds = date.getUTCSeconds().toString().padStart(2, '0');
  return `${hours}${minutes}${seconds}`;
}

/**
 * Parse ADIF date and time strings into an ISO date string.
 * @param dateStr ADIF date format YYYYMMDD
 * @param timeStr ADIF time format HHMMSS or HHMM
 */
export function parseADIFDateTime(dateStr: string, timeStr: string): string {
  const year = dateStr.substring(0, 4);
  const month = dateStr.substring(4, 6);
  const day = dateStr.substring(6, 8);

  const hour = timeStr.substring(0, 2);
  const minute = timeStr.substring(2, 4);
  const second = timeStr.substring(4, 6) || '00';

  return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`).toISOString();
}

/**
 * Convert a QSORecord to a single ADIF record string.
 */
export function convertQSOToADIF(qso: QSORecord, options?: {
  includeStationCallsign?: boolean;
  includeMyGrid?: boolean;
}): string {
  const adifFields: string[] = [];
  const opts = { includeStationCallsign: false, includeMyGrid: true, ...options };
  const adifMode = mapInternalModeToAdif(qso.mode, qso.submode);

  adifFields.push(`<call:${qso.callsign.length}>${qso.callsign}`);

  const startTime = new Date(qso.startTime);
  const qsoDate = formatADIFDate(startTime);
  const qsoTime = formatADIFTime(startTime);

  adifFields.push(`<qso_date:8>${qsoDate}`);
  adifFields.push(`<time_on:6>${qsoTime}`);

  if (qso.endTime) {
    const endTime = new Date(qso.endTime);
    adifFields.push(`<qso_date_off:8>${formatADIFDate(endTime)}`);
    adifFields.push(`<time_off:6>${formatADIFTime(endTime)}`);
  } else {
    adifFields.push(`<qso_date_off:8>${qsoDate}`);
    adifFields.push(`<time_off:6>${qsoTime}`);
  }

  if (adifMode.mode) {
    adifFields.push(`<mode:${adifMode.mode.length}>${adifMode.mode}`);
  }
  if (adifMode.submode) {
    adifFields.push(`<submode:${adifMode.submode.length}>${adifMode.submode}`);
  }

  const freqMHz = (qso.frequency / 1000000).toFixed(6);
  adifFields.push(`<freq:${freqMHz.length}>${freqMHz}`);

  const band = getBandFromFrequency(qso.frequency);
  if (band !== 'Unknown') {
    adifFields.push(`<band:${band.length}>${band}`);
  }

  if (qso.grid) {
    adifFields.push(`<gridsquare:${qso.grid.length}>${qso.grid}`);
  }
  if (qso.dxccId) {
    const value = String(qso.dxccId);
    adifFields.push(`<dxcc:${value.length}>${value}`);
  }
  if (qso.dxccEntity) {
    adifFields.push(`<country:${qso.dxccEntity.length}>${qso.dxccEntity}`);
  }
  if (qso.cqZone) {
    const value = String(qso.cqZone);
    adifFields.push(`<cqz:${value.length}>${value}`);
  }
  if (qso.ituZone) {
    const value = String(qso.ituZone);
    adifFields.push(`<ituz:${value.length}>${value}`);
  }

  if (qso.reportSent) {
    adifFields.push(`<rst_sent:${qso.reportSent.length}>${qso.reportSent}`);
  }
  if (qso.reportReceived) {
    adifFields.push(`<rst_rcvd:${qso.reportReceived.length}>${qso.reportReceived}`);
  }

  if (opts.includeStationCallsign && qso.myCallsign) {
    adifFields.push(`<station_callsign:${qso.myCallsign.length}>${qso.myCallsign}`);
  }
  if (qso.myDxccId) {
    const value = String(qso.myDxccId);
    adifFields.push(`<my_dxcc:${value.length}>${value}`);
  }
  if (qso.myCqZone) {
    const value = String(qso.myCqZone);
    adifFields.push(`<my_cq_zone:${value.length}>${value}`);
  }
  if (qso.myItuZone) {
    const value = String(qso.myItuZone);
    adifFields.push(`<my_itu_zone:${value.length}>${value}`);
  }
  if (qso.myState) {
    adifFields.push(`<my_state:${qso.myState.length}>${qso.myState}`);
  }
  if (qso.myCounty) {
    adifFields.push(`<my_cnty:${qso.myCounty.length}>${qso.myCounty}`);
  }
  if (qso.myIota) {
    adifFields.push(`<my_iota:${qso.myIota.length}>${qso.myIota}`);
  }

  if (opts.includeMyGrid && qso.myGrid) {
    adifFields.push(`<my_gridsquare:${qso.myGrid.length}>${qso.myGrid}`);
  }
  if (qso.myCallsign) {
    adifFields.push(`<operator:${qso.myCallsign.length}>${qso.myCallsign}`);
  }

  if (qso.lotwQslSent) {
    adifFields.push(`<lotw_qsl_sent:${qso.lotwQslSent.length}>${qso.lotwQslSent}`);
  }
  if (qso.lotwQslReceived) {
    adifFields.push(`<lotw_qsl_rcvd:${qso.lotwQslReceived.length}>${qso.lotwQslReceived}`);
  }
  if (qso.lotwQslSentDate) {
    const dateStr = formatADIFDate(new Date(qso.lotwQslSentDate));
    adifFields.push(`<lotw_qslsdate:8>${dateStr}`);
  }
  if (qso.lotwQslReceivedDate) {
    const dateStr = formatADIFDate(new Date(qso.lotwQslReceivedDate));
    adifFields.push(`<lotw_qslrdate:8>${dateStr}`);
  }
  if (qso.dxccStatus) {
    adifFields.push(`<app_tx5dr_dxcc_status:${qso.dxccStatus.length}>${qso.dxccStatus}`);
  }
  if (qso.dxccSource) {
    adifFields.push(`<app_tx5dr_dxcc_source:${qso.dxccSource.length}>${qso.dxccSource}`);
  }
  if (qso.dxccConfidence) {
    adifFields.push(`<app_tx5dr_dxcc_confidence:${qso.dxccConfidence.length}>${qso.dxccConfidence}`);
  }
  if (qso.dxccNeedsReview !== undefined) {
    adifFields.push(`<app_tx5dr_dxcc_needs_review:1>${qso.dxccNeedsReview ? 'Y' : 'N'}`);
  }
  if (qso.stationLocationId) {
    adifFields.push(`<app_tx5dr_station_location_id:${qso.stationLocationId.length}>${qso.stationLocationId}`);
  }
  const comment = resolveQsoComment(qso);
  if (comment) {
    adifFields.push(`<comment:${comment.length}>${comment}`);
  }
  if (qso.qth) {
    adifFields.push(`<qth:${qso.qth.length}>${qso.qth}`);
  }
  if (qso.notes) {
    adifFields.push(`<notes:${qso.notes.length}>${qso.notes}`);
  }

  adifFields.push('<eor>');

  return adifFields.join(' ');
}

/**
 * Parse ADIF field string into key-value pairs.
 */
export function parseADIFFields(recordStr: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const fieldRegex = /<(\w+):(\d+)>([^<]*)/gi;
  let match;

  while ((match = fieldRegex.exec(recordStr)) !== null) {
    const fieldName = match[1].toLowerCase();
    const fieldLength = parseInt(match[2]);
    const fieldValue = match[3].substring(0, fieldLength);
    fields[fieldName] = fieldValue;
  }

  return fields;
}

/**
 * Parse a single ADIF record string into a QSORecord.
 * @param recordStr Single ADIF record string
 * @param source Source identifier (used for ID generation)
 */
export function parseADIFRecord(recordStr: string, source: string = 'adif'): QSORecord | null {
  const fields = parseADIFFields(recordStr);

  if (!fields.call || !fields.qso_date || !fields.time_on) {
    console.warn('[ADIFUtils] ADIF record missing required fields, skipping:', fields);
    return null;
  }

  try {
    const qsoDate = fields.qso_date;
    const timeOn = fields.time_on;
    const timeOff = fields.time_off || timeOn;
    const modeInfo = mapAdifModeToInternal(fields.mode, fields.submode);

    const startTime = parseADIFDateTime(qsoDate, timeOn);
    const endTime = parseADIFDateTime(fields.qso_date_off || qsoDate, timeOff);

    const { comment, messageHistory } = parseLegacyComment(fields.comment);

    const record: QSORecord = {
      id: `${source}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      callsign: fields.call.toUpperCase(),
      startTime: new Date(startTime).getTime(),
      endTime: new Date(endTime).getTime(),
      frequency: fields.freq ? Math.round(parseFloat(fields.freq) * 1000000) : 14074000,
      mode: modeInfo.mode,
      submode: modeInfo.submode,
      reportSent: fields.rst_sent || '',
      reportReceived: fields.rst_rcvd || '',
      grid: fields.gridsquare || '',
      myCallsign: fields.station_callsign || fields.operator || undefined,
      myGrid: fields.my_gridsquare || '',
      qth: fields.qth || undefined,
      comment,
      notes: fields.notes || fields.note || undefined,
      messageHistory,
    };

    if (fields.dxcc) {
      const parsedDxcc = Number.parseInt(fields.dxcc, 10);
      if (Number.isFinite(parsedDxcc)) {
        record.dxccId = parsedDxcc;
      }
    }
    if (fields.country) {
      record.dxccEntity = fields.country;
    }
    if (fields.cqz) {
      const parsedCqz = Number.parseInt(fields.cqz, 10);
      if (Number.isFinite(parsedCqz)) {
        record.cqZone = parsedCqz;
      }
    }
    if (fields.ituz) {
      const parsedItuz = Number.parseInt(fields.ituz, 10);
      if (Number.isFinite(parsedItuz)) {
        record.ituZone = parsedItuz;
      }
    }
    if (fields.my_dxcc) {
      const parsedMyDxcc = Number.parseInt(fields.my_dxcc, 10);
      if (Number.isFinite(parsedMyDxcc)) {
        record.myDxccId = parsedMyDxcc;
      }
    }
    if (fields.my_cq_zone) {
      const parsedMyCq = Number.parseInt(fields.my_cq_zone, 10);
      if (Number.isFinite(parsedMyCq)) {
        record.myCqZone = parsedMyCq;
      }
    }
    if (fields.my_itu_zone) {
      const parsedMyItu = Number.parseInt(fields.my_itu_zone, 10);
      if (Number.isFinite(parsedMyItu)) {
        record.myItuZone = parsedMyItu;
      }
    }
    if (fields.my_state) {
      record.myState = fields.my_state;
    }
    if (fields.my_cnty) {
      record.myCounty = fields.my_cnty;
    }
    if (fields.my_iota) {
      record.myIota = fields.my_iota;
    }
    if (fields.app_tx5dr_dxcc_status) {
      record.dxccStatus = fields.app_tx5dr_dxcc_status as QSORecord['dxccStatus'];
    }
    if (fields.app_tx5dr_dxcc_source) {
      record.dxccSource = fields.app_tx5dr_dxcc_source as QSORecord['dxccSource'];
    }
    if (fields.app_tx5dr_dxcc_confidence) {
      record.dxccConfidence = fields.app_tx5dr_dxcc_confidence as QSORecord['dxccConfidence'];
    }
    if (fields.app_tx5dr_dxcc_needs_review) {
      record.dxccNeedsReview = fields.app_tx5dr_dxcc_needs_review === 'Y';
    }
    if (fields.app_tx5dr_station_location_id) {
      record.stationLocationId = fields.app_tx5dr_station_location_id;
    }

    // LoTW QSL status
    const lotwSent = fields.lotw_qsl_sent?.toUpperCase();
    if (lotwSent && ['Y', 'N', 'R', 'Q', 'I'].includes(lotwSent)) {
      record.lotwQslSent = lotwSent as 'Y' | 'N' | 'R' | 'Q' | 'I';
    }
    const lotwRcvd = (fields.lotw_qsl_rcvd || fields.app_lotw_rxqsl)?.toUpperCase();
    if (lotwRcvd && ['Y', 'N', 'R', 'I', 'V'].includes(lotwRcvd)) {
      record.lotwQslReceived = lotwRcvd as 'Y' | 'N' | 'R' | 'I' | 'V';
    }
    if (fields.lotw_qslsdate) {
      try {
        record.lotwQslSentDate = new Date(parseADIFDateTime(fields.lotw_qslsdate, '000000')).getTime();
      } catch { /* ignore parse error */ }
    }
    if (fields.lotw_qslrdate) {
      try {
        record.lotwQslReceivedDate = new Date(parseADIFDateTime(fields.lotw_qslrdate, '000000')).getTime();
      } catch { /* ignore parse error */ }
    }

    // QRZ QSL status
    const qrzStatus = fields.app_qrzlog_status?.toUpperCase();
    if (qrzStatus === 'C' || qrzStatus === 'Y') {
      record.qrzQslReceived = 'Y';
    }

    if (record.dxccSource !== 'manual_override') {
      const resolution = resolveDXCCEntity(record.callsign, record.startTime);
      if (resolution.entity) {
        record.dxccId = resolution.entity.entityCode;
        record.dxccEntity = resolution.entity.name;
        record.countryCode = resolution.entity.countryCode;
        record.cqZone = resolution.entity.cqZone;
        record.ituZone = resolution.entity.ituZone;
        record.dxccStatus = resolution.entity.deleted ? 'deleted' : 'current';
        record.dxccConfidence = resolution.confidence;
        record.dxccSource = 'resolver';
        record.dxccNeedsReview = resolution.needsReview;
        record.dxccResolvedAt = Date.now();
        record.dxccResolverVersion = DXCC_RESOLVER_VERSION;
      } else {
        record.dxccId = undefined;
        record.dxccEntity = undefined;
        record.countryCode = undefined;
        record.cqZone = undefined;
        record.ituZone = undefined;
        record.dxccStatus = 'unknown';
        record.dxccConfidence = resolution.confidence;
        record.dxccSource = 'resolver';
        record.dxccNeedsReview = true;
        record.dxccResolvedAt = Date.now();
        record.dxccResolverVersion = DXCC_RESOLVER_VERSION;
      }
    }

    return record;
  } catch (error) {
    console.warn('[ADIFUtils] Error parsing ADIF record', { error, fields });
    return null;
  }
}

/**
 * Parse a complete ADIF content string into QSORecord array.
 * @param adifContent Complete ADIF file content
 * @param source Source identifier
 */
export function parseADIFContent(adifContent: string, source: string = 'adif'): QSORecord[] {
  const records: QSORecord[] = [];

  try {
    const eohIndex = adifContent.search(/<eoh>/i);
    const body = eohIndex >= 0 ? adifContent.substring(eohIndex + 5) : adifContent;

    const recordStrings = body.split(/<eor>/i).filter(r => r.trim().length > 0);

    for (const recordStr of recordStrings) {
      const qso = parseADIFRecord(recordStr, source);
      if (qso) {
        records.push(qso);
      }
    }
  } catch (error) {
    console.error('[ADIFUtils] Failed to parse ADIF content:', error);
    throw new Error('ADIF format parse error');
  }

  return records;
}

/**
 * Generate a complete ADIF file with header.
 */
export function generateADIFFile(qsos: QSORecord[], options?: {
  programId?: string;
  programVersion?: string;
  includeStationCallsign?: boolean;
}): string {
  const opts = {
    programId: 'TX5DR',
    programVersion: '1.0',
    includeStationCallsign: false,
    ...options,
  };

  const lines: string[] = [];

  lines.push(`Generated by ${opts.programId} v${opts.programVersion}`);
  lines.push(`<adif_ver:5>3.1.4`);
  lines.push(`<programid:${opts.programId.length}>${opts.programId}`);
  lines.push(`<programversion:${opts.programVersion.length}>${opts.programVersion}`);
  lines.push('<eoh>');
  lines.push('');

  for (const qso of qsos) {
    lines.push(convertQSOToADIF(qso, {
      includeStationCallsign: opts.includeStationCallsign,
    }));
  }

  return lines.join('\n');
}
