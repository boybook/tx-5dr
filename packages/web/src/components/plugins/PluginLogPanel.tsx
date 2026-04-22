import React from 'react';
import { useTranslation } from 'react-i18next';
import type {
  PluginLogEntry,
  PluginRuntimeLogEntry,
  PluginRuntimeLogHistoryPayload,
} from '@tx5dr/contracts';
import { useConnection } from '../../store/radioStore';
import { useWSEvent } from '../../hooks/useWSEvent';
import {
  appendPluginLogEntry,
  PLUGIN_LOG_BUFFER_LIMIT,
  type PluginLogViewEntry,
} from '../../utils/pluginLogBuffer';

export function toPluginLogViewEntry(entry: PluginLogEntry): PluginLogViewEntry {
  return {
    source: 'plugin',
    pluginName: entry.pluginName,
    level: entry.level,
    message: entry.message,
    details: entry.data,
    timestamp: entry.timestamp,
  };
}

export function toPluginRuntimeLogViewEntry(entry: PluginRuntimeLogEntry): PluginLogViewEntry {
  return {
    source: 'system',
    pluginName: entry.pluginName,
    directoryName: entry.directoryName,
    stage: entry.stage,
    level: entry.level,
    message: entry.message,
    details: entry.details,
    timestamp: entry.timestamp,
  };
}

function stringifyPluginLogDetails(details: unknown): string {
  try {
    return JSON.stringify(details);
  } catch {
    return '[unserializable details]';
  }
}

