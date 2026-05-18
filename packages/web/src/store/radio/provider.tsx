import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import type { ReactNode } from 'react';
import type { SpectrumCapabilities, SlotPackFrequencyContext } from '@tx5dr/contracts';
import { api, getBandFromFrequency } from '@tx5dr/core';
import { createLogger } from '../../utils/logger';
import { getWebSocketClientInstanceId } from '../../utils/wsClientInstance';
import { type RadioService, getOrCreateRadioService } from '../../services/radioService';
import { useAuth } from '../authStore';
import {
  AudioSidecarContext,
  CapabilityDescriptorsContext,
  CapabilityStatesContext,
  ConnectionContext,
  LogbookContext,
  MyRelatedTimelineContext,
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
import { setSelectedOperatorId } from '../../utils/operatorPreferences';
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
import {
  buildMyRelatedTimelineGroups,
  initialMyRelatedTimelineState,
  myRelatedTimelineReducer,
  type MyRelatedTransmissionLog,
} from './myRelatedTimeline';
import { getRadioServiceBootstrapAction } from './bootstrap';
import { createSpectrumNegotiator } from './spectrumNegotiation';
import type { FrameDisplayMessage, FrameGroup } from '../../components/radio/digital/FramesTable';
import type { RadioState } from './types';

const logger = createLogger('RadioStore');
const MAX_VALID_DATE_MS = 8_640_000_000_000_000;

function isValidTimestampMs(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= 0
    && value <= MAX_VALID_DATE_MS;
}

function buildFrequencyContext(
  currentMode: string | null,
  currentRadioMode: string | null,
  currentRadioFrequency: number | null,
): SlotPackFrequencyContext | undefined {
  if (!currentRadioFrequency || currentRadioFrequency <= 0) {
    return undefined;
  }

  const band = getBandFromFrequency(currentRadioFrequency);
  return {
    frequency: currentRadioFrequency,
    ...(currentMode ? { mode: currentMode } : {}),
    ...(currentRadioMode ? { radioMode: currentRadioMode } : {}),
    ...(band && band !== 'Unknown' ? { band } : {}),
    description: `${(currentRadioFrequency / 1_000_000).toFixed(3)} MHz`,
  };
}

function buildHeaderContextKey(frequencyContext?: SlotPackFrequencyContext): string {
  return frequencyContext
    ? [
        frequencyContext.frequency ?? '',
        frequencyContext.band ?? '',
        frequencyContext.mode ?? '',
      ].join(':')
    : 'no-frequency';
}

function buildOperatorCallsignsById(radioState: RadioState): Record<string, string> {
  return Object.fromEntries(
    radioState.operators
      .map(operator => [operator.id, operator.context?.myCall?.trim() || ''])
      .filter(([, myCallsign]) => myCallsign.length > 0),
  );
}

function buildVisibleOperatorCallsigns(radioState: RadioState): string[] {
  return radioState.operators
    .map(operator => operator.context?.myCall?.trim() || '')
    .filter(callsign => callsign.length > 0);
}

function buildCurrentOperatorTargetCallsign(radioState: RadioState): string {
  if (!radioState.currentOperatorId) {
    return '';
  }

  const operator = radioState.operators.find(item => item.id === radioState.currentOperatorId);
  return operator?.context?.targetCall?.trim() || '';
}

function buildCurrentLiveSlotStartMs(radioState: RadioState): number | null {
  if (typeof radioState.currentSlotInfo?.startMs === 'number' && Number.isFinite(radioState.currentSlotInfo.startMs)) {
    return radioState.currentSlotInfo.startMs;
  }

  const slotMs = radioState.currentMode?.slotMs;
  if (typeof slotMs !== 'number' || !Number.isFinite(slotMs) || slotMs <= 0) {
    return null;
  }

  const now = Date.now();
  return Math.floor(now / slotMs) * slotMs;
}

export const RadioProvider = ({ children }: { children: ReactNode }) => {
  const [connectionState, connectionDispatch] = useReducer(connectionReducer, initialConnectionState);
  const [radioState, radioDispatch] = useReducer(radioReducer, initialRadioState);
  const [slotPacksState, slotPacksDispatch] = useReducer(slotPacksReducer, initialSlotPacksState);
  const [logbookState, logbookDispatch] = useReducer(logbookReducer, initialLogbookState);
  const [myRelatedTimelineState, myRelatedTimelineDispatch] = useReducer(
    myRelatedTimelineReducer,
    initialMyRelatedTimelineState,
  );

  const { state: authState } = useAuth();
  const canUseAdminRest = !authState.authEnabled || (Boolean(authState.jwt) && authState.role === 'admin');
  const authStateRef = useRef(authState);
  authStateRef.current = authState;
  const prevJwtRef = useRef<string | null>(authState.jwt);

  const radioServiceRef = useRef<RadioService | null>(null);
  const pendingDefaultOpenWebRXDetailProfileRef = useRef<string | null>(null);
  const capabilitiesRef = useRef<SpectrumCapabilities | null>(radioState.spectrumCapabilities);
  const radioStateRef = useRef(radioState);
  const activeProfileIdRef = useRef<string | null>(radioState.activeProfileId);
  const spectrumAutoPriorityPendingRef = useRef(true);
  const connectionStateRef = useRef(connectionState);
  const myRelatedTimelineStateRef = useRef(myRelatedTimelineState);
  const previousSlotSyncingRef = useRef(slotPacksState.isSyncing);

  useEffect(() => {
    connectionStateRef.current = connectionState;
  }, [connectionState]);

  useEffect(() => {
    capabilitiesRef.current = radioState.spectrumCapabilities;
    radioStateRef.current = radioState;
    activeProfileIdRef.current = radioState.activeProfileId;
  }, [radioState]);

  useEffect(() => {
    myRelatedTimelineStateRef.current = myRelatedTimelineState;
  }, [myRelatedTimelineState]);

  useEffect(() => {
    if (radioServiceRef.current) {
      return;
    }

    const clientInstanceId = getWebSocketClientInstanceId();
    const radioService = getOrCreateRadioService();
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

    const unsubscribeProviderEvents = radioService.replaceProviderEventHandlers(eventMap);

    connectionDispatch({ type: 'SET_RADIO_SERVICE', payload: radioService });

    const initialConnectTimer = setTimeout(() => {
      if (!connectionStateRef.current.wasEverConnected) {
        logger.warn('Initial connection timeout after 10s, WSClient background reconnect continues');
        connectionDispatch({ type: 'connectFailed' });
      }
    }, 10000);

    const bootstrapAction = getRadioServiceBootstrapAction(radioService.getConnectionStatus());
    logger.info('Bootstrapping WebSocket connection', { action: bootstrapAction });
    const bootstrapPromise = bootstrapAction === 'forceReconnect'
      ? radioService.forceReconnect()
      : radioService.connect();
    void bootstrapPromise.catch((err) => {
      logger.warn('WebSocket bootstrap failed, WSClient background reconnect continues', err);
    });

    return () => {
      clearTimeout(initialConnectTimer);

      unsubscribeProviderEvents();

      // Don't disconnect the singleton — it will be reused by the next mount
      // (auth key changes / React Strict Mode). The connection stays alive across re-mounts.
      radioServiceRef.current = null;
    };
  }, []);

  // 认证状态变化（登入/登出/切换账户）时强制重建 WS 连接。
  // 由于 WSClient 是单例、主 effect 的依赖数组为 []，这里必须独立监听 jwt 变化。
  // forceReconnect 会走完整握手：新连接 → AUTH_REQUIRED → sendAuthToken → 新的权限过滤。
  useEffect(() => {
    const prev = prevJwtRef.current;
    const next = authState.jwt;
    prevJwtRef.current = next;
    if (prev === next) return;
    const svc = radioServiceRef.current;
    if (!svc) return;
    logger.info('Auth jwt changed, forcing WebSocket reconnect');
    void svc.forceReconnect().catch((err) => {
      logger.warn('forceReconnect after auth change failed', err);
    });
  }, [authState.jwt]);

  useEffect(() => {
    if (!connectionState.isConnected) return;
    if (!canUseAdminRest) return;
    let cancelled = false;
    api.getBootstrapStatus()
      .then((status) => {
        if (!cancelled) {
          radioDispatch({ type: 'bootstrapStatusChanged', payload: status });
        }
      })
      .catch((err) => {
        logger.debug('Failed to fetch bootstrap status snapshot', err);
      });
    return () => {
      cancelled = true;
    };
  }, [canUseAdminRest, connectionState.isConnected]);

  const markSpectrumSelectionManual = useCallback(() => {
    spectrumAutoPriorityPendingRef.current = false;
    pendingDefaultOpenWebRXDetailProfileRef.current = null;
  }, []);

  const setCurrentOperatorId = useCallback((operatorId: string) => {
    setSelectedOperatorId(operatorId);
    radioDispatch({ type: 'setCurrentOperator', payload: operatorId });
    radioServiceRef.current?.setClientSelectedOperator(operatorId);
  }, []);

  const clearRadioErrors = useCallback(() => {
    radioDispatch({ type: 'clearRadioErrors' });
  }, []);

  const clearMyRelatedTimeline = useCallback(() => {
    myRelatedTimelineDispatch({ type: 'clearTimeline' });
  }, []);

  const seedSelectedRx = useCallback((payload: {
    message: FrameDisplayMessage;
    group: FrameGroup;
  }) => {
    const currentMode = radioStateRef.current.currentMode;
    if (!currentMode) {
      return;
    }

    const frequencyContext = payload.group.frequencyContext ?? buildFrequencyContext(
      radioStateRef.current.currentMode?.name ?? null,
      radioStateRef.current.currentRadioMode,
      radioStateRef.current.currentRadioFrequency,
    );

    myRelatedTimelineDispatch({
      type: 'seedSelectedRx',
      payload: {
        currentMode,
        message: payload.message,
        slotStartMs: payload.group.startMs,
        liveSlotStartMs: buildCurrentLiveSlotStartMs(radioStateRef.current),
        frequencyContext,
      },
    });
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
    () => ({
      pttStatus: radioState.pttStatus,
      tuneToneStatus: radioState.tuneToneStatus,
      voicePttLock: radioState.voicePttLock,
    }),
    [radioState.pttStatus, radioState.tuneToneStatus, radioState.voicePttLock],
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

  const myRelatedTimelineGroups = useMemo(
    () => buildMyRelatedTimelineGroups(myRelatedTimelineState),
    [myRelatedTimelineState],
  );

  const myRelatedTimelineContextValue = useMemo(
    () => ({
      groups: myRelatedTimelineGroups,
      clearTimeline: clearMyRelatedTimeline,
      seedSelectedRx,
    }),
    [myRelatedTimelineGroups, clearMyRelatedTimeline, seedSelectedRx],
  );

  useEffect(() => {
    const radioService = connectionState.radioService;
    if (!radioService) {
      return;
    }

    const wsClient = radioService.wsClientInstance;
    const handleTransmissionLog = (data: MyRelatedTransmissionLog) => {
      if (!isValidTimestampMs(data?.slotStartMs)) {
        logger.warn('Ignoring invalid transmissionLog payload', {
          operatorId: data?.operatorId,
          message: data?.message,
          slotStartMs: data?.slotStartMs,
        });
        return;
      }

      const currentMode = radioStateRef.current.currentMode;
      if (!currentMode) {
        return;
      }

      const frequencyContext = data.frequencyContext ?? buildFrequencyContext(
        radioStateRef.current.currentMode?.name ?? null,
        radioStateRef.current.currentRadioMode,
        radioStateRef.current.currentRadioFrequency,
      );

      myRelatedTimelineDispatch({
        type: 'ingestTransmissionLog',
        payload: {
          log: {
            ...data,
            myCallsign: radioStateRef.current.operators.find(operator => operator.id === data.operatorId)?.context?.myCall?.trim() || undefined,
            headerContextKey: buildHeaderContextKey(frequencyContext),
            frequencyContext,
          },
          currentMode,
          liveSlotStartMs: buildCurrentLiveSlotStartMs(radioStateRef.current),
        },
      });
    };

    wsClient.onWSEvent('transmissionLog', handleTransmissionLog);

    return () => {
      wsClient.offWSEvent('transmissionLog', handleTransmissionLog);
    };
  }, [connectionState.radioService]);

  useEffect(() => {
    const previousSyncing = previousSlotSyncingRef.current;
    const currentSyncing = slotPacksState.isSyncing;
    previousSlotSyncingRef.current = currentSyncing;

    if (!previousSyncing && currentSyncing) {
      myRelatedTimelineDispatch({ type: 'beginRestore' });
      return;
    }

    if (previousSyncing && !currentSyncing) {
      const currentMode = radioState.currentMode;
      if (!currentMode) {
        return;
      }

      myRelatedTimelineDispatch({
        type: 'finalizeRestore',
        payload: {
          slotPacks: slotPacksState.slotPacks,
          currentMode,
          liveSlotStartMs: buildCurrentLiveSlotStartMs(radioState),
          visibleOperatorCallsigns: buildVisibleOperatorCallsigns(radioState),
          targetCallsign: buildCurrentOperatorTargetCallsign(radioState),
          operatorCallsignsById: buildOperatorCallsignsById(radioState),
        },
      });
    }
  }, [slotPacksState.isSyncing, slotPacksState.slotPacks, radioState]);

  useEffect(() => {
    if (slotPacksState.isSyncing || !radioState.currentMode) {
      return;
    }

    for (const slotPack of slotPacksState.slotPacks) {
      const processedSeq = myRelatedTimelineStateRef.current.lastProcessedSlotPackSeq.get(slotPack.slotId) ?? -1;
      const incomingSeq = slotPack.stats?.updateSeq ?? 0;
      if (incomingSeq <= processedSeq) {
        continue;
      }

      myRelatedTimelineDispatch({
        type: 'ingestSlotPack',
        payload: {
          slotPack,
          currentMode: radioState.currentMode,
          liveSlotStartMs: buildCurrentLiveSlotStartMs(radioStateRef.current),
          visibleOperatorCallsigns: buildVisibleOperatorCallsigns(radioStateRef.current),
          targetCallsign: buildCurrentOperatorTargetCallsign(radioStateRef.current),
        },
      });
    }
  }, [slotPacksState.slotPacks, slotPacksState.isSyncing, radioState.currentMode]);

  useEffect(() => {
    if (!radioState.currentMode) {
      return;
    }

    myRelatedTimelineDispatch({
      type: 'syncLiveContext',
      payload: {
        currentMode: radioState.currentMode,
        liveSlotStartMs: buildCurrentLiveSlotStartMs(radioState),
        visibleOperatorCallsigns: buildVisibleOperatorCallsigns(radioState),
        targetCallsign: buildCurrentOperatorTargetCallsign(radioState),
      },
    });
  }, [
    radioState.currentMode,
    radioState.currentSlotInfo?.startMs,
    radioState.currentOperatorId,
    radioState.operators,
  ]);

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
                              <MyRelatedTimelineContext.Provider value={myRelatedTimelineContextValue}>
                                <AudioSidecarContext.Provider value={radioState.audioSidecar}>
                                  {children}
                                </AudioSidecarContext.Provider>
                              </MyRelatedTimelineContext.Provider>
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
