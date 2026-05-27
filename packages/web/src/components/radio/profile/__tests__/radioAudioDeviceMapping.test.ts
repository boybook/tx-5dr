import { describe, expect, it } from 'vitest';
import type { AudioDevice, SupportedRig } from '@tx5dr/contracts';
import {
  getRecommendedSampleRate,
  matchAudioDeviceForRig,
  matchUsbAudioDevice,
  resolveRigInfo,
  selectBestSampleRate,
} from '../radioAudioDeviceMapping';

const makeDevice = (
  name: string,
  sampleRates?: number[],
  type: AudioDevice['type'] = 'input',
): AudioDevice => ({
  id: `dev-${name}`,
  name,
  isDefault: false,
  channels: type === 'input' ? 1 : 2,
  sampleRate: sampleRates?.[0] ?? 48000,
  sampleRates,
  type,
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

  it('matches USB audio codec names case-insensitively with collapsed whitespace', () => {
    const devices = [
      makeDevice('Built-in Microphone'),
      makeDevice('BurrBrown from Texas Instruments: USB AUDIO  CODEC'),
    ];
    expect(matchUsbAudioDevice(devices)?.name).toBe('BurrBrown from Texas Instruments: USB AUDIO  CODEC');
  });

  it('matches PCM2902 pattern', () => {
    const devices = [makeDevice('TI PCM2902 Audio')];
    expect(matchUsbAudioDevice(devices)?.name).toBe('TI PCM2902 Audio');
  });

  it('matches C-Media USB Audio Device used by FT-710 interfaces', () => {
    const devices = [makeDevice('C-Media Electronics Inc.: USB Audio Device')];
    expect(matchUsbAudioDevice(devices)?.name).toBe('C-Media Electronics Inc.: USB Audio Device');
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

  it('prefers explicit codec devices over generic USB Audio Device matches', () => {
    const devices = [
      makeDevice('C-Media Electronics Inc.: USB Audio Device'),
      makeDevice('BurrBrown from Texas Instruments: USB AUDIO  CODEC'),
    ];
    expect(matchUsbAudioDevice(devices)?.name).toBe('BurrBrown from Texas Instruments: USB AUDIO  CODEC');
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

describe('matchAudioDeviceForRig', () => {
  it('matches input and output USB audio devices independently', async () => {
    const result = await matchAudioDeviceForRig(1035, RIGS, async () => ({
      inputDevices: [
        makeDevice('USB Audio CODEC', [48000], 'input'),
      ],
      outputDevices: [
        makeDevice('USB Audio CODEC', [44100], 'output'),
      ],
    }));

    expect(result).toEqual({
      inputDeviceName: 'USB Audio CODEC',
      inputSampleRate: 48000,
      outputDeviceName: 'USB Audio CODEC',
      outputSampleRate: 44100,
    });
  });

  it('matches Yaesu FT-710 C-Media audio devices and selects 44.1kHz', async () => {
    const result = await matchAudioDeviceForRig(1049, [
      ...RIGS,
      { rigModel: 1049, mfgName: 'Yaesu', modelName: 'FT-710' },
    ], async () => ({
      inputDevices: [
        makeDevice('C-Media Electronics Inc.: USB Audio Device', [44100, 48000], 'input'),
      ],
      outputDevices: [
        makeDevice('C-Media Electronics Inc.: USB Audio Device', [44100, 48000], 'output'),
      ],
    }));

    expect(result).toEqual({
      inputDeviceName: 'C-Media Electronics Inc.: USB Audio Device',
      inputSampleRate: 44100,
      outputDeviceName: 'C-Media Electronics Inc.: USB Audio Device',
      outputSampleRate: 44100,
    });
  });

  it('keeps Icom USB audio devices on the 48kHz recommendation', async () => {
    const result = await matchAudioDeviceForRig(1037, RIGS, async () => ({
      inputDevices: [
        makeDevice('BurrBrown from Texas Instruments: USB AUDIO  CODEC', [44100, 48000], 'input'),
      ],
      outputDevices: [
        makeDevice('BurrBrown from Texas Instruments: USB AUDIO  CODEC', [44100, 48000], 'output'),
      ],
    }));

    expect(result).toEqual({
      inputDeviceName: 'BurrBrown from Texas Instruments: USB AUDIO  CODEC',
      inputSampleRate: 48000,
      outputDeviceName: 'BurrBrown from Texas Instruments: USB AUDIO  CODEC',
      outputSampleRate: 48000,
    });
  });

  it('does not auto-match devices for unknown manufacturers', async () => {
    const result = await matchAudioDeviceForRig(1039, RIGS, async () => ({
      inputDevices: [
        makeDevice('C-Media Electronics Inc.: USB Audio Device', [44100, 48000], 'input'),
      ],
      outputDevices: [
        makeDevice('C-Media Electronics Inc.: USB Audio Device', [44100, 48000], 'output'),
      ],
    }));

    expect(result).toBeNull();
  });

  it('does not copy an input-only USB match into output settings', async () => {
    const result = await matchAudioDeviceForRig(1035, RIGS, async () => ({
      inputDevices: [
        makeDevice('USB Audio CODEC', [44100], 'input'),
      ],
      outputDevices: [
        makeDevice('Built-in Speaker', [48000], 'output'),
      ],
    }));

    expect(result).toEqual({
      inputDeviceName: 'USB Audio CODEC',
      inputSampleRate: 44100,
    });
  });
});
