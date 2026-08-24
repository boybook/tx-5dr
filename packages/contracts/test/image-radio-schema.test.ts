import { describe, expect, it } from 'vitest';

import {
  EngineModeSchema,
  ImageRadioCapabilitySchema,
  ImageReceiveProfileSchema,
  ImageTemplateSchema,
  SstvTxStartCommandSchema,
} from '../src/index.js';

describe('image radio contracts', () => {
  it('adds image as an engine mode', () => {
    expect(EngineModeSchema.parse('image')).toBe('image');
  });

  it('keeps fax receive-only at the schema boundary', () => {
    const base = { available: true, sstv: { rx: true, tx: true }, fax: { rx: true, tx: false } };
    expect(ImageRadioCapabilitySchema.parse(base).fax.tx).toBe(false);
    expect(() => ImageRadioCapabilitySchema.parse({ ...base, fax: { rx: true, tx: true } })).toThrow();
  });

  it('separates automatic SSTV from fixed immediate receive profiles', () => {
    expect(ImageReceiveProfileSchema.parse({ family: 'sstv', strategy: 'auto' })).toEqual({ family: 'sstv', strategy: 'auto' });
    expect(ImageReceiveProfileSchema.parse({ family: 'sstv', strategy: 'manual', mode: 'robot36' }).mode).toBe('robot36');
    expect(() => ImageReceiveProfileSchema.parse({ family: 'sstv', strategy: 'manual' })).toThrow();
    expect(ImageReceiveProfileSchema.parse({ family: 'fax', strategy: 'auto' })).toEqual({ family: 'fax', strategy: 'auto' });
    expect(ImageReceiveProfileSchema.parse({
      family: 'fax', strategy: 'manual', ioc: 'ioc576', lpm: 120,
      modulation: 'am', centerHz: 1900, deviationHz: 400,
    }).family).toBe('fax');
  });

  it('bounds templates and validates idempotent TX requests', () => {
    const layer = { id: 'line', text: '{MYCALL}', x: 0, y: 0, width: 1, height: 0.2, fontSize: 0.1, color: '#ffffff', align: 'center' };
    expect(() => ImageTemplateSchema.parse({ id: 't', name: 'T', layers: Array.from({ length: 17 }, (_, index) => ({ ...layer, id: String(index) })), createdAt: 1, updatedAt: 1 })).toThrow();
    expect(SstvTxStartCommandSchema.parse({ requestId: 'request-1', operatorId: 'op', artifactId: 'a', mode: 'robot36', expectedFrequency: 14_230_000 }).requestId).toBe('request-1');
  });
});
