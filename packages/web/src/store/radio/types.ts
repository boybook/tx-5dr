import type React from 'react';
import type {
  SlotPack,
  ModeDescriptor,
  OperatorStatus,
  QSORecord,
  LogBookStatistics,
  MeterData,
  MeterCapabilities,
  TunerCapabilities,
  SystemStatus,
  HamlibConfig,
  RadioInfo,
  SpectrumCapabilities,
  SpectrumKind,
  SpectrumSessionState,
  RadioProfile,
  ProfileChangedEvent,
  ReconnectProgress,
  VoicePTTLock,
  EngineMode,
  StationInfo,
  CapabilityDescriptor,
  CapabilityState,
  CapabilityList,
  CoreRadioCapabilities,
  CoreCapabilityDiagnostics,
} from '@tx5dr/contracts';
import { RadioConnectionStatus } from '@tx5dr/contracts';
import type { RadioService } from '../../services/radioService';

export interface ConnectionState {
  isConnected: boolean;
  isConnecting: boolean;
  wasEverConnected: boolean;
  radioService: RadioService | null;
  connectError: string | null;
}

export type ConnectionAction =
  | { type: 'connected' }
  | { type: 'reconnecting' }
  | { type: 'disconnected' }
  | { type: 'SET_RADIO_SERVICE'; payload: RadioService }
  | { type: 'connectFailed' };

export interface RadioState {
  isDecoding: boolean;
  currentMode: ModeDescriptor | null;
  systemStatus: SystemStatus | null;
  operators: OperatorStatus[];
  currentOperatorId: string | null;
  radioConnected: boolean;
  radioConnectionStatus: RadioConnectionStatus;
  radioInfo: RadioInfo | null;
  radioConfig: HamlibConfig;
  pttStatus: {
    isTransmitting: boolean;
    operatorIds: string[];
  };
  meterData: MeterData | null;
  meterCapabilities: MeterCapabilities | null;
  tunerCapabilities: TunerCapabilities | null;
  capabilityDescriptors: Map<string, CapabilityDescriptor>;
  capabilityStates: Map<string, CapabilityState>;
  reconnectProgress: ReconnectProgress | null;
  radioConnectionHealth: {
    connectionHealthy: boolean;
  } | null;
  coreCapabilities: CoreRadioCapabilities | null;
  coreCapabilityDiagnostics: CoreCapabilityDiagnostics | null;
  profiles: RadioProfile[];
  activeProfileId: string | null;
  profilesLoaded: boolean;
  engineMode: EngineMode;
  voicePttLock: VoicePTTLock | null;
  currentRadioMode: string | null;
  currentRadioFrequency: number | null;
  spectrumSessionState: SpectrumSessionState | null;
  radioErrors: RadioErrorRecord[];
  latestRadioError: RadioErrorRecord | null;
  stationInfo: StationInfo | null;
  spectrumCapabilities: SpectrumCapabilities | null;
  selectedSpectrumKind: SpectrumKind | null;
  subscribedSpectrumKind: SpectrumKind | null;
}

export interface ErrorEventData {
  message: string;
  userMessage?: string;
  suggestions?: string[];
  severity?: 'info' | 'warning' | 'error' | 'critical';
  code?: string;
  timestamp?: string;
  context?: Record<string, unknown>;
}

export interface RadioErrorRecord {
  id: string;
  message: string;
  userMessage: string;
  suggestions: string[];
  severity: 'info' | 'warning' | 'error' | 'critical';
  code?: string;
  timestamp: string;
  context?: Record<string, unknown>;
  stack?: string;
  connectionHealth?: { connectionHealthy: boolean };
  profileId: string | null;
  profileName: string | null;
}

export interface DecodeErrorData {
  error: {
    message: string;
    stack?: string;
  };
  request: {
    slotId: string;
    windowIdx: number;
  };
}

export interface ConnectionHealthInfo {
  connectionHealthy: boolean;
}

