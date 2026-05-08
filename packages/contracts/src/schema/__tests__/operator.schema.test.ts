import { describe, expect, it } from 'vitest';
import {
  CreateRadioOperatorRequestSchema,
  UpdateRadioOperatorRequestSchema,
  sanitizeCallsignInput
} from '../../index.js';
import { MODES } from '../mode.schema.js';

describe('operator callsign normalization', () => {
  it('uppercases callsigns while preserving portable separators', () => {
    expect(sanitizeCallsignInput(' bg5abc/p ')).toBe('BG5ABC/P');
  });

  it('normalizes callsigns in create and update payloads', () => {
    const createPayload = CreateRadioOperatorRequestSchema.parse({
      myCallsign: 'bg5abc/p',
      myGrid: 'OL63',
      frequency: 1000,
      transmitCycles: [0],
      mode: MODES.FT8,
    });
    const updatePayload = UpdateRadioOperatorRequestSchema.parse({
      myCallsign: 'vk9/bg3yza',
    });

    expect(createPayload.myCallsign).toBe('BG5ABC/P');
    expect(updatePayload.myCallsign).toBe('VK9/BG3YZA');
  });
});
