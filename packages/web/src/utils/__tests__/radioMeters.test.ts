import { describe, expect, it } from 'vitest';

import { hasAnyMeterCapability, hasAnyMeterReading, shouldShowRadioMetersPanel } from '../radioMeters';

describe('radioMeters', () => {
  it('detects whether any meter reading has arrived', () => {
    expect(hasAnyMeterReading({
      swr: null,
      alc: null,
      level: null,
      power: null,
    })).toBe(false);

    expect(hasAnyMeterReading({
      swr: null,
      alc: {
        raw: 1,
        percent: 22,
        alert: false,
      },
      level: null,
      power: null,
    })).toBe(true);
  });

  it('hides the panel until a real meter reading has been received', () => {
    expect(shouldShowRadioMetersPanel({
      radioConnected: true,
      radioConfigType: 'serial',
      meterCapabilities: {
        strength: true,
        swr: true,
        alc: true,
        power: true,
        powerWatts: false,
      },
      hasReceivedMeterData: false,
    })).toBe(false);
  });

  it('keeps the panel hidden when the backend explicitly reports no supported meters', () => {
    expect(hasAnyMeterCapability({
      strength: false,
      swr: false,
      alc: false,
      power: false,
      powerWatts: false,
    })).toBe(false);

    expect(shouldShowRadioMetersPanel({
      radioConnected: true,
      radioConfigType: 'serial',
      meterCapabilities: {
        strength: false,
        swr: false,
        alc: false,
        power: false,
        powerWatts: false,
      },
      hasReceivedMeterData: true,
    })).toBe(false);
  });

  it('shows the panel when connected, configured, and real meter data has arrived', () => {
    expect(shouldShowRadioMetersPanel({
      radioConnected: true,
      radioConfigType: 'serial',
      meterCapabilities: null,
      hasReceivedMeterData: true,
    })).toBe(true);
  });
});
