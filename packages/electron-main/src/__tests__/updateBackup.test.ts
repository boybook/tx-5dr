import { afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createUpdateBackup } from '../updateBackup.js';
describe('update backup', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  it('keeps a separate complete snapshot without modifying current data', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tx5dr-backup-'));
    try {
      const data = path.join(root, 'data'); await fs.mkdir(data);
      await fs.writeFile(path.join(data, 'logbook.adi'), 'original QSO');
      const backup = await createUpdateBackup([data, data], path.join(root, 'backups'), { version: '1.0.0' });
      await fs.writeFile(path.join(data, 'logbook.adi'), 'new QSO');
      expect(await fs.readFile(path.join(backup, 'data-0/logbook.adi'), 'utf8')).toBe('original QSO');
      const manifest = JSON.parse(await fs.readFile(path.join(backup, 'backup.json'), 'utf8'));
      expect(manifest.entries).toHaveLength(1);
      expect(manifest.entries[0].source).toBe(data);
      await expect(createUpdateBackup([data], path.join(data, 'backups'), {})).rejects.toThrow('outside_data');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('excludes Chromium only at the session root and preserves station and plugin data', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tx5dr-backup-'));
    try {
      const config = path.join(root, 'Roaming', 'TX-5DR');
      const data = path.join(root, 'Local', 'TX-5DR');
      const files = [
        [config, 'config.json'], [config, 'auth.json'], [config, '.admin-token'],
        [config, 'electron-settings.json'], [config, 'certs/custom.pem'],
        [config, 'Network/Cookies'], [config, 'Cache/cache-entry'],
        [config, 'Local Storage/leveldb/LOCK'],
        [data, 'logbook/station.adi'], [data, 'plugins/example/main.js'],
        [data, 'plugin-data/example/Network/Cookies'], [data, 'Network/user-data'],
        [data, 'image-radio/user.png'], [data, 'voice-keyer/recording.wav'],
      ];
      for (const [base, file] of files) {
        await fs.mkdir(path.dirname(path.join(base, file)), { recursive: true });
        await fs.writeFile(path.join(base, file), file);
      }
      const backup = await createUpdateBackup([config, data], path.join(root, 'backups'), {}, { sessionDataDir: config });
      for (const [base, file] of files) {
        const target = path.join(backup, base === config ? 'data-0' : 'data-1', file);
        if (base === config && /^(Network|Cache|Local Storage)\//.test(file)) {
          await expect(fs.access(target)).rejects.toMatchObject({ code: 'ENOENT' });
        } else {
          expect(await fs.readFile(target, 'utf8')).toBe(file);
        }
        expect(await fs.readFile(path.join(base, file), 'utf8')).toBe(file);
      }
      const manifest = JSON.parse(await fs.readFile(path.join(backup, 'backup.json'), 'utf8'));
      expect(manifest.excludedPaths).toEqual(expect.arrayContaining([
        path.join(config, 'Network'), path.join(config, 'Local Storage'), path.join(config, 'Cache'),
      ]));
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('handles a shared config/data root and resolves the session directory alias', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tx5dr-backup-'));
    try {
      const data = path.join(root, 'TX-5DR');
      await fs.mkdir(path.join(data, 'Network'), { recursive: true });
      await fs.writeFile(path.join(data, 'Network/Cookies'), 'browser');
      await fs.writeFile(path.join(data, 'config.json'), 'station');
      const alias = path.join(root, 'session-alias');
      await fs.symlink(data, alias, 'junction');
      const backup = await createUpdateBackup([data, data], path.join(root, 'backups'), {}, { sessionDataDir: alias });
      await expect(fs.access(path.join(backup, 'data-0/Network'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fs.readFile(path.join(backup, 'data-0/config.json'), 'utf8')).toBe('station');
      const manifest = JSON.parse(await fs.readFile(path.join(backup, 'backup.json'), 'utf8'));
      expect(manifest.entries).toHaveLength(1);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it.each(['EBUSY', 'ENOSPC'])('fails on station-data %s and removes only its partial snapshot', async code => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tx5dr-backup-'));
    try {
      const data = path.join(root, 'data');
      const backups = path.join(root, 'backups');
      await fs.mkdir(data);
      await fs.mkdir(path.join(backups, 'previous'), { recursive: true });
      await fs.writeFile(path.join(data, 'config.json'), 'station');
      const error = Object.assign(new Error('copy failed'), { code });
      vi.spyOn(fs, 'cp').mockRejectedValueOnce(error);
      await expect(createUpdateBackup([data], backups, {}, { sessionDataDir: data })).rejects.toBe(error);
      expect(await fs.readdir(backups)).toEqual(['previous']);
      expect(await fs.readFile(path.join(data, 'config.json'), 'utf8')).toBe('station');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