export type RadioAction =
  | { type: 'modeChanged'; payload: ModeDescriptor }
  | { type: 'systemStatus'; payload: SystemStatus }
  | { type: 'decodeError'; payload: DecodeErrorData }
  | { type: 'error'; payload: Error }
  | { type: 'operatorsList'; payload: OperatorStatus[] }
  | { type: 'operatorStatusUpdate'; payload: OperatorStatus }
  | { type: 'setCurrentOperator'; payload: string }
  | { type: 'radioStatusUpdate'; payload: { radioConnected: boolean; status: RadioConnectionStatus; radioInfo: RadioInfo | null; radioConfig?: HamlibConfig; radioConnectionHealth?: ConnectionHealthInfo; reconnectProgress?: ReconnectProgress | null; coreCapabilities?: CoreRadioCapabilities; coreCapabilityDiagnostics?: CoreCapabilityDiagnostics; meterCapabilities?: MeterCapabilities; tunerCapabilities?: TunerCapabilities } }
  | { type: 'pttStatusChanged'; payload: { isTransmitting: boolean; operatorIds: string[] } }
  | { type: 'meterData'; payload: MeterData }
  | { type: 'setProfiles'; payload: { profiles: RadioProfile[]; activeProfileId: string | null } }
  | { type: 'profileChanged'; payload: ProfileChangedEvent }
  | { type: 'profileListUpdated'; payload: { profiles: RadioProfile[]; activeProfileId: string | null } }
  | { type: 'radioError'; payload: RadioErrorRecord }
  | { type: 'clearRadioErrors' }
  | { type: 'setEngineMode'; payload: EngineMode }
  | { type: 'voicePttLockChanged'; payload: VoicePTTLock }
  | { type: 'voiceRadioModeChanged'; payload: string }
  | { type: 'setCurrentRadioFrequency'; payload: number | null }
  | { type: 'setSpectrumSessionState'; payload: SpectrumSessionState | null }
  | { type: 'setStationInfo'; payload: StationInfo }
  | { type: 'setCapabilityList'; payload: CapabilityList }
  | { type: 'updateCapabilityState'; payload: CapabilityState }
  | { type: 'setSpectrumCapabilities'; payload: SpectrumCapabilities | null }
  | { type: 'setSelectedSpectrumKind'; payload: SpectrumKind | null }
  | { type: 'setSubscribedSpectrumKind'; payload: SpectrumKind | null };

export interface SlotPacksState {
  slotPacks: SlotPack[];
  totalMessages: number;
  lastUpdateTime: Date | null;
}

export type SlotPacksAction =
  | { type: 'slotPackUpdated'; payload: SlotPack }
  | { type: 'CLEAR_DATA' };

export interface LogbookState {
  qsosByOperator: Map<string, QSORecord[]>;
  statisticsByLogbook: Map<string, LogBookStatistics>;
  lastUpdateTime: Date | null;
}

export type LogbookAction =
  | { type: 'qsoRecordAdded'; payload: { operatorId: string; logBookId: string; qsoRecord: QSORecord } }
  | { type: 'qsoRecordUpdated'; payload: { operatorId: string; logBookId: string; qsoRecord: QSORecord } }
  | { type: 'logbookUpdated'; payload: { logBookId: string; statistics: LogBookStatistics } }
  | { type: 'loadQSOs'; payload: { operatorId: string; qsos: QSORecord[] } }
  | { type: 'CLEAR_LOGBOOK_DATA' };

export interface CombinedState {
  connection: ConnectionState;
  radio: RadioState;
  slotPacks: SlotPacksState;
  logbook: LogbookState;
}

export interface CombinedDispatch {
  connectionDispatch: React.Dispatch<ConnectionAction>;
  radioDispatch: React.Dispatch<RadioAction>;
  slotPacksDispatch: React.Dispatch<SlotPacksAction>;
  logbookDispatch: React.Dispatch<LogbookAction>;
}
