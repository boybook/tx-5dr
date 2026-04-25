/**
 * Shared callsign filter rule parsing and evaluation logic.
 *
 * Used by the callsign-filter builtin plugin (server-side candidate filtering)
 * and by the web frontend (message display filtering).
 *
 * Modes:
 * - `blocklist`: each non-comment line is a callsign or prefix to filter out.
 * - `regex-keep`: each non-comment line is a regular expression for callsigns
 *   to keep; non-matching callsigns are filtered out.
 *
 * Empty rule list always allows all callsigns (filter disabled).
 */

const REGEX_META_CHARS = /[\\^$.*+?()[\]{}|]/;

export type CallsignFilterMode = 'blocklist' | 'regex-keep';

export interface CallsignFilterRule {
  /** Original input line (before normalization). */
  raw: string;
  /** Active product mode for this compiled rule set. */
  mode: CallsignFilterMode;
  /** How the pattern was interpreted. */
  type: 'prefix' | 'regex';
  /** Returns true if the given uppercase callsign matches this rule's pattern. */
  matches: (callsign: string) => boolean;
}

/**
 * Normalize raw entries: trim whitespace, drop empty lines and `#` comments.
 */
function normalizeEntries(rawEntries: unknown[]): string[] {
  return rawEntries
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0 && !entry.startsWith('#'));
}

export function normalizeCallsignFilterMode(value: unknown): CallsignFilterMode {
  return value === 'regex-keep' ? 'regex-keep' : 'blocklist';
}

/**
 * Parse a list of raw string entries into compiled filter rules.
 *
 * Invalid regex patterns are silently skipped at runtime. Callers should use
 * {@link validateFilterRuleLine} for user-facing validation.
 */
export function parseCallsignFilterRules(
  entries: string[],
  mode: CallsignFilterMode = 'blocklist',
): CallsignFilterRule[] {
  const normalizedMode = normalizeCallsignFilterMode(mode);
  const rules: CallsignFilterRule[] = [];

  for (const rawEntry of normalizeEntries(entries)) {
    if (normalizedMode === 'regex-keep') {
      try {
        const regex = new RegExp(rawEntry, 'i');
        rules.push({
          raw: rawEntry,
          mode: normalizedMode,
          type: 'regex',
          matches: (callsign) => regex.test(callsign),
        });
      } catch {
        continue;
      }
      continue;
    }

    const normalizedPrefix = rawEntry.toUpperCase();
    rules.push({
      raw: rawEntry,
      mode: normalizedMode,
      type: 'prefix',
      matches: (callsign) => callsign.startsWith(normalizedPrefix),
    });
  }

  return rules;
}

/**
 * Evaluate whether a callsign passes the filter.
 *
 * - `blocklist`: matching a callsign/prefix blocks the callsign.
 * - `regex-keep`: matching any regex keeps the callsign; non-matches are blocked.
 * - Empty rule list: allow all (filter disabled).
 *
 * @param callsign - The callsign to test (will be uppercased internally).
 * @param rules - Compiled filter rules from {@link parseCallsignFilterRules}.
 * @returns `true` if the callsign is allowed, `false` if blocked.
 */
export function evaluateCallsignFilter(callsign: string, rules: CallsignFilterRule[]): boolean {
  if (rules.length === 0) return true;

  const upper = callsign.toUpperCase();
  const mode = normalizeCallsignFilterMode(rules[0]?.mode);
  const matched = rules.some((rule) => rule.matches(upper));

  return mode === 'regex-keep' ? matched : !matched;
}

/**
 * Validate a single filter rule line for user-facing feedback.
 *
 * @returns An object with a translation key and optional params if the line is
 *          invalid, or `null` if the line is valid.
 */
export function validateFilterRuleLine(
  line: string,
  lineNumber: number,
  mode: CallsignFilterMode = 'blocklist',
): { key: string; params?: Record<string, unknown> } | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith('#')) return null;

  // In the simple blocklist mode, entries are literal callsign prefixes. Keep a
  // light regex-looking check for legacy drafts so obvious mistakes still show.
  const shouldValidateAsRegex = normalizeCallsignFilterMode(mode) === 'regex-keep'
    || REGEX_META_CHARS.test(trimmed);

  if (shouldValidateAsRegex) {
    try {
      new RegExp(trimmed, 'i');
    } catch {
      return {
        key: 'filterRulesInvalidRegexSyntax',
        params: { line: lineNumber },
      };
    }
  }

  return null;
}
