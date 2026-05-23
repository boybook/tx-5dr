import { describe, expect, it } from 'vitest';
import { createMockContext } from '@tx5dr/plugin-api/testing';
import { watchedNoveltyAutocallTestables } from './index.js';

describe('watched-novelty-autocall', () => {
  it('reports auto-call enabled when any novelty watcher is enabled', () => {
    expect(watchedNoveltyAutocallTestables.isWatchedNoveltyAutoCallEnabled(createMockContext({
      config: { watchNewDxcc: true },
    }))).toBe(true);
    expect(watchedNoveltyAutocallTestables.isWatchedNoveltyAutoCallEnabled(createMockContext({
      config: { watchNewGrid: true },
    }))).toBe(true);
    expect(watchedNoveltyAutocallTestables.isWatchedNoveltyAutoCallEnabled(createMockContext({
      config: { watchNewCallsign: true },
    }))).toBe(true);
    expect(watchedNoveltyAutocallTestables.isWatchedNoveltyAutoCallEnabled(createMockContext({
      config: { watchNewDxcc: false, watchNewGrid: false, watchNewCallsign: false },
    }))).toBe(false);
  });
});
