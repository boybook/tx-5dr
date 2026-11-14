import { useEffect } from 'react';
import { getBandFromFrequency } from '@tx5dr/core';
import type { DigitalRadioEngineEvents, QSORecord } from '@tx5dr/contracts';
import { useConnection, useCurrentOperatorId, useOperators, useRadioModeState } from '../../store/radioStore';
import { workedCallsignStore } from '../../store/workedCallsignStore';

export { useWorkedStatus } from '../../store/workedCallsignStore';

/**
 * Points the worked-before store at the current operator's logbook, band and
 * mode, and feeds it QSOs logged while the screen is open.
 */
export function useWorkedCallsignContext(mode: string): void {
  const { operators } = useOperators();
  const { currentOperatorId } = useCurrentOperatorId();
  const { currentRadioFrequency } = useRadioModeState();
  const connection = useConnection();
  const logbookId = operators.find((operator) => operator.id === currentOperatorId)?.context?.myCall?.trim() || '';
  const band = currentRadioFrequency && currentRadioFrequency > 0 ? getBandFromFrequency(currentRadioFrequency) : null;

  useEffect(() => {
    workedCallsignStore.setContext(logbookId ? { logbookId, band, mode: mode.toUpperCase() } : null);
  }, [band, logbookId, mode]);

  useEffect(() => {
    const radioService = connection.state.radioService;
    if (!radioService) return;
    const ws = radioService.wsClientInstance;
    const onQso: DigitalRadioEngineEvents['qsoRecordAdded'] = (data) => {
      if (data?.qsoRecord) workedCallsignStore.noteQso(data.logBookId, data.qsoRecord as QSORecord);
    };
    ws.onWSEvent('qsoRecordAdded', onQso);
    ws.onWSEvent('qsoRecordUpdated', onQso);
    return () => {
      ws.offWSEvent('qsoRecordAdded', onQso);
      ws.offWSEvent('qsoRecordUpdated', onQso);
    };
  }, [connection.state.radioService]);
}
