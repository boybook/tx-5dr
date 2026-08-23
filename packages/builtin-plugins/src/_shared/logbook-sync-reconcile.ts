import type { QSORecord } from '@tx5dr/contracts';
import type {
  CallsignLogbookAccess,
  LogbookBatchMutation,
  LogbookBatchResult,
  LogbookQsoSnapshot,
} from '@tx5dr/plugin-api';

export type { LogbookBatchMutation, LogbookBatchResult } from '@tx5dr/plugin-api';
export type LogbookSnapshot = LogbookQsoSnapshot;
export type BatchLogbookAccess = Pick<
  CallsignLogbookAccess,
  'readQsoSnapshot' | 'applyQsoBatch'
>;

export interface ReconcilePlan<T> {
  mutations: LogbookBatchMutation[];
  value: T;
}

export interface ReconcileResult<T> {
  value: T;
  batch: LogbookBatchResult;
  attempts: number;
}

function cloneQso(record: QSORecord): QSORecord {
  return {
    ...record,
    messageHistory: [...(record.messageHistory ?? [])],
  };
}

function callsignKey(callsign: string): string {
  return callsign.trim().toUpperCase();
}

/** Mutable, in-memory view used while a provider plans one atomic sync batch. */
export class WorkingLogbookIndex {
  private readonly byId = new Map<string, QSORecord>();
  private readonly byCallsign = new Map<string, QSORecord[]>();

  constructor(records: readonly QSORecord[]) {
    for (const record of records) this.add(record);
  }

  get(id: string): QSORecord | undefined {
    const record = this.byId.get(id);
    return record ? cloneQso(record) : undefined;
  }

  add(record: QSORecord): QSORecord {
    if (this.byId.has(record.id)) {
      throw new Error(`QSO with id ${record.id} already exists in working index`);
    }
    const stored = cloneQso(record);
    this.byId.set(stored.id, stored);
    const key = callsignKey(stored.callsign);
    const bucket = this.byCallsign.get(key) ?? [];
    // Insert before equal timestamps so descending reads preserve stable input order.
    bucket.splice(lowerBound(bucket, stored.startTime), 0, stored);
    this.byCallsign.set(key, bucket);
    return cloneQso(stored);
  }

  replace(record: QSORecord): QSORecord {
    const previous = this.byId.get(record.id);
    if (!previous) {
      throw new Error(`QSO with id ${record.id} not found in working index`);
    }
    const previousKey = callsignKey(previous.callsign);
    const nextKey = callsignKey(record.callsign);
    const stored = cloneQso(record);
    if (previousKey === nextKey && previous.startTime === stored.startTime) {
      const bucket = this.byCallsign.get(previousKey);
      const index = bucket?.findIndex(candidate => candidate.id === stored.id) ?? -1;
      if (bucket && index >= 0) bucket[index] = stored;
      this.byId.set(stored.id, stored);
      return cloneQso(stored);
    }
    if (previousKey !== nextKey) {
      const previousBucket = this.byCallsign.get(previousKey);
      removeFromBucket(previousBucket, record.id);
      if (previousBucket?.length === 0) this.byCallsign.delete(previousKey);
    } else {
      removeFromBucket(this.byCallsign.get(previousKey), record.id);
    }
    this.byId.set(stored.id, stored);
    const nextBucket = this.byCallsign.get(nextKey) ?? [];
    nextBucket.splice(lowerBound(nextBucket, stored.startTime), 0, stored);
    this.byCallsign.set(nextKey, nextBucket);
    return cloneQso(stored);
  }

  queryCallsignTimeRange(
    callsign: string,
    startTime: number,
    endTime: number,
    limit = 25,
  ): QSORecord[] {
    if (limit <= 0) return [];
    const bucket = this.byCallsign.get(callsignKey(callsign)) ?? [];
    const first = lowerBound(bucket, startTime);
    const afterLast = upperBound(bucket, endTime);
    if (first >= afterLast) return [];
    return bucket
      .slice(Math.max(first, afterLast - limit), afterLast)
      .reverse()
      .map(cloneQso);
  }
}

function lowerBound(records: readonly QSORecord[], startTime: number): number {
  let low = 0;
  let high = records.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (records[middle]!.startTime < startTime) low = middle + 1;
    else high = middle;
  }
  return low;
}

function upperBound(records: readonly QSORecord[], startTime: number): number {
  let low = 0;
  let high = records.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (records[middle]!.startTime <= startTime) low = middle + 1;
    else high = middle;
  }
  return low;
}

function removeFromBucket(bucket: QSORecord[] | undefined, id: string): void {
  if (!bucket) return;
  const index = bucket.findIndex(record => record.id === id);
  if (index >= 0) bucket.splice(index, 1);
}

function isRevisionConflict(error: unknown): boolean {
  return !!error
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: unknown }).code === 'LOGBOOK_REVISION_CONFLICT';
}

/**
 * Rebuild a provider-owned plan from a fresh snapshot when another writer wins
 * the optimistic revision race. Remote data remains in the caller's closure.
 */
export async function reconcileLogbookBatch<T>(
  logbook: BatchLogbookAccess,
  planner: (snapshot: LogbookSnapshot) => ReconcilePlan<T>,
  maxReplans = 2,
): Promise<ReconcileResult<T>> {
  for (let replanCount = 0; ; replanCount += 1) {
    const snapshot = await logbook.readQsoSnapshot();
    const plan = planner(snapshot);
    if (plan.mutations.length === 0) {
      return {
        value: plan.value,
        batch: { revision: snapshot.revision, outcomes: [] },
        attempts: replanCount + 1,
      };
    }

    try {
      const batch = await logbook.applyQsoBatch(plan.mutations, {
        expectedRevision: snapshot.revision,
      });
      return { value: plan.value, batch, attempts: replanCount + 1 };
    } catch (error) {
      if (!isRevisionConflict(error) || replanCount >= maxReplans) throw error;
    }
  }
}
