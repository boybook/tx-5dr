import React, { createContext, useContext, useReducer, useEffect, useRef, ReactNode } from 'react';
import { addToast } from '@heroui/toast';
import { createLogger } from '../utils/logger';
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
  RadioProfile,
  ProfileChangedEvent,
  ReconnectProgress,
  RadioErrorEventData,
  VoicePTTLock,
  EngineMode,
  StationInfo
} from '@tx5dr/contracts';
import { RadioConnectionStatus, UserRole } from '@tx5dr/contracts';
import { RadioService } from '../services/radioService';
import { getHandshakeOperatorIds, getHiddenOperatorIds } from '../utils/operatorPreferences';
import { useAuth } from './authStore';
import {
  showErrorToast,
  createRetryAction,
  createRefreshStatusAction,
  isRetryableError
} from '../utils/errorToast';
import i18n from '../i18n';

const logger = createLogger('RadioStore');

// ===== 连接状态管理 =====
export interface ConnectionState {
  isConnected: boolean;
  isConnecting: boolean;
  wasEverConnected: boolean;
  radioService: RadioService | null;
}

export type ConnectionAction =
  | { type: 'connected' }
  | { type: 'disconnected' }
  | { type: 'SET_RADIO_SERVICE'; payload: RadioService };

const initialConnectionState: ConnectionState = {
  isConnected: false,
  isConnecting: true,
  wasEverConnected: false,
  radioService: null
};

function connectionReducer(state: ConnectionState, action: ConnectionAction): ConnectionState {
  switch (action.type) {
    case 'connected':
      return {
        ...state,
        isConnected: true,
        isConnecting: false,
        wasEverConnected: true,
      };
    case 'disconnected':
      return { ...state, isConnected: false, isConnecting: !state.wasEverConnected };
    case 'SET_RADIO_SERVICE':
      return { ...state, radioService: action.payload };
    default:
      return state;
  }
}

// ===== 电台状态管理 =====
export interface RadioState {
  isDecoding: boolean;
  currentMode: ModeDescriptor | null;
  systemStatus: SystemStatus | null;
  operators: OperatorStatus[];
  currentOperatorId: string | null;
  // 电台连接状态
  radioConnected: boolean;
  radioConnectionStatus: RadioConnectionStatus;
  radioInfo: RadioInfo | null;
  radioConfig: HamlibConfig;
  // PTT状态
  pttStatus: {
    isTransmitting: boolean;
    operatorIds: string[];
  };
  // 电台数值表数据
  meterData: MeterData | null;
  // 电台数值表能力（null = 未知/兼容旧版）
  meterCapabilities: MeterCapabilities | null;
  // 天调能力（null = 未连接；连接时由 radioStatusChanged 事件推送）
  tunerCapabilities: TunerCapabilities | null;
  // 电台重连进度
  reconnectProgress: ReconnectProgress | null;
  // 电台连接健康状态
  radioConnectionHealth: {
    connectionHealthy: boolean;
  } | null;
  // Profile 管理
  profiles: RadioProfile[];
  activeProfileId: string | null;
  profilesLoaded: boolean;
  // 语音模式
  engineMode: EngineMode;
  voicePttLock: VoicePTTLock | null;
  currentRadioMode: string | null;
  // 电台错误频道
  radioErrors: RadioErrorRecord[];
  latestRadioError: RadioErrorRecord | null;
  // 电台站基础信息
  stationInfo: StationInfo | null;
}

// 错误事件数据结构
export interface ErrorEventData {
  message: string;
  userMessage?: string;
  suggestions?: string[];
  severity?: 'info' | 'warning' | 'error' | 'critical';
  code?: string;
  timestamp?: string;
  context?: Record<string, unknown>;
}

// 电台错误记录（带 Profile 信息，用于错误历史列表）
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

// 解码错误数据结构
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

// 连接健康状态数据结构
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
  | { type: 'radioStatusUpdate'; payload: { radioConnected: boolean; status: RadioConnectionStatus; radioInfo: RadioInfo | null; radioConfig?: HamlibConfig; radioConnectionHealth?: ConnectionHealthInfo; reconnectProgress?: ReconnectProgress | null; meterCapabilities?: MeterCapabilities; tunerCapabilities?: TunerCapabilities } }
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
  | { type: 'setStationInfo'; payload: StationInfo };

const initialRadioState: RadioState = {
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
  radioConnectionHealth: null,
  profiles: [],
  activeProfileId: null,
  profilesLoaded: false,
  engineMode: 'digital',
  voicePttLock: null,
  currentRadioMode: null,
  radioErrors: [],
  latestRadioError: null,
  stationInfo: null
};

