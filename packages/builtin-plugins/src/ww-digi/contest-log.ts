export const WW_DIGI_CONTEST_ID = 'WW-DIGI' as const;
export const WW_DIGI_MIN_CONTEST_YEAR = 2019;
export const WW_DIGI_MAX_CONTEST_YEAR = 2100;

export interface WWDigiContestPeriod {
  contestYear: number;
  startTime: number;
  /** Exclusive end: Sunday 12:00:00 UTC. */
  endTime: number;
}

export const WW_DIGI_BANDS = ['160M', '80M', '40M', '20M', '15M', '10M'] as const;
export type WWDigiBand = typeof WW_DIGI_BANDS[number];

export const WW_DIGI_POWER_CATEGORIES = ['HIGH', 'LOW', 'QRP'] as const;
export type WWDigiPowerCategory = typeof WW_DIGI_POWER_CATEGORIES[number];

export type ContestQsoStatus = 'included' | 'x-qso' | 'review';

export interface ContestQso {
  /** Stable general-log QSO ID and idempotency key. */
  qsoId: string;
  callsign: string;
  myCallsign: string;
  sentGrid: string;
  /** Missing exchange is rendered as the WW Digi placeholder `ZZ00`. */
  receivedGrid?: string;
  /** Actual RF frequency in hertz. */
  frequencyHz: number;
  band: WWDigiBand;
  mode: 'FT4' | 'FT8';
  /** UTC instant represented as Unix epoch milliseconds. */
  startTime: number;
  status: ContestQsoStatus;
  streamId?: string;
  authorizationId?: string;
  operatorId?: string;
  transmitterId?: 0 | 1;
  source?: 'ww-digi' | 'standard' | 'manual' | 'reconciled';
}

export interface ContestConfig {
  callsign: string;
  location: string;
  categoryBand: 'ALL' | WWDigiBand;
  categoryPower: WWDigiPowerCategory;
  categoryOperator?: 'SINGLE-OP' | 'MULTI-OP' | 'CHECKLOG';
  categoryTransmitter?: 'ONE' | 'TWO' | 'UNLIMITED';
  operators?: string[];
  createdBy?: string;
}

export interface ContestQsoRuntimeView extends ContestQso {
  /** Normalized four-character received exchange, including `ZZ00`. */
  receivedGrid: string;
  /** True only for a scoring duplicate among included QSOs. */
  dupe: boolean;
}

export class ContestLogValidationError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(`${field}: ${message}`);
    this.name = 'ContestLogValidationError';
  }
}

const GRID_PATTERN = /^[A-R]{2}[0-9]{2}$/;
const CALLSIGN_PATTERN = /^[A-Z0-9/]+$/;
const BAND_RANGES_HZ: Record<WWDigiBand, readonly [number, number]> = {
  '160M': [1_800_000, 2_000_000],
  '80M': [3_500_000, 4_000_000],
  '40M': [7_000_000, 7_300_000],
  '20M': [14_000_000, 14_350_000],
  '15M': [21_000_000, 21_450_000],
  '10M': [28_000_000, 29_700_000],
};

/** Resolve the last full August weekend as a half-open UTC contest period. */
export function resolveWWDigiContestPeriod(contestYear: number): WWDigiContestPeriod {
  if (!Number.isInteger(contestYear)
      || contestYear < WW_DIGI_MIN_CONTEST_YEAR
      || contestYear > WW_DIGI_MAX_CONTEST_YEAR) {
    throw new ContestLogValidationError(
      'contestYear',
      `must be an integer from ${WW_DIGI_MIN_CONTEST_YEAR} to ${WW_DIGI_MAX_CONTEST_YEAR}`,
    );
  }
  const augustLastDay = new Date(Date.UTC(contestYear, 7, 31));
  const sundayDate = 31 - augustLastDay.getUTCDay();
  const saturdayDate = sundayDate - 1;
  return {
    contestYear,
    startTime: Date.UTC(contestYear, 7, saturdayDate, 12, 0, 0),
    endTime: Date.UTC(contestYear, 7, sundayDate, 12, 0, 0),
  };
}

/** Official WW Digi deadline: 23:59:59 UTC two calendar days after the contest ends. */
export function resolveWWDigiLogDeadline(contestYear: number): number {
  const end = new Date(resolveWWDigiContestPeriod(contestYear).endTime);
  return Date.UTC(
    end.getUTCFullYear(),
    end.getUTCMonth(),
    end.getUTCDate() + 2,
    23,
    59,
    59,
  );
}

export function isWithinWWDigiContestPeriod(timestamp: number, contestYear: number): boolean {
  if (!Number.isFinite(timestamp)) return false;
  const period = resolveWWDigiContestPeriod(contestYear);
  return timestamp >= period.startTime && timestamp < period.endTime;
}

