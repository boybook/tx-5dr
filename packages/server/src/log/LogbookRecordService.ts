import type { LogBookDxccSummary, QSORecord } from '@tx5dr/contracts';
import {
  DXCC_RESOLVER_VERSION,
  type CallsignAnalysis,
  type LogQueryOptions,
  type LogStatistics,
  extractPrefix,
  getBandFromFrequency,
  getCQZone,
  getCallsignInfo,
  getITUZone,
  normalizeQsoModeForStorage,
  resolveDXCCEntity,
} from '@tx5dr/core';
import { normalizeMessageHistory, resolveQsoComment } from '@tx5dr/plugin-api';

import { buildImportedQsoFingerprint } from './logImportUtils.js';

interface PerCallsignInfo {
  count: number;
  lastQSO: QSORecord;
  grids: Set<string>;
}

interface RecordIndex {
  prefixes: Set<string>;
  cqZones: Set<number>;
  ituZones: Set<number>;
  workedDxccEntities: Set<number>;
  confirmedDxccEntities: Set<number>;
  workedBandDxcc: Map<string, Set<number>>;
  workedBandGrids: Map<string, Set<string>>;
  confirmedBandDxcc: Map<string, Set<number>>;
  workedModeDxcc: Map<string, Set<number>>;
  confirmedModeDxcc: Map<string, Set<number>>;
  perCallsign: Map<string, PerCallsignInfo>;
  perCallsignBands: Map<string, Set<string>>;
}

const IMPORT_MERGE_FIELDS: Array<keyof QSORecord> = [
  'grid',
  'myGrid',
  'myCallsign',
  'qth',
  'comment',
  'notes',
  'reportSent',
  'reportReceived',
  'submode',
  'endTime',
  'frequency',
  'dxccId',
  'dxccEntity',
  'dxccStatus',
  'countryCode',
  'cqZone',
  'ituZone',
  'dxccSource',
  'dxccConfidence',
  'dxccResolvedAt',
  'dxccResolverVersion',
  'dxccNeedsReview',
  'stationLocationId',
  'myDxccId',
  'myCqZone',
  'myItuZone',
  'myState',
  'myCounty',
  'myIota',
];

const LOTW_SENT_PRIORITY: Record<string, number> = { I: 1, N: 2, R: 3, Q: 4, Y: 5 };
const LOTW_RECEIVED_PRIORITY: Record<string, number> = { I: 1, N: 2, R: 3, Y: 4, V: 5 };
const QRZ_PRIORITY: Record<string, number> = { N: 1, Y: 2 };

function createIndex(): RecordIndex {
  return {
    prefixes: new Set(),
    cqZones: new Set(),
    ituZones: new Set(),
    workedDxccEntities: new Set(),
    confirmedDxccEntities: new Set(),
    workedBandDxcc: new Map(),
    workedBandGrids: new Map(),
    confirmedBandDxcc: new Map(),
    workedModeDxcc: new Map(),
    confirmedModeDxcc: new Map(),
    perCallsign: new Map(),
    perCallsignBands: new Map(),
  };
}

function cloneRecord(record: Readonly<QSORecord>): QSORecord {
  return {
    ...record,
    messageHistory: [...record.messageHistory],
  };
}

function addToBucket<T>(bucket: Map<string, Set<T>>, key: string, value: T): void {
  const values = bucket.get(key) ?? new Set<T>();
  values.add(value);
  bucket.set(key, values);
}

function normalizeGridKey(grid?: string): string | undefined {
  const normalized = grid?.trim().toUpperCase();
  if (!normalized || normalized.length < 4) return undefined;
  const key = normalized.slice(0, 4);
  return /^[A-R]{2}[0-9]{2}$/.test(key) ? key : undefined;
}

function normalizeGridSearch(grid?: string): string | undefined {
  const normalized = grid?.trim().toUpperCase();
  return normalized || undefined;
}

function normalizedMode(mode?: string): string {
  return (mode || 'UNKNOWN').toUpperCase();
}

function isConfirmed(qso: QSORecord): boolean {
  return qso.lotwQslReceived === 'Y'
    || qso.lotwQslReceived === 'V'
    || qso.qrzQslReceived === 'Y';
}

