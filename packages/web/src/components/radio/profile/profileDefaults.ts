import type { AudioDeviceSettings, HamlibConfig } from '@tx5dr/contracts';

export const NEW_PROFILE_RADIO_DEFAULTS: HamlibConfig = {
  type: 'none',
  digitalModeRadioMode: 'usb',
};

export const NEW_PROFILE_AUDIO_DEFAULTS: AudioDeviceSettings = {
  outputSampleFormat: 'int16',
};
