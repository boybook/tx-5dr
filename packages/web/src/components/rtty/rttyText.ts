/** Callsign-like token: at least one digit and one letter, optional portable prefix/suffix. */
export const RTTY_CALLSIGN_RE = /^(?:[A-Z0-9]{1,4}\/)?(?=[A-Z0-9]*[0-9])(?=[A-Z0-9]*[A-Z])[A-Z0-9]{3,7}(?:\/[A-Z0-9]{1,4})?$/;
/** Signal report or serial-like token (checked before the callsign pattern: 5NN matches both). */
export const RTTY_REPORT_RE = /^(?:[1-5][1-9N][9N]|5NN|[0-9]{1,4})$/;

/** Base callsign without portable prefix/suffix, for comparing with this station's call. */
export function baseCallsign(callsign: string): string {
  const parts = callsign.toUpperCase().split('/');
  return parts.reduce((longest, part) => (part.length > longest.length ? part : longest), '');
}

export function isRttyCallsign(word: string): boolean {
  return !RTTY_REPORT_RE.test(word) && RTTY_CALLSIGN_RE.test(word);
}

/** True when `word` is this station's own callsign (ignoring /P etc.). */
export function isOwnCallsign(word: string, myCallsign?: string): boolean {
  return Boolean(myCallsign) && baseCallsign(word) === baseCallsign(myCallsign!);
}

/** The last callsign in `text` that is not `myCallsign`, or null. */
export function lastCallsignIn(text: string, myCallsign?: string): string | null {
  const words = text.toUpperCase().split(/\s+/).filter(Boolean);
  for (let index = words.length - 1; index >= 0; index -= 1) {
    const word = words[index]!;
    if (isRttyCallsign(word) && !isOwnCallsign(word, myCallsign)) return word;
  }
  return null;
}
