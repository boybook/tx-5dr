import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import type { ReactNode } from 'react';
import type { SpectrumCapabilities } from '@tx5dr/contracts';
import { createLogger } from '../../utils/logger';
import { getWebSocketClientInstanceId } from '../../utils/wsClientInstance';
import { RadioService } from '../../services/radioService';
import { useAuth } from '../authStore';
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
import { createRadioEventMap } from './createEventMap';
import {
  connectionReducer,
  initialConnectionState,
  initialLogbookState,
  initialRadioState,
  initialSlotPacksState,
  logbookReducer,
  radioReducer,
  slotPacksReducer,
} from './reducers';
import { createSpectrumNegotiator } from './spectrumNegotiation';

const logger = createLogger('RadioStore');

export const RadioProvider = ({ children }: { children: ReactNode }) => {
  const [connectionState, connectionDispatch] = useReducer(connectionReducer, initialConnectionState);
  const [radioState, radioDispatch] = useReducer(radioReducer, initialRadioState);
  const [slotPacksState, slotPacksDispatch] = useReducer(slotPacksReducer, initialSlotPacksState);
  const [logbookState, logbookDispatch] = useReducer(logbookReducer, initialLogbookState);

  const { state: authState } = useAuth();
  const authStateRef = useRef(authState);
  authStateRef.current = authState;

  const radioServiceRef = useRef<RadioService | null>(null);
  const pendingDefaultOpenWebRXDetailProfileRef = useRef<string | null>(null);
  const capabilitiesRef = useRef<SpectrumCapabilities | null>(radioState.spectrumCapabilities);
  const radioStateRef = useRef(radioState);
  const activeProfileIdRef = useRef<string | null>(radioState.activeProfileId);
  const spectrumAutoPriorityPendingRef = useRef(true);
  const connectionStateRef = useRef(connectionState);

  useEffect(() => {
    connectionStateRef.current = connectionState;
  }, [connectionState]);

  useEffect(() => {
    capabilitiesRef.current = radioState.spectrumCapabilities;
    radioStateRef.current = radioState;
    activeProfileIdRef.current = radioState.activeProfileId;
  }, [radioState]);

  useEffect(() => {
    if (radioServiceRef.current) {
      return;
    }

    const clientInstanceId = getWebSocketClientInstanceId();
    const radioService = new RadioService();
    radioServiceRef.current = radioService;

    const spectrumNegotiation = createSpectrumNegotiator({
      radioDispatch,
      radioService,
      capabilitiesRef,
      radioStateRef,
      activeProfileIdRef,
      spectrumAutoPriorityPendingRef,
      pendingDefaultOpenWebRXDetailProfileRef,
      logger,
    });

    const eventMap = createRadioEventMap({
      connectionDispatch,
      radioDispatch,
      slotPacksDispatch,
      logbookDispatch,
      authStateRef,
      radioService,
      radioServiceRef,
      clientInstanceId,
      radioStateRef,
      capabilitiesRef,
      activeProfileIdRef,
      spectrumNegotiation,
      logger,
    });

    const wsClient = radioService.wsClientInstance;
    Object.entries(eventMap).forEach(([event, handler]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wsClient.onWSEvent(event as any, handler as any);
    });

    connectionDispatch({ type: 'SET_RADIO_SERVICE', payload: radioService });

    const initialConnectTimer = setTimeout(() => {
      if (!connectionStateRef.current.wasEverConnected) {
        logger.warn('Initial connection timeout after 10s, WSClient background reconnect continues');
        connectionDispatch({ type: 'connectFailed' });
      }
    }, 10000);

    return () => {
      clearTimeout(initialConnectTimer);

      if (radioServiceRef.current) {
        const currentWsClient = radioServiceRef.current.wsClientInstance;
        Object.entries(eventMap).forEach(([event, handler]) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          currentWsClient.offWSEvent(event as any, handler as any);
        });
      }

      if (radioServiceRef.current) {
        radioServiceRef.current.disconnect();
        radioServiceRef.current = null;
      }
    };
  }, []);

  const markSpectrumSelectionManual = useCallback(() => {
    spectrumAutoPriorityPendingRef.current = false;
    pendingDefaultOpenWebRXDetailProfileRef.current = null;
  }, []);

  const setCurrentOperatorId = useCallback((operatorId: string) => {
    radioDispatch({ type: 'setCurrentOperator', payload: operatorId });
  }, []);

  const clearRadioErrors = useCallback(() => {
    radioDispatch({ type: 'clearRadioErrors' });
  }, []);

  const connectionContextValue = useMemo(
    () => ({ state: connectionState, dispatch: connectionDispatch }),
    [connectionState],
  );

  const radioStateContextValue = useMemo(
    () => ({ state: radioState, dispatch: radioDispatch, markSpectrumSelectionManual }),
    [radioState, markSpectrumSelectionManual],
  );

  const slotPacksContextValue = useMemo(
    () => ({ state: slotPacksState, dispatch: slotPacksDispatch }),
    [slotPacksState],
  );

  const logbookContextValue = useMemo(
    () => ({ state: logbookState, dispatch: logbookDispatch }),
    [logbookState],
  );

  const operatorsContextValue = useMemo(
    () => ({
      operators: radioState.operators,
      currentOperatorId: radioState.currentOperatorId,
      setCurrentOperatorId,
    }),
    [radioState.operators, radioState.currentOperatorId, setCurrentOperatorId],
  );

  const profilesContextValue = useMemo(
    () => ({
      profiles: radioState.profiles,
      activeProfileId: radioState.activeProfileId,
      profilesLoaded: radioState.profilesLoaded,
    }),
    [radioState.profiles, radioState.activeProfileId, radioState.profilesLoaded],
  );

  const radioConnectionContextValue = useMemo(
    () => ({
      radioConnected: radioState.radioConnected,
      radioConnectionStatus: radioState.radioConnectionStatus,
      radioInfo: radioState.radioInfo,
      radioConfig: radioState.radioConfig,
      reconnectProgress: radioState.reconnectProgress,
      radioConnectionHealth: radioState.radioConnectionHealth,
      coreCapabilities: radioState.coreCapabilities,
      coreCapabilityDiagnostics: radioState.coreCapabilityDiagnostics,
    }),
    [
      radioState.radioConnected,
      radioState.radioConnectionStatus,
      radioState.radioInfo,
      radioState.radioConfig,
      radioState.reconnectProgress,
      radioState.radioConnectionHealth,
      radioState.coreCapabilities,
      radioState.coreCapabilityDiagnostics,
    ],
  );

  const radioModeContextValue = useMemo(
    () => ({
      isDecoding: radioState.isDecoding,
      currentMode: radioState.currentMode,
      engineMode: radioState.engineMode,
      currentRadioMode: radioState.currentRadioMode,
      currentRadioFrequency: radioState.currentRadioFrequency,
      spectrumSessionState: radioState.spectrumSessionState,
    }),
    [
      radioState.isDecoding,
      radioState.currentMode,
      radioState.engineMode,
      radioState.currentRadioMode,
      radioState.currentRadioFrequency,
      radioState.spectrumSessionState,
    ],
  );

  const pttContextValue = useMemo(
    () => ({ pttStatus: radioState.pttStatus, voicePttLock: radioState.voicePttLock }),
    [radioState.pttStatus, radioState.voicePttLock],
  );

  const radioErrorsContextValue = useMemo(
    () => ({
      errors: radioState.radioErrors,
      latestError: radioState.latestRadioError,
      clearErrors: clearRadioErrors,
    }),
    [radioState.radioErrors, radioState.latestRadioError, clearRadioErrors],
  );

  const capabilityDescriptorsContextValue = useMemo(
    () => radioState.capabilityDescriptors,
    [radioState.capabilityDescriptors],
  );

  const capabilityStatesContextValue = useMemo(
    () => radioState.capabilityStates,
    [radioState.capabilityStates],
  );

  return (
    <ConnectionContext.Provider value={connectionContextValue}>
      <RadioStateContext.Provider value={radioStateContextValue}>
        <SlotPacksContext.Provider value={slotPacksContextValue}>
          <LogbookContext.Provider value={logbookContextValue}>
            <OperatorsContext.Provider value={operatorsContextValue}>
              <ProfilesContext.Provider value={profilesContextValue}>
                <RadioConnectionContext.Provider value={radioConnectionContextValue}>
                  <RadioModeContext.Provider value={radioModeContextValue}>
                    <PTTContext.Provider value={pttContextValue}>
                      <StationInfoContext.Provider value={radioState.stationInfo}>
                        <RadioErrorsContext.Provider value={radioErrorsContextValue}>
                          <CapabilityDescriptorsContext.Provider value={capabilityDescriptorsContextValue}>
                            <CapabilityStatesContext.Provider value={capabilityStatesContextValue}>
                              {children}
                            </CapabilityStatesContext.Provider>
                          </CapabilityDescriptorsContext.Provider>
                        </RadioErrorsContext.Provider>
                      </StationInfoContext.Provider>
                    </PTTContext.Provider>
                  </RadioModeContext.Provider>
                </RadioConnectionContext.Provider>
              </ProfilesContext.Provider>
            </OperatorsContext.Provider>
          </LogbookContext.Provider>
        </SlotPacksContext.Provider>
      </RadioStateContext.Provider>
    </ConnectionContext.Provider>
  );
};
