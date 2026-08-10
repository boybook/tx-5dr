import { randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  ADIF_EXCLUSIVE_CREATE_FLAGS,
  errorCode,
  fsyncDirectory,
  pathExists,
  writeAll,
  type AdifFileSystem,
} from './FileSystemAdapter.js';

interface LockOwner {
  token: string;
  pid: number;
  createdAt: number;
}

export interface PathFileLockOptions {
  timeoutMs?: number;
  retryDelayMs?: number;
  staleAfterMs?: number;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  isProcessAlive?: (pid: number) => boolean;
}

export class PathFileLockTimeoutError extends Error {
  constructor(public readonly lockPath: string, timeoutMs: number) {
    super(`Timed out acquiring logbook file lock after ${timeoutMs}ms: ${lockPath}`);
    this.name = 'PathFileLockTimeoutError';
  }
}

export class PathFileLock {
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly staleAfterMs: number;
  private readonly now: () => number;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly isProcessAlive: (pid: number) => boolean;

  constructor(
    private readonly fileSystem: AdifFileSystem,
    private readonly lockPath: string,
    options: PathFileLockOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.retryDelayMs = options.retryDelayMs ?? 25;
    this.staleAfterMs = options.staleAfterMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((delayMs) => new Promise(resolve => setTimeout(resolve, delayMs)));
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const owner = await this.acquire();
    try {
      return await operation();
    } finally {
      await this.release(owner).catch(() => undefined);
    }
  }

  private async acquire(): Promise<LockOwner> {
    const startedAt = this.now();
    const owner: LockOwner = {
      token: randomUUID(),
      pid: process.pid,
      createdAt: this.now(),
    };

    for (;;) {
      try {
        const handle = await this.fileSystem.open(this.lockPath, ADIF_EXCLUSIVE_CREATE_FLAGS, 0o600);
        try {
          await writeAll(handle, Buffer.from(`${JSON.stringify(owner)}\n`, 'utf8'), 0);
          await handle.sync();
        } catch (error) {
          await handle.close().catch(() => undefined);
          await this.fileSystem.unlink(this.lockPath).catch(() => undefined);
          throw error;
        }
        await handle.close();
        try {
          await fsyncDirectory(this.fileSystem, path.dirname(this.lockPath));
        } catch (error) {
          await this.fileSystem.unlink(this.lockPath).catch(() => undefined);
          throw error;
        }
        return owner;
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
        if (await this.removeIfStale()) continue;
        if (this.now() - startedAt >= this.timeoutMs) {
          throw new PathFileLockTimeoutError(this.lockPath, this.timeoutMs);
        }
        await this.sleep(this.retryDelayMs);
      }
    }
  }

  private async removeIfStale(): Promise<boolean> {
    let staleByAge = false;
    try {
      const stat = await this.fileSystem.stat(this.lockPath);
      staleByAge = this.now() - stat.mtimeMs >= this.staleAfterMs;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return true;
      return false;
    }

    const owner = await this.readOwner();
    if (owner) {
      // A valid live owner is authoritative regardless of age. Scans and
      // durable rewrites can legitimately outlive the stale-file threshold.
      if (this.isProcessAlive(owner.pid)) return false;
    } else if (!staleByAge) {
      // Only age out malformed lock files left by a crash during acquisition.
      return false;
    }

    const current = await this.readOwner();
    if (owner && current?.token !== owner.token) return false;
    if (!owner && current && this.isProcessAlive(current.pid)) return false;
    await this.fileSystem.unlink(this.lockPath).catch((error) => {
      if (errorCode(error) !== 'ENOENT') throw error;
    });
    await fsyncDirectory(this.fileSystem, path.dirname(this.lockPath));
    return true;
  }

  private async release(owner: LockOwner): Promise<void> {
    if (!await pathExists(this.fileSystem, this.lockPath)) return;
    const current = await this.readOwner();
    if (current?.token !== owner.token) return;
    await this.fileSystem.unlink(this.lockPath).catch((error) => {
      if (errorCode(error) !== 'ENOENT') throw error;
    });
    await fsyncDirectory(this.fileSystem, path.dirname(this.lockPath));
  }

  private async readOwner(): Promise<LockOwner | null> {
    try {
      const raw = await this.fileSystem.readFile(this.lockPath, 'utf8');
      const parsed = JSON.parse(String(raw)) as Partial<LockOwner>;
      if (
        typeof parsed.token !== 'string'
        || typeof parsed.pid !== 'number'
        || typeof parsed.createdAt !== 'number'
      ) {
        return null;
      }
      return parsed as LockOwner;
    } catch {
      return null;
    }
  }
}

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}
