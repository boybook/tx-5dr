import * as React from 'react';
import { Button } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core';
import type { PluginSystemSnapshot } from '@tx5dr/contracts';
import type { PanelMeta } from '../../../hooks/usePluginPanelMeta';
import { getVisiblePluginPanelsForSlot } from '../../plugins/pluginPanelSlots';
import { resolvePluginIcon } from '../../plugins/pluginIcons';
import { openPluginPageWindow } from '../../../utils/windowManager';

export interface OperatorPluginPageActionEntry {
  key: string;
  pluginName: string;
  panelId: string;
  pageId: string;
  title: string;
  icon?: string;
  params?: Record<string, string>;
}

interface ResolveOperatorPluginPageActionsParams {
  snapshot: PluginSystemSnapshot;
  getMeta: (pluginName: string, operatorId: string, panelId: string) => PanelMeta;
  operatorId: string;
  canAccessOperator: boolean;
  canAccessAdmin: boolean;
}

export function resolveOperatorPluginPageActions({
  snapshot,
  getMeta,
  operatorId,
  canAccessOperator,
  canAccessAdmin,
}: ResolveOperatorPluginPageActionsParams): OperatorPluginPageActionEntry[] {
  const visibleEntries = getVisiblePluginPanelsForSlot({
    plugins: snapshot.plugins,
    panelContributions: snapshot.panelContributions,
    getMeta,
    operatorId,
    slot: 'operator-action',
    pluginGeneration: snapshot.generation,
    initialPanelMeta: snapshot.panelMeta,
  });

  return visibleEntries.flatMap((entry) => {
    if (entry.panel.component !== 'iframe' || entry.panel.openMode !== 'page' || !entry.panel.pageId) {
      return [];
    }
    const page = entry.plugin.ui?.pages?.find((candidate) => candidate.id === entry.panel.pageId);
    if (!page || page.resourceBinding !== 'operator') return [];
    const canAccess = (page.accessScope ?? 'admin') === 'operator'
      ? canAccessOperator
      : canAccessAdmin;
    if (!canAccess) return [];

    return [{
      key: entry.key,
      pluginName: entry.pluginName,
      panelId: entry.panel.id,
      pageId: entry.panel.pageId,
      title: entry.resolvedTitle,
      icon: entry.panel.icon,
      params: entry.panel.params,
    }];
  });
}

interface OperatorActionButtonProps {
  icon: IconDefinition;
  label: string;
  onPress: () => void;
}

export const OperatorActionButton: React.FC<OperatorActionButtonProps> = ({ icon, label, onPress }) => (
  <Button
    size="sm"
    variant="flat"
    onPress={onPress}
    className="h-8 min-w-0 shrink-0 px-2 whitespace-nowrap"
    title={label}
    aria-label={label}
    startContent={<FontAwesomeIcon icon={icon} />}
  >
    {label}
  </Button>
);

interface OperatorPluginPageActionsProps {
  entries: OperatorPluginPageActionEntry[];
  operatorId: string;
}

export const OperatorPluginPageActions: React.FC<OperatorPluginPageActionsProps> = ({
  entries,
  operatorId,
}) => (
  <>
    {entries.map((entry) => (
      <OperatorActionButton
        key={entry.key}
        icon={resolvePluginIcon(entry.icon)}
        label={entry.title}
        onPress={() => openPluginPageWindow({
          pluginName: entry.pluginName,
          pageId: entry.pageId,
          operatorId,
          params: { panelId: entry.panelId, ...(entry.params ?? {}) },
        })}
      />
    ))}
  </>
);
