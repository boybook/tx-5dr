import { describe, expect, it } from 'vitest';
import {
  audioSettingsEqual,
  getDeviceNameFromSelectKey,
  makeAudioDeviceSelectKey,
  resolveOutputChannelMode,
  resolveOutputSampleFormat,
} from '../AudioDeviceSettings';

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
});
