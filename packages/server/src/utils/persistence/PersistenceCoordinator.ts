import { createLogger } from '../logger.js';
import { AsyncLocalStorage } from 'node:async_hooks';

const logger = createLogger('PersistenceCoordinator');

export interface FlushablePersistenceTarget {
  name: string;
  flush: (reason?: string) => Promise<void> | void;
}

export class MutationBlockedError extends Error {
  constructor(public readonly target: string) {
    super(`Mutation rejected while persistence is shutting down: ${target}`);
    this.name = 'MutationBlockedError';
  }
}

export class PersistenceCoordinator {
  private static instance: PersistenceCoordinator | null = null;
  private readonly targets = new Map<string, FlushablePersistenceTarget>();
  private mutationsBlocked = false;
  private readonly acceptedLogbookWrites = new Set<object>();
  private readonly logbookWriteScope = new AsyncLocalStorage<{ token: object; logBookId: string }>();

  static getInstance(): PersistenceCoordinator {
    if (!this.instance) {
      this.instance = new PersistenceCoordinator();
    }
    return this.instance;
  }

  register(target: FlushablePersistenceTarget): () => void {
    this.targets.set(target.name, target);
    return () => this.targets.delete(target.name);
  }

  blockNewMutations(): void {
    this.mutationsBlocked = true;
  }

  allowNewMutationsForTests(): void {
    this.mutationsBlocked = false;
  }

  areMutationsBlocked(): boolean {
    return this.mutationsBlocked;
  }

  /** Host-only admission: one already accepted logbook task may drain at shutdown. */
  acceptLogbookWrite(logBookId: string): {
    run<T>(write: () => Promise<T>): Promise<T>;
    release(): void;
  } {
    this.assertMutationsAllowed('logbook:accept');
    const token = {};
    this.acceptedLogbookWrites.add(token);
    return {
      run: <T>(write: () => Promise<T>) => {
        if (!this.acceptedLogbookWrites.has(token)) throw new MutationBlockedError('logbook:expired-admission');
        return this.logbookWriteScope.run({ token, logBookId }, write);
      },
      release: () => { this.acceptedLogbookWrites.delete(token); },
    };
  }

  assertMutationsAllowed(target: string, logBookId?: string): void {
    if (this.mutationsBlocked) {
      const scope = this.logbookWriteScope.getStore();
      if (scope && logBookId === scope.logBookId
          && this.acceptedLogbookWrites.has(scope.token)
          && ['logbook:add', 'logbook:update', 'logbook:batch'].includes(target)) return;
      throw new MutationBlockedError(target);
    }
  }

  async flushAll(options: { deadlineMs?: number; reason?: string } = {}): Promise<{ ok: boolean; errors: Array<{ name: string; error: string }> }> {
    const deadlineMs = options.deadlineMs ?? 30_000;
    const startedAt = Date.now();
    const errors: Array<{ name: string; error: string }> = [];

    for (const target of this.targets.values()) {
      const remainingMs = Math.max(1, deadlineMs - (Date.now() - startedAt));
      try {
        await Promise.race([
          Promise.resolve(target.flush(options.reason)),
          new Promise((_, reject) => setTimeout(() => reject(new Error(`flush timeout after ${remainingMs}ms`)), remainingMs)),
        ]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push({ name: target.name, error: message });
        logger.error('persistence target flush failed', { name: target.name, error: message });
      }
    }

    return { ok: errors.length === 0, errors };
  }
}
