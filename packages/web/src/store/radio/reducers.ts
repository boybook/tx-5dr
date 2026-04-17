import type {
  CapabilityDescriptor,
  CapabilityState,
  EngineMode,
  QSORecord,
  SlotPack,
  SystemStatus,
} from '@tx5dr/contracts';
import { RadioConnectionStatus } from '@tx5dr/contracts';
import { createLogger } from '../../utils/logger';
import type {
  ConnectionAction,
  ConnectionState,
  LogbookAction,
  LogbookState,
  RadioAction,
  RadioState,
  SlotPacksAction,
  SlotPacksState,
} from './types';

const logger = createLogger('RadioStore');

export const initialConnectionState: ConnectionState = {
  isConnected: false,
  isConnecting: true,
  wasEverConnected: false,
  radioService: null,
  connectError: null,
};

export function connectionReducer(state: ConnectionState, action: ConnectionAction): ConnectionState {
  switch (action.type) {
    case 'connected':
      return {
        ...state,
        isConnected: true,
        isConnecting: false,
        wasEverConnected: true,
        connectError: null,
      };
    case 'reconnecting':
      return {
        ...state,
        isConnected: false,
        isConnecting: true,
        connectError: null,
      };
    case 'disconnected':
      return { ...state, isConnected: false, isConnecting: false };
    case 'connectFailed':
      return { ...state, isConnecting: false, connectError: 'SERVER_UNAVAILABLE' };
    case 'SET_RADIO_SERVICE':
      return { ...state, radioService: action.payload };
    default:
      return state;
  }
}

export const initialRadioState: RadioState = {
  isDecoding: false,
  currentMode: null,
  systemStatus: null,
  operators: [],
  currentOperatorId: null,
  radioConnected: false,
  radioConnectionStatus: RadioConnectionStatus.DISCONNECTED,
  radioInfo: null,
  radioConfig: { type: 'none' },
  reconnectProgress: null,
  pttStatus: {
    isTransmitting: false,
    operatorIds: []
  },
  meterData: null,
  meterCapabilities: null,
  tunerCapabilities: null,
  capabilityDescriptors: new Map<string, CapabilityDescriptor>(),
  capabilityStates: new Map<string, CapabilityState>(),
  radioConnectionHealth: null,
  coreCapabilities: null,
  coreCapabilityDiagnostics: null,
  profiles: [],
  activeProfileId: null,
  profilesLoaded: false,
  engineMode: 'digital',
  voicePttLock: null,
  currentRadioMode: null,
  currentRadioFrequency: null,
  spectrumSessionState: null,
  radioErrors: [],
  latestRadioError: null,
  stationInfo: null,
  spectrumCapabilities: null,
  selectedSpectrumKind: null,
  subscribedSpectrumKind: null,
  clockStatus: null,
};

