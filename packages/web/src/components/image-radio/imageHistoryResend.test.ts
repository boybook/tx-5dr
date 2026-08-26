import { describe, expect, it } from 'vitest';

import type { ImageHistoryEntry } from '@tx5dr/contracts';

import { canResendImageHistoryEntry, historyEnvelopeSelection } from './imageHistoryResend';

function txEntry(operatorId = 'operator-a', outcome: 'transmitting' | 'completed' | 'interrupted' = 'completed'): ImageHistoryEntry {
  return {
    record: {
      id: 'history', artifactId: 'artifact', family: 'sstv', direction: 'tx', operatorId,
      sessionId: 'session', occurredAt: 1, startedAt: 1, outcome,
      envelope: {
        enhancedPreamble: false, stationIdMode: 'cw', callsign: 'BG5DRB',
        postImageGapMs: 500, endGuardMs: 300, cwWpm: 20, cwToneHz: 800,
      },
    },
    artifact: {
      id: 'artifact', family: 'sstv', direction: 'tx', operatorId, codecMode: 'robot36',
      pixelFormat: 'rgb8', width: 320, height: 240, frequency: 14_230_000,
      complete: true, truncated: false, pinned: false, contentHash: 'hash', createdAt: 1,
      imageUrl: '/image/artifact',
    },
  };
}

describe('SSTV history resend', () => {
  it('only allows a completed or interrupted transmission owned by the current operator', () => {
    expect(canResendImageHistoryEntry(txEntry(), 'operator-a')).toBe(true);
    expect(canResendImageHistoryEntry(txEntry('operator-b'), 'operator-a')).toBe(false);
    expect(canResendImageHistoryEntry(txEntry('operator-a', 'transmitting'), 'operator-a')).toBe(false);
  });

  it('reuses the historical envelope selection without trusting its callsign snapshot', () => {
    expect(historyEnvelopeSelection(txEntry(), { enhancedPreamble: true, stationIdMode: 'fsk' })).toEqual({
      enhancedPreamble: false,
      stationIdMode: 'cw',
    });

    const withoutSnapshot = txEntry();
    if (withoutSnapshot.record.direction === 'tx') withoutSnapshot.record.envelope = undefined;
    expect(historyEnvelopeSelection(withoutSnapshot, { enhancedPreamble: true, stationIdMode: 'none' })).toEqual({
      enhancedPreamble: true,
      stationIdMode: 'none',
    });
  });
});
