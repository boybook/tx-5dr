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

import { resolveDXCCEntity } from '../callsign/callsign.js';

const REGEX_META_CHARS = /[\\^$.*+?()[\]{}|]/;

export type CallsignFilterMode = 'blocklist' | 'regex-keep';
export type CallsignBandFilterRules = Record<string, string[]>;
export type CallsignBandDxccEntityCodes = Record<string, string[]>;

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

function normalizeBandKey(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function normalizeCallsignBandFilterRules(value: unknown): CallsignBandFilterRules {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const normalized: CallsignBandFilterRules = {};
  for (const [rawBand, rawEntries] of Object.entries(value)) {
    const band = normalizeBandKey(rawBand);
    if (!band) continue;
    const entries = Array.isArray(rawEntries) ? normalizeEntries(rawEntries) : [];
    if (entries.length > 0) {
      normalized[band] = entries;
    }
  }
  return normalized;
}

export function selectCallsignFilterRuleEntries(options: {
  perBandEnabled?: unknown;
  filterRules?: unknown;
  bandFilterRules?: unknown;
  band?: unknown;
}): string[] {
  if (options.perBandEnabled === true) {
    const band = normalizeBandKey(options.band);
    if (!band || band === 'unknown') {
      return [];
    }
    return normalizeCallsignBandFilterRules(options.bandFilterRules)[band] ?? [];
  }

  return Array.isArray(options.filterRules) ? normalizeEntries(options.filterRules) : [];
}


function normalizeDxccEntityCode(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^[1-9]\d*$/.test(trimmed)) return trimmed;
  }
  return undefined;
}

export function normalizeDxccEntityCodes(value: unknown): string[] {
  const rawEntries = typeof value === 'string'
    ? value.split(/\r?\n|,/)
    : Array.isArray(value)
      ? value
      : [];

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of rawEntries) {
    const code = normalizeDxccEntityCode(entry);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    normalized.push(code);
  }
  return normalized;
}

export function normalizeBandDxccEntityCodes(value: unknown): CallsignBandDxccEntityCodes {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const normalized: CallsignBandDxccEntityCodes = {};
  for (const [rawBand, rawEntries] of Object.entries(value)) {
    const band = normalizeBandKey(rawBand);
    if (!band) continue;
    const entries = normalizeDxccEntityCodes(rawEntries);
    if (entries.length > 0) {
      normalized[band] = entries;
    }
  }
  return normalized;
}

export function selectDxccBlockEntityCodes(options: {
  perBandEnabled?: unknown;
  blockedDxccEntityCodes?: unknown;
  bandBlockedDxccEntityCodes?: unknown;
  band?: unknown;
}): string[] {
  if (options.perBandEnabled === true) {
    const band = normalizeBandKey(options.band);
    if (!band || band === 'unknown') {
      return [];
    }
    return normalizeBandDxccEntityCodes(options.bandBlockedDxccEntityCodes)[band] ?? [];
  }

  return normalizeDxccEntityCodes(options.blockedDxccEntityCodes);
}

export function resolveCallsignDxccEntityCode(callsign: unknown): string | undefined {
  if (typeof callsign !== 'string' || !callsign.trim()) return undefined;
  const code = resolveDXCCEntity(callsign.trim().toUpperCase()).entity?.entityCode;
  return normalizeDxccEntityCode(code);
}

export function selectDxccEntityCodeForFilter(options: {
  dxccId?: unknown;
  callsign?: unknown;
}): string | undefined {
  return normalizeDxccEntityCode(options.dxccId)
    ?? resolveCallsignDxccEntityCode(options.callsign);
}

export function evaluateDxccBlocklist(options: {
  dxccBlockEnabled?: unknown;
  blockedDxccEntityCodes?: unknown;
  dxccId?: unknown;
  callsign?: unknown;
}): boolean {
  if (options.dxccBlockEnabled !== true) return true;

  const blockedCodes = new Set(normalizeDxccEntityCodes(options.blockedDxccEntityCodes));
  if (blockedCodes.size === 0) return true;

  const entityCode = selectDxccEntityCodeForFilter({
    dxccId: options.dxccId,
    callsign: options.callsign,
  });
  if (!entityCode) return true;

  return !blockedCodes.has(entityCode);
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
