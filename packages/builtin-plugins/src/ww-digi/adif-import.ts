import { createHash } from 'node:crypto';
import {
  parseADIFDateTime,
  parseADIFRecord,
  type LogbookBatchMutation,
  type QSORecord,
} from '@tx5dr/plugin-api';
import {
  isWithinWWDigiContestPeriod,
  resolveWWDigiBand,
  type WWDigiBand,
} from './contest-log.js';
import { createWWDigiContestEntry } from './contest-entry.js';

export const WW_DIGI_ADIF_IMPORT_MAX_BYTES = 700 * 1024;

export type WWDigiImportIssue =
  | 'invalid-record'
  | 'invalid-callsign'
  | 'invalid-time'
  | 'outside-contest-period'
  | 'unsupported-mode'
  | 'missing-frequency'
  | 'invalid-frequency'
  | 'unsupported-band'
  | 'station-mismatch'
  | 'missing-station-callsign'
  | 'missing-my-grid'
  | 'my-grid-mismatch'
  | 'missing-grid'
  | 'missing-transmitter'
  | 'possible-duplicate';

export interface WWDigiImportCandidate {
  sourceIndex: number;
  fingerprint: string;
  record: QSORecord;
  band: WWDigiBand;
  requiresStationConfirmation: boolean;
  requiresGridConfirmation: boolean;
  reviewIssues: WWDigiImportIssue[];
}

export interface WWDigiImportRejectedRecord {
  sourceIndex: number;
  callsign?: string;
  issues: WWDigiImportIssue[];
}

export interface WWDigiParsedImport {
  totalRead: number;
  candidates: WWDigiImportCandidate[];
  rejected: WWDigiImportRejectedRecord[];
}

export interface WWDigiImportPlanItem {
  mutation: LogbookBatchMutation;
  candidate: WWDigiImportCandidate;
  existingRecordId?: string;
}

export interface WWDigiImportPlan {
  items: WWDigiImportPlanItem[];
  duplicates: number;
  withheld: number;
}

export interface WWDigiImportPreview {
  totalRead: number;
  importable: number;
  review: number;
  duplicates: number;
  rejected: number;
  missingStationCallsign: number;
  missingMyGrid: number;
  issueCounts: Partial<Record<WWDigiImportIssue, number>>;
  rows: Array<{
    sourceIndex: number;
    callsign?: string;
    startTime?: number;
    mode?: string;
    band?: string;
    status: 'ready' | 'review' | 'duplicate' | 'rejected';
    issues: WWDigiImportIssue[];
  }>;
}

const CALLSIGN_PATTERN = /^[A-Z0-9]+(?:\/[A-Z0-9]+)*$/;
const GRID_PATTERN = /^[A-R]{2}[0-9]{2}$/;

function normalizeCallsign(value: string | undefined): string | undefined {
  const normalized = value?.trim().toUpperCase();
  return normalized || undefined;
}

function normalizeGrid(value: string | undefined): string | undefined {
  const normalized = value?.trim().toUpperCase().slice(0, 4);
  return normalized && GRID_PATTERN.test(normalized) ? normalized : undefined;
}

function parseFields(record: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const pattern = /<([^:>]+):(\d+)(?::[^>]*)?>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(record)) !== null) {
    const length = Number.parseInt(match[2]!, 10);
    const start = match.index + match[0].length;
    fields[match[1]!.trim().toLowerCase()] = record.slice(start, start + length);
  }
  return fields;
}

function canonicalRecord(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([name, value]) => `<${name}:${value.length}>${value}`)
    .join('');
}

function splitRecordParts(content: string): { records: string[]; incompleteTail: boolean } {
  const bodyStart = content.search(/<eoh>/i);
  const body = bodyStart >= 0 ? content.slice(bodyStart + 5) : content;
  const parts = body.split(/<eor>/i);
  const tail = parts.pop()?.trim() ?? '';
  return {
    records: parts.map((value) => value.trim()).filter(Boolean),
    incompleteTail: tail.length > 0,
  };
}

