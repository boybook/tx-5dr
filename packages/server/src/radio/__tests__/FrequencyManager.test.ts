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
});
