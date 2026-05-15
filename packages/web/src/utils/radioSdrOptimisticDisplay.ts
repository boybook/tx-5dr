export interface RadioSdrFrequencyRange {
  min: number;
  max: number;
}

export type RadioSdrOptimisticDisplayState =
  | { status: 'idle' }
  | {
      status: 'pending';
      targetFrequencyHz: number;
      baselineFrequencyHz: number;
      baselineFrameCenterHz: number;
      sentAt: number;
      expiresAt: number;
    }
  | {
      status: 'confirmedHold';
      targetFrequencyHz: number;
      confirmedAt: number;
      expiresAt: number;
    };

export const RADIO_SDR_OPTIMISTIC_DISPLAY_PENDING_TIMEOUT_MS = 2000;
export const RADIO_SDR_OPTIMISTIC_DISPLAY_HOLD_TIMEOUT_MS = 1000;
export const RADIO_SDR_OPTIMISTIC_DISPLAY_CONFIRM_MIN_HZ = 50;
export const RADIO_SDR_OPTIMISTIC_DISPLAY_CONFIRM_SPAN_RATIO = 0.001;

export const RADIO_SDR_OPTIMISTIC_DISPLAY_IDLE: RadioSdrOptimisticDisplayState = {
  status: 'idle',
};

export function getRadioSdrRangeSpanHz(range: RadioSdrFrequencyRange): number {
  return range.max - range.min;
}

export function getRadioSdrRangeCenterHz(range: RadioSdrFrequencyRange): number {
  return range.min + getRadioSdrRangeSpanHz(range) / 2;
}

export function getRadioSdrOptimisticConfirmToleranceHz(range: RadioSdrFrequencyRange): number {
  const spanHz = getRadioSdrRangeSpanHz(range);
  if (!Number.isFinite(spanHz) || spanHz <= 0) {
    return RADIO_SDR_OPTIMISTIC_DISPLAY_CONFIRM_MIN_HZ;
  }

  return Math.max(
    RADIO_SDR_OPTIMISTIC_DISPLAY_CONFIRM_MIN_HZ,
    spanHz * RADIO_SDR_OPTIMISTIC_DISPLAY_CONFIRM_SPAN_RATIO,
  );
}

export function isFrequencyNearRadioSdrRangeCenter(
  frequencyHz: number | null | undefined,
  range: RadioSdrFrequencyRange,
): boolean {
  if (typeof frequencyHz !== 'number' || !Number.isFinite(frequencyHz)) {
    return false;
  }

  return Math.abs(frequencyHz - getRadioSdrRangeCenterHz(range)) <= getRadioSdrOptimisticConfirmToleranceHz(range);
}

export function chooseRadioSdrOptimisticBaselineFrequencyHz({
  frameRange,
  currentRadioFrequencyHz,
}: {
  frameRange: RadioSdrFrequencyRange;
  currentRadioFrequencyHz: number | null | undefined;
}): number {
  return isFrequencyNearRadioSdrRangeCenter(currentRadioFrequencyHz, frameRange)
    ? currentRadioFrequencyHz as number
    : getRadioSdrRangeCenterHz(frameRange);
}

export function createRadioSdrOptimisticDisplayPendingState({
  targetFrequencyHz,
  baselineFrequencyHz,
  baselineFrameCenterHz,
  sentAt,
  timeoutMs = RADIO_SDR_OPTIMISTIC_DISPLAY_PENDING_TIMEOUT_MS,
}: {
  targetFrequencyHz: number;
  baselineFrequencyHz: number;
  baselineFrameCenterHz: number;
  sentAt: number;
  timeoutMs?: number;
}): RadioSdrOptimisticDisplayState {
  return {
    status: 'pending',
    targetFrequencyHz: Math.round(targetFrequencyHz),
    baselineFrequencyHz,
    baselineFrameCenterHz,
    sentAt,
    expiresAt: sentAt + timeoutMs,
  };
}

export function confirmRadioSdrOptimisticDisplayStateWithFrame(
  state: RadioSdrOptimisticDisplayState,
  frameRange: RadioSdrFrequencyRange,
  now: number,
  holdTimeoutMs = RADIO_SDR_OPTIMISTIC_DISPLAY_HOLD_TIMEOUT_MS,
): RadioSdrOptimisticDisplayState {
  if (state.status !== 'pending') {
    return state;
  }

  if (now >= state.expiresAt) {
    return RADIO_SDR_OPTIMISTIC_DISPLAY_IDLE;
  }

  const expectedCenterHz = state.baselineFrameCenterHz + (state.targetFrequencyHz - state.baselineFrequencyHz);
  const actualCenterHz = getRadioSdrRangeCenterHz(frameRange);
  const toleranceHz = getRadioSdrOptimisticConfirmToleranceHz(frameRange);
  if (Math.abs(actualCenterHz - expectedCenterHz) > toleranceHz) {
    return state;
  }

  return {
    status: 'confirmedHold',
    targetFrequencyHz: state.targetFrequencyHz,
    confirmedAt: now,
    expiresAt: now + holdTimeoutMs,
  };
}

export function reconcileRadioSdrOptimisticDisplayStateWithRadioFrequency(
  state: RadioSdrOptimisticDisplayState,
  currentRadioFrequencyHz: number | null | undefined,
  now: number,
): RadioSdrOptimisticDisplayState {
  if (state.status === 'idle') {
    return state;
  }

  if (now >= state.expiresAt) {
    return RADIO_SDR_OPTIMISTIC_DISPLAY_IDLE;
  }

  if (state.status !== 'confirmedHold') {
    return state;
  }

  if (
    typeof currentRadioFrequencyHz === 'number'
    && Number.isFinite(currentRadioFrequencyHz)
    && Math.abs(currentRadioFrequencyHz - state.targetFrequencyHz) <= RADIO_SDR_OPTIMISTIC_DISPLAY_CONFIRM_MIN_HZ
  ) {
    return RADIO_SDR_OPTIMISTIC_DISPLAY_IDLE;
  }

  return state;
}

export function resolveRadioSdrOptimisticDisplayFrequencyHz(
  state: RadioSdrOptimisticDisplayState,
  fallbackFrequencyHz: number | null | undefined,
): number | null {
  if (state.status !== 'idle') {
    return state.targetFrequencyHz;
  }

  return typeof fallbackFrequencyHz === 'number' && Number.isFinite(fallbackFrequencyHz)
    ? fallbackFrequencyHz
    : null;
}
