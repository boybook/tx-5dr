/**
 * Low-latency linear streaming resampler for realtime transport edges.
 *
 * It keeps fractional position and one-sample lookahead across chunks, avoiding
 * the discontinuities caused by stateless chunk resampling without introducing
 * FFT/filter block latency.
 */
export class StreamingLinearResampler {
  private readonly step: number;
  private inputBuffer = new Float32Array(0);
  private position = 0;

  constructor(
    private readonly inputRate: number,
    private readonly outputRate: number,
  ) {
    if (inputRate <= 0 || outputRate <= 0) {
      throw new Error(`Invalid resampler rates: ${inputRate} -> ${outputRate}`);
    }
    this.step = inputRate / outputRate;
  }

  process(samples: Float32Array): Float32Array {
    if (samples.length === 0) {
      return new Float32Array(0);
    }

    if (this.inputRate === this.outputRate) {
      return new Float32Array(samples);
    }

    this.inputBuffer = appendSamples(this.inputBuffer, samples);

    const out: number[] = [];

    // Keep one source sample as lookahead so interpolation is continuous across
    // chunk boundaries. This costs <0.1ms at 12k and ~0.02ms at 48k.
    while (this.position < this.inputBuffer.length - 1) {
      const leftIndex = Math.floor(this.position);
      const rightIndex = leftIndex + 1;
      const fraction = this.position - leftIndex;
      const left = this.inputBuffer[leftIndex] ?? 0;
      const right = this.inputBuffer[rightIndex] ?? left;
      out.push(left * (1 - fraction) + right * fraction);
      this.position += this.step;
    }

    const consumed = Math.max(0, Math.floor(this.position));
    if (consumed > 0) {
      this.inputBuffer = this.inputBuffer.slice(consumed);
      this.position -= consumed;
    }

    return Float32Array.from(out);
  }

  reset(): void {
    this.inputBuffer = new Float32Array(0);
    this.position = 0;
  }
}

export class FixedFrameAudioBuffer {
  private buffer = new Float32Array(0);

  constructor(private readonly frameSamples: number) {
    if (!Number.isInteger(frameSamples) || frameSamples <= 0) {
      throw new Error(`Invalid fixed frame size: ${frameSamples}`);
    }
  }

  push(samples: Float32Array): Float32Array[] {
    if (samples.length > 0) {
      this.buffer = appendSamples(this.buffer, samples);
    }

    const frames: Float32Array[] = [];
    while (this.buffer.length >= this.frameSamples) {
      frames.push(this.buffer.slice(0, this.frameSamples));
      this.buffer = this.buffer.slice(this.frameSamples);
    }
    return frames;
  }

  clear(): void {
    this.buffer = new Float32Array(0);
  }

  get queuedSamples(): number {
    return this.buffer.length;
  }
}

function appendSamples(buffer: Float32Array, samples: Float32Array): Float32Array {
  if (buffer.length === 0) {
    return new Float32Array(samples);
  }
  if (samples.length === 0) {
    return buffer;
  }

  const merged = new Float32Array(buffer.length + samples.length);
  merged.set(buffer);
  merged.set(samples, buffer.length);
  return merged;
}
