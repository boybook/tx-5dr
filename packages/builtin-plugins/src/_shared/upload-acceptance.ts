import type { CallsignLogbookAccess, KVStore, QSORecord } from '@tx5dr/plugin-api';
import { normalizeCallsign } from '@tx5dr/plugin-api';
import { reconcileLogbookBatch, type LogbookBatchMutation } from './logbook-sync-reconcile.js';

/** Durable remote acceptance facts until the corresponding local sent patch commits. */
export class UploadAcceptance {
  constructor(private store: KVStore, private service: 'qrz' | 'lotw') {}
  private key(callsign: string) { return `accepted:${this.service}:${normalizeCallsign(callsign)}`; }
  private read(callsign: string): Record<string, number> {
    const value = this.store.get<Record<string, number> | undefined>(this.key(callsign)) ?? {};
    if (typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(date => !Number.isFinite(date))) throw new Error('Invalid upload acceptance receipts');
    return value;
  }
  async remember(callsign: string, accepted: ReadonlyMap<string, number>): Promise<void> {
    this.store.set(this.key(callsign), { ...this.read(callsign), ...Object.fromEntries(accepted) });
    await this.store.flush();
  }
  async clear(callsign: string): Promise<void> {
    this.store.set(this.key(callsign), {});
    await this.store.flush();
  }
  async repair(callsign: string, logbook: CallsignLogbookAccess, automatic = false): Promise<void> {
    const receipts = this.read(callsign);
    const ids = Object.keys(receipts);
    if (!ids.length) return;
    const sent = this.service === 'qrz' ? 'qrzQslSent' : 'lotwQslSent';
    const date = this.service === 'qrz' ? 'qrzQslSentDate' : 'lotwQslSentDate';
    const batchSize = automatic ? 100 : ids.length;
    for (let offset = 0; offset < ids.length; offset += batchSize) {
      const batchIds = ids.slice(offset, offset + batchSize);
      const result = await reconcileLogbookBatch(logbook, snapshot => {
        const byId = new Map(snapshot.records.map(record => [record.id, record]));
        const mutations: LogbookBatchMutation[] = [];
        for (const id of batchIds) {
          const current = byId.get(id);
          // A user's deletion does not authorize recreating a QSO from a receipt.
          if (!current) continue;
          const updates: Partial<QSORecord> = {};
          if (current[sent] !== 'Y') updates[sent] = 'Y';
          if (!current[date]) updates[date] = receipts[id];
          if (Object.keys(updates).length) mutations.push({ type: 'update', qsoId: id, updates });
        }
        return { mutations, value: undefined };
      }, 2, automatic ? { ids: batchIds } : undefined);
      for (const id of batchIds) delete receipts[id];
      this.store.set(this.key(callsign), receipts);
      await this.store.flush();
      if (result.batch.outcomes.length) await logbook.notifyUpdated();
    }
  }
}
