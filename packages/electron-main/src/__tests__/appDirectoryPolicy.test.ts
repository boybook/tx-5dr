import { mkdtemp, mkdir, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveOpenableAppPath } from '../appDirectoryPolicy.js';

describe('resolveOpenableAppPath', () => {
  let base: string;
  let appRoot: string;
  let outside: string;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'tx5dr-open-path-')));
    appRoot = join(base, 'TX-5DR');
    outside = join(base, 'outside');
    await mkdir(join(appRoot, 'logs'), { recursive: true });
    await mkdir(outside, { recursive: true });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('allows existing and missing directories inside an app root', async () => {
    await expect(resolveOpenableAppPath(join(appRoot, 'logs'), { roots: [appRoot] }))
      .resolves.toEqual({ allowed: true, path: join(appRoot, 'logs'), exists: true });
    await expect(resolveOpenableAppPath(join(appRoot, 'plugins', 'new'), { roots: [appRoot] }))
      .resolves.toEqual({ allowed: true, path: join(appRoot, 'plugins', 'new'), exists: false });
  });

  it('rejects paths outside the app roots, including traversal', async () => {
    await expect(resolveOpenableAppPath(outside, { roots: [appRoot] }))
      .resolves.toEqual({ allowed: false, reason: 'outside_app_roots' });
    await expect(resolveOpenableAppPath(join(appRoot, '..', 'outside'), { roots: [appRoot] }))
      .resolves.toEqual({ allowed: false, reason: 'outside_app_roots' });
    await expect(resolveOpenableAppPath(`${appRoot}-sibling`, { roots: [appRoot] }))
      .resolves.toEqual({ allowed: false, reason: 'outside_app_roots' });
  });

  it('follows symbolic links before checking containment', async () => {
    await symlink(outside, join(appRoot, 'escape'));
    await expect(resolveOpenableAppPath(join(appRoot, 'escape'), { roots: [appRoot] }))
      .resolves.toEqual({ allowed: false, reason: 'outside_app_roots' });
    await expect(resolveOpenableAppPath(join(appRoot, 'escape', 'child'), { roots: [appRoot] }))
      .resolves.toEqual({ allowed: false, reason: 'outside_app_roots' });
  });

  it('rejects relative, empty and non-string input', async () => {
    for (const value of ['logs', '', 42, null, `${appRoot}\0x`]) {
      await expect(resolveOpenableAppPath(value, { roots: [appRoot] }))
        .resolves.toEqual({ allowed: false, reason: 'invalid_path' });
    }
  });
});