export function resolveWWDigiBand(frequencyHz: number): WWDigiBand | undefined {
  return WW_DIGI_BANDS.find((band) => {
    const [minimumHz, maximumHz] = BAND_RANGES_HZ[band];
    return frequencyHz >= minimumHz && frequencyHz <= maximumHz;
  });
}

function fail(field: string, message: string): never {
  throw new ContestLogValidationError(field, message);
}

function normalizeRequiredToken(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') fail(field, 'must be a string');
  const normalized = value.trim().toUpperCase();
  if (!normalized) fail(field, 'must not be empty');
  if (normalized.length > maxLength) fail(field, `must not exceed ${maxLength} characters`);
  if (/[\r\n]/.test(normalized)) fail(field, 'must not contain line breaks');
  return normalized;
}

function normalizeCallsign(value: unknown, field: string): string {
  const callsign = normalizeRequiredToken(value, field, 13);
  if (!CALLSIGN_PATTERN.test(callsign)) {
    fail(field, 'must contain only A-Z, 0-9, or /');
  }
  return callsign;
}

function normalizeGrid(value: unknown, field: string, allowMissing: boolean): string | undefined {
  if (value === undefined || value === null || value === '') {
    if (allowMissing) return undefined;
    fail(field, 'must be a four-character Maidenhead grid');
  }
  const grid = normalizeRequiredToken(value, field, 4);
  if (allowMissing && grid === 'ZZ00') return undefined;
  if (!GRID_PATTERN.test(grid)) {
    fail(field, 'must be a four-character Maidenhead grid');
  }
  return grid;
}

function normalizeCreatedBy(value: unknown): string {
  if (value === undefined) return 'TX-5DR';
  if (typeof value !== 'string') fail('config.createdBy', 'must be a string');
  const normalized = value.trim();
  if (!normalized) fail('config.createdBy', 'must not be empty');
  if (normalized.length > 128) fail('config.createdBy', 'must not exceed 128 characters');
  if (/[\r\n]/.test(normalized)) fail('config.createdBy', 'must not contain line breaks');
  return normalized;
}

type NormalizedContestConfig = Required<ContestConfig>;

function normalizeConfig(config: ContestConfig): NormalizedContestConfig {
  if (!config || typeof config !== 'object') fail('config', 'must be an object');

  const callsign = normalizeCallsign(config.callsign, 'config.callsign');
  const location = normalizeRequiredToken(config.location, 'config.location', 32);
  const categoryBand = normalizeRequiredToken(config.categoryBand, 'config.categoryBand', 4);
  if (categoryBand !== 'ALL' && !WW_DIGI_BANDS.includes(categoryBand as WWDigiBand)) {
    fail('config.categoryBand', 'must be ALL or a WW Digi contest band');
  }
  const categoryPower = normalizeRequiredToken(config.categoryPower, 'config.categoryPower', 4);
  if (!WW_DIGI_POWER_CATEGORIES.includes(categoryPower as WWDigiPowerCategory)) {
    fail('config.categoryPower', 'must be HIGH, LOW, or QRP');
  }
  const categoryOperator = normalizeRequiredToken(config.categoryOperator ?? 'SINGLE-OP', 'config.categoryOperator', 10);
  if (!['SINGLE-OP', 'MULTI-OP', 'CHECKLOG'].includes(categoryOperator)) {
    fail('config.categoryOperator', 'must be SINGLE-OP, MULTI-OP, or CHECKLOG');
  }
  const categoryTransmitter = normalizeRequiredToken(config.categoryTransmitter ?? 'ONE', 'config.categoryTransmitter', 9);
  if (!['ONE', 'TWO', 'UNLIMITED'].includes(categoryTransmitter)) {
    fail('config.categoryTransmitter', 'must be ONE, TWO, or UNLIMITED');
  }
  const operators = (config.operators ?? []).map((operator, index) => normalizeCallsign(operator, `config.operators.${index}`));
  if (categoryOperator === 'MULTI-OP' && operators.length === 0) {
    fail('config.operators', 'is required for MULTI-OP');
  }
  if (categoryOperator === 'SINGLE-OP' && categoryTransmitter === 'TWO') {
    fail('config.categoryTransmitter', 'TWO is not available for SINGLE-OP');
  }
  if ((categoryOperator === 'MULTI-OP' || categoryTransmitter === 'UNLIMITED') && categoryBand !== 'ALL') {
    fail('config.categoryBand', 'must be ALL for this operator/transmitter category');
  }
  if (categoryOperator === 'MULTI-OP' && categoryTransmitter === 'ONE' && categoryPower === 'QRP') {
    fail('config.categoryPower', 'MULTI-ONE is available only as HIGH or LOW');
  }
  if (categoryOperator === 'MULTI-OP'
      && (categoryTransmitter === 'TWO' || categoryTransmitter === 'UNLIMITED')
      && categoryPower !== 'HIGH') {
    fail('config.categoryPower', 'MULTI-TWO and MULTI-UNLIMITED require HIGH');
  }

  return {
    callsign,
    location,
    categoryBand: categoryBand as ContestConfig['categoryBand'],
    categoryPower: categoryPower as WWDigiPowerCategory,
    categoryOperator: categoryOperator as NormalizedContestConfig['categoryOperator'],
    categoryTransmitter: categoryTransmitter as NormalizedContestConfig['categoryTransmitter'],
    operators,
    createdBy: normalizeCreatedBy(config.createdBy),
  };
}

