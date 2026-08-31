import {
  formatFT8ContestSubmission,
  scoreFT8ContestQsos,
  type FT8ContestDefinition,
} from './FT8ContestDefinition.js';
import type {
  CompletionEvidence,
  ContestExchangeFields,
  ContestScoreSummary,
  FT8ContestQso,
} from './FT8ContestModules.js';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (stableJson(actual) !== stableJson(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

/** Framework-neutral golden assertions for a composed contest definition. */
export function createFT8ContestTestKit<
  TExchange,
  TQso extends FT8ContestQso<TExchange>,
  TSubmissionOptions = void,
>(contest: FT8ContestDefinition<TExchange, TQso, TSubmissionOptions>) {
  return {
    exchange(
      fields: ContestExchangeFields,
      expected: TExchange,
      canonicalFields: ContestExchangeFields = contest.exchange.encode(expected),
    ): void {
      const decoded = contest.exchange.decode(fields);
      if (!decoded.ok) {
        throw new Error(`contest_exchange_decode_failed:${decoded.issues.map((issue) => issue.code).join(',')}`);
      }
      assertEqual(decoded.value, expected, 'contest_exchange_mismatch');
      const encoded = contest.exchange.encode(decoded.value);
      assertEqual(encoded, canonicalFields, 'contest_exchange_canonical_fields_mismatch');
      const roundTripped = contest.exchange.decode(encoded);
      if (!roundTripped.ok) {
        throw new Error(`contest_exchange_round_trip_failed:${roundTripped.issues.map((issue) => issue.code).join(',')}`);
      }
      assertEqual(roundTripped.value, expected, 'contest_exchange_round_trip_mismatch');
    },
    invalidExchange(fields: Readonly<Record<string, string>>, expectedCode: string): void {
      const decoded = contest.exchange.decode(fields);
      if (decoded.ok || !decoded.issues.some((issue) => issue.code === expectedCode)) {
        throw new Error(`contest_exchange_expected_issue:${expectedCode}`);
      }
    },
    completion(evidence: CompletionEvidence<TExchange>, expected: boolean): void {
      assertEqual(contest.completion.evaluate(evidence).complete, expected, 'contest_completion_mismatch');
    },
    dupe(first: TQso, second: TQso, expected = true): void {
      assertEqual(contest.dupe.key(first) === contest.dupe.key(second), expected, 'contest_dupe_mismatch');
    },
    score(records: readonly TQso[], expected: Partial<ContestScoreSummary>): void {
      const summary = scoreFT8ContestQsos(contest, records);
      for (const [key, value] of Object.entries(expected)) {
        assertEqual(summary[key as keyof ContestScoreSummary], value, `contest_score_${key}_mismatch`);
      }
    },
    submission(records: readonly TQso[], options: TSubmissionOptions, expected: string): void {
      assertEqual(formatFT8ContestSubmission(contest, records, options), expected, 'contest_submission_mismatch');
    },
  };
}
