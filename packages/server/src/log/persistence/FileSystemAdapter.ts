import { constants, promises as fs } from 'node:fs';

export interface AdifFileStat {
  size: number;
  mtimeMs: number;
  mode?: number;
  dev?: number;
  ino?: number;
  isFile(): boolean;
}

export interface AdifFileHandle {
  read(
    buffer: Uint8Array,
    offset?: number,
    length?: number,
    position?: number | null,
  ): Promise<{ bytesRead: number }>;
  write(
    buffer: Uint8Array,
    offset?: number,
    length?: number,
    position?: number | null,
  ): Promise<{ bytesWritten: number }>;
  sync(): Promise<void>;
  truncate(length?: number): Promise<void>;
  close(): Promise<void>;
}

export interface AdifFileSystem {
  open(filePath: string, flags: string | number, mode?: number): Promise<AdifFileHandle>;
  stat(filePath: string): Promise<AdifFileStat>;
  readFile(filePath: string, encoding?: BufferEncoding): Promise<Buffer | string>;
  mkdir(dirPath: string, options?: { recursive?: boolean; mode?: number }): Promise<unknown>;
  rename(source: string, target: string): Promise<void>;
  copyFile(source: string, target: string): Promise<void>;
  chmod(filePath: string, mode: number): Promise<void>;
  unlink(filePath: string): Promise<void>;
  utimes(filePath: string, atime: Date, mtime: Date): Promise<void>;
  readdir(dirPath: string): Promise<string[]>;
  rmdir(dirPath: string): Promise<void>;
}

export const nodeAdifFileSystem: AdifFileSystem = {
  open: (filePath, flags, mode) => fs.open(filePath, flags, mode),
  stat: (filePath) => fs.stat(filePath),
  readFile: (filePath, encoding) => encoding
    ? fs.readFile(filePath, encoding)
    : fs.readFile(filePath),
  mkdir: (dirPath, options) => fs.mkdir(dirPath, options),
  rename: (source, target) => fs.rename(source, target),
  copyFile: (source, target) => fs.copyFile(source, target),
  chmod: (filePath, mode) => fs.chmod(filePath, mode),
  unlink: (filePath) => fs.unlink(filePath),
  utimes: (filePath, atime, mtime) => fs.utimes(filePath, atime, mtime),
  readdir: (dirPath) => fs.readdir(dirPath),
  rmdir: (dirPath) => fs.rmdir(dirPath),
};

export const ADIF_APPEND_FLAGS = constants.O_WRONLY | constants.O_APPEND;
export const ADIF_CREATE_APPEND_FLAGS = ADIF_APPEND_FLAGS | constants.O_CREAT;
export const ADIF_REWRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC;
export const ADIF_EXCLUSIVE_CREATE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL;

export async function pathExists(fileSystem: AdifFileSystem, filePath: string): Promise<boolean> {
  try {
    await fileSystem.stat(filePath);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

export async function writeAll(
  handle: AdifFileHandle,
  input: Uint8Array,
  position: number | null = null,
): Promise<void> {
  let offset = 0;
  while (offset < input.byteLength) {
    const writePosition = position === null ? null : position + offset;
    const { bytesWritten } = await handle.write(input, offset, input.byteLength - offset, writePosition);
    if (!Number.isInteger(bytesWritten) || bytesWritten <= 0) {
      throw new Error('File write made no forward progress');
    }
    offset += bytesWritten;
  }
}

export async function fsyncFile(fileSystem: AdifFileSystem, filePath: string): Promise<void> {
  const handle = await fileSystem.open(filePath, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function fsyncDirectory(fileSystem: AdifFileSystem, dirPath: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await fileSystem.open(dirPath, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}
