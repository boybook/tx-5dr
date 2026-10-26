import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { IncompleteQsoCandidate } from '@tx5dr/contracts';
import { IncompleteQsoWorkerStore } from '../IncompleteQsoWorkerStore.js';

let root: string | undefined;
const base = Date.UTC(2026, 8, 25, 12, 0, 0);

async function createStore() {
  root ??= await mkdtemp(path.join(tmpdir(), 'tx5dr-review-'));
  const store = new IncompleteQsoWorkerStore(root);
  await store.initialize();
  return store;
}

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

function tx(mode: 'FT8' | 'FT4', time: number, text: string) {
  return {
    operatorId: 'op-1', logBookId: 'logbook-W1AAA', myCallsign: 'W1AAA',
    mode, startMs: time, frequency: 14_074_000, audioOffsetHz: 1_000, text,
  };
}

function rx(mode: 'FT8' | 'FT4', time: number, text: string) {
  return { mode, startMs: time, frequency: 14_074_000,
    frames: [{ message: text, freq: 1_000, snr: -14, confidence: 0.97 }] };
}

describe('IncompleteQsoWorkerStore', () => {
  it.each(['FT8', 'FT4'] as const)('retains a %s exchange after both reports, then links a completed QSO', async mode => {
    const store = await createStore();
    await store.ingestRx(rx(mode, base - 15_000, 'CQ K1BBB FN31'));
    await store.ingestRx(rx(mode, base, 'W1AAA K1BBB -12'));
    await store.ingestTx(tx(mode, base + 15_000, 'K1BBB W1AAA R-09'));
    const listed = store.list('logbook-W1AAA', { status: 'pending', limit: 50 });
    expect(listed.items).toHaveLength(1);
    const candidate = await store.get(listed.items[0]!.id);
    expect(candidate).toMatchObject({ reportReceived: '-12', reportSent: '-09', mode, status: 'pending' });
    expect(candidate?.messages.map(message => message.direction)).toEqual(['rx', 'rx', 'tx']);
    expect(candidate?.messages[0]?.text).toBe('CQ K1BBB FN31');

    await store.linkQso('logbook-W1AAA', {
      id: 'qso-1', callsign: 'K1BBB', myCallsign: 'W1AAA', mode,
      frequency: 14_075_000, startTime: base + 15_000,
    });
    expect(store.list('logbook-W1AAA', { status: 'pending', limit: 50 }).items).toHaveLength(0);
    expect(store.list('logbook-W1AAA', { status: 'recorded', limit: 50 }).items[0]?.linkedQsoId).toBe('qso-1');
  });

  it('ignores one-way, partial and off-air evidence and deduplicates late RX snapshots', async () => {
    const store = await createStore();
    await store.ingestRx(rx('FT8', base, 'W1AAA K1BBB -12'));
    await store.ingestRx(rx('FT8', base, 'W1AAA K1BBB -12'));
    await store.ingestRx(rx('FT8', base, 'W1AAA <...> RR73'));
    expect(store.list('logbook-W1AAA', { status: 'pending', limit: 50 }).items).toHaveLength(0);
    await store.ingestTx(tx('FT8', base + 15_000, 'K1BBB W1AAA R-09'));
    await store.ingestRx(rx('FT8', base, 'W1AAA K1BBB -12'));
    const candidate = await store.get(store.list('logbook-W1AAA', { status: 'pending', limit: 50 }).items[0]!.id);
    expect(candidate?.messages).toHaveLength(2);
  });

  it('rebuilds a missing monthly index without losing a candidate', async () => {
    const store = await createStore();
    await store.ingestRx(rx('FT8', base, 'W1AAA K1BBB -12'));
    await store.ingestTx(tx('FT8', base + 15_000, 'K1BBB W1AAA R-09'));
    const before = store.list('logbook-W1AAA', { status: 'pending', limit: 50 }).items[0]!;
    await unlink(path.join(root!, 'W1AAA', '2026-09', 'index.json'));
    const reloaded = await createStore();
    expect(reloaded.list('logbook-W1AAA', { status: 'pending', limit: 50 }).items[0]?.id).toBe(before.id);
  });

  it('keeps attempts separate by operator and band', async () => {
    const store = await createStore();
    await store.ingestRx(rx('FT8', base, 'W1AAA K1BBB -12'));
    await store.ingestTx({ ...tx('FT8', base + 15_000, 'K1BBB W1AAA R-09'), operatorId: 'op-2',
      logBookId: 'logbook-other', frequency: 7_074_000 });
    expect(store.list('logbook-other', { status: 'pending', limit: 50 }).items).toHaveLength(0);
  });

  it('pages a multi-month index without reading the frame archive', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'tx5dr-review-index-'));
    for (let month = 0; month < 3; month++) {
      const time = Date.UTC(2026, month, 1);
      const dir = path.join(root, 'W1AAA', new Date(time).toISOString().slice(0, 7));
      await mkdir(dir, { recursive: true });
      const index = [];
      for (let number = 0; number < 500; number++) {
        const id = `00000000-0000-4000-8000-${String(month * 500 + number).padStart(12, '0')}`;
        const startTime = time + number * 60_000;
        const record = candidateFixture(id, startTime);
        await writeFile(path.join(dir, `${id}.json`), JSON.stringify(record));
        index.push({ id, revision: record.revision, logBookId: record.logBookId,
          myCallsign: record.myCallsign, callsign: record.callsign, mode: record.mode,
          frequency: record.frequency, startTime, endTime: record.endTime, status: record.status });
      }
      await writeFile(path.join(dir, 'index.json'), JSON.stringify(index));
    }
    const store = await createStore();
    const started = performance.now();
    const page = store.list('logbook-W1AAA', { status: 'pending', limit: 50 });
    expect(page.items).toHaveLength(50);
    expect(page.nextCursor).toBeDefined();
    const second = store.list('logbook-W1AAA', { status: 'pending', limit: 50, cursor: page.nextCursor });
    expect(second.items).toHaveLength(50);
    expect(new Set([...page.items, ...second.items].map(item => item.id)).size).toBe(100);
    expect(performance.now() - started).toBeLessThan(1_000);
  }, 30_000);
});

function candidateFixture(id: string, startTime: number): IncompleteQsoCandidate {
  return {
    schemaVersion: 1, id, revision: 1, logBookId: 'logbook-W1AAA', operatorId: 'op-1',
    myCallsign: 'W1AAA', callsign: `K1${String(id.slice(-4))}`,
    mode: 'FT8', frequency: 14_075_000, startTime, endTime: startTime + 15_000,
    reportSent: '-09', reportReceived: '-12', messages: [], status: 'pending',
  };
}
