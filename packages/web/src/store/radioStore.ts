import React, { createContext, useContext, useReducer, useEffect, useRef, ReactNode } from 'react';
import type { SlotPack, ModeDescriptor, DigitalRadioEngineEvents, OperatorStatus, QSORecord, LogBookStatistics } from '@tx5dr/contracts';
import { RadioService } from '../services/radioService';
import { getEnabledOperatorIds, getHandshakeOperatorIds, setOperatorPreferences } from '../utils/operatorPreferences';

// ===== 连接状态管理 =====
export interface ConnectionState {
  isConnected: boolean;
  isConnecting: boolean;
  isReconnecting: boolean;
  reconnectAttempts: number;
  maxReconnectAttempts: number;
  hasReachedMaxAttempts: boolean;
  lastReconnectInfo: any;
  radioService: RadioService | null;
}

export type ConnectionAction = 
  | { type: 'connected' }
  | { type: 'disconnected' }
  | { type: 'reconnecting'; payload: any }
  | { type: 'reconnectStopped'; payload: any }
  | { type: 'updateConnectionInfo'; payload: any }
  | { type: 'SET_RADIO_SERVICE'; payload: RadioService };

const initialConnectionState: ConnectionState = {
  isConnected: false,
  isConnecting: false,
  isReconnecting: false,
  reconnectAttempts: 0,
  maxReconnectAttempts: -1,
  hasReachedMaxAttempts: false,
  lastReconnectInfo: null,
  radioService: null
};