function normalizeContestQso(qso: ContestQso): ContestQso {
  if (!qso || typeof qso !== 'object') fail('qso', 'must be an object');

  const qsoId = typeof qso.qsoId === 'string' ? qso.qsoId.trim() : '';
  if (!qsoId) fail('qso.qsoId', 'must not be empty');
  if (qsoId.length > 128) fail('qso.qsoId', 'must not exceed 128 characters');

  const band = normalizeRequiredToken(qso.band, 'qso.band', 4) as WWDigiBand;
  if (!WW_DIGI_BANDS.includes(band)) fail('qso.band', 'must be a WW Digi contest band');

  if (!Number.isSafeInteger(qso.frequencyHz) || qso.frequencyHz <= 0) {
    fail('qso.frequencyHz', 'must be a positive integer number of hertz');
  }
  const [minimumHz, maximumHz] = BAND_RANGES_HZ[band];
  if (qso.frequencyHz < minimumHz || qso.frequencyHz > maximumHz) {
    fail('qso.frequencyHz', `does not belong to ${band}`);
  }

  const mode = normalizeRequiredToken(qso.mode, 'qso.mode', 3);
  if (mode !== 'FT4' && mode !== 'FT8') fail('qso.mode', 'must be FT4 or FT8');

  if (!Number.isSafeInteger(qso.startTime)) {
    fail('qso.startTime', 'must be Unix epoch milliseconds');
  }
  try {
    new Date(qso.startTime).toISOString();
  } catch {
    fail('qso.startTime', 'must be a valid UTC instant');
  }

  if (qso.status !== 'included' && qso.status !== 'x-qso' && qso.status !== 'review') {
    fail('qso.status', 'must be included, x-qso, or review');
  }

  return {
    qsoId,
    callsign: normalizeCallsign(qso.callsign, 'qso.callsign'),
    myCallsign: normalizeCallsign(qso.myCallsign, 'qso.myCallsign'),
    sentGrid: normalizeGrid(qso.sentGrid, 'qso.sentGrid', false)!,
    receivedGrid: normalizeGrid(qso.receivedGrid, 'qso.receivedGrid', true),
    frequencyHz: qso.frequencyHz,
    band,
    mode,
    startTime: qso.startTime,
    status: qso.status,
    streamId: typeof qso.streamId === 'string' && qso.streamId.trim() ? qso.streamId.trim() : undefined,
    authorizationId: typeof qso.authorizationId === 'string' && qso.authorizationId.trim()
      ? qso.authorizationId.trim()
      : undefined,
    operatorId: typeof qso.operatorId === 'string' && qso.operatorId.trim() ? qso.operatorId.trim() : undefined,
    transmitterId: qso.transmitterId === 0 || qso.transmitterId === 1 ? qso.transmitterId : undefined,
    source: qso.source,
  };
}

/** Validate and normalize one config snapshot. */
export function validateContestConfig(config: ContestConfig): NormalizedContestConfig {
  return normalizeConfig(config);
}

/** Validate and normalize one contest QSO. */
export function validateContestQso(qso: ContestQso): ContestQso {
  return normalizeContestQso(qso);
}

/**
 * Insert or replace one QSO by its stable general-log ID.
 *
 * Replaying an identical committed QSO is therefore a no-op in the resulting
 * value, while an explicit status correction replaces the existing projection.
 */
export function upsertContestQso(records: readonly ContestQso[], qso: ContestQso): ContestQso[] {
  const normalized = normalizeContestQso(qso);
  const next = records.map(normalizeContestQso);
  const existingIndex = next.findIndex((candidate) => candidate.qsoId === normalized.qsoId);
  if (existingIndex < 0) return [...next, normalized];

  next[existingIndex] = normalized;
  return next;
}

