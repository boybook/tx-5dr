import { describe, expect, it } from 'vitest';
import { decodeDeepCWOutput } from '../CWDecoderWorkerCore.js';

const EN_CLASSES = 42;
const A = 14;
const B = 15;
const SPACE = 40;
const BLANK = 41;

function logits(indices: number[]): Float32Array {
  const output = new Float32Array(indices.length * EN_CLASSES).fill(-10);
  indices.forEach((index, frame) => {
    output[frame * EN_CLASSES + index] = 0;
  });
  return output;
}

describe('decodeDeepCWOutput', () => {
  it('returns plain text and detailed spans using the DeepCW CTC rules', () => {
    const decoded = decodeDeepCWOutput(logits([A, A, BLANK, SPACE, SPACE, B, B]), [1, 7, EN_CLASSES], 'en');

    expect(decoded.text).toBe('A B');
    expect(decoded.plainText).toBe('A B');
    expect(decoded.wordSpaceSpans).toEqual([{ startFrame: 3, endFrame: 4 }]);
    expect(decoded.characterSpans).toEqual([
      { char: 'A', startFrame: 0, endFrame: 1 },
      { char: ' ', startFrame: 3, endFrame: 4 },
      { char: 'B', startFrame: 5, endFrame: 6 },
    ]);
    expect(decoded.confidence).toBe(1);
  });
});
