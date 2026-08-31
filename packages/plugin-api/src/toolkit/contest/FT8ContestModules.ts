import { normalizeCallsign } from '../../utils/callsign.js';
import { calculateGridDistance } from '@tx5dr/core';
import { buildCabrilloDocument, type CabrilloDocumentInput } from './CabrilloBuilder.js';

/** Modes currently covered by the FT8 contest composition API. */
export type FT8ContestMode = 'FT8' | 'FT4';

/** Flat exchange fields suitable for a contest QSO envelope or submission adapter. */
export type ContestExchangeFields = Readonly<Record<string, string>>;

export interface ContestValidationIssue {
  code: string;
  field?: string;
  message?: string;
}

export type FT8ExchangeDecodeResult<TExchange> =
  | { ok: true; value: TExchange }
  | { ok: false; issues: readonly ContestValidationIssue[] };

/** Converts between typed contest exchange data and flat persisted fields. */
export interface FT8ExchangeModule<TExchange> {
  readonly id: string;
  decode(fields: ContestExchangeFields): FT8ExchangeDecodeResult<TExchange>;
  encode(exchange: TExchange): ContestExchangeFields;
  validate(exchange: TExchange): readonly ContestValidationIssue[];
}

export function defineFT8ExchangeModule<TExchange>(
  module: FT8ExchangeModule<TExchange>,
): FT8ExchangeModule<TExchange> {
  return module;
}

export interface GridExchange {
  grid: string;
}

export interface GridAndSnrExchange extends GridExchange {
  snr: number;
}

export interface GridExchangeOptions {
  /** Value used when an imported exchange has no grid. Omit to reject it. */
  missingGrid?: string;
}

function normalizeGrid(grid: string): string {
  return grid.trim().toUpperCase();
}

function validateGrid(grid: string, allowedMissingGrid?: string): ContestValidationIssue[] {
  const normalized = normalizeGrid(grid);
  if (allowedMissingGrid && normalized === normalizeGrid(allowedMissingGrid)) return [];
  if (!/^[A-R]{2}[0-9]{2}$/.test(normalized)) {
    return [{ code: 'invalid_grid', field: 'grid' }];
  }
  return [];
}

/** Common four-character Maidenhead exchange. */
export function gridExchange(options: GridExchangeOptions = {}): FT8ExchangeModule<GridExchange> {
  return defineFT8ExchangeModule({
    id: 'grid-4',
    decode(fields) {
      const grid = normalizeGrid(fields.grid ?? options.missingGrid ?? '');
      const issues = validateGrid(grid, options.missingGrid);
      return issues.length > 0 ? { ok: false, issues } : { ok: true, value: { grid } };
    },
    encode(exchange) {
      return { grid: normalizeGrid(exchange.grid) };
    },
    validate(exchange) {
      return validateGrid(exchange.grid, options.missingGrid);
    },
  });
}

/** Four-character Maidenhead plus an integer signal report. */
export function gridAndSnrExchange(
  options: GridExchangeOptions = {},
): FT8ExchangeModule<GridAndSnrExchange> {
  return defineFT8ExchangeModule({
    id: 'grid-4-and-snr',
    decode(fields) {
      const grid = normalizeGrid(fields.grid ?? options.missingGrid ?? '');
      const snrText = fields.snr?.trim() ?? '';
      const snr = Number(snrText);
      const issues = validateGrid(grid, options.missingGrid);
      if (snrText === '' || !Number.isInteger(snr)) {
        issues.push({ code: 'invalid_snr', field: 'snr' });
      }
      return issues.length > 0 ? { ok: false, issues } : { ok: true, value: { grid, snr } };
    },
    encode(exchange) {
      return { grid: normalizeGrid(exchange.grid), snr: String(exchange.snr) };
    },
    validate(exchange) {
      const issues = validateGrid(exchange.grid, options.missingGrid);
      if (!Number.isInteger(exchange.snr)) issues.push({ code: 'invalid_snr', field: 'snr' });
      return issues;
    },
  });
}

export interface CompletionEvidence<TExchange> {
  sentExchange?: TExchange;
  receivedExchange?: TExchange;
  sentFinalAck?: boolean;
  receivedFinalAck?: boolean;
}

export interface CompletionEvaluation {
  complete: boolean;
  missing: readonly string[];
}

/** Pure completion policy. It never keys the radio or mutates Host state. */
export interface CompletionModule<TExchange> {
  readonly id: string;
  evaluate(evidence: CompletionEvidence<TExchange>): CompletionEvaluation;
}

export function defineCompletionModule<TExchange>(
  module: CompletionModule<TExchange>,
): CompletionModule<TExchange> {
  return module;
}

