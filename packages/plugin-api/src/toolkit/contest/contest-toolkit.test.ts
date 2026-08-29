import { describe, expect, it } from 'vitest';
import { createMockKVStore } from '../../testing/index.js';
import { buildCabrilloDocument } from './CabrilloBuilder.js';
import { ContestSessionRepository } from './ContestSessionRepository.js';

describe('contest toolkit', () => {
  it('atomically merges a shared versioned session', () => {
    const store = createMockKVStore();
    const create = () => ({ schemaVersion: 1, revision: 0, ids: [] as string[] });
    const first = new ContestSessionRepository(store, 'session', create);
    const second = new ContestSessionRepository(store, 'session', create);
    first.update((session) => ({ ...session, ids: [...session.ids, 'a'] }));
    second.update((session) => ({ ...session, ids: [...session.ids, 'b'] }));
    expect(first.read()).toEqual({ schemaVersion: 1, revision: 2, ids: ['a', 'b'] });
  });

  it('builds deterministic Cabrillo with CRLF endings', () => {
    expect(buildCabrilloDocument({
      headers: [['CONTEST', 'EXAMPLE']],
      qsoLines: ['QSO: 14000 DG 2026-01-01 0000 A A B B 0'],
    })).toBe('START-OF-LOG: 3.0\r\nCONTEST: EXAMPLE\r\nQSO: 14000 DG 2026-01-01 0000 A A B B 0\r\nEND-OF-LOG:\r\n');
  });
});
