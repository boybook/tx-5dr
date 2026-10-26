import type { CallsignLogbookReadAccess, QSORecord } from '@tx5dr/plugin-api';

/** Refresh queued records inside the provider gate reading only their exact persisted IDs. */
export async function currentUploadRecords(logbook: CallsignLogbookReadAccess, records: QSORecord[], allowUnpersisted = false): Promise<QSORecord[]> {
  if (records.length === 0) return [];
  const current = new Map<string, QSORecord>();
  for (let offset = 0; offset < records.length; offset += 1000) {
    const snapshot = await logbook.readQsoSnapshot({ ids: records.slice(offset, offset + 1000).map(record => record.id) });
    for (const record of snapshot.records) current.set(record.id, record);
  }
  return records.flatMap(record => current.get(record.id) ?? (allowUnpersisted ? record : []));
}