export function radioReducer(state: RadioState, action: RadioAction): RadioState {
  switch (action.type) {
    case 'modeChanged':
      return {
        ...state,
        currentMode: action.payload
      };
    
    case 'systemStatus':
      return {
        ...state,
        systemStatus: action.payload,
        isDecoding: action.payload?.isDecoding || false,
        currentMode: action.payload?.currentMode || state.currentMode,
        // Extract engineMode from systemStatus (defaults to 'digital')
        engineMode: (action.payload as SystemStatus & { engineMode?: EngineMode })?.engineMode || state.engineMode,
        currentRadioMode: (action.payload as SystemStatus & { currentRadioMode?: string })?.currentRadioMode ?? state.currentRadioMode
      };

    case 'setCurrentRadioFrequency':
      return {
        ...state,
        currentRadioFrequency: action.payload && action.payload > 0 ? action.payload : state.currentRadioFrequency,
      };

    case 'setSpectrumSessionState':
      return {
        ...state,
        spectrumSessionState: action.payload,
        currentRadioMode: action.payload?.voice.radioMode ?? state.currentRadioMode,
        currentRadioFrequency: action.payload?.currentRadioFrequency && action.payload.currentRadioFrequency > 0
          ? action.payload.currentRadioFrequency
          : state.currentRadioFrequency,
      };
    
    case 'decodeError':
      logger.warn('Decode error:', action.payload);
      return state;

    case 'error':
      logger.error('Radio service error:', action.payload);
      return state;
    
    case 'operatorsList':
      return {
        ...state,
        operators: action.payload || []
      };
    
    case 'operatorStatusUpdate':
      return {
        ...state,
        operators: state.operators.map(op => {
          if (op.id === action.payload.id) {
            // 深度比较，只有实际变化时才更新
            const hasContextChanged =
              JSON.stringify(op.context) !== JSON.stringify(action.payload.context);
            const hasSlotChanged = op.currentSlot !== action.payload.currentSlot;
            const hasTransmittingChanged = op.isTransmitting !== action.payload.isTransmitting;
            const hasSlotsChanged =
              JSON.stringify(op.slots) !== JSON.stringify(action.payload.slots);
            const hasCycleInfoChanged =
              JSON.stringify(op.cycleInfo) !== JSON.stringify(action.payload.cycleInfo);
            const hasTransmitCyclesChanged =
              JSON.stringify(op.transmitCycles) !== JSON.stringify(action.payload.transmitCycles);

            // 如果没有实质性变化，返回原对象（避免重新渲染）
            if (!hasContextChanged && !hasSlotChanged && !hasTransmittingChanged &&
                !hasSlotsChanged && !hasCycleInfoChanged && !hasTransmitCyclesChanged) {
              return op;
            }

            return action.payload;
          }
          return op;
        })
      };

    case 'setCurrentOperator':
      return {
        ...state,
        currentOperatorId: action.payload
      };

    case 'radioStatusUpdate':
      return {
        ...state,
        radioConnected: action.payload.radioConnected,
        radioConnectionStatus: action.payload.status,
        radioInfo: action.payload.radioInfo,
        // 如果事件中包含radioConfig则更新，否则保持现有配置
        radioConfig: action.payload.radioConfig || state.radioConfig,
        // 同步重连进度
        reconnectProgress: action.payload.reconnectProgress ?? null,
        // 同步连接健康状态（如果事件中包含）
        radioConnectionHealth: action.payload.radioConnectionHealth !== undefined
          ? action.payload.radioConnectionHealth
          : state.radioConnectionHealth,
        coreCapabilities: action.payload.radioConnected
          ? (action.payload.coreCapabilities ?? state.coreCapabilities)
          : null,
        coreCapabilityDiagnostics: action.payload.radioConnected
          ? (action.payload.coreCapabilityDiagnostics ?? null)
          : null,
        // 数值表能力：连接时更新，断开时重置为 null
        meterCapabilities: action.payload.radioConnected
          ? (action.payload.meterCapabilities ?? state.meterCapabilities)
          : null,
        // 天调能力：连接时更新，断开时重置为 null
        // TODO: remove after capability system migration (Phase 3)
        tunerCapabilities: action.payload.radioConnected
          ? (action.payload.tunerCapabilities ?? state.tunerCapabilities)
          : null,
        // 仅在真正的终结断开态清空能力（DISCONNECTED / CONNECTION_LOST / NOT_CONFIGURED）。
        // CONNECTING / RECONNECTING 是中间态，此时 radioConnected 虽为 false 但能力列表应保留，
        // 否则 wake flow 中的 capabilityList 事件会被紧随其后的 connecting 事件清空。
        capabilityDescriptors:
          action.payload.status === RadioConnectionStatus.DISCONNECTED ||
          action.payload.status === RadioConnectionStatus.CONNECTION_LOST ||
          action.payload.status === RadioConnectionStatus.NOT_CONFIGURED
            ? new Map<string, CapabilityDescriptor>()
            : state.capabilityDescriptors,
        capabilityStates:
          action.payload.status === RadioConnectionStatus.DISCONNECTED ||
          action.payload.status === RadioConnectionStatus.CONNECTION_LOST ||
          action.payload.status === RadioConnectionStatus.NOT_CONFIGURED
            ? new Map<string, CapabilityState>()
            : state.capabilityStates,
        currentRadioFrequency: action.payload.radioConnected ? state.currentRadioFrequency : null,
        spectrumSessionState: action.payload.radioConnected ? state.spectrumSessionState : null,
      };

    case 'setSpectrumCapabilities':
      return {
        ...state,
        spectrumCapabilities: action.payload,
      };

    case 'setSelectedSpectrumKind':
      return {
        ...state,
        selectedSpectrumKind: action.payload,
      };

    case 'setSubscribedSpectrumKind':
      return {
        ...state,
        subscribedSpectrumKind: action.payload,
      };

    case 'clockStatusChanged':
      return {
        ...state,
        clockStatus: action.payload,
      };

    case 'pttStatusChanged':
      return {
        ...state,
        pttStatus: {
          isTransmitting: action.payload.isTransmitting,
          operatorIds: action.payload.operatorIds
        }
      };

    case 'meterData':
      return {
        ...state,
        meterData: action.payload
      };

    case 'setProfiles':
      return {
        ...state,
        profiles: action.payload.profiles,
        activeProfileId: action.payload.activeProfileId,
        profilesLoaded: true
      };

    case 'profileChanged': {
      const { profileId, profile } = action.payload;
      return {
        ...state,
        activeProfileId: profileId,
        // 更新 radioConfig 为新 Profile 的配置
        radioConfig: profile.radio,
        // 更新 profiles 列表中对应的 Profile
        profiles: state.profiles.map(p => p.id === profileId ? profile : p)
      };
    }

    case 'profileListUpdated':
      return {
        ...state,
        profiles: action.payload.profiles,
        activeProfileId: action.payload.activeProfileId
      };

    case 'radioError': {
      const newErrors = [action.payload, ...state.radioErrors].slice(0, 100);
      return { ...state, radioErrors: newErrors, latestRadioError: action.payload };
    }

    case 'clearRadioErrors':
      return { ...state, radioErrors: [], latestRadioError: null };

    case 'setEngineMode':
      return { ...state, engineMode: action.payload };

    case 'voicePttLockChanged':
      return { ...state, voicePttLock: action.payload };

    case 'voiceRadioModeChanged':
      return { ...state, currentRadioMode: action.payload };

    case 'setStationInfo':
      return { ...state, stationInfo: action.payload };

    case 'setCapabilityList': {
      const descriptorMap = new Map<string, CapabilityDescriptor>();
      for (const descriptor of action.payload.descriptors) {
        descriptorMap.set(descriptor.id, descriptor);
      }

      const newMap = new Map<string, CapabilityState>();
      for (const cap of action.payload.capabilities) {
        newMap.set(cap.id, cap);
      }
      return {
        ...state,
        capabilityDescriptors: descriptorMap,
        capabilityStates: newMap,
      };
    }

    case 'updateCapabilityState': {
      const updated = new Map(state.capabilityStates);
      updated.set(action.payload.id, action.payload);
      return { ...state, capabilityStates: updated };
    }

    default:
      return state;
  }
}

