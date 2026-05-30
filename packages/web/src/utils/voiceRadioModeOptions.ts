import type { CapabilityDescriptor, CapabilityState } from '@tx5dr/contracts';

export const FALLBACK_VOICE_RADIO_MODES = ['USB', 'LSB', 'FM', 'AM'] as const;
export const VOICE_RADIO_MODE_ORDER = [...FALLBACK_VOICE_RADIO_MODES, 'WFM'] as const;

const VOICE_RADIO_MODE_SET = new Set<string>(VOICE_RADIO_MODE_ORDER);

export function normalizeVoiceRadioMode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return VOICE_RADIO_MODE_SET.has(normalized) ? normalized : null;
}

export function deriveVoiceRadioModeOptions(
  descriptor: CapabilityDescriptor | null | undefined,
  state: CapabilityState | null | undefined,
): string[] {
  const capabilityOptions = descriptor?.options ?? [];
  if (state?.supported && capabilityOptions.length > 0) {
    const availableModes = new Set(
      capabilityOptions
        .map((option) => normalizeVoiceRadioMode(option.value))
        .filter((mode): mode is string => Boolean(mode)),
    );
    const modes = VOICE_RADIO_MODE_ORDER.filter((mode) => availableModes.has(mode));
    if (modes.length > 0) {
      return modes;
    }
  }

  return [...FALLBACK_VOICE_RADIO_MODES];
}
