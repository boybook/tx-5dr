import type { KeyboardPlaceholderValues } from '@tx5dr/contracts';

/**
 * Placeholder resolution for keyboard-mode message text (CW, RTTY).
 *
 * `{MYCALL}`, `{HISCALL}`, `{TRST}` and `{RRST}` are replaced from the current
 * UI context. A mode may also declare control tokens (for example RTTY `{RX}`)
 * that the server interprets; they are kept verbatim in the resolved text and
 * never count as unresolved.
 */

export type MessagePlaceholderName = 'MYCALL' | 'HISCALL' | 'TRST' | 'RRST';

export const MESSAGE_PLACEHOLDER_NAMES: readonly MessagePlaceholderName[] = ['MYCALL', 'HISCALL', 'TRST', 'RRST'];

export type MessagePlaceholderValues = KeyboardPlaceholderValues;

export type MessageSegment =
  | { type: 'text'; text: string }
  | {
      type: 'placeholder';
      placeholder: MessagePlaceholderName;
      source: string;
      text: string;
      resolved: boolean;
    }
  | {
      type: 'control';
      /** Upper-case token name without braces, e.g. `RX`. */
      token: string;
      source: string;
      text: string;
    };

export interface ResolvedMessage {
  text: string;
  segments: MessageSegment[];
  unresolved: MessagePlaceholderName[];
}

export interface ResolveMessagePlaceholdersOptions {
  /** Control token names (without braces) kept verbatim, e.g. `['RX']`. */
  controlTokens?: readonly string[];
}

function normalizeValue(value: string | undefined): string {
  return value?.trim().toUpperCase() ?? '';
}

function resolvePlaceholder(name: MessagePlaceholderName, values: MessagePlaceholderValues): string {
  switch (name) {
    case 'MYCALL':
      return normalizeValue(values.myCall);
    case 'HISCALL':
      return normalizeValue(values.hisCall);
    case 'TRST':
      return normalizeValue(values.trst);
    case 'RRST':
      return normalizeValue(values.rrst);
    default:
      return '';
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const patternCache = new Map<string, RegExp>();

function getPattern(controlTokens: readonly string[]): RegExp {
  const normalized = controlTokens.map(token => token.trim().toUpperCase()).filter(Boolean);
  const cacheKey = normalized.join('|');
  const cached = patternCache.get(cacheKey);
  if (cached) return cached;
  const names = [...MESSAGE_PLACEHOLDER_NAMES, ...normalized.map(escapeRegExp)];
  const pattern = new RegExp(`\\{(${names.join('|')})\\}`, 'gi');
  patternCache.set(cacheKey, pattern);
  return pattern;
}

function isPlaceholderName(value: string): value is MessagePlaceholderName {
  return (MESSAGE_PLACEHOLDER_NAMES as readonly string[]).includes(value);
}

export function resolveMessagePlaceholders(
  text: string,
  values: MessagePlaceholderValues,
  options: ResolveMessagePlaceholdersOptions = {},
): ResolvedMessage {
  const segments: MessageSegment[] = [];
  const unresolved = new Set<MessagePlaceholderName>();
  let output = '';
  let lastIndex = 0;

  for (const match of text.matchAll(getPattern(options.controlTokens ?? []))) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      const plain = text.slice(lastIndex, index);
      segments.push({ type: 'text', text: plain });
      output += plain;
    }

    const name = match[1].toUpperCase();
    const source = match[0];

    if (isPlaceholderName(name)) {
      const resolvedText = resolvePlaceholder(name, values);
      const resolved = resolvedText.length > 0;
      if (!resolved) {
        unresolved.add(name);
      }
      segments.push({
        type: 'placeholder',
        placeholder: name,
        source,
        text: resolved ? resolvedText : source,
        resolved,
      });
      output += resolved ? resolvedText : source;
    } else {
      segments.push({ type: 'control', token: name, source, text: source });
      output += source;
    }
    lastIndex = index + source.length;
  }

  if (lastIndex < text.length) {
    const tail = text.slice(lastIndex);
    segments.push({ type: 'text', text: tail });
    output += tail;
  }

  return {
    text: output,
    segments: segments.length > 0 ? segments : [{ type: 'text', text }],
    unresolved: Array.from(unresolved),
  };
}
