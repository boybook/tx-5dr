import * as React from 'react';
import type { PluginPanelMetaPayload } from '@tx5dr/contracts';
import { useConnection } from '../store/radioStore';
import { useWSEvent } from './useWSEvent';

export interface PanelMeta {
  title?: string | null;
  titleValues?: Record<string, unknown>;
  visible?: boolean;
}

function getPanelMetaKey(payload: Pick<PluginPanelMetaPayload, 'pluginName' | 'operatorId' | 'panelId'>): string {
  return `${payload.pluginName}:${payload.operatorId}:${payload.panelId}`;
}

function buildMetaMap(entries: PluginPanelMetaPayload[]): Record<string, PanelMeta> {
  return Object.fromEntries(entries.map((entry) => [
    getPanelMetaKey(entry),
    { ...entry.meta },
  ]));
}

export function usePluginPanelMeta(initialEntries: PluginPanelMetaPayload[] = []) {
  const connection = useConnection();
  const [metaMap, setMetaMap] = React.useState<Record<string, PanelMeta>>(() => buildMetaMap(initialEntries));

  React.useEffect(() => {
    setMetaMap(buildMetaMap(initialEntries));
  }, [initialEntries]);

  useWSEvent(
    connection.state.radioService,
    'pluginPanelMeta',
    (payload: PluginPanelMetaPayload) => {
      const key = getPanelMetaKey(payload);
      setMetaMap((prev) => ({
        ...prev,
        [key]: { ...prev[key], ...payload.meta },
      }));
    },
  );

  const getMeta = React.useCallback(
    (pluginName: string, operatorId: string, panelId: string): PanelMeta => {
      return metaMap[`${pluginName}:${operatorId}:${panelId}`] ?? {};
    },
    [metaMap],
  );

  return getMeta;
}
