import { afterEach, describe, expect, it, vi } from 'vitest';

// Constructing the engine resolves app paths; keep every persistence root in a scratch dir.
await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'tx5dr-rx-clock-'));
  for (const key of ['CONFIG', 'DATA', 'LOGS', 'CACHE', 'PLUGINS', 'PLUGIN_DATA']) {
    process.env[`TX5DR_${key}_DIR`] = join(root, key.toLowerCase());
  }
});

import { DigitalRadioEngine } from '../../DigitalRadioEngine.js';

describe('DigitalRadioEngine RX audio clock wiring (RX-08)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('injects the calibrated clock source into the RX audio buffer', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_778_592_296_556);
    const engine = DigitalRadioEngine.getInstance();
    const clockSource = engine.getClockSource();
    const provider = engine.getAudioStreamManager().getAudioProvider();

    // System clock one FT8 slot behind the NTP-calibrated time.
    clockSource.setCalibrationOffsetMs(15_251.6);

    expect(clockSource.now()).toBe(Date.now() + 15_251.6);
    // The ring buffer, getBuffer clamping and spectrum reads all use this clock.
    expect(provider.getCurrentTimeMs()).toBe(clockSource.now());
  });
});
