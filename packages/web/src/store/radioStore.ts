import React, { createContext, useContext, useReducer, useEffect, useRef, ReactNode } from 'react';
import { addToast } from '@heroui/toast';
import type {
  SlotPack,
  ModeDescriptor,
  OperatorStatus,
  QSORecord,
  LogBookStatistics,
  MeterData,
  SystemStatus,
  HamlibConfig,
  RadioInfo,
  RadioProfile,
  ProfileChangedEvent,
  ReconnectProgress,
  RadioErrorEventData
} from '@tx5dr/contracts';
import { RadioConnectionStatus } from '@tx5dr/contracts';
import { RadioService } from '../services/radioService';
import { getHandshakeOperatorIds, setOperatorPreferences } from '../utils/operatorPreferences';
import {
  showErrorToast,
  createRetryAction,
  createRefreshStatusAction,
  isRetryableError
} from '../utils/errorToast';

// ===== 连接状态管理 =====
export interface ConnectionState {
  isConnected: boolean;
  isConnecting: boolean;
  radioService: RadioService | null;
}

export type ConnectionAction =
  | { type: 'connected' }
  | { type: 'disconnected' }
  | { type: 'SET_RADIO_SERVICE'; payload: RadioService };

const initialConnectionState: ConnectionState = {
  isConnected: false,
  isConnecting: false,
  radioService: null
};

function connectionReducer(state: ConnectionState, action: ConnectionAction): ConnectionState {
  switch (action.type) {
    case 'connected':
      return {
        ...state,
        isConnected: true,
        isConnecting: false,
      };
    case 'disconnected':
      return { ...state, isConnected: false, isConnecting: false };
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
  // 电台重连进度
  reconnectProgress: ReconnectProgress | null;
  // 电台连接健康状态
  radioConnectionHealth: {
    connectionHealthy: boolean;
  } | null;
  // Profile 管理
  profiles: RadioProfile[];
  activeProfileId: string | null;
  // 电台错误频道
  radioErrors: RadioErrorRecord[];
  latestRadioError: RadioErrorRecord | null;
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
  | { type: 'radioStatusUpdate'; payload: { radioConnected: boolean; status: RadioConnectionStatus; radioInfo: RadioInfo | null; radioConfig?: HamlibConfig; radioConnectionHealth?: ConnectionHealthInfo; reconnectProgress?: ReconnectProgress | null } }
  | { type: 'pttStatusChanged'; payload: { isTransmitting: boolean; operatorIds: string[] } }
  | { type: 'meterData'; payload: MeterData }
  | { type: 'setProfiles'; payload: { profiles: RadioProfile[]; activeProfileId: string | null } }
  | { type: 'profileChanged'; payload: ProfileChangedEvent }
  | { type: 'profileListUpdated'; payload: { profiles: RadioProfile[]; activeProfileId: string | null } }
  | { type: 'radioError'; payload: RadioErrorRecord }
  | { type: 'clearRadioErrors' };

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
  radioConnectionHealth: null,
  profiles: [],
  activeProfileId: null,
  radioErrors: [],
  latestRadioError: null
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
        currentMode: action.payload?.currentMode || state.currentMode
      };
    
    case 'decodeError':
      console.warn('解码错误:', action.payload);
      return state;
    
    case 'error':
      console.error('RadioService错误:', action.payload);
      return state;
    
    case 'operatorsList':
      return {
        ...state,
        operators: action.payload || []
      };
    
    case 'operatorStatusUpdate':
      console.log('📻 [Store] 收到操作员状态更新:', action.payload);
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
              console.log(`📻 [Store] 操作员 ${op.id} 状态无变化，跳过更新`);
              return op;
            }
            
            console.log(`📻 [Store] 操作员 ${op.id} 状态有变化，进行更新:`, {
              hasContextChanged,
              hasSlotChanged,
              hasTransmittingChanged,
              hasSlotsChanged,
              hasCycleInfoChanged,
              hasTransmitCyclesChanged,
              newCycleInfo: action.payload.cycleInfo
            });
            
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
          : state.radioConnectionHealth
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
        activeProfileId: action.payload.activeProfileId
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

