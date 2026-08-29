export type LaneFrequencyMode = 'auto' | 'manual';

export class LaneFrequencyController {
  private manualFrequencyHz?: number;

  constructor(
    private readonly resolveAutomaticFrequencyHz: () => number,
    private readonly minimumHz = 100,
    private readonly maximumHz = 5000,
  ) {}

  get mode(): LaneFrequencyMode { return this.manualFrequencyHz === undefined ? 'auto' : 'manual'; }
  get frequencyHz(): number { return this.manualFrequencyHz ?? this.resolveAutomaticFrequencyHz(); }

  setManual(frequencyHz: number): void {
    if (!Number.isFinite(frequencyHz) || frequencyHz < this.minimumHz || frequencyHz > this.maximumHz) {
      throw new Error('audio_frequency_out_of_range');
    }
    this.manualFrequencyHz = Math.round(frequencyHz);
  }

  useAutomatic(): void { this.manualFrequencyHz = undefined; }

  checkpoint(): { manualFrequencyHz?: number } {
    return this.manualFrequencyHz === undefined ? {} : { manualFrequencyHz: this.manualFrequencyHz };
  }

  restore(checkpoint: { manualFrequencyHz?: number }): void {
    this.manualFrequencyHz = checkpoint.manualFrequencyHz;
  }
}
