export interface CTCDecodeResult {
  text: string;
  confidence: number;
}

export const DEFAULT_CW_ALPHABET = ['-', ' ', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/?.='.split('')];

export function decodeCTCGreedy(probabilities: number[][], alphabet = DEFAULT_CW_ALPHABET): CTCDecodeResult {
  const blankIndex = 0;
  const tokens: string[] = [];
  let previous = blankIndex;
  let confidenceSum = 0;
  let frames = 0;

  for (const frame of probabilities) {
    let bestIndex = 0;
    let bestValue = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < frame.length; i += 1) {
      const value = frame[i] ?? Number.NEGATIVE_INFINITY;
      if (value > bestValue) {
        bestValue = value;
        bestIndex = i;
      }
    }
    frames += 1;
    confidenceSum += Number.isFinite(bestValue) ? bestValue : 0;
    if (bestIndex !== blankIndex && bestIndex !== previous) {
      tokens.push(alphabet[bestIndex] ?? '');
    }
    previous = bestIndex;
  }

  return {
    text: tokens.join('').replace(/\s+/g, ' ').trim(),
    confidence: frames > 0 ? Math.max(0, Math.min(1, confidenceSum / frames)) : 0,
  };
}
