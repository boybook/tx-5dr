import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Characterization of ft8-lessons QSO-30: evidence capture for the incomplete
// QSO review runs in a separate process behind a bounded observation queue.
// Overflow is dropped and counted; it never waits on, or blocks, the caller.

class FakeWorker extends EventEmitter {
  connected = true;
  readonly sent: Array<{ id: number; operation: string }> = [];
  send(message: { id: number; operation: string }, _callback?: (error: Error | null) => void): boolean {
    this.sent.push(message);
    return true;
  }
  disconnect(): void {
    this.connected = false;
    this.emit('exit', 0);
  }
  kill(): void {
    this.disconnect();
  }
}

const workers: FakeWorker[] = [];

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  fork: vi.fn(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  }),
}));

const { IncompleteQsoService } = await import('../IncompleteQsoService.js');

const rxSlot = (startMs: number) => ({
  mode: 'FT8' as const,
  startMs,
  frequency: 14_074_000,
  frames: [{ message: 'W1AAA K1BBB -12', snr: -14, freq: 1000, confidence: 1 }],
});

let service: InstanceType<typeof IncompleteQsoService> | undefined;

afterEach(async () => {
  await service?.close();
  service = undefined;
  workers.splice(0);
  vi.useRealTimers();
});

function startReadyService(): FakeWorker {
  service = new IncompleteQsoService('/nonexistent-review-dir');
  service.start();
  const worker = workers.at(-1)!;
  worker.emit('message', { type: 'ready' });
  return worker;
}

describe('IncompleteQsoService observation queue bound', () => {
  it('caps in-flight observations at 64 and counts the dropped overflow', () => {
    vi.useFakeTimers();
    const worker = startReadyService();

    for (let i = 0; i < 64; i++) service!.observeRx(rxSlot(i * 15_000));
    service!.observeTx({
      operatorId: 'op-1', logBookId: 'logbook-W1AAA', myCallsign: 'W1AAA',
      mode: 'FT8', startMs: 0, frequency: 14_074_000, audioOffsetHz: 1000, text: 'K1BBB W1AAA R-09',
    });

    expect(worker.sent).toHaveLength(64);
    expect(service!.getHealth()).toMatchObject({ state: 'ready', dropped: 1 });
  });

  it('frees a slot when the worker answers and does not bound review requests', async () => {
    vi.useFakeTimers();
    const worker = startReadyService();
    for (let i = 0; i < 64; i++) service!.observeRx(rxSlot(i * 15_000));

    // A user-facing query is not an observation and is never dropped.
    const listing = service!.list('logbook-W1AAA', { status: 'pending', limit: 50 }).catch(() => undefined);
    expect(worker.sent.at(-1)?.operation).toBe('list');

    worker.emit('message', { type: 'result', id: worker.sent[0]!.id, result: null });
    service!.observeRx(rxSlot(64 * 15_000));

    expect(worker.sent.filter(message => message.operation === 'rx')).toHaveLength(65);
    expect(service!.getHealth().dropped).toBe(0);
    await service!.close();
    await listing;
  });
});
