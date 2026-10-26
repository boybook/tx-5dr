import { describe, expect, it } from 'vitest';
import { SyncStatusSchema, SyncActionSchema } from '../logbook-sync.schema.js';
const status = { operationId: 'sync', revision: 1, operation: 'full_sync', state: 'running', stage: 'downloading',
  startedAt: 1, updatedAt: 2, processed: 0, downloaded: 0, imported: 0, updated: 0, uploaded: 0, skipped: 0, failed: 0,
  conflicts: 0, resumable: true, errors: [] };
describe('sync status boundary', () => {
  it('rejects unknown properties, invalid counters and oversized errors', () => {
    expect(SyncStatusSchema.safeParse(status).success).toBe(true);
    for (const extra of [{ apiKey: 'secret' }, { failed: -1 }, { revision: 1.5 }, { rejected: -1 }, { errors: Array(21).fill({ code: 'error', message: 'failure' }) }]) {
      expect(SyncStatusSchema.safeParse({ ...status, ...extra }).success).toBe(false);
    }
  });
  it('defaults the rejection counter for statuses written before it existed', () => {
    expect(SyncStatusSchema.parse(status).rejected).toBe(0);
    expect(SyncStatusSchema.parse({ ...status, rejected: 3 }).rejected).toBe(3);
  });
  it('tolerates extra fields on projected failures', () => {
    const parsed = SyncStatusSchema.parse({
      ...status,
      errors: [{ code: 'x', message: 'y', source: 'host', retryable: true }],
    });
    expect(parsed.errors[0]).toMatchObject({ code: 'x', message: 'y' });
    expect(parsed.errors[0]).not.toHaveProperty('source');
  });
});

describe('sync action parameters', () => {
  it('accepts legacy operations and opt-in parameterized pages', () => {
    expect(SyncActionSchema.parse({ id: 'up', label: 'Upload', operation: 'upload' }).operation).toBe('upload');
    expect(SyncActionSchema.parse({ id: 'up', label: 'Upload', pageId: 'progress', pageParams: { intent: 'start', operation: 'upload' } }).pageParams).toEqual({ intent: 'start', operation: 'upload' });
  });
  it('rejects reserved binding and authentication fields and ambiguous actions', () => {
    for (const key of ['callsign', 'operatorId', 'launchId', 'auth_token', '_session', 'apiKey']) {
      expect(SyncActionSchema.safeParse({ id: 'up', label: 'Upload', pageId: 'progress', pageParams: { [key]: 'override' } }).success).toBe(false);
    }
    expect(SyncActionSchema.safeParse({ id: 'up', label: 'Upload', pageId: 'progress', operation: 'upload' }).success).toBe(false);
    expect(SyncActionSchema.safeParse({ id: 'up', label: 'Upload', operation: 'upload', pageParams: {} }).success).toBe(false);
  });
});
