import type { OperatorStatus } from '@tx5dr/contracts';
import {
  getStandardDigitalFrequencyMatch,
  type StandardDigitalModeName,
} from '@tx5dr/core';

export {
  getStandardDigitalFrequencyMatch,
  STANDARD_DIGITAL_FREQUENCIES_HZ,
  STANDARD_DIGITAL_FREQUENCY_TOLERANCE_HZ,
} from '@tx5dr/core';

export interface SameCallsignStandardFrequencyWarningGroup {
  callsign: string;
  cycles: number[];
  operatorIds: string[];
}

export interface SameCallsignStandardFrequencyWarning {
  modeName: StandardDigitalModeName;
  standardFrequency: number;
  groups: SameCallsignStandardFrequencyWarningGroup[];
}

export interface MultiStreamStandardFrequencyRestriction {
  modeName: StandardDigitalModeName;
  standardFrequency: number;
  operatorIds: string[];
}

type WarningOperatorInput = Pick<OperatorStatus, 'id' | 'isTransmitting' | 'context' | 'transmitCycles'>;
type StrategyOperatorInput = Pick<OperatorStatus, 'id' | 'runtime'>;

function normalizeCallsign(callsign: string | null | undefined): string {
  return (callsign ?? '').trim().toUpperCase();
}

function normalizeTransmitCycles(transmitCycles: readonly number[] | undefined): number[] {
  const cycles = transmitCycles && transmitCycles.length > 0 ? transmitCycles : [0];
  return [...new Set(cycles.filter((cycle) => cycle === 0 || cycle === 1))].sort((a, b) => a - b);
}

function intersectCycles(left: readonly number[], right: readonly number[]): number[] {
  const rightSet = new Set(right);
  return left.filter((cycle) => rightSet.has(cycle));
}

export function deriveSameCallsignStandardFrequencyWarning(
  operators: readonly WarningOperatorInput[],
  modeName: string | null | undefined,
  frequency: number | null | undefined,
): SameCallsignStandardFrequencyWarning | null {
  const match = getStandardDigitalFrequencyMatch(modeName, frequency);
  if (!match) {
    return null;
  }

  const byCallsign = new Map<string, Array<{ id: string; cycles: number[] }>>();

  for (const operator of operators) {
    if (!operator.isTransmitting) {
      continue;
    }

    const callsign = normalizeCallsign(operator.context.myCall);
    if (!callsign) {
      continue;
    }

    const cycles = normalizeTransmitCycles(operator.transmitCycles);
    if (cycles.length === 0) {
      continue;
    }

    const existing = byCallsign.get(callsign) ?? [];
    existing.push({ id: operator.id, cycles });
    byCallsign.set(callsign, existing);
  }

  const groups: SameCallsignStandardFrequencyWarningGroup[] = [];

  for (const [callsign, groupOperators] of byCallsign) {
    if (groupOperators.length < 2) {
      continue;
    }

    const overlappingCycles = new Set<number>();
    const overlappingOperatorIds = new Set<string>();

    for (let i = 0; i < groupOperators.length; i += 1) {
      for (let j = i + 1; j < groupOperators.length; j += 1) {
        const overlap = intersectCycles(groupOperators[i].cycles, groupOperators[j].cycles);
        if (overlap.length === 0) {
          continue;
        }

        overlap.forEach((cycle) => overlappingCycles.add(cycle));
        overlappingOperatorIds.add(groupOperators[i].id);
        overlappingOperatorIds.add(groupOperators[j].id);
      }
    }

    if (overlappingCycles.size > 0) {
      groups.push({
        callsign,
        cycles: [...overlappingCycles].sort((a, b) => a - b),
        operatorIds: groupOperators
          .filter((operator) => [...overlappingOperatorIds].some((id) => id === operator.id))
          .map((operator) => operator.id),
      });
    }
  }

  if (groups.length === 0) {
    return null;
  }

  return {
    modeName: match.modeName,
    standardFrequency: match.standardFrequency,
    groups,
  };
}

export function deriveMultiStreamStandardFrequencyRestriction(
  operators: readonly StrategyOperatorInput[],
  modeName: string | null | undefined,
  frequency: number | null | undefined,
): MultiStreamStandardFrequencyRestriction | null {
  const match = getStandardDigitalFrequencyMatch(modeName, frequency);
  if (!match) return null;

  const operatorIds = operators
    .filter((operator) => (operator.runtime?.queue?.requestedMaxActiveStreams ?? 1) > 1)
    .map((operator) => operator.id);
  return operatorIds.length > 0 ? { ...match, operatorIds } : null;
}

export function formatSameCallsignWarningCallsigns(groups: readonly SameCallsignStandardFrequencyWarningGroup[]): string {
  return groups.map((group) => group.callsign).join(', ');
}
