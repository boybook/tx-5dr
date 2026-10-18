import { describe, expect, it, vi } from 'vitest';
import type { QSORecord, CallsignLogbookAccess, KVStore, PluginContextFor } from '@tx5dr/plugin-api';
import { QRZSyncProvider } from '../qrz-sync/provider.js';
import { LoTWSyncProvider } from '../lotw-sync/provider.js';
import { WaveLogSyncProvider } from '../wavelog-sync/provider.js';

const qso: QSORecord = { id: 'local', callsign: 'JA1ABC', myCallsign: 'BG5DRB', startTime: 1776427200000, frequency: 14074000, mode: 'FT8', messageHistory: [], notes: 'user note' };

describe('concurrent provider local commits', () => {
  it.each([true, false])('preserves user fields and confirmations across revision races (existing=%s)', async existing => {
    const records: QSORecord[] = existing ? [{ ...qso }] : [];
    let revision = 0; let readers = 0; let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const access = {
      readQsoSnapshot: vi.fn(async () => {
        const snapshot = { revision: String(revision), records: structuredClone(records) };
        if (++readers <= 3) { if (readers === 3) release(); await barrier; }
        return snapshot;
      }),
      applyQsoBatch: vi.fn(async (mutations, options) => {
        if (options.expectedRevision !== String(revision)) throw Object.assign(new Error('conflict'), { code: 'LOGBOOK_REVISION_CONFLICT' });
        const outcomes = mutations.map((mutation, inputIndex) => {
          if (mutation.type === 'add') { records.push(mutation.record); return { inputIndex, status: 'added' as const, record: mutation.record }; }
          const index = records.findIndex(record => record.id === mutation.qsoId);
          records[index] = { ...records[index]!, ...mutation.updates };
          return { inputIndex, status: 'updated' as const, record: records[index]! };
        });
        // A concurrent user edit must survive the losing providers' replans.
        records[0] = { ...records[0]!, notes: 'edited during synchronization' };
        revision++; return { revision: String(revision), outcomes };
      }),
      notifyUpdated: vi.fn(async () => {}),
    } satisfies Pick<CallsignLogbookAccess, 'readQsoSnapshot' | 'applyQsoBatch' | 'notifyUpdated'>;
    const memory = new Map<string, unknown>();
    const store = { get: (key: string) => memory.get(key), set: (key: string, value: unknown) => { memory.set(key, value); }, flush: async () => {} } as KVStore;
    const ctx = { store: { global: store }, logbook: { forCallsign: () => access }, log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } } as unknown as PluginContextFor<readonly ['network', 'logbook:read', 'logbook:write']>;
    const qrz = new QRZSyncProvider(ctx);
    qrz.setConfig('BG5DRB', { apiKey: 'test-key', autoUploadQSO: false });
    const download = vi.spyOn(qrz as unknown as { downloadQSOs(key: string): Promise<QSORecord[]> }, 'downloadQSOs').mockResolvedValue([{ ...qso, id: 'qrz', qrzQslReceived: 'Y', qrzQslReceivedDate: 1776500000000 }]);
    const lotw = new LoTWSyncProvider(ctx) as unknown as { processDownloadedRecords(logbook: typeof access, callsign: string, records: QSORecord[]): Promise<unknown> };
    const wavelog = new WaveLogSyncProvider(ctx).sync as unknown as { merge(callsign: string, records: QSORecord[], runtime: unknown): Promise<unknown> };
    await Promise.all([
      qrz.download('BG5DRB'),
      lotw.processDownloadedRecords(access, 'BG5DRB', [{ ...qso, id: 'lotw', lotwQslReceived: 'Y', lotwQslReceivedDate: 1776500000001 }]),
      wavelog.merge('BG5DRB', [{ ...qso, id: 'wavelog', lotwQslSent: 'Y' }], { checkpoint: { receipts: {}, pendingReceipts: {} } }),
    ]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ notes: 'edited during synchronization', frequency: qso.frequency, qrzQslReceived: 'Y', qrzQslReceivedDate: 1776500000000, lotwQslReceived: 'Y', lotwQslReceivedDate: 1776500000001, lotwQslSent: 'Y' });
    expect(download).toHaveBeenCalledTimes(1);
    expect(access.applyQsoBatch.mock.calls.length).toBeGreaterThan(3);
  });
});
