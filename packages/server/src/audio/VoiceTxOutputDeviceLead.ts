import { performance } from 'node:perf_hooks';

export class VoiceTxOutputDeviceLead {
  private startedAt: number | null = null;
  private submittedSamples = 0;
  private sampleRate = 0;

  reset(): void {
    this.startedAt = null;
    this.submittedSamples = 0;
    this.sampleRate = 0;
  }

  get(outputSampleRate: number, now = performance.now()): number {
    if (
      this.startedAt === null
      || this.submittedSamples <= 0
      || outputSampleRate <= 0
      || this.sampleRate !== outputSampleRate
    ) {
      return 0;
    }
    const submittedMs = (this.submittedSamples / outputSampleRate) * 1000;
    const playedMs = Math.max(0, now - this.startedAt);
    return Math.max(0, submittedMs - playedMs);
  }

  noteWrite(sampleCount: number, outputSampleRate: number, now = performance.now()): void {
    if (sampleCount <= 0 || outputSampleRate <= 0) {
      return;
    }
    if (this.sampleRate !== outputSampleRate || this.get(outputSampleRate, now) <= 0.5) {
      this.startedAt = now;
      this.submittedSamples = 0;
      this.sampleRate = outputSampleRate;
    }
    this.submittedSamples += sampleCount;
  }
}
