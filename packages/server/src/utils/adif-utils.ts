/**
 * ADIF (Amateur Data Interchange Format) 公共工具模块
 * 提供 ADIF 格式的解析、生成和转换功能，供 WaveLog/QRZ/LoTW 等服务复用
 */

import { QSORecord } from '@tx5dr/contracts';
import { getBandFromFrequency, resolveDXCCEntity, DXCC_RESOLVER_VERSION } from '@tx5dr/core';
import { createLogger } from './logger.js';

const logger = createLogger('ADIFUtils');

/**
 * 格式化 ADIF 日期 (YYYYMMDD)
 */
export function formatADIFDate(date: Date): string {
  const year = date.getUTCFullYear().toString().padStart(4, '0');
  const month = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = date.getUTCDate().toString().padStart(2, '0');
  return `${year}${month}${day}`;
}

/**
 * 格式化 ADIF 时间 (HHMMSS)
 */
export function formatADIFTime(date: Date): string {
  const hours = date.getUTCHours().toString().padStart(2, '0');
  const minutes = date.getUTCMinutes().toString().padStart(2, '0');
  const seconds = date.getUTCSeconds().toString().padStart(2, '0');
  return `${hours}${minutes}${seconds}`;
}

/**
 * 解析 ADIF 日期时间格式为 ISO 字符串
 * @param dateStr ADIF 日期格式 YYYYMMDD
 * @param timeStr ADIF 时间格式 HHMMSS 或 HHMM
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
 * 将 QSO 记录转换为单条 ADIF 记录字符串
 * @param qso QSO 记录
 * @param options 可选配置
 */
export function convertQSOToADIF(qso: QSORecord, options?: {
  includeStationCallsign?: boolean;
  includeMyGrid?: boolean;
}): string {
  const adifFields: string[] = [];
  const opts = { includeStationCallsign: false, includeMyGrid: true, ...options };

  // 必需字段
  adifFields.push(`<call:${qso.callsign.length}>${qso.callsign}`);

  // QSO 时间 - UTC
  const startTime = new Date(qso.startTime);
  const qsoDate = formatADIFDate(startTime);
  const qsoTime = formatADIFTime(startTime);

  adifFields.push(`<qso_date:8>${qsoDate}`);
  adifFields.push(`<time_on:6>${qsoTime}`);

  // 结束时间
  if (qso.endTime) {
    const endTime = new Date(qso.endTime);
    adifFields.push(`<qso_date_off:8>${formatADIFDate(endTime)}`);
    adifFields.push(`<time_off:6>${formatADIFTime(endTime)}`);
  } else {
    adifFields.push(`<qso_date_off:8>${qsoDate}`);
    adifFields.push(`<time_off:6>${qsoTime}`);
  }

  // 模式
  if (qso.mode) {
    adifFields.push(`<mode:${qso.mode.length}>${qso.mode}`);
  }

  // 频率 (MHz)
  const freqMHz = (qso.frequency / 1000000).toFixed(6);
  adifFields.push(`<freq:${freqMHz.length}>${freqMHz}`);

  // 频段
  const band = getBandFromFrequency(qso.frequency);
  if (band !== 'Unknown') {
    adifFields.push(`<band:${band.length}>${band}`);
  }

  // 网格坐标
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

  // 信号报告
  if (qso.reportSent) {
    adifFields.push(`<rst_sent:${qso.reportSent.length}>${qso.reportSent}`);
  }
  if (qso.reportReceived) {
    adifFields.push(`<rst_rcvd:${qso.reportReceived.length}>${qso.reportReceived}`);
  }

  // 我的呼号
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
    adifFields.push(`<state:${qso.myState.length}>${qso.myState}`);
  }
  if (qso.myCounty) {
    adifFields.push(`<cnty:${qso.myCounty.length}>${qso.myCounty}`);
  }
  if (qso.myIota) {
    adifFields.push(`<iota:${qso.myIota.length}>${qso.myIota}`);
  }

  // 我的网格坐标
  if (opts.includeMyGrid && qso.myGrid) {
    adifFields.push(`<my_gridsquare:${qso.myGrid.length}>${qso.myGrid}`);
  }

  // LoTW QSL 确认状态
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

  // 结束标记
  adifFields.push('<eor>');

  return adifFields.join(' ');
}

