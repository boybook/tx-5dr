export interface PresetFrequency {
  band: string;
  mode: string;
  frequency: number;
  description?: string;
}

export class FrequencyManager {
  private presets: PresetFrequency[] = [
    // FT8 频率
    { band: '6m', mode: 'FT8', frequency: 50313000, description: '50.313 MHz (6米波段)' },
    { band: '10m', mode: 'FT8', frequency: 28074000, description: '28.074 MHz (10米波段)' },
    { band: '12m', mode: 'FT8', frequency: 24915000, description: '24.915 MHz (12米波段)' },
    { band: '15m', mode: 'FT8', frequency: 21074000, description: '21.074 MHz (15米波段)' },
    { band: '17m', mode: 'FT8', frequency: 18100000, description: '18.100 MHz (17米波段)' },
    { band: '20m', mode: 'FT8', frequency: 14074000, description: '14.074 MHz (20米波段)' },
    { band: '30m', mode: 'FT8', frequency: 10136000, description: '10.136 MHz (30米波段)' },
    { band: '40m', mode: 'FT8', frequency: 7074000, description: '7.074 MHz (40米波段)' },
    { band: '80m', mode: 'FT8', frequency: 3573000, description: '3.573 MHz (80米波段)' },
    { band: '160m', mode: 'FT8', frequency: 1840000, description: '1.840 MHz (160米波段)' },
    
    // FT4 频率
    { band: '6m', mode: 'FT4', frequency: 50318000, description: '50.318 MHz (6米波段)' },
    { band: '10m', mode: 'FT4', frequency: 28180000, description: '28.180 MHz (10米波段)' },
    { band: '12m', mode: 'FT4', frequency: 24919000, description: '24.919 MHz (12米波段)' },
    { band: '15m', mode: 'FT4', frequency: 21140000, description: '21.140 MHz (15米波段)' },
    { band: '17m', mode: 'FT4', frequency: 18104000, description: '18.104 MHz (17米波段)' },
    { band: '20m', mode: 'FT4', frequency: 14080000, description: '14.080 MHz (20米波段)' },
    { band: '30m', mode: 'FT4', frequency: 10140000, description: '10.140 MHz (30米波段)' },
    { band: '40m', mode: 'FT4', frequency: 7047500, description: '7.047.5 MHz (40米波段)' },
    { band: '80m', mode: 'FT4', frequency: 3575000, description: '3.575 MHz (80米波段)' },
    { band: '160m', mode: 'FT4', frequency: 1842000, description: '1.842 MHz (160米波段)' },
    
    // 常用的一些其他频率
    { band: '2m', mode: 'FT8', frequency: 144174000, description: '144.174 MHz (2米波段)' },
    { band: '70cm', mode: 'FT8', frequency: 432174000, description: '432.174 MHz (70厘米波段)' },
  ];

  getPresets(): PresetFrequency[] {
    return [...this.presets];
  }

  /**
   * 根据模式筛选预设频率
   */
  getPresetsByMode(mode: string): PresetFrequency[] {
    return this.presets.filter(preset => preset.mode === mode);
  }

  /**
   * 根据波段筛选预设频率
   */
  getPresetsByBand(band: string): PresetFrequency[] {
    return this.presets.filter(preset => preset.band === band);
  }

  /**
   * 获取所有支持的波段
   */
  getAllBands(): string[] {
    return [...new Set(this.presets.map(preset => preset.band))];
  }

  /**
   * 获取所有支持的模式
   */
  getAllModes(): string[] {
    return [...new Set(this.presets.map(preset => preset.mode))];
  }

  /**
   * 查找最接近的预设频率
   */
  findClosestPreset(frequency: number, mode?: string): PresetFrequency | null {
    let candidates = this.presets;
    if (mode) {
      candidates = candidates.filter(preset => preset.mode === mode);
    }

    if (candidates.length === 0) {
      return null;
    }

    return candidates.reduce((closest, current) => {
      const currentDiff = Math.abs(current.frequency - frequency);
      const closestDiff = Math.abs(closest.frequency - frequency);
      return currentDiff < closestDiff ? current : closest;
    });
  }

  /**
   * 验证频率是否在业余无线电频段内
   */
  isValidAmateuerFrequency(frequency: number): boolean {
    // 业余无线电主要频段范围（Hz）
    const amateurBands = [
      [1800000, 2000000],    // 160m
      [3500000, 4000000],    // 80m
      [5351500, 5366500],    // 60m
      [7000000, 7300000],    // 40m
      [10100000, 10150000],  // 30m
      [14000000, 14350000],  // 20m
      [18068000, 18168000],  // 17m
      [21000000, 21450000],  // 15m
      [24890000, 24990000],  // 12m
      [28000000, 29700000],  // 10m
      [50000000, 54000000],  // 6m
      [144000000, 148000000], // 2m
      [420000000, 450000000], // 70cm
    ];

    return amateurBands.some(([min, max]) => frequency >= min && frequency <= max);
  }
}
