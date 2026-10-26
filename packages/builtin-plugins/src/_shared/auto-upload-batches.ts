import type { QSORecord, SyncUploadResult } from '@tx5dr/plugin-api';

/** Bound automatic backlog work while remaining inside the current provider invocation. */
export async function uploadAutomaticBatches(
  records: QSORecord[], upload: (records: QSORecord[]) => Promise<SyncUploadResult>,
): Promise<SyncUploadResult> {
  const result: SyncUploadResult = { submitted: 0, uploaded: 0, skipped: 0, failed: 0 };
  for (let offset = 0; offset < records.length; offset += 100) {
    const batch = await upload(records.slice(offset, offset + 100));
    result.submitted! += batch.submitted ?? batch.uploaded;
    result.uploaded += batch.uploaded; result.skipped += batch.skipped; result.failed += batch.failed;
    if (batch.failures?.length) (result.failures ??= []).push(...batch.failures);
    if (batch.failed || batch.failures?.length) {
      result.failed += Math.max(0, records.length - offset - 100);
      break;
    }
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  return result;
}