function connectionReducer(state: ConnectionState, action: ConnectionAction): ConnectionState {
  switch (action.type) {
    case 'connected':
      return { 
        ...state, 
        isConnected: true, 
        isConnecting: false,
        isReconnecting: false,
        reconnectAttempts: 0,
        hasReachedMaxAttempts: false
      };
    case 'disconnected':
      return { ...state, isConnected: false, isConnecting: false };
    case 'reconnecting':
      return { 
        ...state, 
        isReconnecting: true,
        reconnectAttempts: action.payload.attempt,
        maxReconnectAttempts: action.payload.maxAttempts,
        hasReachedMaxAttempts: false,
        lastReconnectInfo: action.payload
      };
    case 'reconnectStopped':
      return { 
        ...state, 
        isReconnecting: false,
        hasReachedMaxAttempts: state.maxReconnectAttempts !== -1 && action.payload.reason === 'maxAttemptsReached'
      };
    case 'updateConnectionInfo':
      return {
        ...state,
        isConnecting: action.payload.isConnecting,
        isReconnecting: action.payload.isReconnecting,
        reconnectAttempts: action.payload.reconnectAttempts,
        maxReconnectAttempts: action.payload.maxReconnectAttempts,
        hasReachedMaxAttempts: action.payload.maxReconnectAttempts !== -1 && action.payload.hasReachedMaxAttempts
      };
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
  systemStatus: any;
  operators: OperatorStatus[];
  currentOperatorId: string | null;
  // 电台连接状态
  radioConnected: boolean;
  radioInfo: {
    manufacturer?: string;
    model?: string;
    rigModel?: number;
  } | null;
  radioConfig: any;
  // PTT状态
  pttStatus: {
    isTransmitting: boolean;
    operatorIds: string[];
  };
}

export type RadioAction =
  | { type: 'modeChanged'; payload: ModeDescriptor }
  | { type: 'systemStatus'; payload: any }
  | { type: 'decodeError'; payload: any }
  | { type: 'error'; payload: Error }
  | { type: 'operatorsList'; payload: OperatorStatus[] }
  | { type: 'operatorStatusUpdate'; payload: OperatorStatus }
  | { type: 'setCurrentOperator'; payload: string }
  | { type: 'radioStatusUpdate'; payload: { radioConnected: boolean; radioInfo: any; radioConfig: any } }
  | { type: 'pttStatusChanged'; payload: { isTransmitting: boolean; operatorIds: string[] } };

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
  }
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
        // 只有当payload中有有效的radioConfig时才更新，否则保持现有配置
        radioConfig: (action.payload.radioConfig && action.payload.radioConfig.type !== 'none')
          ? action.payload.radioConfig
          : state.radioConfig
      };

    case 'pttStatusChanged':
      return {
        ...state,
        pttStatus: {
          isTransmitting: action.payload.isTransmitting,
          operatorIds: action.payload.operatorIds
        }
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
    const eventMap: Record<string, (...args: any[]) => void> = {
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
      modeChanged: (mode: ModeDescriptor) => {
        radioDispatch({ type: 'modeChanged', payload: mode });
      },
      systemStatus: (status: any) => {
        radioDispatch({ type: 'systemStatus', payload: status });
      },
      decodeError: (errorInfo: any) => {
        radioDispatch({ type: 'decodeError', payload: errorInfo });
      },
      error: (error: Error) => {
        radioDispatch({ type: 'error', payload: error });
      },
      slotPackUpdated: (slotPack: SlotPack) => {
        slotPacksDispatch({ type: 'slotPackUpdated', payload: slotPack });
      },
      qsoRecordAdded: (data: { operatorId: string; logBookId: string; qsoRecord: QSORecord }) => {
        console.log('📝 [RadioProvider] 收到QSO记录添加事件:', data);
        logbookDispatch({ type: 'qsoRecordAdded', payload: data });
      },
      logbookUpdated: (data: { logBookId: string; statistics: LogBookStatistics }) => {
        console.log('📊 [RadioProvider] 收到日志本更新事件:', data);
        logbookDispatch({ type: 'logbookUpdated', payload: data });
      },
      operatorsList: (data: { operators: OperatorStatus[] }) => {
        radioDispatch({ type: 'operatorsList', payload: data.operators });
      },
      operatorStatusUpdate: (operatorStatus: OperatorStatus) => {
        radioDispatch({ type: 'operatorStatusUpdate', payload: operatorStatus });
      },
      // 频率变化：清空本地 SlotPack 历史
      frequencyChanged: (_data: any) => {
        console.log('📻 [RadioProvider] 频率变化，清空本地时隙历史');
        slotPacksDispatch({ type: 'CLEAR_DATA' });
      },
      // PTT状态变化
      pttStatusChanged: (data: { isTransmitting: boolean; operatorIds: string[] }) => {
        console.log(`📡 [RadioProvider] PTT状态变化: ${data.isTransmitting ? '开始发射' : '停止发射'}, 操作员=[${data.operatorIds?.join(', ') || ''}]`);
        radioDispatch({ type: 'pttStatusChanged', payload: data });
      },
      handshakeComplete: (data: any) => {
        console.log('🤝 [RadioProvider] 握手完成:', data);
        if (data.finalEnabledOperatorIds) {
          console.log('💾 [RadioProvider] 新客户端，保存默认操作员偏好:', data.finalEnabledOperatorIds);
          setOperatorPreferences({
            enabledOperatorIds: data.finalEnabledOperatorIds,
            lastUpdated: Date.now()
          });
        }
      },
      reconnecting: (reconnectInfo: any) => {
        console.log('🔄 [RadioProvider] 正在重连:', reconnectInfo);
        connectionDispatch({ type: 'reconnecting', payload: reconnectInfo });
      },
      reconnectStopped: (stopInfo: any) => {
        console.log('⏹️ [RadioProvider] 重连已停止:', stopInfo);
        connectionDispatch({ type: 'reconnectStopped', payload: stopInfo });
      },
      radioStatusChanged: (data: any) => {
        console.log('📡 [RadioProvider] 电台状态变化:', data.connected ? '已连接' : '已断开', data.reason || '');
        
        radioDispatch({ 
          type: 'radioStatusUpdate',
          payload: {
            radioConnected: data.connected,
            radioInfo: data.connected ? (data.radioInfo || null) : null, // 断开时清空radioInfo
            radioConfig: data.radioConfig || { type: 'none' } // reducer会智能处理配置保持
          }
        });
      },
      radioReconnecting: (data: any) => {
        console.log('🔄 [RadioProvider] 电台重连中:', data);
      },
      radioReconnectFailed: (data: any) => {
        console.log('❌ [RadioProvider] 电台重连失败:', data);
      },
      radioReconnectStopped: (data: any) => {
        console.log('⏹️ [RadioProvider] 电台重连已停止:', data);
      },
      radioError: (data: any) => {
        console.log('⚠️ [RadioProvider] 电台错误:', data);
      },
      radioDisconnectedDuringTransmission: (data: any) => {
        console.warn('🚨 [RadioProvider] 电台发射中断开连接:', data);
      }
    };

    Object.entries(eventMap).forEach(([event, handler]) => {
      radioService.on(event as any, handler as any);
    });

    connectionDispatch({ type: 'SET_RADIO_SERVICE', payload: radioService });

    // 启动连接状态定期更新
    connectionStatusTimerRef.current = setInterval(() => {
      if (radioServiceRef.current) {
        const connectionStatus = radioServiceRef.current.getConnectionStatus();
        connectionDispatch({ type: 'updateConnectionInfo', payload: connectionStatus });
      }
    }, 1000); // 每秒更新一次连接状态

    // 清理函数
    return () => {
      if (connectionStatusTimerRef.current) {
        clearInterval(connectionStatusTimerRef.current);
        connectionStatusTimerRef.current = null;
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