export interface ExchangeAndFinalAckOptions {
  exchange?: 'received' | 'both';
  finalAck?: 'sent' | 'received' | 'either' | 'both';
}

/** Requires exchange evidence and an explicit final acknowledgement. */
export function requireExchangeAndFinalAck<TExchange>(
  options: ExchangeAndFinalAckOptions = {},
): CompletionModule<TExchange> {
  const exchange = options.exchange ?? 'both';
  const finalAck = options.finalAck ?? 'either';
  return {
    id: `exchange-${exchange}-final-ack-${finalAck}`,
    evaluate(evidence) {
      const missing: string[] = [];
      if (!evidence.receivedExchange) missing.push('received_exchange');
      if (exchange === 'both' && !evidence.sentExchange) missing.push('sent_exchange');

      if (finalAck === 'sent' && !evidence.sentFinalAck) missing.push('sent_final_ack');
      if (finalAck === 'received' && !evidence.receivedFinalAck) missing.push('received_final_ack');
      if (finalAck === 'either' && !evidence.sentFinalAck && !evidence.receivedFinalAck) {
        missing.push('final_ack');
      }
      if (finalAck === 'both') {
        if (!evidence.sentFinalAck) missing.push('sent_final_ack');
        if (!evidence.receivedFinalAck) missing.push('received_final_ack');
      }
      return { complete: missing.length === 0, missing };
    },
  };
}

/** Minimal QSO shape used by common FT8 contest modules. Plugins may extend it. */
export interface FT8ContestQso<TExchange = unknown> {
  callsign: string;
  band: string;
  mode: FT8ContestMode;
  /** QSO start time used for edition eligibility. */
  startTime: number;
  /** Review/excluded records remain visible but are not scored or submitted. */
  status?: 'included' | 'review' | 'excluded' | 'x-qso';
  sentExchange?: TExchange;
  receivedExchange?: TExchange;
  distanceKm?: number;
}

/** Center-to-center Maidenhead distance shared by FT8 distance-scoring rules. */
export function maidenheadDistanceKm(fromGrid: string, toGrid: string): number | undefined {
  return calculateGridDistance(fromGrid, toGrid) ?? undefined;
}

export interface ContestSerialOptions<TRecord> {
  serial(record: TRecord): string | number | undefined;
  startAt?: number;
  width?: number;
}

/**
 * Allocates the next serial from a current QSO snapshot. Call this inside
 * `ContestApplicationSessionFacade.transact()` so revision retries re-plan it.
 */
export function nextContestSerial<TRecord>(
  records: readonly TRecord[],
  options: ContestSerialOptions<TRecord>,
): string {
  const startAt = options.startAt ?? 1;
  const width = options.width ?? 3;
  if (!Number.isInteger(startAt) || startAt < 1 || !Number.isInteger(width) || width < 1 || width > 9) {
    throw new Error('contest_serial_invalid_options');
  }
  let maximum = startAt - 1;
  for (const record of records) {
    const value = options.serial(record);
    const text = typeof value === 'number' ? String(value) : value?.trim();
    if (!text || !/^\d+$/.test(text)) continue;
    const serial = Number(text);
    if (Number.isSafeInteger(serial) && serial >= startAt) maximum = Math.max(maximum, serial);
  }
  return String(maximum + 1).padStart(width, '0');
}

export type DupeScope = 'band' | 'mode' | 'session' | 'contest';

export interface DupeModule<TQso> {
  readonly id: string;
  readonly scope: DupeScope;
  key(qso: TQso): string;
}

export function defineDupeModule<TQso>(module: DupeModule<TQso>): DupeModule<TQso> {
  return module;
}

export interface OncePerBandOptions {
  /** Set true only when FT4 and FT8 are separate duplicate scopes. */
  includeMode?: boolean;
}

/** Default FT contest duplicate policy: normalized callsign once per band. */
export function oncePerBand<TQso extends Pick<FT8ContestQso, 'callsign' | 'band' | 'mode'>>(
  options: OncePerBandOptions = {},
): DupeModule<TQso> {
  return defineDupeModule({
    id: options.includeMode ? 'callsign-band-mode' : 'callsign-band',
    scope: options.includeMode ? 'mode' : 'band',
    key(qso) {
      const parts = [normalizeCallsign(qso.callsign), qso.band.trim().toUpperCase()];
      if (options.includeMode) parts.push(qso.mode);
      return parts.join(':');
    },
  });
}

export interface ContestQsoScore {
  points: number;
  multiplierKeys: readonly string[];
  eligible: boolean;
}

export interface ContestScoreSummary {
  qsoCount: number;
  qsoPoints: number;
  multiplierCount: number;
  total: number;
}

