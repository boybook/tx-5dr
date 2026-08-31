import type { ContestQsoEnvelope, QSORecord } from '@tx5dr/plugin-api';

export const WW_DIGI_CONTEST_ID = 'WW-DIGI' as const;
export const WW_DIGI_RULESET_VERSION = 'tx5dr-ww-digi-v1' as const;
export type WWDigiRulesetVersion = typeof WW_DIGI_RULESET_VERSION;

export type WWDigiContestStatus = 'included' | 'x-qso' | 'review';
export type WWDigiContestSource = 'ww-digi' | 'standard' | 'manual' | 'reconciled' | 'imported';

export interface WWDigiContestEntryInput {
  contestYear: number;
  sentGrid: string;
  receivedGrid?: string;
  status?: WWDigiContestStatus;
  source?: WWDigiContestSource;
  streamId?: string;
  authorizationId?: string;
  operatorId?: string;
  transmitterId?: 0 | 1;
  practice?: boolean;
  legacyOverrideResolved?: boolean;
}

export interface WWDigiContestEntryView {
  sentGrid?: string;
  receivedGrid?: string;
  status?: WWDigiContestStatus;
  source?: WWDigiContestSource;
  streamId?: string;
  authorizationId?: string;
  operatorId?: string;
  transmitterId?: 0 | 1;
  practice: boolean;
  legacyOverrideResolved: boolean;
}

export function wwDigiEditionId(contestYear: number): string {
  return `ww-digi-${contestYear}`;
}

/** Edition-aware lookup so future rules only affect their own contest years. */
export function wwDigiRulesetVersion(_contestYear: number): WWDigiRulesetVersion {
  return WW_DIGI_RULESET_VERSION;
}

function normalizedGrid(value: string | undefined): string | undefined {
  const grid = value?.trim().toUpperCase().slice(0, 4);
  return grid || undefined;
}

export function createWWDigiContestEntry(input: WWDigiContestEntryInput): ContestQsoEnvelope {
  const annotations: NonNullable<ContestQsoEnvelope['annotations']> = {
    status: input.status ?? 'included',
    source: input.source ?? 'ww-digi',
  };
  if (input.streamId) annotations.streamId = input.streamId;
  if (input.authorizationId) annotations.authorizationId = input.authorizationId;
  if (input.operatorId) annotations.operatorId = input.operatorId;
  if (input.transmitterId !== undefined) annotations.transmitterId = input.transmitterId;
  if (input.practice) annotations.practice = true;
  if (input.legacyOverrideResolved) annotations.legacyOverrideResolved = true;

  const sentGrid = normalizedGrid(input.sentGrid);
  const receivedGrid = normalizedGrid(input.receivedGrid);
  return {
    schemaVersion: 1,
    contestId: WW_DIGI_CONTEST_ID,
    editionId: wwDigiEditionId(input.contestYear),
    rulesetVersion: wwDigiRulesetVersion(input.contestYear),
    sent: sentGrid ? { grid: sentGrid } : {},
    received: receivedGrid ? { grid: receivedGrid } : {},
    annotations,
  };
}

function annotationString(
  annotations: ContestQsoEnvelope['annotations'],
  key: string,
): string | undefined {
  const value = annotations?.[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function readWWDigiContestEntry(record: Pick<QSORecord, 'contestId' | 'contestEntry'>): WWDigiContestEntryView | undefined {
  const entry = record.contestEntry;
  if (!entry || entry.contestId.toUpperCase() !== WW_DIGI_CONTEST_ID) return undefined;
  const status = annotationString(entry.annotations, 'status');
  const source = annotationString(entry.annotations, 'source');
  const transmitterId = entry.annotations?.transmitterId;
  return {
    sentGrid: normalizedGrid(entry.sent.grid),
    receivedGrid: normalizedGrid(entry.received.grid),
    status: status === 'included' || status === 'x-qso' || status === 'review' ? status : undefined,
    source: source === 'ww-digi' || source === 'standard' || source === 'manual'
      || source === 'reconciled' || source === 'imported' ? source : undefined,
    streamId: annotationString(entry.annotations, 'streamId'),
    authorizationId: annotationString(entry.annotations, 'authorizationId'),
    operatorId: annotationString(entry.annotations, 'operatorId'),
    transmitterId: transmitterId === 0 || transmitterId === 1 ? transmitterId : undefined,
    practice: entry.annotations?.practice === true,
    legacyOverrideResolved: entry.annotations?.legacyOverrideResolved === true,
  };
}

export function withWWDigiContestEntry(
  record: QSORecord,
  input: WWDigiContestEntryInput,
): QSORecord {
  return {
    ...record,
    contestId: WW_DIGI_CONTEST_ID,
    contestEntry: createWWDigiContestEntry(input),
  };
}
