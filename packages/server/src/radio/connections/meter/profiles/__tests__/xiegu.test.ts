import { describe, expect, it } from 'vitest';

import { resolveMeterProfile } from '../index.js';
import { xieguAlcReading, xieguProfile } from '../xiegu.js';
import type { MeterProfileMatchContext, MeterReadContext } from '../../types.js';

function matchCtx(
  manufacturer: string | null,
  modelName: string | null,
  levels: string[] = ['ALC', 'STRENGTH', 'SWR'],
): MeterProfileMatchContext {
  return {
    manufacturer,
    modelName,
    rigModel: null,
    supportedLevels: new Set(levels),
    connectionType: 'network',
  };
}

function readCtx(level: number | null): MeterReadContext {
  return {
    getLevel: async () => level,
    sendRaw: async () => Buffer.alloc(0),
    currentFrequencyHz: 14_074_000,
    supportedLevels: new Set(['ALC']),
    rigMetadata: null,
    txPowerMaxWatts: 10,
    levelDecodeStrategy: { name: 'generic', sourceLevel: 'STRENGTH', displayStyle: 's-meter', label: 'generic' },
  } as unknown as MeterReadContext;
}

describe('xiegu meter profile', () => {
  it('matches Xiegu radios and not other brands', () => {
    expect(xieguProfile.matches(matchCtx('Xiegu', 'X6100'))).toBe(true);
    expect(xieguProfile.matches(matchCtx('Xiegu', 'G90'))).toBe(true);
    expect(xieguProfile.matches(matchCtx('Xiegu', 'X6200'))).toBe(true);
    expect(xieguProfile.matches(matchCtx('Icom', 'IC-705'))).toBe(false);
    expect(xieguProfile.matches(matchCtx('Yaesu', 'FT-991A'))).toBe(false);
  });

  it('does not match when the rig exposes no ALC level at all', () => {
    expect(xieguProfile.matches(matchCtx('Xiegu', 'X6100', ['STRENGTH']))).toBe(false);
  });

  it('wins profile resolution over the default Hamlib fallback for a Xiegu rig', () => {
    expect(resolveMeterProfile(matchCtx('Xiegu', 'X6100')).name).toBe('xiegu-inverted-alc');
    expect(resolveMeterProfile(matchCtx('Icom', 'IC-705')).name).toBe('default-hamlib');
  });

  it('keeps the radio\'s own number and stays silent while the ALC is not acting', () => {
    // Hamlib reports 1.0 == "headroom full" == Xiegu's on-screen 100 %.
    expect(xieguAlcReading(1.0)).toMatchObject({ percent: 100, alert: false });
    expect(xieguAlcReading(0.98)).toMatchObject({ percent: 98, alert: false });
    expect(xieguAlcReading(0.9)).toMatchObject({ percent: 90, alert: false });
  });

  it('raises the alert only once the ALC is genuinely compressing', () => {
    // 0.5 on the Hamlib scale == half the headroom gone == real compression.
    expect(xieguAlcReading(0.5)).toMatchObject({ percent: 50, alert: true });
    expect(xieguAlcReading(0.1)).toMatchObject({ percent: 10, alert: true });
    expect(xieguAlcReading(0)).toMatchObject({ percent: 0, alert: true });
  });

  it('is the exact inverse of the stock rule that caused the false alarm', () => {
    // The stock rule alerts at >= 1.0, i.e. precisely on a clean transmission.
    expect(xieguAlcReading(1.0).alert).toBe(false);
    // ... and stays quiet while overdriving, which is the bug being fixed.
    expect(xieguAlcReading(0.2).alert).toBe(true);
  });

  it('clamps out-of-range and NaN input instead of emitting a bogus reading', () => {
    expect(xieguAlcReading(1.7).percent).toBe(100);
    expect(xieguAlcReading(-0.4).percent).toBe(0);
    expect(xieguAlcReading(Number.NaN).percent).toBe(0);
  });

  it('returns null when the rig fails to report an ALC level', async () => {
    await expect(xieguProfile.readAlc!(readCtx(null))).resolves.toBeNull();
  });

  it('reads a live value through the profile', async () => {
    await expect(xieguProfile.readAlc!(readCtx(0.97))).resolves.toMatchObject({
      percent: 97,
      alert: false,
    });
  });
});
