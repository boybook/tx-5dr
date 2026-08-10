import { promises as fs } from 'node:fs';

export interface LegacyDirectoryEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
}

export interface LegacyFileStat {
  size: number;
  mtimeMs: number;
  mode?: number;
  dev?: number;
  ino?: number;
}

export interface LegacyLogbookFileStore {
  listDirectory(dirPath: string): Promise<LegacyDirectoryEntry[]>;
  stat(filePath: string): Promise<LegacyFileStat>;
  exists(filePath: string): Promise<boolean>;
  readFile(filePath: string): Promise<Buffer>;
  makeDirectory(dirPath: string): Promise<void>;
  writeFileDurable(filePath: string, data: Buffer, mode?: number): Promise<void>;
  copyFileDurable(sourcePath: string, targetPath: string): Promise<void>;
  rename(sourcePath: string, targetPath: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
  removeDirectory(dirPath: string): Promise<void>;
  syncDirectory(dirPath: string): Promise<void>;
}

export class NodeLegacyLogbookFileStore implements LegacyLogbookFileStore {
  async listDirectory(dirPath: string): Promise<LegacyDirectoryEntry[]> {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries.map(entry => ({
      name: entry.name,
      isFile: entry.isFile(),
      isDirectory: entry.isDirectory(),
    }));
  }

  async stat(filePath: string): Promise<LegacyFileStat> {
    const stat = await fs.stat(filePath);
    return {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      mode: stat.mode,
      dev: stat.dev,
      ino: stat.ino,
    };
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async readFile(filePath: string): Promise<Buffer> {
    return fs.readFile(filePath);
  }

  async makeDirectory(dirPath: string): Promise<void> {
    await fs.mkdir(dirPath, { recursive: true });
  }

  async writeFileDurable(filePath: string, data: Buffer, mode = 0o600): Promise<void> {
    const handle = await fs.open(filePath, 'w', mode);
    try {
      await handle.chmod(mode);
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async copyFileDurable(sourcePath: string, targetPath: string): Promise<void> {
    await fs.copyFile(sourcePath, targetPath);
    const handle = await fs.open(targetPath, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async rename(sourcePath: string, targetPath: string): Promise<void> {
    await fs.rename(sourcePath, targetPath);
  }

  async unlink(filePath: string): Promise<void> {
    await fs.unlink(filePath);
  }

  async removeDirectory(dirPath: string): Promise<void> {
    await fs.rmdir(dirPath);
  }

  async syncDirectory(dirPath: string): Promise<void> {
    if (process.platform === 'win32') return;
    const handle = await fs.open(dirPath, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
}
