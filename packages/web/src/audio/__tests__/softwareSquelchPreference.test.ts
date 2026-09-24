import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_SOFTWARE_SQUELCH_PREFERENCE,
  SOFTWARE_SQUELCH_STORAGE_KEY,
  isFmLikeRadioMode,
  isSoftwareSquelchEffective,
  loadSoftwareSquelchPreference,
  normalizeSoftwareSquelchPreference,
  saveSoftwareSquelchPreference,
} from '../softwareSquelchPreference';

describe('software squelch preference', () => {
  const originalWindow = globalThis.window;

  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, value);
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalWindow !== undefined) {
      vi.stubGlobal('window', originalWindow);
    }
  });

  it('falls back to auto for missing or invalid values', () => {
    expect(normalizeSoftwareSquelchPreference(null)).toBe('auto');
    expect(normalizeSoftwareSquelchPreference('sometimes')).toBe('auto');
    expect(normalizeSoftwareSquelchPreference(42)).toBe('auto');
    expect(loadSoftwareSquelchPreference()).toBe('auto');

    window.localStorage.setItem(SOFTWARE_SQUELCH_STORAGE_KEY, '{bad json');
    expect(loadSoftwareSquelchPreference()).toBe(DEFAULT_SOFTWARE_SQUELCH_PREFERENCE);

    window.localStorage.setItem(SOFTWARE_SQUELCH_STORAGE_KEY, '"maybe"');
    expect(loadSoftwareSquelchPreference()).toBe('auto');
  });

  it('accepts valid preferences and persists them', () => {
    for (const preference of ['auto', 'on', 'off'] as const) {
      expect(normalizeSoftwareSquelchPreference(preference)).toBe(preference);
    }

    saveSoftwareSquelchPreference('on');
    expect(loadSoftwareSquelchPreference()).toBe('on');
    expect(window.localStorage.getItem(SOFTWARE_SQUELCH_STORAGE_KEY)).toBe('"on"');

    saveSoftwareSquelchPreference('off');
    expect(loadSoftwareSquelchPreference()).toBe('off');
  });
});

describe('isFmLikeRadioMode', () => {
  it('matches FM-family modes case-insensitively', () => {
    expect(isFmLikeRadioMode('FM')).toBe(true);
    expect(isFmLikeRadioMode('fm')).toBe(true);
    expect(isFmLikeRadioMode('WFM')).toBe(true);
    expect(isFmLikeRadioMode('NFM')).toBe(true);
    expect(isFmLikeRadioMode('pktfm')).toBe(true);
  });

  it('rejects non-FM modes and empty input', () => {
    expect(isFmLikeRadioMode('USB')).toBe(false);
    expect(isFmLikeRadioMode('LSB')).toBe(false);
    expect(isFmLikeRadioMode('AM')).toBe(false);
    expect(isFmLikeRadioMode('CW')).toBe(false);
    expect(isFmLikeRadioMode('')).toBe(false);
    expect(isFmLikeRadioMode(null)).toBe(false);
    expect(isFmLikeRadioMode(undefined)).toBe(false);
  });
});

describe('isSoftwareSquelchEffective', () => {
  it('on/off override the radio mode', () => {
    expect(isSoftwareSquelchEffective('on', 'USB')).toBe(true);
    expect(isSoftwareSquelchEffective('on', null)).toBe(true);
    expect(isSoftwareSquelchEffective('off', 'WFM')).toBe(false);
    expect(isSoftwareSquelchEffective('off', 'USB')).toBe(false);
  });

  it('auto follows FM-like modes only', () => {
    expect(isSoftwareSquelchEffective('auto', 'WFM')).toBe(true);
    expect(isSoftwareSquelchEffective('auto', 'FM')).toBe(true);
    // SSB/AM must stay unmuted by default: hamlib DCD is unreliable without a carrier.
    expect(isSoftwareSquelchEffective('auto', 'USB')).toBe(false);
    expect(isSoftwareSquelchEffective('auto', 'LSB')).toBe(false);
    expect(isSoftwareSquelchEffective('auto', 'AM')).toBe(false);
    // Unknown mode: keep the squelch gate off (safe default for listening).
    expect(isSoftwareSquelchEffective('auto', null)).toBe(false);
    expect(isSoftwareSquelchEffective('auto', undefined)).toBe(false);
  });
});
