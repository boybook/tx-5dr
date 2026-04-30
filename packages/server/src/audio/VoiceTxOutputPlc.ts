const PLC_TAIL_MS = 8;
const PLC_RESTORE_CROSSFADE_MS = 3;

export class VoiceTxOutputPlc {
  private history = new Float32Array(0);
  private historySampleRate = 0;
  private restoreCrossfadePending = false;

  reset(): void {
    this.history = new Float32Array(0);
    this.historySampleRate = 0;
    this.restoreCrossfadePending = false;
  }

  createTailSamples(sampleCount: number, outputSampleRate: number): { samples: Float32Array; generated: boolean } {
    const out = new Float32Array(Math.max(0, sampleCount));
    if (out.length === 0 || this.history.length === 0 || outputSampleRate <= 0) {
      return { samples: out, generated: false };
    }

    const maxPlcSamples = Math.ceil((PLC_TAIL_MS / 1000) * outputSampleRate);
    const plcSamples = Math.min(out.length, maxPlcSamples, this.history.length);
    const sourceSamples = Math.min(this.history.length, maxPlcSamples);
    const sourceStart = this.history.length - sourceSamples;
    for (let index = 0; index < plcSamples; index += 1) {
      const phase = plcSamples <= 1 ? 1 : index / (plcSamples - 1);
      const fade = Math.cos((phase * Math.PI) / 2);
      out[index] = this.history[sourceStart + (index % sourceSamples)]! * fade;
    }
    this.restoreCrossfadePending = plcSamples > 0;
    return { samples: out, generated: plcSamples > 0 };
  }

  applyRestoreCrossfade(samples: Float32Array, realSampleCount: number, outputSampleRate: number): void {
    if (!this.restoreCrossfadePending || this.history.length === 0 || outputSampleRate <= 0) {
      this.restoreCrossfadePending = false;
      return;
    }

    const crossfadeSamples = Math.min(
      realSampleCount,
      this.history.length,
      Math.ceil((PLC_RESTORE_CROSSFADE_MS / 1000) * outputSampleRate),
    );
    const historyStart = this.history.length - crossfadeSamples;
    for (let index = 0; index < crossfadeSamples; index += 1) {
      const wet = (index + 1) / (crossfadeSamples + 1);
      samples[index] = (this.history[historyStart + index]! * (1 - wet)) + (samples[index]! * wet);
    }
    this.restoreCrossfadePending = false;
  }

  recordRealOutput(samples: Float32Array, outputSampleRate: number): void {
    if (samples.length === 0 || outputSampleRate <= 0) {
      return;
    }
    const maxHistorySamples = Math.ceil((PLC_TAIL_MS / 1000) * outputSampleRate);
    if (this.historySampleRate !== outputSampleRate) {
      this.history = new Float32Array(0);
      this.historySampleRate = outputSampleRate;
      this.restoreCrossfadePending = false;
    }
    if (samples.length >= maxHistorySamples) {
      this.history = new Float32Array(samples.subarray(samples.length - maxHistorySamples));
      return;
    }
    const merged = new Float32Array(Math.min(maxHistorySamples, this.history.length + samples.length));
    const keep = Math.max(0, merged.length - samples.length);
    if (keep > 0) {
      merged.set(this.history.subarray(this.history.length - keep), 0);
    }
    merged.set(samples, keep);
    this.history = merged;
  }
}
