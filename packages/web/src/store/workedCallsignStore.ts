import { useEffect, useSyncExternalStore } from 'react';
import { api, getBandFromFrequency } from '@tx5dr/core';
import type { QSORecord } from '@tx5dr/contracts';
import { createLogger } from '../utils/logger';

const logger = createLogger('WorkedCallsignStore');

/**
 * `dupe`: already worked on this band in this mode (contest dupe);
 * `worked`: worked before on another band or mode; `new`: never worked.
 */
export type WorkedStatus = 'new' | 'worked' | 'dupe';

interface WorkedContext {
  logbookId: string;
  band: string | null;
  mode: string;
}

const MAX_CONCURRENT = 2;
const LOOKUP_LIMIT = 50;

/**
 * Lazily looks up whether callsigns seen on screen are in the operator's
 * logbook. Lookups are cached per logbook/band/mode and updated from new QSOs.
 */
class WorkedCallsignStore {
  private context: WorkedContext | null = null;
  private records = new Map<string, QSORecord[]>();
  private statuses = new Map<string, WorkedStatus>();
  private queue: string[] = [];
  /** Callsigns on screen; looked up again for a new logbook. */
  private wanted = new Set<string>();
  private inFlight = new Set<string>();
  private listeners = new Set<() => void>();
  private generation = 0;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  setContext(next: WorkedContext | null): void {
    const current = this.context;
    if (current && next && current.logbookId === next.logbookId && current.band === next.band && current.mode === next.mode) return;
    const logbookChanged = current?.logbookId !== next?.logbookId;
    this.context = next;
    if (logbookChanged) {
      this.generation += 1;
      this.records.clear();
      this.queue = [];
      this.inFlight.clear();
    }
    this.statuses.clear();
    for (const [callsign, records] of this.records) this.statuses.set(callsign, this.classify(records));
    if (logbookChanged && next) for (const callsign of this.wanted) this.request(callsign);
    this.notify();
  }

  get(callsign: string): WorkedStatus | undefined {
    return this.statuses.get(callsign);
  }

  request(callsign: string): void {
    this.wanted.add(callsign);
    if (this.wanted.size > 2_000) this.wanted.delete(this.wanted.values().next().value!);
    if (!this.context || this.records.has(callsign) || this.inFlight.has(callsign) || this.queue.includes(callsign)) return;
    this.queue.push(callsign);
    this.pump();
  }

  /** Applies a QSO logged or edited while the screen is open. */
  noteQso(logbookId: string, record: QSORecord): void {
    if (!this.context || logbookId.toUpperCase() !== this.context.logbookId.toUpperCase()) return;
    const callsign = record.callsign.toUpperCase();
    const records = (this.records.get(callsign) ?? []).filter((item) => item.id !== record.id);
    records.push(record);
    this.records.set(callsign, records);
    this.statuses.set(callsign, this.classify(records));
    this.notify();
  }

  private classify(records: QSORecord[]): WorkedStatus {
    if (records.length === 0) return 'new';
    const { band, mode } = this.context ?? { band: null, mode: '' };
    const dupe = records.some((record) => (record.mode || '').toUpperCase() === mode
      && band !== null && getBandFromFrequency(record.frequency) === band);
    return dupe ? 'dupe' : 'worked';
  }

  private pump(): void {
    while (this.inFlight.size < MAX_CONCURRENT && this.queue.length > 0 && this.context) {
      const callsign = this.queue.shift()!;
      const generation = this.generation;
      const { logbookId } = this.context;
      this.inFlight.add(callsign);
      api.getLogBookQSOs(logbookId, { callsign, limit: LOOKUP_LIMIT, offset: 0, dxccNeedsReview: undefined })
        .then((result) => {
          if (generation !== this.generation) return;
          const matches = (result.data ?? []).filter((record) => record.callsign.toUpperCase() === callsign);
          this.records.set(callsign, matches);
          this.statuses.set(callsign, this.classify(matches));
          this.notify();
        })
        .catch((error: unknown) => logger.debug('Worked-before lookup failed', { callsign, error }))
        .finally(() => {
          if (generation !== this.generation) return;
          this.inFlight.delete(callsign);
          this.pump();
        });
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

export const workedCallsignStore = new WorkedCallsignStore();

/** Worked-before status of one callsign; triggers a lookup the first time it is shown. */
export function useWorkedStatus(callsign: string): WorkedStatus | undefined {
  const status = useSyncExternalStore(workedCallsignStore.subscribe, () => workedCallsignStore.get(callsign));
  useEffect(() => { workedCallsignStore.request(callsign); }, [callsign]);
  return status;
}
