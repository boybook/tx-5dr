import * as React from 'react';
import type { PluginPanelMetaPayload } from '@tx5dr/contracts';
import { useConnection } from '../store/radioStore';
import { useWSEvent } from './useWSEvent';

export interface PanelMeta {
  title?: string | null;
  titleValues?: Record<string, unknown>;
  visible?: boolean;
  tone?: 'default' | 'primary' | 'secondary' | 'success' | 'warning' | 'danger';
}

function getPanelMetaKey(payload: Pick<PluginPanelMetaPayload, 'pluginName' | 'operatorId' | 'panelId'>): string {
  return `${payload.pluginName}:${payload.operatorId}:${payload.panelId}`;
}

interface PanelMetaLayers {
  globalMetaMap: Record<string, PanelMeta>;
  scopedMetaMap: Record<string, PanelMeta>;
}

export function buildPanelMetaLayers(entries: PluginPanelMetaPayload[]): PanelMetaLayers {
  return entries.reduce<PanelMetaLayers>((layers, entry) => {
    const key = getPanelMetaKey(entry);
    if (entry.viewerTokenId) {
      layers.scopedMetaMap[key] = {
        ...layers.scopedMetaMap[key],
        ...entry.meta,
      };
    } else {
      layers.globalMetaMap[key] = {
        ...layers.globalMetaMap[key],
        ...entry.meta,
      };
    }
    return layers;
  }, {
    globalMetaMap: {},
    scopedMetaMap: {},
  });
}

export function usePluginPanelMeta(initialEntries: PluginPanelMetaPayload[] = []) {
  const connection = useConnection();
  const [globalMetaMap, setGlobalMetaMap] = React.useState<Record<string, PanelMeta>>(
    () => buildPanelMetaLayers(initialEntries).globalMetaMap,
  );
  const [scopedMetaMap, setScopedMetaMap] = React.useState<Record<string, PanelMeta>>(
    () => buildPanelMetaLayers(initialEntries).scopedMetaMap,
  );

  React.useEffect(() => {
    const layers = buildPanelMetaLayers(initialEntries);
    setGlobalMetaMap(layers.globalMetaMap);
    setScopedMetaMap(layers.scopedMetaMap);
  }, [initialEntries]);

  useWSEvent(
    connection.state.radioService,
    'pluginPanelMeta',
    (payload: PluginPanelMetaPayload) => {
      const key = getPanelMetaKey(payload);
      if (payload.viewerTokenId) {
        setScopedMetaMap((prev) => ({
          ...prev,
          [key]: { ...prev[key], ...payload.meta },
        }));
        return;
      }
      setGlobalMetaMap((prev) => ({
        ...prev,
        [key]: { ...prev[key], ...payload.meta },
      }));
    },
  );

  const getMeta = React.useCallback(
    (pluginName: string, operatorId: string, panelId: string): PanelMeta => {
      const key = `${pluginName}:${operatorId}:${panelId}`;
      return {
        ...(globalMetaMap[key] ?? {}),
        ...(scopedMetaMap[key] ?? {}),
      };
    },
    [globalMetaMap, scopedMetaMap],
  );

  return getMeta;
}
