import fs from 'node:fs/promises';
import path from 'node:path';

/** Called only after the embedded server has drained writes and exited. */
export async function createUpdateBackup(roots: string[], destination: string, source: unknown): Promise<string> {
  const uniqueRoots = [...new Set(roots.map(root => path.resolve(root)))];
  const backup = path.join(destination, `before-update-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  if (uniqueRoots.some(root => backup === root || backup.startsWith(`${root}${path.sep}`))) throw new Error('backup_must_be_outside_data');
  const staging = `${backup}.partial`;
  await fs.mkdir(staging, { recursive: true, mode: 0o700 });
  const entries: Array<{ source: string; directory: string }> = [];
  for (const [index, root] of uniqueRoots.entries()) {
    try { await fs.access(root); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    const directory = `data-${index}`;
    await fs.cp(root, path.join(staging, directory), { recursive: true, dereference: false, errorOnExist: true, force: false });
    entries.push({ source: root, directory });
  }
  await fs.writeFile(path.join(staging, 'backup.json'), JSON.stringify({ schemaVersion: 1, source, createdAt: new Date().toISOString(), entries }, null, 2), { mode: 0o600 });
  await fs.writeFile(path.join(staging, 'RESTORE.txt'), 'Stop TX-5DR before restoring. Reinstall the source application version. Restore each directory listed in backup.json to its original path. Restoring replaces data with this snapshot; preserve newer data separately first. Third-party plugin compatibility is not guaranteed.\n');
  await fs.rename(staging, backup);
  return backup;
}
