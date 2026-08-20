import { describe, expect, it } from 'vitest';
import { ConfigManager } from '../config-manager.js';

describe('ConfigManager digital mode preference migration', () => {
  it('migrates only missing Profile preferences to USB', () => {
    const config = {
      profiles: [
        { id: 'legacy', radio: { type: 'serial' } },
        { id: 'manual', radio: { type: 'serial', digitalModeRadioMode: 'none' } },
        { id: 'data', radio: { type: 'serial', digitalModeRadioMode: 'usb-data' } },
      ],
    };
    const migrate = (ConfigManager.prototype as unknown as {
      migrateMissingDigitalModeRadioMode: (candidate: unknown) => boolean;
    }).migrateMissingDigitalModeRadioMode;

    expect(migrate.call({}, config)).toBe(true);
    expect(config.profiles.map((profile) => profile.radio.digitalModeRadioMode)).toEqual([
      'usb',
      'none',
      'usb-data',
    ]);
    expect(migrate.call({}, config)).toBe(false);
  });
});
