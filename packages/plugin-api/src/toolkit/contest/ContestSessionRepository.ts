import type { KVStore } from '../../helpers.js';

export interface VersionedContestSession {
  schemaVersion: number;
  revision: number;
}

/** Atomic repository for callsign/year-scoped plugin contest sessions. */
export class ContestSessionRepository<TSession extends VersionedContestSession> {
  constructor(
    private readonly store: KVStore,
    private readonly key: string,
    private readonly create: () => TSession,
  ) {}

  read(): TSession {
    return this.store.get<TSession>(this.key, this.create());
  }

  update(mutator: (current: TSession) => TSession): TSession {
    return this.store.update<TSession>(this.key, (stored) => {
      const current = stored ?? this.create();
      const next = mutator(structuredClone(current));
      return { ...next, revision: current.revision + 1 };
    }) ?? this.create();
  }

  async flush(): Promise<void> {
    await this.store.flush();
  }
}
