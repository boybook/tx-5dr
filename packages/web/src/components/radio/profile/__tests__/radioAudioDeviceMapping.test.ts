import { describe, expect, it } from 'vitest';
import type { AudioDevice, SupportedRig } from '@tx5dr/contracts';
import {
  getRecommendedSampleRate,
  matchUsbAudioDevice,
  resolveRigInfo,
  selectBestSampleRate,
} from '../radioAudioDeviceMapping';

const makeDevice = (name: string, sampleRates?: number[]): AudioDevice => ({
  id: `dev-${name}`,
  name,
  isDefault: false,
  channels: 1,
  sampleRate: sampleRates?.[0] ?? 48000,
  sampleRates,
  type: 'input',
});

const RIGS: SupportedRig[] = [
  { rigModel: 1035, mfgName: 'Yaesu', modelName: 'FT-991A' },
  { rigModel: 1036, mfgName: 'Yaesu', modelName: 'FT-891' },
  { rigModel: 1037, mfgName: 'Icom', modelName: 'IC-7300' },
  { rigModel: 1038, mfgName: 'Icom', modelName: 'IC-705' },
  { rigModel: 1039, mfgName: 'Kenwood', modelName: 'TS-590S' },
];

describe('resolveRigInfo', () => {
  it('resolves known rig model', () => {
    expect(resolveRigInfo(1035, RIGS)).toEqual({
      mfgName: 'Yaesu',
      modelName: 'FT-991A',
    });
  });

  it('returns null for unknown rig model', () => {
    expect(resolveRigInfo(9999, RIGS)).toBeNull();
  });
});

describe('matchUsbAudioDevice', () => {
  it('matches "USB Audio CODEC"', () => {
    const devices = [
      makeDevice('Built-in Microphone'),
      makeDevice('USB Audio CODEC'),
      makeDevice('Speakers'),
    ];
    expect(matchUsbAudioDevice(devices)?.name).toBe('USB Audio CODEC');
  });

  it('matches PCM2902 pattern', () => {
    const devices = [makeDevice('TI PCM2902 Audio')];
    expect(matchUsbAudioDevice(devices)?.name).toBe('TI PCM2902 Audio');
  });

  it('returns null when no USB audio device found', () => {
    const devices = [makeDevice('Built-in Microphone'), makeDevice('Speakers')];
    expect(matchUsbAudioDevice(devices)).toBeNull();
  });

  it('returns first match when multiple exist', () => {
    const devices = [
      makeDevice('USB Audio CODEC'),
      makeDevice('Another USB Audio CODEC'),
    ];
    expect(matchUsbAudioDevice(devices)?.name).toBe('USB Audio CODEC');
  });
});

describe('getRecommendedSampleRate', () => {
  it('returns 44100 for Yaesu', () => {
    expect(getRecommendedSampleRate('Yaesu')).toBe(44100);
  });

  it('returns 44100 for yaesu (case-insensitive)', () => {
    expect(getRecommendedSampleRate('yaesu')).toBe(44100);
  });

  it('returns 48000 for Icom', () => {
    expect(getRecommendedSampleRate('Icom')).toBe(48000);
  });

  it('returns null for Kenwood', () => {
    expect(getRecommendedSampleRate('Kenwood')).toBeNull();
  });

  it('returns null for unknown manufacturer', () => {
    expect(getRecommendedSampleRate('Elecraft')).toBeNull();
  });
});

describe('selectBestSampleRate', () => {
  it('picks recommended rate when available', () => {
    expect(selectBestSampleRate(44100, [22050, 44100, 48000])).toBe(44100);
  });

  it('picks closest rate when recommended is unavailable', () => {
    expect(selectBestSampleRate(44100, [22050, 48000, 96000])).toBe(48000);
  });

  it('uses fallback list when supported rates empty', () => {
    // FALLBACK_SAMPLE_RATE_OPTIONS includes 44100
    expect(selectBestSampleRate(44100, [])).toBe(44100);
  });

  it('picks closest from fallback when recommended missing', () => {
    expect(selectBestSampleRate(44100, [8000, 48000])).toBe(48000);
  });
});
