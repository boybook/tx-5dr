import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LegacyLogbookMigrationWorker,
  readLegacyFileWithProgress,
  resolveLegacyMigrationWorkerEntry,
  type LegacyMigrationProcess,
} from '../LegacyLogbookMigrationWorker.js';
import { LegacyLogbookDocumentCodec } from '../LegacyLogbookDocumentCodec.js';
import { legacyMigrationPaths } from '../LegacyLogbookMigrator.js';

function fakeProcess(): LegacyMigrationProcess {
  const child = new EventEmitter() as LegacyMigrationProcess;
  child.kill = vi.fn(() => true) as LegacyMigrationProcess['kill'];
  child.send = vi.fn(() => true) as LegacyMigrationProcess['send'];
  return child;
}

function successfulMigration(mainPath: string) {
  return {
    status: 'MIGRATED' as const,
    mainPath,
    committed: true,
    appliedTransactions: 0,
    skippedTransactions: 0,
    unappliedOperations: 0,
    issues: [],
  };
}

describe('LegacyLogbookMigrationWorker', () => {
  const tempDirectories: string[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(tempDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
  });

  it('does not fork or read ADIF content when no legacy artifact exists', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'tx5dr-legacy-worker-stable-'));
    tempDirectories.push(directory);
    const mainPath = path.join(directory, 'STABLE.adi');
    await writeFile(mainPath, 'arbitrary current content');
    const workerFactory = vi.fn(() => fakeProcess());

    const result = await new LegacyLogbookMigrationWorker({ workerFactory }).migrate(mainPath);

    expect(result.status).toBe('NOT_NEEDED');
    expect(workerFactory).not.toHaveBeenCalled();
    expect(await readFile(mainPath, 'utf8')).toBe('arbitrary current content');
  });

  it('reports real read advances and every MiB while preserving the exact legacy bytes', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'tx5dr-legacy-worker-stream-'));
    tempDirectories.push(directory);
    const filePath = path.join(directory, 'LARGE.adi.bak.1');
    const source = Buffer.alloc(2 * 1024 * 1024 + 17, 0x61);
    source[source.length - 1] = 0xff;
    await writeFile(filePath, source);
    const progress: number[] = [];

    const result = await readLegacyFileWithProgress(filePath, bytesRead => progress.push(bytesRead));

    expect(result.equals(source)).toBe(true);
    expect(progress).toEqual(expect.arrayContaining([
      64 * 1024,
      1024 * 1024,
      2 * 1024 * 1024,
      source.length,
    ]));
    expect(progress.at(-1)).toBe(source.length);
    expect(progress.every((value, index) => index === 0 || value > progress[index - 1]!)).toBe(true);
  });

  it('reports legacy codec progress every 1000 scanned records', async () => {
    const records = Array.from({ length: 1001 }, (_, index) => (
      `<CALL:5>BG5DR<QSO_DATE:8>20260810<TIME_ON:6>${String(index).padStart(6, '0')}<MODE:3>FT8<FREQ:9>14.074000<EOR>`
    )).join('\n');
    const progress: number[] = [];

    await new LegacyLogbookDocumentCodec(count => progress.push(count))
      .decodeSnapshot(Buffer.from(records), 'memory.adi');

    expect(progress).toEqual([1000, 1001]);
  });

  it('caps the child heap and isolates a stalled migration as a failed health result', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'tx5dr-legacy-worker-timeout-'));
    tempDirectories.push(directory);
    const mainPath = path.join(directory, 'STALLED.adi');
    await writeFile(`${mainPath}.bak.1`, 'legacy snapshot');
    const child = fakeProcess();
    const worker = new LegacyLogbookMigrationWorker({
      noProgressTimeoutMs: 20,
      workerFactory: () => {
        queueMicrotask(() => child.emit('message', { type: 'ready' }));
        return child;
      },
    });

    const result = await worker.migrate(mainPath);

    expect(resolveLegacyMigrationWorkerEntry().execArgv).toContain('--max-old-space-size=512');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(result.status).toBe('FAILED');
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'MIGRATION_WORKER_FAILED' }),
    ]));
  });

  it('does not let repeated liveness progress extend the no-progress timeout', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'tx5dr-legacy-worker-heartbeat-'));
    tempDirectories.push(directory);
    const mainPath = path.join(directory, 'HEARTBEAT.adi');
    await writeFile(`${mainPath}.bak.1`, 'legacy snapshot');
    const child = fakeProcess();
    let heartbeat: NodeJS.Timeout | undefined;
    const worker = new LegacyLogbookMigrationWorker({
      noProgressTimeoutMs: 30,
      hardTimeoutMs: 500,
      workerFactory: () => {
        queueMicrotask(() => child.emit('message', { type: 'ready' }));
        heartbeat = setInterval(() => {
          child.emit('message', { type: 'progress', id: 1, sequence: 1, stage: 'migrate:started' });
        }, 5);
        return child;
      },
    });

    const result = await worker.migrate(mainPath).finally(() => clearInterval(heartbeat));

    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(result.status).toBe('FAILED');
    expect(result.issues[0]?.message).toContain('made no progress for 30ms');
  });

  it('lets a new progress milestone extend only the no-progress window', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'tx5dr-legacy-worker-progress-'));
    tempDirectories.push(directory);
    const mainPath = path.join(directory, 'PROGRESS.adi');
    await writeFile(`${mainPath}.bak.1`, 'legacy snapshot');
    const child = fakeProcess();
    const worker = new LegacyLogbookMigrationWorker({
      noProgressTimeoutMs: 25,
      hardTimeoutMs: 200,
      workerFactory: () => {
        queueMicrotask(() => child.emit('message', { type: 'ready' }));
        setTimeout(() => {
          child.emit('message', { type: 'progress', id: 1, sequence: 1, stage: 'migrate:source-read' });
        }, 15);
        setTimeout(() => {
          child.emit('message', {
            type: 'migration-result',
            id: 1,
            result: successfulMigration(mainPath),
          });
        }, 35);
        return child;
      },
    });

    const result = await worker.migrate(mainPath);

    expect(result.status).toBe('MIGRATED');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('enforces an absolute deadline even while milestones keep advancing', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'tx5dr-legacy-worker-deadline-'));
    tempDirectories.push(directory);
    const mainPath = path.join(directory, 'DEADLINE.adi');
    await writeFile(`${mainPath}.bak.1`, 'legacy snapshot');
    const child = fakeProcess();
    let sequence = 0;
    let progress: NodeJS.Timeout | undefined;
    const worker = new LegacyLogbookMigrationWorker({
      noProgressTimeoutMs: 30,
      hardTimeoutMs: 45,
      workerFactory: () => {
        queueMicrotask(() => child.emit('message', { type: 'ready' }));
        progress = setInterval(() => {
          sequence += 1;
          child.emit('message', { type: 'progress', id: 1, sequence, stage: `migrate:step-${sequence}` });
        }, 5);
        return child;
      },
    });

    const result = await worker.migrate(mainPath).finally(() => clearInterval(progress));

    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(result.status).toBe('FAILED');
    expect(result.issues[0]?.message).toContain('exceeded hard deadline of 45ms');
  });

  it('resumes a pending recovery manifest even after every top-level sidecar moved', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'tx5dr-legacy-worker-resume-'));
    tempDirectories.push(directory);
    const mainPath = path.join(directory, 'RESUME.adi');
    const manifestPath = path.join(legacyMigrationPaths(mainPath).recoveryRoot, 'manifest.json');
    await writeFile(mainPath, '<EOH>\n');
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, '{}');
    const child = fakeProcess();
    const workerFactory = vi.fn(() => {
      queueMicrotask(() => {
        child.emit('message', { type: 'ready' });
        queueMicrotask(() => child.emit('message', {
          type: 'migration-result',
          id: 1,
          result: {
            status: 'CLEANUP_PENDING',
            mainPath,
            committed: false,
            appliedTransactions: 0,
            skippedTransactions: 0,
            unappliedOperations: 0,
            issues: [],
          },
        }));
      });
      return child;
    });

    const result = await new LegacyLogbookMigrationWorker({ workerFactory }).migrate(mainPath);

    expect(workerFactory).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('CLEANUP_PENDING');
  });

  it('runs a real one-time migration in the child process', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'tx5dr-legacy-worker-real-'));
    tempDirectories.push(directory);
    const mainPath = path.join(directory, 'REAL.adi');
    const backup = '<CALL:5>BG5DR<QSO_DATE:8>20260810<TIME_ON:6>010203<MODE:3>FT8<FREQ:9>14.074000<EOR>\n';
    await writeFile(`${mainPath}.bak.1`, backup);

    const result = await new LegacyLogbookMigrationWorker({ noProgressTimeoutMs: 10_000 }).migrate(mainPath);

    expect(result.status).not.toBe('FAILED');
    expect(await readFile(mainPath, 'utf8')).toContain('BG5DR');
  }, 15_000);
});
