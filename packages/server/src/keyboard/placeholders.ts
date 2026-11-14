import type { KeyboardPlaceholderValues } from '@tx5dr/contracts';

/**
 * Placeholder substitution shared by keyboard modes (CW, RTTY).
 *
 * Values come from the client's current QSO context. A placeholder without a
 * value fails the whole message instead of transmitting the literal token.
 */
export function replaceKeyboardPlaceholders(
  text: string,
  values: KeyboardPlaceholderValues,
  modeLabel: string,
): string {
  const unresolved = new Set<string>();
  const replaced = text.replace(/\{(MYCALL|HISCALL|TRST|RRST)\}/gi, (source, name: string) => {
    const key = name.toUpperCase();
    const value = key === 'MYCALL'
      ? values.myCall
      : key === 'HISCALL'
        ? values.hisCall
        : key === 'TRST'
          ? values.trst
          : values.rrst;
    if (!value?.trim()) {
      unresolved.add(key);
      return source;
    }
    return value.trim().toUpperCase();
  });
  if (unresolved.size > 0) {
    throw new Error(`${modeLabel} message placeholder value is missing: ${Array.from(unresolved).join(', ')}`);
  }
  return replaced;
}

export function normalizeKeyboardPlaceholderValues(
  values: KeyboardPlaceholderValues | undefined,
  fallbackMyCall?: string | null,
): KeyboardPlaceholderValues {
  const myCall = typeof values?.myCall === 'string' ? values.myCall : '';
  const hisCall = typeof values?.hisCall === 'string' ? values.hisCall : '';
  const trst = typeof values?.trst === 'string' ? values.trst : '';
  const rrst = typeof values?.rrst === 'string' ? values.rrst : '';
  return {
    myCall: (myCall || fallbackMyCall || '').trim().toUpperCase() || undefined,
    hisCall: hisCall.trim().toUpperCase() || undefined,
    trst: trst.trim().toUpperCase() || undefined,
    rrst: rrst.trim().toUpperCase() || undefined,
  };
}
