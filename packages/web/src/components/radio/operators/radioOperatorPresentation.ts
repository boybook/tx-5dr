import type { OperatorStatus, SlotInfo, StrategyStateOption } from '@tx5dr/contracts';
import { CycleUtils } from '@tx5dr/core';

export type RadioOperatorCurrentTransmission = NonNullable<
  OperatorStatus['currentTransmissions']
>[number];

export interface RadioOperatorStreamPresentation {
  streamId: string;
  currentState?: string;
  targetCallsign?: string;
  audioFrequencyHz?: number;
  text?: string;
  qsoLifecycleEpoch?: number;
  stateOptions?: StrategyStateOption[];
}

/**
 * Returns the Host-projected transmission set. The selected legacy TX slot is
 * only a compatibility fallback for older servers that omit the new field.
 */
export function resolveRadioOperatorCurrentTransmissions(
  operatorStatus: OperatorStatus,
): RadioOperatorCurrentTransmission[] {
  const currentTransmissions = operatorStatus.currentTransmissions;
  if (currentTransmissions !== undefined) {
    return currentTransmissions.map((transmission) => ({ ...transmission }));
  }

  const legacyText = operatorStatus.slots && operatorStatus.currentSlot
    ? operatorStatus.slots[
      operatorStatus.currentSlot as keyof NonNullable<OperatorStatus['slots']>
    ] || ''
    : '';
  if (!legacyText) return [];

  const legacyStream = operatorStatus.runtime?.streams?.[0];
  return [{
    streamId: legacyStream?.streamId ?? 'default',
    text: legacyText,
    audioFrequencyHz: legacyStream?.audioFrequencyHz ?? operatorStatus.context.frequency ?? 0,
  }];
}

export function summarizeRadioOperatorTransmissions(
  transmissions: readonly RadioOperatorCurrentTransmission[],
): string {
  return transmissions.map((transmission) => transmission.text).filter(Boolean).join(' · ');
}

/**
 * Joins the three public projections without inventing protocol data in the UI.
 * Runtime streams establish stable row order; current transmissions and active
 * queue rows fill any Host-only or strategy-only streams that remain.
 */
export function resolveRadioOperatorStreamPresentations(
  operatorStatus: OperatorStatus,
): RadioOperatorStreamPresentation[] {
  const rows = new Map<string, RadioOperatorStreamPresentation>();
  const upsert = (
    streamId: string,
    patch: Omit<RadioOperatorStreamPresentation, 'streamId'>,
  ) => {
    rows.set(streamId, { ...rows.get(streamId), streamId, ...patch });
  };

  for (const stream of operatorStatus.runtime?.streams ?? []) {
    upsert(stream.streamId, {
      currentState: stream.currentState,
      targetCallsign: stream.targetCallsign,
      audioFrequencyHz: stream.audioFrequencyHz,
      qsoLifecycleEpoch: stream.qsoLifecycleEpoch,
      ...(stream.stateOptions ? { stateOptions: stream.stateOptions } : {}),
    });
  }

  const transmissions = resolveRadioOperatorCurrentTransmissions(operatorStatus);
  for (const transmission of transmissions) {
    upsert(transmission.streamId, {
      text: transmission.text,
      audioFrequencyHz: transmission.audioFrequencyHz,
    });
  }

  for (const queueRow of operatorStatus.runtime?.queue?.rows ?? []) {
    if (!queueRow.streamId) continue;
    const existing = rows.get(queueRow.streamId);
    upsert(queueRow.streamId, {
      currentState: existing?.currentState ?? queueRow.displayState,
      targetCallsign: existing?.targetCallsign ?? queueRow.callsign,
      audioFrequencyHz: existing?.audioFrequencyHz ?? queueRow.audioFrequencyHz,
    });
  }

  return [...rows.values()];
}

export function resolveSingleControllableStream(
  streams: readonly RadioOperatorStreamPresentation[],
  maxActiveStreams: number | undefined,
): RadioOperatorStreamPresentation | undefined {
  if (maxActiveStreams !== 1) return undefined;
  const controllable = streams.filter((stream) => (stream.stateOptions?.length ?? 0) > 0);
  return controllable.length === 1 ? controllable[0] : undefined;
}

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
  const transmitContent = summarizeRadioOperatorTransmissions(
    resolveRadioOperatorCurrentTransmissions(operatorStatus),
  );
  const hasTransmitIntent = operatorStatus.hasTransmitIntent ?? Boolean(transmitContent);
  const isTransmit = operatorStatus.isInActivePTT === true
    || (operatorStatus.isTransmitting && isCurrentTransmitCycle && hasTransmitIntent);

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
