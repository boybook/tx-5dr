export function resampleLinear(input: Float32Array, inputRate: number, outputRate: number): Float32Array {
  if (input.length === 0 || inputRate <= 0 || outputRate <= 0) {
    return new Float32Array(0);
  }
  if (inputRate === outputRate) {
    return new Float32Array(input);
  }
  const outputLength = Math.max(1, Math.round((input.length * outputRate) / inputRate));
  const output = new Float32Array(outputLength);
  const ratio = inputRate / outputRate;
  for (let i = 0; i < outputLength; i += 1) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = input[Math.min(idx, input.length - 1)] ?? 0;
    const b = input[Math.min(idx + 1, input.length - 1)] ?? a;
    output[i] = a + (b - a) * frac;
  }
  return output;
}

export function resample12kTo9600(input: Float32Array): Float32Array {
  return resampleLinear(input, 12_000, 9_600);
}
