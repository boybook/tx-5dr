export interface PresetFrequency {
  band: string;
  mode: string; // 协议模式，如 FT8, FT4
  radioMode?: string; // 电台调制模式，如 USB, LSB, AM, FM
  frequency: number;
  description?: string;
}

export class FrequencyManager {
  private presets: PresetFrequency[] = [
    // 按频率从小到大排列
    { band: '160m', mode: 'FT8', radioMode: 'USB', frequency: 1840000, description: '1.840 MHz 160m' },
    { band: '160m', mode: 'FT4', radioMode: 'USB', frequency: 1842000, description: '1.842 MHz 160m' },
    { band: '80m', mode: 'FT8', radioMode: 'USB', frequency: 3573000, description: '3.573 MHz 80m' },
    { band: '80m', mode: 'FT4', radioMode: 'USB', frequency: 3575000, description: '3.575 MHz 80m' },
    { band: '40m', mode: 'FT4', radioMode: 'USB', frequency: 7047500, description: '7.0475 MHz 40m' },
    { band: '40m', mode: 'FT8', radioMode: 'USB', frequency: 7074000, description: '7.074 MHz 40m' },
    { band: '30m', mode: 'FT8', radioMode: 'USB', frequency: 10136000, description: '10.136 MHz 30m' },
    { band: '30m', mode: 'FT4', radioMode: 'USB', frequency: 10140000, description: '10.140 MHz 30m' },
    { band: '20m', mode: 'FT8', radioMode: 'USB', frequency: 14074000, description: '14.074 MHz 20m' },
    { band: '20m', mode: 'FT4', radioMode: 'USB', frequency: 14080000, description: '14.080 MHz 20m' },
    { band: '17m', mode: 'FT8', radioMode: 'USB', frequency: 18100000, description: '18.100 MHz 17m' },
    { band: '17m', mode: 'FT4', radioMode: 'USB', frequency: 18104000, description: '18.104 MHz 17m' },
    { band: '15m', mode: 'FT8', radioMode: 'USB', frequency: 21074000, description: '21.074 MHz 15m' },
    { band: '15m', mode: 'FT4', radioMode: 'USB', frequency: 21140000, description: '21.140 MHz 15m' },
    { band: '12m', mode: 'FT8', radioMode: 'USB', frequency: 24915000, description: '24.915 MHz 12m' },
    { band: '12m', mode: 'FT4', radioMode: 'USB', frequency: 24919000, description: '24.919 MHz 12m' },
    { band: '10m', mode: 'FT8', radioMode: 'USB', frequency: 28074000, description: '28.074 MHz 10m' },
    { band: '10m', mode: 'FT4', radioMode: 'USB', frequency: 28180000, description: '28.180 MHz 10m' },
    { band: '6m', mode: 'FT8', radioMode: 'USB', frequency: 50313000, description: '50.313 MHz 6m' },
    { band: '6m', mode: 'FT4', radioMode: 'USB', frequency: 50318000, description: '50.318 MHz 6m' },
    { band: '2m', mode: 'FT8', radioMode: 'USB', frequency: 144174000, description: '144.174 MHz 2m' },
    { band: '2m', mode: 'FT8', radioMode: 'USB', frequency: 144460000, description: '144.460 MHz 2m' },
    { band: '70cm', mode: 'FT8', radioMode: 'USB', frequency: 432174000, description: '432.174 MHz 70cm' },
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

}
