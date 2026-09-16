import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { QSORecord } from '@tx5dr/contracts';
import { QsoCompletionService, type QsoCompletionRequest } from '../QsoCompletionService.js';
import { PersistenceCoordinator } from '../../utils/persistence/PersistenceCoordinator.js';
import { ADIFLogProvider } from '../ADIFLogProvider.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function request(streamId = 'stream-1'): QsoCompletionRequest {
  return {
    operatorId: 'operator-1', logBookId: 'book-1', qsoRuntimeGeneration: 1,
    streamId, qsoLifecycleEpoch: 1,
    qsoRecord: {
      id: `qso-${streamId}`, callsign: 'K1BBB', myCallsign: 'W1AAA', frequency: 14074000,
      mode: 'FT8', startTime: 1_000, messageHistory: [],
    },
  };
}

function harness() {
  const result = deferred<{ record: QSORecord; afterCommit?: () => Promise<void> }>();
  const write = vi.fn(() => result.promise);
  const onFailed = vi.fn();
  const onCommitted = vi.fn();
  const persistence = new PersistenceCoordinator();
  const service = new QsoCompletionService({
    write, onFailed, onCommitted, persistence,
    readCommitted: async () => request().qsoRecord,
  });
  return { service, write, result, onFailed, onCommitted, persistence };
}

afterEach(() => { vi.useRealTimers(); });

