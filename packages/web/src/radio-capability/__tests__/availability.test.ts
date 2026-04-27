import { describe, expect, it } from 'vitest';
import type { CapabilityState } from '@tx5dr/contracts';
import {
  getCapabilityAvailability,
  getCapabilityUnavailableText,
  isCapabilityAvailable,
  isCapabilityInteractive,
} from '../availability';

const t = (key: string, defaultValue?: string) => defaultValue ?? key;

function state(overrides: Partial<CapabilityState>): CapabilityState {
  return {
    id: 'sql',
    supported: true,
    availability: 'available',
    value: 0.5,
    updatedAt: 1,
    ...overrides,
  };
}

describe('capability availability helpers', () => {
  it('treats missing availability as available for supported legacy states', () => {
    const legacy = state({ availability: undefined });

    expect(getCapabilityAvailability(legacy)).toBe('available');
    expect(isCapabilityAvailable(legacy)).toBe(true);
    expect(isCapabilityInteractive(legacy, true, true)).toBe(true);
  });

  it('disables supported controls that are currently unavailable', () => {
    const unavailable = state({
      availability: 'unavailable',
      availabilityReason: 'runtime_error',
      value: null,
    });

    expect(isCapabilityAvailable(unavailable)).toBe(false);
    expect(isCapabilityInteractive(unavailable, true, true)).toBe(false);
    expect(getCapabilityUnavailableText(unavailable, t)).toBe('Radio reported this control is currently unavailable.');
  });

  it('uses the tuner-specific unavailable message for supported tuner capabilities', () => {
    const tuner = state({
      id: 'tuner_switch',
      availability: 'unavailable',
      availabilityReason: 'runtime_error',
      value: null,
    });

    expect(getCapabilityUnavailableText(tuner, t, 'tuner_switch')).toBe(
      'Tuner not connected.',
    );
  });
});
