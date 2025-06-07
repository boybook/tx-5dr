import React, { createContext, useContext, useReducer, useEffect, useRef, ReactNode, useState } from 'react';
import type { SlotPack, ModeDescriptor, DigitalRadioEngineEvents, OperatorStatus } from '@tx5dr/contracts';
import { RadioService } from '../services/radioService';
import { getEnabledOperatorIds, getHandshakeOperatorIds, setOperatorPreferences } from '../utils/operatorPreferences';

// ===== 连接状态管理 =====
export interface ConnectionState {
  isConnected: boolean;
  radioService: RadioService | null;
}

export type ConnectionAction = 
  | { type: 'connected' }
  | { type: 'disconnected' }
  | { type: 'SET_RADIO_SERVICE'; payload: RadioService };

const initialConnectionState: ConnectionState = {
  isConnected: false,
  radioService: null
};

function connectionReducer(state: ConnectionState, action: ConnectionAction): ConnectionState {
  switch (action.type) {
    case 'connected':
      return { ...state, isConnected: true };
    case 'disconnected':
      return { ...state, isConnected: false };
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
}

export type RadioAction = 
  | { type: 'modeChanged'; payload: ModeDescriptor }
  | { type: 'systemStatus'; payload: any }
  | { type: 'decodeError'; payload: any }
  | { type: 'error'; payload: Error }
  | { type: 'operatorsList'; payload: OperatorStatus[] }
  | { type: 'operatorStatusUpdate'; payload: OperatorStatus }
  | { type: 'setCurrentOperator'; payload: string };

const initialRadioState: RadioState = {
  isDecoding: false,
  currentMode: null,
  systemStatus: null,
  operators: [],
  currentOperatorId: null
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

const initialSlotPacksState: SlotPacksState = {
  slotPacks: [],
  totalMessages: 0,
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

// ===== 组合状态和Context =====
export interface CombinedState {
  connection: ConnectionState;
  radio: RadioState;
  slotPacks: SlotPacksState;
}

export interface CombinedDispatch {
  connectionDispatch: React.Dispatch<ConnectionAction>;
  radioDispatch: React.Dispatch<RadioAction>;
  slotPacksDispatch: React.Dispatch<SlotPacksAction>;
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
  
  // 使用 useRef 确保 RadioService 单例，避免 StrictMode 导致的重复创建
  const radioServiceRef = useRef<RadioService | null>(null);

  // 初始化RadioService
  useEffect(() => {
    // 如果已经有实例，直接返回，避免重复创建
    if (radioServiceRef.current) {
      return;
    }
    
    const radioService = new RadioService();
    radioServiceRef.current = radioService;
    
    // 设置事件监听器 - 分发到不同的reducer
    radioService.on('connected', () => {
      connectionDispatch({ type: 'connected' });
      
      // 连接成功后立即发送握手消息（包含操作员偏好设置）
      const handshakeOperatorIds = getHandshakeOperatorIds();
      
      console.log('🤝 [RadioProvider] 连接成功，发送握手消息:', {
        enabledOperatorIds: handshakeOperatorIds
      });
      
      radioService.sendHandshake(handshakeOperatorIds);
    });

    radioService.on('disconnected', () => {
      connectionDispatch({ type: 'disconnected' });
    });

    radioService.on('modeChanged', (mode: ModeDescriptor) => {
      radioDispatch({ type: 'modeChanged', payload: mode });
    });

    radioService.on('systemStatus', (status: any) => {
      radioDispatch({ type: 'systemStatus', payload: status });
    });

    radioService.on('decodeError', (errorInfo: any) => {
      radioDispatch({ type: 'decodeError', payload: errorInfo });
    });

    radioService.on('error', (error: Error) => {
      radioDispatch({ type: 'error', payload: error });
    });

    radioService.on('slotPackUpdated', (slotPack: SlotPack) => {
      slotPacksDispatch({ type: 'slotPackUpdated', payload: slotPack });
    });

    radioService.on('operatorsList', (data: { operators: OperatorStatus[] }) => {
      radioDispatch({ type: 'operatorsList', payload: data.operators });
    });

    radioService.on('operatorStatusUpdate', (operatorStatus: OperatorStatus) => {
      radioDispatch({ type: 'operatorStatusUpdate', payload: operatorStatus });
    });

    radioService.on('handshakeComplete' as any, (data: any) => {
      console.log('🤝 [RadioProvider] 握手完成:', data);
      
      // 如果是新客户端，保存服务端确定的操作员列表到本地
      if (data.finalEnabledOperatorIds) {
        console.log('💾 [RadioProvider] 新客户端，保存默认操作员偏好:', data.finalEnabledOperatorIds);
        setOperatorPreferences({
          enabledOperatorIds: data.finalEnabledOperatorIds,
          lastUpdated: Date.now()
        });
      }
      
      // 握手完成后，所有过滤数据都已正确接收
    });

    connectionDispatch({ type: 'SET_RADIO_SERVICE', payload: radioService });

    // 清理函数
    return () => {
      if (radioServiceRef.current) {
        radioServiceRef.current.disconnect();
        radioServiceRef.current = null;
      }
    };
  }, []);

  const combinedState: CombinedState = {
    connection: connectionState,
    radio: radioState,
    slotPacks: slotPacksState
  };

  const combinedDispatch: CombinedDispatch = {
    connectionDispatch,
    radioDispatch,
    slotPacksDispatch
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