function isTwoWayConfirmed(qso: QSORecord): boolean {
  return (qso.lotwQslSent === 'Y' && (qso.lotwQslReceived === 'Y' || qso.lotwQslReceived === 'V'))
    || (qso.qrzQslSent === 'Y' && qso.qrzQslReceived === 'Y');
}

function matchesMode(qso: QSORecord, filter: string): boolean {
  const normalizedQso = normalizeQsoModeForStorage(qso);
  const normalizedFilter = normalizeQsoModeForStorage({ mode: filter });
  if (!normalizedFilter.mode) return true;
  if ((normalizedQso.mode || '').toUpperCase() !== normalizedFilter.mode) return false;
  return !normalizedFilter.submode
    || (normalizedQso.submode || '').toUpperCase() === normalizedFilter.submode;
}

function matchesFilters(qso: QSORecord, options?: LogQueryOptions): boolean {
  if (!options) return true;
  if (options.callsign && !qso.callsign.toUpperCase().includes(options.callsign.toUpperCase())) return false;
  if (options.grid) {
    const search = normalizeGridSearch(options.grid);
    if (search && !normalizeGridSearch(qso.grid)?.startsWith(search)) return false;
  }
  if (options.frequencyRange
    && (qso.frequency < options.frequencyRange.min || qso.frequency > options.frequencyRange.max)) return false;
  if (options.timeRange
    && (qso.startTime < options.timeRange.start || qso.startTime > options.timeRange.end)) return false;
  if (options.mode && !matchesMode(qso, options.mode)) return false;
  if (options.band
    && getBandFromFrequency(qso.frequency).toUpperCase() !== options.band.toUpperCase()) return false;
  if (options.dxccStatus && qso.dxccStatus !== options.dxccStatus) return false;
  if (options.qslFlow) {
    const confirmed = isTwoWayConfirmed(qso);
    if (options.qslFlow === 'two_way_confirmed' ? !confirmed : confirmed) return false;
  }
  if (options.excludeModes?.some(mode => mode.toUpperCase() === qso.mode.toUpperCase())) return false;
  if (options.qslStatus) {
    const confirmed = isConfirmed(qso);
    const uploaded = qso.lotwQslSent === 'Y' || qso.qrzQslSent === 'Y';
    if (options.qslStatus === 'confirmed' && !confirmed) return false;
    if (options.qslStatus === 'uploaded' && (!uploaded || confirmed)) return false;
    if (options.qslStatus === 'none' && (uploaded || confirmed)) return false;
  }
  return true;
}

function addToIndex(index: RecordIndex, qso: QSORecord): void {
  const callsign = qso.callsign.toUpperCase();
  const band = getBandFromFrequency(qso.frequency);
  const grid = normalizeGridKey(qso.grid);

  try {
    const prefix = extractPrefix(callsign);
    if (prefix) index.prefixes.add(prefix);
  } catch {}
  try {
    const zone = getCQZone(callsign);
    if (zone !== null) index.cqZones.add(zone);
  } catch {}
  try {
    const zone = getITUZone(callsign);
    if (zone !== null) index.ituZones.add(zone);
  } catch {}

  if (qso.dxccId) {
    index.workedDxccEntities.add(qso.dxccId);
    if (band !== 'Unknown') addToBucket(index.workedBandDxcc, band, qso.dxccId);
    addToBucket(index.workedModeDxcc, normalizedMode(qso.mode), qso.dxccId);
    if (isConfirmed(qso)) {
      index.confirmedDxccEntities.add(qso.dxccId);
      if (band !== 'Unknown') addToBucket(index.confirmedBandDxcc, band, qso.dxccId);
      addToBucket(index.confirmedModeDxcc, normalizedMode(qso.mode), qso.dxccId);
    }
  }
  if (grid && band !== 'Unknown') addToBucket(index.workedBandGrids, band, grid);

  const previous = index.perCallsign.get(callsign);
  if (previous) {
    previous.count += 1;
    if (qso.startTime > previous.lastQSO.startTime) previous.lastQSO = qso;
    if (grid) previous.grids.add(grid);
  } else {
    index.perCallsign.set(callsign, { count: 1, lastQSO: qso, grids: new Set(grid ? [grid] : []) });
  }
  if (band !== 'Unknown') addToBucket(index.perCallsignBands, callsign, band);
}

