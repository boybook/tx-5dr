import { describe, expect, it } from 'vitest';
import type { ScoredCandidate } from '@tx5dr/plugin-api';
import { createMockContext, createMockParsedMessage } from '@tx5dr/plugin-api/testing';
import { snrFilterPlugin } from './index.js';

describe('snr-filter hooks', () => {
  it('filters candidates below the configured minimum SNR', () => {
    const candidates = [
      createMockParsedMessage({ rawMessage: 'CQ ABOVE FN31', snr: -8 }),
      createMockParsedMessage({ rawMessage: 'CQ WEAK FN31', snr: -18 }),
    ];
    const ctx = createMockContext({ config: { minSNR: -10 } });

    const filtered = snrFilterPlugin.hooks?.onFilterCandidates?.(candidates, ctx) as typeof candidates;

    expect(filtered).toHaveLength(1);
    expect(filtered?.[0]?.rawMessage).toBe('CQ ABOVE FN31');
  });

  it('gives higher SNR candidates higher scores when SNR-priority is enabled', () => {
    const candidates: ScoredCandidate[] = [
      { ...createMockParsedMessage({ rawMessage: 'CQ WEAK FN31', snr: -16 }), score: 0 },
      { ...createMockParsedMessage({ rawMessage: 'CQ HIGHER FN31', snr: -3 }), score: 0 },
    ];
    const ctx = createMockContext({ config: { prioritizeHigherSNR: true } });

    const scored = snrFilterPlugin.hooks?.onScoreCandidates?.(candidates, ctx) as ScoredCandidate[];

    expect(scored[1].score).toBeGreaterThan(scored[0].score);
  });

  it('leaves scores unchanged when SNR-priority is disabled', () => {
    const candidates: ScoredCandidate[] = [
      { ...createMockParsedMessage({ rawMessage: 'CQ WEAK FN31', snr: -16 }), score: 10 },
      { ...createMockParsedMessage({ rawMessage: 'CQ HIGHER FN31', snr: -3 }), score: 20 },
    ];
    const ctx = createMockContext({ config: { prioritizeHigherSNR: false } });

    const scored = snrFilterPlugin.hooks?.onScoreCandidates?.(candidates, ctx) as ScoredCandidate[];

    expect(scored.map((candidate) => candidate.score)).toEqual([10, 20]);
  });
});
