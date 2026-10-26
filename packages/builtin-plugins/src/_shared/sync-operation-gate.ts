import { createSyncFailure, normalizeCallsign, type SyncUploadResult, type SyncDownloadResult } from '@tx5dr/plugin-api';

export class SyncBusyError extends Error {
  readonly code = 'sync_busy';
  constructor(message = 'A synchronization operation is already active for this callsign') { super(message); }
}
/** One instance per Provider. It never schedules work outside the caller's invocation. */
export class SyncOperationGate {
  private tails = new Map<string, Promise<void>>();
  isBusy(callsign: string): boolean { return this.tails.has(normalizeCallsign(callsign)); }
  assertIdle(callsign: string): void { if (this.isBusy(callsign)) throw new SyncBusyError(); }
  async run<T>(callsign: string, action: () => Promise<T>, wait = false): Promise<T> {
    const key = normalizeCallsign(callsign);
    if (!wait) this.assertIdle(callsign);
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(action);
    const tail = result.then(() => undefined, () => undefined);
    this.tails.set(key, tail);
    try { return await result; }
    finally { if (this.tails.get(key) === tail) this.tails.delete(key); }
  }
}
export function busyUpload(providerId: string): SyncUploadResult {
  return { uploaded:0, skipped:0, failed:0, failures:[createSyncFailure({code:'sync_busy',message:'A synchronization operation is already active for this callsign',providerId,operation:'upload',retryable:true})] };
}
export function busyDownload(providerId: string): SyncDownloadResult {
  return { downloaded:0, matched:0, updated:0, failures:[createSyncFailure({code:'sync_busy',message:'A synchronization operation is already active for this callsign',providerId,operation:'download',retryable:true})] };
}