export function enrichQsoWithDxcc(qso: QSORecord): QSORecord {
  if (qso.dxccSource === 'manual_override' && qso.dxccId) return { ...qso };
  const resolution = resolveDXCCEntity(qso.callsign, qso.startTime);
  const entity = resolution.entity;
  if (!entity) {
    return {
      ...qso,
      dxccId: undefined,
      dxccEntity: undefined,
      countryCode: undefined,
      cqZone: undefined,
      ituZone: undefined,
      dxccStatus: 'unknown',
      dxccSource: 'resolver',
      dxccConfidence: resolution.confidence,
      dxccResolvedAt: Date.now(),
      dxccResolverVersion: DXCC_RESOLVER_VERSION,
      dxccNeedsReview: true,
    };
  }
  return {
    ...qso,
    dxccId: entity.entityCode,
    dxccEntity: entity.name,
    dxccStatus: 'current',
    countryCode: entity.countryCode,
    cqZone: entity.cqZone,
    ituZone: entity.ituZone,
    dxccSource: 'resolver',
    dxccConfidence: resolution.confidence,
    dxccResolvedAt: Date.now(),
    dxccResolverVersion: DXCC_RESOLVER_VERSION,
    dxccNeedsReview: resolution.needsReview,
  };
}

export function normalizeQsoForPersistence(record: QSORecord): QSORecord {
  const textNormalized = {
    ...record,
    messageHistory: normalizeMessageHistory(record.messageHistory),
  };
  return enrichQsoWithDxcc(normalizeQsoModeForStorage({
    ...textNormalized,
    comment: resolveQsoComment(textNormalized),
  }));
}

function isMissing(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === 'number' && Number.isNaN(value);
}

function mergeStatus<T extends string | undefined>(current: T, incoming: T, priority: Record<string, number>): T {
  if (!incoming) return current;
  if (!current) return incoming;
  return (priority[incoming] || 0) > (priority[current] || 0) ? incoming : current;
}

function latestTimestamp(current?: number, incoming?: number): number | undefined {
  if (!Number.isFinite(incoming)) return current;
  if (!Number.isFinite(current)) return incoming;
  return Math.max(current!, incoming!);
}

export function mergeImportedQso(existing: QSORecord, incoming: QSORecord): { changed: boolean; record: QSORecord } {
  let changed = false;
  const merged: QSORecord = { ...existing };
  for (const field of IMPORT_MERGE_FIELDS) {
    if (isMissing(merged[field]) && !isMissing(incoming[field])) {
      merged[field] = incoming[field] as never;
      changed = true;
    }
  }
  if (merged.messageHistory.length === 0 && incoming.messageHistory.length > 0) {
    merged.messageHistory = [...incoming.messageHistory];
    changed = true;
  }
  const currentComment = resolveQsoComment(merged);
  const incomingComment = resolveQsoComment(incoming);
  if (isMissing(currentComment) && !isMissing(incomingComment)) {
    merged.comment = incomingComment;
    changed = true;
  } else if (isMissing(merged.comment) && !isMissing(currentComment)) {
    merged.comment = currentComment;
    changed = true;
  }

  const statusValues: Array<[keyof QSORecord, unknown]> = [
    ['lotwQslSent', mergeStatus(merged.lotwQslSent, incoming.lotwQslSent, LOTW_SENT_PRIORITY)],
    ['lotwQslReceived', mergeStatus(merged.lotwQslReceived, incoming.lotwQslReceived, LOTW_RECEIVED_PRIORITY)],
    ['qrzQslSent', mergeStatus(merged.qrzQslSent, incoming.qrzQslSent, QRZ_PRIORITY)],
    ['qrzQslReceived', mergeStatus(merged.qrzQslReceived, incoming.qrzQslReceived, QRZ_PRIORITY)],
    ['lotwQslSentDate', latestTimestamp(merged.lotwQslSentDate, incoming.lotwQslSentDate)],
    ['lotwQslReceivedDate', latestTimestamp(merged.lotwQslReceivedDate, incoming.lotwQslReceivedDate)],
    ['qrzQslSentDate', latestTimestamp(merged.qrzQslSentDate, incoming.qrzQslSentDate)],
    ['qrzQslReceivedDate', latestTimestamp(merged.qrzQslReceivedDate, incoming.qrzQslReceivedDate)],
  ];
  for (const [field, value] of statusValues) {
    if (merged[field] !== value) {
      merged[field] = value as never;
      changed = true;
    }
  }
  return changed ? { changed, record: enrichQsoWithDxcc(merged) } : { changed: false, record: existing };
}

