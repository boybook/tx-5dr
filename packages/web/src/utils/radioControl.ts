import type { CapabilityState, CoreRadioCapabilities, EngineMode } from '@tx5dr/contracts';
import { subject as caslSubject } from '@casl/ability';

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

export function canWriteRadioFrequency(
  canSetFrequency: boolean,
  coreCapabilities: CoreRadioCapabilities | null | undefined,
): boolean {
  return canSetFrequency && isCoreCapabilityAvailable(coreCapabilities, 'writeFrequency');
}

export interface AbilityLike {
  can(action: string, subject: unknown): boolean;
}

export function canExecuteRadioFrequency(
  ability: AbilityLike,
  frequency: number | null | undefined,
): boolean {
  if (typeof frequency !== 'number' || !Number.isFinite(frequency) || frequency <= 0) {
    return false;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ability.can('execute', caslSubject('RadioFrequency', { frequency: Math.round(frequency) }) as any);
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

export function shouldShowAntennaTuneEntry(
  radioConnected: boolean,
  canControlRadio: boolean,
): boolean {
  return radioConnected && canControlRadio;
}

export function shouldShowRadioControlEntry(
  radioConnected: boolean,
  canControlRadio: boolean,
): boolean {
  return radioConnected && canControlRadio;
}

export function isFakeFrequencySupportedMode(
  engineMode: EngineMode | null | undefined,
  currentModeName: string | null | undefined,
): boolean {
  return engineMode === 'digital' && (currentModeName === 'FT8' || currentModeName === 'FT4');
}

export function shouldShowFakeFrequencyEntry(
  radioConnected: boolean,
  canControlRadio: boolean,
  radioConfigType: string | null | undefined,
  engineMode: EngineMode | null | undefined,
  currentModeName: string | null | undefined,
): boolean {
  return radioConnected
    && canControlRadio
    && !!radioConfigType
    && radioConfigType !== 'none'
    && isFakeFrequencySupportedMode(engineMode, currentModeName);
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
      ? Boolean((document as Document & {
        userActivation?: { hasBeenActive?: boolean };
      }).userActivation?.hasBeenActive)
      : false,
  };
}
