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

  it('does not turn an undecoded placeholder into an actionable target', () => {
    expect(resolveFrameCallsign({ message: '<...> BG5DRB RR73' })).toBeUndefined();
    expect(resolveFrameCallsign({ message: 'NOT AN FT8 MESSAGE' })).toBeUndefined();
  });
});
