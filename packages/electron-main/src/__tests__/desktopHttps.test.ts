import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildDesktopHttpsStatus,
  ensureDefaultSelfSignedCertificate,
  generateSelfSignedCertificate,
  getSelfSignedCertificateRegenerationReason,
  sanitizeDesktopHttpsConfig,
} from '../desktopHttps.js';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tx5dr-desktop-https-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('desktop HTTPS defaults', () => {
  it('enables self-signed HTTPS by default', () => {
    expect(sanitizeDesktopHttpsConfig(undefined)).toMatchObject({
      enabled: true,
      mode: 'self-signed',
      httpsPort: 8443,
      redirectExternalHttp: true,
    });
  });

  it('preserves an explicit disabled setting', () => {
    expect(sanitizeDesktopHttpsConfig({ enabled: false })).toMatchObject({
      enabled: false,
      mode: 'self-signed',
    });
  });
});

describe('desktop HTTPS self-signed certificate preflight', () => {
  it('generates a valid certificate with expected subject alternative names', async () => {
    const configDir = await createTempDir();
    const config = await generateSelfSignedCertificate({
      configDir,
      hostname: 'tx5dr-host',
      lanAddresses: ['192.168.1.20'],
      existingConfig: sanitizeDesktopHttpsConfig(undefined),
    });

    const status = await buildDesktopHttpsStatus({
      configDir,
      config,
      hostname: 'tx5dr-host',
      httpPort: 8076,
      httpsPort: 8443,
      lanAddresses: ['192.168.1.20'],
    });

    expect(status.certificateStatus).toBe('valid');
    expect(status.activeScheme).toBe('https');
    expect(status.usingSelfSigned).toBe(true);
    expect(status.certificateMeta?.altNames).toEqual(expect.arrayContaining([
      'localhost',
      '127.0.0.1',
      'tx5dr-host',
      '192.168.1.20',
    ]));
  });

  it('generates and returns a changed config when the default certificate is missing', async () => {
    const configDir = await createTempDir();
    const result = await ensureDefaultSelfSignedCertificate({
      configDir,
      hostname: 'tx5dr-host',
      lanAddresses: ['192.168.1.20'],
      existingConfig: sanitizeDesktopHttpsConfig(undefined),
    });

    expect(result.changed).toBe(true);
    expect(result.reason).toBe('missing_certificate_path');
    expect(result.config.enabled).toBe(true);
    expect(result.config.mode).toBe('self-signed');
    expect(result.config.certPath).toMatch(/desktop-selfsigned-cert\.pem$/);
    expect(result.config.keyPath).toMatch(/desktop-selfsigned-key\.pem$/);
  });

  it('regenerates a self-signed certificate when the key does not match', async () => {
    const configDir = await createTempDir();
    const otherConfigDir = await createTempDir();
    const config = await generateSelfSignedCertificate({
      configDir,
      hostname: 'tx5dr-host',
      lanAddresses: ['192.168.1.20'],
      existingConfig: sanitizeDesktopHttpsConfig(undefined),
    });
    const otherConfig = await generateSelfSignedCertificate({
      configDir: otherConfigDir,
      hostname: 'tx5dr-host',
      lanAddresses: ['192.168.1.20'],
      existingConfig: sanitizeDesktopHttpsConfig(undefined),
    });

    const mismatchedConfig = {
      ...config,
      keyPath: otherConfig.keyPath,
    };
    await expect(getSelfSignedCertificateRegenerationReason({
      config: mismatchedConfig,
      hostname: 'tx5dr-host',
      lanAddresses: ['192.168.1.20'],
    })).resolves.toBe('certificate_key_mismatch');

    const result = await ensureDefaultSelfSignedCertificate({
      configDir,
      hostname: 'tx5dr-host',
      lanAddresses: ['192.168.1.20'],
      existingConfig: mismatchedConfig,
    });

    expect(result.changed).toBe(true);
    expect(result.reason).toBe('certificate_key_mismatch');
    await expect(getSelfSignedCertificateRegenerationReason({
      config: result.config,
      hostname: 'tx5dr-host',
      lanAddresses: ['192.168.1.20'],
    })).resolves.toBeNull();
  });

  it('regenerates a self-signed certificate when expected SAN entries are missing', async () => {
    const configDir = await createTempDir();
    const config = await generateSelfSignedCertificate({
      configDir,
      hostname: 'old-host',
      lanAddresses: [],
      existingConfig: sanitizeDesktopHttpsConfig(undefined),
    });

    const result = await ensureDefaultSelfSignedCertificate({
      configDir,
      hostname: 'new-host',
      lanAddresses: ['192.168.1.30'],
      existingConfig: config,
    });

    expect(result.changed).toBe(true);
    expect(result.reason).toBe('subject_alt_name_mismatch');
    const status = await buildDesktopHttpsStatus({
      configDir,
      config: result.config,
      hostname: 'new-host',
      httpPort: 8076,
      httpsPort: 8443,
      lanAddresses: ['192.168.1.30'],
    });
    expect(status.certificateMeta?.altNames).toEqual(expect.arrayContaining([
      'localhost',
      '127.0.0.1',
      'new-host',
      '192.168.1.30',
    ]));
  });

  it('does not overwrite imported PEM settings', async () => {
    const configDir = await createTempDir();
    const result = await ensureDefaultSelfSignedCertificate({
      configDir,
      hostname: 'tx5dr-host',
      lanAddresses: ['192.168.1.20'],
      existingConfig: {
        ...sanitizeDesktopHttpsConfig(undefined),
        mode: 'imported-pem',
        certPath: '/missing/cert.pem',
        keyPath: '/missing/key.pem',
      },
    });

    expect(result.changed).toBe(false);
    expect(result.config.mode).toBe('imported-pem');
    expect(result.config.certPath).toBe('/missing/cert.pem');
  });
});
