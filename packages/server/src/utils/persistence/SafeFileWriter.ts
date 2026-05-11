import { promises as fs } from 'node:fs';
import path from 'node:path';

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
    super(message);
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
  } catch {
    return false;
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

interface Candidate<T> {
  path: string;
  label: string;
  value?: T;
  serialized?: string;
  error?: string;
}

async function parseCandidate<T>(candidatePath: string, label: string, validate: (value: unknown) => T): Promise<Candidate<T>> {
  try {
    const serialized = await fs.readFile(candidatePath, 'utf-8');
    if (serialized.trim().length === 0) {
      throw new Error('empty file');
    }
    return { path: candidatePath, label, value: validate(JSON.parse(serialized)), serialized };
  } catch (error) {
    return { path: candidatePath, label, error: (error as Error).message };
  }
}

async function listTempCandidates(filePath: string): Promise<string[]> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = await Promise.all(entries
      .filter(entry => entry.isFile() && entry.name.startsWith(`${base}.tmp-`))
      .map(async (entry) => {
        const candidatePath = path.join(dir, entry.name);
        const stat = await fs.stat(candidatePath).catch(() => null);
        return stat ? { path: candidatePath, mtimeMs: stat.mtimeMs } : null;
      }));
    return files
      .filter((entry): entry is { path: string; mtimeMs: number } => Boolean(entry))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .map(entry => entry.path);
  } catch {
    return [];
  }
}

export async function loadJsonWithRecovery<T>(
  filePath: string,
  options: LoadJsonWithRecoveryOptions<T>,
): Promise<{ value: T; recoveredFrom?: string; createdDefault: boolean; serialized: string }> {
  const writer = options.writer ?? new SafeFileWriter({ backups: options.backups ?? 3 });
  const createIfMissing = options.createIfMissing !== false;
  const mainExists = await exists(filePath);

  if (!mainExists) {
    const defaultValue = options.defaultValue();
    const serialized = `${JSON.stringify(defaultValue, null, 2)}\n`;
    if (createIfMissing) {
      await writer.writeFile(filePath, serialized, { backups: options.backups ?? 3 });
    }
    return { value: defaultValue, createdDefault: true, serialized };
  }

  const main = await parseCandidate(filePath, 'main', options.validate);
  if (main.value !== undefined) {
    return { value: main.value, createdDefault: false, serialized: main.serialized ?? '' };
  }

  const rawCandidatePaths = [
    ...(await listTempCandidates(filePath)),
    ...Array.from({ length: options.backups ?? 3 }, (_, index) => `${filePath}.bak.${index + 1}`),
  ];
  const candidatePaths = (await Promise.all(rawCandidatePaths.map(async (candidatePath, order) => {
    const stat = await fs.stat(candidatePath).catch(() => null);
    return stat ? { path: candidatePath, mtimeMs: stat.mtimeMs, order } : null;
  })))
    .filter((candidate): candidate is { path: string; mtimeMs: number; order: number } => Boolean(candidate))
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.order - b.order)
    .map(candidate => candidate.path);

  const failures = [`main: ${main.error ?? 'unknown error'}`];
  for (const candidatePath of candidatePaths) {
    const candidate = await parseCandidate(candidatePath, candidatePath, options.validate);
    if (candidate.value !== undefined) {
      const corruptPath = `${filePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      await fs.rename(filePath, corruptPath).catch((error) => {
        logger.warn('failed to move corrupt json aside', { filePath, corruptPath, error: (error as Error).message });
      });
      await writer.writeFile(filePath, candidate.serialized ?? `${JSON.stringify(candidate.value, null, 2)}\n`, { backups: options.backups ?? 3 });
      return {
        value: candidate.value,
        recoveredFrom: candidate.path,
        createdDefault: false,
        serialized: candidate.serialized ?? '',
      };
    }
    failures.push(`${candidate.label}: ${candidate.error ?? 'unknown error'}`);
  }

  throw new JsonRecoveryError(`Unable to recover JSON file: ${filePath}`, filePath, failures);
}
