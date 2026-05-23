import { describe, expect, it } from 'vitest';
import {
  CreateRadioOperatorRequestSchema,
  UpdateRadioOperatorRequestSchema,
  sanitizeCallsignInput,
  sanitizeGridInput,
} from '../../index.js';
import { MODES } from '../mode.schema.js';

describe('operator callsign normalization', () => {
  it('uppercases callsigns while preserving portable separators', () => {
    expect(sanitizeCallsignInput(' bg5abc/p ')).toBe('BG5ABC/P');
  });

  it('uppercases grids and removes whitespace', () => {
    expect(sanitizeGridInput(' ol 63aa ')).toBe('OL63AA');
  });

  it('normalizes callsigns and grids in create and update payloads', () => {
    const createPayload = CreateRadioOperatorRequestSchema.parse({
      myCallsign: 'bg5abc/p',
      myGrid: 'ol63aa',
      frequency: 1000,
      transmitCycles: [0],
      mode: MODES.FT8,
    });
    const updatePayload = UpdateRadioOperatorRequestSchema.parse({
      myCallsign: 'vk9/bg3yza',
      myGrid: 'pm01',
    });

    expect(createPayload.myCallsign).toBe('BG5ABC/P');
    expect(createPayload.myGrid).toBe('OL63AA');
    expect(updatePayload.myCallsign).toBe('VK9/BG3YZA');
    expect(updatePayload.myGrid).toBe('PM01');
  });
});
