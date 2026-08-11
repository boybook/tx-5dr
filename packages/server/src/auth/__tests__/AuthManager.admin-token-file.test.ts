import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RuntimeStateManager } from '../../config/RuntimeStateManager.js';
import { AuthManager } from '../AuthManager.js';
import { tx5drPaths } from '../../utils/app-paths.js';

function resetAuthSingletons(): void {
  (AuthManager as unknown as { instance?: AuthManager }).instance = undefined;
  (RuntimeStateManager as unknown as { instance?: RuntimeStateManager | null }).instance = null;
  (tx5drPaths as unknown as { _configDir: string | null })._configDir = null;
}

describe('.admin-token compatibility', () => {
  const previousConfigDir = process.env.TX5DR_CONFIG_DIR;
  let configDir: string;
  let authManager: AuthManager;

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'tx5dr-admin-token-file-'));
    process.env.TX5DR_CONFIG_DIR = configDir;
    resetAuthSingletons();
  });

  afterEach(async () => {
    await authManager?.flush();
    resetAuthSingletons();
    if (previousConfigDir === undefined) delete process.env.TX5DR_CONFIG_DIR;
    else process.env.TX5DR_CONFIG_DIR = previousConfigDir;
    await rm(configDir, { recursive: true, force: true });
  });

  it('preserves an existing token and restricts its POSIX permissions', async () => {
    const tokenPath = join(configDir, '.admin-token');
    const originalToken = 'txdr_existing_admin_token_that_must_not_rotate';
    await writeFile(tokenPath, originalToken, { mode: 0o644 });
    if (process.platform !== 'win32') await chmod(tokenPath, 0o644);

    authManager = AuthManager.getInstance();
    await authManager.initialize();

    expect(await readFile(tokenPath, 'utf8')).toBe(originalToken);
    if (process.platform !== 'win32') {
      expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
    }
  });

  it('creates a new token file with owner-only POSIX permissions', async () => {
    const tokenPath = join(configDir, '.admin-token');
    authManager = AuthManager.getInstance();
    await authManager.initialize();

    expect((await readFile(tokenPath, 'utf8')).trim()).toMatch(/^txdr_/);
    if (process.platform !== 'win32') {
      expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
    }
  });
});
