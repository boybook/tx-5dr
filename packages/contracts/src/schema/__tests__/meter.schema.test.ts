import { describe, expect, it } from 'vitest';
import { MeterDataSchema } from '../websocket.schema.js';

describe('MeterDataSchema', () => {
  it('accepts watts without an invented normalized percentage', () => {
    expect(MeterDataSchema.parse({
      swr: null,
      alc: null,
      level: null,
      power: { raw: 12.5, percent: null, watts: 12.5, maxWatts: null },
    }).power?.percent).toBeNull();
  });

  it('accepts native dBFS ALC while keeping legacy percent messages compatible', () => {
    expect(MeterDataSchema.parse({
      swr: null,
      alc: { raw: -2.5, percent: 87.5, alert: true, unit: 'dbfs' },
      level: null,
      power: null,
    }).alc?.unit).toBe('dbfs');
    expect(MeterDataSchema.parse({
      swr: null,
      alc: { raw: 120, percent: 100, alert: true },
      level: null,
      power: null,
    }).alc?.unit).toBeUndefined();
  });
});
