import { promises as fs } from 'node:fs';
import path from 'node:path';

export function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function resolveSafeRelativePath(root: string, relativePath: string): string | null {
  if (relativePath.includes('\0')) {
    return null;
  }

  const normalized = path.normalize(relativePath);
  if (path.isAbsolute(normalized) || normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    return null;
  }

  const resolved = path.resolve(root, normalized);
  return isPathInside(root, resolved) ? resolved : null;
}

export function validateArchiveRelativePath(relativePath: string): void {
  if (relativePath.includes('\0')) {
    throw new Error(`Invalid archive path: ${relativePath}`);
  }

  const normalizedInput = relativePath.replace(/\\/g, '/');
  const normalized = path.posix.normalize(normalizedInput);
  const hasParentSegment = normalizedInput.split('/').includes('..');
  const isAbsolute = path.posix.isAbsolute(normalizedInput)
    || path.win32.isAbsolute(relativePath)
    || /^[a-zA-Z]:/.test(relativePath);

  if (
    !normalizedInput
    || normalized === '.'
    || isAbsolute
    || hasParentSegment
    || normalized === '..'
    || normalized.startsWith('../')
  ) {
    throw new Error(`Unsafe archive path rejected: ${relativePath}`);
  }
}

export async function assertRealPathInside(root: string, target: string): Promise<void> {
  const [realRoot, realTarget] = await Promise.all([
    fs.realpath(root),
    fs.realpath(target),
  ]);

  if (!isPathInside(realRoot, realTarget)) {
    throw new Error(`Resolved path escapes root: ${target}`);
  }
}

export async function validateExtractedTree(root: string): Promise<void> {
  await assertRealPathInside(root, root);

  const visit = async (current: string) => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      const relative = path.relative(root, entryPath);
      if (!resolveSafeRelativePath(root, relative)) {
        throw new Error(`Unsafe extracted path rejected: ${relative}`);
      }

      const stat = await fs.lstat(entryPath);
      if (stat.isSymbolicLink()) {
        throw new Error(`Plugin archives must not contain symbolic links: ${relative}`);
      }

      await assertRealPathInside(root, entryPath);
      if (stat.isDirectory()) {
        await visit(entryPath);
      }
    }
  };

  await visit(root);
}