function splitRecords(content: string): string[] {
  return splitRecordParts(content).records;
}

function modeFromFields(fields: Record<string, string>): 'FT4' | 'FT8' | undefined {
  const mode = fields.mode?.trim().toUpperCase();
  const submode = fields.submode?.trim().toUpperCase();
  if (submode === 'FT4' || submode === 'FT8') return submode;
  if (mode === 'FT4' || mode === 'FT8') return mode;
  return undefined;
}

function fingerprintOf(record: Pick<QSORecord, 'callsign' | 'startTime' | 'mode' | 'frequency'>): string {
  return [
    record.callsign.trim().toUpperCase(),
    Math.floor(record.startTime / 1_000),
    record.mode.trim().toUpperCase(),
    Math.round(record.frequency),
  ].join('__');
}

function stableImportId(fingerprint: string): string {
  return `ww-digi-import-${createHash('sha256').update(fingerprint).digest('hex').slice(0, 24)}`;
}

function issueCounts(
  parsed: WWDigiParsedImport,
  plan: WWDigiImportPlan,
): Partial<Record<WWDigiImportIssue, number>> {
  const counts: Partial<Record<WWDigiImportIssue, number>> = {};
  const add = (issue: WWDigiImportIssue) => { counts[issue] = (counts[issue] ?? 0) + 1; };
  for (const candidate of parsed.candidates) candidate.reviewIssues.forEach(add);
  for (const rejected of parsed.rejected) rejected.issues.forEach(add);
  if (plan.duplicates > 0) counts['possible-duplicate'] = counts['possible-duplicate'] ?? 0;
  return counts;
}

function parseTimestamp(fields: Record<string, string>): number | undefined {
  if (!fields.qso_date || !fields.time_on) return undefined;
  try {
    return new Date(parseADIFDateTime(fields.qso_date, fields.time_on)).getTime();
  } catch {
    return undefined;
  }
}

