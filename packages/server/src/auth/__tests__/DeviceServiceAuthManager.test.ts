import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { DeviceServiceAuthManager } from '../DeviceServiceAuthManager.js';

async function createManager(now = 1_700_000_000_000): Promise<DeviceServiceAuthManager> {
  const dir = await mkdtemp(join(tmpdir(), 'tx5dr-device-auth-'));
  const manager = new DeviceServiceAuthManager({
    sessionTokenFilePath: join(dir, '.device-ui-token'),
    stateFilePath: join(dir, 'device-ui-auth-state.json'),
    jwtTtlSeconds: 60,
    now: () => now,
  });
  await manager.initialize();
  return manager;
}

describe('DeviceServiceAuthManager', () => {
  it('creates a protected device UI token file outside auth.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tx5dr-device-auth-'));
    const tokenPath = join(dir, '.device-ui-token');
    const statePath = join(dir, 'device-ui-auth-state.json');
    const manager = new DeviceServiceAuthManager({ sessionTokenFilePath: tokenPath, stateFilePath: statePath });

    await manager.initialize();

    expect(await readFile(tokenPath, 'utf-8')).toBe(manager.getSessionToken());
    if (process.platform !== 'win32') {
      expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
    }
    expect(await readFile(statePath, 'utf-8')).toContain('jwtSecret');
  });

  it('checks the file-backed session token before issuing a JWT', async () => {
    const manager = await createManager();

    expect(manager.validateSessionToken('wrong')).toBe(false);
    await expect(manager.createSession({ deviceId: 'panel-1', sessionToken: 'wrong' })).resolves.toBeNull();

    const response = await manager.createSession({ deviceId: 'panel-1', sessionToken: manager.getSessionToken() });
    expect(response?.deviceId).toBe('panel-1');
    expect(response?.jwt).toBeTypeOf('string');
  });

  it('signs and verifies only active device-ui JWT sessions', async () => {
    const manager = await createManager();
    const { jwt, payload } = await manager.signDeviceJwt({ deviceId: 'panel-2' });

    expect(payload.typ).toBe('device-ui');
    expect(payload.aud).toBe('tx5dr-device-ui');
    expect(manager.verifyDeviceJwt(jwt)).toMatchObject({ deviceId: 'panel-2', sessionId: payload.sessionId });
    expect(manager.isSessionJwtValid(jwt)).toBe(true);

    await manager.revokeSession(payload.sessionId);

    expect(manager.verifyDeviceJwt(jwt)).toMatchObject({ deviceId: 'panel-2' });
    expect(manager.isSessionJwtValid(jwt)).toBe(false);
  });
});
