import * as React from 'react';
import { useVisiblePluginPanelsForSlot } from '../plugins/pluginPanelSlots';
import { PluginCardSlotStack } from '../plugins/PluginSlotHosts';

interface CWLeftPluginSlotProps {
  operatorId: string | null | undefined;
}

export const CWLeftPluginSlot: React.FC<CWLeftPluginSlotProps> = ({ operatorId }) => {
  const entries = useVisiblePluginPanelsForSlot(operatorId, 'cw-left-top');

  if (!operatorId || entries.length === 0) {
    return null;
  }

  return <PluginCardSlotStack entries={entries} operatorId={operatorId} />;
};
