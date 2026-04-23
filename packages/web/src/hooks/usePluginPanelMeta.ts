import * as React from 'react';
import type { PluginPanelMetaPayload } from '@tx5dr/contracts';
import { useConnection } from '../store/radioStore';
import { useWSEvent } from './useWSEvent';

export interface PanelMeta {
  title?: string | null;
  titleValues?: Record<string, unknown>;
  visible?: boolean;
}

export function usePluginPanelMeta() {
  const connection = useConnection();
  const [metaMap, setMetaMap] = React.useState<Record<string, PanelMeta>>({});

  useWSEvent(
    connection.state.radioService,
    'pluginPanelMeta',
    (payload: PluginPanelMetaPayload) => {
      const key = `${payload.pluginName}:${payload.operatorId}:${payload.panelId}`;
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
