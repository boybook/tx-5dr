import { describe, expect, it } from 'vitest';
import { StreamingCommitHelper } from '../StreamingCommitHelper.js';

function createHelper() {
  return new StreamingCommitHelper({
    backend: 'deepcw-onnx',
    sampleRate: 9_600,
    minPendingSeconds: 2,
    minConfirmedSeconds: 2,
    tailGuardSeconds: 1.25,
    maxSegmentSeconds: 12,
  });
}

describe('StreamingCommitHelper', () => {
  it('does not choose a split point without a word-space boundary before max segment', () => {
    const helper = createHelper();
    expect(helper.getConfirmedSplitPoint([], 4 * 9_600)).toBeNull();
    expect(helper.getForcedSplitPoint(4 * 9_600, 4 * 9_600, [])).toBeNull();
  });

  it('chooses the latest stable word-space split point outside the tail guard', () => {
    const helper = createHelper();
    const split = helper.getConfirmedSplitPoint([{ startFrame: 100, endFrame: 105 }], 4 * 9_600);

    expect(split).toMatchObject({ sample: 20_064, endFrame: 105, forced: false });
  });

  it('does not split before both minimum confirmed audio and tail guard are available', () => {
    const helper = createHelper();

    expect(helper.getConfirmedSplitPoint([{ startFrame: 100, endFrame: 105 }], 3 * 9_600)).toBeNull();
  });

  it('forces a split at the analysis length when max segment is reached', () => {
    const helper = createHelper();
    const split = helper.getForcedSplitPoint(12 * 9_600, 12 * 9_600, []);

    expect(split).toEqual({ sample: 115_200, endFrame: Number.POSITIVE_INFINITY, forced: true });
  });

  it('normalizes and records committed text segments', () => {
    const helper = createHelper();
    const lane = helper.normalizeResult({
      text: 'A  B',
      plainText: 'A  B',
      confidence: 0.8,
      characterSpans: [
        { char: 'A', startFrame: 0, endFrame: 0 },
        { char: ' ', startFrame: 1, endFrame: 2 },
        { char: ' ', startFrame: 3, endFrame: 3 },
        { char: 'B', startFrame: 4, endFrame: 4 },
      ],
      wordSpaceSpans: [{ startFrame: 1, endFrame: 3 }],
    });
    const commit = helper.buildCommitEvent(lane, 123);

    expect(commit?.text).toBe('A B');
    expect(helper.getCommittedText()).toBe('A B');
  });
});
