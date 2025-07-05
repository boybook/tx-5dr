export interface PresetFrequency {
  band: string;
  mode: string;
  frequency: number;
}

export class FrequencyManager {
  private presets: PresetFrequency[] = [
    { band: '20m', mode: 'FT8', frequency: 14074000 },
    { band: '40m', mode: 'FT8', frequency: 7074000 },
    { band: '80m', mode: 'FT8', frequency: 3573000 },
    { band: '20m', mode: 'FT4', frequency: 14080000 },
  ];

  getPresets() {
    return [...this.presets];
  }
}