export class LogbookRecordService {
  private readonly records: readonly QSORecord[];
  private readonly byId = new Map<string, QSORecord>();
  private readonly index = createIndex();

  constructor(records: Iterable<Readonly<QSORecord>>) {
    const collected: QSORecord[] = [];
    for (const input of records) {
      const record = enrichQsoWithDxcc(cloneRecord(input));
      collected.push(record);
      this.byId.set(record.id, record);
      addToIndex(this.index, record);
    }
    this.records = Object.freeze(collected);
  }

  get(id: string): QSORecord | null {
    const record = this.byId.get(id);
    return record ? cloneRecord(record) : null;
  }

  all(): readonly QSORecord[] {
    return this.records.map(cloneRecord);
  }

  query(options?: LogQueryOptions): QSORecord[] {
    let records = this.records.filter(record => matchesFilters(record, options));
    if (options) {
      const orderBy = options.orderBy ?? 'time';
      const direction = options.orderDirection === 'asc' ? 1 : -1;
      records = [...records].sort((left, right) => {
        if (orderBy === 'callsign') return direction * left.callsign.localeCompare(right.callsign);
        const comparison = orderBy === 'frequency'
          ? left.frequency - right.frequency
          : left.startTime - right.startTime;
        return direction * comparison;
      });
      if (options.offset) records = records.slice(options.offset);
      if (options.limit !== undefined) records = records.slice(0, options.limit);
    }
    return records.map(cloneRecord);
  }

  count(options?: LogQueryOptions): number {
    let count = 0;
    for (const record of this.records) if (matchesFilters(record, options)) count += 1;
    return count;
  }

  hasWorked(callsign: string, band?: string): boolean {
    const key = callsign.toUpperCase();
    if (!band) return (this.index.perCallsign.get(key)?.count ?? 0) > 0;
    if (band === 'Unknown') return false;
    return this.index.perCallsignBands.get(key)?.has(band) ?? false;
  }

  lastWithCallsign(callsign: string): QSORecord | null {
    const record = this.index.perCallsign.get(callsign.toUpperCase())?.lastQSO;
    return record ? cloneRecord(record) : null;
  }

  analyze(callsign: string, grid?: string, band?: string): CallsignAnalysis {
    const upper = callsign.toUpperCase();
    const info = this.index.perCallsign.get(upper);
    const prefix = extractPrefix(upper);
    const resolution = resolveDXCCEntity(upper, Date.now());
    const callsignInfo = getCallsignInfo(upper);
    const entity = resolution.entity;
    const cqZone = entity?.cqZone ?? getCQZone(upper);
    const ituZone = entity?.ituZone ?? getITUZone(upper);
    const dxccId = entity?.entityCode;
    const hasWorkedCallsign = (info?.count ?? 0) > 0;
    const gridKey = normalizeGridKey(grid);
    return {
      isNewCallsign: band && band !== 'Unknown'
        ? !(this.index.perCallsignBands.get(upper)?.has(band))
        : !info,
      lastQSO: info?.lastQSO ? cloneRecord(info.lastQSO) : undefined,
      qsoCount: info?.count ?? 0,
      isNewGrid: !!gridKey
        && !hasWorkedCallsign
        && !!band
        && band !== 'Unknown'
        && !(this.index.workedBandGrids.get(band)?.has(gridKey)),
      isNewDxccEntity: dxccId ? !this.index.workedDxccEntities.has(dxccId) : false,
      isNewBandDxccEntity: dxccId && band && band !== 'Unknown'
        ? !(this.index.workedBandDxcc.get(band)?.has(dxccId))
        : false,
      isConfirmedDxcc: dxccId ? this.index.confirmedDxccEntities.has(dxccId) : false,
      isNewCQZone: cqZone !== null && !this.index.cqZones.has(cqZone),
      isNewITUZone: ituZone !== null && !this.index.ituZones.has(ituZone),
      prefix,
      cqZone: cqZone || undefined,
      ituZone: ituZone || undefined,
      dxccEntity: entity?.name,
      dxccId,
      dxccStatus: entity ? 'current' : 'unknown',
      state: callsignInfo?.state,
      stateConfidence: callsignInfo?.stateConfidence,
      dxccNeedsReview: resolution.needsReview,
      dxccMatchKind: resolution.matchKind,
      dxccDataSource: resolution.dataSource,
      dxccResolverVersion: DXCC_RESOLVER_VERSION,
    };
  }

