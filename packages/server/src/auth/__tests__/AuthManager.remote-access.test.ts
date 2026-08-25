import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuthManager } from '../AuthManager.js';
import { RuntimeStateManager } from '../../config/RuntimeStateManager.js';
import { tx5drPaths } from '../../utils/app-paths.js';

function resetSingletons() {
  (AuthManager as unknown as { instance?: AuthManager }).instance = undefined;
  (RuntimeStateManager as unknown as { instance?: RuntimeStateManager | null }).instance = null;
  for (const key of ['_configDir', '_dataDir', '_logsDir', '_cacheDir']) {
    (tx5drPaths as unknown as Record<string, unknown>)[key] = null;
  }
}

describe('AuthManager remote access migration', () => {
  let configDir = '';
  const previousConfigDir = process.env.TX5DR_CONFIG_DIR;
  const previousRuntimeManagement = process.env.TX5DR_RUNTIME_MANAGEMENT;

  beforeEach(() => {
    configDir = mkdtempSync(path.join(os.tmpdir(), 'tx5dr-remote-access-'));
    process.env.TX5DR_CONFIG_DIR = configDir;
    delete process.env.TX5DR_RUNTIME_MANAGEMENT;
    resetSingletons();
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
    resetSingletons();
    if (previousConfigDir === undefined) delete process.env.TX5DR_CONFIG_DIR;
    else process.env.TX5DR_CONFIG_DIR = previousConfigDir;
    if (previousRuntimeManagement === undefined) delete process.env.TX5DR_RUNTIME_MANAGEMENT;
    else process.env.TX5DR_RUNTIME_MANAGEMENT = previousRuntimeManagement;
  });

  it('disables public viewing on a new installation', async () => {
    const manager = AuthManager.getInstance();
    await manager.initialize();
    expect(manager.isPublicViewingAllowed()).toBe(false);
  });

  it('starts a new Electron installation in local-only mode', async () => {
    process.env.TX5DR_RUNTIME_MANAGEMENT = 'electron';
    const manager = AuthManager.getInstance();
    await manager.initialize();
    expect(manager.getRemoteAccessConfig()).toMatchObject({
      preset: 'local',
      maxConnections: 8,
      maxConnectionsPerIp: 8,
      maxPendingAuth: 8,
    });
  });

  it('normalizes a persisted local preset to LAN for external deployments', async () => {
    writeFileSync(path.join(configDir, 'auth.json'), JSON.stringify({
      enabled: true,
      allowPublicViewing: false,
      remoteAccess: { preset: 'local', allowedOrigins: [] },
      jwtSecret: 'legacy-secret',
      tokens: [],
    }));
    const manager = AuthManager.getInstance();
    await manager.initialize();
    expect(manager.getRemoteAccessConfig()).toMatchObject({
      preset: 'lan',
      maxConnections: 32,
      maxConnectionsPerIp: 16,
      maxPendingAuth: 32,
    });
  });

  it('preserves the legacy effective default when an existing config omitted the field', async () => {
    writeFileSync(path.join(configDir, 'auth.json'), JSON.stringify({
      enabled: true,
      jwtSecret: 'legacy-secret',
      tokens: [],
    }));
    const manager = AuthManager.getInstance();
    await manager.initialize();
    expect(manager.isPublicViewingAllowed()).toBe(true);
    expect(JSON.parse(readFileSync(path.join(configDir, 'auth.json'), 'utf8')).allowPublicViewing).toBe(true);
  });

  it('fails closed instead of migrating a corrupt config to public viewing', async () => {
    writeFileSync(path.join(configDir, 'auth.json'), '{broken');
    const manager = AuthManager.getInstance();
    await expect(manager.initialize()).rejects.toThrow('Unable to recover JSON file');
  });

  it('requires an explicit origin for managed public deployment and accepts HTTP', async () => {
    const manager = AuthManager.getInstance();
    await manager.initialize();

    await expect(manager.updateRemoteAccessConfig({ preset: 'public', allowedOrigins: [] }))
      .rejects.toMatchObject({ code: 'PUBLIC_ORIGIN_REQUIRED' });

    const updated = await manager.updateRemoteAccessConfig({
      preset: 'public',
      allowedOrigins: ['http://radio.example.com/'],
    });
    expect(updated).toMatchObject({
      preset: 'public',
      allowedOrigins: ['http://radio.example.com'],
      maxConnections: 128,
      maxConnectionsPerIp: 32,
    });
  });

  it('loads a manually configured secure public origin', async () => {
    writeFileSync(path.join(configDir, 'auth.json'), JSON.stringify({
      enabled: true,
      allowPublicViewing: false,
      remoteAccess: {
        preset: 'public',
        allowedOrigins: ['https://radio.example.com'],
      },
      jwtSecret: 'existing-secret',
      tokens: [],
    }));

    const manager = AuthManager.getInstance();
    await manager.initialize();

    expect(manager.getRemoteAccessConfig()).toMatchObject({
      preset: 'public',
      allowedOrigins: ['https://radio.example.com'],
    });
  });

  it('loads a manually configured HTTP public origin', async () => {
    writeFileSync(path.join(configDir, 'auth.json'), JSON.stringify({
      enabled: true,
      allowPublicViewing: false,
      remoteAccess: {
        preset: 'public',
        allowedOrigins: ['http://radio.example.com'],
      },
      jwtSecret: 'existing-secret',
      tokens: [],
    }));

    const manager = AuthManager.getInstance();
    await manager.initialize();

    expect(manager.getRemoteAccessConfig()).toMatchObject({
      preset: 'public',
      allowedOrigins: ['http://radio.example.com'],
    });
  });
});
