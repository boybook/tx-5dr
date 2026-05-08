import { useCallback } from 'react';
import { useConnection, useRadioState } from '../store/radioStore';
import type { CWKeyerStatus, CWKeyerConfig } from '@tx5dr/contracts';
import { WSMessageType } from '@tx5dr/contracts';

/**
 * CW 键控器 Hook — 封装 WebSocket 通信和状态订阅
 */
export function useCWKeyer() {
  const connection = useConnection();
  const radioState = useRadioState();
  const radioService = connection.state.radioService;

  const cwKeyerStatus: CWKeyerStatus | null = radioState.state.cwKeyerStatus;
  const cwConfig: CWKeyerConfig | null = radioState.state.cwConfig;
  const engineMode = radioState.state.engineMode;
  const isCWMode = engineMode === 'cw';

  const sendKeyAction = useCallback((action: 'key-down' | 'key-up') => {
    if (!radioService) return;
    radioService.wsClientInstance.send(WSMessageType.CW_KEY_ACTION, { action });
  }, [radioService]);

  const sendText = useCallback((text: string, callsign?: string) => {
    if (!radioService) return;
    radioService.wsClientInstance.send(WSMessageType.CW_TEXT_INPUT, { text, callsign });
  }, [radioService]);

  const playMessage = useCallback((callsign: string, slotId: string, repeat: boolean) => {
    if (!radioService) return;
    radioService.wsClientInstance.send(WSMessageType.CW_PLAY_MESSAGE, { callsign, slotId, repeat });
  }, [radioService]);

  const stopMessage = useCallback(() => {
    if (!radioService) return;
    radioService.wsClientInstance.send(WSMessageType.CW_STOP_MESSAGE, {});
  }, [radioService]);

  return {
    cwKeyerStatus,
    cwConfig,
    isCWMode,
    sendKeyAction,
    sendText,
    playMessage,
    stopMessage,
  };
}
