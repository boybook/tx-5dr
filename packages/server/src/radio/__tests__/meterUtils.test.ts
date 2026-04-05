import { describe, expect, it } from 'vitest';

import {
  genericHamlibStrengthToLevelMeterReading,
  resolveHamlibMeterDecodeStrategy,
  yaesuRawstrToLevelMeterReading,
} from '../connections/meterUtils.js';

describe('meterUtils', () => {
  it('resolves the Yaesu RAWSTR strategy when brand and RAWSTR support match', () => {
    expect(resolveHamlibMeterDecodeStrategy({
      manufacturer: 'Yaesu',
      supportedLevels: ['RAWSTR', 'STRENGTH'],
    })).toEqual({
      name: 'yaesu',
      sourceLevel: 'RAWSTR',
      displayStyle: 's-meter',
      label: 'yaesu-rawstr',
    });
  });

  it('resolves the ICOM branded STRENGTH strategy only for ICOM rigs', () => {
    expect(resolveHamlibMeterDecodeStrategy({
      manufacturer: 'ICOM',
      supportedLevels: ['STRENGTH'],
    })).toEqual({
      name: 'icom',
      sourceLevel: 'STRENGTH',
      displayStyle: 's-meter-dbm',
      label: 'icom-strength',
    });
  });

  it('falls back to the generic STRENGTH strategy for unmatched brands', () => {
    expect(resolveHamlibMeterDecodeStrategy({
      manufacturer: 'Kenwood',
      supportedLevels: ['STRENGTH'],
    })).toEqual({
      name: 'generic',
      sourceLevel: 'STRENGTH',
      displayStyle: 'db-over-s9',
      label: 'generic-strength',
    });
  });

  it('converts Yaesu RAWSTR anchor points to the expected S readings', () => {
    expect(yaesuRawstrToLevelMeterReading(90)).toMatchObject({
      raw: 90,
      formatted: 'S5',
      displayStyle: 's-meter',
    });
    expect(yaesuRawstrToLevelMeterReading(150)).toMatchObject({
      raw: 150,
      formatted: 'S9',
      displayStyle: 's-meter',
    });
    expect(yaesuRawstrToLevelMeterReading(189)).toMatchObject({
      raw: 189,
      formatted: 'S9+20dB',
      dbAboveS9: 20,
      displayStyle: 's-meter',
    });
  });

  it('interpolates Yaesu RAWSTR values between anchor points', () => {
    const reading = yaesuRawstrToLevelMeterReading(80);

    expect(reading.displayStyle).toBe('s-meter');
    expect(reading.sUnits).toBeGreaterThan(4);
    expect(reading.sUnits).toBeLessThan(5);
    expect(reading.formatted).toBe('S5');
  });

  it('formats unmatched Hamlib strength values as dB relative to S9', () => {
    expect(genericHamlibStrengthToLevelMeterReading(-24)).toMatchObject({
      formatted: '-24 dB@S9',
      displayStyle: 'db-over-s9',
    });
    expect(genericHamlibStrengthToLevelMeterReading(10)).toMatchObject({
      formatted: '+10 dB@S9',
      dbAboveS9: 10,
      displayStyle: 'db-over-s9',
    });
  });
});
