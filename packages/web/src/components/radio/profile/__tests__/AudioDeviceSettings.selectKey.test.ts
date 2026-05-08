import { describe, expect, it } from 'vitest';
import {
  getDeviceNameFromSelectKey,
  makeAudioDeviceSelectKey,
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
});
