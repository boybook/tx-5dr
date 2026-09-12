import * as React from 'react';
import type { PluginStatus, PluginSystemSnapshot } from '@tx5dr/contracts';
import { api } from '@tx5dr/core';
import { useAuth } from '../store/authStore';
import { useConnection } from '../store/radio/hooks';
import { registerPluginLocales } from '../utils/pluginLocales';
import { createLogger } from '../utils/logger';

const logger = createLogger('PluginSnapshot');
const EMPTY_SNAPSHOT: PluginSystemSnapshot = {
  state: 'ready', generation: 0, plugins: [], panelMeta: [], panelContributions: [],
};
const PluginSnapshotContext = React.createContext<PluginSystemSnapshot | null>(null);
type SnapshotUpdate = (snapshot: PluginSystemSnapshot) => PluginSystemSnapshot;

/** One authenticated RadioProvider owns REST hydration and the live plugin projection. */
export function PluginSnapshotProvider({ children }: { children: React.ReactNode }) {
  const { state: connection } = useConnection();
  const { state: auth } = useAuth();
  const canLoad = !auth.authEnabled || (Boolean(auth.jwt) && (auth.role === 'admin' || auth.role === 'operator'));
  const scope = JSON.stringify([auth.authEnabled, auth.jwt, auth.role]);
  const [owned, setOwned] = React.useState({ scope, snapshot: EMPTY_SNAPSHOT });
  const setSnapshot = React.useCallback((update: React.SetStateAction<PluginSystemSnapshot>) => {
    setOwned(previous => {
      const current = previous.scope === scope ? previous.snapshot : EMPTY_SNAPSHOT;
      const snapshot = typeof update === 'function' ? update(current) : update;
      return previous.scope === scope && snapshot === current ? previous : { scope, snapshot };
    });
  }, [scope]);

  React.useEffect(() => {
    if (!canLoad) {
      setSnapshot(EMPTY_SNAPSHOT);
      return;
    }
    if (!connection.isReady || !connection.radioService) return;

    const ws = connection.radioService.wsClientInstance;
    let disposed = false;
    let hydrating = true;
    let receivedFullSnapshot = false;
    let liveGeneration = -1;
    const pending = new Map<string, SnapshotUpdate>();
    const apply = (key: string, update: SnapshotUpdate, liveUpdate = update) => {
      if (disposed) return;
      if (hydrating) {
        // Retain the latest update per logical entry, in arrival order. A slow
        // REST request must not accumulate every repeated panel/status event.
        pending.delete(key);
        pending.set(key, update);
      }
      setSnapshot(liveUpdate);
    };
    const registerLocales = (plugins: PluginStatus[]) => {
      plugins.forEach(plugin => registerPluginLocales(plugin.name, plugin.locales));
    };
    const onList = (data: PluginSystemSnapshot) => {
      if (disposed || data.generation < liveGeneration) return;
      liveGeneration = data.generation;
      registerLocales(data.plugins);
      // A reconnect may lead to a restarted Host whose generation begins again.
      const firstSnapshot = !receivedFullSnapshot;
      receivedFullSnapshot = true;
      const update: SnapshotUpdate = previous => data.generation >= previous.generation ? data : previous;
      apply('list', update, firstSnapshot ? () => data : update);
    };
    const onStatus = (data: { generation: number; plugin: PluginStatus }) => {
      if (disposed || data.generation < liveGeneration) return;
      liveGeneration = data.generation;
      registerLocales([data.plugin]);
      apply(`status:${data.plugin.name}`, previous => {
        if (data.generation < previous.generation) return previous;
        const plugins = previous.plugins.some(plugin => plugin.name === data.plugin.name)
          ? previous.plugins.map(plugin => plugin.name === data.plugin.name ? data.plugin : plugin)
          : [...previous.plugins, data.plugin];
        return { ...previous, generation: data.generation, plugins };
      });
    };
    const onContributions = (group: NonNullable<PluginSystemSnapshot['panelContributions']>[number]) => {
      apply(`panel:${JSON.stringify([group.pluginName, group.groupId, group.instanceTarget ?? null])}`, previous => {
        const groups = (previous.panelContributions ?? []).filter(entry => !(
          entry.pluginName === group.pluginName && entry.groupId === group.groupId
          && JSON.stringify(entry.instanceTarget ?? null) === JSON.stringify(group.instanceTarget ?? null)
        ));
        if (group.panels.length > 0) groups.push(group);
        return { ...previous, panelContributions: groups };
      });
    };

    ws.onWSEvent('pluginList', onList);
    ws.onWSEvent('pluginStatusChanged', onStatus);
    ws.onWSEvent('pluginPanelContributionsChanged', onContributions);
    void api.getPlugins().then(response => {
      if (disposed) return;
      // Replay events received during the request, including contributions which
      // have no generation. A late REST response must not undo those live events.
      const next = [...pending.values()].reduce((value, update) => update(value), response);
      hydrating = false;
      pending.clear();
      liveGeneration = next.generation;
      receivedFullSnapshot = true;
      registerLocales(next.plugins);
      setSnapshot(next);
    }).catch((error: unknown) => {
      if (disposed) return;
      hydrating = false;
      pending.clear();
      logger.error('Failed to load plugin snapshot', error);
    });

    return () => {
      disposed = true;
      pending.clear();
      ws.offWSEvent('pluginList', onList);
      ws.offWSEvent('pluginStatusChanged', onStatus);
      ws.offWSEvent('pluginPanelContributionsChanged', onContributions);
    };
  }, [canLoad, connection.isReady, connection.radioService, setSnapshot]);

  return React.createElement(PluginSnapshotContext.Provider, { value: canLoad && owned.scope === scope ? owned.snapshot : EMPTY_SNAPSHOT }, children);
}

export function usePluginSnapshot(): PluginSystemSnapshot {
  const snapshot = React.useContext(PluginSnapshotContext);
  if (!snapshot) throw new Error('usePluginSnapshot must be used within PluginSnapshotProvider');
  return snapshot;
}
