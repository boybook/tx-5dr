import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncompleteQsoCandidate, IncompleteQsoQuery, QSORecord } from '@tx5dr/contracts';
import type { ReviewRxSlot, ReviewTxFact } from './IncompleteQsoWorkerStore.js';
import { createLogger } from '../utils/logger.js';
import { PersistenceCoordinator } from '../utils/persistence/PersistenceCoordinator.js';

const logger = createLogger('IncompleteQsoService');
const MAX_OBSERVATIONS_IN_FLIGHT = 64;
const REQUEST_TIMEOUT_MS = 30_000;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  observation: boolean;
}

export class IncompleteQsoService {
  private worker: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private observationsInFlight = 0;
  private ready = false;
  private stopping = false;
  private error?: string;
  private dropped = 0;
  private unregisterPersistence?: () => void;

  constructor(private readonly dataDir: string) {}

  start(): void {
    if (this.worker) return;
    const currentFile = fileURLToPath(import.meta.url);
    const source = currentFile.endsWith('.ts');
    const entry = path.join(path.dirname(currentFile), source ? 'incomplete-qso-worker-entry.ts' : 'incomplete-qso-worker-entry.js');
    let worker: ChildProcess;
    try {
      worker = fork(entry, [], {
      execArgv: source ? ['--import', 'tsx'] : [],
      env: { ...process.env, TX5DR_REVIEW_DIR: path.join(this.dataDir, 'incomplete-qso-review') },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      logger.error('Candidate worker could not start', { error: this.error });
      return;
    }
    this.worker = worker;
    worker.on('message', (message: { type: string; id?: number; result?: unknown; error?: string }) => {
      if (message.type === 'ready') {
        this.ready = true;
        this.error = undefined;
        return;
      }
      if (message.type === 'fatal') {
        this.error = message.error ?? 'Review worker failed';
        logger.error('Candidate worker initialization failed', { error: this.error });
        return;
      }
      if (message.id === undefined) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (pending.observation) this.observationsInFlight--;
      if (message.type === 'error') pending.reject(new Error(message.error ?? 'Candidate worker request failed'));
      else pending.resolve(message.result);
    });
    worker.on('exit', (code) => {
      this.ready = false;
      if (!this.stopping) this.error = `Candidate worker exited (${code ?? 'unknown'})`;
      this.worker = null;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(this.error));
      }
      this.pending.clear();
      this.observationsInFlight = 0;
    });
    worker.on('error', error => {
      this.ready = false;
      this.error = error.message;
      logger.error('Candidate worker failed', { error: error.message });
    });
    this.unregisterPersistence = PersistenceCoordinator.getInstance().register({
      name: 'incomplete-qso-review',
      flush: async () => {
        await Promise.allSettled([...this.pending.values()].map(pending => new Promise<void>(resolve => {
          const originalResolve = pending.resolve;
          const originalReject = pending.reject;
          pending.resolve = value => { originalResolve(value); resolve(); };
          pending.reject = error => { originalReject(error); resolve(); };
        })));
      },
    });
  }

  getHealth(): { state: 'ready' | 'loading' | 'unavailable'; dropped: number; error?: string } {
    return { state: this.ready ? 'ready' : this.error ? 'unavailable' : 'loading', dropped: this.dropped, error: this.error };
  }

  async close(): Promise<void> {
    this.stopping = true;
    const worker = this.worker;
    if (!worker) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { worker.kill(); resolve(); }, 3_000);
      worker.once('exit', () => { clearTimeout(timer); resolve(); });
      worker.disconnect();
    });
    this.unregisterPersistence?.();
    this.unregisterPersistence = undefined;
  }

  private request<T>(operation: string, payload: Record<string, unknown>, observation = false): Promise<T> {
    if (!this.ready || !this.worker?.connected) return Promise.reject(new Error('REVIEW_UNAVAILABLE'));
    if (observation && this.observationsInFlight >= MAX_OBSERVATIONS_IN_FLIGHT) {
      this.dropped++;
      return Promise.reject(new Error('REVIEW_QUEUE_FULL'));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (observation) this.observationsInFlight--;
        reject(new Error('REVIEW_WORKER_TIMEOUT'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer, observation });
      if (observation) this.observationsInFlight++;
      this.worker!.send({ id, operation, payload }, error => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(timer);
        if (observation) this.observationsInFlight--;
        reject(error);
      });
    });
  }

  observeRx(slot: ReviewRxSlot): void {
    void this.request('rx', { slot }, true).catch(error => {
      if (error.message !== 'REVIEW_QUEUE_FULL') this.dropped++;
      if (error.message !== 'REVIEW_UNAVAILABLE') logger.warn('Candidate RX observation failed', { error: error.message });
    });
  }

  observeTx(fact: ReviewTxFact): void {
    void this.request('tx', { fact }, true).catch(error => {
      if (error.message !== 'REVIEW_QUEUE_FULL') this.dropped++;
      if (error.message !== 'REVIEW_UNAVAILABLE') logger.warn('Candidate TX observation failed', { error: error.message });
    });
  }

  linkQso(logBookId: string, record: QSORecord): void {
    void this.request('link', { logBookId, record }, true).catch(error => {
      logger.warn('Candidate QSO reconciliation failed', { error: error.message, qsoId: record.id });
    });
  }

  list(logBookId: string, query: IncompleteQsoQuery): Promise<{ items: Array<Pick<IncompleteQsoCandidate,
    'id' | 'revision' | 'logBookId' | 'myCallsign' | 'callsign' | 'mode' | 'frequency' | 'startTime' | 'endTime' | 'status' | 'linkedQsoId' | 'commitRequested' | 'syncQueued'>>; nextCursor?: string }> {
    return this.request('list', { logBookId, query });
  }

  get(id: string, logBookId: string): Promise<IncompleteQsoCandidate | null> {
    return this.request('get', { id, logBookId });
  }

  update(id: string, logBookId: string, revision: number, patch: Partial<IncompleteQsoCandidate>): Promise<IncompleteQsoCandidate> {
    return this.request('update', { id, logBookId, revision, patch });
  }
}
