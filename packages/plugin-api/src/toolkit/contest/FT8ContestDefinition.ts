import type {
  CompletionModule,
  DupeModule,
  FT8ContestMode,
  FT8ContestQso,
  FT8ExchangeModule,
  ScoringModule,
  ContestScoreSummary,
  SubmissionModule,
} from './FT8ContestModules.js';
import { oncePerBand } from './FT8ContestModules.js';

export interface ContestRuleSource {
  readonly url: string;
  readonly confirmedAt?: string;
}

/** Immutable identity and time boundary for one contest occurrence. */
export interface ContestEditionDefinition {
  readonly id: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly source?: ContestRuleSource;
}

export interface FixedWeekendEditionInput {
  id: string;
  startAt: string | Date;
  endAt: string | Date;
  source?: ContestRuleSource;
}

function toIso(value: string | Date, field: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`contest_edition_invalid_${field}`);
  return date.toISOString();
}

/** Defines one fixed contest occurrence; the name reflects the common weekend format. */
export function fixedWeekendEdition(input: FixedWeekendEditionInput): ContestEditionDefinition {
  const startAt = toIso(input.startAt, 'start');
  const endAt = toIso(input.endAt, 'end');
  if (new Date(endAt).getTime() <= new Date(startAt).getTime()) {
    throw new Error('contest_edition_invalid_range');
  }
  if (!input.id.trim()) throw new Error('contest_edition_id_required');
  return Object.freeze({
    id: input.id.trim(),
    startAt,
    endAt,
    source: input.source ? Object.freeze({ ...input.source }) : undefined,
  });
}

export interface FT8OperatingPolicy {
  humanInitiation: 'required' | 'optional';
  maxConcurrentQsos: number;
  maxSimultaneousSignals: number;
  cycleRelation: 'single' | 'same' | 'opposite' | 'any';
}

export interface FT8ContestDefinition<
  TExchange,
  TQso extends FT8ContestQso<TExchange>,
  TSubmissionOptions = void,
> {
  readonly id: string;
  readonly rulesetVersion: string;
  readonly edition: ContestEditionDefinition;
  readonly modes: readonly FT8ContestMode[];
  readonly bands: readonly string[];
  readonly exchange: FT8ExchangeModule<TExchange>;
  readonly completion: CompletionModule<TExchange>;
  readonly dupe: DupeModule<TQso>;
  readonly scoring: ScoringModule<TQso>;
  readonly submission: SubmissionModule<TQso, TSubmissionOptions>;
  readonly operating: Readonly<FT8OperatingPolicy>;
}

export interface FT8ContestDefinitionInput<
  TExchange,
  TQso extends FT8ContestQso<TExchange>,
  TSubmissionOptions = void,
> {
  id: string;
  rulesetVersion: string;
  edition: ContestEditionDefinition;
  modes?: readonly FT8ContestMode[];
  bands: readonly string[];
  exchange: FT8ExchangeModule<TExchange>;
  /** Completion stays explicit because it participates in RF fail-closed behavior. */
  completion: CompletionModule<TExchange>;
  dupe?: DupeModule<TQso>;
  scoring: ScoringModule<TQso>;
  submission: SubmissionModule<TQso, TSubmissionOptions>;
  operating?: Partial<FT8OperatingPolicy>;
}

const SAFE_OPERATING_DEFAULTS: FT8OperatingPolicy = {
  humanInitiation: 'required',
  maxConcurrentQsos: 1,
  maxSimultaneousSignals: 1,
  cycleRelation: 'single',
};

const HOST_MAX_CONTEST_STREAMS = 5;

function snapshotExchangeModule<TExchange>(
  module: FT8ExchangeModule<TExchange>,
): FT8ExchangeModule<TExchange> {
  return Object.freeze({
    id: module.id,
    decode: module.decode.bind(module),
    encode: module.encode.bind(module),
    validate: module.validate.bind(module),
  });
}

function snapshotCompletionModule<TExchange>(
  module: CompletionModule<TExchange>,
): CompletionModule<TExchange> {
  return Object.freeze({ id: module.id, evaluate: module.evaluate.bind(module) });
}

function snapshotDupeModule<TQso>(module: DupeModule<TQso>): DupeModule<TQso> {
  return Object.freeze({ id: module.id, scope: module.scope, key: module.key.bind(module) });
}

function snapshotScoringModule<TQso>(module: ScoringModule<TQso>): ScoringModule<TQso> {
  return Object.freeze({
    id: module.id,
    score: module.score.bind(module),
    aggregate: module.aggregate.bind(module),
  });
}

function snapshotSubmissionModule<TQso, TOptions>(
  module: SubmissionModule<TQso, TOptions>,
): SubmissionModule<TQso, TOptions> {
  return Object.freeze({
    id: module.id,
    mediaType: module.mediaType,
    extension: module.extension,
    format: module.format.bind(module),
  });
}

/**
 * Composes public rule modules into a normalized FT8/FT4 contest definition.
 * It performs no Host registration and every supplied module remains replaceable.
 */
export function defineFT8Contest<
  TExchange,
  TQso extends FT8ContestQso<TExchange> = FT8ContestQso<TExchange>,
  TSubmissionOptions = void,
