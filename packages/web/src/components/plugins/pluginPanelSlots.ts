import * as React from 'react';
import type {
  PluginPanelDescriptor,
  PluginPanelMetaPayload,
  PluginPanelSlot,
  PluginStatus,
  PluginSystemSnapshot,
  PluginUIPanelContributionGroup,
} from '@tx5dr/contracts';
import { usePluginPanelMeta, type PanelMeta } from '../../hooks/usePluginPanelMeta';
import { usePluginSnapshot } from '../../hooks/usePluginSnapshot';
import { resolvePluginLabel, resolvePluginLabelWithValues, resolvePluginName } from '../../utils/pluginLocales';

export interface VisiblePluginPanelEntry {
  key: string;
  plugin: PluginStatus;
  panel: PluginPanelDescriptor;
  pluginName: string;
  pluginDisplayName: string;
  resolvedTitle: string;
  tabLabel: string;
  contributionGroupId: string;
  pluginGeneration: number;
  initialPanelMeta: PluginPanelMetaPayload[];
  meta: PanelMeta;
}

function pluginMatchesOperator(plugin: PluginStatus, operatorId: string): boolean {
  if (plugin.type === 'strategy') {
    return plugin.assignedOperatorIds?.includes(operatorId) ?? false;
  }
  return plugin.enabled;
}

export function panelMatchesSlot(panel: PluginPanelDescriptor, slot: PluginPanelSlot): boolean {
  if (slot === 'operator') {
    return !panel.slot || panel.slot === 'operator';
  }
  return panel.slot === slot;
}

export function getVisiblePluginPanelsForSlot(params: {
  plugins: PluginStatus[];
  panelContributions: PluginSystemSnapshot['panelContributions'];
  getMeta: (pluginName: string, operatorId: string, panelId: string) => PanelMeta;
  operatorId: string;
  slot: PluginPanelSlot;
  pluginGeneration: number;
  initialPanelMeta: PluginPanelMetaPayload[];
}): VisiblePluginPanelEntry[] {
  const { plugins, panelContributions, getMeta, operatorId, slot, pluginGeneration, initialPanelMeta } = params;
  const contributionGroups = panelContributions ?? [];

  return plugins.flatMap((plugin) => {
    if (!pluginMatchesOperator(plugin, operatorId)) {
      return [];
    }

    const pluginGroups = getContributionGroupsForPlugin(plugin, contributionGroups, operatorId);
    return pluginGroups.flatMap((group) => group.panels.flatMap((panel) => {
      if (!panelMatchesSlot(panel, slot)) {
        return [];
      }

      const meta = getMeta(plugin.name, operatorId, panel.id);
      if (meta.visible === false) {
        return [];
      }

      const staticTitle = resolvePluginLabel(panel.title, plugin.name);
      const resolvedTitle = meta.title !== undefined && meta.title !== null
        ? resolvePluginLabelWithValues(meta.title, plugin.name, meta.titleValues)
        : staticTitle;
      const pluginDisplayName = resolvePluginName(plugin.name, plugin.name);
      const tabLabel = resolvedTitle.trim().length > 0 ? resolvedTitle : pluginDisplayName;

      return [{
        key: `${plugin.name}:${panel.id}`,
        plugin,
        panel,
        pluginName: plugin.name,
        pluginDisplayName,
        resolvedTitle,
        tabLabel,
        contributionGroupId: group.groupId,
        pluginGeneration,
        initialPanelMeta,
        meta,
      }];
    }));
  });
}

function contributionGroupMatchesOperator(group: PluginUIPanelContributionGroup, operatorId: string): boolean {
  if (group.source === 'manifest') {
    return true;
  }
  if (!group.instanceTarget) {
    return true;
  }
  return group.instanceTarget.kind === 'operator'
    ? group.instanceTarget.operatorId === operatorId
    : true;
}

function getContributionGroupsForPlugin(
  plugin: PluginStatus,
  contributionGroups: PluginUIPanelContributionGroup[],
  operatorId: string,
): PluginUIPanelContributionGroup[] {
  const matchingGroups = contributionGroups.filter((group) =>
    group.pluginName === plugin.name && contributionGroupMatchesOperator(group, operatorId)
  );
  const hasManifestGroup = matchingGroups.some((group) => group.source === 'manifest' || group.groupId === 'manifest');
  if (hasManifestGroup || (plugin.panels ?? []).length === 0) {
    return matchingGroups;
  }
  return [
    {
      pluginName: plugin.name,
      groupId: 'manifest',
      source: 'manifest',
      panels: plugin.panels ?? [],
    },
    ...matchingGroups,
  ];
}

export function useVisiblePluginPanelsForSlot(
  operatorId: string | null | undefined,
  slot: PluginPanelSlot,
): VisiblePluginPanelEntry[] {
  const pluginSnapshot = usePluginSnapshot();
  const getMeta = usePluginPanelMeta(pluginSnapshot.panelMeta);

  return React.useMemo(() => {
    if (!operatorId) {
      return [];
    }

    return getVisiblePluginPanelsForSlot({
      plugins: pluginSnapshot.plugins,
      panelContributions: pluginSnapshot.panelContributions,
      getMeta,
      operatorId,
      slot,
      pluginGeneration: pluginSnapshot.generation,
      initialPanelMeta: pluginSnapshot.panelMeta,
    });
  }, [
    getMeta,
    operatorId,
    pluginSnapshot.generation,
    pluginSnapshot.panelContributions,
    pluginSnapshot.panelMeta,
    pluginSnapshot.plugins,
    slot,
  ]);
}
