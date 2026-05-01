import { createContext } from 'react';
import type React from 'react';
import type {
  AudioSidecarStatusPayload,
  CapabilityDescriptor,
  CapabilityState,
  CoreCapabilityDiagnostics,
  CoreRadioCapabilities,
  EngineMode,
  HamlibConfig,
  ModeDescriptor,
  OperatorStatus,
  RadioInfo,
  RadioProfile,
  ReconnectProgress,
  SpectrumKind,
  SpectrumSessionState,
  StationInfo,
  VoicePTTLock,
} from '@tx5dr/contracts';
import { RadioConnectionStatus } from '@tx5dr/contracts';
import type {
  ConnectionAction,
  ConnectionState,
  LogbookAction,
  LogbookState,
  RadioAction,
  RadioErrorRecord,
  RadioState,
  SlotPacksAction,
  SlotPacksState,
} from './types';

export const ConnectionContext = createContext<{
  state: ConnectionState;
  dispatch: React.Dispatch<ConnectionAction>;
} | undefined>(undefined);

export const RadioStateContext = createContext<{
  state: RadioState;
  dispatch: React.Dispatch<RadioAction>;
  markSpectrumSelectionManual?: () => void;
} | undefined>(undefined);

export const SlotPacksContext = createContext<{
  state: SlotPacksState;
  dispatch: React.Dispatch<SlotPacksAction>;
} | undefined>(undefined);

export const LogbookContext = createContext<{
  state: LogbookState;
  dispatch: React.Dispatch<LogbookAction>;
} | undefined>(undefined);

export const OperatorsContext = createContext<{
  operators: OperatorStatus[];
  currentOperatorId: string | null;
  setCurrentOperatorId: (operatorId: string) => void;
} | undefined>(undefined);

export const ProfilesContext = createContext<{
  profiles: RadioProfile[];
  activeProfileId: string | null;
  profilesLoaded: boolean;
} | undefined>(undefined);

export const RadioConnectionContext = createContext<{
  radioConnected: boolean;
  radioConnectionStatus: RadioConnectionStatus;
  radioInfo: RadioInfo | null;
  radioConfig: HamlibConfig;
  reconnectProgress: ReconnectProgress | null;
  radioConnectionHealth: { connectionHealthy: boolean } | null;
  coreCapabilities: CoreRadioCapabilities | null;
  coreCapabilityDiagnostics: CoreCapabilityDiagnostics | null;
} | undefined>(undefined);

export const RadioModeContext = createContext<{
  isDecoding: boolean;
  currentMode: ModeDescriptor | null;
  engineMode: EngineMode;
  currentRadioMode: string | null;
  currentRadioFrequency: number | null;
  spectrumSessionState: SpectrumSessionState | null;
} | undefined>(undefined);

export const PTTContext = createContext<{
  pttStatus: RadioState['pttStatus'];
  tuneToneStatus: RadioState['tuneToneStatus'];
  voicePttLock: VoicePTTLock | null;
} | undefined>(undefined);

export const StationInfoContext = createContext<StationInfo | null>(null);

export const RadioErrorsContext = createContext<{
  errors: RadioErrorRecord[];
  latestError: RadioErrorRecord | null;
  clearErrors: () => void;
} | undefined>(undefined);

export const CapabilityDescriptorsContext = createContext<Map<string, CapabilityDescriptor> | undefined>(undefined);
export const CapabilityStatesContext = createContext<Map<string, CapabilityState> | undefined>(undefined);

export const AudioSidecarContext = createContext<AudioSidecarStatusPayload | null>(null);

export const SpectrumContext = createContext<{
  selectedKind: SpectrumKind | null;
  subscribedKind: SpectrumKind | null;
} | undefined>(undefined);
