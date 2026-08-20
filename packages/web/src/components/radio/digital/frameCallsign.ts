import { FT8MessageParser } from '@tx5dr/core';

export interface FrameCallsignSource {
  message: string;
  logbookAnalysis?: { callsign?: string };
}

/** Resolve only a structured sender; never guess an RF target from raw tokens. */
export function resolveFrameCallsign(frame: FrameCallsignSource): string | undefined {
  const analyzedCallsign = frame.logbookAnalysis?.callsign?.trim();
  if (analyzedCallsign) return analyzedCallsign;

  try {
    const parsed = FT8MessageParser.parseMessage(frame.message);
    if (parsed && 'senderCallsign' in parsed && typeof parsed.senderCallsign === 'string') {
      const callsign = parsed.senderCallsign.trim();
      return callsign || undefined;
    }
  } catch {
    // Malformed and free-text rows are intentionally not actionable.
  }
  return undefined;
}
