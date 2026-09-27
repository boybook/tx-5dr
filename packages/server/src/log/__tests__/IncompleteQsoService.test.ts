import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IncompleteQsoService } from '../IncompleteQsoService.js';

let directory: string | undefined;
let service: IncompleteQsoService | undefined;

afterEach(async () => {
  await service?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
  service = undefined;
  directory = undefined;
});

describe('IncompleteQsoService process boundary', () => {
  it('captures and reloads a candidate through the worker IPC', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'tx5dr-review-process-'));
    service = new IncompleteQsoService(directory);
    service.start();
    await vi.waitFor(() => expect(service!.getHealth().state).toBe('ready'), { timeout: 10_000 });
    const startMs = Date.UTC(2026, 8, 25, 12, 0, 0);
    service.observeRx({ mode: 'FT8', startMs, frequency: 14_074_000,
      frames: [{ message: 'W1AAA K1BBB -12', snr: -14, freq: 1000, confidence: 1 }] });
    service.observeTx({ operatorId: 'op-1', logBookId: 'logbook-W1AAA', myCallsign: 'W1AAA',
      mode: 'FT8', startMs: startMs + 15_000, frequency: 14_074_000,
      audioOffsetHz: 1000, text: 'K1BBB W1AAA R-09' });
    await vi.waitFor(async () => {
      const listed = await service!.list('logbook-W1AAA', { status: 'pending', limit: 50 });
      expect(listed.items).toHaveLength(1);
    }, { timeout: 10_000 });
    await service.close();
    service = new IncompleteQsoService(directory);
    service.start();
    await vi.waitFor(() => expect(service!.getHealth().state).toBe('ready'), { timeout: 10_000 });
    expect((await service.list('logbook-W1AAA', { status: 'pending', limit: 50 })).items).toHaveLength(1);
  }, 30_000);
});
