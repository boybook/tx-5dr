import type { CoreRadioCapabilities } from '@tx5dr/contracts';

export interface FrequencyOptionLike {
  key: string;
  mode: string;
}

export function isCoreCapabilityAvailable(
  coreCapabilities: CoreRadioCapabilities | null | undefined,
  capability: keyof CoreRadioCapabilities,
): boolean {
  return coreCapabilities?.[capability] !== false;
}

export function filterDigitalFrequencyOptions<T extends FrequencyOptionLike>(
  availableFrequencies: T[],
  currentModeName: string | null | undefined,
  customFrequencyOption?: T | null,
): T[] {
  let filtered = currentModeName
    ? availableFrequencies.filter(freq => freq.mode === currentModeName)
    : availableFrequencies.filter(freq => freq.mode !== 'VOICE');

  if (customFrequencyOption && (!currentModeName || customFrequencyOption.mode === currentModeName)) {
    const exists = filtered.some(freq => freq.key === customFrequencyOption.key);
    if (!exists) {
      filtered = [customFrequencyOption, ...filtered];
    }
  }

  return filtered;
}
