const CALLSIGN_RE = /\b(?:[A-Z]{1,2}\d[A-Z0-9]{1,4}|[A-Z0-9]{1,3}\d[A-Z]{1,4})\b/i;

/** First amateur callsign-shaped token in decoded text, upper-cased, or null. */
export function extractCallsign(text: string): string | null {
  const match = text.toUpperCase().match(CALLSIGN_RE);
  return match?.[0] ?? null;
}
