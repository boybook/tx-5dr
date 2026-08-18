/**
 * Software SSB demodulator for Icom ACC/USB Output Select = IF.
 *
 * Icom USB IF is a real-valued ~12 kHz IF carried in PCM (typically 48 kHz).
 * We mix to baseband with a quadrature LO, low-pass filter I/Q, and form USB/LSB
 * AF without a hard AGC (peak soft-limit only) so strong in-band signals do not
 * suppress weaker ones the way radio AF AGC would.
 */

export type IfSideband = 'usb' | 'lsb';

export interface IcomIfSsbDemodulatorOptions {
  centerHz?: number;
  sideband?: IfSideband;
  /** Baseband low-pass cutoff in Hz (SSB AF width). */
  cutoffHz?: number;
}

type BiquadState = { x1: number; x2: number; y1: number; y2: number };
type BiquadCoeffs = { b0: number; b1: number; b2: number; a1: number; a2: number };

const DEFAULT_CENTER_HZ = 12000;
const DEFAULT_CUTOFF_HZ = 3000;
const SOFT_LIMIT_THRESHOLD = 0.95;

function createBiquadState(): BiquadState {
  return { x1: 0, x2: 0, y1: 0, y2: 0 };
}

/** Second-order Butterworth low-pass (RBJ cookbook). */
function designLowpassBiquad(sampleRate: number, cutoffHz: number): BiquadCoeffs {
  const safeCutoff = Math.max(20, Math.min(cutoffHz, sampleRate * 0.45));
  const w0 = (2 * Math.PI * safeCutoff) / sampleRate;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const alpha = sinW0 / Math.SQRT2;
  const b0 = (1 - cosW0) / 2;
  const b1 = 1 - cosW0;
  const b2 = (1 - cosW0) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cosW0;
  const a2 = 1 - alpha;
  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: a1 / a0,
    a2: a2 / a0,
  };
}

function processBiquad(sample: number, coeffs: BiquadCoeffs, state: BiquadState): number {
  const y = coeffs.b0 * sample
    + coeffs.b1 * state.x1
    + coeffs.b2 * state.x2
    - coeffs.a1 * state.y1
    - coeffs.a2 * state.y2;
  state.x2 = state.x1;
  state.x1 = sample;
  state.y2 = state.y1;
  state.y1 = y;
  return y;
}

function softLimit(sample: number): number {
  const abs = Math.abs(sample);
  if (abs <= SOFT_LIMIT_THRESHOLD) {
    return sample;
  }
  // Soft knee toward ±1 without hard clipping of the whole block.
  const sign = sample < 0 ? -1 : 1;
  return sign * (SOFT_LIMIT_THRESHOLD + (1 - SOFT_LIMIT_THRESHOLD) * Math.tanh(abs - SOFT_LIMIT_THRESHOLD));
}

export class IcomIfSsbDemodulator {
  private centerHz: number;
  private sideband: IfSideband;
  private cutoffHz: number;
  private sampleRate = 0;
  private phase = 0;
  private iFilter1 = createBiquadState();
  private iFilter2 = createBiquadState();
  private qFilter1 = createBiquadState();
  private qFilter2 = createBiquadState();
  private coeffs: BiquadCoeffs | null = null;

  constructor(options: IcomIfSsbDemodulatorOptions = {}) {
    this.centerHz = options.centerHz ?? DEFAULT_CENTER_HZ;
    this.sideband = options.sideband ?? 'usb';
    this.cutoffHz = options.cutoffHz ?? DEFAULT_CUTOFF_HZ;
  }

  getCenterHz(): number {
    return this.centerHz;
  }

  getSideband(): IfSideband {
    return this.sideband;
  }

  configure(options: IcomIfSsbDemodulatorOptions = {}): void {
    if (options.centerHz !== undefined) {
      this.centerHz = options.centerHz;
    }
    if (options.sideband !== undefined) {
      this.sideband = options.sideband;
    }
    if (options.cutoffHz !== undefined) {
      this.cutoffHz = options.cutoffHz;
    }
    this.coeffs = null;
    this.sampleRate = 0;
    this.reset();
  }

  reset(): void {
    this.phase = 0;
    this.iFilter1 = createBiquadState();
    this.iFilter2 = createBiquadState();
    this.qFilter1 = createBiquadState();
    this.qFilter2 = createBiquadState();
  }

  /**
   * Demodulate a real IF PCM block into SSB AF at the same sample rate.
   */
  process(samples: Float32Array, sampleRate: number): Float32Array {
    if (samples.length === 0) {
      return samples;
    }
    const rate = Math.floor(sampleRate);
    if (!Number.isFinite(rate) || rate <= 0) {
      return samples;
    }
    this.ensureConfigured(rate);

    const out = new Float32Array(samples.length);
    const twoPi = 2 * Math.PI;
    const phaseIncrement = (twoPi * this.centerHz) / rate;
    const coeffs = this.coeffs!;

    for (let i = 0; i < samples.length; i++) {
      const x = samples[i];
      const cosLo = Math.cos(this.phase);
      const sinLo = Math.sin(this.phase);
      this.phase += phaseIncrement;
      if (this.phase >= twoPi) {
        this.phase -= twoPi;
      }

      // Mix to complex baseband.
      let iBase = x * cosLo;
      let qBase = x * (-sinLo);

      // Cascaded LPF (~60 dB/decade equivalent with two stages).
      iBase = processBiquad(iBase, coeffs, this.iFilter1);
      iBase = processBiquad(iBase, coeffs, this.iFilter2);
      qBase = processBiquad(qBase, coeffs, this.qFilter1);
      qBase = processBiquad(qBase, coeffs, this.qFilter2);

      // Phasing method: USB = I - Q, LSB = I + Q (after -sin Q mix).
      const af = this.sideband === 'usb' ? (iBase - qBase) : (iBase + qBase);
      out[i] = softLimit(af);
    }

    return out;
  }

  private ensureConfigured(sampleRate: number): void {
    if (this.sampleRate === sampleRate && this.coeffs) {
      return;
    }
    this.sampleRate = sampleRate;
    this.coeffs = designLowpassBiquad(sampleRate, this.cutoffHz);
    this.reset();
  }
}
