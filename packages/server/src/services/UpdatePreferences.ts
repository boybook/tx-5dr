import { stat, chown } from 'node:fs/promises';
import path from 'node:path';
import { UpdatePreferencesSchema, type SystemUpdateChannel } from '@tx5dr/contracts';
import { SERVER_BUILD_INFO } from '../generated/buildInfo.js';
import { tx5drPaths } from '../utils/app-paths.js';
import { SafeFileWriter, loadJsonWithRecovery } from '../utils/persistence/index.js';

import { resolveRuntimeDistribution } from '../utils/runtime-distribution.js';

export async function canEditUpdateChannel(): Promise<boolean> {
  const distribution = resolveRuntimeDistribution(await tx5drPaths.getDataDir());
  return distribution !== 'electron' && distribution !== 'android-bridge';
}

const writer = new SafeFileWriter({ mode: 0o600, backups: 3 });

export async function getUpdatePreferences(): Promise<{ channel: SystemUpdateChannel }> {
  const file = path.join(await tx5drPaths.getConfigDir(), 'update-preferences.json');
  return (await loadJsonWithRecovery(file, {
    validate: value => UpdatePreferencesSchema.parse(value),
    defaultValue: () => ({ channel: SERVER_BUILD_INFO.channel }),
    createIfMissing: false, writer,
  })).value;
}

export async function setUpdatePreferences(input: unknown): Promise<{ channel: SystemUpdateChannel }> {
  const preferences = UpdatePreferencesSchema.parse(input);
  const directory = await tx5drPaths.getConfigDir();
  const file = path.join(directory, 'update-preferences.json');
  await writer.writeFile(file, `${JSON.stringify(preferences)}\n`);
  if (process.getuid?.() === 0) {
    const owner = await stat(directory);
    for (const candidate of [file, ...[1, 2, 3].map(index => `${file}.bak.${index}`)]) {
      try { await chown(candidate, owner.uid, owner.gid); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  return preferences;
}
