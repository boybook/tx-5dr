import { describe, expect, it } from 'vitest';
import type { CapabilityDescriptor, CapabilityState } from '@tx5dr/contracts';
import { deriveVoiceRadioModeOptions } from '../voiceRadioModeOptions';

function descriptor(options: Array<string | number>): CapabilityDescriptor {
  return {
    id: 'radio_mode',
    category: 'operation',
    valueType: 'enum',
    options: options.map((value) => ({ value })),
    readable: true,
    writable: false,
    updateMode: 'polling',
    labelI18nKey: 'radio:capability.radio_mode.label',
    hasSurfaceControl: false,
  };
}

function state(overrides: Partial<CapabilityState> = {}): CapabilityState {
  return {
    id: 'radio_mode',
    supported: true,
    value: 'USB',
    updatedAt: 1,
    ...overrides,
  };
}

describe('deriveVoiceRadioModeOptions', () => {
  it('orders supported voice modes and includes WFM only when reported', () => {
    expect(deriveVoiceRadioModeOptions(
      descriptor(['WFM', 'USB', 'FM', 'CW']),
      state(),
    )).toEqual(['USB', 'FM', 'WFM']);
  });

  it('falls back to legacy voice modes before capability metadata arrives', () => {
    expect(deriveVoiceRadioModeOptions(undefined, undefined)).toEqual(['USB', 'LSB', 'FM', 'AM']);
  });

  it('keeps WFM selectable when the current capability descriptor supports it', () => {
    const options = deriveVoiceRadioModeOptions(
      descriptor(['USB', 'LSB', 'FM', 'AM', 'WFM']),
      state({ value: 'WFM' }),
    );

    expect(options).toContain('WFM');
  });
});
