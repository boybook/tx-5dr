import type { PluginRuntimeLogEntry } from '@tx5dr/contracts';

export const PLUGIN_LOG_BUFFER_LIMIT = 500;

export type PluginLogSource = 'plugin' | 'system';

export interface PluginLogViewEntry {
  source: PluginLogSource;
  pluginName?: string;
  directoryName?: string;
  stage?: PluginRuntimeLogEntry['stage'];
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  details?: unknown;
  timestamp: number;
}

export function appendPluginLogEntry(
  entries: PluginLogViewEntry[],
  entry: PluginLogViewEntry,
  limit = PLUGIN_LOG_BUFFER_LIMIT,
): PluginLogViewEntry[] {
  return [...entries, entry].slice(-limit);
}
