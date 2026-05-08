const CALLSIGN_WHITESPACE_REGEX = /\s+/g;

export function sanitizeCallsignInput(callsign?: string | null): string {
  if (!callsign) {
    return '';
  }

  return callsign.toUpperCase().replace(CALLSIGN_WHITESPACE_REGEX, '');
}
