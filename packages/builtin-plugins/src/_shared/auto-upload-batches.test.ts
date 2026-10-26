import { describe, expect, it, vi } from 'vitest';
import type { QSORecord } from '@tx5dr/plugin-api';
import { uploadAutomaticBatches } from './auto-upload-batches.js';

describe('automatic backlog batches', () => {
  it('stops after a failure and reports untouched records so the Host retains them', async () => {
    const records = Array.from({ length: 250 }, (_, i) => ({ id: String(i) } as QSORecord));
    const upload = vi.fn().mockResolvedValueOnce({ submitted: 100, uploaded: 100, skipped: 0, failed: 0 })
      .mockResolvedValueOnce({ submitted: 100, uploaded: 20, skipped: 0, failed: 80, failures: [{ code: 'remote_failed' }] });
    expect(await uploadAutomaticBatches(records, upload)).toMatchObject({ submitted: 200, uploaded: 120, failed: 130 });
    expect(upload.mock.calls.map(([batch]) => batch.length)).toEqual([100, 100]);
  });
});
