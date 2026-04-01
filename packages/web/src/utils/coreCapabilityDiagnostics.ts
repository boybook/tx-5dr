import type {
  CoreRadioCapabilities,
  CoreCapabilityDiagnostic,
  CoreCapabilityDiagnostics,
} from '@tx5dr/contracts';

export type CoreCapabilityKey = keyof CoreRadioCapabilities;

export interface ActiveCoreCapabilityDiagnostic extends CoreCapabilityDiagnostic {
  capability: CoreCapabilityKey;
}

const CORE_CAPABILITY_KEYS: CoreCapabilityKey[] = [
  'readFrequency',
  'writeFrequency',
  'readRadioMode',
  'writeRadioMode',
];

export function getActiveCoreCapabilityDiagnostics(
  coreCapabilities: CoreRadioCapabilities | null | undefined,
  diagnostics: CoreCapabilityDiagnostics | null | undefined,
): ActiveCoreCapabilityDiagnostic[] {
  if (!coreCapabilities || !diagnostics) {
    return [];
  }

  return CORE_CAPABILITY_KEYS.flatMap((capability) => {
    if (coreCapabilities[capability] !== false) {
      return [];
    }

    const diagnostic = diagnostics[capability];
    if (!diagnostic) {
      return [];
    }

    return [{
      ...diagnostic,
      capability,
    }];
  });
}
