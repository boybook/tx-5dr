import * as React from 'react';
import type { PluginPanelSlot } from '@tx5dr/contracts';
import { useVisiblePluginPanelsForSlot } from '../plugins/pluginPanelSlots';
import { PluginCardSlotStack } from '../plugins/PluginSlotHosts';

export interface ModeLeftPluginSlotProps {
  /** Plugin panel slot, e.g. `cw-left-top`. */
  slotId: PluginPanelSlot;
  operatorId: string | null | undefined;
}

/** Plugin cards of `slotId` stacked at the top of a keyboard mode's left pane. */
export const ModeLeftPluginSlot: React.FC<ModeLeftPluginSlotProps> = ({ slotId, operatorId }) => {
  const entries = useVisiblePluginPanelsForSlot(operatorId, slotId);

  if (!operatorId || entries.length === 0) {
    return null;
  }

  return <PluginCardSlotStack entries={entries} operatorId={operatorId} />;
};
