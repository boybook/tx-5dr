import { describe, expect, it } from 'vitest';
import type { AudioDevice, AudioDeviceResolution } from '@tx5dr/contracts';
import {
  audioSettingsEqual,
  buildAudioDeviceSelectOptions,
  getDeviceNameFromSelectKey,
  getSelectedAudioDeviceKey,
  makeAudioDeviceSelectKey,
  resolveOutputChannelMode,
  resolveOutputSampleFormat,
  resolveUniqueRouteKey,
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

  it('uses a stable route key when an Android endpoint is enumerated', () => {
    const endpoint: AudioDevice = {
      ...builtInInput,
      id: 'android-input-42',
      name: 'Headset microphone',
      backend: 'android',
      kind: 'wired-headset',
      connector: '3.5mm',
      routeKey: 'android:wired-headset:input',
    };
    const options = buildAudioDeviceSelectOptions(
      'input',
      [endpoint],
      endpoint.name,
      undefined,
      endpoint.routeKey,
    );

    expect(options).toEqual([expect.objectContaining({
      key: 'input::android:wired-headset:input',
      routeKey: 'android:wired-headset:input',
      isMissing: false,
    })]);
    expect(getSelectedAudioDeviceKey('input', endpoint.name, endpoint.routeKey))
      .toBe('input::android:wired-headset:input');
  });

  it('upgrades a legacy name only when it maps to one stable route', () => {
    const endpoint = {
      ...builtInInput,
      name: 'Android audio',
      routeKey: 'android:usb:input',
    };
    expect(resolveUniqueRouteKey([endpoint], endpoint.name)).toBe(endpoint.routeKey);
    expect(resolveUniqueRouteKey([
      endpoint,
      { ...endpoint, id: 'input-2', routeKey: 'android:wired-headset:input' },
    ], endpoint.name)).toBe('');
  });

  it('keeps a saved route key as missing instead of falling back by name', () => {
    const routeKey = 'android:wired-headset:input';
    const resolution: AudioDeviceResolution = {
      configuredDeviceName: 'Headset microphone',
      configuredRouteKey: routeKey,
      configuredDevice: null,
      effectiveDevice: null,
      status: 'missing',
    };
    const options = buildAudioDeviceSelectOptions(
      'input',
      [{ ...builtInInput, name: 'Headset microphone' }],
      'Headset microphone',
      resolution,
      routeKey,
    );

    expect(options).toContainEqual({
      key: `input::${routeKey}`,
      deviceName: 'Headset microphone',
      routeKey,
      device: null,
      isMissing: true,
    });
  });

  it('marks an enumerated but unavailable stable route as missing', () => {
    const routeKey = 'android:wired-headset:output';
    const options = buildAudioDeviceSelectOptions('output', [{
      ...builtInInput,
      id: 'android-output-9',
      type: 'output',
      name: 'Headset headphones',
      routeKey,
      availability: 'cached',
      routeState: 'lost',
    }], 'Headset headphones', undefined, routeKey);

    expect(options).toEqual([expect.objectContaining({
      key: `output::${routeKey}`,
      routeKey,
      isMissing: true,
    })]);
  });

  it('treats route identity changes as real controlled changes', () => {
    expect(audioSettingsEqual({
      inputDeviceName: 'Headset microphone',
      inputRouteKey: 'android:wired-headset:input',
      inputSampleRate: 48000,
      outputSampleRate: 48000,
      inputBufferSize: 1024,
      outputBufferSize: 1024,
      outputSampleFormat: 'float32',
      outputChannelMode: 'mono',
    }, {
      inputDeviceName: 'Headset microphone',
    })).toBe(false);

    expect(audioSettingsEqual({
      inputDeviceName: 'Headset microphone',
      inputRouteKey: null,
      inputSampleRate: 48000,
      outputSampleRate: 48000,
      inputBufferSize: 1024,
      outputBufferSize: 1024,
      outputSampleFormat: 'float32',
      outputChannelMode: 'mono',
    }, {
      inputDeviceName: 'Headset microphone',
    })).toBe(true);
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