const RadioContext = createContext<{
  state: CombinedState;
  dispatch: CombinedDispatch;
} | undefined>(undefined);

// Provider组件
export const RadioProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [connectionState, connectionDispatch] = useReducer(connectionReducer, initialConnectionState);
  const [radioState, radioDispatch] = useReducer(radioReducer, initialRadioState);
  const [slotPacksState, slotPacksDispatch] = useReducer(slotPacksReducer, initialSlotPacksState);
  const [logbookState, logbookDispatch] = useReducer(logbookReducer, initialLogbookState);
  
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
        const handshakeOperatorIds = getHandshakeOperatorIds();
        console.log('🤝 [RadioProvider] 连接成功，发送握手消息:', {
          enabledOperatorIds: handshakeOperatorIds
        });
        radioService.sendHandshake(handshakeOperatorIds);
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
            console.log('🔄 用户点击重试启动');
            if (radioServiceRef.current) {
              radioServiceRef.current.startDecoding();
            }
          });
        }
        // 处理引擎启动失败
        else if (code === 'ENGINE_START_FAILED') {
          action = createRetryAction(() => {
            console.log('🔄 用户点击重试启动引擎');
            if (radioServiceRef.current) {
              radioServiceRef.current.startDecoding();
            }
          });
        }
        // 处理设备未找到 / 配置无效 → 提示打开配置
        else if (code === 'DEVICE_NOT_FOUND' || code === 'INVALID_CONFIG') {
          action = {
            label: '打开设置',
            handler: () => {
              window.dispatchEvent(new CustomEvent('openProfileModal'));
            }
          };
        }
        // 处理超时错误
        else if (code === 'TIMEOUT') {
          action = createRetryAction(() => {
            console.log('🔄 用户点击重试操作');
            // 注意：这里需要记录上次失败的操作才能重试
            // 暂时只是显示提示
            addToast({
              title: '提示',
              description: '请手动重试刚才的操作',
              color: 'primary',
              timeout: 3000
            });
          });
        }
        // 处理状态冲突
        else if (code === 'STATE_CONFLICT') {
          action = createRefreshStatusAction(() => {
            console.log('🔄 用户点击刷新状态');
            if (radioServiceRef.current) {
              radioServiceRef.current.getSystemStatus();
            }
          });
        }
        // 处理资源繁忙
        else if (code === 'RESOURCE_BUSY') {
          action = createRetryAction(() => {
            console.log('🔄 用户点击重试（资源繁忙）');
            addToast({
              title: '提示',
              description: '请稍后再试',
              color: 'primary',
              timeout: 2000
            });
          });
        }
        // 其他可重试错误
        else if (isRetryableError(code)) {
          action = createRetryAction(() => {
            console.log(`🔄 用户点击重试（错误代码：${code}）`);
            addToast({
              title: '提示',
              description: '请手动重试刚才的操作',
              color: 'primary',
              timeout: 3000
            });
          });
        }

        // 显示用户友好的错误 Toast
        showErrorToast({
          userMessage: userMessage || message || '发生未知错误',
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
          payload: new Error(message || '未知错误')
        });
      },
      slotPackUpdated: (data: unknown) => {
        slotPacksDispatch({ type: 'slotPackUpdated', payload: data as SlotPack });
      },
      qsoRecordAdded: (data: unknown) => {
        const qsoData = data as { operatorId: string; logBookId: string; qsoRecord: QSORecord };
        console.log('📝 [RadioProvider] 收到QSO记录添加事件:', qsoData);
        logbookDispatch({ type: 'qsoRecordAdded', payload: qsoData });
      },
      logbookUpdated: (data: unknown) => {
        const logbookData = data as { logBookId: string; statistics: LogBookStatistics };
        console.log('📊 [RadioProvider] 收到日志本更新事件:', logbookData);
        logbookDispatch({ type: 'logbookUpdated', payload: logbookData });
      },
      operatorsList: (data: unknown) => {
        const operatorsData = data as { operators: OperatorStatus[] };
        radioDispatch({ type: 'operatorsList', payload: operatorsData.operators });
      },
      operatorStatusUpdate: (data: unknown) => {
        radioDispatch({ type: 'operatorStatusUpdate', payload: data as OperatorStatus });
      },
      // 频率变化：清空本地 SlotPack 历史
      frequencyChanged: () => {
        console.log('📻 [RadioProvider] 频率变化，清空本地时隙历史');
        slotPacksDispatch({ type: 'CLEAR_DATA' });
      },
      // PTT状态变化
      pttStatusChanged: (data: unknown) => {
        const pttData = data as { isTransmitting: boolean; operatorIds: string[] };
        console.log(`📡 [RadioProvider] PTT状态变化: ${pttData.isTransmitting ? '开始发射' : '停止发射'}, 操作员=[${pttData.operatorIds?.join(', ') || ''}]`);
        radioDispatch({ type: 'pttStatusChanged', payload: pttData });
      },
      // 电台数值表数据
      meterData: (data: unknown) => {
        // 数值表数据频率较高，不打印日志
        radioDispatch({ type: 'meterData', payload: data as MeterData });
      },
      handshakeComplete: async (data: unknown) => {
        const handshakeData = data as { finalEnabledOperatorIds?: string[] };
        console.log('🤝 [RadioProvider] 握手完成:', handshakeData);
        if (handshakeData.finalEnabledOperatorIds) {
          console.log('💾 [RadioProvider] 新客户端，保存默认操作员偏好:', handshakeData.finalEnabledOperatorIds);
          setOperatorPreferences({
            enabledOperatorIds: handshakeData.finalEnabledOperatorIds,
            lastUpdated: Date.now()
          });
        }

        // 握手完成后，请求 Profile 列表
        // 注意：电台状态已通过 WSServer addConnection 的 radioStatusChanged 初始同步完成，
        // 后续状态变化通过 radioStatusChanged 事件实时推送，无需重复 API 请求。
        console.log('🔄 [RadioProvider] 握手完成，请求 Profile 列表');
        try {
          const { api } = await import('@tx5dr/core');
          const profilesResponse = await api.getProfiles();
          console.log('✅ [RadioProvider] Profile 列表已同步:', profilesResponse.profiles.length, '个 Profile');
          radioDispatch({
            type: 'setProfiles',
            payload: {
              profiles: profilesResponse.profiles,
              activeProfileId: profilesResponse.activeProfileId
            }
          });
        } catch (error) {
          console.error('❌ [RadioProvider] 获取 Profile 列表失败:', error);
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
          reason?: string;
          message?: string;
        };
        console.log('📡 [RadioProvider] 电台状态变化:', radioData.status || (radioData.connected ? 'connected' : 'disconnected'), radioData.reason || '');

        radioDispatch({
          type: 'radioStatusUpdate',
          payload: {
            radioConnected: radioData.connected,
            status: radioData.status,
            radioInfo: radioData.radioInfo,
            radioConfig: radioData.radioConfig,
            radioConnectionHealth: radioData.connectionHealth,
            reconnectProgress: radioData.reconnectProgress ?? null
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
        console.log('⚠️ [RadioProvider] 电台错误:', errorData);

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
        console.warn('🚨 [RadioProvider] 电台发射中断开连接:', data);
      },
      textMessage: (data: unknown) => {
        const msgData = data as { title: string; text: string; color?: string; timeout?: number | null };
        console.log('📬 [RadioProvider] 收到文本消息:', msgData);
        addToast({
          title: msgData.title,
          description: msgData.text,
          color: (msgData.color as "default" | "foreground" | "primary" | "secondary" | "success" | "warning" | "danger" | undefined) || 'default',
          timeout: msgData.timeout === null ? undefined : (msgData.timeout || 3000)
        });
      },
      // Profile 管理事件
      profileChanged: (data: unknown) => {
        const profileData = data as ProfileChangedEvent;
        console.log('📋 [RadioProvider] Profile 已切换:', profileData.profileId, profileData.profile.name);
        radioDispatch({ type: 'profileChanged', payload: profileData });
      },
      profileListUpdated: (data: unknown) => {
        const listData = data as { profiles: RadioProfile[]; activeProfileId: string | null };
        console.log('📋 [RadioProvider] Profile 列表已更新:', listData.profiles.length, '个 Profile');
        radioDispatch({ type: 'profileListUpdated', payload: listData });
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

  const combinedState: CombinedState = {
    connection: connectionState,
    radio: radioState,
    slotPacks: slotPacksState,
    logbook: logbookState
  };

  const combinedDispatch: CombinedDispatch = {
    connectionDispatch,
    radioDispatch,
    slotPacksDispatch,
    logbookDispatch
  };

  return React.createElement(
    RadioContext.Provider,
    { value: { state: combinedState, dispatch: combinedDispatch } },
    children
  );
};

// Hook for using the radio context
export const useRadio = () => {
  const context = useContext(RadioContext);
  if (context === undefined) {
    throw new Error('useRadio must be used within a RadioProvider');
  }
  return context;
};

// 便捷的单独hooks
export const useConnection = () => {
  const { state, dispatch } = useRadio();
  return {
    state: state.connection,
    dispatch: dispatch.connectionDispatch
  };
};

export const useRadioState = () => {
  const { state, dispatch } = useRadio();
  return {
    state: state.radio,
    dispatch: dispatch.radioDispatch
  };
};

export const useSlotPacks = () => {
  const { state, dispatch } = useRadio();
  return {
    state: state.slotPacks,
    dispatch: dispatch.slotPacksDispatch
  };
}; 

export const useOperators = () => {
  const { state } = useRadio();
  return {
    operators: state.radio.operators || [],
  };
};

export const useCurrentOperatorId = () => {
  const { state, dispatch } = useRadio();
  return {
    currentOperatorId: state.radio.currentOperatorId || state.radio.operators?.[0]?.id,
    setCurrentOperatorId: (operatorId: string) => {
      // 只更新前端状态，不发送到后端
      dispatch.radioDispatch({ type: 'setCurrentOperator', payload: operatorId });
    }
  };
};

export const useLogbook = () => {
  const { state, dispatch } = useRadio();
  return {
    state: state.logbook,
    dispatch: dispatch.logbookDispatch,
    // 便捷方法
    getQSOsForOperator: (operatorId: string) => state.logbook.qsosByOperator.get(operatorId) || [],
    getStatisticsForLogbook: (logBookId: string) => state.logbook.statisticsByLogbook.get(logBookId),
    addQSORecord: (data: { operatorId: string; logBookId: string; qsoRecord: QSORecord }) => {
      dispatch.logbookDispatch({ type: 'qsoRecordAdded', payload: data });
    },
    loadQSOs: (operatorId: string, qsos: QSORecord[]) => {
      dispatch.logbookDispatch({ type: 'loadQSOs', payload: { operatorId, qsos } });
    }
  };
};

export const useProfiles = () => {
  const { state } = useRadio();
  const activeProfile = state.radio.profiles.find(p => p.id === state.radio.activeProfileId) ?? null;
  return {
    profiles: state.radio.profiles,
    activeProfileId: state.radio.activeProfileId,
    activeProfile,
  };
};

export const useRadioErrors = () => {
  const { state, dispatch } = useRadio();
  return {
    errors: state.radio.radioErrors,
    latestError: state.radio.latestRadioError,
    clearErrors: () => dispatch.radioDispatch({ type: 'clearRadioErrors' }),
  };
};
