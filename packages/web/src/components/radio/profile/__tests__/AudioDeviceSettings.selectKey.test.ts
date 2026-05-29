import { describe, expect, it } from 'vitest';
import type { AudioDevice, AudioDeviceResolution } from '@tx5dr/contracts';
import {
  audioSettingsEqual,
  buildAudioDeviceSelectOptions,
  getDeviceNameFromSelectKey,
  makeAudioDeviceSelectKey,
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

const missingResolution = (deviceName: string): AudioDeviceResolution => ({
  configuredDeviceName: deviceName,
  configuredDevice: null,
  effectiveDevice: null,
  status: 'missing',
});

describe('AudioDeviceSettings select keys', () => {
  it('scopes same-named audio devices by direction without changing the saved name', () => {
    const deviceName = 'USB Audio CODEC';
    const inputKey = makeAudioDeviceSelectKey('input', deviceName);
    const outputKey = makeAudioDeviceSelectKey('output', deviceName);

    expect(inputKey).toBe('input::USB Audio CODEC');
    expect(outputKey).toBe('output::USB Audio CODEC');
    expect(inputKey).not.toBe(outputKey);
    expect(getDeviceNameFromSelectKey('input', inputKey)).toBe(deviceName);
    expect(getDeviceNameFromSelectKey('output', outputKey)).toBe(deviceName);
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

  it('detects real controlled audio changes', () => {
    expect(audioSettingsEqual({
      inputDeviceName: 'C-Media Electronics Inc.: USB Audio Device',
      outputDeviceName: 'C-Media Electronics Inc.: USB Audio Device',
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

  it('adds a direction-scoped missing input option for the saved device name', () => {
    const options = buildAudioDeviceSelectOptions(
      'input',
      [builtInInput],
      'USB Audio CODEC',
      missingResolution('USB Audio CODEC'),
    );

    expect(options).toEqual([
      expect.objectContaining({
        key: 'input::Built-in Mic',
        deviceName: 'Built-in Mic',
        isMissing: false,
      }),
      {
        key: 'input::USB Audio CODEC',
        deviceName: 'USB Audio CODEC',
        device: null,
        isMissing: true,
      },
    ]);
  });

  it('adds a direction-scoped missing output option without changing the saved name', () => {
    const options = buildAudioDeviceSelectOptions(
      'output',
      [],
      'USB Audio CODEC',
      missingResolution('USB Audio CODEC'),
    );

    expect(options).toEqual([{
      key: 'output::USB Audio CODEC',
      deviceName: 'USB Audio CODEC',
      device: null,
      isMissing: true,
    }]);
    expect(getDeviceNameFromSelectKey('output', options[0].key)).toBe('USB Audio CODEC');
  });

  it('keeps same-named missing input and output options distinct', () => {
    const deviceName = 'C-Media Electronics Inc.: USB Audio Device';

    const inputOptions = buildAudioDeviceSelectOptions('input', [], deviceName, missingResolution(deviceName));
    const outputOptions = buildAudioDeviceSelectOptions('output', [], deviceName, missingResolution(deviceName));

    expect(inputOptions[0].key).toBe('input::C-Media Electronics Inc.: USB Audio Device');
    expect(outputOptions[0].key).toBe('output::C-Media Electronics Inc.: USB Audio Device');
    expect(getDeviceNameFromSelectKey('input', inputOptions[0].key)).toBe(deviceName);
    expect(getDeviceNameFromSelectKey('output', outputOptions[0].key)).toBe(deviceName);
  });

  it('does not add a synthetic option when the saved device is currently enumerated', () => {
    const options = buildAudioDeviceSelectOptions(
      'input',
      [{ ...builtInInput, name: 'USB Audio CODEC' }],
      'USB Audio CODEC',
      {
        configuredDeviceName: 'USB Audio CODEC',
        configuredDevice: { ...builtInInput, name: 'USB Audio CODEC' },
        effectiveDevice: { ...builtInInput, name: 'USB Audio CODEC' },
        status: 'selected',
      },
    );

    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({
      key: 'input::USB Audio CODEC',
      deviceName: 'USB Audio CODEC',
      isMissing: false,
    });
  });
});