export function parseWWDigiAdifImport(
  content: string,
  options: {
    contestYear: number;
    stationCallsign: string;
    stationGrid: string;
    requireTransmitterId?: boolean;
  },
): WWDigiParsedImport {
  const stationCallsign = options.stationCallsign.trim().toUpperCase();
  const stationGrid = options.stationGrid.trim().toUpperCase().slice(0, 4);
  const split = splitRecordParts(content);
  const records = split.records;
  const candidates: WWDigiImportCandidate[] = [];
  const rejected: WWDigiImportRejectedRecord[] = [];

  records.forEach((raw, sourceIndex) => {
    const fields = parseFields(raw);
    const callsign = normalizeCallsign(fields.call);
    const issues: WWDigiImportIssue[] = [];
    if (!callsign || callsign.length > 13 || !CALLSIGN_PATTERN.test(callsign)) issues.push('invalid-callsign');
    const startTime = parseTimestamp(fields);
    if (startTime === undefined) issues.push('invalid-time');
    else if (!isWithinWWDigiContestPeriod(startTime, options.contestYear)) issues.push('outside-contest-period');
    const mode = modeFromFields(fields);
    if (!mode) issues.push('unsupported-mode');

    const frequencyText = fields.freq?.trim();
    const frequencyMHz = frequencyText ? Number.parseFloat(frequencyText) : Number.NaN;
    if (!frequencyText) issues.push('missing-frequency');
    else if (!Number.isFinite(frequencyMHz) || frequencyMHz <= 0) issues.push('invalid-frequency');
    const frequency = Number.isFinite(frequencyMHz) ? Math.round(frequencyMHz * 1_000_000) : 0;
    const band = frequency > 0 ? resolveWWDigiBand(frequency) : undefined;
    if (frequency > 0 && !band) issues.push('unsupported-band');

    const sourceStation = normalizeCallsign(fields.station_callsign);
    if (sourceStation && sourceStation !== stationCallsign) issues.push('station-mismatch');

    if (issues.length > 0 || !callsign || startTime === undefined || !mode || !band) {
      rejected.push({ sourceIndex, callsign, issues: issues.length > 0 ? issues : ['invalid-record'] });
      return;
    }

    const parsed = parseADIFRecord(canonicalRecord(fields), 'ww-digi-import');
    if (!parsed) {
      rejected.push({ sourceIndex, callsign, issues: ['invalid-record'] });
      return;
    }

    const sourceMyGridText = fields.my_gridsquare?.trim().toUpperCase();
    const sourceMyGrid = normalizeGrid(fields.my_gridsquare);
    if (sourceMyGridText && !sourceMyGrid) {
      rejected.push({ sourceIndex, callsign, issues: ['invalid-record'] });
      return;
    }
    const remoteGrid = normalizeGrid(fields.gridsquare);
    const requiresStationConfirmation = !sourceStation;
    const requiresGridConfirmation = !sourceMyGrid;
    const reviewIssues: WWDigiImportIssue[] = [];
    if (requiresStationConfirmation) reviewIssues.push('missing-station-callsign');
    if (requiresGridConfirmation) reviewIssues.push('missing-my-grid');
    if (sourceMyGrid && sourceMyGrid !== stationGrid) reviewIssues.push('my-grid-mismatch');
    if (!remoteGrid) reviewIssues.push('missing-grid');
    if (options.requireTransmitterId) reviewIssues.push('missing-transmitter');

    const normalizedRecord: QSORecord = {
      ...parsed,
      id: '',
      callsign,
      startTime,
      frequency,
      mode,
      submode: mode,
      contestId: 'WW-DIGI',
      contestEntry: createWWDigiContestEntry({
        contestYear: options.contestYear,
        sentGrid: sourceMyGrid ?? stationGrid,
        receivedGrid: remoteGrid,
        status: reviewIssues.length > 0 ? 'review' : 'included',
        source: 'imported',
      }),
      myCallsign: stationCallsign,
      myGrid: sourceMyGrid ?? stationGrid,
      grid: remoteGrid,
      messageHistory: [...parsed.messageHistory],
    };
    const fingerprint = fingerprintOf(normalizedRecord);
    normalizedRecord.id = stableImportId(fingerprint);
    candidates.push({
      sourceIndex,
      fingerprint,
      record: normalizedRecord,
      band,
      requiresStationConfirmation,
      requiresGridConfirmation,
      reviewIssues,
    });
  });

  if (split.incompleteTail) {
    rejected.push({ sourceIndex: records.length, issues: ['invalid-record'] });
  }
  return { totalRead: records.length + Number(split.incompleteTail), candidates, rejected };
}

function possibleDuplicate(candidate: WWDigiImportCandidate, existing: QSORecord): boolean {
  return candidate.record.callsign.trim().toUpperCase() === existing.callsign.trim().toUpperCase()
    && candidate.record.mode.trim().toUpperCase() === existing.mode.trim().toUpperCase()
    && resolveWWDigiBand(existing.frequency) === candidate.band
    && Math.abs(candidate.record.startTime - existing.startTime) <= 120_000;
}

function synchronizeContestEntryStatus(candidate: WWDigiImportCandidate): void {
  const entry = candidate.record.contestEntry;
  if (!entry) return;
  candidate.record.contestEntry = {
    ...entry,
    annotations: {
      ...entry.annotations,
      status: candidate.reviewIssues.length > 0 ? 'review' : 'included',
    },
  };
}

