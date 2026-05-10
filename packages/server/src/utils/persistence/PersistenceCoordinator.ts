import { createLogger } from '../logger.js';

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

  assertMutationsAllowed(target: string): void {
    if (this.mutationsBlocked) {
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