function getStringDetail(details: unknown, key: string): string | null {
  if (!details || typeof details !== 'object') {
    return null;
  }
  const value = (details as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function resolveTargetLabel(entry: PluginLogViewEntry): string {
  if (entry.pluginName) {
    return entry.pluginName;
  }
  if (entry.directoryName) {
    return `dir:${entry.directoryName}`;
  }
  const pluginDir = getStringDetail(entry.details, 'pluginDir');
  if (pluginDir) {
    return `dir:${pluginDir}`;
  }
  const dirPath = getStringDetail(entry.details, 'dirPath');
  if (dirPath) {
    return `dir:${dirPath}`;
  }
  return entry.source === 'system' ? 'system' : 'plugin';
}

export function formatPluginLogLine(entry: PluginLogViewEntry): string {
  const sourceLabel = entry.source === 'system' ? 'System' : 'Plugin';
  const stageSuffix = entry.stage ? `/${entry.stage}` : '';
  const targetLabel = resolveTargetLabel(entry);
  const detailsSuffix = entry.details === undefined
    ? ''
    : ` details=${stringifyPluginLogDetails(entry.details)}`;

  return `[${new Date(entry.timestamp).toLocaleTimeString()}] [${entry.level}] [${sourceLabel}${stageSuffix}] [${targetLabel}] ${entry.message}${detailsSuffix}`;
}

function getLevelClass(level: PluginLogViewEntry['level']): string {
  switch (level) {
    case 'debug':
      return 'text-default-500';
    case 'info':
      return 'text-sky-600';
    case 'warn':
      return 'text-warning-600';
    case 'error':
      return 'text-danger-700';
    default:
      return 'text-default-600';
  }
}

function getLineClass(level: PluginLogViewEntry['level']): string {
  if (level === 'error') {
    return 'rounded-md border border-danger-200 bg-danger-50/80';
  }
  return '';
}

function getPluginLogEntryIdentity(entry: PluginLogViewEntry): string {
  return [
    entry.timestamp,
    entry.source,
    entry.stage ?? '',
    entry.level,
    entry.pluginName ?? '',
    entry.directoryName ?? '',
    entry.message,
    entry.details === undefined ? '' : stringifyPluginLogDetails(entry.details),
  ].join('|');
}

export function mergePluginLogEntries(
  existingEntries: PluginLogViewEntry[],
  incomingEntries: PluginLogViewEntry[],
  limit = PLUGIN_LOG_BUFFER_LIMIT,
): PluginLogViewEntry[] {
  const deduped: PluginLogViewEntry[] = [];
  const seen = new Set<string>();
  const sorted = [...existingEntries, ...incomingEntries]
    .sort((a, b) => a.timestamp - b.timestamp);
  for (const entry of sorted) {
    const identity = getPluginLogEntryIdentity(entry);
    if (!seen.has(identity)) {
      seen.add(identity);
      deduped.push(entry);
    }
  }
  return deduped.slice(-limit);
}

export const PluginLogPanel: React.FC = () => {
  const { t } = useTranslation('settings');
  const connection = useConnection();
  const [entries, setEntries] = React.useState<PluginLogViewEntry[]>([]);
  const logContainerRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (connection.state.isConnected) {
      connection.state.radioService?.getPluginRuntimeLogHistory(PLUGIN_LOG_BUFFER_LIMIT);
    }
  }, [connection.state.isConnected, connection.state.radioService]);

  useWSEvent(connection.state.radioService, 'pluginLog', (entry: PluginLogEntry) => {
    setEntries((prev) => appendPluginLogEntry(prev, toPluginLogViewEntry(entry)));
  });

  useWSEvent(connection.state.radioService, 'pluginRuntimeLog', (entry: PluginRuntimeLogEntry) => {
    setEntries((prev) => appendPluginLogEntry(prev, toPluginRuntimeLogViewEntry(entry)));
  });

  useWSEvent(connection.state.radioService, 'pluginRuntimeLogHistory', (payload: PluginRuntimeLogHistoryPayload) => {
    const normalizedEntries = payload.entries.map((entry) => toPluginRuntimeLogViewEntry(entry));
    setEntries((prev) => mergePluginLogEntries(prev, normalizedEntries));
  });

  React.useEffect(() => {
    const container = logContainerRef.current;
    if (!container) {
      return;
    }
    container.scrollTop = container.scrollHeight;
  }, [entries]);

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-base font-semibold text-default-700">
          {t('plugins.logsTitle', 'Plugin Runtime Logs')}
        </h3>
        <p className="mt-1 text-sm text-default-400">
          {t(
            'plugins.logsDescription',
            'Shows plugin loading/reload logs from the host and runtime logs emitted by plugin code.',
          )}
        </p>
      </div>

      <div
        ref={logContainerRef}
        className="max-h-96 overflow-y-auto rounded-xl border border-default-200/70 bg-default-50/40"
      >
        {entries.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-default-400">
            {t('plugins.logsEmpty', 'No plugin logs in this session yet.')}
          </div>
        ) : (
          <div className="space-y-1 px-4 py-3 font-mono text-xs leading-5">
            {entries.map((entry, index) => {
              const identity = getPluginLogEntryIdentity(entry);
              const sourceLabel = entry.source === 'system' ? 'System' : 'Plugin';
              const stageSuffix = entry.stage ? `/${entry.stage}` : '';
              const targetLabel = resolveTargetLabel(entry);
              const detailsSuffix = entry.details === undefined
                ? ''
                : ` details=${stringifyPluginLogDetails(entry.details)}`;
              const lineClass = getLineClass(entry.level);
              const levelClass = getLevelClass(entry.level);

              return (
                <div
                  key={`${identity}:${index}`}
                  className={`whitespace-pre-wrap break-all px-2 py-1 ${lineClass}`.trim()}
                >
                  <span className="text-default-500">
                    [{new Date(entry.timestamp).toLocaleTimeString()}]
                  </span>
                  {' '}
                  <span className={levelClass}>
                    [{entry.level}]
                  </span>
                  {' '}
                  <span className="text-indigo-600">
                    [{sourceLabel}{stageSuffix}]
                  </span>
                  {' '}
                  <span className="text-teal-600">
                    [{targetLabel}]
                  </span>
                  {' '}
                  <span className={entry.level === 'error' ? 'text-danger-700' : 'text-default-700'}>
                    {entry.message}
                  </span>
                  {detailsSuffix.length > 0 && (
                    <span className="text-default-500">{detailsSuffix}</span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
};
