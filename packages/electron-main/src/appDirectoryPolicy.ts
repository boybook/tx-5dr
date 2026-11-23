import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Decides which local paths a station page may open with `shell:openPath`.
 *
 * Paths arrive from the station UI (logs, data, plugin and diagnostics
 * directories reported by the embedded server). They are opened only when they
 * resolve, after following symbolic links, inside one of the app's own roots.
 * A missing directory may be created only inside those roots.
 */

export interface AppDirectoryRoots {
  roots: readonly string[];
}

export type OpenablePathDecision =
  | { allowed: true; path: string; exists: boolean }
  | { allowed: false; reason: 'invalid_path' | 'outside_app_roots' };

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function realpathOrNull(target: string): Promise<string | null> {
  try {
    return await fs.realpath(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Resolves the deepest existing ancestor through symbolic links and re-appends the rest. */
async function resolveThroughExistingAncestor(target: string): Promise<{ resolved: string; exists: boolean }> {
  const missing: string[] = [];
  let current = target;
  for (;;) {
    const real = await realpathOrNull(current);
    if (real !== null) {
      return { resolved: path.join(real, ...missing.reverse()), exists: missing.length === 0 };
    }
    const parent = path.dirname(current);
    if (parent === current) return { resolved: target, exists: false };
    missing.push(path.basename(current));
    current = parent;
  }
}

export async function resolveOpenableAppPath(
  requested: unknown,
  options: AppDirectoryRoots,
): Promise<OpenablePathDecision> {
  if (typeof requested !== 'string' || requested.trim() === '' || requested.includes('\0')) {
    return { allowed: false, reason: 'invalid_path' };
  }
  if (!path.isAbsolute(requested)) return { allowed: false, reason: 'invalid_path' };

  const { resolved, exists } = await resolveThroughExistingAncestor(path.resolve(requested));
  for (const root of options.roots) {
    const { resolved: resolvedRoot } = await resolveThroughExistingAncestor(path.resolve(root));
    if (isInside(resolved, resolvedRoot)) return { allowed: true, path: resolved, exists };
  }
  return { allowed: false, reason: 'outside_app_roots' };
}