describe('QsoCompletionService', () => {
  it('drains an accepted QSO into real ADIF after shutdown blocks new mutations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tx5dr-qso-drain-'));
    const file = join(directory, 'contacts.adi');
    const provider = new ADIFLogProvider({ logBookId: 'book-1', logFilePath: file });
    const persistence = PersistenceCoordinator.getInstance();
    persistence.allowNewMutationsForTests();
    const preparation = deferred<void>();
    const entered = deferred<void>();
    const service = new QsoCompletionService({
      persistence, onFailed: vi.fn(), readCommitted: (_book, id) => provider.getQSO(id),
      write: async task => {
        const candidate = await task.prepare(async () => {
          entered.resolve();
          await preparation.promise;
          return task.request.qsoRecord;
        });
        return { record: await provider.addQSO(candidate) };
      },
    });
    try {
      await provider.initialize();
      const saving = service.submit(request());
      await entered.promise;
      service.stopAccepting();
      persistence.blockNewMutations();
      await expect(provider.addQSO(request('new').qsoRecord)).rejects.toThrow('shutting down');
      preparation.resolve();
      await saving;
      await service.drain();
      expect((await provider.getQSO('qso-stream-1'))?.callsign).toBe('K1BBB');
      expect(await readFile(file, 'utf8')).toContain('qso-stream-1');
      expect(service.status('operator-1').state).toBe('idle');
    } finally {
      persistence.allowNewMutationsForTests();
      preparation.resolve();
      await provider.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('releases completed candidate payloads and retires compact outcome entries', async () => {
    const service = new QsoCompletionService({
      persistence: new PersistenceCoordinator(), onFailed: vi.fn(), readCommitted: async () => null,
      write: async task => ({ record: await task.prepare(async () => ({ ...task.request.qsoRecord, comment: 'x'.repeat(4000) })) }),
    });
    for (let index = 0; index < 1000; index += 1) await service.submit(request(`stream-${index}`));
    await service.drain();
    const tasks = (service as unknown as { tasks: Map<string, { request?: unknown; prepared?: unknown; promise?: unknown }> }).tasks;
    expect(tasks.size).toBe(1000);
    for (const task of tasks.values()) {
      expect(task.request).toBeUndefined();
      expect(task.prepared).toBeUndefined();
      expect(task.promise).toBeUndefined();
    }
    expect(service.status('operator-1')).toEqual({ state: 'idle', pendingCount: 0, unsavedCount: 0 });
    service.retire('operator-1', 1);
    expect(tasks.size).toBe(0);
  });

  it('joins duplicate submissions while saving and after commit without another write', async () => {
    const { service, write, result, onCommitted } = harness();
    const first = service.submit(request());
    expect(service.submit(request())).toBe(first);
    expect(service.submit({ ...request(), logBookId: 'newly-selected-book', baseFrequency: 7074000 })).toBe(first);
    result.resolve({ record: request().qsoRecord });
    await first;
    await service.drain();
    await expect(service.submit(request())).resolves.toMatchObject({ id: 'qso-stream-1' });
    expect(write).toHaveBeenCalledTimes(1);
    expect(onCommitted).toHaveBeenCalledTimes(1);
  });

  it('rejects changed data under the same completion identity', async () => {
    const { service, result } = harness();
    const first = service.submit(request());
    await expect(service.submit({ ...request(), qsoRecord: { ...request().qsoRecord, frequency: 7074000 } }))
      .rejects.toThrow('Conflicting payload');
    result.resolve({ record: request().qsoRecord });
    await first;
  });

  it('shows slow saving without permitting another writer and accepts a late success', async () => {
    vi.useFakeTimers();
    const { service, write, result } = harness();
    const saving = service.submit(request());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(service.status('operator-1')).toMatchObject({ state: 'slow', pendingCount: 1, unsavedCount: 0 });
    expect(service.submit(request())).toBe(saving);
    result.resolve({ record: request().qsoRecord });
    await saving;
    expect(service.status('operator-1').state).toBe('idle');
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('keeps committed state when a post-commit notification fails', async () => {
    const { service, result, onFailed } = harness();
    const saving = service.submit(request());
    result.resolve({ record: request().qsoRecord, afterCommit: async () => { throw new Error('sync unavailable'); } });
    await saving;
    await service.drain();
    expect(onFailed).not.toHaveBeenCalled();
    expect(service.unresolved()).toEqual([]);
  });

  it('retains failed records, joins explicit retry, and does not re-prepare the candidate', async () => {
    const persistence = new PersistenceCoordinator();
    const prepare = vi.fn(async () => ({ ...request().qsoRecord, comment: 'frozen' }));
    let fail = true;
    const write = vi.fn(async (task) => {
      const record = await task.prepare(prepare);
      if (fail) throw new Error('disk full');
      return { record };
    });
    const service = new QsoCompletionService({ write, persistence, onFailed: vi.fn(), readCommitted: async () => null });
    await expect(service.submit(request())).rejects.toThrow('disk full');
    const attempt = service.unresolved()[0]!;
    expect(attempt.qsoRecord.comment).toBe('frozen');
    fail = false;
    const retry = service.retry(attempt.logBookId, attempt.attemptId);
    expect(service.retry(attempt.logBookId, attempt.attemptId)).toBe(retry);
    expect(() => service.discard(attempt.logBookId, attempt.attemptId)).toThrow();
    await retry;
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(service.unresolved()).toEqual([]);
  });

  it('does not retry or discard an uncertain file result', async () => {
    const { service, result } = harness();
    const saving = service.submit(request());
    result.reject(Object.assign(new Error('file state unknown'), { code: 'LOGBOOK_WRITE_STATE_UNCERTAIN' }));
    await expect(saving).rejects.toThrow();
    const attempt = service.unresolved()[0]!;
    await expect(service.retry(attempt.logBookId, attempt.attemptId)).rejects.toThrow('Verify');
    expect(() => service.discard(attempt.logBookId, attempt.attemptId)).toThrow();
    expect(() => service.assertLogbookRemovable(attempt.logBookId)).toThrow();
    expect(service.status('operator-1').state).toBe('uncertain');
  });

  it('allows several retained failures to be explicitly recovered without discarding another contact', async () => {
    let fail = true;
    const write = vi.fn(async task => {
      if (fail) throw new Error('disk full');
      return { record: task.request.qsoRecord };
    });
    const service = new QsoCompletionService({ write, persistence: new PersistenceCoordinator(), onFailed: vi.fn(), readCommitted: async () => null });
    await expect(service.submit(request('one'))).rejects.toThrow();
    await expect(service.submit(request('two'))).rejects.toThrow();
    const attempts = service.unresolved();
    expect(attempts).toHaveLength(2);
    fail = false;
    await service.retry('book-1', attempts[0]!.attemptId);
    expect(service.unresolved()).toHaveLength(1);
    await service.retry('book-1', attempts[1]!.attemptId);
    expect(service.unresolved()).toEqual([]);
    expect(write).toHaveBeenCalledTimes(3);
  });

  it('isolates matching epochs on separate streams and serializes their writes', async () => {
    const { service, write, result } = harness();
    const first = service.submit(request('stream-1'));
    const second = service.submit(request('stream-2'));
    await Promise.resolve();
    expect(write).toHaveBeenCalledTimes(1);
    result.resolve({ record: request().qsoRecord });
    await Promise.all([first, second]);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('drains accepted work after admissions close and refuses deletion until it ends', async () => {
    const { service, result } = harness();
    const saving = service.submit(request());
    service.stopAccepting();
    await expect(service.submit(request('new-stream'))).rejects.toThrow('admission');
    expect(() => service.assertLogbookRemovable('book-1')).toThrow();
    let drained = false;
    const draining = service.drain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    result.resolve({ record: request().qsoRecord });
    await saving;
    await draining;
    expect(() => service.assertLogbookRemovable('book-1')).not.toThrow();
  });

  it('reports drain timeout without cancelling the pending write', async () => {
    vi.useFakeTimers();
    const { service, result } = harness();
    const saving = service.submit(request());
    const draining = expect(service.drain(100)).rejects.toThrow('deadline');
    await vi.advanceTimersByTimeAsync(100);
    await draining;
    expect(service.status('operator-1').pendingCount).toBe(1);
    result.resolve({ record: request().qsoRecord });
    await saving;
  });
});

describe('accepted logbook write admission', () => {
  it('only permits its original logbook writes during shutdown and revokes retained continuations', async () => {
    const persistence = new PersistenceCoordinator();
    const admission = persistence.acceptLogbookWrite('book-1');
    persistence.blockNewMutations();
    expect(() => persistence.acceptLogbookWrite('book-1')).toThrow();
    await admission.run(async () => {
      expect(() => persistence.assertMutationsAllowed('logbook:add', 'book-1')).not.toThrow();
      expect(() => persistence.assertMutationsAllowed('logbook:add', 'book-2')).toThrow();
      expect(() => persistence.assertMutationsAllowed('logbook:delete', 'book-1')).toThrow();
      admission.release();
      expect(() => persistence.assertMutationsAllowed('logbook:add', 'book-1')).toThrow();
    });
    expect(() => admission.run(async () => {})).toThrow();
    expect(() => persistence.assertMutationsAllowed('logbook:add', 'book-1')).toThrow();
  });
});
