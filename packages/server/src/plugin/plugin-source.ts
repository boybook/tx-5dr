import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { PluginSource } from '@tx5dr/contracts';
import { PluginSourceSchema } from '@tx5dr/contracts';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('PluginSource');

export const PLUGIN_SOURCE_FILE_NAME = '.tx5dr-source.json';

const PluginSourceFileSchema = z.object({
  schemaVersion: z.literal(1),
  source: PluginSourceSchema,
});

export function getPluginSourceFilePath(pluginDir: string): string {
  return path.join(pluginDir, PLUGIN_SOURCE_FILE_NAME);
}

export async function readPluginSource(pluginDir: string): Promise<PluginSource | undefined> {
  const filePath = getPluginSourceFilePath(pluginDir);

  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = PluginSourceFileSchema.parse(JSON.parse(raw));
    return parsed.source;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return undefined;
    }
    logger.warn(`Failed to read plugin source metadata: ${pluginDir}`, error);
    return undefined;
  }
}

export async function writePluginSource(pluginDir: string, source: PluginSource): Promise<void> {
  const filePath = getPluginSourceFilePath(pluginDir);
  const payload = PluginSourceFileSchema.parse({
    schemaVersion: 1,
    source,
  });

  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}
