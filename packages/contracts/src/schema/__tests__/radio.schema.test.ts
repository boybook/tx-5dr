import { describe, expect, it } from 'vitest';
import { PresetFrequencySchema } from '../radio.schema.js';

describe('PresetFrequencySchema repeater DUP fields', () => {
  it('accepts existing presets without repeater DUP fields', () => {
    const parsed = PresetFrequencySchema.parse({
      band: '2m',
      mode: 'VOICE',
      radioMode: 'FM',
      frequency: 145000000,
      description: '145.000 MHz 2m FM',
    });

    expect(parsed.repeaterShift).toBeUndefined();
    expect(parsed.repeaterOffsetHz).toBeUndefined();
  });

  it('accepts plus or minus DUP presets with positive Hz offsets', () => {
    const parsed = PresetFrequencySchema.parse({
      band: '2m',
      mode: 'VOICE',
      radioMode: 'FM',
      frequency: 145000000,
      repeaterShift: 'plus',
      repeaterOffsetHz: 600000,
    });

    expect(parsed.repeaterShift).toBe('plus');
    expect(parsed.repeaterOffsetHz).toBe(600000);
  });

  it('rejects DUP direction without a positive offset', () => {
    expect(() => PresetFrequencySchema.parse({
      band: '2m',
      mode: 'VOICE',
      radioMode: 'FM',
      frequency: 145000000,
      repeaterShift: 'minus',
    })).toThrow();

    expect(() => PresetFrequencySchema.parse({
      band: '2m',
      mode: 'VOICE',
      radioMode: 'FM',
      frequency: 145000000,
      repeaterShift: 'minus',
      repeaterOffsetHz: 0,
    })).toThrow();
  });

  it('rejects invalid DUP directions', () => {
    expect(() => PresetFrequencySchema.parse({
      band: '2m',
      mode: 'VOICE',
      radioMode: 'FM',
      frequency: 145000000,
      repeaterShift: 'up',
      repeaterOffsetHz: 600000,
    })).toThrow();
  });

  it('rejects DUP presets outside VOICE FM', () => {
    expect(() => PresetFrequencySchema.parse({
      band: '20m',
      mode: 'VOICE',
      radioMode: 'USB',
      frequency: 14270000,
      repeaterShift: 'plus',
      repeaterOffsetHz: 600000,
    })).toThrow();
  });
});

describe('PresetFrequencySchema tone squelch fields', () => {
  it('accepts CTCSS tone presets with positive 0.1 Hz values', () => {
    const parsed = PresetFrequencySchema.parse({
      band: '2m',
      mode: 'VOICE',
      radioMode: 'FM',
      frequency: 145000000,
      toneMode: 'ctcss',
      ctcssToneTenthsHz: 885,
    });

    expect(parsed.toneMode).toBe('ctcss');
    expect(parsed.ctcssToneTenthsHz).toBe(885);
  });

  it('accepts DCS presets with positive codes', () => {
    const parsed = PresetFrequencySchema.parse({
      band: '2m',
      mode: 'VOICE',
      radioMode: 'FM',
      frequency: 145000000,
      toneMode: 'dcs',
      dcsCode: 23,
    });

    expect(parsed.toneMode).toBe('dcs');
    expect(parsed.dcsCode).toBe(23);
  });

  it('rejects tone squelch modes without required values', () => {
    expect(() => PresetFrequencySchema.parse({
      band: '2m',
      mode: 'VOICE',
      radioMode: 'FM',
      frequency: 145000000,
      toneMode: 'ctcss',
    })).toThrow();

    expect(() => PresetFrequencySchema.parse({
      band: '2m',
      mode: 'VOICE',
      radioMode: 'FM',
      frequency: 145000000,
      toneMode: 'dcs',
    })).toThrow();
  });

  it('rejects invalid tone squelch values and modes', () => {
    expect(() => PresetFrequencySchema.parse({
      band: '2m',
      mode: 'VOICE',
      radioMode: 'FM',
      frequency: 145000000,
      toneMode: 'ctcss',
      ctcssToneTenthsHz: 0,
    })).toThrow();

    expect(() => PresetFrequencySchema.parse({
      band: '2m',
      mode: 'VOICE',
      radioMode: 'FM',
      frequency: 145000000,
      toneMode: 'dcs',
      dcsCode: -1,
    })).toThrow();

    expect(() => PresetFrequencySchema.parse({
      band: '2m',
      mode: 'VOICE',
      radioMode: 'FM',
      frequency: 145000000,
      toneMode: 'tone',
      ctcssToneTenthsHz: 885,
    })).toThrow();
  });

  it('rejects tone squelch presets outside VOICE FM', () => {
    expect(() => PresetFrequencySchema.parse({
      band: '20m',
      mode: 'VOICE',
      radioMode: 'USB',
      frequency: 14270000,
      toneMode: 'ctcss',
      ctcssToneTenthsHz: 885,
    })).toThrow();
  });
});
