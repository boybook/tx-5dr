import { describe, expect, it } from 'vitest';
import type { AudioDevice, AudioDeviceResolution } from '@tx5dr/contracts';
import {
  audioSettingsEqual,
  buildAudioDeviceSelectOptions,
  resolveOutputChannelMode,
  resolveOutputSampleFormat,
} from '../AudioDeviceSettings';

const builtInInput: AudioDevice = {
  id: 'input-1',
  name: 'Built-in Mic',
  isDefault: true,
  channels: 1,
  sampleRate: 48000,
  type: 'input',
};

const codecA: AudioDevice = {
  id: 'input-130',
  name: 'USB Audio CODEC',
  isDefault: false,
  channels: 2,
  sampleRate: 48000,
  type: 'input',
  hardwareId: 'usb:1-7.2.4',
  detail: 'IC-9700 12010311 · VID:PID 08bb:2901 · USB 1-7.2.4',
  serialNumber: 'IC-9700 12010311',
};

const codecB: AudioDevice = {
  id: 'input-140',
  name: 'USB Audio CODEC',
  isDefault: false,
  channels: 2,
  sampleRate: 48000,
  type: 'input',
  hardwareId: 'usb:1-7.4.4',
  detail: 'IC-7610 11002034 · VID:PID 08bb:2901 · USB 1-7.4.4',
  serialNumber: 'IC-7610 11002034',
};

const missingResolution = (deviceName: string, deviceId?: string): AudioDeviceResolution => ({
  configuredDeviceName: deviceName,
  configuredDeviceId: deviceId ?? null,
  configuredHardwareId: null,
  configuredDevice: null,
  effectiveDevice: null,
  status: 'missing',
});

describe('AudioDeviceSettings select keys', () => {
  it('lists both same-named USB codecs as separate options with unique ids', () => {
    const options = buildAudioDeviceSelectOptions([codecA, codecB], codecB.id, codecB.name);

    expect(options).toHaveLength(2);
    expect(options.map((option) => option.deviceId)).toEqual([
      'input-130',
      'input-140',
    ]);
    expect(new Set(options.map((option) => option.deviceId)).size).toBe(2);
    expect(options[1]).toMatchObject({
      deviceId: 'input-140',
      hardwareId: 'usb:1-7.4.4',
      deviceName: 'USB Audio CODEC',
    });
  });

  it('dedupes colliding backend device ids so Select keys stay unique', () => {
    const options = buildAudioDeviceSelectOptions(
      [codecA, { ...codecA, hardwareId: 'usb:other' }],
      '',
      '',
    );

    expect(options.map((option) => option.deviceId)).toEqual(['input-130', 'input-130#1']);
  });

  it('defaults output diagnostics to the existing Float32 mono behavior', () => {
    expect(resolveOutputSampleFormat(undefined)).toBe('float32');
    expect(resolveOutputChannelMode(undefined)).toBe('mono');
    expect(resolveOutputSampleFormat({ outputSampleFormat: 'int16' })).toBe('int16');
    expect(resolveOutputChannelMode({ outputChannelMode: 'both' })).toBe('both');
  });

  it('treats controlled initial settings and local defaults as equal to avoid echo changes', () => {
    expect(audioSettingsEqual({
      inputSampleRate: 48000,
      outputSampleRate: 48000,
      inputBufferSize: 1024,
      outputBufferSize: 1024,
      outputSampleFormat: 'int16',
      outputChannelMode: 'mono',
    }, {
      outputSampleFormat: 'int16',
    })).toBe(true);
  });

  it('detects real controlled audio changes including device ids', () => {
    expect(audioSettingsEqual({
      inputDeviceName: 'C-Media Electronics Inc.: USB Audio Device',
      outputDeviceName: 'C-Media Electronics Inc.: USB Audio Device',
      inputDeviceId: 'input-10',
      outputDeviceId: 'output-10',
      inputSampleRate: 44100,
      outputSampleRate: 44100,
      inputBufferSize: 1024,
      outputBufferSize: 1024,
      outputSampleFormat: 'int16',
      outputChannelMode: 'mono',
    }, {
      outputSampleFormat: 'int16',
    })).toBe(false);
  });

  it('adds a missing input option for the saved device', () => {
    const options = buildAudioDeviceSelectOptions(
      [builtInInput],
      'input-999',
      'USB Audio CODEC',
      missingResolution('USB Audio CODEC', 'input-999'),
    );

    expect(options).toEqual([
      expect.objectContaining({
        deviceId: 'input-1',
        deviceName: 'Built-in Mic',
        isMissing: false,
      }),
      {
        deviceId: 'input-999',
        deviceName: 'USB Audio CODEC',
        hardwareId: undefined,
        device: null,
        isMissing: true,
      },
    ]);
  });

  it('adds a missing output option from the saved name when id is absent', () => {
    const options = buildAudioDeviceSelectOptions(
      [],
      '',
      'USB Audio CODEC',
      missingResolution('USB Audio CODEC'),
    );

    expect(options).toEqual([{
      deviceId: 'missing:USB Audio CODEC',
      deviceName: 'USB Audio CODEC',
      hardwareId: undefined,
      device: null,
      isMissing: true,
    }]);
  });

  it('does not add a synthetic option when the saved device is currently enumerated', () => {
    const options = buildAudioDeviceSelectOptions(
      [codecA],
      codecA.id,
      codecA.name,
      {
        configuredDeviceName: codecA.name,
        configuredDeviceId: codecA.id,
        configuredHardwareId: codecA.hardwareId,
        configuredDevice: codecA,
        effectiveDevice: codecA,
        status: 'selected',
      },
    );

    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({
      deviceId: 'input-130',
      isMissing: false,
    });
  });
});
