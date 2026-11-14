import * as React from 'react';
import { ModeLeftPluginSlot } from '../keyboard-mode/ModeLeftPluginSlot';

interface CWLeftPluginSlotProps {
  operatorId: string | null | undefined;
}

export const CWLeftPluginSlot: React.FC<CWLeftPluginSlotProps> = ({ operatorId }) => (
  <ModeLeftPluginSlot slotId="cw-left-top" operatorId={operatorId} />
);
