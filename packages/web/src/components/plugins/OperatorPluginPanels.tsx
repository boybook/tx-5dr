import React from 'react';
import { useTranslation } from 'react-i18next';
import { PluginPanelRenderer } from './PluginPanelRenderer';
import { usePluginSnapshot } from '../../hooks/usePluginSnapshot';
import { resolvePluginLabel, resolvePluginName } from '../../utils/pluginLocales';

interface OperatorPluginPanelsProps {
  operatorId: string;
}

export const OperatorPluginPanels: React.FC<OperatorPluginPanelsProps> = ({ operatorId }) => {
  const { t } = useTranslation('settings');
  const pluginSnapshot = usePluginSnapshot();

  const activePluginsWithPanels = React.useMemo(
    () => pluginSnapshot.plugins.filter((plugin) => {
      if (!plugin.panels?.length) {
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
      <div className="text-[11px] uppercase tracking-[0.18em] text-default-400">
        {t('plugins.livePanels', 'Live Panels')}
      </div>
      {activePluginsWithPanels.map((plugin) => (
        <section key={plugin.name} className="space-y-2">
          <div className="text-xs font-medium text-default-600">
            {resolvePluginName(plugin.name, plugin.name)}
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            {(plugin.panels ?? []).map((panel) => (
              <PluginPanelRenderer
                key={`${plugin.name}:${panel.id}`}
                pluginName={plugin.name}
                operatorId={operatorId}
                panelId={panel.id}
                title={resolvePluginLabel(panel.title, plugin.name)}
                component={panel.component}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
};
