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
  RadioInfo
} from '@tx5dr/contracts';
import { RadioService } from '../services/radioService';
import { getHandshakeOperatorIds, setOperatorPreferences } from '../utils/operatorPreferences';
import {
  showErrorToast,
  createRetryConnectionAction,
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
  radioInfo: RadioInfo | null;
  radioConfig: HamlibConfig;
  // PTT状态
  pttStatus: {
    isTransmitting: boolean;
    operatorIds: string[];
  };
  // 电台数值表数据
  meterData: MeterData | null;
  // 电台连接状态信息
  radioReconnectInfo: {
    isReconnecting: boolean;
    connectionHealthy: boolean;
  } | null;
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

// 重连信息数据结构
export interface ReconnectInfo {
  isReconnecting: boolean;
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
  | { type: 'radioStatusUpdate'; payload: { radioConnected: boolean; radioInfo: RadioInfo | null; radioConfig: HamlibConfig; radioReconnectInfo?: ReconnectInfo } }
  | { type: 'updateReconnectInfo'; payload: ReconnectInfo }
  | { type: 'pttStatusChanged'; payload: { isTransmitting: boolean; operatorIds: string[] } }
  | { type: 'meterData'; payload: MeterData };

const initialRadioState: RadioState = {
  isDecoding: false,
  currentMode: null,
  systemStatus: null,
  operators: [],
  currentOperatorId: null,
  radioConnected: false,
  radioInfo: null,
  radioConfig: { type: 'none' },
  pttStatus: {
    isTransmitting: false,
    operatorIds: []
  },
  meterData: null,
  radioReconnectInfo: null
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
        radioInfo: action.payload.radioInfo,
        // 如果事件中包含radioConfig则更新，否则保持现有配置
        radioConfig: action.payload.radioConfig || state.radioConfig,
        // 同步重连信息（如果事件中包含）
        radioReconnectInfo: action.payload.radioReconnectInfo !== undefined
          ? action.payload.radioReconnectInfo
          : state.radioReconnectInfo
      };

    case 'updateReconnectInfo':
      return {
        ...state,
        radioReconnectInfo: action.payload
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

        // 处理连接失败错误
        if (code === 'CONNECTION_FAILED' || code === 'RADIO_CONNECTION_FAILED') {
          action = createRetryConnectionAction(() => {
            console.log('🔄 用户点击重试连接');
            if (radioServiceRef.current) {
              // 尝试重新连接电台
              radioServiceRef.current.wsClientInstance.send('connectRadio', {});
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

        // 握手完成后，主动请求电台状态以确保状态同步
        console.log('🔄 [RadioProvider] 握手完成，主动请求电台状态');
        try {
          const { api } = await import('@tx5dr/core');
          const status = await api.getRadioStatus();
          if (status.success && status.status) {
            console.log('✅ [RadioProvider] 电台状态已同步:', {
              radioConnected: status.status.connected,
              radioInfo: status.status.radioInfo,
              configType: status.status.radioConfig?.type
            });
            radioDispatch({
              type: 'radioStatusUpdate',
              payload: {
                radioConnected: status.status.connected,
                radioInfo: status.status.radioInfo,
                radioConfig: status.status.radioConfig || { type: 'none' }
              }
            });
          }
        } catch (error) {
          console.error('❌ [RadioProvider] 获取电台状态失败:', error);
        }
      },
      radioStatusChanged: (data: unknown) => {
        const radioData = data as {
          connected: boolean;
          radioInfo: RadioInfo | null;
          radioConfig: HamlibConfig;
          reconnectInfo?: ReconnectInfo;
          reason?: string;
        };
        console.log('📡 [RadioProvider] 电台状态变化:', radioData.connected ? '已连接' : '已断开', radioData.reason || '');

        radioDispatch({
          type: 'radioStatusUpdate',
          payload: {
            radioConnected: radioData.connected,
            radioInfo: radioData.radioInfo, // 直接使用事件中的完整数据（连接时有值，断开时为null）
            radioConfig: radioData.radioConfig, // 直接使用事件中的配置（始终包含完整配置）
            radioReconnectInfo: radioData.reconnectInfo // 同步重连信息（连接成功后会重置为 isReconnecting: false）
          }
        });
      },
      radioReconnecting: (data: unknown) => {
        const reconnectData = data as { reconnectInfo?: ReconnectInfo };
        console.log('🔄 [RadioProvider] 电台重连中:', reconnectData);
        // 更新重连状态到 Redux
        if (reconnectData.reconnectInfo) {
          radioDispatch({
            type: 'updateReconnectInfo',
            payload: reconnectData.reconnectInfo
          });
        }
      },
      radioReconnectFailed: (data: unknown) => {
        console.log('❌ [RadioProvider] 电台重连失败:', data);
      },
      radioReconnectStopped: (data: unknown) => {
        console.log('⏹️ [RadioProvider] 电台重连已停止:', data);
      },
      radioError: (data: unknown) => {
        console.log('⚠️ [RadioProvider] 电台错误:', data);
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
