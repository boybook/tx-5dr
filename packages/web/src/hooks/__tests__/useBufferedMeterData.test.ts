import { describe, expect, it } from 'vitest';
import type { MeterData } from '@tx5dr/contracts';
import { TxMeterEpochGuard } from '../useBufferedMeterData';

describe('TxMeterEpochGuard', () => {
  it('suppresses the previous TX sample across a fast unkey and rekey', () => {
    const guard = new TxMeterEpochGuard();
    const previous: NonNullable<MeterData['power']> = {
      raw: 10,
      percent: null,
      watts: 10,
      maxWatts: null,
    };
    expect(guard.resolve('power', previous, false)).toBeNull();
    expect(guard.resolve('power', previous, true)).toBeNull();

    const current = { ...previous, raw: 12, watts: 12 };
    expect(guard.resolve('power', current, true)).toBe(current);
  });

  it('tracks SWR, ALC, and power independently', () => {
    const guard = new TxMeterEpochGuard();
    const swr: NonNullable<MeterData['swr']> = { raw: 1.2, swr: 1.2, alert: false };
    const alc: NonNullable<MeterData['alc']> = { raw: -2.5, percent: 87.5, alert: true, unit: 'dbfs' };
    guard.resolve('swr', swr, false);
    guard.resolve('alc', alc, false);
    expect(guard.resolve('swr', swr, true)).toBeNull();
    expect(guard.resolve('alc', { ...alc, raw: -4, percent: 80, alert: false }, true)).toMatchObject({ raw: -4 });
  });
});
