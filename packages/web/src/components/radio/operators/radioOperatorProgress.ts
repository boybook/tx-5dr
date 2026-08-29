import type React from 'react';
import type { OperatorStatus, SlotInfo } from '@tx5dr/contracts';
import { resolveRadioOperatorCurrentTransmissions } from './radioOperatorPresentation';

export function getRadioOperatorProgressAnimation(
  slotInfo: SlotInfo | null | undefined,
  slotDurationMs?: number | null,
): React.CSSProperties {
  if (!slotInfo || !slotDurationMs) {
    return { animation: 'none' };
  }

  const normalizedProgress = Math.max(0, Math.min(slotInfo.phaseMs / slotDurationMs, 1));
  const remainingMs = Math.max(1, slotDurationMs * (1 - normalizedProgress));
  const maskStartPercent = Math.max(0, 100 - normalizedProgress * 100);

  return {
    animation: `progress-bar ${remainingMs}ms linear forwards`,
    // @ts-expect-error CSS custom property for animation start position
    '--progress-start': `${maskStartPercent}%`,
  };
}

export function shouldRadioOperatorPropsBeEqual(prev: OperatorStatus, next: OperatorStatus): boolean {
  if (prev.id !== next.id ||
      prev.isActive !== next.isActive ||
      prev.isTransmitting !== next.isTransmitting ||
      prev.isInActivePTT !== next.isInActivePTT ||
      prev.hasTransmitIntent !== next.hasTransmitIntent ||
      prev.currentSlot !== next.currentSlot) {
    return false;
  }

  if (JSON.stringify(prev.context) !== JSON.stringify(next.context)) {
    return false;
  }

  if (JSON.stringify(prev.slots) !== JSON.stringify(next.slots)) {
    return false;
  }

  if (JSON.stringify(prev.transmitCycles) !== JSON.stringify(next.transmitCycles)) {
    return false;
  }

  if (JSON.stringify(prev.strategy) !== JSON.stringify(next.strategy)) {
    return false;
  }

  if (JSON.stringify(prev.runtime?.queue) !== JSON.stringify(next.runtime?.queue)) {
    return false;
  }

  if (JSON.stringify(prev.runtime?.streams) !== JSON.stringify(next.runtime?.streams)) {
    return false;
  }

  if (JSON.stringify(resolveRadioOperatorCurrentTransmissions(prev))
      !== JSON.stringify(resolveRadioOperatorCurrentTransmissions(next))) {
    return false;
  }

  return true;
}
