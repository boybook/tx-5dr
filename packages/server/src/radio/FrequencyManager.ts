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

    // ===== SSTV image activity centers (regional, not exclusive channels) =====
    { band: '80m', mode: 'SSTV', radioMode: 'LSB', frequency: 3730000, description: '3.730 MHz SSTV · IARU 1', region: 'iaru1', imagePurpose: 'activity', audioCenterHz: 1900 },
    { band: '80m', mode: 'SSTV', radioMode: 'LSB', frequency: 3845000, description: '3.845 MHz SSTV · IARU 2', region: 'iaru2', imagePurpose: 'activity', audioCenterHz: 1900 },
    { band: '40m', mode: 'SSTV', radioMode: 'LSB', frequency: 7165000, description: '7.165 MHz SSTV · IARU 1', region: 'iaru1', imagePurpose: 'activity', audioCenterHz: 1900 },
    { band: '40m', mode: 'SSTV', radioMode: 'LSB', frequency: 7171000, description: '7.171 MHz SSTV · IARU 2', region: 'iaru2', imagePurpose: 'activity', audioCenterHz: 1900 },
    { band: '40m', mode: 'SSTV', radioMode: 'LSB', frequency: 7181000, description: '7.181 MHz SSTV · IARU 2', region: 'iaru2', imagePurpose: 'activity', audioCenterHz: 1900 },
    { band: '20m', mode: 'SSTV', radioMode: 'USB', frequency: 14227000, description: '14.227 MHz SSTV · Secondary', region: 'global', imagePurpose: 'activity', audioCenterHz: 1900 },
    { band: '20m', mode: 'SSTV', radioMode: 'USB', frequency: 14230000, description: '14.230 MHz SSTV', region: 'global', imagePurpose: 'activity', audioCenterHz: 1900 },
    { band: '20m', mode: 'SSTV', radioMode: 'USB', frequency: 14233000, description: '14.233 MHz SSTV · Secondary', region: 'global', imagePurpose: 'activity', audioCenterHz: 1900 },
    { band: '15m', mode: 'SSTV', radioMode: 'USB', frequency: 21340000, description: '21.340 MHz SSTV', region: 'global', imagePurpose: 'activity', audioCenterHz: 1900 },
    { band: '10m', mode: 'SSTV', radioMode: 'USB', frequency: 28680000, description: '28.680 MHz SSTV', region: 'global', imagePurpose: 'activity', audioCenterHz: 1900 },
    { band: '2m', mode: 'SSTV', radioMode: 'FM', frequency: 144500000, description: '144.500 MHz SSTV · IARU 1', region: 'iaru1', imagePurpose: 'activity', audioCenterHz: 1900 },
    { band: '2m', mode: 'SSTV', radioMode: 'FM', frequency: 145800000, description: '145.800 MHz ISS SSTV RX', region: 'global', imagePurpose: 'iss', audioCenterHz: 1900 },

    // ===== HF weatherfax receiver dial frequencies (carrier minus 1.9 kHz USB) =====
    { band: '4MHz', mode: 'FAX', radioMode: 'USB', frequency: 4233100, carrierFrequency: 4235000, description: 'NMF Boston 4.235 MHz', region: 'iaru2', imagePurpose: 'weatherfax', audioCenterHz: 1900 },
    { band: '6MHz', mode: 'FAX', radioMode: 'USB', frequency: 6338600, carrierFrequency: 6340500, description: 'NMF Boston 6.3405 MHz', region: 'iaru2', imagePurpose: 'weatherfax', audioCenterHz: 1900 },
    { band: '9MHz', mode: 'FAX', radioMode: 'USB', frequency: 9108100, carrierFrequency: 9110000, description: 'NMF Boston 9.110 MHz', region: 'iaru2', imagePurpose: 'weatherfax', audioCenterHz: 1900 },
    { band: '12MHz', mode: 'FAX', radioMode: 'USB', frequency: 12748100, carrierFrequency: 12750000, description: 'NMF Boston 12.750 MHz', region: 'iaru2', imagePurpose: 'weatherfax', audioCenterHz: 1900 },
  ];

  private presets: PresetFrequency[];

  constructor(customPresets?: PresetFrequency[] | null) {
    if (!customPresets || customPresets.length === 0) {
      this.presets = [...FrequencyManager.DEFAULT_PRESETS];
      return;
    }

    const configuredModes = new Set(customPresets.map((preset) => preset.mode));
    const missingImageDefaults = FrequencyManager.DEFAULT_PRESETS.filter((preset) => (
      (preset.mode === 'SSTV' || preset.mode === 'FAX') && !configuredModes.has(preset.mode)
    ));
    this.presets = [...customPresets, ...missingImageDefaults];
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
