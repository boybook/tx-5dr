import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

describe('LiveKitCredentialState', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.LIVEKIT_CREDENTIALS_FILE;
    delete process.env.LIVEKIT_API_KEY;
    delete process.env.LIVEKIT_API_SECRET;
    delete process.env.LIVEKIT_CONFIG_FILE;
    delete process.env.TX5DR_CONFIG_DIR;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it('prefers explicit LIVEKIT_CREDENTIALS_FILE when provided', async () => {
    process.env.LIVEKIT_CREDENTIALS_FILE = '/tmp/custom-livekit.env';
    const module = await import('../LiveKitCredentialState.js');

    expect(module.resolveLiveKitCredentialFilePath()).toBe('/tmp/custom-livekit.env');
  });

  it('uses managed linux credential path for packaged deployments even if env file omitted the credential variable', async () => {
    process.env.TX5DR_CONFIG_DIR = '/var/lib/tx5dr/config';
    process.env.LIVEKIT_CONFIG_FILE = '/etc/tx5dr/livekit.yaml';

    const existsSpy = vi.spyOn(fs, 'existsSync').mockImplementation((target) => {
      return target === '/etc/tx5dr/livekit-credentials.env';
    });

    const module = await import('../LiveKitCredentialState.js');

    expect(module.resolveLiveKitCredentialFilePath()).toBe('/etc/tx5dr/livekit-credentials.env');
    expect(existsSpy).not.toHaveBeenCalledWith('/var/lib/tx5dr/config/livekit-credentials.env');
  });

  it('falls back to TX5DR_CONFIG_DIR for non-managed runtime layouts', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tx5dr-livekit-'));
    process.env.TX5DR_CONFIG_DIR = tempRoot;

    const module = await import('../LiveKitCredentialState.js');

    expect(module.resolveLiveKitCredentialFilePath()).toBe(path.join(tempRoot, 'livekit-credentials.env'));
  });
});
