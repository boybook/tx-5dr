import { describe, expect, it } from 'vitest';
import { createMongoAbility } from '@casl/ability';
import {
  canExecuteRadioFrequency,
  canWriteRadioFrequency,
  deriveMonitorActivationCtaState,
  filterDigitalFrequencyOptions,
  isFakeFrequencySupportedMode,
  isCoreCapabilityAvailable,
  shouldShowAntennaTuneEntry,
  shouldShowAutoTunerShortcut,
  shouldShowFakeFrequencyEntry,
  shouldShowRadioControlEntry,
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

  it('requires both CASL permission and radio write capability before writing frequency', () => {
    expect(canWriteRadioFrequency(false, null)).toBe(false);
    expect(canWriteRadioFrequency(true, null)).toBe(true);
    expect(canWriteRadioFrequency(true, {
      readFrequency: true,
      writeFrequency: false,
      readRadioMode: true,
      writeRadioMode: true,
    })).toBe(false);
  });

  it('checks radio frequency permission with target frequency data', () => {
    const ability = createMongoAbility([
      { action: 'execute', subject: 'RadioFrequency', conditions: { frequency: { $gte: 14_000_000, $lte: 14_350_000 } } },
    ]);

    expect(canExecuteRadioFrequency(ability, 14_270_000)).toBe(true);
    expect(canExecuteRadioFrequency(ability, 14_500_000)).toBe(false);
    expect(canExecuteRadioFrequency(ability, null)).toBe(false);
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

  it('shows antenna tune entry whenever the connected radio can be controlled', () => {
    expect(shouldShowAntennaTuneEntry(true, true)).toBe(true);
    expect(shouldShowAntennaTuneEntry(true, false)).toBe(false);
    expect(shouldShowAntennaTuneEntry(false, true)).toBe(false);
  });

  it('shows radio control entry only when connected and permitted', () => {
    expect(shouldShowRadioControlEntry(true, true)).toBe(true);
    expect(shouldShowRadioControlEntry(true, false)).toBe(false);
    expect(shouldShowRadioControlEntry(false, true)).toBe(false);
  });

  it('supports virtual frequency offset only in FT8/FT4 digital modes', () => {
    expect(isFakeFrequencySupportedMode('digital', 'FT8')).toBe(true);
    expect(isFakeFrequencySupportedMode('digital', 'FT4')).toBe(true);
    expect(isFakeFrequencySupportedMode('voice', 'VOICE')).toBe(false);
    expect(isFakeFrequencySupportedMode('cw', 'CW')).toBe(false);
    expect(isFakeFrequencySupportedMode('digital', null)).toBe(false);
  });

  it('shows virtual frequency offset entry only for connected controllable FT8/FT4 radios', () => {
    expect(shouldShowFakeFrequencyEntry(true, true, 'serial', 'digital', 'FT8')).toBe(true);
    expect(shouldShowFakeFrequencyEntry(true, true, 'network', 'digital', 'FT4')).toBe(true);
    expect(shouldShowFakeFrequencyEntry(true, true, 'serial', 'voice', 'VOICE')).toBe(false);
    expect(shouldShowFakeFrequencyEntry(true, true, 'none', 'digital', 'FT8')).toBe(false);
    expect(shouldShowFakeFrequencyEntry(true, false, 'serial', 'digital', 'FT8')).toBe(false);
    expect(shouldShowFakeFrequencyEntry(false, true, 'serial', 'digital', 'FT8')).toBe(false);
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
