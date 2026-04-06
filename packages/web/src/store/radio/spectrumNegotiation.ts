import type React from 'react';
import type {
  SpectrumCapabilities,
  SpectrumKind,
  SpectrumSessionState,
} from '@tx5dr/contracts';
import type { RadioService } from '../../services/radioService';
import type { RadioAction, RadioState } from './types';
import type { createLogger } from '../../utils/logger';

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

  const isSpectrumKindAvailable = (capabilities: SpectrumCapabilities, kind: SpectrumKind | null): boolean => {
    if (!kind) {
      return false;
    }

    return capabilities.sources.some((source) => source.kind === kind && source.available);
  };

  const pickSpectrumKindByPriority = (capabilities: SpectrumCapabilities): SpectrumKind => {
    return SPECTRUM_PRIORITY.find((kind) => isSpectrumKindAvailable(capabilities, kind)) ?? 'audio';
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
    const effectiveKind = shouldAutoApplyPriority
      ? pickSpectrumKindByPriority(capabilities)
      : (
          isSpectrumKindAvailable(capabilities, currentSelectedKind)
            ? currentSelectedKind as SpectrumKind
            : pickSpectrumKindByPriority(capabilities)
        );
    const currentModeName = radioStateRef.current.currentMode?.name ?? null;
    const shouldAutoEnableOpenWebRXDetail = shouldAutoApplyPriority
      && effectiveKind === 'openwebrx-sdr'
      && profileId !== null
      && (currentModeName === 'FT8' || currentModeName === 'FT4');

    radioDispatch({ type: 'setSpectrumCapabilities', payload: capabilities });
    radioDispatch({ type: 'setSelectedSpectrumKind', payload: effectiveKind });
    radioDispatch({ type: 'setSubscribedSpectrumKind', payload: effectiveKind });
    radioService.subscribeSpectrum(effectiveKind);

    pendingDefaultOpenWebRXDetailProfileRef.current = shouldAutoEnableOpenWebRXDetail
      ? profileId
      : null;

    if (shouldAutoApplyPriority) {
      spectrumAutoPriorityPendingRef.current = shouldContinueAutoPriority(capabilities, effectiveKind);
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
    spectrumAutoPriorityPendingRef.current = true;
    pendingDefaultOpenWebRXDetailProfileRef.current = null;
    radioDispatch({ type: 'setSelectedSpectrumKind', payload: null });
    radioDispatch({ type: 'setSubscribedSpectrumKind', payload: null });

    const currentCapabilities = capabilitiesRef.current;
    if (currentCapabilities && shouldAcceptSpectrumProfile(currentCapabilities.profileId)) {
      applySpectrumSelection(currentCapabilities);
    }
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

  return {
    applySpectrumSelection,
    applyProfileDrivenSpectrumNegotiation,
    applyModeDrivenSpectrumNegotiation,
    onSpectrumSessionStateChanged,
    shouldAcceptSpectrumProfile,
  };
}
