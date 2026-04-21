import type React from 'react';
import { addToast } from '@heroui/toast';
import type {
  CoreCapabilityDiagnostics,
  CoreRadioCapabilities,

  LogBookStatistics,
  MeterCapabilities,
  MeterData,
  ModeDescriptor,
  OperatorStatus,
  ProfileChangedEvent,
  QSORecord,
  RadioErrorEventData,
  RadioProfile,
  SlotPack,
  SpectrumCapabilities,
  SpectrumFrame,
  SpectrumSessionState,
  SystemStatus,
  TunerCapabilities,
  VoicePTTLock,
  CapabilityList,
  CapabilityState,
  HamlibConfig,
  RadioInfo,
  ReconnectProgress,
  ClockStatusSummary,
  AudioSidecarStatusPayload,
} from '@tx5dr/contracts';
import { RadioConnectionStatus, UserRole } from '@tx5dr/contracts';
import type { RadioService } from '../../services/radioService';
import { getHandshakeOperatorIds, getHiddenOperatorIds } from '../../utils/operatorPreferences';
import {
  showErrorToast,
  createRetryAction,
  createRefreshStatusAction,
  isRetryableError,
} from '../../utils/errorToast';
import i18n from '../../i18n/index';
import type { AuthState } from '../authStore';
import type {
  ConnectionAction,
  ConnectionHealthInfo,
  DecodeErrorData,
  ErrorEventData,
  LogbookAction,
  RadioAction,
  RadioErrorRecord,
  RadioState,
  SlotPacksAction,
} from './types';

interface SpectrumNegotiationBridge {
  applySpectrumSelection: (capabilities: SpectrumCapabilities) => void;
  applyProfileDrivenSpectrumNegotiation: (profileId: string | null, clearSpectrumState: boolean) => void;
  applyModeDrivenSpectrumNegotiation: () => void;
  onSpectrumSessionStateChanged: (sessionState: SpectrumSessionState) => void;
  shouldAcceptSpectrumProfile: (profileId: string | null | undefined) => boolean;
}

interface CreateRadioEventMapDeps {
  connectionDispatch: React.Dispatch<ConnectionAction>;
  radioDispatch: React.Dispatch<RadioAction>;
  slotPacksDispatch: React.Dispatch<SlotPacksAction>;
  logbookDispatch: React.Dispatch<LogbookAction>;
  authStateRef: React.MutableRefObject<AuthState>;
  radioService: RadioService;
  radioServiceRef: React.MutableRefObject<RadioService | null>;
  clientInstanceId: string;
  radioStateRef: React.MutableRefObject<RadioState>;
  capabilitiesRef: React.MutableRefObject<SpectrumCapabilities | null>;
  activeProfileIdRef: React.MutableRefObject<string | null>;
  spectrumNegotiation: SpectrumNegotiationBridge;
  logger: {
    debug: (message: string, ...args: unknown[]) => void;
    info: (message: string, ...args: unknown[]) => void;
    warn: (message: string, ...args: unknown[]) => void;
    error: (message: string, ...args: unknown[]) => void;
  };
}

