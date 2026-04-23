import * as React from 'react';
import type { VisiblePluginPanelEntry } from './pluginPanelSlots';
import { PluginTabbedPaneHost } from './PluginSlotHosts';

interface MainRightPluginPaneProps {
  operatorId: string;
  entries: VisiblePluginPanelEntry[];
}

export const MainRightPluginPane: React.FC<MainRightPluginPaneProps> = ({ operatorId, entries }) => {
  if (entries.length === 0) {
    return null;
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-content1">
      <PluginTabbedPaneHost
        entries={entries}
        operatorId={operatorId}
        className="h-full min-h-0 flex-1"
        panelClassName="h-full min-h-0"
        minPaneHeight={280}
      />
    </div>
  );
};
