import { describe, expect, it } from 'vitest';
import {
  OBSERVABILITY_NOTICE_VERSION,
  UpdateObservabilitySettingsSchema,
} from '../observability.schema.js';

describe('observability settings schema', () => {
  it('requires acknowledgment of the current notice', () => {
    expect(UpdateObservabilitySettingsSchema.parse({
      enabled: true,
      noticeVersion: OBSERVABILITY_NOTICE_VERSION,
    })).toEqual({ enabled: true, noticeVersion: 1 });
    expect(() => UpdateObservabilitySettingsSchema.parse({ enabled: true, noticeVersion: 0 })).toThrow();
  });
});
