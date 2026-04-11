import { promises as fs } from 'fs';
import path from 'path';
import { createLogger } from '../utils/logger.js';
import type { PluginFileStore } from '@tx5dr/plugin-api';

const logger = createLogger('PluginFileStore');

/**
 * File-system-backed implementation of {@link PluginFileStore}.
 *
 * Files are stored under `{dataDir}/plugins/{pluginName}/files/`. All path
 * arguments are resolved relative to this root and validated to prevent
 * directory traversal attacks.
 */
export class PluginFileStoreProvider implements PluginFileStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  async write(filePath: string, data: Buffer): Promise<void> {
    const resolved = this.resolve(filePath);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, data);
    logger.debug('file written', { path: filePath, size: data.length });
  }

  async read(filePath: string): Promise<Buffer | null> {
    const resolved = this.resolve(filePath);
    try {
      return await fs.readFile(resolved);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async delete(filePath: string): Promise<boolean> {
    const resolved = this.resolve(filePath);
    try {
      await fs.unlink(resolved);
      logger.debug('file deleted', { path: filePath });
      return true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }

  async list(prefix?: string): Promise<string[]> {
    const dir = prefix ? this.resolve(prefix) : this.root;
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
      const base = prefix ? dir : this.root;
      return entries
        .filter(e => e.isFile())
        .map(e => {
          const entryDir = (e as unknown as { parentPath?: string }).parentPath ?? e.path ?? base;
          return path.relative(this.root, path.join(entryDir, e.name));
        });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  /**
   * Resolves a relative path against the sandbox root and validates that the
   * result stays within the sandbox. Throws on any traversal attempt.
   */
  private resolve(filePath: string): string {
    const normalized = path.normalize(filePath);
    if (path.isAbsolute(normalized) || normalized.startsWith('..')) {
      throw new Error(`Path traversal rejected: ${filePath}`);
    }
    const resolved = path.resolve(this.root, normalized);
    if (!resolved.startsWith(this.root)) {
      throw new Error(`Path traversal rejected: ${filePath}`);
    }
    return resolved;
  }
}
