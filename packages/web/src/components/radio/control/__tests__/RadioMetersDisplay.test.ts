import { describe, expect, it } from 'vitest';

import {
  getMeterSlotVisibility,
  isAlcAutoPromptSuppressedForSession,
  setAlcAutoPromptSuppressedForSession,
  shouldAutoOpenAlcWarning,
  shouldForceOpenAlcWarning,
  shouldShowLevelDbmDetail,
  shouldShowLevelPowerMeter,
} from '../RadioMetersDisplay';
import { hasAnyMeterCapability } from '../../../../utils/radioMeters';

describe('RadioMetersDisplay', () => {
  it('shows dBm detail for s-meter-dbm readings when the container is wide enough', () => {
    expect(shouldShowLevelDbmDetail(580, {
      raw: 120,
      percent: 50,
      sUnits: 9,
      dBm: -73,
      formatted: 'S9',
      displayStyle: 's-meter-dbm',
    })).toBe(true);
  });

  it('hides dBm detail for branded s-meter readings', () => {
    expect(shouldShowLevelDbmDetail(999, {
      raw: 150,
      percent: 50,
      sUnits: 9,
      dBm: -73,
      formatted: 'S9',
      displayStyle: 's-meter',
    })).toBe(false);
  });

  it('hides dBm detail for generic db-over-s9 readings', () => {
    expect(shouldShowLevelDbmDetail(999, {
      raw: 80,
      percent: 25,
      sUnits: 5,
      dBm: -97,
      formatted: '-24 dB@S9',
      displayStyle: 'db-over-s9',
    })).toBe(false);
  });

  it('disables the ALC over-limit prompt when explicitly turned off', () => {
    expect(shouldAutoOpenAlcWarning(
      true,
      true,
      {
        raw: 1,
        percent: 100,
        alert: true,
      },
      false,
      false,
    )).toBe(false);
  });

  it('enables the ALC over-limit prompt for active over-limit TX readings', () => {
    expect(shouldAutoOpenAlcWarning(
      true,
      true,
      {
        raw: 1,
        percent: 100,
        alert: true,
      },
      false,
      true,
    )).toBe(true);
  });

  it('keeps ALC over-limit detection independent from session suppression', () => {
    setAlcAutoPromptSuppressedForSession(true);

    expect(shouldAutoOpenAlcWarning(
      true,
      true,
      {
        raw: 1,
        percent: 100,
        alert: true,
      },
      false,
      true,
    )).toBe(true);
    expect(isAlcAutoPromptSuppressedForSession()).toBe(true);

    setAlcAutoPromptSuppressedForSession(false);
  });

  it('forces the ALC popover open only while session suppression is disabled', () => {
    expect(shouldForceOpenAlcWarning(true, false)).toBe(true);
    expect(shouldForceOpenAlcWarning(true, true)).toBe(false);
    expect(shouldForceOpenAlcWarning(false, false)).toBe(false);
  });

  it('treats an all-false capability snapshot as unsupported', () => {
    expect(hasAnyMeterCapability({
      strength: false,
      swr: false,
      alc: false,
      power: false,
      powerWatts: false,
    })).toBe(false);
  });

  it('keeps the Level/Power meter slot when TX power data is unavailable', () => {
    expect(shouldShowLevelPowerMeter({
      strength: true,
      swr: true,
      alc: true,
      power: false,
      powerWatts: false,
    }, true, false)).toBe(true);
  });

  it('still shows the RX Level meter when only strength capability is enabled', () => {
    expect(shouldShowLevelPowerMeter({
      strength: true,
      swr: true,
      alc: true,
      power: false,
      powerWatts: false,
    }, true, false)).toBe(true);
  });

  it('keeps ICOM WLAN declared SWR/ALC slots visible when RX data only has Level', () => {
    expect(getMeterSlotVisibility({
      strength: true,
      swr: true,
      alc: true,
      power: true,
      powerWatts: true,
    }, {
      swr: null,
      alc: null,
      level: {
        raw: 120,
        percent: 50,
        sUnits: 9,
        dBm: -73,
        formatted: 'S9',
        displayStyle: 's-meter-dbm',
      },
      power: null,
    })).toEqual({
      levelPower: true,
      swr: true,
      alc: true,
    });
  });

  it('falls back to value-driven slot visibility when meter capabilities are unknown', () => {
    expect(getMeterSlotVisibility(null, {
      swr: null,
      alc: null,
      level: {
        raw: 120,
        percent: 50,
        sUnits: 9,
        dBm: -73,
        formatted: 'S9',
        displayStyle: 's-meter-dbm',
      },
      power: null,
    })).toEqual({
      levelPower: true,
      swr: false,
      alc: false,
    });
  });
});
