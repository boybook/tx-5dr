export type TxAudioEnvelopeProfile = 'ft8-ft4';

export interface TxAudioEnvelopePolicy {
  profile: TxAudioEnvelopeProfile;
  attackMs: number;
  releaseMs: number;
  maxStopDelayMs: number;
}

export const FT8_FT4_TX_ENVELOPE_POLICY: TxAudioEnvelopePolicy = {
  profile: 'ft8-ft4',
  attackMs: 10,
  releaseMs: 10,
  maxStopDelayMs: 10,
};

function raisedCosineUp(index: number, length: number): number {
  if (length <= 1) return 0;
  const phase = index / (length - 1);
  return Math.max(0, Math.min(1, 0.5 - (0.5 * Math.cos(Math.PI * phase))));
}

function raisedCosineDown(index: number, length: number): number {
  if (length <= 1) return 0;
  const phase = index / (length - 1);
  return Math.max(0, Math.min(1, 0.5 + (0.5 * Math.cos(Math.PI * phase))));
}

/** Applies a non-overlapping raised-cosine attack and release to a clip. */
export function applyTxAudioEnvelope(
  samples: Float32Array,
  sampleRate: number,
  policy: TxAudioEnvelopePolicy,
): Float32Array {
  if (samples.length === 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    return new Float32Array(samples);
  }

  const requestedAttack = Math.max(0, Math.round((policy.attackMs / 1_000) * sampleRate));
  const requestedRelease = Math.max(0, Math.round((policy.releaseMs / 1_000) * sampleRate));
  let attackSamples = Math.min(samples.length, requestedAttack);
  let releaseSamples = Math.min(samples.length, requestedRelease);
  if (attackSamples + releaseSamples > samples.length) {
    attackSamples = Math.floor(samples.length / 2);
    releaseSamples = samples.length - attackSamples;
  }

  const output = new Float32Array(samples);
  for (let index = 0; index < attackSamples; index += 1) {
    output[index] = samples[index]! * raisedCosineUp(index, attackSamples);
  }
  for (let index = 0; index < releaseSamples; index += 1) {
    const outputIndex = samples.length - releaseSamples + index;
    output[outputIndex] = samples[outputIndex]! * raisedCosineDown(index, releaseSamples);
  }
  return output;
}

/** Creates a bounded release tail from the last submitted sample. */
export function createTxAudioReleaseTail(
  lastSample: number,
  sampleRate: number,
  policy: TxAudioEnvelopePolicy,
): Float32Array {
  const sampleCount = Math.max(0, Math.round((policy.releaseMs / 1_000) * sampleRate));
  const output = new Float32Array(sampleCount);
  if (sampleCount === 0) return output;
  const limit = Math.abs(lastSample);
  const sign = lastSample < 0 ? -1 : 1;
  for (let index = 0; index < sampleCount; index += 1) {
    output[index] = sign * Math.min(limit, limit * raisedCosineDown(index, sampleCount));
  }
  return output;
}