  statistics(): LogStatistics {
    const uniqueCallsigns = new Set<string>();
    const uniqueGrids = new Set<string>();
    const byMode = new Map<string, number>();
    const byBand = new Map<string, number>();
    let firstQSOTime: number | undefined;
    let lastQSOTime: number | undefined;
    for (const qso of this.records) {
      uniqueCallsigns.add(qso.callsign);
      const grid = normalizeGridKey(qso.grid);
      if (grid) uniqueGrids.add(grid);
      byMode.set(qso.mode, (byMode.get(qso.mode) ?? 0) + 1);
      const band = getBandFromFrequency(qso.frequency);
      byBand.set(band, (byBand.get(band) ?? 0) + 1);
      if (firstQSOTime === undefined || qso.startTime < firstQSOTime) firstQSOTime = qso.startTime;
      if (lastQSOTime === undefined || qso.startTime > lastQSOTime) lastQSOTime = qso.startTime;
    }
    return {
      totalQSOs: this.records.length,
      uniqueCallsigns: uniqueCallsigns.size,
      uniqueGrids: uniqueGrids.size,
      byMode,
      byBand,
      firstQSOTime,
      lastQSOTime,
      dxcc: this.dxccSummary(),
    };
  }

  dxccSummary(): LogBookDxccSummary {
    const workedCurrent = new Set<number>();
    const workedDeleted = new Set<number>();
    const confirmedCurrent = new Set<number>();
    const confirmedDeleted = new Set<number>();
    const byBand = new Map<string, { worked: Set<number>; confirmed: Set<number> }>();
    const byMode = new Map<string, { worked: Set<number>; confirmed: Set<number> }>();
    let reviewCount = 0;
    for (const qso of this.records) {
      if (qso.dxccNeedsReview) reviewCount += 1;
      if (!qso.dxccId) continue;
      const deleted = qso.dxccStatus === 'deleted';
      const confirmed = isConfirmed(qso);
      (deleted ? workedDeleted : workedCurrent).add(qso.dxccId);
      if (confirmed) (deleted ? confirmedDeleted : confirmedCurrent).add(qso.dxccId);
      const band = getBandFromFrequency(qso.frequency);
      if (band !== 'Unknown') {
        const entry = byBand.get(band) ?? { worked: new Set<number>(), confirmed: new Set<number>() };
        entry.worked.add(qso.dxccId);
        if (confirmed) entry.confirmed.add(qso.dxccId);
        byBand.set(band, entry);
      }
      const mode = normalizedMode(qso.mode);
      const entry = byMode.get(mode) ?? { worked: new Set<number>(), confirmed: new Set<number>() };
      entry.worked.add(qso.dxccId);
      if (confirmed) entry.confirmed.add(qso.dxccId);
      byMode.set(mode, entry);
    }
    const buckets = (source: Map<string, { worked: Set<number>; confirmed: Set<number> }>) =>
      [...source].map(([key, value]) => ({ key, worked: value.worked.size, confirmed: value.confirmed.size }))
        .sort((left, right) => left.key.localeCompare(right.key));
    return {
      worked: {
        current: workedCurrent.size,
        total: workedCurrent.size + workedDeleted.size,
        deleted: workedDeleted.size,
      },
      confirmed: {
        current: confirmedCurrent.size,
        total: confirmedCurrent.size + confirmedDeleted.size,
        deleted: confirmedDeleted.size,
      },
      reviewCount,
      byBand: buckets(byBand),
      byMode: buckets(byMode),
    };
  }

  fingerprintIndex(): Map<string, string> {
    const index = new Map<string, string>();
    for (const record of this.records) {
      const fingerprint = buildImportedQsoFingerprint(record);
      if (!index.has(fingerprint)) index.set(fingerprint, record.id);
    }
    return index;
  }
}
