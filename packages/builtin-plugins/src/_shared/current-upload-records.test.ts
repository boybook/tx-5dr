import { describe, expect, it, vi } from 'vitest';
import type { CallsignLogbookReadAccess, QSORecord } from '@tx5dr/plugin-api';
import { currentUploadRecords } from './current-upload-records.js';

const record: QSORecord = { id: 'one', callsign: 'JA1ABC', mode: 'FT8', frequency: 14074000, startTime: 100, messageHistory: [] };
describe('queued upload state refresh', () => {
  it('reads only queued IDs and uses the persisted sent state', async () => {
    const readQsoSnapshot = vi.fn(async () => ({ revision: 'r', records: [{ ...record, qrzQslSent: 'Y' as const }] }));
    const result = await currentUploadRecords({ readQsoSnapshot } as unknown as CallsignLogbookReadAccess, [record]);
    expect(result[0]?.qrzQslSent).toBe('Y');
    expect(readQsoSnapshot).toHaveBeenCalledTimes(1);
    expect(readQsoSnapshot).toHaveBeenCalledWith({ ids: ['one'] });
  });
  it('resolves a moved record by ID and drops deleted records rather than reusing stale data', async () => {
    const readQsoSnapshot = vi.fn().mockResolvedValueOnce({ revision: 'r2', records: [{ ...record, startTime: 300, qrzQslSent: 'Y' }] });
    const access = { readQsoSnapshot } as unknown as CallsignLogbookReadAccess;
    expect(await currentUploadRecords(access, [record, { ...record, id: 'deleted' }])).toEqual([{ ...record, startTime: 300, qrzQslSent: 'Y' }]);
    expect(readQsoSnapshot).toHaveBeenCalledTimes(1);
    expect(readQsoSnapshot).toHaveBeenCalledWith({ ids: ['one', 'deleted'] });
  });
});
