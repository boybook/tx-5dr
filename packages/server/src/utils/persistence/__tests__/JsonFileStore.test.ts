import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

import { JsonFileStore, JsonRecoveryError, SafeFileWriter } from '../index.js';
import { validateAppConfigCandidate } from '../../../config/config-manager.js';

interface TestConfig {
  version: number;
  name: string;
}

function validateTestConfig(value: unknown): TestConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('root must be an object');
  }
  const candidate = value as Partial<TestConfig>;
  if (typeof candidate.version !== 'number' || typeof candidate.name !== 'string') {
    throw new Error('invalid test config');
  }
  return { version: candidate.version, name: candidate.name };
}

describe('JsonFileStore durability', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('recovers a corrupt main file from the newest valid backup without writing defaults', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'tx5dr-json-store-'));
    tempDirs.push(tempDir);
    const filePath = join(tempDir, 'config.json');

    const store = new JsonFileStore<TestConfig>(filePath, {
      defaultValue: () => ({ version: 1, name: 'default' }),
      validate: validateTestConfig,
      backups: 3,
    });
    await store.load();
    await store.set({ version: 2, name: 'good-backup' });
    await writeFile(filePath, '{"version":', 'utf-8');

    const recovered = new JsonFileStore<TestConfig>(filePath, {
      defaultValue: () => ({ version: 99, name: 'must-not-overwrite' }),
      validate: validateTestConfig,
      backups: 3,
    });

    await expect(recovered.load()).resolves.toEqual({ version: 1, name: 'default' });
    const mainContent = await readFile(filePath, 'utf-8');
    expect(mainContent).toContain('"name": "default"');
    expect(mainContent).not.toContain('must-not-overwrite');
  });

  it('throws and leaves a corrupt main file untouched when no valid recovery candidate exists', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'tx5dr-json-store-'));
    tempDirs.push(tempDir);
    const filePath = join(tempDir, 'config.json');
    await writeFile(filePath, '{"version":', 'utf-8');

    const store = new JsonFileStore<TestConfig>(filePath, {
      defaultValue: () => ({ version: 1, name: 'default' }),
      validate: validateTestConfig,
      backups: 3,
    });

    await expect(store.load()).rejects.toBeInstanceOf(JsonRecoveryError);
    await expect(readFile(filePath, 'utf-8')).resolves.toBe('{"version":');
  });

  it('does not poison later queued writes after a failed safe write', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'tx5dr-safe-writer-'));
    tempDirs.push(tempDir);
    const blockedPath = join(tempDir, 'blocked');
    await writeFile(blockedPath, 'not a directory', 'utf-8');

    const writer = new SafeFileWriter();
    await expect(writer.writeFile(join(blockedPath, 'config.json'), '{}\n')).rejects.toBeTruthy();

    const okPath = join(tempDir, 'ok.json');
    await writer.writeFile(okPath, '{"ok":true}\n');
    await expect(readFile(okPath, 'utf-8')).resolves.toBe('{"ok":true}\n');
  });

  it('recovers app config when critical root fields have invalid types', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'tx5dr-app-config-recovery-'));
    tempDirs.push(tempDir);
    const filePath = join(tempDir, 'config.json');
    await writeFile(filePath, '{"operators":{},"server":{"port":3000}}\n', 'utf-8');
    await writeFile(`${filePath}.bak.1`, '{"operators":[],"server":{"port":4000},"customFrequencyPresets":null}\n', 'utf-8');

    const store = new JsonFileStore<Record<string, unknown>>(filePath, {
      defaultValue: () => ({ operators: [{ id: 'must-not-overwrite' }] }),
      validate: validateAppConfigCandidate,
      backups: 3,
    });

    await expect(store.load()).resolves.toMatchObject({
      operators: [],
      server: { port: 4000 },
      customFrequencyPresets: null,
    });
    await expect(readFile(filePath, 'utf-8')).resolves.toContain('"port":4000');
  });

  it('throws on unrecoverable app config schema errors without writing defaults', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'tx5dr-app-config-recovery-'));
    tempDirs.push(tempDir);
    const filePath = join(tempDir, 'config.json');
    const invalid = '{"profiles":{},"activeProfileId":42}\n';
    await writeFile(filePath, invalid, 'utf-8');

    const store = new JsonFileStore<Record<string, unknown>>(filePath, {
      defaultValue: () => ({ profiles: [{ id: 'must-not-overwrite' }] }),
      validate: validateAppConfigCandidate,
      backups: 3,
    });

    await expect(store.load()).rejects.toBeInstanceOf(JsonRecoveryError);
    await expect(readFile(filePath, 'utf-8')).resolves.toBe(invalid);
  });

  it('accepts migration-friendly app configs with missing optional fields', () => {
    expect(validateAppConfigCandidate({
      ft8: { frequency: 14074000 },
      server: { port: 4000, host: '127.0.0.1' },
      operators: [],
    })).toMatchObject({
      ft8: { frequency: 14074000 },
      server: { port: 4000 },
    });
  });
});
