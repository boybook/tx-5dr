import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { createLogger } from '../logger.js';

const logger = createLogger('SafeFileWriter');

export interface SafeWriteOptions {
  backups?: number;
  mode?: number;
  retryCount?: number;
  retryDelayMs?: number;
  fsync?: boolean;
}

export class JsonRecoveryError extends Error {
  constructor(message: string, public readonly filePath: string, public readonly causes: string[] = []) {
    super(causes.length ? `${message} (${causes.slice(0, 10).join('; ')})` : message);
    this.name = 'JsonRecoveryError';
  }
}

function isRetryableRenameError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function renameWithRetry(source: string, target: string, options: Required<Pick<SafeWriteOptions, 'retryCount' | 'retryDelayMs'>>): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= options.retryCount; attempt += 1) {
    try {
      await fs.rename(source, target);
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableRenameError(error) || attempt >= options.retryCount) {
        break;
      }
      await sleep(options.retryDelayMs * (attempt + 1));
    }
  }
  throw lastError;
}

export async function fsyncDirectoryBestEffort(dirPath: string): Promise<void> {
  if (process.platform === 'win32') {
    return;
  }

  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(dirPath, 'r');
    await handle.sync();
  } catch (error) {
    logger.debug('directory fsync skipped', { dirPath, error: (error as Error).message });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export class SafeFileWriter {
  private sequence = 0;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly defaultOptions: SafeWriteOptions = {}) {}

  async writeFile(filePath: string, data: string | Buffer, options: SafeWriteOptions = {}): Promise<void> {
    const merged = { ...this.defaultOptions, ...options };
    const run = this.tail.catch(() => undefined).then(() => this.writeFileNow(filePath, data, merged));
    this.tail = run.catch(() => undefined);
    await run;
  }

  async flush(): Promise<void> {
    await this.tail;
  }

  private async writeFileNow(filePath: string, data: string | Buffer, options: SafeWriteOptions): Promise<void> {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    const retryOptions = {
      retryCount: options.retryCount ?? 8,
      retryDelayMs: options.retryDelayMs ?? 25,
    };
    const backups = Math.max(0, options.backups ?? 3);
    const tmpPath = path.join(dir, `${base}.tmp-${process.pid}-${Date.now()}-${++this.sequence}`);

    await fs.mkdir(dir, { recursive: true });

    let handle: fs.FileHandle | null = null;
    try {
      handle = await fs.open(tmpPath, 'w', options.mode ?? 0o600);
      await handle.writeFile(data);
      if (options.fsync !== false) {
        await handle.sync();
      }
      await handle.close();
      handle = null;

      if (backups > 0 && await exists(filePath)) {
        await this.rotateBackups(filePath, backups, retryOptions);
      }

      await renameWithRetry(tmpPath, filePath, retryOptions);
      await fsyncDirectoryBestEffort(dir);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.unlink(tmpPath).catch(() => undefined);
      throw error;
    }
  }

  private async rotateBackups(filePath: string, backups: number, retryOptions: Required<Pick<SafeWriteOptions, 'retryCount' | 'retryDelayMs'>>): Promise<void> {
    for (let index = backups; index >= 2; index -= 1) {
      const from = `${filePath}.bak.${index - 1}`;
      const to = `${filePath}.bak.${index}`;
      if (await exists(from)) {
        await fs.unlink(to).catch(() => undefined);
        await renameWithRetry(from, to, retryOptions).catch((error) => {
          logger.warn('failed to rotate backup', { from, to, error: (error as Error).message });
        });
      }
    }

    await fs.copyFile(filePath, `${filePath}.bak.1`).catch((error) => {
      logger.warn('failed to create backup before safe write', { filePath, error: (error as Error).message });
    });
  }
}

export async function safeWriteFile(filePath: string, data: string | Buffer, options?: SafeWriteOptions): Promise<void> {
  await new SafeFileWriter().writeFile(filePath, data, options);
}

export async function safeWriteJson(filePath: string, value: unknown, options?: SafeWriteOptions): Promise<void> {
  await safeWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`, options);
}

export interface LoadJsonWithRecoveryOptions<T> {
  defaultValue: () => T;
  validate: (value: unknown) => T;
  writer?: SafeFileWriter;
  backups?: number;
  createIfMissing?: boolean;
}

/** Only absence is recoverable as a new file; an inaccessible file is still user data. */
export async function readOptionalFile(filePath: string): Promise<Buffer | null> {
  try { return await fs.readFile(filePath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function listRecoveryCandidates(filePath: string, backups = 3): Promise<string[]> {
  const dir = path.dirname(filePath);
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const names = new Set(Array.from({ length: backups }, (_, i) => `${path.basename(filePath)}.bak.${i + 1}`));
  const candidates = await Promise.all(entries
    .filter(entry => names.has(entry.name) || entry.name.startsWith(`${path.basename(filePath)}.tmp-`))
    .map(async entry => {
      const candidatePath = path.join(dir, entry.name);
      try { return { path: candidatePath, mtime: (await fs.stat(candidatePath)).mtimeMs }; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    }));
  return candidates.filter((item): item is { path: string; mtime: number } => item !== null)
    .sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path)).map(item => item.path);
}

/** Do not include JSON contents or validator messages (which can quote secret values). */
export function jsonFailureCode(error: unknown): string {
  if (error instanceof SyntaxError) return 'INVALID_JSON';
  const code = (error as NodeJS.ErrnoException)?.code;
  return typeof code === 'string' ? code : 'INVALID_SCHEMA';
}

export async function loadJsonWithRecovery<T>(
  filePath: string,
  options: LoadJsonWithRecoveryOptions<T>,
): Promise<{ value: T; recoveredFrom?: string; createdDefault: boolean; serialized: string }> {
  const writer = options.writer ?? new SafeFileWriter({ backups: options.backups ?? 3 });
  const main = await readOptionalFile(filePath);
  const failures: string[] = [];
  if (main !== null) {
    try {
      const serialized = main.toString('utf8');
      return { value: options.validate(JSON.parse(serialized)), createdDefault: false, serialized };
    } catch (error) { failures.push(`main: ${jsonFailureCode(error)}`); }
  }
  const candidates = await listRecoveryCandidates(filePath, options.backups);
  for (const candidatePath of candidates) {
    const raw = await readOptionalFile(candidatePath);
    if (raw === null) continue;
    let value: T;
    const serialized = raw.toString('utf8');
    try { value = options.validate(JSON.parse(serialized)); }
    catch (error) {
      failures.push(`${path.basename(candidatePath)}: ${jsonFailureCode(error)}`);
      continue;
    }
    // Copy durably before replacing; a failed archive must never allow an overwrite.
    if (main !== null) {
      const digest = createHash('sha256').update(main).digest('hex');
      await writer.writeFile(`${filePath}.corrupt-${digest}`, main, { backups: 0 });
    }
    // Recovery must not rotate away the candidate that made recovery possible.
    await writer.writeFile(filePath, serialized, { backups: 0 });
    return { value, recoveredFrom: candidatePath, createdDefault: false, serialized };
  }
  if (main === null && candidates.length === 0) {
    const value = options.validate(options.defaultValue());
    const serialized = `${JSON.stringify(value, null, 2)}\n`;
    if (options.createIfMissing !== false) await writer.writeFile(filePath, serialized, { backups: options.backups ?? 3 });
    return { value, createdDefault: true, serialized };
  }
  throw new JsonRecoveryError(`Unable to recover JSON file: ${filePath}`, filePath, failures);
}
