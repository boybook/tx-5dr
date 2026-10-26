import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createUpdateBackup } from '../updateBackup.js';
describe('update backup', () => {
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
});
