export type TextMatchMode = 'exact' | 'prefix' | 'fuzzy' | 'regex';

export interface TextMatchRule {
  raw: string;
  mode: TextMatchMode;
  matches(value: string): boolean;
}

export interface TextMatchResult {
  rule: TextMatchRule;
}

export interface TextMatchValidationIssue {
  key: string;
  params?: Record<string, unknown>;
}

export interface CompileTextMatchRulesOptions {
  normalize?: (value: string) => string;
  onInvalidRegex?: (entry: string, error: unknown) => void;
}

export interface ValidateTextMatchRuleLineOptions {
  issueKey?: string;
}

const DEFAULT_REGEX_ISSUE_KEY = 'matchRulesInvalidRegexSyntax';

export function normalizeTextMatchEntries(value: unknown): string[] {
  const entries = typeof value === 'string'
    ? value.split(/\r?\n|,/)
    : Array.isArray(value)
      ? value
      : [];

  return entries
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0 && !entry.startsWith('#'));
}

export function normalizeTextMatchMode(value: unknown): TextMatchMode {
  if (value === 'prefix' || value === 'fuzzy' || value === 'regex') {
    return value;
  }
  return 'exact';
}

function defaultNormalize(value: string): string {
  return value.trim().toUpperCase();
}

function compileOneRule(
  raw: string,
  mode: TextMatchMode,
  normalize: (value: string) => string,
): TextMatchRule {
  if (mode === 'regex') {
    const regex = new RegExp(raw, 'i');
    return {
      raw,
      mode,
      matches: (value) => regex.test(normalize(value)),
    };
  }

  const normalizedRule = normalize(raw);
  return {
    raw,
    mode,
    matches: (value) => {
      const normalizedValue = normalize(value);
      if (mode === 'prefix') {
        return normalizedValue.startsWith(normalizedRule);
      }
      if (mode === 'fuzzy') {
        return normalizedValue.includes(normalizedRule);
      }
      return normalizedValue === normalizedRule;
    },
  };
}

export function compileTextMatchRules(
  entries: unknown,
  mode: TextMatchMode,
  options: CompileTextMatchRulesOptions = {},
): TextMatchRule[] {
  const normalizedMode = normalizeTextMatchMode(mode);
  const normalize = options.normalize ?? defaultNormalize;
  const rules: TextMatchRule[] = [];

  for (const rawEntry of normalizeTextMatchEntries(entries)) {
    try {
      rules.push(compileOneRule(rawEntry, normalizedMode, normalize));
    } catch (error) {
      if (normalizedMode === 'regex') {
        options.onInvalidRegex?.(rawEntry, error);
      }
    }
  }

  return rules;
}

export function compileLegacyAutoRegexTextMatchRules(
  entries: unknown,
  literalMode: Extract<TextMatchMode, 'exact' | 'prefix'>,
  options: CompileTextMatchRulesOptions = {},
): TextMatchRule[] {
  const normalize = options.normalize ?? defaultNormalize;
  const rules: TextMatchRule[] = [];

  for (const rawEntry of normalizeTextMatchEntries(entries)) {
    const mode: TextMatchMode = looksLikeRegexTextMatchRule(rawEntry) ? 'regex' : literalMode;
    try {
      rules.push(compileOneRule(rawEntry, mode, normalize));
    } catch (error) {
      if (mode === 'regex') {
        options.onInvalidRegex?.(rawEntry, error);
      }
    }
  }

  return rules;
}

export function matchTextValue(value: string, rules: TextMatchRule[]): TextMatchResult | null {
  for (const rule of rules) {
    if (rule.matches(value)) {
      return { rule };
    }
  }
  return null;
}

export function looksLikeRegexTextMatchRule(entry: string): boolean {
  return /[\\^$.*+?()[\]{}|]/.test(entry);
}

export function validateTextMatchRuleLine(
  line: string,
  lineNumber: number,
  mode: TextMatchMode,
  options: ValidateTextMatchRuleLineOptions = {},
): TextMatchValidationIssue | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith('#')) {
    return null;
  }

  if (normalizeTextMatchMode(mode) !== 'regex') {
    return null;
  }

  try {
    new RegExp(trimmed, 'i');
    return null;
  } catch {
    return {
      key: options.issueKey ?? DEFAULT_REGEX_ISSUE_KEY,
      params: { line: lineNumber },
    };
  }
}

export function validateLegacyAutoRegexTextMatchRuleLine(
  line: string,
  lineNumber: number,
  options: ValidateTextMatchRuleLineOptions = {},
): TextMatchValidationIssue | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith('#') || !looksLikeRegexTextMatchRule(trimmed)) {
    return null;
  }

  try {
    new RegExp(trimmed, 'i');
    return null;
  } catch {
    return {
      key: options.issueKey ?? DEFAULT_REGEX_ISSUE_KEY,
      params: { line: lineNumber },
    };
  }
}
