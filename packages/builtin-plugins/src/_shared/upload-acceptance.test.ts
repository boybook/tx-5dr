import { describe, expect, it, vi } from 'vitest';
import type { CallsignLogbookAccess, KVStore, QSORecord } from '@tx5dr/plugin-api';
import { UploadAcceptance } from './upload-acceptance.js';

describe('automatic acceptance repair', () => {
  it('keeps only unfinished receipts after a bounded repair fails and resumes without losing other fields', async () => {
    const memory = new Map<string, unknown>();
    const store = { get: (key: string) => structuredClone(memory.get(key)), set: (key: string, value: unknown) => { memory.set(key, structuredClone(value)); }, flush: vi.fn(async () => {}) } as unknown as KVStore;
    const records = Array.from({ length: 150 }, (_, i) => ({ id: String(i), callsign: 'JA1ABC', frequency: 14074000, mode: 'FT8', startTime: 100, messageHistory: [], notes: 'user edit', lotwQslReceived: 'Y' } as QSORecord));
    let fail = true;
    const logbook = {
      readQsoSnapshot: vi.fn(async (filter: { ids: string[] }) => {
        expect(filter.ids.length).toBeLessThanOrEqual(100);
        return { revision: 'r', records: records.filter(record => filter.ids.includes(record.id)) };
      }),
      applyQsoBatch: vi.fn(async (mutations: Array<{ qsoId: string; updates: Partial<QSORecord> }>) => {
        if (fail && mutations[0]?.qsoId === '100') throw Object.assign(new Error('conflict'), { code: 'LOGBOOK_REVISION_CONFLICT' });
        return { revision: 'r2', outcomes: mutations.map((mutation, inputIndex) => {
          const record = records.find(record => record.id === mutation.qsoId)!;
          Object.assign(record, mutation.updates);
          return { inputIndex, status: 'updated' as const, record };
        }) };
      }),
      notifyUpdated: vi.fn(async () => {}),
    } as unknown as CallsignLogbookAccess;
    const acceptance = new UploadAcceptance(store, 'qrz');
    await acceptance.remember('BG5DRB', new Map(records.map(record => [record.id, 200])));
    await expect(acceptance.repair('BG5DRB', logbook, true)).rejects.toThrow('conflict');
    expect(Object.keys(memory.get('accepted:qrz:BG5DRB') as object)).toHaveLength(50);
    fail = false; await acceptance.repair('BG5DRB', logbook, true);
    expect(memory.get('accepted:qrz:BG5DRB')).toEqual({});
    expect(records.every(record => record.qrzQslSent === 'Y' && record.notes === 'user edit' && record.lotwQslReceived === 'Y')).toBe(true);
  });
});
