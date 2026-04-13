/**
 * Callsign normalization utilities
 *
 * Strips portable/mobile suffixes (e.g. BG3YZA/P → BG3YZA) so that
 * logbook access checks match the base callsign regardless of suffix.
 */

/**
 * Extract the base callsign by removing prefixes/suffixes.
 * Picks the longest segment that looks like a callsign (contains both
 * letters and digits).  Examples:
 *   "BG3YZA"     → "BG3YZA"
 *   "BG3YZA/P"   → "BG3YZA"
 *   "VK9/BG3YZA" → "BG3YZA"
 *   "BG3YZA/QRP" → "BG3YZA"
 */
export function normalizeCallsign(callsign: string): string {
  const upper = callsign.toUpperCase().trim();
  if (!upper.includes('/')) return upper;
  const parts = upper.split('/');
  let best = parts[0];
  for (const part of parts) {
    if (part.length > best.length && /[A-Z]/.test(part) && /\d/.test(part)) {
      best = part;
    }
  }
  return best;
}
