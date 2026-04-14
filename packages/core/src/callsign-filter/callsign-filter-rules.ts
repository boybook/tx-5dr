/**
 * Shared callsign filter rule parsing and evaluation logic.
 *
 * Used by the callsign-filter builtin plugin (server-side candidate filtering)
 * and by the web frontend (message display filtering).
 *
 * Rule syntax (one rule per line):
 * - Plain text → exact match (case-insensitive)
 * - Contains regex metacharacters → regex match (case-insensitive)
 * - `!` prefix → exclude/negate the rule
 * - `#` prefix → comment (ignored)
 *
 * Evaluation semantics (gitignore-style with dynamic baseline):
 * - If the first active rule is an include rule → baseline is "block all" (whitelist mode)
 * - If the first active rule is an exclude rule → baseline is "allow all" (blacklist mode)
 * - Rules are evaluated in order; the last matching rule wins
 * - Empty rule list → allow all (no filtering)
 */

const REGEX_META_CHARS = /[\\^$.*+?()[\]{}|]/;

export interface CallsignFilterRule {
  /** Original input line (before normalization). */
  raw: string;
  /** Whether this is an exclude (negate) rule (prefixed with `!`). */
  isExclude: boolean;
  /** How the pattern was interpreted. */
  type: 'exact' | 'regex';
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

/**
 * Parse a list of raw string entries into compiled filter rules.
 *
 * Invalid regex patterns are silently skipped (callers should use
 * {@link validateFilterRuleLine} for user-facing validation).
 */
export function parseCallsignFilterRules(entries: string[]): CallsignFilterRule[] {
  const rules: CallsignFilterRule[] = [];

  for (const rawEntry of normalizeEntries(entries)) {
    let entry = rawEntry;
    let isExclude = false;

    if (entry.startsWith('!')) {
      isExclude = true;
      entry = entry.slice(1).trim();
      if (entry.length === 0) continue;
    }

    if (REGEX_META_CHARS.test(entry)) {
      try {
        const regex = new RegExp(entry, 'i');
        rules.push({
          raw: rawEntry,
          isExclude,
          type: 'regex',
          matches: (callsign) => regex.test(callsign),
        });
      } catch {
        // Invalid regex — skip silently during runtime
        continue;
      }
    } else {
      const normalized = entry.toUpperCase();
      rules.push({
        raw: rawEntry,
        isExclude,
        type: 'exact',
        matches: (callsign) => callsign === normalized,
      });
    }
  }

  return rules;
}

/**
 * Evaluate whether a callsign passes the filter.
 *
 * Dynamic baseline: the first rule's type determines the default outcome.
 * - First rule is include → default = block (whitelist mode)
 * - First rule is exclude → default = allow (blacklist mode)
 *
 * Rules are evaluated in order; the last matching rule determines the result.
 *
 * @param callsign - The callsign to test (will be uppercased internally).
 * @param rules - Compiled filter rules from {@link parseCallsignFilterRules}.
 * @returns `true` if the callsign is allowed, `false` if blocked.
 */
export function evaluateCallsignFilter(callsign: string, rules: CallsignFilterRule[]): boolean {
  if (rules.length === 0) return true;

  // Dynamic baseline: first exclude rule → allow all by default; first include → block all
  const defaultAllow = rules[0].isExclude;
  let result = defaultAllow;

  const upper = callsign.toUpperCase();
  for (const rule of rules) {
    if (rule.matches(upper)) {
      result = !rule.isExclude; // include → true (allow), exclude → false (block)
    }
  }

  return result;
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
): { key: string; params?: Record<string, unknown> } | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith('#')) return null;

  let pattern = trimmed;
  if (pattern.startsWith('!')) {
    pattern = pattern.slice(1).trim();
    if (pattern.length === 0) return null; // bare `!` is harmless, will be skipped
  }

  if (REGEX_META_CHARS.test(pattern)) {
    try {
      new RegExp(pattern, 'i');
    } catch {
      return {
        key: 'filterRulesInvalidRegexSyntax',
        params: { line: lineNumber },
      };
    }
  }

  return null;
}
