/**
 * QSOs this client is logging or saving itself (and confirms with its own
 * toast). The server echoes every logged QSO as a toast to all clients; the
 * QSO toast aggregator drops the echo for these so it is not shown twice,
 * neither directly nor in a later "while in the background" summary.
 */

/** How long a local log mark suppresses the matching server toast. */
export const LOCAL_QSO_TOAST_SUPPRESS_MS = 15_000;

/** Callsign → time this client logged or saved a QSO for it. */
const marks = new Map<string, number>();

function normalize(callsign: string): string {
  return callsign.trim().toUpperCase();
}

/** Records that this client is about to log or save a QSO with `callsign`. */
export function noteLocallyLoggedQso(callsign: string): void {
  const key = normalize(callsign);
  if (!key) return;
  const now = Date.now();
  for (const [entry, at] of marks) {
    if (now - at > LOCAL_QSO_TOAST_SUPPRESS_MS) marks.delete(entry);
  }
  marks.set(key, now);
}

/** Consumes a recent local mark for `callsign`; true when the server toast should be dropped. */
export function consumeLocallyLoggedQso(callsign: string): boolean {
  const key = normalize(callsign);
  const at = key ? marks.get(key) : undefined;
  if (at === undefined) return false;
  marks.delete(key);
  return Date.now() - at <= LOCAL_QSO_TOAST_SUPPRESS_MS;
}

export function resetLocallyLoggedQsosForTests(): void {
  marks.clear();
}
