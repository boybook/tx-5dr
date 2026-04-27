import type { OperatorStatus } from '@tx5dr/contracts';

export const STANDARD_DIGITAL_FREQUENCY_TOLERANCE_HZ = 1500;

const STANDARD_DIGITAL_FREQUENCIES_HZ = {
  FT8: [
    1840000,
    3573000,
    7074000,
    10136000,
    14074000,
    18100000,
    21074000,
    24915000,
    28074000,
    50313000,
    144174000,
    144460000,
    432174000,
  ],
  FT4: [
    1842000,
    3575000,
    7047500,
    10140000,
    14080000,
    18104000,
    21140000,
    24919000,
    28180000,
    50318000,
  ],
} as const;

type StandardDigitalModeName = keyof typeof STANDARD_DIGITAL_FREQUENCIES_HZ;

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

type WarningOperatorInput = Pick<OperatorStatus, 'id' | 'isTransmitting' | 'context' | 'transmitCycles'>;

function normalizeModeName(modeName: string | null | undefined): StandardDigitalModeName | null {
  const normalized = modeName?.trim().toUpperCase();
  return normalized === 'FT8' || normalized === 'FT4' ? normalized : null;
}

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

export function getStandardDigitalFrequencyMatch(
  modeName: string | null | undefined,
  frequency: number | null | undefined,
): { modeName: StandardDigitalModeName; standardFrequency: number } | null {
  const digitalModeName = normalizeModeName(modeName);
  if (!digitalModeName || typeof frequency !== 'number' || !Number.isFinite(frequency)) {
    return null;
  }

  const standardFrequency = STANDARD_DIGITAL_FREQUENCIES_HZ[digitalModeName].find(
    (candidate) => Math.abs(candidate - frequency) <= STANDARD_DIGITAL_FREQUENCY_TOLERANCE_HZ,
  );

  return standardFrequency ? { modeName: digitalModeName, standardFrequency } : null;
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

export function formatSameCallsignWarningCallsigns(groups: readonly SameCallsignStandardFrequencyWarningGroup[]): string {
  return groups.map((group) => group.callsign).join(', ');
}
