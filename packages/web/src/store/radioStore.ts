import React, { createContext, useContext, useReducer, useEffect, ReactNode } from 'react';
import type { SlotPack, ModeDescriptor, DigitalRadioEngineEvents } from '@tx5dr/contracts';
import { RadioService } from '../services/radioService';

// 状态接口定义
export interface RadioState {
  slotPacks: SlotPack[];
  isConnected: boolean;
  isDecoding: boolean;
  totalMessages: number;
  lastUpdateTime: Date | null;
  radioService: RadioService | null;
  currentMode: ModeDescriptor | null;
  systemStatus: any;
}

// 动作类型定义 - 直接对应WebSocket事件
export type RadioAction = 
  // WebSocket事件对应的actions
  | { type: 'slotPackUpdated'; payload: SlotPack }
  | { type: 'connected' }
  | { type: 'disconnected' }
  | { type: 'clockStarted' }
  | { type: 'clockStopped' }
  | { type: 'modeChanged'; payload: ModeDescriptor }
  | { type: 'systemStatus'; payload: any }
  | { type: 'decodeError'; payload: any }
  | { type: 'error'; payload: Error }
  // 内部管理actions
  | { type: 'SET_RADIO_SERVICE'; payload: RadioService }
  | { type: 'CLEAR_DATA' };

// 初始状态
const initialState: RadioState = {
  slotPacks: [],
  isConnected: false,
  isDecoding: false,
  totalMessages: 0,
  lastUpdateTime: null,
  radioService: null,
  currentMode: null,
  systemStatus: null
};

// Reducer函数
function radioReducer(state: RadioState, action: RadioAction): RadioState {
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
    
    case 'connected':
      return {
        ...state,
        isConnected: true
      };
    
    case 'disconnected':
      return {
        ...state,
        isConnected: false,
        isDecoding: false
      };
    
    case 'clockStarted':
      return {
        ...state,
        isDecoding: true
      };
    
    case 'clockStopped':
      return {
        ...state,
        isDecoding: false
      };
    
    case 'modeChanged':
      return {
        ...state,
        currentMode: action.payload
      };
    
    case 'systemStatus':
      return {
        ...state,
        systemStatus: action.payload
      };
    
    case 'decodeError':
      console.warn('解码错误:', action.payload);
      return state;
    
    case 'error':
      console.error('RadioService错误:', action.payload);
      return state;
    
    case 'CLEAR_DATA':
      return {
        ...state,
        slotPacks: [],
        totalMessages: 0,
        lastUpdateTime: null
      };
    
    case 'SET_RADIO_SERVICE':
      return {
        ...state,
        radioService: action.payload
      };
    
    default:
      return state;
  }
}

// Context创建
const RadioContext = createContext<{
  state: RadioState;
  dispatch: React.Dispatch<RadioAction>;
} | undefined>(undefined);

// Provider组件
export const RadioProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [state, dispatch] = useReducer(radioReducer, initialState);

  // 初始化RadioService
  useEffect(() => {
    const radioService = new RadioService();
    
    // 设置事件监听器 - 直接映射WebSocket事件到Redux actions
    const eventMappings: Array<{
      event: keyof DigitalRadioEngineEvents;
      actionType: RadioAction['type'];
    }> = [
      { event: 'slotPackUpdated', actionType: 'slotPackUpdated' },
      { event: 'connected', actionType: 'connected' },
      { event: 'disconnected', actionType: 'disconnected' },
      { event: 'clockStarted', actionType: 'clockStarted' },
      { event: 'clockStopped', actionType: 'clockStopped' },
      { event: 'modeChanged', actionType: 'modeChanged' },
      { event: 'systemStatus', actionType: 'systemStatus' },
      { event: 'decodeError', actionType: 'decodeError' },
      { event: 'error', actionType: 'error' }
    ];

    eventMappings.forEach(({ event, actionType }) => {
      radioService.on(event, (payload?: any) => {
        if (payload !== undefined) {
          dispatch({ type: actionType, payload } as RadioAction);
        } else {
          dispatch({ type: actionType } as RadioAction);
        }
      });
    });

    dispatch({ type: 'SET_RADIO_SERVICE', payload: radioService });

    // 清理函数
    return () => {
      radioService.disconnect();
    };
  }, []);

  return React.createElement(
    RadioContext.Provider,
    { value: { state, dispatch } },
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