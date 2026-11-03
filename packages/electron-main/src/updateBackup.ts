import fs from 'node:fs/promises';
import path from 'node:path';

// Chromium owns these entries under sessionData and can keep them locked until
// Electron exits. They are not station data; never filter these names elsewhere.
const CHROMIUM_SESSION_ENTRIES = new Set([
  'Network', 'Cookies', 'Cookies-journal', 'Cache', 'Code Cache', 'GPUCache',
  'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'ShaderCache', 'GrShaderCache',
  'blob_storage', 'Local Storage', 'Session Storage', 'IndexedDB', 'WebStorage',
  'Service Worker', 'File System', 'shared_proto_db', 'SharedStorage',
  'SharedStorage-wal', 'SharedStorage-shm', 'Storage', 'Partitions',
  'Local State', 'Preferences', 'Secure Preferences', 'TransportSecurity',
  'Trust Tokens', 'Trust Tokens-journal', 'Reporting and NEL',
  'Reporting and NEL-journal', 'QuotaManager', 'QuotaManager-journal',
  'SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile',
]);

/** Called only after the embedded server has drained writes and exited. */
export async function createUpdateBackup(
  roots: string[], destination: string, source: unknown,
  options: { sessionDataDir?: string } = {},
): Promise<string> {
  const uniqueRoots = [...new Set(roots.map(root => path.resolve(root)))];
  // Resolve actual filesystem casing: Electron's app name and station directory
  // can differ in case on Windows and on case-insensitive macOS volumes.
  let sessionDataDir: string | undefined;
  if (options.sessionDataDir) {
    try { sessionDataDir = await fs.realpath(options.sessionDataDir); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const backup = path.join(destination, `before-update-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  if (uniqueRoots.some(root => backup === root || backup.startsWith(`${root}${path.sep}`))) throw new Error('backup_must_be_outside_data');
  const staging = `${backup}.partial`;
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  // Only clean up staging created by this attempt, never an older partial backup.
  await fs.mkdir(staging, { mode: 0o700 });
  const entries: Array<{ source: string; directory: string }> = [];
  const excludedPaths: string[] = [];
  try {
    for (const [index, root] of uniqueRoots.entries()) {
      try { await fs.access(root); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      const canonicalRoot = await fs.realpath(root);
      const directory = `data-${index}`;
      await fs.cp(root, path.join(staging, directory), {
        recursive: true, dereference: false, errorOnExist: true, force: false,
        filter: file => {
          const canonicalFile = path.join(canonicalRoot, path.relative(root, file));
          if (sessionDataDir && path.dirname(canonicalFile) === sessionDataDir
              && CHROMIUM_SESSION_ENTRIES.has(path.basename(canonicalFile))) {
            excludedPaths.push(file);
            return false;
          }
          return true;
        },
      });
      entries.push({ source: root, directory });
    }
    await fs.writeFile(path.join(staging, 'backup.json'), JSON.stringify({ schemaVersion: 1, source, createdAt: new Date().toISOString(), entries, excludedPaths }, null, 2), { mode: 0o600 });
    await fs.writeFile(path.join(staging, 'RESTORE.txt'), 'Stop TX-5DR before restoring. Reinstall the source application version. Copy the backed-up contents of each directory listed in backup.json over its original path; do not delete the destination directory first. Chromium session storage and caches listed in excludedPaths are not included. Restoring replaces backed-up files with this snapshot; preserve newer data separately first. Third-party plugin compatibility is not guaranteed.\n');
    await fs.rename(staging, backup);
    return backup;
  } catch (error) {
    // Do not publish a partial snapshot or hide the original station-data error.
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
