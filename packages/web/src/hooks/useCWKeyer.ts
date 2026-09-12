import { useCallback } from 'react';
import { useConnection, useCurrentOperatorId, useCWState, useRadioModeState } from '../store/radioStore';
import type { CWPlaceholderValues } from '@tx5dr/contracts';
import { WSMessageType } from '@tx5dr/contracts';

/**
 * CW 键控器 Hook — 封装 WebSocket 通信和状态订阅
 */
export function useCWKeyer() {
  const connection = useConnection();
  const { cwKeyerStatus, cwConfig } = useCWState();
  const { engineMode } = useRadioModeState();
  const { currentOperatorId } = useCurrentOperatorId();
  const radioService = connection.state.radioService;

  const isCWMode = engineMode === 'cw';

  const sendKeyAction = useCallback((action: 'key-down' | 'key-up') => {
    if (!radioService || !currentOperatorId) return;
    radioService.wsClientInstance.send(WSMessageType.CW_KEY_ACTION, { action, operatorId: currentOperatorId });
  }, [currentOperatorId, radioService]);

  const sendText = useCallback((text: string, callsign?: string, placeholderValues?: CWPlaceholderValues) => {
    if (!radioService || !currentOperatorId) return;
    radioService.wsClientInstance.send(WSMessageType.CW_TEXT_INPUT, { text, callsign, placeholderValues, operatorId: currentOperatorId });
  }, [currentOperatorId, radioService]);

  const playMessage = useCallback((
    callsign: string,
    slotId: string,
    repeat: boolean,
    startImmediately = true,
    placeholderValues?: CWPlaceholderValues,
  ) => {
    if (!radioService || !currentOperatorId) return;
    radioService.wsClientInstance.send(WSMessageType.CW_PLAY_MESSAGE, {
      callsign,
      slotId,
      repeat,
      startImmediately,
      placeholderValues,
      operatorId: currentOperatorId,
    });
  }, [currentOperatorId, radioService]);

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
