import { describe, expect, it } from 'vitest';
import { LogBookExportOptionsSchema, LogBookQSOQueryOptionsSchema } from '../logbook.schema.js';

describe('logbook DXCC review filter', () => {
  it('decodes the review flag from the query string', () => {
    expect(LogBookQSOQueryOptionsSchema.parse({ dxccNeedsReview: 'true' }).dxccNeedsReview).toBe(true);
    expect(LogBookQSOQueryOptionsSchema.parse({}).dxccNeedsReview).toBeUndefined();
    expect(LogBookQSOQueryOptionsSchema.parse({ dxccNeedsReview: undefined }).dxccNeedsReview).toBeUndefined();
  });

  it('rejects values that do not mean "review only"', () => {
    expect(() => LogBookQSOQueryOptionsSchema.parse({ dxccNeedsReview: 'false' })).toThrow();
  });

  it('applies the same decoding to export options', () => {
    expect(LogBookExportOptionsSchema.parse({ dxccNeedsReview: 'true' }).dxccNeedsReview).toBe(true);
  });
});
