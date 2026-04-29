import * as React from 'react';
import type { PluginStatus, PluginSystemSnapshot } from '@tx5dr/contracts';
import { api } from '@tx5dr/core';
import { useConnection } from '../store/radioStore';
import { useWSEvent } from './useWSEvent';
import { registerPluginLocales } from '../utils/pluginLocales';
import { createLogger } from '../utils/logger';

const logger = createLogger('usePluginSnapshot');

const EMPTY_SNAPSHOT: PluginSystemSnapshot = {
  state: 'ready',
  generation: 0,
  plugins: [],
  panelMeta: [],
  panelContributions: [],
};

export function usePluginSnapshot(): PluginSystemSnapshot {
  const connection = useConnection();
  const [snapshot, setSnapshot] = React.useState<PluginSystemSnapshot>(EMPTY_SNAPSHOT);

  React.useEffect(() => {
    api.getPlugins()
      .then((nextSnapshot) => {
        nextSnapshot.plugins.forEach((plugin) => registerPluginLocales(plugin.name, plugin.locales));
        setSnapshot(nextSnapshot);
      })
      .catch((err: unknown) => logger.error('Failed to load plugin snapshot', err));
  }, []);

  useWSEvent(connection.state.radioService, 'pluginList', (data: PluginSystemSnapshot) => {
    data.plugins.forEach((plugin) => registerPluginLocales(plugin.name, plugin.locales));
    setSnapshot((prev) => data.generation >= prev.generation ? data : prev);
  });

  useWSEvent(
    connection.state.radioService,
    'pluginStatusChanged',
    (data: { generation: number; plugin: PluginStatus }) => {
      registerPluginLocales(data.plugin.name, data.plugin.locales);
      setSnapshot((prev) => {
        if (data.generation < prev.generation) {
          return prev;
        }
        const nextPlugins = prev.plugins.some((plugin) => plugin.name === data.plugin.name)
          ? prev.plugins.map((plugin) => plugin.name === data.plugin.name ? data.plugin : plugin)
          : [...prev.plugins, data.plugin];
        return {
          ...prev,
          generation: data.generation,
          plugins: nextPlugins,
        };
      });
    },
  );

  useWSEvent(
    connection.state.radioService,
    'pluginPanelContributionsChanged',
    (group: NonNullable<PluginSystemSnapshot['panelContributions']>[number]) => {
      setSnapshot((prev) => {
        const existing = prev.panelContributions ?? [];
        const nextGroups = existing.filter((entry) => {
          const sameTarget = JSON.stringify(entry.instanceTarget ?? null) === JSON.stringify(group.instanceTarget ?? null);
          return !(entry.pluginName === group.pluginName && entry.groupId === group.groupId && sameTarget);
        });
        if (group.panels.length > 0) {
          nextGroups.push(group);
        }
        return {
          ...prev,
          panelContributions: nextGroups,
        };
      });
    },
  );

  return snapshot;
}
