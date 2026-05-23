import { describe, expect, it } from 'vitest';
import { createMockContext } from '@tx5dr/plugin-api/testing';
import { watchedCallsignAutocallTestables } from './index.js';

describe('watched-callsign-autocall', () => {
  it('reports auto-call enabled only when watch list has active entries', () => {
    expect(watchedCallsignAutocallTestables.isWatchedCallsignAutoCallEnabled(createMockContext({
      config: { watchList: ['JA1AAA'] },
    }))).toBe(true);
    expect(watchedCallsignAutocallTestables.isWatchedCallsignAutoCallEnabled(createMockContext({
      config: { watchList: ['  ', '# JA1AAA'] },
    }))).toBe(false);
  });
});
