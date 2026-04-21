import { describe, expect, it } from 'vitest';
import type { CapabilityDescriptor } from '@tx5dr/contracts';
import {
  findDiscreteOptionIndex,
  getDiscreteNumberOptions,
  getDiscreteOptionDisplayText,
} from './NumberLevelCapability';

function createDescriptor(overrides: Partial<CapabilityDescriptor> = {}): CapabilityDescriptor {
  return {
    id: 'rf_power',
    category: 'rf',
    valueType: 'number',
    range: { min: 0, max: 1, step: 0.01 },
    readable: true,
    writable: true,
    updateMode: 'polling',
    pollIntervalMs: 10000,
    labelI18nKey: 'radio:capability.rf_power.label',
    descriptionI18nKey: 'radio:capability.rf_power.description',
    display: { mode: 'percent', decimals: 0 },
    hasSurfaceControl: false,
    ...overrides,
  };
}

describe('NumberLevelCapability helpers', () => {
  it('keeps continuous descriptors unaffected when no discrete options are present', () => {
    const descriptor = createDescriptor();
    expect(getDiscreteNumberOptions(descriptor)).toEqual([]);
  });

  it('selects the exact discrete option index when the server value matches', () => {
    const descriptor = createDescriptor({
      discreteOptions: [{ value: 0.1 }, { value: 0.5 }, { value: 1 }],
    });

    expect(findDiscreteOptionIndex(getDiscreteNumberOptions(descriptor), 0.5)).toBe(1);
  });

  it('snaps to the nearest discrete option index when the server value is slightly off-grid', () => {
    const descriptor = createDescriptor({
      discreteOptions: [{ value: 0.1 }, { value: 0.5 }, { value: 1 }],
    });

    expect(findDiscreteOptionIndex(getDiscreteNumberOptions(descriptor), 0.51)).toBe(1);
  });

  it('prefers discrete option labels over numeric formatting', () => {
    const descriptor = createDescriptor({
      discreteOptions: [{ value: 0.5, label: '5 W (50%)' }, { value: 1, label: '10 W (100%)' }],
    });

    expect(
      getDiscreteOptionDisplayText(getDiscreteNumberOptions(descriptor), descriptor, 0.5, (key) => key),
    ).toBe('5 W (50%)');
  });
});
