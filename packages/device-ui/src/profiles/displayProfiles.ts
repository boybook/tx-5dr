export interface DisplayProfile {
  id: string;
  family: 'tft-touch' | 'oled-mono';
  width: number;
  height: number;
  color: 'rgb565' | 'mono1';
  input: 'touch' | 'buttons' | 'none';
  renderer: 'tx5dr-panel-lvgl' | 'tx5dr-panel-oled' | 'mock';
  supportsQr: boolean;
  supportsWifiPasswordEntry: boolean;
  maxRecentMessages: number;
  preferredRefreshHz: number;
  burnInProtection: boolean;
}

export const DISPLAY_PROFILES: Record<string, DisplayProfile> = {
  'tft-ili9486-320x480-touch': {
    id: 'tft-ili9486-320x480-touch',
    family: 'tft-touch',
    width: 320,
    height: 480,
    color: 'rgb565',
    input: 'touch',
    renderer: 'tx5dr-panel-lvgl',
    supportsQr: true,
    supportsWifiPasswordEntry: true,
    maxRecentMessages: 5,
    preferredRefreshHz: 15,
    burnInProtection: false,
  },
  'oled-ssd1306-128x64-1btn': oledProfile('oled-ssd1306-128x64-1btn'),
  'oled-ssd1315-128x64-1btn': oledProfile('oled-ssd1315-128x64-1btn'),
  'oled-sh1106-128x64-1btn': oledProfile('oled-sh1106-128x64-1btn'),
};

function oledProfile(id: string): DisplayProfile {
  return {
    id,
    family: 'oled-mono',
    width: 128,
    height: 64,
    color: 'mono1',
    input: 'buttons',
    renderer: 'tx5dr-panel-oled',
    supportsQr: false,
    supportsWifiPasswordEntry: false,
    maxRecentMessages: 1,
    preferredRefreshHz: 2,
    burnInProtection: true,
  };
}

export function getDisplayProfile(profileId: string): DisplayProfile {
  const profile = DISPLAY_PROFILES[profileId];
  if (!profile) {
    throw new Error(`Unknown device-ui display profile: ${profileId}`);
  }
  return profile;
}
