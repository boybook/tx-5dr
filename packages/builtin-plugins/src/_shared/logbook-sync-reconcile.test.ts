import { describe, expect, it, vi } from 'vitest';

import type { QSORecord } from '@tx5dr/contracts';
import {
  reconcileLogbookBatch,
  WorkingLogbookIndex,
  type BatchLogbookAccess,
} from './logbook-sync-reconcile.js';

function qso(id: string, callsign: string, startTime: number): QSORecord {
  return {
    id,
    callsign,
    frequency: 14_074_000,
    mode: 'FT8',
    startTime,
    messageHistory: [],
  };
}

describe('WorkingLogbookIndex', () => {
  it('queries exact callsigns and reflects staged additions and replacements', () => {
    const index = new WorkingLogbookIndex([
      qso('one', 'JA1ABC', 100),
      qso('portable', 'JA1ABC/P', 105),
    ]);

    index.add(qso('two', 'ja1abc', 110));
    index.replace({ ...qso('one', 'JA1ABC', 100), notes: 'updated' });

    expect(index.queryCallsignTimeRange('ja1abc', 90, 120)).toEqual([
      expect.objectContaining({ id: 'two' }),
      expect.objectContaining({ id: 'one', notes: 'updated' }),
    ]);
    expect(index.queryCallsignTimeRange('JA1ABC/P', 90, 120)).toEqual([
      expect.objectContaining({ id: 'portable' }),
    ]);
  });

  it('returns the newest bounded candidates from an inclusive time range', () => {
    const index = new WorkingLogbookIndex([
      qso('late', 'JA1ABC', 300),
      qso('early', 'JA1ABC', 100),
      qso('middle', 'JA1ABC', 200),
      qso('outside', 'JA1ABC', 400),
    ]);

    expect(index.queryCallsignTimeRange('JA1ABC', 100, 300, 2).map(record => record.id))
      .toEqual(['late', 'middle']);
  });
});

describe('reconcileLogbookBatch', () => {
  it('replans revision conflicts without re-running remote work', async () => {
    const readQsoSnapshot = vi.fn()
      .mockResolvedValueOnce({ revision: 'one', records: [] })
      .mockResolvedValueOnce({ revision: 'two', records: [] });
    const conflict = Object.assign(new Error('conflict'), { code: 'LOGBOOK_REVISION_CONFLICT' });
    const applyQsoBatch = vi.fn()
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ revision: 'three', outcomes: [] });
    const planner = vi.fn(() => ({
      mutations: [{ type: 'add' as const, record: qso('one', 'JA1ABC', 100) }],
      value: { imported: 1 },
    }));

    const result = await reconcileLogbookBatch(
      { readQsoSnapshot, applyQsoBatch } as BatchLogbookAccess,
      planner,
    );

    expect(result.attempts).toBe(2);
    expect(planner).toHaveBeenCalledTimes(2);
    expect(applyQsoBatch).toHaveBeenNthCalledWith(2, expect.any(Array), {
      expectedRevision: 'two',
    });
  });

  it('does not call the write API for an empty plan', async () => {
    const logbook: BatchLogbookAccess = {
      readQsoSnapshot: vi.fn(async () => ({ revision: 'one', records: [] })),
      applyQsoBatch: vi.fn(),
    };

    const result = await reconcileLogbookBatch(logbook, () => ({
      mutations: [],
      value: 'noop',
    }));

    expect(result.value).toBe('noop');
    expect(logbook.applyQsoBatch).not.toHaveBeenCalled();
  });
});
