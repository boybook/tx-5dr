import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_IDS,
  CapabilityDescriptorSchema,
  CapabilityStateSchema,
  type CapabilityId,
} from '../src/schema/radio-capability.schema';

describe('CAPABILITY_IDS', () => {
  it('includes radio_mode for dynamic voice radio mode discovery', () => {
    const id: CapabilityId = 'radio_mode';

    expect(CAPABILITY_IDS).toContain(id);
  });

  it('accepts radio_mode as an enum capability descriptor and state', () => {
    expect(CapabilityDescriptorSchema.parse({
      id: 'radio_mode',
      category: 'operation',
      valueType: 'enum',
      options: [{ value: 'USB' }, { value: 'WFM' }],
      readable: true,
      writable: false,
      updateMode: 'polling',
      labelI18nKey: 'radio:capability.radio_mode.label',
      hasSurfaceControl: false,
    })).toMatchObject({
      id: 'radio_mode',
      valueType: 'enum',
      options: [{ value: 'USB' }, { value: 'WFM' }],
    });

    expect(CapabilityStateSchema.parse({
      id: 'radio_mode',
      supported: true,
      value: 'WFM',
      updatedAt: 1,
    })).toMatchObject({
      id: 'radio_mode',
      supported: true,
      value: 'WFM',
    });
  });
});
