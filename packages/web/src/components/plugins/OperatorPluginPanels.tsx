import React from 'react';
import { PluginPanelRenderer } from './PluginPanelRenderer';
import { usePluginSnapshot } from '../../hooks/usePluginSnapshot';
import { usePluginPanelMeta } from '../../hooks/usePluginPanelMeta';
import { resolvePluginLabel, resolvePluginLabelWithValues, resolvePluginName } from '../../utils/pluginLocales';
import type { PluginPanelDescriptor } from '@tx5dr/contracts';

interface OperatorPluginPanelsProps {
  operatorId: string;
}

export function getOperatorPanelContainerClass(panel: PluginPanelDescriptor): string {
  return panel.width === 'full' ? 'md:col-span-2' : '';
}

export const OperatorPluginPanels: React.FC<OperatorPluginPanelsProps> = ({ operatorId }) => {
  const pluginSnapshot = usePluginSnapshot();
  const getMeta = usePluginPanelMeta(pluginSnapshot.panelMeta);

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
        const visiblePanels = operatorPanels.filter((panel) => {
          const meta = getMeta(plugin.name, operatorId, panel.id);
          return meta.visible !== false;
        });
        if (visiblePanels.length === 0) {
          return null;
        }
        const resolvedTitles = visiblePanels.map((panel) => {
          const meta = getMeta(plugin.name, operatorId, panel.id);
          const staticTitle = resolvePluginLabel(panel.title, plugin.name);
          if (meta.title !== undefined && meta.title !== null) {
            return resolvePluginLabelWithValues(meta.title, plugin.name, meta.titleValues);
          }
          return staticTitle;
        });
        const isImmersiveIframeOnlySection = visiblePanels.length > 0
          && visiblePanels.every((panel, index) => panel.component === 'iframe' && resolvedTitles[index]?.trim() === '');
        const sectionTitle = isImmersiveIframeOnlySection
          ? ''
          : resolvePluginName(plugin.name, plugin.name);
        return (
          <section key={plugin.name} className={isImmersiveIframeOnlySection ? '' : 'space-y-2'}>
            {sectionTitle && (
              <div className="text-xs font-medium text-default-600">
                {sectionTitle}
              </div>
            )}
            <div className={`grid md:grid-cols-2 ${isImmersiveIframeOnlySection ? 'gap-0' : 'gap-2'}`}>
              {visiblePanels.map((panel, index) => (
                <div
                  key={`${plugin.name}:${panel.id}`}
                  className={getOperatorPanelContainerClass(panel)}
                >
                  <PluginPanelRenderer
                    pluginName={plugin.name}
                    operatorId={operatorId}
                    panelId={panel.id}
                    pluginGeneration={pluginSnapshot.generation}
                    title={resolvedTitles[index] ?? ''}
                    component={panel.component}
                    pageId={panel.pageId}
                    initialPanelMeta={pluginSnapshot.panelMeta}
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
