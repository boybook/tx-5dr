import { describe, expect, it } from 'vitest';

import {
  EngineModeSchema,
  ImageRadioCapabilitySchema,
  ImageHistoryRecordSchema,
  ImageComposerBackgroundSchema,
  ImagePaperBoundarySchema,
  ImageFaxCalibrationSchema,
  FaxCalibrationSetCommandSchema,
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
    const parsedTemplate = ImageTemplateSchema.parse({ id: 'legacy', name: 'Legacy', layers: [layer], createdAt: 1, updatedAt: 1 });
    expect(parsedTemplate.layers[0]).toMatchObject({ align: 'center', rotation: 0, strokeWidth: 0.12 });
    expect(ImageTemplateSchema.parse({ ...parsedTemplate, layers: [{ ...parsedTemplate.layers[0], rotation: 45 }] }).layers[0].rotation).toBe(45);
    expect(ImageTemplateSchema.parse({ ...parsedTemplate, layers: [{ ...parsedTemplate.layers[0], x: -0.5, width: 2 }] }).layers[0]).toMatchObject({ x: -0.5, width: 2 });
    expect(() => ImageTemplateSchema.parse({ ...parsedTemplate, layers: [{ ...parsedTemplate.layers[0], rotation: 181 }] })).toThrow();
    expect(() => ImageTemplateSchema.parse({ ...parsedTemplate, layers: [{ ...parsedTemplate.layers[0], strokeWidth: 0.51 }] })).toThrow();
    expect(() => ImageTemplateSchema.parse({ ...parsedTemplate, layers: [{ ...parsedTemplate.layers[0], x: -2.1 }] })).toThrow();
    expect(() => ImageTemplateSchema.parse({ id: 't', name: 'T', layers: Array.from({ length: 17 }, (_, index) => ({ ...layer, id: String(index) })), createdAt: 1, updatedAt: 1 })).toThrow();
    expect(SstvTxStartCommandSchema.parse({ requestId: 'request-1', operatorId: 'op', artifactId: 'a', mode: 'robot36', expectedFrequency: 14_230_000 })).toMatchObject({
      requestId: 'request-1', envelope: { enhancedPreamble: true, stationIdMode: 'fsk' },
    });
    expect(SstvTxStartCommandSchema.parse({ requestId: 'request-2', operatorId: 'op', artifactId: 'a', mode: 'robot36', expectedFrequency: 14_230_000, interruptActiveCapture: true }).interruptActiveCapture).toBe(true);
    expect(SstvTxStartCommandSchema.parse({
      requestId: 'request-3', operatorId: 'op', artifactId: 'a', mode: 'robot36', expectedFrequency: 14_230_000,
      envelope: { enhancedPreamble: true, stationIdMode: 'cw' },
    }).envelope).toEqual({ enhancedPreamble: true, stationIdMode: 'cw' });
  });

  it('separates received captures from real transmit history', () => {
    expect(ImageHistoryRecordSchema.parse({
      id: 'rx', artifactId: 'image', family: 'sstv', direction: 'rx', occurredAt: 1,
      saveReason: 'manual', complete: false, truncated: false,
    }).direction).toBe('rx');
    expect(ImageHistoryRecordSchema.parse({
      id: 'tx', artifactId: 'image', family: 'sstv', direction: 'tx', operatorId: 'op',
      sessionId: 'session', occurredAt: 1, startedAt: 1, outcome: 'completed',
    }).direction).toBe('tx');
    expect(() => ImageHistoryRecordSchema.parse({
      id: 'tx', artifactId: 'image', family: 'sstv', direction: 'tx',
      sessionId: 'session', occurredAt: 1, startedAt: 1, outcome: 'completed',
    })).toThrow();
  });

  it('distinguishes local transmit paper segments from received content', () => {
    const boundary = ImagePaperBoundarySchema.parse({
      boundaryId: 'tx:start', lineIndex: 12, kind: 'localTxStart', trusted: false,
      codecMode: 'robot36', width: 320, pixelFormat: 'rgb8', timestamp: 1,
      source: 'localTx', txSessionId: 'tx-1',
    });
    expect(boundary).toMatchObject({ kind: 'localTxStart', source: 'localTx', txSessionId: 'tx-1' });
  });

  it('validates per-operator composer background metadata', () => {
    expect(ImageComposerBackgroundSchema.parse({
      operatorId: 'op', width: 1024, height: 512, updatedAt: 1, imageUrl: '/background.png',
    }).operatorId).toBe('op');
    expect(() => ImageComposerBackgroundSchema.parse({
      operatorId: '', width: 1024, height: 512, updatedAt: 1, imageUrl: '/background.png',
    })).toThrow();
  });

  it('bounds FAX calibration commands and control points', () => {
    const calibration = ImageFaxCalibrationSchema.parse({
      boundaryId: 'fax:1', revision: 2, autoEnabled: true,
      autoPoints: [{ revision: 1, referenceLine: 10, phasePixels: 2, clockPpm: 25, confidence: 0.8, source: 'phasing', status: 'locked' }],
      manualPhasePixels: 0, manualClockPpm: 0, updatedAt: 1,
    });
    expect(calibration.autoPoints[0].clockPpm).toBe(25);
    expect(FaxCalibrationSetCommandSchema.parse({
      requestId: 'r', operatorId: 'op', sessionId: 's', boundaryId: 'fax:1', expectedRevision: 2,
      autoEnabled: true, phasePixels: 10, clockPpm: 5000,
    }).clockPpm).toBe(5000);
    expect(() => FaxCalibrationSetCommandSchema.parse({
      requestId: 'r', operatorId: 'op', sessionId: 's', boundaryId: 'fax:1', expectedRevision: 2,
      autoEnabled: true, phasePixels: 10, clockPpm: 5001,
    })).toThrow();
  });
});