export interface ScoringModule<TQso> {
  readonly id: string;
  score(qso: TQso): ContestQsoScore;
  aggregate(scores: readonly ContestQsoScore[]): ContestScoreSummary;
}

export function defineScoringModule<TQso>(module: ScoringModule<TQso>): ScoringModule<TQso> {
  return module;
}

export interface DistancePointsOptions<TQso> {
  stepKm: number;
  rounding?: 'floor' | 'ceil';
  basePoints?: number;
  /** Minimum number of distance steps, used by rules that award one step for any valid QSO. */
  minimumDistanceSteps?: number;
  missingDistancePoints?: number;
  distanceKm?: (qso: TQso) => number | undefined;
  multiplierKeys?: (qso: TQso) => readonly string[];
}

/** Common distance-step scoring with optional multiplier aggregation. */
export function distancePoints<
  TQso extends { distanceKm?: number } = FT8ContestQso,
>(
  options: DistancePointsOptions<TQso>,
): ScoringModule<TQso> {
  if (!Number.isFinite(options.stepKm) || options.stepKm <= 0) {
    throw new Error('contest_scoring_invalid_step_km');
  }
  const basePoints = options.basePoints ?? 1;
  const minimumDistanceSteps = options.minimumDistanceSteps ?? 0;
  if (!Number.isInteger(minimumDistanceSteps) || minimumDistanceSteps < 0) {
    throw new Error('contest_scoring_invalid_minimum_distance_steps');
  }
  const rounding = options.rounding ?? 'floor';
  const usesMultipliers = options.multiplierKeys !== undefined;
  const round = rounding === 'ceil' ? Math.ceil : Math.floor;
  return defineScoringModule({
    id: `distance-${rounding}-${options.stepKm}`,
    score(qso) {
      const distanceKm = options.distanceKm?.(qso) ?? qso.distanceKm;
      const points = distanceKm === undefined || !Number.isFinite(distanceKm) || distanceKm < 0
        ? options.missingDistancePoints ?? 0
        : basePoints + Math.max(minimumDistanceSteps, round(distanceKm / options.stepKm));
      return {
        points,
        multiplierKeys: options.multiplierKeys?.(qso) ?? [],
        eligible: points > 0,
      };
    },
    aggregate(scores) {
      const eligible = scores.filter((score) => score.eligible);
      const qsoPoints = eligible.reduce((sum, score) => sum + score.points, 0);
      const multiplierCount = new Set(eligible.flatMap((score) => score.multiplierKeys)).size;
      return {
        qsoCount: eligible.length,
        qsoPoints,
        multiplierCount,
        total: usesMultipliers ? qsoPoints * multiplierCount : qsoPoints,
      };
    },
  });
}

export interface GridFieldMultiplierOptions<TQso> {
  grid(qso: TQso): string | undefined;
  band?: (qso: TQso) => string | undefined;
}

/** Builds multiplier keys from the first two characters of a valid grid. */
export function gridFieldMultiplier<TQso>(
  options: GridFieldMultiplierOptions<TQso>,
): (qso: TQso) => readonly string[] {
  return (qso) => {
    const grid = normalizeGrid(options.grid(qso) ?? '');
    if (!/^[A-R]{2}[0-9]{2}$/.test(grid)) return [];
    const band = options.band?.(qso)?.trim().toUpperCase();
    return [band ? `${band}:${grid.slice(0, 2)}` : grid.slice(0, 2)];
  };
}

export interface SubmissionModule<TQso, TOptions = void> {
  readonly id: string;
  readonly mediaType: string;
  readonly extension: string;
  format(records: readonly TQso[], options: TOptions): string;
}

export function defineSubmissionModule<TQso, TOptions = void>(
  module: SubmissionModule<TQso, TOptions>,
): SubmissionModule<TQso, TOptions> {
  return module;
}

export interface CabrilloSubmissionOptions<TQso, TOptions> {
  headers(options: TOptions): CabrilloDocumentInput['headers'];
  qsoLine(qso: TQso, options: TOptions): string;
}

/** Cabrillo adapter that leaves every contest-specific column with the plugin. */
export function cabrilloSubmission<TQso = FT8ContestQso, TOptions = void>(
  options: CabrilloSubmissionOptions<TQso, TOptions>,
): SubmissionModule<TQso, TOptions> {
  return defineSubmissionModule({
    id: 'cabrillo-3',
    mediaType: 'text/plain',
    extension: '.log',
    format(records, formatOptions) {
      return buildCabrilloDocument({
        headers: options.headers(formatOptions),
        qsoLines: records.map((record) => options.qsoLine(record, formatOptions)),
      });
    },
  });
}
