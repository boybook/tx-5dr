import { describe, expect, it } from 'vitest';
import {
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
});
