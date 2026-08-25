import { describe, expect, it } from 'vitest';

import { FrequencyManager } from '../FrequencyManager.js';

describe('FrequencyManager image presets', () => {
  it('includes common SSTV activity frequencies in the default catalog', () => {
    const frequencies = new FrequencyManager().getPresetsByMode('SSTV').map((preset) => preset.frequency);

    expect(frequencies).toEqual(expect.arrayContaining([
      3_730_000,
      3_845_000,
      7_165_000,
      7_171_000,
      7_181_000,
      14_227_000,
      14_230_000,
      14_233_000,
      21_340_000,
      28_680_000,
      144_500_000,
      145_800_000,
    ]));
  });

  it('includes worldwide marine FAX channels with the documented USB offset', () => {
    const presets = new FrequencyManager().getPresetsByMode('FAX');

    expect(presets).toHaveLength(49);
    expect(presets.map((preset) => preset.frequency)).toEqual(expect.arrayContaining([
      3_620_600,  // JMH Tokyo, assigned 3622.5 kHz
      4_197_850,  // XSQ Guangzhou, assigned 4199.75 kHz
      4_344_100,  // NMC Pt Reyes, assigned 4346 kHz
      4_316_000,  // NMG New Orleans, assigned 4317.9 kHz
      4_233_100,  // NMF Boston, assigned 4235 kHz
      9_980_600,  // KVM70 Honolulu, assigned 9982.5 kHz
      11_028_100, // VMC Charleville, assigned 11030 kHz
      7_533_100,  // VMW Wiluna, assigned 7535 kHz
      7_878_100,  // DDK3 Hamburg, assigned 7880 kHz
      4_608_100,  // GYA Northwood, assigned 4610 kHz
    ]));

    for (const preset of presets) {
      expect(preset.radioMode).toBe('USB');
      expect(preset.audioCenterHz).toBe(1_900);
      expect(preset.assignedFrequency).toBe(preset.frequency + 1_900);
      expect(preset.imagePurpose).toBe('weatherfax');
      expect(preset.faxEmission).toMatch(/^[JF][13]C$/);
    }
  });

  it('backfills image presets for legacy customized catalogs without image modes', () => {
    const manager = new FrequencyManager([
      { band: '20m', mode: 'VOICE', radioMode: 'USB', frequency: 14_270_000, description: 'Custom voice' },
    ]);

    expect(manager.getPresetsByMode('VOICE')).toHaveLength(1);
    expect(manager.getPresetsByMode('SSTV').length).toBeGreaterThan(0);
    expect(manager.getPresetsByMode('FAX').length).toBeGreaterThan(0);
  });

  it('preserves configured image families and only fills a missing family', () => {
    const manager = new FrequencyManager([
      { band: '20m', mode: 'SSTV', radioMode: 'USB', frequency: 14_240_000, description: 'Custom SSTV' },
    ]);

    expect(manager.getPresetsByMode('SSTV').map((preset) => preset.frequency)).toEqual([14_240_000]);
    expect(manager.getPresetsByMode('FAX').length).toBeGreaterThan(0);
  });

  it('backfills new standard FAX channels into customized catalogs without replacing overrides', () => {
    const manager = new FrequencyManager([
      {
        band: '4MHz',
        mode: 'FAX',
        radioMode: 'USB',
        frequency: 4_233_100,
        description: 'Custom Boston label',
      },
    ]);
    const faxPresets = manager.getPresetsByMode('FAX');
    const boston = faxPresets.find((preset) => preset.frequency === 4_233_100);

    expect(faxPresets).toHaveLength(49);
    expect(new Set(faxPresets.map((preset) => preset.frequency)).size).toBe(49);
    expect(boston).toMatchObject({
      description: 'Custom Boston label',
      assignedFrequency: 4_235_000,
      audioCenterHz: 1_900,
      faxEmission: 'J3C',
    });
  });
});
