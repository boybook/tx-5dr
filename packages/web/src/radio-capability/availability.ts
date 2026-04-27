import type { CapabilityState } from '@tx5dr/contracts';

type Translate = (key: string, defaultValue?: string) => string;

export function getCapabilityAvailability(state: CapabilityState | null | undefined): 'available' | 'unavailable' | 'unknown' {
  if (state?.availability) {
    return state.availability;
  }
  return state?.supported ? 'available' : 'unknown';
}

export function isCapabilityAvailable(state: CapabilityState | null | undefined): boolean {
  return Boolean(state?.supported) && getCapabilityAvailability(state) !== 'unavailable';
}

export function isCapabilityInteractive(
  state: CapabilityState | null | undefined,
  canControl: boolean,
  canWrite: boolean,
): boolean {
  return canControl && canWrite && isCapabilityAvailable(state);
}

export function getCapabilityUnavailableText(
  state: CapabilityState | null | undefined,
  t: Translate,
  capabilityId?: string,
): string | null {
  if (!state?.supported || getCapabilityAvailability(state) !== 'unavailable') {
    return null;
  }

  if (capabilityId === 'tuner_switch' || capabilityId === 'tuner_tune') {
    return t(
      'radio:capability.panel.tunerUnavailable',
      'Tuner not connected.',
    );
  }

  switch (state.availabilityReason) {
    case 'busy':
      return t('radio:capability.panel.unavailableBusy', 'Radio is busy; try again shortly.');
    case 'unsupported_by_current_mode':
      return t('radio:capability.panel.unavailableMode', 'Unavailable in the current radio mode.');
    case 'runtime_error':
    case 'radio_reported_unavailable':
      return t('radio:capability.panel.unavailableRuntime', 'Radio reported this control is currently unavailable.');
    default:
      return t('radio:capability.panel.unavailable', 'Currently unavailable.');
  }
}