export const initialSlotPacksState: SlotPacksState = {
  slotPacks: [],
  totalMessages: 0,
  lastUpdateTime: null
};

export const initialLogbookState: LogbookState = {
  qsosByOperator: new Map(),
  statisticsByLogbook: new Map(),
  lastUpdateTime: null
};

export function slotPacksReducer(state: SlotPacksState, action: SlotPacksAction): SlotPacksState {
  switch (action.type) {
    case 'slotPackUpdated': {
      const newSlotPack = action.payload;
      const existingIndex = state.slotPacks.findIndex(sp => sp.slotId === newSlotPack.slotId);
      
      let updatedSlotPacks: SlotPack[];
      if (existingIndex >= 0) {
        // 更新现有的SlotPack
        updatedSlotPacks = [...state.slotPacks];
        updatedSlotPacks[existingIndex] = newSlotPack;
      } else {
        // 添加新的SlotPack
        updatedSlotPacks = [...state.slotPacks, newSlotPack];
      }
      
      // 按时间排序并只保留最近的50个SlotPack
      updatedSlotPacks.sort((a, b) => a.startMs - b.startMs);
      if (updatedSlotPacks.length > 50) {
        updatedSlotPacks = updatedSlotPacks.slice(-50);
      }
      
      // 计算总消息数
      const totalMessages = updatedSlotPacks.reduce((sum, sp) => sum + sp.frames.length, 0);
      
      return {
        ...state,
        slotPacks: updatedSlotPacks,
        totalMessages,
        lastUpdateTime: new Date()
      };
    }
    
    case 'CLEAR_DATA':
      return {
        ...state,
        slotPacks: [],
        totalMessages: 0,
        lastUpdateTime: null
      };
    
    default:
      return state;
  }
}

