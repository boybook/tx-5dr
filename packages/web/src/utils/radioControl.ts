import type { CapabilityState, CoreRadioCapabilities } from '@tx5dr/contracts';

export interface FrequencyOptionLike {
  key: string;
  mode: string;
}

export interface MonitorActivationCtaState {
  shouldShowActivationCta: boolean;
  hasUserActivation: boolean;
}

export function isCoreCapabilityAvailable(
  coreCapabilities: CoreRadioCapabilities | null | undefined,
  capability: keyof CoreRadioCapabilities,
): boolean {
  return coreCapabilities?.[capability] !== false;
}

export function shouldShowAutoTunerShortcut(
  radioConnected: boolean,
  canControlRadio: boolean,
  tunerSwitchCapability: CapabilityState | null | undefined,
): boolean {
  return radioConnected
    && canControlRadio
    && tunerSwitchCapability?.supported === true;
}

export function filterDigitalFrequencyOptions<T extends FrequencyOptionLike>(
  availableFrequencies: T[],
  currentModeName: string | null | undefined,
  customFrequencyOption?: T | null,
): T[] {
  let filtered = currentModeName
    ? availableFrequencies.filter(freq => freq.mode === currentModeName)
    : availableFrequencies.filter(freq => freq.mode !== 'VOICE');

  if (customFrequencyOption) {
    const exists = filtered.some(freq => freq.key === customFrequencyOption.key);
    if (!exists) {
      filtered = [customFrequencyOption, ...filtered];
    }
  }

  return filtered;
}

export function deriveMonitorActivationCtaState(
  isVoiceMode: boolean,
  isConnected: boolean,
  isPlaying: boolean,
  hasActivatedPlaybackThisSession: boolean,
): MonitorActivationCtaState {
  const shouldShowActivationCta = isVoiceMode
    && isConnected
    && !isPlaying
    && !hasActivatedPlaybackThisSession;

  return {
    shouldShowActivationCta,
    hasUserActivation: typeof document !== 'undefined'
      ? Boolean(document.userActivation?.hasBeenActive)
      : false,
  };
}
