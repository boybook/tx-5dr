import type React from 'react';
import type {
  SpectrumCapabilities,
  SpectrumFrame,
  SpectrumKind,
  SpectrumSessionState,
} from '@tx5dr/contracts';
import type { RadioService } from '../../services/radioService';
import type { RadioAction, RadioState } from './types';
import type { createLogger } from '../../utils/logger';
import { isSpectrumSubscriptionPaused } from '../../utils/spectrumSubscriptionPause';
import { getPreferredSpectrumKind } from '../../utils/spectrumPreferences';

type Logger = ReturnType<typeof createLogger>;

interface SpectrumNegotiationDeps {
  radioDispatch: React.Dispatch<RadioAction>;
  radioService: RadioService;
  capabilitiesRef: React.MutableRefObject<SpectrumCapabilities | null>;
  radioStateRef: React.MutableRefObject<RadioState>;
  activeProfileIdRef: React.MutableRefObject<string | null>;
  spectrumAutoPriorityPendingRef: React.MutableRefObject<boolean>;
  pendingDefaultOpenWebRXDetailProfileRef: React.MutableRefObject<string | null>;
  logger: Logger;
}

export function createSpectrumNegotiator({
  radioDispatch,
  radioService,
  capabilitiesRef,
  radioStateRef,
  activeProfileIdRef,
  spectrumAutoPriorityPendingRef,
  pendingDefaultOpenWebRXDetailProfileRef,
  logger,
}: SpectrumNegotiationDeps) {
  const SPECTRUM_PRIORITY: SpectrumKind[] = ['openwebrx-sdr', 'radio-sdr', 'audio'];
  let radioFramePromotionInFlight = false;

  const isSpectrumKindAvailable = (capabilities: SpectrumCapabilities, kind: SpectrumKind | null): boolean => {
    if (!kind) {
      return false;
    }

    return capabilities.sources.some((source) => source.kind === kind && source.available);
  };

  const pickSpectrumKindByPriority = (capabilities: SpectrumCapabilities): SpectrumKind => {
    return SPECTRUM_PRIORITY.find((kind) => isSpectrumKindAvailable(capabilities, kind)) ?? 'audio';
  };

  const pickPreferredOrPriorityKind = (capabilities: SpectrumCapabilities): {
    kind: SpectrumKind;
    usedPreference: boolean;
  } => {
    const preferredKind = getPreferredSpectrumKind(
      capabilities.profileId ?? activeProfileIdRef.current,
    );
    if (isSpectrumKindAvailable(capabilities, preferredKind)) {
      return { kind: preferredKind as SpectrumKind, usedPreference: true };
    }
    return { kind: pickSpectrumKindByPriority(capabilities), usedPreference: false };
  };

  const shouldContinueAutoPriority = (
    capabilities: SpectrumCapabilities,
    selectedKind: SpectrumKind,
  ): boolean => {
    const selectedPriorityIndex = SPECTRUM_PRIORITY.indexOf(selectedKind);
    if (selectedPriorityIndex <= 0) {
      return false;
    }

    return SPECTRUM_PRIORITY
      .slice(0, selectedPriorityIndex)
      .some((kind) => capabilities.sources.some((source) => source.kind === kind && source.supported && !source.available));
  };

  const shouldAcceptSpectrumProfile = (profileId: string | null | undefined): boolean => {
    if (profileId === undefined) {
      return true;
    }
    const activeProfileId = activeProfileIdRef.current;
    return activeProfileId === null || (profileId ?? null) === activeProfileId;
  };

  const resetSpectrumNegotiation = (profileId: string | null, clearSpectrumState: boolean): void => {
    radioFramePromotionInFlight = false;
    activeProfileIdRef.current = profileId;
    spectrumAutoPriorityPendingRef.current = true;
    pendingDefaultOpenWebRXDetailProfileRef.current = null;

    radioDispatch({ type: 'setSelectedSpectrumKind', payload: null });
    radioDispatch({ type: 'setSubscribedSpectrumKind', payload: null });

    if (clearSpectrumState) {
      capabilitiesRef.current = null;
      radioDispatch({ type: 'setSpectrumCapabilities', payload: null });
      radioDispatch({ type: 'setSpectrumSessionState', payload: null });
    }
  };

  const applySpectrumSelection = (capabilities: SpectrumCapabilities) => {
    radioFramePromotionInFlight = false;
    if (!shouldAcceptSpectrumProfile(capabilities.profileId)) {
      logger.debug('Ignoring stale spectrum capabilities', {
        activeProfileId: activeProfileIdRef.current,
        capabilitiesProfileId: capabilities.profileId,
      });
      return;
    }

    const profileId = capabilities.profileId;
    const currentSelectedKind = radioStateRef.current.selectedSpectrumKind;
    const shouldAutoApplyPriority = spectrumAutoPriorityPendingRef.current;
    let usedPreference = false;
    let effectiveKind: SpectrumKind;
    if (shouldAutoApplyPriority) {
      const picked = pickPreferredOrPriorityKind(capabilities);
      effectiveKind = picked.kind;
      usedPreference = picked.usedPreference;
    } else {
      effectiveKind = isSpectrumKindAvailable(capabilities, currentSelectedKind)
        ? currentSelectedKind as SpectrumKind
        : pickSpectrumKindByPriority(capabilities);
    }
    const currentModeName = radioStateRef.current.currentMode?.name ?? null;
    const shouldAutoEnableOpenWebRXDetail = shouldAutoApplyPriority
      && !usedPreference
      && effectiveKind === 'openwebrx-sdr'
      && profileId !== null
      && (currentModeName === 'FT8' || currentModeName === 'FT4');

    capabilitiesRef.current = capabilities;
    radioDispatch({ type: 'setSpectrumCapabilities', payload: capabilities });
    radioDispatch({ type: 'setSelectedSpectrumKind', payload: effectiveKind });
    radioDispatch({ type: 'setSubscribedSpectrumKind', payload: isSpectrumSubscriptionPaused() ? null : effectiveKind });
    if (!isSpectrumSubscriptionPaused()) {
      radioService.subscribeSpectrum(effectiveKind);
    }

    pendingDefaultOpenWebRXDetailProfileRef.current = shouldAutoEnableOpenWebRXDetail
      ? profileId
      : null;

    if (shouldAutoApplyPriority) {
      // A stored preference is an explicit user choice — do not keep auto-upgrading away from it.
      spectrumAutoPriorityPendingRef.current = usedPreference
        ? false
        : shouldContinueAutoPriority(capabilities, effectiveKind);
    }
  };

  const applyProfileDrivenSpectrumNegotiation = (profileId: string | null, clearSpectrumState: boolean) => {
    resetSpectrumNegotiation(profileId, clearSpectrumState);

    const currentCapabilities = capabilitiesRef.current;
    if (currentCapabilities && shouldAcceptSpectrumProfile(currentCapabilities.profileId)) {
      applySpectrumSelection(currentCapabilities);
    }
  };

  const applyModeDrivenSpectrumNegotiation = () => {
    radioFramePromotionInFlight = false;
    pendingDefaultOpenWebRXDetailProfileRef.current = null;
    radioDispatch({ type: 'setSelectedSpectrumKind', payload: null });
    radioDispatch({ type: 'setSubscribedSpectrumKind', payload: null });

    // Provisional selection using current (potentially stale) capabilities
    // to avoid a "waiting for spectrum data" flash during mode switch.
    const currentCapabilities = capabilitiesRef.current;
    if (currentCapabilities && shouldAcceptSpectrumProfile(currentCapabilities.profileId)) {
      const preferred = pickPreferredOrPriorityKind(currentCapabilities);
      const effectiveKind = preferred.kind;
      radioDispatch({ type: 'setSpectrumCapabilities', payload: currentCapabilities });
      radioDispatch({ type: 'setSelectedSpectrumKind', payload: effectiveKind });
      radioDispatch({ type: 'setSubscribedSpectrumKind', payload: isSpectrumSubscriptionPaused() ? null : effectiveKind });
      if (!isSpectrumSubscriptionPaused()) {
        radioService.subscribeSpectrum(effectiveKind);
      }
      // Preference already encodes the user's choice; skip priority upgrade after mode switch.
      if (preferred.usedPreference) {
        spectrumAutoPriorityPendingRef.current = false;
        return;
      }
    }

    // Auto-priority stays ON — the definitive selection happens when
    // fresh spectrumCapabilities arrive from the server after mode switch.
    spectrumAutoPriorityPendingRef.current = true;
  };

  const onSpectrumSessionStateChanged = (sessionState: SpectrumSessionState) => {
    const currentProfileId = capabilitiesRef.current?.profileId ?? null;
    if (!shouldAcceptSpectrumProfile(currentProfileId)) {
      return;
    }
    radioDispatch({ type: 'setSpectrumSessionState', payload: sessionState });

    const pendingProfileId = pendingDefaultOpenWebRXDetailProfileRef.current;
    const currentModeName = radioStateRef.current.currentMode?.name ?? null;
    const shouldAutoEnableDetail = pendingProfileId !== null
      && currentProfileId === pendingProfileId
      && sessionState.kind === 'openwebrx-sdr'
      && sessionState.sourceMode === 'full'
      && (currentModeName === 'FT8' || currentModeName === 'FT4');

    if (shouldAutoEnableDetail) {
      pendingDefaultOpenWebRXDetailProfileRef.current = null;
      radioService.invokeSpectrumControl('openwebrx-detail-toggle', 'toggle');
    }
  };

  const onSpectrumFrame = (frame: SpectrumFrame) => {
    if (frame.kind !== 'radio-sdr' || !spectrumAutoPriorityPendingRef.current || radioFramePromotionInFlight) {
      return;
    }
    if (!shouldAcceptSpectrumProfile(frame.meta.profileId)) {
      return;
    }

    const preferredKind = getPreferredSpectrumKind(
      capabilitiesRef.current?.profileId ?? activeProfileIdRef.current,
    );
    // A persisted non-radio preference is an explicit user choice. A radio
    // preference (or no preference) may still be promoted by a real frame.
    if (preferredKind && preferredKind !== 'radio-sdr') {
      spectrumAutoPriorityPendingRef.current = false;
      return;
    }

    const currentSelectedKind = radioStateRef.current.selectedSpectrumKind;
    if (currentSelectedKind === 'radio-sdr') {
      radioFramePromotionInFlight = false;
      spectrumAutoPriorityPendingRef.current = false;
      return;
    }

    const currentSelectedPriority = currentSelectedKind
      ? SPECTRUM_PRIORITY.indexOf(currentSelectedKind)
      : SPECTRUM_PRIORITY.length;
    if (currentSelectedPriority < SPECTRUM_PRIORITY.indexOf('radio-sdr')) {
      return;
    }

    radioFramePromotionInFlight = true;
    spectrumAutoPriorityPendingRef.current = capabilitiesRef.current
      ? shouldContinueAutoPriority(capabilitiesRef.current, 'radio-sdr')
      : false;
    radioDispatch({ type: 'setSelectedSpectrumKind', payload: 'radio-sdr' });
    radioDispatch({
      type: 'setSubscribedSpectrumKind',
      payload: isSpectrumSubscriptionPaused() ? null : 'radio-sdr',
    });
    if (!isSpectrumSubscriptionPaused()) {
      radioService.subscribeSpectrum('radio-sdr');
    }
    logger.info('Promoted spectrum selection after receiving a radio SDR frame');
  };

  return {
    applySpectrumSelection,
    applyProfileDrivenSpectrumNegotiation,
    applyModeDrivenSpectrumNegotiation,
    onSpectrumSessionStateChanged,
    onSpectrumFrame,
    shouldAcceptSpectrumProfile,
  };
}
