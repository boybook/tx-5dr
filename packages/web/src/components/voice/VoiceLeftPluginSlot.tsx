import * as React from 'react';
import { useVisiblePluginPanelsForSlot } from '../plugins/pluginPanelSlots';
import { PluginCardSlotStack } from '../plugins/PluginSlotHosts';

interface VoiceLeftPluginSlotProps {
  operatorId: string | null | undefined;
}

export const VoiceLeftPluginSlot: React.FC<VoiceLeftPluginSlotProps> = ({ operatorId }) => {
  const entries = useVisiblePluginPanelsForSlot(operatorId, 'voice-left-top');

  if (!operatorId || entries.length === 0) {
    return null;
  }

  return <PluginCardSlotStack entries={entries} operatorId={operatorId} />;
};
