import React, { createContext, useContext, useReducer, useEffect, ReactNode } from 'react';
import type { SlotPack, ModeDescriptor, DigitalRadioEngineEvents } from '@tx5dr/contracts';
import { RadioService } from '../services/radioService';

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
}

export type RadioAction = 
  | { type: 'modeChanged'; payload: ModeDescriptor }
  | { type: 'systemStatus'; payload: any }
  | { type: 'decodeError'; payload: any }
  | { type: 'error'; payload: Error };

const initialRadioState: RadioState = {
  isDecoding: false,
  currentMode: null,
  systemStatus: null
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
        // 从systemStatus中提取isDecoding状态
        isDecoding: action.payload?.isDecoding || false,
        // 从systemStatus中提取当前模式
        currentMode: action.payload?.currentMode || state.currentMode
      };
    
    case 'decodeError':
      console.warn('解码错误:', action.payload);
      return state;
    
    case 'error':
      console.error('RadioService错误:', action.payload);
      return state;
    
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

  // 初始化RadioService
  useEffect(() => {
    const radioService = new RadioService();
    
    // 设置事件监听器 - 分发到不同的reducer
    radioService.on('connected', () => {
      connectionDispatch({ type: 'connected' });
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

    connectionDispatch({ type: 'SET_RADIO_SERVICE', payload: radioService });

    // 清理函数
    return () => {
      radioService.disconnect();
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