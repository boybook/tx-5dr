import { describe, expect, it } from 'vitest';
import { filterDigitalFrequencyOptions, isCoreCapabilityAvailable } from '../radioControl';

describe('radioControl utils', () => {
  it('keeps digital presets available when current mode is unknown', () => {
    const frequencies = [
      { key: 'ft8', mode: 'FT8' },
      { key: 'ft4', mode: 'FT4' },
      { key: 'voice', mode: 'VOICE' },
    ];

    expect(filterDigitalFrequencyOptions(frequencies, null)).toEqual([
      { key: 'ft8', mode: 'FT8' },
      { key: 'ft4', mode: 'FT4' },
    ]);
  });

  it('includes matching custom digital frequency once', () => {
    const frequencies = [{ key: 'ft8', mode: 'FT8' }];
    const custom = { key: 'custom', mode: 'FT8' };

    expect(filterDigitalFrequencyOptions(frequencies, 'FT8', custom)).toEqual([
      custom,
      { key: 'ft8', mode: 'FT8' },
    ]);
  });

  it('treats missing core capability info as available until explicitly unsupported', () => {
    expect(isCoreCapabilityAvailable(null, 'writeFrequency')).toBe(true);
    expect(isCoreCapabilityAvailable({
      readFrequency: true,
      writeFrequency: false,
      readRadioMode: true,
      writeRadioMode: true,
    }, 'writeFrequency')).toBe(false);
  });
});
