import React from 'react';
import { PluginPanelRenderer } from './PluginPanelRenderer';
import { useVisiblePluginPanelsForSlot } from './pluginPanelSlots';
import type { PluginPanelDescriptor } from '@tx5dr/contracts';

interface OperatorPluginPanelsProps {
  operatorId: string;
}

export function getOperatorPanelContainerClass(panel: PluginPanelDescriptor): string {
  return panel.width === 'full' ? 'md:col-span-2' : '';
}

export const OperatorPluginPanels: React.FC<OperatorPluginPanelsProps> = ({ operatorId }) => {
  const visiblePanels = useVisiblePluginPanelsForSlot(operatorId, 'operator');

  if (visiblePanels.length === 0) {
    return null;
  }

  const groupedPanels = visiblePanels.reduce<Map<string, typeof visiblePanels>>((map, entry) => {
    const existing = map.get(entry.pluginName) ?? [];
    existing.push(entry);
    map.set(entry.pluginName, existing);
    return map;
  }, new Map());

  return (
    <div className="space-y-3">
      {Array.from(groupedPanels.entries()).map(([pluginName, entries]) => {
        const isImmersiveIframeOnlySection = entries.length > 0
          && entries.every((entry) => entry.panel.component === 'iframe' && entry.resolvedTitle.trim() === '');
        const sectionTitle = isImmersiveIframeOnlySection ? '' : entries[0]?.pluginDisplayName ?? pluginName;

        return (
          <section key={pluginName} className={isImmersiveIframeOnlySection ? '' : 'space-y-2'}>
            {sectionTitle && (
              <div className="text-xs font-medium text-default-600">
                {sectionTitle}
              </div>
            )}
            <div className={`grid md:grid-cols-2 ${isImmersiveIframeOnlySection ? 'gap-0' : 'gap-2'}`}>
              {entries.map((entry) => (
                <div
                  key={entry.key}
                  className={getOperatorPanelContainerClass(entry.panel)}
                >
                  <PluginPanelRenderer
                    pluginName={entry.pluginName}
                    operatorId={operatorId}
                    panelId={entry.panel.id}
                    pluginGeneration={entry.pluginGeneration}
                    title={entry.resolvedTitle}
                    component={entry.panel.component}
                    pageId={entry.panel.pageId}
                    initialPanelMeta={entry.initialPanelMeta}
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
