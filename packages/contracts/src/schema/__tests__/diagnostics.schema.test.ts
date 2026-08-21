import { describe, expect, it } from 'vitest';
import { CreateDiagnosticUploadRequestSchema } from '../diagnostics.schema.js';

describe('diagnostic upload request schema', () => {
  it('accepts one supported source and a bounded range', () => {
    expect(CreateDiagnosticUploadRequestSchema.parse({
      sourceId: 'server',
      fromMs: 1_777_000_000_000,
      toMs: 1_777_003_600_000,
      feedback: '  Radio stopped  ',
    })).toMatchObject({ sourceId: 'server', feedback: 'Radio stopped' });
  });

  it('rejects arbitrary sources, oversized feedback, and ranges over seven days', () => {
    expect(() => CreateDiagnosticUploadRequestSchema.parse({
      sourceId: '/tmp/arbitrary.log',
      fromMs: 1_777_000_000_000,
      toMs: 1_777_003_600_000,
    })).toThrow();
    expect(() => CreateDiagnosticUploadRequestSchema.parse({
      sourceId: 'server',
      fromMs: 1_777_000_000_000,
      toMs: 1_777_000_000_000 + (8 * 24 * 60 * 60 * 1000),
    })).toThrow();
    expect(() => CreateDiagnosticUploadRequestSchema.parse({
      sourceId: 'server',
      fromMs: 1_777_000_000_000,
      toMs: 1_777_003_600_000,
      feedback: 'x'.repeat(2001),
    })).toThrow();
  });
});