/**
 * 解析 ADIF 字段为键值对
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
 * 解析单条 ADIF 记录为 QSORecord
 * @param recordStr 单条 ADIF 记录字符串
 * @param source 数据来源标识（用于生成 ID 和 messages）
 */
export function parseADIFRecord(recordStr: string, source: string = 'adif'): QSORecord | null {
  const fields = parseADIFFields(recordStr);

  // 检查必需字段
  if (!fields.call || !fields.qso_date || !fields.time_on) {
    logger.warn('ADIF record missing required fields, skipping:', fields);
    return null;
  }

  try {
    const qsoDate = fields.qso_date;
    const timeOn = fields.time_on;
    const timeOff = fields.time_off || timeOn;

    const startTime = parseADIFDateTime(qsoDate, timeOn);
    const endTime = parseADIFDateTime(fields.qso_date_off || qsoDate, timeOff);

    const record: QSORecord = {
      id: `${source}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      callsign: fields.call.toUpperCase(),
      startTime: new Date(startTime).getTime(),
      endTime: new Date(endTime).getTime(),
      frequency: fields.freq ? Math.round(parseFloat(fields.freq) * 1000000) : 14074000,
      mode: fields.mode || 'FT8',
      reportSent: fields.rst_sent || '',
      reportReceived: fields.rst_rcvd || '',
      grid: fields.gridsquare || '',
      myCallsign: fields.station_callsign || '',
      myGrid: fields.my_gridsquare || '',
      messages: [`QSO imported from ${source} at ${new Date().toISOString()}`]
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
    if (fields.state) {
      record.myState = fields.state;
    }
    if (fields.cnty) {
      record.myCounty = fields.cnty;
    }
    if (fields.iota) {
      record.myIota = fields.iota;
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

    // LoTW QSL 确认状态
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

    // QRZ QSL 确认状态
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
    logger.warn('Error parsing ADIF record', { error, fields });
    return null;
  }
}

/**
 * 解析 ADIF 内容字符串为 QSORecord 数组
 * @param adifContent 完整的 ADIF 内容
 * @param source 数据来源标识
 */
export function parseADIFContent(adifContent: string, source: string = 'adif'): QSORecord[] {
  const records: QSORecord[] = [];

  try {
    // 跳过头部（<eoh> 之前的内容）
    const eohIndex = adifContent.search(/<eoh>/i);
    const body = eohIndex >= 0 ? adifContent.substring(eohIndex + 5) : adifContent;

    // 按记录分割（<eor> 标记）
    const recordStrings = body.split(/<eor>/i).filter(r => r.trim().length > 0);

    for (const recordStr of recordStrings) {
      const qso = parseADIFRecord(recordStr, source);
      if (qso) {
        records.push(qso);
      }
    }
  } catch (error) {
    logger.error('Failed to parse ADIF content:', error);
    throw new Error('ADIF format parse error');
  }

  return records;
}

/**
 * 生成完整的 ADIF 文件内容（含文件头）
 * @param qsos QSO 记录数组
 * @param options 可选配置
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

  // ADIF 文件头
  lines.push(`Generated by ${opts.programId} v${opts.programVersion}`);
  lines.push(`<adif_ver:5>3.1.4`);
  lines.push(`<programid:${opts.programId.length}>${opts.programId}`);
  lines.push(`<programversion:${opts.programVersion.length}>${opts.programVersion}`);
  lines.push('<eoh>');
  lines.push('');

  // QSO 记录
  for (const qso of qsos) {
    lines.push(convertQSOToADIF(qso, {
      includeStationCallsign: opts.includeStationCallsign,
    }));
  }

  return lines.join('\n');
}
