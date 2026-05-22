import type { OperatorStatus, SlotPack } from '@tx5dr/contracts';
import { CycleUtils } from '@tx5dr/core';

const IDLE_FREQUENCY_MIN_HZ = 0;
const IDLE_FREQUENCY_MAX_HZ = 3000;
const IDLE_FREQUENCY_GUARD_HZ = 100;

interface FrequencyGap {
  start: number;
  end: number;
  width: number;
  center: number;
}

interface OccupiedInterval {
  start: number;
  end: number;
}

export function pickManualIdleFrequency(params: {
  slotPacks: SlotPack[];
  operators: OperatorStatus[];
  operatorId: string;
  transmitCycles: number[];
  slotMs: number;
}): number | null {
  const candidates = [...params.slotPacks]
    .filter((slotPack) => {
      const cycleMatch = CycleUtils.isOperatorTransmitCycleFromMs(
        params.transmitCycles,
        slotPack.startMs,
        params.slotMs,
      );
      return cycleMatch && slotPack.frames && slotPack.frames.length > 0;
    })
    .sort((a, b) => b.endMs - a.endMs);

  const latest = candidates[0];
  if (!latest) {
    return null;
  }

  const occupiedFrequencies = [
    ...latest.frames
      .filter((frame) => frame.snr !== -999)
      .map((frame) => frame.freq),
    ...params.operators
      .filter((operator) => operator.id !== params.operatorId)
      .map((operator) => operator.context.frequency),
  ]
    .filter((frequency): frequency is number => (
      typeof frequency === 'number'
      && Number.isFinite(frequency)
      && frequency >= IDLE_FREQUENCY_MIN_HZ
      && frequency <= IDLE_FREQUENCY_MAX_HZ
    ))
    .sort((a, b) => a - b);

  if (occupiedFrequencies.length === 0) {
    return Math.round((IDLE_FREQUENCY_MIN_HZ + IDLE_FREQUENCY_MAX_HZ) / 2);
  }

  const halfGuard = IDLE_FREQUENCY_GUARD_HZ / 2;
  const occupiedIntervals = occupiedFrequencies
    .map((frequency) => ({
      start: Math.max(IDLE_FREQUENCY_MIN_HZ, frequency - halfGuard),
      end: Math.min(IDLE_FREQUENCY_MAX_HZ, frequency + halfGuard),
    }))
    .filter((interval) => (
      interval.end >= IDLE_FREQUENCY_MIN_HZ
      && interval.start <= IDLE_FREQUENCY_MAX_HZ
    ))
    .sort((a, b) => a.start - b.start);

  const mergedIntervals: OccupiedInterval[] = [];
  for (const interval of occupiedIntervals) {
    const last = mergedIntervals[mergedIntervals.length - 1];
    if (!last || interval.start > last.end) {
      mergedIntervals.push({ ...interval });
    } else {
      last.end = Math.max(last.end, interval.end);
    }
  }

  const gaps: FrequencyGap[] = [];
  let cursor = IDLE_FREQUENCY_MIN_HZ;
  for (const interval of mergedIntervals) {
    if (interval.start > cursor) {
      gaps.push({
        start: cursor,
        end: interval.start,
        width: interval.start - cursor,
        center: Math.round((cursor + interval.start) / 2),
      });
    }
    cursor = Math.max(cursor, interval.end);
  }
  if (cursor < IDLE_FREQUENCY_MAX_HZ) {
    gaps.push({
      start: cursor,
      end: IDLE_FREQUENCY_MAX_HZ,
      width: IDLE_FREQUENCY_MAX_HZ - cursor,
      center: Math.round((cursor + IDLE_FREQUENCY_MAX_HZ) / 2),
    });
  }

  const validGaps = gaps.filter((gap) => gap.width >= halfGuard);
  if (validGaps.length === 0) {
    return null;
  }

  const overallCenter = (IDLE_FREQUENCY_MIN_HZ + IDLE_FREQUENCY_MAX_HZ) / 2;
  const bestGap = validGaps.reduce((best, current) => {
    if (current.width > best.width) {
      return current;
    }
    if (current.width === best.width) {
      const currentDistance = Math.abs(current.center - overallCenter);
      const bestDistance = Math.abs(best.center - overallCenter);
      return currentDistance < bestDistance ? current : best;
    }
    return best;
  });

  return Math.max(IDLE_FREQUENCY_MIN_HZ, Math.min(IDLE_FREQUENCY_MAX_HZ, bestGap.center));
}
