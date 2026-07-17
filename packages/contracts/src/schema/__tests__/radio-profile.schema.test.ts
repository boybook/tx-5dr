import { describe, expect, it } from 'vitest';
import {
  CreateProfileRequestSchema,
  RadioProfileSchema,
  UpdateProfileRequestSchema,
} from '../radio-profile.schema.js';

const audio = {
  inputDeviceName: 'Headset microphone',
  inputRouteKey: 'android:wired-headset:input',
  outputDeviceName: 'Headset headphones',
  outputRouteKey: 'android:wired-headset:output',
  inputSampleRate: 48000,
  outputSampleRate: 48000,
};

describe('radio profile audio route identity', () => {
  it('preserves stable route keys through create and update requests', () => {
    expect(CreateProfileRequestSchema.parse({
      name: 'Android 3.5 mm',
      radio: { type: 'none' },
      audio,
    }).audio).toMatchObject(audio);

    expect(UpdateProfileRequestSchema.parse({ audio }).audio).toMatchObject(audio);
  });

  it('loads stable route keys while accepting legacy name-only profiles', () => {
    const baseProfile = {
      id: 'profile-1',
      name: 'Android 3.5 mm',
      radio: { type: 'none' as const },
      audioLockedToRadio: false,
      createdAt: 1,
      updatedAt: 2,
    };

    expect(RadioProfileSchema.parse({ ...baseProfile, audio }).audio).toMatchObject(audio);
    expect(RadioProfileSchema.parse({
      ...baseProfile,
      audio: { inputDeviceName: 'Legacy USB Audio' },
    }).audio).toEqual({ inputDeviceName: 'Legacy USB Audio' });
  });
});
