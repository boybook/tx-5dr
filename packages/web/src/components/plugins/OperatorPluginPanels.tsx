import React from 'react';
import { PluginPanelRenderer } from './PluginPanelRenderer';
import { usePluginSnapshot } from '../../hooks/usePluginSnapshot';
import { resolvePluginLabel, resolvePluginName } from '../../utils/pluginLocales';
import type { PluginPanelDescriptor } from '@tx5dr/contracts';

interface OperatorPluginPanelsProps {
  operatorId: string;
}

export function getOperatorPanelContainerClass(panel: PluginPanelDescriptor): string {
  return panel.width === 'full' ? 'md:col-span-2' : '';
}

export const OperatorPluginPanels: React.FC<OperatorPluginPanelsProps> = ({ operatorId }) => {
  const pluginSnapshot = usePluginSnapshot();

  const activePluginsWithPanels = React.useMemo(
    () => pluginSnapshot.plugins.filter((plugin) => {
      // Only include panels destined for the operator card (no slot or slot === 'operator')
      const operatorPanels = (plugin.panels ?? []).filter(
        (panel) => !panel.slot || panel.slot === 'operator',
      );
      if (operatorPanels.length === 0) {
        return false;
      }
      if (plugin.type === 'strategy') {
        return plugin.assignedOperatorIds?.includes(operatorId) ?? false;
      }
      return plugin.enabled;
    }),
    [operatorId, pluginSnapshot.plugins],
  );

  if (activePluginsWithPanels.length === 0) {
    return null;
  }

  return (
    <div className="space-y-3">
      {activePluginsWithPanels.map((plugin) => {
        const operatorPanels = (plugin.panels ?? []).filter(
          (panel) => !panel.slot || panel.slot === 'operator',
        );
        return (
          <section key={plugin.name} className="space-y-2">
            <div className="text-xs font-medium text-default-600">
              {resolvePluginName(plugin.name, plugin.name)}
            </div>
            <div className="grid gap-2 md:grid-cols-2">
              {operatorPanels.map((panel) => (
                <div
                  key={`${plugin.name}:${panel.id}`}
                  className={getOperatorPanelContainerClass(panel)}
                >
                  <PluginPanelRenderer
                    pluginName={plugin.name}
                    operatorId={operatorId}
                    panelId={panel.id}
                    title={resolvePluginLabel(panel.title, plugin.name)}
                    component={panel.component}
                    pageId={panel.pageId}
                  />
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
};
