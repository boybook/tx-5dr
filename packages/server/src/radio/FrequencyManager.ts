import type { PresetFrequency } from '@tx5dr/contracts';

const MARINE_FAX_AUDIO_CENTER_HZ = 1_900;

interface MarineFaxStationDefinition {
  callSign: string;
  location: string;
  region: NonNullable<PresetFrequency['region']>;
  emission: NonNullable<PresetFrequency['faxEmission']>;
  channels: ReadonlyArray<{ assignedFrequency: number; callSign?: string }>;
}

// NWS Worldwide Marine Radiofacsimile Broadcast Schedules, March 2025.
// The publication lists assigned frequencies. A transceiver feeding a PC
// decoder in USB mode tunes 1.9 kHz below the assigned frequency.
const MARINE_FAX_STATIONS: readonly MarineFaxStationDefinition[] = [
  {
    callSign: 'JMH', location: 'Tokyo', region: 'iaru3', emission: 'J3C',
    channels: [
      { callSign: 'JMH', assignedFrequency: 3_622_500 },
      { callSign: 'JMH2', assignedFrequency: 7_795_000 },
      { callSign: 'JMH4', assignedFrequency: 13_988_500 },
    ],
  },
  {
    callSign: 'HLL2', location: 'Seoul', region: 'iaru3', emission: 'J3C',
    channels: [3_585_000, 5_857_500, 7_433_500, 9_165_000, 13_570_000]
      .map((assignedFrequency) => ({ assignedFrequency })),
  },
  {
    callSign: 'XSQ', location: 'Guangzhou', region: 'iaru3', emission: 'F3C',
    channels: [4_199_750, 8_412_500, 12_629_250, 16_826_250]
      .map((assignedFrequency) => ({ assignedFrequency })),
  },
  {
    callSign: 'NOJ', location: 'Kodiak', region: 'iaru2', emission: 'J3C',
    channels: [2_054_000, 4_298_000, 8_459_000, 12_412_500]
      .map((assignedFrequency) => ({ assignedFrequency })),
  },
  {
    callSign: 'NMC', location: 'Pt Reyes', region: 'iaru2', emission: 'J3C',
    channels: [4_346_000, 8_682_000, 12_786_000, 17_151_200, 22_527_000]
      .map((assignedFrequency) => ({ assignedFrequency })),
  },
  {
    callSign: 'NMG', location: 'New Orleans', region: 'iaru2', emission: 'J3C',
    channels: [4_317_900, 8_503_900, 12_789_900, 17_146_400]
      .map((assignedFrequency) => ({ assignedFrequency })),
  },
  {
    callSign: 'NMF', location: 'Boston', region: 'iaru2', emission: 'J3C',
    channels: [4_235_000, 6_340_500, 9_110_000, 12_750_000]
      .map((assignedFrequency) => ({ assignedFrequency })),
  },
  {
    callSign: 'KVM70', location: 'Honolulu', region: 'iaru2', emission: 'J3C',
    channels: [9_982_500, 11_090_000, 16_135_000]
      .map((assignedFrequency) => ({ assignedFrequency })),
  },
  {
    callSign: 'VMC', location: 'Charleville', region: 'iaru3', emission: 'J3C',
    channels: [2_628_000, 5_100_000, 11_030_000, 13_920_000, 20_469_000]
      .map((assignedFrequency) => ({ assignedFrequency })),
  },
  {
    callSign: 'VMW', location: 'Wiluna', region: 'iaru3', emission: 'J3C',
    channels: [5_755_000, 7_535_000, 10_555_000, 15_615_000, 18_060_000]
      .map((assignedFrequency) => ({ assignedFrequency })),
  },
  {
    callSign: 'DDH3', location: 'Hamburg', region: 'iaru1', emission: 'F1C',
    channels: [
      { callSign: 'DDH3', assignedFrequency: 3_855_000 },
      { callSign: 'DDK3', assignedFrequency: 7_880_000 },
      { callSign: 'DDK6', assignedFrequency: 13_882_500 },
    ],
  },
  {
    callSign: 'GYA', location: 'Northwood', region: 'iaru1', emission: 'J3C',
    channels: [2_618_500, 4_610_000, 8_040_000, 11_086_500]
      .map((assignedFrequency) => ({ assignedFrequency })),
  },
];

function formatAssignedFrequencyMHz(frequency: number): string {
  const [whole, fraction = ''] = (frequency / 1_000_000).toFixed(6).split('.');
  return `${whole}.${fraction.replace(/0+$/, '').padEnd(3, '0')}`;
}

function buildMarineFaxPresets(): PresetFrequency[] {
  return MARINE_FAX_STATIONS.flatMap((station) => station.channels.map((channel) => {
    const callSign = channel.callSign ?? station.callSign;
    const assignedFrequency = channel.assignedFrequency;
    return {
      band: `${Math.floor(assignedFrequency / 1_000_000)}MHz`,
      mode: 'FAX',
      radioMode: 'USB',
      frequency: assignedFrequency - MARINE_FAX_AUDIO_CENTER_HZ,
      assignedFrequency,
      faxEmission: station.emission,
      description: `${callSign} ${station.location} ${formatAssignedFrequencyMHz(assignedFrequency)} MHz`,
      region: station.region,
      imagePurpose: 'weatherfax',
      audioCenterHz: MARINE_FAX_AUDIO_CENTER_HZ,
    } satisfies PresetFrequency;
  }));
}

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

    // ===== Worldwide marine weatherfax USB dial frequencies =====
    ...buildMarineFaxPresets(),
  ];

  private presets: PresetFrequency[];

  constructor(customPresets?: PresetFrequency[] | null) {
    if (!customPresets || customPresets.length === 0) {
      this.presets = [...FrequencyManager.DEFAULT_PRESETS];
      return;
    }

    const configuredModes = new Set(customPresets.map((preset) => preset.mode));
    const defaultFaxByFrequency = new Map(
      FrequencyManager.DEFAULT_PRESETS
        .filter((preset) => preset.mode === 'FAX')
        .map((preset) => [preset.frequency, preset]),
    );
    const enrichedCustomPresets = customPresets.map((preset) => {
      const matchingDefault = preset.mode === 'FAX' ? defaultFaxByFrequency.get(preset.frequency) : undefined;
      return matchingDefault ? { ...matchingDefault, ...preset } : preset;
    });
    const configuredFaxFrequencies = new Set(
      enrichedCustomPresets
        .filter((preset) => preset.mode === 'FAX')
        .map((preset) => preset.frequency),
    );
    const missingImageDefaults = FrequencyManager.DEFAULT_PRESETS.filter((preset) => (
      (preset.mode === 'SSTV' && !configuredModes.has('SSTV'))
      || (preset.mode === 'FAX' && !configuredFaxFrequencies.has(preset.frequency))
    ));
    this.presets = [...enrichedCustomPresets, ...missingImageDefaults];
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