>(
  input: FT8ContestDefinitionInput<TExchange, TQso, TSubmissionOptions>,
): FT8ContestDefinition<TExchange, TQso, TSubmissionOptions> {
  const id = input.id.trim();
  const rulesetVersion = input.rulesetVersion.trim();
  if (!id) throw new Error('contest_id_required');
  if (!rulesetVersion) throw new Error('contest_ruleset_version_required');

  const edition = fixedWeekendEdition(input.edition);
  const modes: FT8ContestMode[] = [...new Set<FT8ContestMode>(input.modes ?? ['FT8'])];
  const bands = [...new Set(input.bands.map((band) => band.trim().toUpperCase()).filter(Boolean))];
  if (modes.length === 0) throw new Error('contest_modes_required');
  if (bands.length === 0) throw new Error('contest_bands_required');

  const operating = { ...SAFE_OPERATING_DEFAULTS, ...input.operating };
  if (!Number.isInteger(operating.maxConcurrentQsos)
    || operating.maxConcurrentQsos < 1
    || operating.maxConcurrentQsos > HOST_MAX_CONTEST_STREAMS) {
    throw new Error('contest_operating_invalid_concurrent_qsos');
  }
  if (!Number.isInteger(operating.maxSimultaneousSignals)
    || operating.maxSimultaneousSignals < 1
    || operating.maxSimultaneousSignals > HOST_MAX_CONTEST_STREAMS
    || operating.maxSimultaneousSignals > operating.maxConcurrentQsos) {
    throw new Error('contest_operating_invalid_simultaneous_signals');
  }

  return Object.freeze({
    ...input,
    id,
    rulesetVersion,
    edition,
    modes: Object.freeze(modes),
    bands: Object.freeze(bands),
    exchange: snapshotExchangeModule(input.exchange),
    completion: snapshotCompletionModule(input.completion),
    dupe: snapshotDupeModule(input.dupe ?? oncePerBand<TQso>()),
    scoring: snapshotScoringModule(input.scoring),
    submission: snapshotSubmissionModule(input.submission),
    operating: Object.freeze(operating),
  });
}

export type AnyFT8ContestDefinition = FT8ContestDefinition<
  unknown,
  FT8ContestQso<unknown>,
  unknown
>;

export type FT8ContestProjectionIssue =
  | 'outside_edition'
  | 'unsupported_mode'
  | 'unsupported_band'
  | 'review'
  | 'excluded'
  | 'x_qso'
  | 'dupe';

export interface FT8ContestProjectionRow<TQso> {
  qso: TQso;
  /** Backwards-friendly alias for scoreEligible. */
  eligible: boolean;
  scoreEligible: boolean;
  submissionEligible: boolean;
  dupe: boolean;
  issues: readonly FT8ContestProjectionIssue[];
}

/** Applies the common edition/mode/band/status/dupe envelope once for score and export. */
export function projectFT8ContestQsos<
  TExchange,
  TQso extends FT8ContestQso<TExchange>,
  TSubmissionOptions,
>(
  contest: FT8ContestDefinition<TExchange, TQso, TSubmissionOptions>,
  records: readonly TQso[],
): FT8ContestProjectionRow<TQso>[] {
  const start = Date.parse(contest.edition.startAt);
  const end = Date.parse(contest.edition.endAt);
  const modes = new Set(contest.modes);
  const bands = new Set(contest.bands.map((band) => band.toUpperCase()));
  const worked = new Set<string>();
  return records
    .map((qso, index) => ({ qso, index }))
    .sort((left, right) => left.qso.startTime - right.qso.startTime || left.index - right.index)
    .map(({ qso }) => {
      const issues: FT8ContestProjectionIssue[] = [];
      const band = qso.band.trim().toUpperCase();
      const baseEligible = Number.isFinite(qso.startTime)
        && qso.startTime >= start
        && qso.startTime < end
        && modes.has(qso.mode)
        && bands.has(band);
      if (!Number.isFinite(qso.startTime) || qso.startTime < start || qso.startTime >= end) {
        issues.push('outside_edition');
      }
      if (!modes.has(qso.mode)) issues.push('unsupported_mode');
      if (!bands.has(band)) issues.push('unsupported_band');
      const status = qso.status ?? 'included';
      if (status === 'review') issues.push('review');
      if (status === 'excluded') issues.push('excluded');
      if (status === 'x-qso') issues.push('x_qso');
      const key = contest.dupe.key(qso);
      const countsAsWorked = baseEligible && (status === 'included' || status === 'review');
      const dupe = countsAsWorked && worked.has(key);
      if (dupe) issues.push('dupe');
      if (countsAsWorked) worked.add(key);
      const scoreEligible = baseEligible && status === 'included' && !dupe;
      return {
        qso,
        dupe,
        issues,
        eligible: scoreEligible,
        scoreEligible,
        submissionEligible: baseEligible && (status === 'included' || status === 'x-qso'),
      };
    });
}

export function scoreFT8ContestQsos<
  TExchange,
  TQso extends FT8ContestQso<TExchange>,
  TSubmissionOptions,
>(
  contest: FT8ContestDefinition<TExchange, TQso, TSubmissionOptions>,
  records: readonly TQso[],
): ContestScoreSummary {
  const scores = projectFT8ContestQsos(contest, records)
    .filter((row) => row.scoreEligible)
    .map((row) => contest.scoring.score(row.qso));
  return contest.scoring.aggregate(scores);
}

export function formatFT8ContestSubmission<
  TExchange,
  TQso extends FT8ContestQso<TExchange>,
  TSubmissionOptions,
>(
  contest: FT8ContestDefinition<TExchange, TQso, TSubmissionOptions>,
  records: readonly TQso[],
  options: TSubmissionOptions,
): string {
  const eligible = projectFT8ContestQsos(contest, records)
    .filter((row) => row.submissionEligible)
    .map((row) => row.qso);
  return contest.submission.format(eligible, options);
}
