import { describe, expect, it } from 'vitest';

import { shouldAutoOpenAlcWarning, shouldShowLevelDbmDetail } from '../RadioMetersDisplay';

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
});
