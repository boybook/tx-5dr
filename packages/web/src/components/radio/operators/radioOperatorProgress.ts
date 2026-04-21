import type React from 'react';
import type { OperatorStatus } from '@tx5dr/contracts';

export function getRadioOperatorProgressAnimation(
  cycleInfo: OperatorStatus['cycleInfo'],
  slotDurationMs?: number | null,
): React.CSSProperties {
  if (!cycleInfo || !slotDurationMs) {
    return { animation: 'none' };
  }

  const { cycleProgress } = cycleInfo;

  if (cycleProgress > 1.2) {
    return { animation: 'none' };
  }

  const normalizedProgress = Math.max(0, Math.min(cycleProgress, 1));
  const remainingMs = Math.max(0, slotDurationMs * (1 - normalizedProgress));
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
      prev.currentSlot !== next.currentSlot) {
    return false;
  }

  if (JSON.stringify(prev.context) !== JSON.stringify(next.context)) {
    return false;
  }

  if (JSON.stringify(prev.slots) !== JSON.stringify(next.slots)) {
    return false;
  }

  if (prev.cycleInfo && next.cycleInfo) {
    if (prev.cycleInfo.currentCycle !== next.cycleInfo.currentCycle ||
        prev.cycleInfo.isTransmitCycle !== next.cycleInfo.isTransmitCycle ||
        prev.cycleInfo.cycleProgress !== next.cycleInfo.cycleProgress) {
      return false;
    }
  } else if (prev.cycleInfo !== next.cycleInfo) {
    return false;
  }

  if (JSON.stringify(prev.transmitCycles) !== JSON.stringify(next.transmitCycles)) {
    return false;
  }

  return true;
}
