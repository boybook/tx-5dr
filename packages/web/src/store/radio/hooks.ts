import { useCallback, useContext } from 'react';
import type {
  CapabilityDescriptor,
  CapabilityState,
  QSORecord,
  SpectrumKind,
} from '@tx5dr/contracts';
import {
  CapabilityDescriptorsContext,
  CapabilityStatesContext,
  ConnectionContext,
  LogbookContext,
  OperatorsContext,
  ProfilesContext,
  PTTContext,
  RadioConnectionContext,
  RadioErrorsContext,
  RadioModeContext,
  RadioStateContext,
  SlotPacksContext,
  StationInfoContext,
} from './contexts';

export const useRadio = () => {
  const connection = useContext(ConnectionContext);
  const radio = useContext(RadioStateContext);
  const slotPacks = useContext(SlotPacksContext);
  const logbook = useContext(LogbookContext);
  if (!connection || !radio || !slotPacks || !logbook) {
    throw new Error('useRadio must be used within a RadioProvider');
  }
  return {
    state: {
      connection: connection.state,
      radio: radio.state,
      slotPacks: slotPacks.state,
      logbook: logbook.state,
    },
    dispatch: {
      connectionDispatch: connection.dispatch,
      radioDispatch: radio.dispatch,
      slotPacksDispatch: slotPacks.dispatch,
      logbookDispatch: logbook.dispatch,
    },
  };
};

export const useConnection = () => {
  const context = useContext(ConnectionContext);
  if (!context) throw new Error('useConnection must be used within RadioProvider');
  return context;
};

export const useRadioState = () => {
  const context = useContext(RadioStateContext);
  if (!context) throw new Error('useRadioState must be used within RadioProvider');
  return context;
};

export const useSlotPacks = () => {
  const context = useContext(SlotPacksContext);
  if (!context) throw new Error('useSlotPacks must be used within RadioProvider');
  return context;
};

export const useOperators = () => {
  const context = useContext(OperatorsContext);
  if (!context) throw new Error('useOperators must be used within RadioProvider');
  return {
    operators: context.operators || [],
  };
};

export const useCurrentOperatorId = () => {
  const context = useContext(OperatorsContext);
  if (!context) throw new Error('useCurrentOperatorId must be used within RadioProvider');
  return {
    currentOperatorId: context.currentOperatorId || context.operators?.[0]?.id,
    setCurrentOperatorId: context.setCurrentOperatorId,
  };
};

export const useLogbook = () => {
  const context = useContext(LogbookContext);
  if (!context) throw new Error('useLogbook must be used within RadioProvider');
  return {
    state: context.state,
    dispatch: context.dispatch,
    getQSOsForOperator: (operatorId: string) => context.state.qsosByOperator.get(operatorId) || [],
    getStatisticsForLogbook: (logBookId: string) => context.state.statisticsByLogbook.get(logBookId),
    addQSORecord: (data: { operatorId: string; logBookId: string; qsoRecord: QSORecord }) => {
      context.dispatch({ type: 'qsoRecordAdded', payload: data });
    },
    updateQSORecord: (data: { operatorId: string; logBookId: string; qsoRecord: QSORecord }) => {
      context.dispatch({ type: 'qsoRecordUpdated', payload: data });
    },
    loadQSOs: (operatorId: string, qsos: QSORecord[]) => {
      context.dispatch({ type: 'loadQSOs', payload: { operatorId, qsos } });
    },
  };
};

export const useProfiles = () => {
  const context = useContext(ProfilesContext);
  if (!context) throw new Error('useProfiles must be used within RadioProvider');
  const activeProfile = context.profiles.find((p) => p.id === context.activeProfileId) ?? null;
  return {
    profiles: context.profiles,
    activeProfileId: context.activeProfileId,
    activeProfile,
    profilesLoaded: context.profilesLoaded,
  };
};

export const useStationInfo = () => {
  return useContext(StationInfoContext);
};

export const useRadioConnectionState = () => {
  const context = useContext(RadioConnectionContext);
  if (!context) throw new Error('useRadioConnectionState must be used within RadioProvider');
  return context;
};

export const useRadioModeState = () => {
  const context = useContext(RadioModeContext);
  if (!context) throw new Error('useRadioModeState must be used within RadioProvider');
  return context;
};

export const usePTTState = () => {
  const context = useContext(PTTContext);
  if (!context) throw new Error('usePTTState must be used within RadioProvider');
  return context;
};

export const useSpectrum = () => {
  const { state, dispatch, markSpectrumSelectionManual } = useRadioState();
  const setSelectedKind = useCallback((kind: SpectrumKind | null) => {
    markSpectrumSelectionManual?.();
    dispatch({ type: 'setSelectedSpectrumKind', payload: kind });
    dispatch({ type: 'setSubscribedSpectrumKind', payload: kind });
  }, [dispatch, markSpectrumSelectionManual]);

  return {
    capabilities: state.spectrumCapabilities,
    sessionState: state.spectrumSessionState,
    selectedKind: state.selectedSpectrumKind,
    subscribedKind: state.subscribedSpectrumKind,
    setSelectedKind,
  };
};

export const useRadioErrors = () => {
  const context = useContext(RadioErrorsContext);
  if (!context) throw new Error('useRadioErrors must be used within RadioProvider');
  return context;
};

export const useCapabilityState = (id: string): CapabilityState | undefined => {
  const context = useContext(CapabilityStatesContext);
  if (!context) throw new Error('useCapabilityState must be used within RadioProvider');
  return context.get(id);
};

export const useCapabilityDescriptor = (id: string): CapabilityDescriptor | undefined => {
  const context = useContext(CapabilityDescriptorsContext);
  if (!context) throw new Error('useCapabilityDescriptor must be used within RadioProvider');
  return context.get(id);
};

export const useCapabilityDescriptors = (): Map<string, CapabilityDescriptor> => {
  const context = useContext(CapabilityDescriptorsContext);
  if (!context) throw new Error('useCapabilityDescriptors must be used within RadioProvider');
  return context;
};

export const useCapabilityStates = (): Map<string, CapabilityState> => {
  const context = useContext(CapabilityStatesContext);
  if (!context) throw new Error('useCapabilityStates must be used within RadioProvider');
  return context;
};
