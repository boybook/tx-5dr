import { describe, expect, it } from 'vitest';
import {
  RttyConfigSchema,
  RttyDecoderEventSchema,
  RttyTxAppendSchema,
  resolveRttyAudioTones,
  rttyMarkRfFrequency,
  rttyRadioMode,
  rttyTonesInRange,
} from '../rtty.schema.js';

describe('RTTY contracts', () => {
  it('defaults to 45.45 Bd / 170 Hz on LSB with the signal browser on', () => {
    expect(RttyConfigSchema.parse({})).toMatchObject({
      baud: 45.45,
      shiftHz: 170,
      stopBits: 1.5,
      sideband: 'lsb',
      centerHz: 2210,
      reverse: false,
      scanner: true,
      scannerChannels: 6,
    });
  });

  it('keeps mark the higher RF frequency on either sideband, and REV swaps it', () => {
    const lsb = resolveRttyAudioTones(RttyConfigSchema.parse({}));
    expect(lsb).toEqual({ markHz: 2125, spaceHz: 2295 });
    expect(rttyMarkRfFrequency(14_080_000, RttyConfigSchema.parse({}))).toBe(14_077_875);
    const usb = RttyConfigSchema.parse({ sideband: 'usb' });
    expect(resolveRttyAudioTones(usb)).toEqual({ markHz: 2295, spaceHz: 2125 });
    expect(rttyMarkRfFrequency(14_080_000, usb)).toBe(14_082_295);
    expect(resolveRttyAudioTones(RttyConfigSchema.parse({ reverse: true }))).toEqual({ markHz: 2295, spaceHz: 2125 });
    expect(rttyRadioMode(usb)).toBe('USB');
  });

  it('accepts only tones the modem can use (100–4000 Hz)', () => {
    expect(rttyTonesInRange(RttyConfigSchema.parse({}))).toBe(true);
    expect(rttyTonesInRange(RttyConfigSchema.parse({ centerHz: 400, shiftHz: 850 }))).toBe(false);
    expect(rttyTonesInRange(RttyConfigSchema.parse({ centerHz: 3000, shiftHz: 850 }))).toBe(true);
    expect(rttyTonesInRange(RttyConfigSchema.parse({ centerHz: 650, shiftHz: 1200 }))).toBe(false);
  });

  it('parses live, replay and snapshot character events and resets', () => {
    const character = { ch: 'K', confidence: 0.9, at: 1 };
    expect(RttyDecoderEventSchema.parse({ kind: 'characters', sessionId: 's', sequence: 0, characters: [character] }).kind).toBe('characters');
    expect(RttyDecoderEventSchema.parse({ kind: 'characters', sessionId: 's', sequence: 1, replay: true, replayFrom: 0, characters: [character] })).toMatchObject({ replay: true });
    // A snapshot taken before any live batch carries sequence -1.
    expect(RttyDecoderEventSchema.parse({ kind: 'characters', sessionId: 's', sequence: -1, snapshot: true, characters: [character] })).toMatchObject({ snapshot: true });
    expect(() => RttyDecoderEventSchema.parse({ kind: 'reset', sessionId: 's', reason: 'redecoded' })).toThrow();
    expect(RttyDecoderEventSchema.parse({ kind: 'reset', sessionId: 's', reason: 'cleared' }).kind).toBe('reset');
  });

  it('requires an operator for transmit commands', () => {
    expect(() => RttyTxAppendSchema.parse({ text: 'CQ' })).toThrow();
    expect(RttyTxAppendSchema.parse({ text: 'CQ', operatorId: 'op' }).text).toBe('CQ');
  });
});
