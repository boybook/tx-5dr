import { describe, expect, it } from 'vitest';
import { filterDigitalFrequencyOptions, isCoreCapabilityAvailable, shouldShowAutoTunerShortcut } from '../radioControl';

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

  it('shows auto tuner shortcut only when connected, permitted, and supported', () => {
    expect(shouldShowAutoTunerShortcut(true, true, {
      id: 'tuner_switch',
      supported: true,
      value: false,
      updatedAt: 1,
    })).toBe(true);

    expect(shouldShowAutoTunerShortcut(true, false, {
      id: 'tuner_switch',
      supported: true,
      value: false,
      updatedAt: 1,
    })).toBe(false);

    expect(shouldShowAutoTunerShortcut(true, true, {
      id: 'tuner_switch',
      supported: false,
      value: null,
      updatedAt: 1,
    })).toBe(false);

    expect(shouldShowAutoTunerShortcut(false, true, {
      id: 'tuner_switch',
      supported: true,
      value: true,
      updatedAt: 1,
    })).toBe(false);

    expect(shouldShowAutoTunerShortcut(true, true, undefined)).toBe(false);
  });
});
