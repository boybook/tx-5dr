import type { PresetFrequency } from '@tx5dr/contracts';

export class FrequencyManager {
  static readonly DEFAULT_PRESETS: PresetFrequency[] = [
    // ===== FT8 / FT4 数字模式 =====
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

    // ===== VOICE 语音模式 =====
    // HF SSB - LSB below 10 MHz, USB above 10 MHz (ham radio convention)
    // 80m
    { band: '80m', mode: 'VOICE', radioMode: 'LSB', frequency: 3840000, description: '3.840 MHz 80m' },
    { band: '80m', mode: 'VOICE', radioMode: 'LSB', frequency: 3850000, description: '3.850 MHz 80m' },
    // 40m - 7.050 is the main Chinese ham calling frequency
    { band: '40m', mode: 'VOICE', radioMode: 'LSB', frequency: 7050000, description: '7.050 MHz 40m Calling' },
    { band: '40m', mode: 'VOICE', radioMode: 'LSB', frequency: 7055000, description: '7.055 MHz 40m' },
    { band: '40m', mode: 'VOICE', radioMode: 'LSB', frequency: 7060000, description: '7.060 MHz 40m' },
    { band: '40m', mode: 'VOICE', radioMode: 'LSB', frequency: 7070000, description: '7.070 MHz 40m' },
    // 20m - 14.270 is the main Chinese ham USB frequency
    { band: '20m', mode: 'VOICE', radioMode: 'USB', frequency: 14180000, description: '14.180 MHz 20m BY NET' },
    { band: '20m', mode: 'VOICE', radioMode: 'USB', frequency: 14270000, description: '14.270 MHz 20m Calling' },
    { band: '20m', mode: 'VOICE', radioMode: 'USB', frequency: 14275000, description: '14.275 MHz 20m' },
    { band: '20m', mode: 'VOICE', radioMode: 'USB', frequency: 14330000, description: '14.330 MHz 20m CRSA NET' },
    // 17m
    { band: '17m', mode: 'VOICE', radioMode: 'USB', frequency: 18160000, description: '18.160 MHz 17m' },
    // 15m - 21.400 is the Chinese ham calling frequency
    { band: '15m', mode: 'VOICE', radioMode: 'USB', frequency: 21400000, description: '21.400 MHz 15m Calling' },
    // 12m
    { band: '12m', mode: 'VOICE', radioMode: 'USB', frequency: 24950000, description: '24.950 MHz 12m' },
    // 10m
    { band: '10m', mode: 'VOICE', radioMode: 'USB', frequency: 28400000, description: '28.400 MHz 10m' },
    { band: '10m', mode: 'VOICE', radioMode: 'FM', frequency: 29600000, description: '29.600 MHz 10m FM' },
    // 6m
    { band: '6m', mode: 'VOICE', radioMode: 'USB', frequency: 50110000, description: '50.110 MHz 6m Calling' },
    // VHF/UHF FM
    { band: '2m', mode: 'VOICE', radioMode: 'FM', frequency: 145000000, description: '145.000 MHz 2m FM' },
    { band: '70cm', mode: 'VOICE', radioMode: 'FM', frequency: 433000000, description: '433.000 MHz 70cm FM' },
    { band: '70cm', mode: 'VOICE', radioMode: 'FM', frequency: 438500000, description: '438.500 MHz 70cm FM' },
  ];

  private presets: PresetFrequency[];

  constructor(customPresets?: PresetFrequency[] | null) {
    this.presets = customPresets && customPresets.length > 0
      ? customPresets
      : [...FrequencyManager.DEFAULT_PRESETS];
  }

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
   * 根据频率查找匹配的预设频率
   * @param frequency 要匹配的频率 (Hz)
   * @param tolerance 容差 (Hz)，默认 500 Hz
   * @returns 匹配结果，包括预设信息或自定义标记
   */
  findMatchingPreset(frequency: number, tolerance: number = 500): {
    preset: PresetFrequency | null;
    isCustom: boolean;
  } {
    let closestPreset: PresetFrequency | null = null;
    let smallestDiff = Infinity;

    for (const preset of this.presets) {
      const diff = Math.abs(preset.frequency - frequency);
      if (diff <= tolerance && diff < smallestDiff) {
        closestPreset = preset;
        smallestDiff = diff;
      }
    }

    return {
      preset: closestPreset,
      isCustom: closestPreset === null
    };
  }

}
