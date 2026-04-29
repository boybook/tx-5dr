import * as React from 'react';
import { Card, CardBody, CardHeader } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { PersistentTabs, type PersistentTabItem } from '../common/PersistentTabs';
import type { VisiblePluginPanelEntry } from './pluginPanelSlots';
import { PluginPanelRenderer } from './PluginPanelRenderer';

interface PluginCardSlotStackProps {
  entries: VisiblePluginPanelEntry[];
  operatorId: string;
  className?: string;
}

export const PluginCardSlotStack: React.FC<PluginCardSlotStackProps> = ({
  entries,
  operatorId,
  className = '',
}) => {
  const { t } = useTranslation('settings');

  if (entries.length === 0) {
    return null;
  }

  return (
    <div className={`space-y-2 ${className}`.trim()}>
      {entries.map((entry) => (
        <Card key={entry.key}>
          {entry.resolvedTitle.trim().length > 0 && (
            <CardHeader className="pb-0 pt-2 px-3">
              <span className="text-xs font-medium text-default-600">{entry.resolvedTitle}</span>
            </CardHeader>
          )}
          <CardBody className="p-0 overflow-hidden">
            <PluginPanelRenderer
              pluginName={entry.pluginName}
              operatorId={operatorId}
              panelId={entry.panel.id}
              pluginGeneration={entry.pluginGeneration}
              title={entry.resolvedTitle}
              component={entry.panel.component}
              pageId={entry.panel.pageId}
              params={entry.panel.params}
              variant="pane"
              minHeight={200}
              className="h-full"
              initialPanelMeta={entry.initialPanelMeta}
            />
          </CardBody>
        </Card>
      ))}
      {entries.length === 0 && (
        <div className="text-xs text-default-400">{t('plugins.noData', 'No data yet')}</div>
      )}
    </div>
  );
};

interface PluginTabbedPaneHostProps {
  entries: VisiblePluginPanelEntry[];
  operatorId: string;
  className?: string;
  tabBarClassName?: string;
  panelClassName?: string;
  minPaneHeight?: number;
}

export const PluginTabbedPaneHost: React.FC<PluginTabbedPaneHostProps> = ({
  entries,
  operatorId,
  className = '',
  tabBarClassName = '',
  panelClassName = '',
  minPaneHeight = 320,
}) => {
  const items = React.useMemo<PersistentTabItem[]>(() => entries.map((entry) => ({
    key: entry.key,
    label: entry.tabLabel,
    content: (
      <PluginPanelRenderer
        pluginName={entry.pluginName}
        operatorId={operatorId}
        panelId={entry.panel.id}
        pluginGeneration={entry.pluginGeneration}
        title={entry.resolvedTitle}
        component={entry.panel.component}
        pageId={entry.panel.pageId}
        params={entry.panel.params}
        variant="pane"
        minHeight={minPaneHeight}
        fillHeight
        className="h-full min-h-0 flex-1"
        initialPanelMeta={entry.initialPanelMeta}
      />
    ),
  })), [entries, minPaneHeight, operatorId]);

  if (items.length === 0) {
    return null;
  }

  return (
    <PersistentTabs
      items={items}
      hideSingleTabBar
      className={className}
      tabBarClassName={tabBarClassName}
      panelClassName={panelClassName}
    />
  );
};