/** Update inclusion state without deleting the underlying contact. */
export function setContestQsoStatus(
  records: readonly ContestQso[],
  qsoId: string,
  status: ContestQsoStatus,
): ContestQso[] {
  if (status !== 'included' && status !== 'x-qso' && status !== 'review') {
    fail('status', 'must be included, x-qso, or review');
  }
  if (typeof qsoId !== 'string' || !qsoId.trim()) fail('qsoId', 'must not be empty');
  const normalizedId = qsoId.trim();
  const normalizedRecords = records.map(normalizeContestQso);
  const existing = normalizedRecords.find((candidate) => candidate.qsoId === normalizedId);
  if (!existing) fail('qsoId', 'does not identify an existing contest QSO');
  return upsertContestQso(normalizedRecords, { ...existing, status });
}

function coalesceByQsoId(records: readonly ContestQso[]): ContestQso[] {
  const byId = new Map<string, ContestQso>();
  for (const record of records) {
    const normalized = normalizeContestQso(record);
    byId.set(normalized.qsoId, normalized);
  }
  return [...byId.values()];
}

function compareQso(left: ContestQso, right: ContestQso): number {
  return left.startTime - right.startTime || left.qsoId.localeCompare(right.qsoId);
}

/** Return the deterministic, chronological runtime projection with live dupe state. */
export function projectContestQsos(records: readonly ContestQso[]): ContestQsoRuntimeView[] {
  const worked = new Set<string>();
  return coalesceByQsoId(records)
    .sort(compareQso)
    .map((qso) => {
      const key = `${qso.callsign}:${qso.band}`;
      const countsAsWorked = qso.status === 'included' || qso.status === 'review';
      const dupe = countsAsWorked && worked.has(key);
      if (countsAsWorked) worked.add(key);
      return {
        ...qso,
        receivedGrid: qso.receivedGrid ?? 'ZZ00',
        dupe,
      };
    });
}

function formatUtc(timestamp: number): { date: string; time: string } {
  const iso = new Date(timestamp).toISOString();
  return {
    date: iso.slice(0, 10),
    time: `${iso.slice(11, 13)}${iso.slice(14, 16)}`,
  };
}

function renderQsoLine(qso: ContestQsoRuntimeView): string {
  const { date, time } = formatUtc(qso.startTime);
  const prefix = qso.status === 'x-qso' ? 'X-QSO:' : 'QSO:';
  const frequencyKhz = Math.round(qso.frequencyHz / 1_000).toString().padStart(5, ' ');
  return `${prefix} ${frequencyKhz} DG ${date} ${time} ${qso.myCallsign.padEnd(13)} ${qso.sentGrid.padEnd(8)} ${qso.callsign.padEnd(13)} ${qso.receivedGrid.padEnd(8)} ${qso.transmitterId ?? 0}`;
}

/** Generate one deterministic Cabrillo 3.0 WW Digi submission with CRLF line endings. */
export function generateWWDigiCabrillo(
  config: ContestConfig,
  records: readonly ContestQso[],
): string {
  const normalizedConfig = normalizeConfig(config);
  const projected = projectContestQsos(records);
  if (projected.some((qso) => qso.status === 'review')) fail('qso.status', 'all review records must be resolved before export');
  if (normalizedConfig.categoryTransmitter === 'TWO'
      && projected.some((qso) => qso.status !== 'x-qso' && qso.transmitterId !== 0 && qso.transmitterId !== 1)) {
    fail('qso.transmitterId', 'is required for every TWO-transmitter QSO');
  }
  for (const qso of projected) {
    if (qso.myCallsign !== normalizedConfig.callsign) {
      fail('qso.myCallsign', `must match config.callsign for QSO ${qso.qsoId}`);
    }
  }

  return buildCabrilloDocument({
    headers: [
      ['CONTEST', WW_DIGI_CONTEST_ID],
      ['CALLSIGN', normalizedConfig.callsign],
      ['LOCATION', normalizedConfig.location],
      ['CATEGORY-OPERATOR', normalizedConfig.categoryOperator],
      ['CATEGORY-TRANSMITTER', normalizedConfig.categoryTransmitter],
      ['CATEGORY-BAND', normalizedConfig.categoryBand],
      ['CATEGORY-POWER', normalizedConfig.categoryPower],
      ['CATEGORY-MODE', 'DIGI'],
      ['CATEGORY-STATION', 'FIXED'],
      ...(normalizedConfig.operators.length > 0 ? [['OPERATORS', normalizedConfig.operators.join(', ')]] as const : []),
      ['CREATED-BY', normalizedConfig.createdBy],
    ],
    qsoLines: projected.map(renderQsoLine),
  });
}
import { buildCabrilloDocument } from '@tx5dr/plugin-api/toolkit';
