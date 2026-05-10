import { describe, expect, it } from 'vitest';
import { resolveCWMessagePlaceholders } from '../cwMessagePlaceholders';

describe('CW message placeholders', () => {
  it('replaces MYCALL and HISCALL case-insensitively', () => {
    const resolved = resolveCWMessagePlaceholders(
      '{hiscall} DE {MYCALL} TU {mycall}',
      { myCall: 'bg5drb', hisCall: 'k1abc' },
    );

    expect(resolved.text).toBe('K1ABC DE BG5DRB TU BG5DRB');
    expect(resolved.unresolved).toEqual([]);
  });

  it('keeps missing HISCALL visible and marks it unresolved', () => {
    const resolved = resolveCWMessagePlaceholders(
      '{HISCALL} DE {MYCALL}',
      { myCall: 'BG5DRB' },
    );

    expect(resolved.text).toBe('{HISCALL} DE BG5DRB');
    expect(resolved.unresolved).toEqual(['HISCALL']);
    expect(resolved.segments).toContainEqual({
      type: 'placeholder',
      placeholder: 'HISCALL',
      source: '{HISCALL}',
      text: '{HISCALL}',
      resolved: false,
    });
  });

  it('leaves text without supported placeholders unchanged', () => {
    const resolved = resolveCWMessagePlaceholders('CQ TEST', {
      myCall: 'BG5DRB',
      hisCall: 'K1ABC',
    });

    expect(resolved.text).toBe('CQ TEST');
    expect(resolved.unresolved).toEqual([]);
    expect(resolved.segments).toEqual([{ type: 'text', text: 'CQ TEST' }]);
  });
});
