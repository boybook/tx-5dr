import { describe, expect, it } from 'vitest';
import {
  EMPTY_CW_DECODER_TRANSCRIPT,
  cwDecoderTranscriptReducer,
  deriveCWDecoderConfirmedText,
  type CWDecoderTranscriptSegment,
} from '../cwDecoderTranscript';

function segment(overrides: Partial<CWDecoderTranscriptSegment> = {}): CWDecoderTranscriptSegment {
  return {
    id: 'seg-1',
    sessionId: 'session-1',
    sequence: 1,
    text: 'CQ',
    finalized: true,
    prependSpace: true,
    updatedAt: 1,
    ...overrides,
  };
}

describe('cwDecoderTranscriptReducer', () => {
  it('resets session state and ignores stale sessions', () => {
    const reset = cwDecoderTranscriptReducer(EMPTY_CW_DECODER_TRANSCRIPT, {
      type: 'reset',
      sessionId: 'session-1',
      timestamp: 1,
    });
    const stale = cwDecoderTranscriptReducer(reset, {
      type: 'commit',
      segment: segment({ sessionId: 'session-2', id: 'seg-stale' }),
    });

    expect(reset).toMatchObject({ sessionId: 'session-1', segments: [], pending: null });
    expect(stale.segments).toHaveLength(0);
  });

  it('replaces pending in place and ignores older versions', () => {
    const reset = cwDecoderTranscriptReducer(EMPTY_CW_DECODER_TRANSCRIPT, { type: 'reset', sessionId: 'session-1' });
    const first = cwDecoderTranscriptReducer(reset, {
      type: 'pending',
      pending: { sessionId: 'session-1', version: 2, text: 'CQ T', finalized: false, updatedAt: 2 },
    });
    const stale = cwDecoderTranscriptReducer(first, {
      type: 'pending',
      pending: { sessionId: 'session-1', version: 1, text: 'OLD', finalized: false, updatedAt: 1 },
    });
    const next = cwDecoderTranscriptReducer(stale, {
      type: 'pending',
      pending: { sessionId: 'session-1', version: 3, text: 'CQ TEST', finalized: false, updatedAt: 3 },
    });

    expect(stale.pending?.text).toBe('CQ T');
    expect(next.pending?.text).toBe('CQ TEST');
  });

  it('appends a commit once and clears pending', () => {
    const withPending = cwDecoderTranscriptReducer(
      cwDecoderTranscriptReducer(EMPTY_CW_DECODER_TRANSCRIPT, { type: 'reset', sessionId: 'session-1' }),
      { type: 'pending', pending: { sessionId: 'session-1', version: 1, text: 'CQ', finalized: false, updatedAt: 1 } },
    );
    const committed = cwDecoderTranscriptReducer(withPending, { type: 'commit', segment: segment() });
    const duplicate = cwDecoderTranscriptReducer(committed, { type: 'commit', segment: segment() });

    expect(committed.pending).toBeNull();
    expect(committed.segments.map(item => item.text)).toEqual(['CQ']);
    expect(duplicate.segments).toHaveLength(1);
  });

  it('derives confirmed text respecting prependSpace', () => {
    expect(deriveCWDecoderConfirmedText([
      segment({ id: 'seg-1', sequence: 1, text: 'CQ', prependSpace: true }),
      segment({ id: 'seg-2', sequence: 2, text: 'TEST', prependSpace: true }),
      segment({ id: 'seg-3', sequence: 3, text: 'ING', prependSpace: false }),
    ])).toBe('CQ TESTING');
  });

  it('maps legacy pending and commit events as a fallback', () => {
    const pending = cwDecoderTranscriptReducer(EMPTY_CW_DECODER_TRANSCRIPT, {
      type: 'legacy_pending',
      text: 'CQ T',
      timestamp: 1,
    });
    const committed = cwDecoderTranscriptReducer(pending, {
      type: 'legacy_commit',
      text: 'CQ TEST',
      timestamp: 2,
    });

    expect(pending.pending?.text).toBe('CQ T');
    expect(committed.pending).toBeNull();
    expect(deriveCWDecoderConfirmedText(committed.segments)).toBe('CQ TEST');
  });

  it('ignores legacy fallback events once a structured session is active', () => {
    const structured = cwDecoderTranscriptReducer(EMPTY_CW_DECODER_TRANSCRIPT, {
      type: 'reset',
      sessionId: 'session-1',
      timestamp: 1,
    });
    const afterLegacyPending = cwDecoderTranscriptReducer(structured, {
      type: 'legacy_pending',
      text: 'OLD',
      timestamp: 2,
    });
    const afterLegacyCommit = cwDecoderTranscriptReducer(afterLegacyPending, {
      type: 'legacy_commit',
      text: 'OLD',
      timestamp: 3,
    });

    expect(afterLegacyPending.pending).toBeNull();
    expect(afterLegacyCommit.segments).toHaveLength(0);
  });
});
