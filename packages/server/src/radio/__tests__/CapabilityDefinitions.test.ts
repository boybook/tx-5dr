import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_DEFINITION_MAP,
  isCapabilityTemporarilyDisabled,
} from '../capabilities/definitions.js';

describe('capability safety quarantine', () => {
  it('disables TX audio input reads and writes for every backend/model', () => {
    const definition = CAPABILITY_DEFINITION_MAP.get('tx_audio_input_source');

    expect(isCapabilityTemporarilyDisabled('tx_audio_input_source')).toBe(true);
    expect(definition).toBeDefined();
    const quarantined = definition!;
    expect(quarantined.descriptor.readable).toBe(false);
    expect(quarantined.descriptor.writable).toBe(false);
    expect(quarantined.descriptor.options).toEqual([]);
    expect(quarantined.probeSupport({} as never)).resolves.toBe(false);
    expect(quarantined.read).toBeUndefined();
    expect(quarantined.write).toBeUndefined();
  });
});
