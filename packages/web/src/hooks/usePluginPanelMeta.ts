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
      const meta = applyPanelMetaPatch(layers.scopedMetaMap[key], entry.meta);
      if (meta) {
        layers.scopedMetaMap[key] = meta;
      } else {
        delete layers.scopedMetaMap[key];
      }
    } else {
      const meta = applyPanelMetaPatch(layers.globalMetaMap[key], entry.meta);
      if (meta) {
        layers.globalMetaMap[key] = meta;
      } else {
        delete layers.globalMetaMap[key];
      }
    }
    return layers;
  }, {
    globalMetaMap: {},
    scopedMetaMap: {},
  });
}

function applyPanelMetaPatch(current: PanelMeta | undefined, patch: PluginPanelMetaPayload['meta']): PanelMeta | undefined {
  const next: PanelMeta = { ...(current ?? {}) };
  if (patch.title === null) {
    delete next.title;
  } else if (patch.title !== undefined) {
    next.title = patch.title;
  }
  if (patch.titleValues === null) {
    delete next.titleValues;
  } else if (patch.titleValues !== undefined) {
    next.titleValues = patch.titleValues;
  }
  if (patch.visible === null) {
    delete next.visible;
  } else if (patch.visible !== undefined) {
    next.visible = patch.visible;
  }
  if (patch.tone === null) {
    delete next.tone;
  } else if (patch.tone !== undefined) {
    next.tone = patch.tone;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function applyPanelMetaPayload(
  previous: Record<string, PanelMeta>,
  payload: PluginPanelMetaPayload,
): Record<string, PanelMeta> {
  const key = getPanelMetaKey(payload);
  const meta = applyPanelMetaPatch(previous[key], payload.meta);
  const next = { ...previous };
  if (meta) {
    next[key] = meta;
  } else {
    delete next[key];
  }
  return next;
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
      if (payload.viewerTokenId) {
        setScopedMetaMap((prev) => applyPanelMetaPayload(prev, payload));
        return;
      }
      setGlobalMetaMap((prev) => applyPanelMetaPayload(prev, payload));
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