export function logbookReducer(state: LogbookState, action: LogbookAction): LogbookState {
  switch (action.type) {
    case 'qsoRecordAdded': {
      const { operatorId, qsoRecord } = action.payload;
      const updatedQsosByOperator = new Map(state.qsosByOperator);
      
      // 获取该操作员现有的QSO记录
      const existingQsos = updatedQsosByOperator.get(operatorId) || [];
      
      // 检查是否已存在相同的QSO记录（避免重复）
      const existingIndex = existingQsos.findIndex(qso => qso.id === qsoRecord.id);
      
      let updatedQsos: QSORecord[];
      if (existingIndex >= 0) {
        // 更新现有记录
        updatedQsos = [...existingQsos];
        updatedQsos[existingIndex] = qsoRecord;
      } else {
        // 添加新记录
        updatedQsos = [...existingQsos, qsoRecord];
      }
      
      // 按时间排序（最新的在前）
      updatedQsos.sort((a, b) => b.startTime - a.startTime);
      
      // 限制每个操作员保留的记录数量（例如最近1000条）
      if (updatedQsos.length > 1000) {
        updatedQsos = updatedQsos.slice(0, 1000);
      }
      
      updatedQsosByOperator.set(operatorId, updatedQsos);
      
      return {
        ...state,
        qsosByOperator: updatedQsosByOperator,
        lastUpdateTime: new Date()
      };
    }

    case 'qsoRecordUpdated': {
      const { operatorId, qsoRecord } = action.payload;
      const updatedQsosByOperator = new Map(state.qsosByOperator);
      
      // 获取该操作员现有的QSO记录
      const existingQsos = updatedQsosByOperator.get(operatorId) || [];
      
      // 检查是否已存在相同的QSO记录（避免重复）
      const existingIndex = existingQsos.findIndex(qso => qso.id === qsoRecord.id);
      
      let updatedQsos: QSORecord[];
      if (existingIndex >= 0) {
        // 更新现有记录
        updatedQsos = [...existingQsos];
        updatedQsos[existingIndex] = qsoRecord;
      } else {
        // 添加新记录
        updatedQsos = [...existingQsos, qsoRecord];
      }
      
      // 按时间排序（最新的在前）
      updatedQsos.sort((a, b) => b.startTime - a.startTime);
      
      // 限制每个操作员保留的记录数量（例如最近1000条）
      if (updatedQsos.length > 1000) {
        updatedQsos = updatedQsos.slice(0, 1000);
      }
      
      updatedQsosByOperator.set(operatorId, updatedQsos);
      
      return {
        ...state,
        qsosByOperator: updatedQsosByOperator,
        lastUpdateTime: new Date()
      };
    }
    
    case 'logbookUpdated': {
      const { logBookId, statistics } = action.payload;
      const updatedStatistics = new Map(state.statisticsByLogbook);
      updatedStatistics.set(logBookId, statistics);
      
      return {
        ...state,
        statisticsByLogbook: updatedStatistics,
        lastUpdateTime: new Date()
      };
    }
    
    case 'loadQSOs': {
      const { operatorId, qsos } = action.payload;
      const updatedQsosByOperator = new Map(state.qsosByOperator);
      
      // 按时间排序（最新的在前）
      const sortedQsos = [...qsos].sort((a, b) => b.startTime - a.startTime);
      updatedQsosByOperator.set(operatorId, sortedQsos);
      
      return {
        ...state,
        qsosByOperator: updatedQsosByOperator,
        lastUpdateTime: new Date()
      };
    }
    
    case 'CLEAR_LOGBOOK_DATA':
      return {
        ...state,
        qsosByOperator: new Map(),
        statisticsByLogbook: new Map(),
        lastUpdateTime: null
      };
    
    default:
      return state;
  }
}
