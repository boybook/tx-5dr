import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Select, SelectItem } from '@heroui/react';
import type { PluginLogEntry } from '@tx5dr/contracts';
import { useConnection } from '../../store/radioStore';
import { useWSEvent } from '../../hooks/useWSEvent';
import { resolvePluginName } from '../../utils/pluginLocales';
import {
  appendPluginLogEntry,
  filterPluginLogEntries,
  type PluginLogFilters,
} from '../../utils/pluginLogBuffer';

interface PluginLogPanelProps {
  pluginNames: string[];
}

const LEVELS: Array<PluginLogEntry['level']> = ['debug', 'info', 'warn', 'error'];

export const PluginLogPanel: React.FC<PluginLogPanelProps> = ({ pluginNames }) => {
  const { t } = useTranslation('settings');
  const connection = useConnection();
  const [entries, setEntries] = React.useState<PluginLogEntry[]>([]);
  const [filters, setFilters] = React.useState<PluginLogFilters>({
    pluginName: 'all',
    level: 'all',
  });

  useWSEvent(connection.state.radioService, 'pluginLog' as any, (entry: PluginLogEntry) => {
    setEntries((prev) => appendPluginLogEntry(prev, entry));
  });

  const filteredEntries = React.useMemo(
    () => filterPluginLogEntries(entries, filters),
    [entries, filters],
  );

  const pluginOptions = React.useMemo(
    () => Array.from(new Set([...pluginNames, ...entries.map((entry) => entry.pluginName)])).sort(),
    [entries, pluginNames],
  );

  return (
    <section className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-default-700">
            {t('plugins.logsTitle', 'Plugin Logs')}
          </h3>
          <p className="mt-1 text-sm text-default-400">
            {t('plugins.logsDescription', 'Live session logs emitted by plugin code.')}
          </p>
        </div>
        <Button
          size="sm"
          variant="flat"
          onPress={() => setEntries([])}
        >
          {t('plugins.clearLogs', 'Clear')}
        </Button>
      </div>

      <div className="space-y-3">
        <div className="grid gap-3 md:grid-cols-2">
          <Select
            size="sm"
            label={t('plugins.filterPlugin', 'Plugin')}
            selectedKeys={[filters.pluginName]}
            onSelectionChange={(keys) => {
              const next = Array.from(keys as Set<string>)[0];
              if (next) {
                setFilters((prev) => ({ ...prev, pluginName: next }));
              }
            }}
            variant="bordered"
          >
            <SelectItem key="all">
              {t('plugins.allPlugins', 'All plugins')}
            </SelectItem>
            {pluginOptions.map((pluginName) => (
              <SelectItem key={pluginName}>
                {resolvePluginName(pluginName, pluginName)}
              </SelectItem>
            ))}
          </Select>

          <Select
            size="sm"
            label={t('plugins.filterLevel', 'Level')}
            selectedKeys={[filters.level]}
            onSelectionChange={(keys) => {
              const next = Array.from(keys as Set<string>)[0] as PluginLogFilters['level'] | undefined;
              if (next) {
                setFilters((prev) => ({ ...prev, level: next }));
              }
            }}
            variant="bordered"
          >
            <SelectItem key="all">
              {t('plugins.allLevels', 'All levels')}
            </SelectItem>
            {LEVELS.map((level) => (
              <SelectItem key={level}>
                {t(`plugins.level.${level}`, level)}
              </SelectItem>
            ))}
          </Select>
        </div>

        <div className="max-h-96 overflow-y-auto rounded-xl border border-default-200/70 bg-default-50/40">
          {filteredEntries.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-default-400">
              {t('plugins.logsEmpty', 'No plugin logs in this session yet.')}
            </div>
          ) : (
            <div className="divide-y divide-default-200/70">
              {filteredEntries.map((entry, index) => (
                <div key={`${entry.timestamp}:${entry.pluginName}:${index}`} className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-mono text-default-400">
                      {new Date(entry.timestamp).toLocaleTimeString()}
                    </span>
                    <span className="rounded-full bg-default-200 px-2 py-0.5 font-semibold uppercase tracking-wide text-default-700">
                      {entry.level}
                    </span>
                    <span className="font-medium text-default-600">
                      {resolvePluginName(entry.pluginName, entry.pluginName)}
                    </span>
                  </div>
                  <div className="mt-2 text-sm text-default-800">
                    {entry.message}
                  </div>
                  {entry.data !== undefined && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs text-default-500">
                        {t('plugins.viewLogDetails', 'View details')}
                      </summary>
                      <pre className="mt-2 overflow-x-auto rounded-lg bg-content1 p-3 text-xs text-default-600">
                        {JSON.stringify(entry.data, null, 2)}
                      </pre>
                    </details>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
};