export function createRadioEventMap({
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
}: CreateRadioEventMapDeps): Record<string, (data?: unknown) => void> {
  const refreshRealtimeState = () => {
    radioService.getSystemStatus();

    const subscribedKind = radioStateRef.current.subscribedSpectrumKind;
    if (subscribedKind) {
      radioService.subscribeSpectrum(subscribedKind);
    }
  };

  return {
    connected: () => {
      connectionDispatch({ type: 'connected' });
      if (!authStateRef.current.authEnabled) {
        const handshakeOperatorIds = getHandshakeOperatorIds();
        logger.info('Auth disabled, sending handshake directly:', {
          enabledOperatorIds: handshakeOperatorIds,
          clientInstanceId,
        });
        radioService.sendHandshake(handshakeOperatorIds, clientInstanceId);
      }
      refreshRealtimeState();
    },
    reconnecting: (data: unknown) => {
      const reconnectData = data as { attempt: number; delayMs: number };
      logger.info('WebSocket reconnecting', reconnectData);
      connectionDispatch({ type: 'reconnecting' });
    },
    authRequired: (data: unknown) => {
      const authData = data as { allowPublicViewing: boolean };
      logger.info('Received AUTH_REQUIRED:', authData);
      const wsClient = radioService.wsClientInstance;
      const jwt = authStateRef.current.jwt;
      if (jwt) {
        logger.info('Sending JWT for authentication');
        wsClient.sendAuthToken(jwt);
      } else if (authData.allowPublicViewing) {
        logger.info('Joining as public viewer');
        wsClient.sendAuthPublicViewer();
      } else {
        logger.warn('Auth required but no JWT available');
      }
    },
    authResult: (data: unknown) => {
      const result = data as { success: boolean; role?: UserRole; label?: string; operatorIds?: string[]; error?: string };
      if (result.success) {
        logger.info('Auth succeeded, role:', result.role);
        const handshakeOperatorIds = getHandshakeOperatorIds();
        radioService.sendHandshake(handshakeOperatorIds, clientInstanceId);
        refreshRealtimeState();
      } else {
        const errorCode = result.error;
        const localizedError = errorCode
          ? i18n.t(`auth:errors.${errorCode}`, { defaultValue: errorCode })
          : i18n.t('auth:login.failed');
        logger.error('Auth failed', { errorCode, localizedError });
      }
    },
    authExpired: (data: unknown) => {
      const expData = data as { reason?: string };
      logger.warn('JWT expired:', expData.reason);
      addToast({
        title: i18n.t('auth:expired.title'),
        description: i18n.t('auth:expired.description'),
        color: 'warning',
        timeout: 5000,
      });
    },
    disconnected: () => {
      connectionDispatch({ type: 'disconnected' });
    },
    modeChanged: (data: unknown) => {
      const nextMode = data as ModeDescriptor;
      const previousModeName = radioStateRef.current.currentMode?.name ?? null;
      radioDispatch({ type: 'modeChanged', payload: nextMode });
      if (nextMode.name !== previousModeName) {
        spectrumNegotiation.applyModeDrivenSpectrumNegotiation();
      }
    },
    systemStatus: (data: unknown) => {
      const status = data as SystemStatus;
      radioDispatch({ type: 'systemStatus', payload: status });
    },
    clockStatusChanged: (data: unknown) => {
      radioDispatch({ type: 'clockStatusChanged', payload: data as ClockStatusSummary });
    },
    spectrumCapabilities: (data: unknown) => {
      spectrumNegotiation.applySpectrumSelection(data as SpectrumCapabilities);
    },
    spectrumFrame: (data: unknown) => {
      const profileId = (data as SpectrumFrame).meta.profileId;
      if (!spectrumNegotiation.shouldAcceptSpectrumProfile(profileId)) {
        return;
      }
    },
    spectrumSessionStateChanged: (data: unknown) => {
      spectrumNegotiation.onSpectrumSessionStateChanged(data as SpectrumSessionState);
    },
    decodeError: (data: unknown) => {
      radioDispatch({ type: 'decodeError', payload: data as DecodeErrorData });
    },
    error: (data: unknown) => {
      const errorData = data as ErrorEventData;
      const {
        message,
        userMessage,
        userMessageKey,
        userMessageParams,
        suggestions = [],
        severity = 'error',
        code,
        timestamp: _timestamp,
        context,
      } = errorData;
      // 优先使用后端提供的 i18n 翻译键本地化 userMessage
      const localizedUserMessage =
        userMessageKey && i18n.exists(userMessageKey)
          ? i18n.t(userMessageKey, userMessageParams ?? {})
          : (userMessage ?? message);

      let action: { label: string; handler: () => void } | undefined;

      if (code === 'CONNECTION_FAILED' || code === 'RADIO_CONNECTION_FAILED' || code === 'CONNECTION_TIMEOUT') {
        action = createRetryAction(() => {
          logger.debug('User clicked retry start');
          if (radioServiceRef.current) {
            radioServiceRef.current.startDecoding();
          }
        });
      } else if (code === 'ENGINE_START_FAILED') {
        action = createRetryAction(() => {
          logger.debug('User clicked retry start engine');
          if (radioServiceRef.current) {
            radioServiceRef.current.startDecoding();
          }
        });
      } else if (code === 'DEVICE_NOT_FOUND' || code === 'INVALID_CONFIG') {
        action = {
          label: i18n.t('common:action.openSettings'),
          handler: () => {
            window.dispatchEvent(new CustomEvent('openProfileModal'));
          },
        };
      } else if (code === 'TIMEOUT') {
        action = createRetryAction(() => {
          logger.debug('User clicked retry operation');
          addToast({
            title: i18n.t('toast:severity.info'),
            description: i18n.t('toast:hint.retryManually'),
            color: 'primary',
            timeout: 3000,
          });
        });
      } else if (code === 'STATE_CONFLICT') {
        action = createRefreshStatusAction(() => {
          logger.debug('User clicked refresh status');
          if (radioServiceRef.current) {
            radioServiceRef.current.getSystemStatus();
          }
        });
      } else if (code === 'RESOURCE_BUSY') {
        action = createRetryAction(() => {
          logger.debug('User clicked retry (resource busy)');
          addToast({
            title: i18n.t('toast:severity.info'),
            description: i18n.t('toast:hint.tryLater'),
            color: 'primary',
            timeout: 2000,
          });
        });
      } else if (isRetryableError(code)) {
        action = createRetryAction(() => {
          logger.debug(`User clicked retry (error code: ${code})`);
          addToast({
            title: i18n.t('toast:severity.info'),
            description: i18n.t('toast:hint.retryManually'),
            color: 'primary',
            timeout: 3000,
          });
        });
      }

      showErrorToast({
        userMessage: localizedUserMessage || message || i18n.t('errors:code.UNKNOWN_ERROR.userMessage'),
        suggestions,
        severity,
        code,
        technicalDetails: message,
        context,
        action,
      });

      radioDispatch({
        type: 'error',
        payload: new Error(message || i18n.t('errors:code.UNKNOWN_ERROR.userMessage')),
      });
    },
    slotPackUpdated: (data: unknown) => {
      slotPacksDispatch({ type: 'slotPackUpdated', payload: data as SlotPack });
    },
    qsoRecordAdded: (data: unknown) => {
      const qsoData = data as { operatorId: string; logBookId: string; qsoRecord: QSORecord };
      logger.debug('QSO record added:', qsoData);
      logbookDispatch({ type: 'qsoRecordAdded', payload: qsoData });
    },
    qsoRecordUpdated: (data: unknown) => {
      const qsoData = data as { operatorId: string; logBookId: string; qsoRecord: QSORecord };
      logger.debug('QSO record updated:', qsoData);
      logbookDispatch({ type: 'qsoRecordUpdated', payload: qsoData });
    },
    logbookUpdated: (data: unknown) => {
      const logbookData = data as { logBookId: string; statistics: LogBookStatistics; operatorId?: string };
      logger.debug('Logbook updated:', logbookData);
      logbookDispatch({ type: 'logbookUpdated', payload: logbookData });
    },
    operatorsList: (data: unknown) => {
      const operatorsData = data as { operators: OperatorStatus[] };
      radioDispatch({ type: 'operatorsList', payload: operatorsData.operators });

      const hiddenIds = getHiddenOperatorIds();
      if (hiddenIds.length > 0) {
        const allIds = operatorsData.operators.map((op) => op.id);
        const hiddenSet = new Set(hiddenIds);
        // Only sync if the received list actually contains operators that should be hidden.
        // This prevents infinite loops: server responds to setClientEnabledOperators with
        // a filtered operatorsList, and if no hidden operators remain, we stop re-sending.
        if (allIds.some((id) => hiddenSet.has(id))) {
          const enabledIds = allIds.filter((id) => !hiddenSet.has(id));
          logger.debug('Syncing enabled operators after receiving list:', enabledIds);
          radioService.setClientEnabledOperators(enabledIds);
        }
      }
    },
    operatorStatusUpdate: (() => {
      const pending = new Map<string, OperatorStatus>();
      let timer: ReturnType<typeof setTimeout> | null = null;
      return (data: unknown) => {
        const status = data as OperatorStatus;
        pending.set(status.id, status);
        if (!timer) {
          timer = setTimeout(() => {
            for (const s of pending.values()) {
              radioDispatch({ type: 'operatorStatusUpdate', payload: s });
            }
            pending.clear();
            timer = null;
          }, 200);
        }
      };
    })(),
    frequencyChanged: (data: unknown) => {
      const freqData = data as { frequency?: number; radioMode?: string };
      radioDispatch({
        type: 'setCurrentRadioFrequency',
        payload: typeof freqData.frequency === 'number' && freqData.frequency > 0 ? freqData.frequency : null,
      });
      if (typeof freqData.radioMode === 'string' && freqData.radioMode.trim()) {
        radioDispatch({ type: 'voiceRadioModeChanged', payload: freqData.radioMode });
      }
      logger.debug('Frequency changed, clearing local slot history', { frequency: freqData.frequency });
      slotPacksDispatch({ type: 'CLEAR_DATA' });
    },
    pttStatusChanged: (data: unknown) => {
      const pttData = data as { isTransmitting: boolean; operatorIds: string[] };
      logger.debug(`PTT status changed: ${pttData.isTransmitting ? 'transmitting' : 'idle'}, operators=[${pttData.operatorIds?.join(', ') || ''}]`);
      radioDispatch({ type: 'pttStatusChanged', payload: pttData });
    },
    meterData: (() => {
      let lastDispatchTime = 0;
      let pendingData: MeterData | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      return (data: unknown) => {
        const now = Date.now();
        pendingData = data as MeterData;
        if (now - lastDispatchTime >= 100) {
          lastDispatchTime = now;
          radioDispatch({ type: 'meterData', payload: pendingData });
          pendingData = null;
        } else if (!timer) {
          timer = setTimeout(() => {
            if (pendingData) {
              lastDispatchTime = Date.now();
              radioDispatch({ type: 'meterData', payload: pendingData });
              pendingData = null;
            }
            timer = null;
          }, 100 - (now - lastDispatchTime));
        }
      };
    })(),
    handshakeComplete: async () => {
      logger.info('Handshake complete');
      logger.info('Handshake complete, requesting profile list');
      try {
        const { api } = await import('@tx5dr/core');
        const profilesResponse = await api.getProfiles();
        logger.info('Profile list synced', { count: profilesResponse.profiles.length });
        radioDispatch({
          type: 'setProfiles',
          payload: {
            profiles: profilesResponse.profiles,
            activeProfileId: profilesResponse.activeProfileId,
          },
        });
        spectrumNegotiation.applyProfileDrivenSpectrumNegotiation(
          profilesResponse.activeProfileId,
          capabilitiesRef.current?.profileId !== profilesResponse.activeProfileId,
        );
      } catch (error) {
        logger.error('Failed to fetch profile list:', error);
        radioDispatch({
          type: 'setProfiles',
          payload: { profiles: [], activeProfileId: null },
        });
        spectrumNegotiation.applyProfileDrivenSpectrumNegotiation(null, false);
      }

      try {
        const { api: stationApi } = await import('@tx5dr/core');
        const stationInfoResp = await stationApi.getStationInfo();
        radioDispatch({ type: 'setStationInfo', payload: stationInfoResp.data });
        logger.info('Station info loaded', { callsign: stationInfoResp.data.callsign ?? '(empty)' });
      } catch (error) {
        logger.warn('Failed to fetch station info', error);
      }
    },
    radioStatusChanged: (data: unknown) => {
      const radioData = data as {
        connected: boolean;
        status: RadioConnectionStatus;
        radioInfo: RadioInfo | null;
        radioConfig?: HamlibConfig;
        connectionHealth?: ConnectionHealthInfo;
        reconnectProgress?: ReconnectProgress | null;
        coreCapabilities?: CoreRadioCapabilities;
        coreCapabilityDiagnostics?: CoreCapabilityDiagnostics;
        meterCapabilities?: MeterCapabilities;
        tunerCapabilities?: TunerCapabilities;
        reason?: string;
        message?: string;
      };
      logger.debug('Radio status changed', { status: radioData.status || (radioData.connected ? 'connected' : 'disconnected'), reason: radioData.reason });

      radioDispatch({
        type: 'radioStatusUpdate',
        payload: {
          radioConnected: radioData.connected,
          status: radioData.status,
          radioInfo: radioData.radioInfo,
          radioConfig: radioData.radioConfig,
          radioConnectionHealth: radioData.connectionHealth,
          reconnectProgress: radioData.reconnectProgress ?? null,
          coreCapabilities: radioData.coreCapabilities,
          coreCapabilityDiagnostics: radioData.coreCapabilityDiagnostics,
          meterCapabilities: radioData.meterCapabilities,
          tunerCapabilities: radioData.tunerCapabilities,
        },
      });
    },
    radioError: (data: unknown) => {
      const errorData = data as RadioErrorEventData;
      logger.warn('Radio error received:', errorData);

      const record: RadioErrorRecord = {
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        message: errorData.message,
        userMessage: errorData.userMessage || errorData.message,
        userMessageKey: errorData.userMessageKey,
        userMessageParams: errorData.userMessageParams,
        suggestions: errorData.suggestions || [],
        severity: (errorData.severity as RadioErrorRecord['severity']) || 'error',
        code: errorData.code,
        timestamp: errorData.timestamp || new Date().toISOString(),
        context: errorData.context as Record<string, unknown> | undefined,
        stack: errorData.stack,
        connectionHealth: errorData.connectionHealth,
        profileId: errorData.profileId ?? null,
        profileName: errorData.profileName ?? null,
      };

      radioDispatch({ type: 'radioError', payload: record });
    },
    radioDisconnectedDuringTransmission: (data: unknown) => {
      logger.warn('Radio disconnected during transmission:', data);
    },
    textMessage: (data: unknown) => {
      const msgData = data as { title: string; text: string; color?: string; timeout?: number | null; key?: string; params?: Record<string, string> };
      logger.debug('Text message received:', msgData);
      const title = msgData.key
        ? i18n.t(`toast:serverMessage.${msgData.key}.title`, msgData.params || {})
        : msgData.title;
      const description = msgData.key
        ? i18n.t(`toast:serverMessage.${msgData.key}.description`, { ...msgData.params, defaultValue: msgData.text })
        : msgData.text;
      addToast({
        title,
        description,
        color: (msgData.color as 'default' | 'foreground' | 'primary' | 'secondary' | 'success' | 'warning' | 'danger' | undefined) || 'default',
        timeout: msgData.timeout === null ? undefined : (msgData.timeout || 3000),
      });
    },
    profileChanged: (data: unknown) => {
      const profileData = data as ProfileChangedEvent;
      logger.info('Profile switched', { profileId: profileData.profileId, name: profileData.profile.name });
      radioDispatch({ type: 'profileChanged', payload: profileData });
      spectrumNegotiation.applyProfileDrivenSpectrumNegotiation(profileData.profileId, true);
    },
    profileListUpdated: (data: unknown) => {
      const listData = data as { profiles: RadioProfile[]; activeProfileId: string | null };
      logger.info('Profile list updated', { count: listData.profiles.length });
      radioDispatch({ type: 'profileListUpdated', payload: listData });
      if (listData.activeProfileId !== activeProfileIdRef.current) {
        spectrumNegotiation.applyProfileDrivenSpectrumNegotiation(
          listData.activeProfileId,
          capabilitiesRef.current?.profileId !== listData.activeProfileId,
        );
      }
    },
    voicePttLockChanged: (data: unknown) => {
      const lockData = data as VoicePTTLock;
      logger.debug('Voice PTT lock changed:', lockData);
      radioDispatch({ type: 'voicePttLockChanged', payload: lockData });
    },
    voiceRadioModeChanged: (data: unknown) => {
      const modeData = data as { radioMode: string };
      logger.debug('Voice radio mode changed:', modeData.radioMode);
      radioDispatch({ type: 'voiceRadioModeChanged', payload: modeData.radioMode });
    },
    radioCapabilityList: (data: unknown) => {
      const listData = data as CapabilityList;
      logger.debug('Radio capability list received', {
        descriptorCount: listData.descriptors.length,
        stateCount: listData.capabilities.length,
      });
      radioDispatch({ type: 'setCapabilityList', payload: listData });
    },
    radioCapabilityChanged: (data: unknown) => {
      const state = data as CapabilityState;
      logger.debug('Radio capability changed', { id: state.id, value: state.value });
      radioDispatch({ type: 'updateCapabilityState', payload: state });
    },
    audioSidecarStatusChanged: (data: unknown) => {
      const payload = data as AudioSidecarStatusPayload;
      logger.debug('Audio sidecar status changed', { status: payload.status, retryAttempt: payload.retryAttempt });
      radioDispatch({ type: 'audioSidecarStatusChanged', payload });
    },
  };
}
