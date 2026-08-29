import { describe, expect, it } from 'vitest';
import {
  buildWWDigiCQ,
  buildWWDigi73,
  buildWWDigiGrid,
  buildWWDigiRogerGrid,
  buildWWDigiRR73,
  parseWWDigiMessage,
} from './protocol.js';

describe('WW Digi messages', () => {
  it('parses the official four-message exchange', () => {
    expect(parseWWDigiMessage('CQ WW K1ABC FN42')).toEqual({ type: 'cq', senderCallsign: 'K1ABC', grid: 'FN42' });
    expect(parseWWDigiMessage('K1ABC S52XYZ JN76')).toEqual({
      type: 'grid', targetCallsign: 'K1ABC', senderCallsign: 'S52XYZ', grid: 'JN76',
    });
    expect(parseWWDigiMessage('S52XYZ K1ABC R FN42')).toEqual({
      type: 'roger-grid', targetCallsign: 'S52XYZ', senderCallsign: 'K1ABC', grid: 'FN42',
    });
    expect(parseWWDigiMessage('K1ABC S52XYZ RR73')).toEqual({
      type: 'rr73', targetCallsign: 'K1ABC', senderCallsign: 'S52XYZ',
    });
  });

  it('generates canonical messages', () => {
    expect(buildWWDigiCQ('k1abc', 'fn42aa')).toBe('CQ WW K1ABC FN42');
    expect(buildWWDigiGrid('s52xyz', 'k1abc', 'fn42aa')).toBe('S52XYZ K1ABC FN42');
    expect(buildWWDigiRogerGrid('s52xyz', 'k1abc', 'fn42aa')).toBe('S52XYZ K1ABC R FN42');
    expect(buildWWDigiRR73('s52xyz', 'k1abc')).toBe('S52XYZ K1ABC RR73');
    expect(buildWWDigi73('s52xyz', 'k1abc')).toBe('S52XYZ K1ABC 73');
  });
});
