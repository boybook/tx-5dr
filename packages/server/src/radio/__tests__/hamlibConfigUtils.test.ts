import { describe, expect, it } from 'vitest';
import { normalizeHamlibConfig } from '../hamlibConfigUtils.js';

describe('normalizeHamlibConfig digital mode preference', () => {
  it('migrates a missing preference to USB', () => {
    expect(normalizeHamlibConfig({ type: 'serial' }).digitalModeRadioMode).toBe('usb');
  });

  it.each(['none', 'usb', 'usb-data'] as const)('preserves an explicit %s preference', (preference) => {
    expect(normalizeHamlibConfig({
      type: 'serial',
      digitalModeRadioMode: preference,
    }).digitalModeRadioMode).toBe(preference);
  });
});
