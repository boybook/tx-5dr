import { describe, expect, it } from 'vitest';
import { resolveFrameCallsign } from './frameCallsign';

describe('resolveFrameCallsign', () => {
  it('uses the decoded sender when logbook analysis is unavailable', () => {
    expect(resolveFrameCallsign({ message: 'CQ JA1ABC PM95' })).toBe('JA1ABC');
    expect(resolveFrameCallsign({ message: 'BG5DRB JA1ABC -10' })).toBe('JA1ABC');
  });

  it('prefers the server analysis identity when present', () => {
    expect(resolveFrameCallsign({
      message: 'CQ JA1ABC PM95',
      logbookAnalysis: { callsign: 'JA1ABC/P' },
    })).toBe('JA1ABC/P');
  });

  it('uses a known sender from a supported partial-decode format', () => {
    expect(resolveFrameCallsign({ message: '<...> JA1ABC RR73' })).toBe('JA1ABC');
    expect(resolveFrameCallsign({ message: '... E25XLD/M -11' })).toBe('E25XLD/M');
    expect(resolveFrameCallsign({ message: '<...> <SX100PAOK> 73' })).toBe('SX100PAOK');
  });

  it('does not use an unknown sender or guess a callsign from unsupported text', () => {
    expect(resolveFrameCallsign({ message: 'BG5DRB <...> RR73' })).toBeUndefined();
    expect(resolveFrameCallsign({ message: 'CQ <...> PL09' })).toBeUndefined();
    expect(resolveFrameCallsign({ message: '<...> JA1ABC RR73 EXTRA' })).toBeUndefined();
    expect(resolveFrameCallsign({ message: '<...> <THANKS> 73' })).toBeUndefined();
    expect(resolveFrameCallsign({ message: 'TNX JA1ABC 73' })).toBeUndefined();
    expect(resolveFrameCallsign({ message: 'NOT AN FT8 MESSAGE' })).toBeUndefined();
  });
});
