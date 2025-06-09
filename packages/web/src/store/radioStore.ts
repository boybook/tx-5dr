import { create } from 'zustand';
import React, { useEffect, useRef, ReactNode } from 'react';
import type { SlotPack, ModeDescriptor, OperatorStatus } from '@tx5dr/contracts';
import { RadioService } from '../services/radioService';
import { getHandshakeOperatorIds, setOperatorPreferences } from '../utils/operatorPreferences';

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

export interface RadioState {
  isDecoding: boolean;
  currentMode: ModeDescriptor | null;
  systemStatus: any;
  operators: OperatorStatus[];
  currentOperatorId: string | null;
}

export interface SlotPacksState {
  slotPacks: SlotPack[];
  totalMessages: number;
  lastUpdateTime: Date | null;
}

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

const initialRadioState: RadioState = {
  isDecoding: false,
  currentMode: null,
  systemStatus: null,
  operators: [],
  currentOperatorId: null
};

const initialSlotPacksState: SlotPacksState = {
  slotPacks: [],
  totalMessages: 0,
  lastUpdateTime: null
};

interface RadioStore {
  connection: ConnectionState;
  radio: RadioState;
  slotPacks: SlotPacksState;
  setRadioService: (rs: RadioService) => void;
  updateConnection: (info: Partial<ConnectionState>) => void;
  updateRadio: (info: Partial<RadioState>) => void;
  updateOperatorStatus: (operator: OperatorStatus) => void;
  addSlotPack: (slotPack: SlotPack) => void;
  clearSlotPacks: () => void;
  setCurrentOperatorId: (id: string) => void;
}

export const useRadioStore = create<RadioStore>((set, get) => ({
  connection: initialConnectionState,
  radio: initialRadioState,
  slotPacks: initialSlotPacksState,
  setRadioService: (rs) => set(state => ({ connection: { ...state.connection, radioService: rs } })),
  updateConnection: (info) => set(state => ({ connection: { ...state.connection, ...info } })),
  updateRadio: (info) => set(state => ({ radio: { ...state.radio, ...info } })),
  updateOperatorStatus: (operator) => set(state => ({
    radio: {
      ...state.radio,
      operators: state.radio.operators.map(op => op.id === operator.id ? operator : op)
    }
  })),
  addSlotPack: (slotPack) => set(state => {
    const existingIndex = state.slotPacks.slotPacks.findIndex(sp => sp.slotId === slotPack.slotId);
    let updated = [...state.slotPacks.slotPacks];
    if (existingIndex >= 0) {
      updated[existingIndex] = slotPack;
    } else {
      updated.push(slotPack);
    }
    updated.sort((a, b) => a.startMs - b.startMs);
    if (updated.length > 50) {
      updated = updated.slice(-50);
    }
    const totalMessages = updated.reduce((sum, sp) => sum + sp.frames.length, 0);
    return { slotPacks: { slotPacks: updated, totalMessages, lastUpdateTime: new Date() } };
  }),
  clearSlotPacks: () => set({ slotPacks: initialSlotPacksState }),
  setCurrentOperatorId: (id) => set(state => ({ radio: { ...state.radio, currentOperatorId: id } }))
}));

export const RadioProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const setRadioService = useRadioStore(s => s.setRadioService);
  const updateConnection = useRadioStore(s => s.updateConnection);
  const updateRadio = useRadioStore(s => s.updateRadio);
  const updateOperatorStatus = useRadioStore(s => s.updateOperatorStatus);
  const addSlotPack = useRadioStore(s => s.addSlotPack);

  const radioServiceRef = useRef<RadioService | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (radioServiceRef.current) return;
    const radioService = new RadioService();
    radioServiceRef.current = radioService;
    setRadioService(radioService);

    radioService.on('connected', () => {
      updateConnection({ isConnected: true, isConnecting: false, isReconnecting: false, reconnectAttempts: 0, hasReachedMaxAttempts: false });
      const ids = getHandshakeOperatorIds();
      radioService.sendHandshake(ids);
    });

    radioService.on('disconnected', () => {
      updateConnection({ isConnected: false, isConnecting: false });
    });

    radioService.on('modeChanged', (mode: ModeDescriptor) => {
      updateRadio({ currentMode: mode });
    });

    radioService.on('systemStatus', (status: any) => {
      updateRadio({ systemStatus: status, isDecoding: status?.isDecoding || false, currentMode: status?.currentMode || get().radio.currentMode });
    });

    radioService.on('slotPackUpdated', (slotPack: SlotPack) => {
      addSlotPack(slotPack);
    });

    radioService.on('operatorsList', (data: { operators: OperatorStatus[] }) => {
      updateRadio({ operators: data.operators || [] });
    });

    radioService.on('operatorStatusUpdate', (operator: OperatorStatus) => {
      updateOperatorStatus(operator);
    });

    radioService.on('handshakeComplete', (data: any) => {
      if (data.finalEnabledOperatorIds) {
        setOperatorPreferences({
          enabledOperatorIds: data.finalEnabledOperatorIds,
          lastUpdated: Date.now()
        });
      }
    });

    (radioService as any).on('reconnecting', (info: any) => {
      updateConnection({
        isReconnecting: true,
        reconnectAttempts: info.attempt,
        maxReconnectAttempts: info.maxAttempts,
        hasReachedMaxAttempts: false,
        lastReconnectInfo: info
      });
    });

    (radioService as any).on('reconnectStopped', (info: any) => {
      updateConnection({
        isReconnecting: false,
        hasReachedMaxAttempts: info.reason === 'maxAttemptsReached'
      });
    });

    timerRef.current = setInterval(() => {
      if (radioServiceRef.current) {
        const status = radioServiceRef.current.getConnectionStatus();
        updateConnection(status);
      }
    }, 1000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      radioServiceRef.current?.disconnect();
      radioServiceRef.current = null;
    };
  }, []);

  return <>{children}</>;
};

export const useConnection = () => {
  const state = useRadioStore(s => s.connection);
  return { state };
};

export const useRadioState = () => {
  const state = useRadioStore(s => s.radio);
  return { state };
};

export const useSlotPacks = () => {
  const state = useRadioStore(s => s.slotPacks);
  return { state };
};

export const useOperators = () => {
  return { operators: useRadioStore(s => s.radio.operators) };
};

export const useCurrentOperatorId = () => {
  const currentOperatorId = useRadioStore(s => s.radio.currentOperatorId || s.radio.operators?.[0]?.id);
  const setCurrentOperatorId = useRadioStore(s => s.setCurrentOperatorId);
  return { currentOperatorId, setCurrentOperatorId };
};
