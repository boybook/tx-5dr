import { describe, expect, it } from 'vitest';
import { CapabilityDescriptorSchema, CapabilityValueSchema, WriteCapabilityGroupPayloadSchema } from '../src/schema/radio-capability.schema.js';

describe('radio capability group contract', () => {
  it('preserves scalar values and rejects retargeting and nonfinite group values', () => {
    expect(CapabilityValueSchema.safeParse({ low: 10, high: 20 }).success).toBe(false);
    const payload = { groupId: 'rx_filter_band', sessionId: 'session', values: { rx_filter_low: -3000, rx_filter_high: -50 } };
    expect(WriteCapabilityGroupPayloadSchema.parse(payload)).toEqual(payload);
    expect(WriteCapabilityGroupPayloadSchema.safeParse({ ...payload, receiver: 1 }).success).toBe(false);
    expect(WriteCapabilityGroupPayloadSchema.safeParse({ ...payload, values: { rx_filter_low: Infinity } }).success).toBe(false);
  });
  it('validates invertible display transforms', () => {
    const d = { id: 'af_gain', category: 'audio', valueType: 'number', readable: true, writable: true,
      updateMode: 'event', labelI18nKey: 'radio:capability.af_gain.label', hasSurfaceControl: false,
      display: { mode: 'value', unit: 'dB', transform: { scale: 60, offset: -60 } } };
    expect(CapabilityDescriptorSchema.safeParse(d).success).toBe(true);
    expect(CapabilityDescriptorSchema.safeParse({ ...d, display: { ...d.display, transform: { scale: 0, offset: 0 } } }).success).toBe(false);
  });
});
