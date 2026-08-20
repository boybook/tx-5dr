import type { OperatorStatus, SlotInfo } from '@tx5dr/contracts';
import { CycleUtils } from '@tx5dr/core';

export interface RadioOperatorCyclePresentation {
  isTransmit: boolean;
  transmitContent: string;
  progressColor: string;
}

export function resolveRadioOperatorCyclePresentation(
  operatorStatus: OperatorStatus,
  slotInfo: SlotInfo | null | undefined,
  isCurrentTransmitCycle: boolean,
): RadioOperatorCyclePresentation {
  const isTransmit = operatorStatus.isInActivePTT === true
    || (operatorStatus.isTransmitting && isCurrentTransmitCycle);
  const transmitContent = operatorStatus.slots && operatorStatus.currentSlot
    ? operatorStatus.slots[
      operatorStatus.currentSlot as keyof NonNullable<OperatorStatus['slots']>
    ] || ''
    : '';

  if (isTransmit) {
    return {
      isTransmit,
      transmitContent,
      progressColor: 'hsl(var(--heroui-danger) / 0.15)',
    };
  }

  return {
    isTransmit,
    transmitContent,
    progressColor: !slotInfo || CycleUtils.isEvenCycle(slotInfo.cycleNumber)
      ? 'var(--ft8-cycle-even-bg)'
      : 'var(--ft8-cycle-odd-bg)',
  };
}
