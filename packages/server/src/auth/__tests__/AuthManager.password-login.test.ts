import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UserRole } from '@tx5dr/contracts';
import { RuntimeStateManager } from '../../config/RuntimeStateManager.js';
import { AuthManager } from '../AuthManager.js';

function resetAuthSingletons(): void {
  (AuthManager as unknown as { instance?: AuthManager }).instance = undefined;
  (RuntimeStateManager as unknown as { instance?: RuntimeStateManager | null }).instance = null;
}

describe('AuthManager password login credentials', () => {
  const previousConfigDir = process.env.TX5DR_CONFIG_DIR;
  let configDir: string;
  let authManager: AuthManager;

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'tx5dr-auth-password-login-'));
    process.env.TX5DR_CONFIG_DIR = configDir;
    resetAuthSingletons();
    authManager = AuthManager.getInstance();
    await authManager.initialize();
  });

  afterEach(async () => {
    await authManager.flush();
    resetAuthSingletons();
    if (previousConfigDir === undefined) {
      delete process.env.TX5DR_CONFIG_DIR;
    } else {
      process.env.TX5DR_CONFIG_DIR = previousConfigDir;
    }
    await rm(configDir, { recursive: true, force: true });
  });

  it('enables password login after an admin assigns username and password to a token', async () => {
    const created = await authManager.createToken({
      label: 'Operator',
      role: UserRole.OPERATOR,
      operatorIds: [],
      maxOperators: 1,
    }, null);

    expect(await authManager.validatePasswordLogin('alice', 'password123')).toBeNull();

    const updated = await authManager.updateToken(created.id, {
      loginCredential: {
        username: 'alice',
        password: 'password123',
      },
    });

    expect(updated?.loginCredential).toEqual({
      username: 'alice',
      allowSelfService: false,
    });

    const login = await authManager.validatePasswordLogin('ALICE', 'password123');
    expect(login?.id).toBe(created.id);
  });

  it('does not treat self-service permission alone as an enabled password login', async () => {
    const created = await authManager.createToken({
      label: 'Self service pending',
      role: UserRole.OPERATOR,
      operatorIds: [],
      maxOperators: 1,
      allowSelfLoginCredential: true,
    }, null);

    const tokenInfo = authManager.getTokenById(created.id);
    expect(tokenInfo?.allowSelfLoginCredential).toBe(true);
    expect(tokenInfo?.loginCredential).toBeUndefined();
    await expect(authManager.validatePasswordLogin('alice', 'password123')).resolves.toBeNull();
  });
});
