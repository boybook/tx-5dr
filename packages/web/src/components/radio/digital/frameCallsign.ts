import { FT8MessageParser } from '@tx5dr/core';

export interface FrameCallsignSource {
  message: string;
  logbookAnalysis?: { callsign?: string };
}

/** Resolve a strictly decoded sender; never guess an RF target from arbitrary raw tokens. */
export function resolveFrameCallsign(frame: FrameCallsignSource): string | undefined {
  const analyzedCallsign = frame.logbookAnalysis?.callsign?.trim();
  if (analyzedCallsign) return analyzedCallsign;

  try {
    const callsign = FT8MessageParser.parseDecodedSenderCallsign(frame.message)?.trim();
    return callsign || undefined;
  } catch {
    // Malformed and free-text rows are intentionally not actionable.
  }
  return undefined;
}
