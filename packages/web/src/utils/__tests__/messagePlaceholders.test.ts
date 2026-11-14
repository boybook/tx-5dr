import { describe, expect, it } from 'vitest';
import { resolveMessagePlaceholders } from '../messagePlaceholders';

describe('resolveMessagePlaceholders', () => {
  it('treats control tokens as neutral segments kept verbatim', () => {
    const resolved = resolveMessagePlaceholders('{hiscall} TU {rx}', { hisCall: 'k1abc' }, { controlTokens: ['RX'] });
    expect(resolved.text).toBe('K1ABC TU {rx}');
    expect(resolved.unresolved).toEqual([]);
    expect(resolved.segments).toContainEqual({ type: 'control', token: 'RX', source: '{rx}', text: '{rx}' });
  });

  it('leaves undeclared tokens as plain text', () => {
    const resolved = resolveMessagePlaceholders('TU {RX}', {});
    expect(resolved.segments).toEqual([{ type: 'text', text: 'TU {RX}' }]);
  });

  it('still reports missing placeholders next to control tokens', () => {
    const resolved = resolveMessagePlaceholders('{TRST} {RX}', {}, { controlTokens: ['RX'] });
    expect(resolved.unresolved).toEqual(['TRST']);
  });
});
