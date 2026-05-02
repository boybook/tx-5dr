import { describe, expect, it } from 'vitest';
import type { AudioDeviceSettings } from '@tx5dr/contracts';
import {
  deriveBufferSizeOptions,
  deriveSampleRateOptions,
  isVirtualAudioDevice,
  resolveAudioSettingNumber,
} from '../audioDeviceOptions';

const physicalDevice = {
  id: 'input-1',
  name: 'USB Audio',
  isDefault: true,
  channels: 1,
  sampleRate: 48000,
  sampleRates: [48000, 16000, 16000, 44100],
  type: 'input' as const,
};

describe('audio device option helpers', () => {
  it('uses sorted device sample rates when available', () => {
    expect(deriveSampleRateOptions(physicalDevice, 48000)).toEqual({
      values: [16000, 44100, 48000],
      isFallback: false,
      isCurrentUnsupported: false,
    });
  });

  it('keeps an unsupported current sample rate visible', () => {
    expect(deriveSampleRateOptions(physicalDevice, 96000)).toEqual({
      values: [16000, 44100, 48000, 96000],
      isFallback: false,
      isCurrentUnsupported: true,
    });
  });

  it('falls back when devices do not report sample rates', () => {
    const options = deriveSampleRateOptions({ ...physicalDevice, sampleRates: undefined }, 48000, [12000, 48000]);
    expect(options.values).toEqual([12000, 48000]);
    expect(options.isFallback).toBe(true);
  });

  it('keeps current sample rate visible when fallback options are used', () => {
    const options = deriveSampleRateOptions({ ...physicalDevice, sampleRates: undefined }, 32000, [12000, 48000]);
    expect(options.values).toEqual([12000, 32000, 48000]);
    expect(options.isFallback).toBe(true);
    expect(options.isCurrentUnsupported).toBe(false);
  });

  it('keeps unsupported buffer sizes visible', () => {
    expect(deriveBufferSizeOptions([128, 256, 512], 768)).toEqual({
      values: [128, 256, 512, 768],
      isFallback: false,
      isCurrentUnsupported: true,
    });
  });

  it('keeps current buffer size visible when fallback options are used', () => {
    expect(deriveBufferSizeOptions([], 384, [128, 256])).toEqual({
      values: [128, 256, 384],
      isFallback: true,
      isCurrentUnsupported: false,
    });
  });

  it('detects virtual audio devices', () => {
    expect(isVirtualAudioDevice({ ...physicalDevice, id: 'icom-wlan-input' })).toBe(true);
    expect(isVirtualAudioDevice({ ...physicalDevice, id: 'openwebrx-remote' })).toBe(true);
    expect(isVirtualAudioDevice(physicalDevice)).toBe(false);
  });

  it('resolves split settings before legacy settings', () => {
    const settings: AudioDeviceSettings = {
      sampleRate: 48000,
      bufferSize: 1024,
      inputSampleRate: 16000,
      inputBufferSize: 256,
    };

    expect(resolveAudioSettingNumber(settings, 'inputSampleRate', 'sampleRate', 12000)).toBe(16000);
    expect(resolveAudioSettingNumber(settings, 'outputSampleRate', 'sampleRate', 12000)).toBe(48000);
    expect(resolveAudioSettingNumber(settings, 'inputBufferSize', 'bufferSize', 768)).toBe(256);
    expect(resolveAudioSettingNumber(settings, 'outputBufferSize', 'bufferSize', 768)).toBe(1024);
  });
});
