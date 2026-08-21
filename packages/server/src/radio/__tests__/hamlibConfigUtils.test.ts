import { describe, expect, it } from 'vitest';
import { normalizeHamlibConfig } from '../hamlibConfigUtils.js';

describe('normalizeHamlibConfig digital mode preference', () => {
  it('normalizes a missing preference to none', () => {
    expect(normalizeHamlibConfig({ type: 'serial' }).digitalModeRadioMode).toBe('none');
  });

  it.each(['none', 'usb', 'usb-data'] as const)('preserves an explicit %s preference', (preference) => {
    expect(normalizeHamlibConfig({
      type: 'serial',
      digitalModeRadioMode: preference,
    }).digitalModeRadioMode).toBe(preference);
  });
});