function radioReducer(state: RadioState, action: RadioAction): RadioState {
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
        // 数值表能力：连接时更新，断开时重置为 null
        meterCapabilities: action.payload.radioConnected
          ? (action.payload.meterCapabilities ?? state.meterCapabilities)
          : null,
        // 天调能力：连接时更新，断开时重置为 null
        tunerCapabilities: action.payload.radioConnected
          ? (action.payload.tunerCapabilities ?? state.tunerCapabilities)
          : null,
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

    default:
      return state;
  }
}

// ===== 时隙包数据管理 =====
export interface SlotPacksState {
  slotPacks: SlotPack[];
  totalMessages: number;
  lastUpdateTime: Date | null;
}

export type SlotPacksAction = 
  | { type: 'slotPackUpdated'; payload: SlotPack }
  | { type: 'CLEAR_DATA' };

// ===== 通联日志数据管理 =====
export interface LogbookState {
  qsosByOperator: Map<string, QSORecord[]>; // 按操作员ID分组的QSO记录
  statisticsByLogbook: Map<string, LogBookStatistics>; // 按日志本ID分组的统计信息
  lastUpdateTime: Date | null;
}

export type LogbookAction = 
  | { type: 'qsoRecordAdded'; payload: { operatorId: string; logBookId: string; qsoRecord: QSORecord } }
  | { type: 'logbookUpdated'; payload: { logBookId: string; statistics: LogBookStatistics } }
  | { type: 'loadQSOs'; payload: { operatorId: string; qsos: QSORecord[] } }
  | { type: 'CLEAR_LOGBOOK_DATA' };

const initialSlotPacksState: SlotPacksState = {
  slotPacks: [],
  totalMessages: 0,
  lastUpdateTime: null
};

const initialLogbookState: LogbookState = {
  qsosByOperator: new Map(),
  statisticsByLogbook: new Map(),
  lastUpdateTime: null
};

