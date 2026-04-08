import type { PluginLogEntry } from '@tx5dr/contracts';

export const PLUGIN_LOG_BUFFER_LIMIT = 200;

export interface PluginLogFilters {
  pluginName: string;
  level: 'all' | PluginLogEntry['level'];
}

export function appendPluginLogEntry(
  entries: PluginLogEntry[],
  entry: PluginLogEntry,
  limit = PLUGIN_LOG_BUFFER_LIMIT,
): PluginLogEntry[] {
  return [entry, ...entries].slice(0, limit);
}

export function filterPluginLogEntries(
  entries: PluginLogEntry[],
  filters: PluginLogFilters,
): PluginLogEntry[] {
  return entries.filter((entry) => {
    if (filters.pluginName !== 'all' && entry.pluginName !== filters.pluginName) {
      return false;
    }
    if (filters.level !== 'all' && entry.level !== filters.level) {
      return false;
    }
    return true;
  });
}
