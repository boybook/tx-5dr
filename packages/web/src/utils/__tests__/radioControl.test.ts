import { describe, expect, it } from 'vitest';
import {
  deriveMonitorActivationCtaState,
  filterDigitalFrequencyOptions,
  isCoreCapabilityAvailable,
  shouldShowAutoTunerShortcut,
} from '../radioControl';

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

  it('keeps the current custom frequency visible even when its mode differs from the active filter', () => {
    const frequencies = [{ key: 'ft4', mode: 'FT4' }];
    const custom = { key: 'custom', mode: 'FT8' };

    expect(filterDigitalFrequencyOptions(frequencies, 'FT4', custom)).toEqual([
      custom,
      { key: 'ft4', mode: 'FT4' },
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

  it('shows monitor activation CTA only before the first playback gesture succeeds', () => {
    expect(deriveMonitorActivationCtaState(true, true, false, false)).toMatchObject({
      shouldShowActivationCta: true,
    });

    expect(deriveMonitorActivationCtaState(true, true, false, true)).toMatchObject({
      shouldShowActivationCta: false,
    });

    expect(deriveMonitorActivationCtaState(false, true, false, false)).toMatchObject({
      shouldShowActivationCta: false,
    });
  });
});