function slotPacksReducer(state: SlotPacksState, action: SlotPacksAction): SlotPacksState {
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

function logbookReducer(state: LogbookState, action: LogbookAction): LogbookState {
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

// ===== 组合状态和Context =====
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

// ===== 拆分后的独立 Context =====
const ConnectionContext = createContext<{
  state: ConnectionState;
  dispatch: React.Dispatch<ConnectionAction>;
} | undefined>(undefined);

const RadioStateContext = createContext<{
  state: RadioState;
  dispatch: React.Dispatch<RadioAction>;
} | undefined>(undefined);

const SlotPacksContext = createContext<{
  state: SlotPacksState;
  dispatch: React.Dispatch<SlotPacksAction>;
} | undefined>(undefined);

const LogbookContext = createContext<{
  state: LogbookState;
  dispatch: React.Dispatch<LogbookAction>;
} | undefined>(undefined);

// Provider组件
export const RadioProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [connectionState, connectionDispatch] = useReducer(connectionReducer, initialConnectionState);
  const [radioState, radioDispatch] = useReducer(radioReducer, initialRadioState);
  const [slotPacksState, slotPacksDispatch] = useReducer(slotPacksReducer, initialSlotPacksState);
  const [logbookState, logbookDispatch] = useReducer(logbookReducer, initialLogbookState);

  // 认证状态引用（用于事件回调中读取最新认证状态）
  const { state: authState } = useAuth();
  const authStateRef = useRef(authState);
  authStateRef.current = authState;

  // 使用 useRef 确保 RadioService 单例，避免 StrictMode 导致的重复创建
  const radioServiceRef = useRef<RadioService | null>(null);
  const connectionStatusTimerRef = useRef<NodeJS.Timeout | null>(null);

  // 初始化RadioService
  useEffect(() => {
    // 如果已经有实例，直接返回，避免重复创建
    if (radioServiceRef.current) {
      return;
    }
    
    const radioService = new RadioService();
    radioServiceRef.current = radioService;

    // 设置事件监听器 - 分发到不同的reducer
    const eventMap: Record<string, (data?: unknown) => void> = {
      connected: () => {
        connectionDispatch({ type: 'connected' });
        // 当认证未启用时，服务端不会发 AUTH_REQUIRED，直接握手
        // 当认证启用时，等待 authResult 成功后再握手
        if (!authStateRef.current.authEnabled) {
          const handshakeOperatorIds = getHandshakeOperatorIds();
          logger.info('Auth disabled, sending handshake directly:', {
            enabledOperatorIds: handshakeOperatorIds
          });
          radioService.sendHandshake(handshakeOperatorIds);
        }
        // else: 等待 authRequired → 发送 token/publicViewer → authResult → 握手
      },
      // 认证：服务端要求认证
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
      // 认证结果
      authResult: (data: unknown) => {
        const result = data as { success: boolean; role?: UserRole; label?: string; operatorIds?: string[]; error?: string };
        if (result.success) {
          logger.info('Auth succeeded, role:', result.role);
          // 认证成功后发送握手
          const handshakeOperatorIds = getHandshakeOperatorIds();
          radioService.sendHandshake(handshakeOperatorIds);
        } else {
          const errorCode = result.error;
          const localizedError = errorCode
            ? i18n.t(`auth:errors.${errorCode}`, { defaultValue: errorCode })
            : i18n.t('auth:login.failed');
          logger.error('Auth failed', { errorCode, localizedError });
        }
      },
      // JWT 过期通知
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
        radioDispatch({ type: 'modeChanged', payload: data as ModeDescriptor });
      },
      systemStatus: (data: unknown) => {
        radioDispatch({ type: 'systemStatus', payload: data as SystemStatus });
      },
      decodeError: (data: unknown) => {
        radioDispatch({ type: 'decodeError', payload: data as DecodeErrorData });
      },
      error: (data: unknown) => {
        // 适配新的增强错误格式
        const errorData = data as ErrorEventData;
        const {
          message,            // 技术错误信息（供开发者/日志）
          userMessage,        // 用户友好提示（供UI显示）⭐ 新增
          suggestions = [],   // 操作建议数组 ⭐ 新增
          severity = 'error', // 错误严重程度 ⭐ 新增
          code,               // 错误代码 ⭐ 新增
          timestamp: _timestamp,  // 时间戳
          context             // 错误上下文 ⭐ 新增
        } = errorData;

        // 根据错误代码创建操作按钮
        let action: { label: string; handler: () => void } | undefined;

        // 处理连接失败 / 超时错误 → 重试启动引擎
        if (code === 'CONNECTION_FAILED' || code === 'RADIO_CONNECTION_FAILED' || code === 'CONNECTION_TIMEOUT') {
          action = createRetryAction(() => {
            logger.debug('User clicked retry start');
            if (radioServiceRef.current) {
              radioServiceRef.current.startDecoding();
            }
          });
        }
        // 处理引擎启动失败
        else if (code === 'ENGINE_START_FAILED') {
          action = createRetryAction(() => {
            logger.debug('User clicked retry start engine');
            if (radioServiceRef.current) {
              radioServiceRef.current.startDecoding();
            }
          });
        }
        // 处理设备未找到 / 配置无效 → 提示打开配置
        else if (code === 'DEVICE_NOT_FOUND' || code === 'INVALID_CONFIG') {
          action = {
            label: i18n.t('common:action.openSettings'),
            handler: () => {
              window.dispatchEvent(new CustomEvent('openProfileModal'));
            }
          };
        }
        // 处理超时错误
        else if (code === 'TIMEOUT') {
          action = createRetryAction(() => {
            logger.debug('User clicked retry operation');
            addToast({
              title: i18n.t('toast:severity.info'),
              description: i18n.t('toast:hint.retryManually'),
              color: 'primary',
              timeout: 3000
            });
          });
        }
        // 处理状态冲突
        else if (code === 'STATE_CONFLICT') {
          action = createRefreshStatusAction(() => {
            logger.debug('User clicked refresh status');
            if (radioServiceRef.current) {
              radioServiceRef.current.getSystemStatus();
            }
          });
        }
        // 处理资源繁忙
        else if (code === 'RESOURCE_BUSY') {
          action = createRetryAction(() => {
            logger.debug('User clicked retry (resource busy)');
            addToast({
              title: i18n.t('toast:severity.info'),
              description: i18n.t('toast:hint.tryLater'),
              color: 'primary',
              timeout: 2000
            });
          });
        }
        // 其他可重试错误
        else if (isRetryableError(code)) {
          action = createRetryAction(() => {
            logger.debug(`User clicked retry (error code: ${code})`);
            addToast({
              title: i18n.t('toast:severity.info'),
              description: i18n.t('toast:hint.retryManually'),
              color: 'primary',
              timeout: 3000
            });
          });
        }

        // 显示用户友好的错误 Toast
        showErrorToast({
          userMessage: userMessage || message || i18n.t('errors:code.UNKNOWN_ERROR.userMessage'),
          suggestions,
          severity,
          code,
          technicalDetails: message,
          context,
          action  // 传递操作按钮
        });

        // 保持向后兼容：dispatch error action（用于日志记录）
        radioDispatch({
          type: 'error',
          payload: new Error(message || i18n.t('errors:code.UNKNOWN_ERROR.userMessage'))
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
      logbookUpdated: (data: unknown) => {
        const logbookData = data as { logBookId: string; statistics: LogBookStatistics };
        logger.debug('Logbook updated:', logbookData);
        logbookDispatch({ type: 'logbookUpdated', payload: logbookData });
      },
      operatorsList: (data: unknown) => {
        const operatorsData = data as { operators: OperatorStatus[] };
        radioDispatch({ type: 'operatorsList', payload: operatorsData.operators });

        // 黑名单模式：收到操作员列表后，如果有隐藏的操作员，同步给服务端
        const hiddenIds = getHiddenOperatorIds();
        if (hiddenIds.length > 0) {
          const allIds = operatorsData.operators.map(op => op.id);
          const hiddenSet = new Set(hiddenIds);
          const enabledIds = allIds.filter(id => !hiddenSet.has(id));
          logger.debug('Syncing enabled operators after receiving list:', enabledIds);
          radioService.setClientEnabledOperators(enabledIds);
        }
      },
      operatorStatusUpdate: (() => {
        // 节流：200ms 内合并多次操作员状态更新
        const pending: Map<string, OperatorStatus> = new Map();
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
      // 频率变化：清空本地 SlotPack 历史
      frequencyChanged: () => {
        logger.debug('Frequency changed, clearing local slot history');
        slotPacksDispatch({ type: 'CLEAR_DATA' });
      },
      // PTT状态变化
      pttStatusChanged: (data: unknown) => {
        const pttData = data as { isTransmitting: boolean; operatorIds: string[] };
        logger.debug(`PTT status changed: ${pttData.isTransmitting ? 'transmitting' : 'idle'}, operators=[${pttData.operatorIds?.join(', ') || ''}]`);
        radioDispatch({ type: 'pttStatusChanged', payload: pttData });
      },
      // 电台数值表数据（节流：100ms 内最多更新一次）
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
      handshakeComplete: async (_data: unknown) => {
        logger.info('Handshake complete');

        // 握手完成后，请求 Profile 列表
        // 注意：电台状态已通过 WSServer addConnection 的 radioStatusChanged 初始同步完成，
        // 后续状态变化通过 radioStatusChanged 事件实时推送，无需重复 API 请求。
        logger.info('Handshake complete, requesting profile list');
        try {
          const { api } = await import('@tx5dr/core');
          const profilesResponse = await api.getProfiles();
          logger.info('Profile list synced', { count: profilesResponse.profiles.length });
          radioDispatch({
            type: 'setProfiles',
            payload: {
              profiles: profilesResponse.profiles,
              activeProfileId: profilesResponse.activeProfileId
            }
          });
        } catch (error) {
          logger.error('Failed to fetch profile list:', error);
          // 即使获取失败（如 viewer 角色无权限），仍标记为已加载，使前端可区分引导状态
          radioDispatch({
            type: 'setProfiles',
            payload: { profiles: [], activeProfileId: null }
          });
        }

        // 握手完成后，获取电台站信息（公开，所有角色都拉取）
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
            meterCapabilities: radioData.meterCapabilities,
            tunerCapabilities: radioData.tunerCapabilities,
          }
        });

        // 重连成功 toast
        if (radioData.status === RadioConnectionStatus.CONNECTED && radioData.connected) {
          // 仅在之前是 RECONNECTING 或 CONNECTION_LOST 状态时显示
          // 通过检查 reconnectProgress 是否从有值变为 null 来判断
        }

        // CONNECTION_LOST 状态不再推送 Toast，由 RadioControl Alert 内联展示
      },
      radioError: (data: unknown) => {
        const errorData = data as RadioErrorEventData;
        logger.warn('Radio error received:', errorData);

        const record: RadioErrorRecord = {
          id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          message: errorData.message,
          userMessage: errorData.userMessage || errorData.message,
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
        // 有 key 时优先使用翻译，兜底使用原始 title/text
        const title = msgData.key
          ? i18n.t(`toast:serverMessage.${msgData.key}.title`, msgData.params || {})
          : msgData.title;
        const description = msgData.key
          ? i18n.t(`toast:serverMessage.${msgData.key}.description`, { ...msgData.params, defaultValue: msgData.text })
          : msgData.text;
        addToast({
          title,
          description,
          color: (msgData.color as "default" | "foreground" | "primary" | "secondary" | "success" | "warning" | "danger" | undefined) || 'default',
          timeout: msgData.timeout === null ? undefined : (msgData.timeout || 3000)
        });
      },
      // Profile 管理事件
      profileChanged: (data: unknown) => {
        const profileData = data as ProfileChangedEvent;
        logger.info('Profile switched', { profileId: profileData.profileId, name: profileData.profile.name });
        radioDispatch({ type: 'profileChanged', payload: profileData });
      },
      profileListUpdated: (data: unknown) => {
        const listData = data as { profiles: RadioProfile[]; activeProfileId: string | null };
        logger.info('Profile list updated', { count: listData.profiles.length });
        radioDispatch({ type: 'profileListUpdated', payload: listData });
      },
      // Voice mode events
      voicePttLockChanged: (data: unknown) => {
        const lockData = data as VoicePTTLock;
        logger.debug('Voice PTT lock changed:', lockData);
        radioDispatch({ type: 'voicePttLockChanged', payload: lockData });
      },
      voiceRadioModeChanged: (data: unknown) => {
        const modeData = data as { radioMode: string };
        logger.debug('Voice radio mode changed:', modeData.radioMode);
        radioDispatch({ type: 'voiceRadioModeChanged', payload: modeData.radioMode });
      }
    };

    // 直接订阅 WSClient 事件，绕过 RadioService 的事件层
    // 这样可以简化事件流：WSClient → RadioProvider → Components
    const wsClient = radioService.wsClientInstance;
    Object.entries(eventMap).forEach(([event, handler]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wsClient.onWSEvent(event as any, handler as any);
    });

    connectionDispatch({ type: 'SET_RADIO_SERVICE', payload: radioService });


    // 清理函数
    return () => {
      if (connectionStatusTimerRef.current) {
        clearInterval(connectionStatusTimerRef.current);
        connectionStatusTimerRef.current = null;
      }

      // 取消所有 WSClient 事件订阅
      if (radioServiceRef.current) {
        const wsClient = radioServiceRef.current.wsClientInstance;
        Object.entries(eventMap).forEach(([event, handler]) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          wsClient.offWSEvent(event as any, handler as any);
        });
      }

      if (radioServiceRef.current) {
        radioServiceRef.current.disconnect();
        radioServiceRef.current = null;
      }
    };
  }, []);

  return React.createElement(
    ConnectionContext.Provider, { value: { state: connectionState, dispatch: connectionDispatch } },
    React.createElement(
      RadioStateContext.Provider, { value: { state: radioState, dispatch: radioDispatch } },
      React.createElement(
        SlotPacksContext.Provider, { value: { state: slotPacksState, dispatch: slotPacksDispatch } },
        React.createElement(
          LogbookContext.Provider, { value: { state: logbookState, dispatch: logbookDispatch } },
          children
        )
      )
    )
  );
};

// ===== Consumer Hooks（各 hook 直接从对应 Context 读取，互不影响）=====

// 向后兼容：聚合所有 Context
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
    }
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
  const { state } = useRadioState();
  return {
    operators: state.operators || [],
  };
};

export const useCurrentOperatorId = () => {
  const { state, dispatch } = useRadioState();
  return {
    currentOperatorId: state.currentOperatorId || state.operators?.[0]?.id,
    setCurrentOperatorId: (operatorId: string) => {
      dispatch({ type: 'setCurrentOperator', payload: operatorId });
    }
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
    loadQSOs: (operatorId: string, qsos: QSORecord[]) => {
      context.dispatch({ type: 'loadQSOs', payload: { operatorId, qsos } });
    }
  };
};

export const useProfiles = () => {
  const { state } = useRadioState();
  const activeProfile = state.profiles.find(p => p.id === state.activeProfileId) ?? null;
  return {
    profiles: state.profiles,
    activeProfileId: state.activeProfileId,
    activeProfile,
    profilesLoaded: state.profilesLoaded,
  };
};

export const useStationInfo = () => {
  const { state } = useRadioState();
  return state.stationInfo;
};

export const useRadioErrors = () => {
  const { state, dispatch } = useRadioState();
  return {
    errors: state.radioErrors,
    latestError: state.latestRadioError,
    clearErrors: () => dispatch({ type: 'clearRadioErrors' }),
  };
};
