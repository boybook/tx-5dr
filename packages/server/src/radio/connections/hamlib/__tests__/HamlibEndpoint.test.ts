import { describe, expect, it, vi } from 'vitest';

vi.mock('hamlib', () => ({ HamLib: class {} }));

const { HamlibEndpoint } = await import('../HamlibEndpoint.js');

describe('HamlibEndpoint', () => {
  it('drops a malformed telemetry frame without throwing into the emitting runtime', () => {
    const endpoint = new HamlibEndpoint();
    const events: string[] = [];
    endpoint.on('event', payload => events.push(payload.event));
    const badMeter = { swr: { raw: Number.NaN, swr: Infinity, alert: false }, alc: null, level: null, power: null };
    expect(() => endpoint.runtime.emit('meterData', badMeter as never)).not.toThrow();
    endpoint.runtime.emit('frequencyChanged', 14074000);
    expect(events).toEqual(['frequencyChanged']);
  });
});
