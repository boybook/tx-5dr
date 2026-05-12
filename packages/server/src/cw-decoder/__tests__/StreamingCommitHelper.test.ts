import { describe, expect, it } from 'vitest';
import { StreamingCommitHelper, type DetailedDecodeLike } from '../StreamingCommitHelper.js';

const SAMPLE_RATE = 9_600;

function createHelper() {
  return new StreamingCommitHelper({
    backend: 'deepcw-onnx',
    sampleRate: SAMPLE_RATE,
    minPendingSeconds: 2,
    minConfirmedSeconds: 2,
    tailGuardSeconds: 1.25,
    maxSegmentSeconds: 30,
    overlapRetentionSeconds: 1.25,
    stableMinNonWhitespaceChars: 5,
    stableRepeatCount: 3,
  });
}

function resultFor(text: string, startFrame = 90): DetailedDecodeLike {
  const chars = Array.from(text);
  return {
    text,
    plainText: text,
    confidence: 0.8,
    characterSpans: chars.map((char, index) => ({
      char,
      startFrame: startFrame + index * 8,
      endFrame: startFrame + index * 8 + 1,
    })),
    wordSpaceSpans: chars.flatMap((char, index) => (char === ' '
      ? [{ startFrame: startFrame + index * 8, endFrame: startFrame + index * 8 + 1 }]
      : [])),
  };
}

describe('StreamingCommitHelper', () => {
  it('does not choose a split point without a word-space boundary before max segment', () => {
    const helper = createHelper();
    expect(helper.getConfirmedSplitPoint([], 4 * SAMPLE_RATE)).toBeNull();
    expect(helper.getForcedSplitPoint(4 * SAMPLE_RATE, 4 * SAMPLE_RATE, [])).toBeNull();
  });

  it('chooses the latest stable word-space split point outside the tail guard', () => {
    const helper = createHelper();
    const split = helper.getConfirmedSplitPoint([{ startFrame: 100, endFrame: 105 }], 4 * SAMPLE_RATE);

    expect(split).toMatchObject({ sample: 20_064, endFrame: 105, forced: false });
  });

  it('does not split before both minimum confirmed audio and tail guard are available', () => {
    const helper = createHelper();

    expect(helper.getConfirmedSplitPoint([{ startFrame: 100, endFrame: 105 }], 3 * SAMPLE_RATE)).toBeNull();
  });

  it('forces a split at the analysis length when max segment is reached', () => {
    const helper = createHelper();
    const split = helper.getForcedSplitPoint(30 * SAMPLE_RATE, 30 * SAMPLE_RATE, []);

    expect(split).toEqual({ sample: 288_000, endFrame: Number.POSITIVE_INFINITY, forced: true });
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
    const commit = helper.buildCommitEvent(lane, 123, { sessionId: 's1', sequence: 1, prependSpace: true });

    expect(commit?.text).toBe('A B');
    expect(helper.getCommittedText()).toBe('A B');
  });

  it('waits for two decodes before committing a stable prefix with enough characters', () => {
    const helper = createHelper();
    const result = resultFor('CQ TEST');

    expect(helper.evaluateDecode(result, 5 * SAMPLE_RATE, 5 * SAMPLE_RATE).decision).toBeNull();
    const second = helper.evaluateDecode(result, 5 * SAMPLE_RATE, 5 * SAMPLE_RATE);

    expect(second.decision?.lane.text).toBe('CQ TEST');
    expect(second.decision?.forced).toBe(false);
  });

  it('commits a short stable prefix after repeated identical candidates', () => {
    const helper = createHelper();
    const result = resultFor('CQ');

    expect(helper.evaluateDecode(result, 5 * SAMPLE_RATE, 5 * SAMPLE_RATE).decision).toBeNull();
    expect(helper.evaluateDecode(result, 5 * SAMPLE_RATE, 5 * SAMPLE_RATE).decision).toBeNull();
    expect(helper.evaluateDecode(result, 5 * SAMPLE_RATE, 5 * SAMPLE_RATE).decision).toBeNull();
    const fourth = helper.evaluateDecode(result, 5 * SAMPLE_RATE, 5 * SAMPLE_RATE);

    expect(fourth.decision?.lane.text).toBe('CQ');
  });

  it('forces progress at 30s and retains 1.25s overlap after commit', () => {
    const helper = createHelper();
    const evaluation = helper.evaluateDecode(resultFor(''), 30 * SAMPLE_RATE, 30 * SAMPLE_RATE);

    expect(evaluation.decision).toMatchObject({ commitSample: 30 * SAMPLE_RATE, forced: true });
    const retention = helper.acceptCommit(evaluation.decision!.commitSample);

    expect(retention.retainedOverlapSamples).toBe(12_000);
    expect(retention.dropSamples).toBe(276_000);
  });
});
