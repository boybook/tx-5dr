import { mkdtemp, readFile, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { nodeAdifFileSystem } from '../FileSystemAdapter.js';
import { PathFileLock, PathFileLockTimeoutError } from '../PathFileLock.js';
import { PerPathSerialQueue } from '../PerPathSerialQueue.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('persistence path coordination', () => {
  const tempDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
  });

  async function lockPath(): Promise<string> {
    const directory = await mkdtemp(path.join(tmpdir(), 'tx5dr-path-lock-'));
    tempDirectories.push(directory);
    return path.join(directory, 'operation.lock');
  }

  it('runs same-path work FIFO, survives failures, and drains the latest operation', async () => {
    const queue = new PerPathSerialQueue();
    const gate = deferred();
    const order: string[] = [];
    const first = queue.run('/tmp/same.adi', async () => {
      order.push('first-start');
      await gate.promise;
      order.push('first-end');
    });
    const failed = queue.run('/tmp/same.adi', async () => {
      order.push('failed');
      throw new Error('expected failure');
    });
    const third = queue.run('/tmp/same.adi', async () => {
      order.push('third');
    });
    const drained = queue.drain('/tmp/same.adi').then(() => order.push('drained'));

    await new Promise(resolve => setImmediate(resolve));
    expect(order).toEqual(['first-start']);
    gate.resolve();
    await expect(failed).rejects.toThrow('expected failure');
    await Promise.all([first, third, drained]);
    expect(order).toEqual(['first-start', 'first-end', 'failed', 'third', 'drained']);
  });

  it('removes a lock owned by a dead process and releases its own token', async () => {
    const filePath = await lockPath();
    await writeFile(filePath, JSON.stringify({ token: 'dead', pid: 999_999_999, createdAt: Date.now() }));
    const lock = new PathFileLock(nodeAdifFileSystem, filePath, {
      timeoutMs: 50,
      isProcessAlive: () => false,
    });

    await expect(lock.run(async () => 'ok')).resolves.toBe('ok');
    await expect(readFile(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('times out without stealing a live lock', async () => {
    const filePath = await lockPath();
    await writeFile(filePath, JSON.stringify({ token: 'live', pid: process.pid, createdAt: 1_000 }));
    let now = 1_000;
    const lock = new PathFileLock(nodeAdifFileSystem, filePath, {
      timeoutMs: 10,
      retryDelayMs: 5,
      staleAfterMs: 60_000,
      now: () => now,
      sleep: async delay => { now += delay; },
      isProcessAlive: () => true,
    });

    await expect(lock.run(async () => undefined)).rejects.toBeInstanceOf(PathFileLockTimeoutError);
    expect(JSON.parse(await readFile(filePath, 'utf8')).token).toBe('live');
  });

  it('never steals a live lock merely because a long operation exceeded the stale age', async () => {
    const filePath = await lockPath();
    await writeFile(filePath, JSON.stringify({ token: 'long-running', pid: process.pid, createdAt: 1_000 }));
    await utimes(filePath, new Date(1_000), new Date(1_000));
    let now = 120_000;
    const lock = new PathFileLock(nodeAdifFileSystem, filePath, {
      timeoutMs: 10,
      retryDelayMs: 5,
      staleAfterMs: 60_000,
      now: () => now,
      sleep: async delay => { now += delay; },
      isProcessAlive: () => true,
    });

    await expect(lock.run(async () => undefined)).rejects.toBeInstanceOf(PathFileLockTimeoutError);
    expect(JSON.parse(await readFile(filePath, 'utf8')).token).toBe('long-running');
  });

  it('never deletes a lock whose token changed while the operation ran', async () => {
    const filePath = await lockPath();
    const lock = new PathFileLock(nodeAdifFileSystem, filePath);

    await lock.run(async () => {
      await writeFile(filePath, JSON.stringify({ token: 'new-owner', pid: process.pid, createdAt: Date.now() }));
    });

    expect(JSON.parse(await readFile(filePath, 'utf8')).token).toBe('new-owner');
    await unlink(filePath);
  });
});
