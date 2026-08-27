import { useCallback, useEffect, useRef, useState } from 'react';

import { addToast } from '@heroui/toast';
import type { SstvTxEnvelopeSelection } from '@tx5dr/contracts';
import { useTranslation } from 'react-i18next';

import { sstvTxErrorTranslationKey } from '../components/image-radio/sstvTxCommand';
import { useImageRadioControls } from './useImageRadio';
import { useConnection } from '../store/radioStore';
import { createClientId } from '../utils/clientId';

export type PreparedSstvTx = {
  artifactId: string;
  operatorId: string;
  mode: string;
  expectedFrequency: number;
  envelope: SstvTxEnvelopeSelection;
};

type PrepareSstvTx = () => Promise<PreparedSstvTx>;

const TERMINAL_PHASES = new Set(['idle', 'completed', 'cancelled', 'error', 'ptt_unknown']);

export function useSstvTxStart() {
  const { t } = useTranslation('image');
  const connection = useConnection();
  const { status, txStatus, txCommandResult } = useImageRadioControls();
  const [starting, setStarting] = useState(false);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);
  const [captureConfirmOpen, setCaptureConfirmOpen] = useState(false);
  const pendingPrepareRef = useRef<PrepareSstvTx | null>(null);
  const preparedRef = useRef<PreparedSstvTx | null>(null);

  const clear = useCallback(() => {
    pendingPrepareRef.current = null;
    preparedRef.current = null;
    setPendingRequestId(null);
    setStarting(false);
    setActiveKey(null);
  }, []);

  const dispatch = useCallback((prepared: PreparedSstvTx, interruptActiveCapture: boolean) => {
    const service = connection.state.radioService;
    if (!service || !connection.state.isReady) throw new Error('IMAGE_CONNECTION_UNAVAILABLE');
    const requestId = createClientId();
    preparedRef.current = prepared;
    setPendingRequestId(requestId);
    setStarting(true);
    service.startSstvTx({ requestId, ...prepared, interruptActiveCapture });
  }, [connection.state.isReady, connection.state.radioService]);

  const prepareAndDispatch = useCallback(async (prepare: PrepareSstvTx, interruptActiveCapture: boolean) => {
    setStarting(true);
    try {
      const prepared = await prepare();
      dispatch(prepared, interruptActiveCapture);
    } catch (error) {
      clear();
      addToast({ title: error instanceof Error ? error.message : t('sendFailed'), color: 'danger' });
    }
  }, [clear, dispatch, t]);

  const start = useCallback((key: string, prepare: PrepareSstvTx) => {
    if (starting || captureConfirmOpen || (txStatus && !TERMINAL_PHASES.has(txStatus.phase))) return;
    setActiveKey(key);
    pendingPrepareRef.current = prepare;
    if (status?.rxCaptureActive) {
      setCaptureConfirmOpen(true);
      return;
    }
    pendingPrepareRef.current = null;
    void prepareAndDispatch(prepare, false);
  }, [captureConfirmOpen, prepareAndDispatch, starting, status?.rxCaptureActive, txStatus]);

  const cancelCaptureConfirmation = useCallback(() => {
    setCaptureConfirmOpen(false);
    clear();
  }, [clear]);

  const confirmCaptureInterrupt = useCallback(() => {
    setCaptureConfirmOpen(false);
    const prepared = preparedRef.current;
    if (prepared) {
      try {
        dispatch(prepared, true);
      } catch (error) {
        clear();
        addToast({ title: error instanceof Error ? error.message : t('sendFailed'), color: 'danger' });
      }
      return;
    }
    const prepare = pendingPrepareRef.current;
    pendingPrepareRef.current = null;
    if (prepare) void prepareAndDispatch(prepare, true);
  }, [clear, dispatch, prepareAndDispatch, t]);

  useEffect(() => {
    if (!pendingRequestId || txCommandResult?.requestId !== pendingRequestId) return;
    setPendingRequestId(null);
    if (txCommandResult.accepted) return;
    setStarting(false);
    if (txCommandResult.errorCode === 'IMAGE_RX_CAPTURE_CONFIRM_REQUIRED') {
      setCaptureConfirmOpen(true);
      return;
    }
    clear();
    addToast({ title: t(sstvTxErrorTranslationKey(txCommandResult.errorCode)), color: 'danger' });
  }, [clear, pendingRequestId, t, txCommandResult]);

  useEffect(() => {
    if (!pendingRequestId) return;
    if (txStatus?.requestId === pendingRequestId && txStatus.phase !== 'idle') {
      setPendingRequestId(null);
      return;
    }
    const timeout = window.setTimeout(() => {
      clear();
      addToast({ title: t('txAckTimeout'), color: 'danger' });
    }, 5_000);
    return () => window.clearTimeout(timeout);
  }, [clear, pendingRequestId, t, txStatus?.phase, txStatus?.requestId]);

  useEffect(() => {
    if (txStatus && TERMINAL_PHASES.has(txStatus.phase) && txStatus.phase !== 'idle') clear();
  }, [clear, txStatus]);

  const txActive = Boolean(txStatus && !TERMINAL_PHASES.has(txStatus.phase));
  return {
    start,
    starting,
    activeKey,
    isBusy: starting || captureConfirmOpen || txActive,
    captureConfirmOpen,
    cancelCaptureConfirmation,
    confirmCaptureInterrupt,
  };
}
