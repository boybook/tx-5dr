import type {
  CapabilityDescriptor,
  CapabilityOption,
} from '@tx5dr/contracts';
import { RadioConnectionType } from '../connections/IRadioConnection.js';
import type { IRadioConnection } from '../connections/IRadioConnection.js';

interface HamlibSupportProbeConnection extends IRadioConnection {
  isSupportedLevel(level: string): boolean;
  isSupportedFunction(functionName: string): boolean;
  isSupportedParm(parmName: string): boolean;
}

export function hasHamlibSupportProbe(connection: IRadioConnection): connection is HamlibSupportProbeConnection {
  const candidate = connection as Partial<HamlibSupportProbeConnection>;
  return typeof candidate.isSupportedLevel === 'function'
    && typeof candidate.isSupportedFunction === 'function'
    && typeof candidate.isSupportedParm === 'function';
}

export function createPercentDescriptor(
  id: string,
  category: CapabilityDescriptor['category'],
  labelI18nKey: string,
  descriptionI18nKey: string,
): CapabilityDescriptor {
  return {
    id,
    category,
    valueType: 'number',
    range: { min: 0, max: 1, step: 0.01 },
    readable: true,
    writable: true,
    updateMode: 'polling',
    pollIntervalMs: 10000,
    labelI18nKey,
    descriptionI18nKey,
    display: { mode: 'percent', decimals: 0 },
    hasSurfaceControl: false,
  };
}

export function createBooleanDescriptor(
  id: string,
  category: CapabilityDescriptor['category'],
  labelI18nKey: string,
  descriptionI18nKey: string,
): CapabilityDescriptor {
  return {
    id,
    category,
    valueType: 'boolean',
    readable: true,
    writable: true,
    updateMode: 'polling',
    pollIntervalMs: 10000,
    labelI18nKey,
    descriptionI18nKey,
    hasSurfaceControl: false,
  };
}

export function createOption(value: string | number, labelI18nKey?: string): CapabilityOption {
  return labelI18nKey ? { value, labelI18nKey } : { value };
}

export function uniqueSortedNumbers(values: number[]): number[] {
  return Array.from(new Set(values.filter((value) => Number.isFinite(value)))).sort((a, b) => a - b);
}

export function buildTuningStepOptions(steps: number[]): CapabilityOption[] {
  return uniqueSortedNumbers(steps)
    .filter((step) => step > 0)
    .map((step) => createOption(step));
}

export function buildCtcssToneOptions(tones: number[]): CapabilityOption[] {
  return uniqueSortedNumbers(tones)
    .filter((tone) => tone > 0)
    .map((tone) => createOption(tone));
}

export function buildDcsCodeOptions(codes: number[]): CapabilityOption[] {
  return uniqueSortedNumbers(codes)
    .filter((code) => code > 0)
    .map((code) => createOption(code));
}

export function buildModeBandwidthOptions(values: Array<string | number>): CapabilityOption[] {
  const numericValues = uniqueSortedNumbers(values.filter((value): value is number => typeof value === 'number'))
    .filter((value) => value > 0)
    .map((value) => createOption(value));
  const stringValues = Array.from(new Set(
    values
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
  )).map((value) => createOption(value));

  return [...numericValues, ...stringValues];
}

export function createHamlibLevelProbe(level: string) {
  return async (connection: IRadioConnection, fallback?: () => Promise<void>): Promise<boolean> => {
    if (
      connection.getType() === RadioConnectionType.HAMLIB
      && hasHamlibSupportProbe(connection)
      && connection.isSupportedLevel(level)
    ) {
      return true;
    }

    if (!fallback) {
      return false;
    }

    await fallback();
    return true;
  };
}
