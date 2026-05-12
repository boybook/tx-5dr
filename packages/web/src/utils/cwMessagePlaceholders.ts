export type CWPlaceholderName = 'MYCALL' | 'HISCALL' | 'TRST' | 'RRST';

export interface CWPlaceholderValues {
  myCall?: string;
  hisCall?: string;
  trst?: string;
  rrst?: string;
}

export type CWMessageSegment =
  | { type: 'text'; text: string }
  | {
      type: 'placeholder';
      placeholder: CWPlaceholderName;
      source: string;
      text: string;
      resolved: boolean;
    };

export interface ResolvedCWMessage {
  text: string;
  segments: CWMessageSegment[];
  unresolved: CWPlaceholderName[];
}

const PLACEHOLDER_PATTERN = /\{(MYCALL|HISCALL|TRST|RRST)\}/gi;

function normalizeCallsign(value: string | undefined): string {
  return value?.trim().toUpperCase() ?? '';
}

function normalizeRst(value: string | undefined): string {
  return value?.trim().toUpperCase() ?? '';
}

function resolvePlaceholder(name: CWPlaceholderName, values: CWPlaceholderValues): string {
  switch (name) {
    case 'MYCALL':
      return normalizeCallsign(values.myCall);
    case 'HISCALL':
      return normalizeCallsign(values.hisCall);
    case 'TRST':
      return normalizeRst(values.trst);
    case 'RRST':
      return normalizeRst(values.rrst);
    default:
      return '';
  }
}

export function resolveCWMessagePlaceholders(
  text: string,
  values: CWPlaceholderValues,
): ResolvedCWMessage {
  const segments: CWMessageSegment[] = [];
  const unresolved = new Set<CWPlaceholderName>();
  let output = '';
  let lastIndex = 0;

  for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      const plain = text.slice(lastIndex, index);
      segments.push({ type: 'text', text: plain });
      output += plain;
    }

    const placeholder = match[1].toUpperCase() as CWPlaceholderName;
    const source = match[0];
    const resolvedText = resolvePlaceholder(placeholder, values);
    const resolved = resolvedText.length > 0;

    if (!resolved) {
      unresolved.add(placeholder);
    }

    segments.push({
      type: 'placeholder',
      placeholder,
      source,
      text: resolved ? resolvedText : source,
      resolved,
    });
    output += resolved ? resolvedText : source;
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
