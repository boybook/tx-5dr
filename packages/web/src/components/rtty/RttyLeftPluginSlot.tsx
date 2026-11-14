import * as React from 'react';
import { ModeLeftPluginSlot } from '../keyboard-mode/ModeLeftPluginSlot';

interface RttyLeftPluginSlotProps {
  operatorId: string | null | undefined;
}

export const RttyLeftPluginSlot: React.FC<RttyLeftPluginSlotProps> = ({ operatorId }) => (
  <ModeLeftPluginSlot slotId="rtty-left-top" operatorId={operatorId} />
);