export function planWWDigiAdifImport(
  candidates: readonly WWDigiImportCandidate[],
  existingRecords: readonly QSORecord[],
  confirmations: { stationCallsign: boolean; stationGrid: boolean },
): WWDigiImportPlan {
  const existingByFingerprint = new Map(existingRecords.map((record) => [fingerprintOf(record), record]));
  const seen = new Set<string>();
  const items: WWDigiImportPlanItem[] = [];
  let duplicates = 0;
  let withheld = 0;

  for (const sourceCandidate of candidates) {
    const candidate: WWDigiImportCandidate = structuredClone(sourceCandidate);
    if ((candidate.requiresStationConfirmation && !confirmations.stationCallsign)
        || (candidate.requiresGridConfirmation && !confirmations.stationGrid)) {
      withheld += 1;
      continue;
    }
    if (confirmations.stationCallsign) {
      candidate.reviewIssues = candidate.reviewIssues.filter((issue) => issue !== 'missing-station-callsign');
    }
    if (confirmations.stationGrid) {
      candidate.reviewIssues = candidate.reviewIssues.filter((issue) => issue !== 'missing-my-grid');
    }
    synchronizeContestEntryStatus(candidate);
    if (seen.has(candidate.fingerprint)) {
      duplicates += 1;
      continue;
    }
    seen.add(candidate.fingerprint);
    const existing = existingByFingerprint.get(candidate.fingerprint);
    if (existing) {
      const updates: Partial<QSORecord> = {};
      if (!existing.grid && candidate.record.grid) updates.grid = candidate.record.grid;
      if (!existing.myGrid && candidate.record.myGrid) updates.myGrid = candidate.record.myGrid;
      if (!existing.myCallsign) updates.myCallsign = candidate.record.myCallsign;
      if (existing.contestId?.trim().toUpperCase() !== 'WW-DIGI') updates.contestId = 'WW-DIGI';
      if (!existing.contestEntry && candidate.record.contestEntry) {
        updates.contestEntry = structuredClone(candidate.record.contestEntry);
      }
      if (Object.keys(updates).length === 0) {
        duplicates += 1;
        continue;
      }
      items.push({
        mutation: { type: 'update', qsoId: existing.id, updates },
        candidate,
        existingRecordId: existing.id,
      });
      continue;
    }
    if ([...existingRecords, ...items.map((item) => item.candidate.record)]
      .some((record) => possibleDuplicate(candidate, record))) {
      if (!candidate.reviewIssues.includes('possible-duplicate')) {
        candidate.reviewIssues.push('possible-duplicate');
      }
      synchronizeContestEntryStatus(candidate);
    }
    items.push({ mutation: { type: 'add', record: candidate.record }, candidate });
  }
  return { items, duplicates, withheld };
}

export function summarizeWWDigiAdifImport(
  parsed: WWDigiParsedImport,
  existingRecords: readonly QSORecord[],
): WWDigiImportPreview {
  const plan = planWWDigiAdifImport(parsed.candidates, existingRecords, {
    stationCallsign: true,
    stationGrid: true,
  });
  const plannedBySource = new Map(plan.items.map((item) => [item.candidate.sourceIndex, item.candidate]));
  const rows: WWDigiImportPreview['rows'] = [];
  for (const candidate of parsed.candidates.slice(0, 50)) {
    const planned = plannedBySource.get(candidate.sourceIndex);
    rows.push({
      sourceIndex: candidate.sourceIndex,
      callsign: candidate.record.callsign,
      startTime: candidate.record.startTime,
      mode: candidate.record.mode,
      band: candidate.band,
      status: !planned ? 'duplicate' : planned.reviewIssues.length > 0 ? 'review' : 'ready',
      issues: planned?.reviewIssues ?? [],
    });
  }
  for (const record of parsed.rejected.slice(0, Math.max(0, 50 - rows.length))) {
    rows.push({
      sourceIndex: record.sourceIndex,
      callsign: record.callsign,
      status: 'rejected',
      issues: record.issues,
    });
  }
  return {
    totalRead: parsed.totalRead,
    importable: plan.items.length,
    review: plan.items.filter((item) => item.candidate.reviewIssues.length > 0).length,
    duplicates: plan.duplicates,
    rejected: parsed.rejected.length,
    missingStationCallsign: parsed.candidates.filter((item) => item.requiresStationConfirmation).length,
    missingMyGrid: parsed.candidates.filter((item) => item.requiresGridConfirmation).length,
    issueCounts: issueCounts(parsed, plan),
    rows,
  };
}

export const wwDigiAdifImportTestables = {
  fingerprintOf,
  parseFields,
  splitRecords,
};
