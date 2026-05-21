import React, { useCallback, useEffect, useMemo } from 'react';
import { Card, CardBody } from '@heroui/react';
import { api, ApiError, getBandFromFrequency } from '@tx5dr/core';
import { useTranslation } from 'react-i18next';
import { useAbility, useAuth, useCan } from '../../store/authStore';
import { useConnection, useOperators, useRadioConnectionState, useRadioState, useSplitState } from '../../store/radioStore';
import { createLogger } from '../../utils/logger';
import { canExecuteRadioFrequency, canWriteRadioFrequency } from '../../utils/radioControl';
import { resetOperatorsForOperatingStateChange } from '../../utils/operatorReset';
import { showErrorToast } from '../../utils/errorToast';
import { setRadioFrequencyWithIntent } from '../../utils/radioFrequencyIntent';
import { FrequencyDigit } from '../radio/frequency/FrequencyDigit';
import { SPLIT_FREQUENCY_ROW_CLASS, SplitFrequencyLayout } from '../radio/frequency/SplitFrequencyLayout';
import { SplitSettingsPopover } from '../radio/frequency/SplitSettingsPopover';

const logger = createLogger('CWFrequencyControl');
const DEFAULT_CW_FREQUENCY = 14_000_000;
const FREQ_PENDING_TIMEOUT_MS = 1500;
const FREQ_MATCH_TOLERANCE_HZ = 10;
const FREQ_DEBOUNCE_MS = 50;

type DigitEntry = { char: string; placeValue: number; isSeparator: false; isLeadingZero: boolean }
  | { char: string; isSeparator: true };

function buildFrequencyDigits(frequency: number): DigitEntry[] {
  const freq = Math.round(frequency);
  const mhzWhole = Math.floor(freq / 1_000_000);
  const remainder = freq % 1_000_000;
  const khzPart = Math.floor(remainder / 1_000);
  const hzPart = remainder % 1_000;

  const mhzStr = String(mhzWhole).padStart(3, '0');
  const khzStr = String(khzPart).padStart(3, '0');
  const hzStr = String(hzPart).padStart(3, '0');
  const result: DigitEntry[] = [];

  const mhzPlaces = [100_000_000, 10_000_000, 1_000_000];
  let seenNonZero = false;
  for (let i = 0; i < 3; i++) {
    const isLeadingZero = !seenNonZero && mhzStr[i] === '0';
    if (mhzStr[i] !== '0') seenNonZero = true;
    result.push({ char: mhzStr[i], placeValue: mhzPlaces[i], isSeparator: false, isLeadingZero });
  }
  result.push({ char: '.', isSeparator: true });

  const khzPlaces = [100_000, 10_000, 1_000];
  for (let i = 0; i < 3; i++) {
    result.push({ char: khzStr[i], placeValue: khzPlaces[i], isSeparator: false, isLeadingZero: false });
  }
  result.push({ char: '.', isSeparator: true });

  const hzPlaces = [100, 10, 1];
  for (let i = 0; i < 3; i++) {
    result.push({ char: hzStr[i], placeValue: hzPlaces[i], isSeparator: false, isLeadingZero: false });
  }

  return result;
}

export const CWFrequencyControl: React.FC = () => {
  const { t } = useTranslation('voice');
  const connection = useConnection();
  const { operators } = useOperators();
  const radioConnection = useRadioConnectionState();
  const radio = useRadioState();
  const { state: authState } = useAuth();
  const canUseAuthenticatedRest = !authState.authEnabled || Boolean(authState.jwt);
  const canSetFrequency = useCan('execute', 'RadioFrequency');
  const ability = useAbility();
  const canWriteFrequency = canWriteRadioFrequency(canSetFrequency, radioConnection.coreCapabilities);
  const canWriteTargetFrequency = useCallback((frequency: number) => (
    canWriteFrequency && canExecuteRadioFrequency(ability, frequency)
  ), [ability, canWriteFrequency]);
  const liveFrequency = radio.state.currentRadioFrequency && radio.state.currentRadioFrequency > 0
    ? radio.state.currentRadioFrequency
    : null;

  const [currentFrequency, setCurrentFrequency] = React.useState<number>(liveFrequency ?? DEFAULT_CW_FREQUENCY);
  const currentFrequencyRef = React.useRef(currentFrequency);
  currentFrequencyRef.current = currentFrequency;
  const pendingFreqRef = React.useRef<{ intendedFrequency: number; sentAt: number } | null>(null);
  const freqDebounceTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Split state
  const { splitEnabled, splitTxFrequency, splitTxFrequencyWritable } = useSplitState();
  const showSplitFrequencyControls = splitEnabled;
  const [currentTxFrequency, setCurrentTxFrequency] = React.useState<number>(
    splitTxFrequency && splitTxFrequency > 0 ? splitTxFrequency : 0,
  );
  const currentTxFrequencyRef = React.useRef(currentTxFrequency);
  currentTxFrequencyRef.current = currentTxFrequency;
  const canEditSplitTxFrequency = currentTxFrequency > 0;
  const pendingTxFreqRef = React.useRef<{ intendedFrequency: number; sentAt: number } | null>(null);
  const txFreqDebounceTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync TX frequency from store when split state changes
  React.useEffect(() => {
    if (!splitEnabled) {
      return;
    }
    if (splitTxFrequency && splitTxFrequency > 0) {
      setCurrentTxFrequency(splitTxFrequency);
    }
  }, [splitEnabled, splitTxFrequency]);

  const resetOperatorsAfterOperatingStateChange = useCallback(() => {
    resetOperatorsForOperatingStateChange({
      operators,
      radioService: connection.state.radioService,
    });
  }, [connection.state.radioService, operators]);

  const acceptServerFrequency = useCallback((incoming: number | null | undefined) => {
    if (typeof incoming !== 'number' || incoming <= 0) return;
    const pending = pendingFreqRef.current;
    if (pending) {
      const withinWindow = Date.now() - pending.sentAt < FREQ_PENDING_TIMEOUT_MS;
      const matched = Math.abs(incoming - pending.intendedFrequency) < FREQ_MATCH_TOLERANCE_HZ;
      if (withinWindow && !matched) return;
      if (matched) pendingFreqRef.current = null;
    }
    setCurrentFrequency(incoming);
  }, []);

  const flushPendingFrequency = useCallback(async () => {
    const pending = pendingFreqRef.current;
    if (!pending) return;

    if (!canWriteTargetFrequency(pending.intendedFrequency) || !connection.state.isConnected) {
      pendingFreqRef.current = null;
      return;
    }

    const freq = pending.intendedFrequency;
    const band = getBandFromFrequency(freq);
    const description = `${(freq / 1_000_000).toFixed(3)} MHz`;
    pendingFreqRef.current = { intendedFrequency: freq, sentAt: Date.now() };

    try {
      const response = await setRadioFrequencyWithIntent({
        frequency: freq,
        mode: 'CW',
        band,
        description,
      });
      if (response.success) {
        resetOperatorsAfterOperatingStateChange();
      }
    } catch (error) {
      logger.error('Failed to set CW frequency:', error);
      if (error instanceof ApiError) {
        showErrorToast({ userMessage: error.userMessage, suggestions: error.suggestions, severity: error.severity, code: error.code });
      }
    }
  }, [canWriteTargetFrequency, connection.state.isConnected, resetOperatorsAfterOperatingStateChange]);

  const applyFrequency = useCallback((newFreq: number) => {
    if (!canWriteTargetFrequency(newFreq) || !connection.state.isConnected) {
      pendingFreqRef.current = null;
      return;
    }

    setCurrentFrequency(newFreq);
    pendingFreqRef.current = { intendedFrequency: newFreq, sentAt: Date.now() };
    if (freqDebounceTimerRef.current) {
      clearTimeout(freqDebounceTimerRef.current);
    }
    freqDebounceTimerRef.current = setTimeout(() => {
      freqDebounceTimerRef.current = null;
      void flushPendingFrequency();
    }, FREQ_DEBOUNCE_MS);
  }, [canWriteTargetFrequency, connection.state.isConnected, flushPendingFrequency]);

  useEffect(() => () => {
    if (freqDebounceTimerRef.current) {
      clearTimeout(freqDebounceTimerRef.current);
      freqDebounceTimerRef.current = null;
    }
    if (txFreqDebounceTimerRef.current) {
      clearTimeout(txFreqDebounceTimerRef.current);
      txFreqDebounceTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (liveFrequency !== null) {
      acceptServerFrequency(liveFrequency);
    }
  }, [acceptServerFrequency, liveFrequency]);

  useEffect(() => {
    if (liveFrequency !== null) return;
    if (!canUseAuthenticatedRest) return;
    let cancelled = false;
    api.getLastFrequency()
      .then((resp) => {
        if (cancelled) return;
        if (resp.lastCWFrequency?.frequency) {
          setCurrentFrequency(resp.lastCWFrequency.frequency);
        }
      })
      .catch((error) => logger.warn('Failed to load last CW frequency:', error));
    return () => {
      cancelled = true;
    };
  }, [canUseAuthenticatedRest, liveFrequency]);

  useEffect(() => {
    const radioService = connection.state.radioService;
    if (!radioService) return;
    const wsClient = radioService.wsClientInstance;

    const handleFreqChanged = (data: { frequency?: number; mode?: string }) => {
      if (data?.mode && data.mode !== 'CW') return;
      acceptServerFrequency(data?.frequency);
    };

    wsClient.onWSEvent('frequencyChanged', handleFreqChanged);
    return () => {
      wsClient.offWSEvent('frequencyChanged', handleFreqChanged);
    };
  }, [connection.state.radioService, acceptServerFrequency]);

  const frequencyDigits = useMemo(() => buildFrequencyDigits(currentFrequency), [currentFrequency]);

  const txFrequencyDigits = useMemo(() => buildFrequencyDigits(currentTxFrequency), [currentTxFrequency]);

  const applyTxFrequency = useCallback((newFreq: number) => {
    if (!canWriteFrequency || !splitTxFrequencyWritable || !connection.state.isConnected) {
      pendingTxFreqRef.current = null;
      return;
    }

    setCurrentTxFrequency(newFreq);
    pendingTxFreqRef.current = { intendedFrequency: newFreq, sentAt: Date.now() };
    if (txFreqDebounceTimerRef.current) {
      clearTimeout(txFreqDebounceTimerRef.current);
    }
    txFreqDebounceTimerRef.current = setTimeout(() => {
      txFreqDebounceTimerRef.current = null;
      const pending = pendingTxFreqRef.current;
      if (!pending) return;
      pendingTxFreqRef.current = { intendedFrequency: pending.intendedFrequency, sentAt: Date.now() };
      const wsClient = connection.state.radioService?.wsClientInstance;
      if (wsClient) {
        wsClient.setSplitFrequency(pending.intendedFrequency);
      }
    }, FREQ_DEBOUNCE_MS);
  }, [canWriteFrequency, connection.state.isConnected, connection.state.radioService, splitTxFrequencyWritable]);

  const changeDigitAtPlace = useCallback((placeValue: number, delta: number) => {
    const freq = currentFrequencyRef.current;
    const newFreq = Math.max(0, freq + delta * placeValue);
    if (newFreq < 1_000_000 || newFreq > 1_000_000_000) return;
    applyFrequency(newFreq);
  }, [applyFrequency]);

  const setDigitAtPlace = useCallback((placeValue: number, newDigitValue: number) => {
    const freq = Math.round(currentFrequencyRef.current);
    const currentDigit = Math.floor(freq / placeValue) % 10;
    const delta = newDigitValue - currentDigit;
    if (delta === 0) return;
    const newFreq = freq + delta * placeValue;
    if (newFreq < 1_000_000 || newFreq > 1_000_000_000) return;
    applyFrequency(newFreq);
  }, [applyFrequency]);

  const changeTxDigitAtPlace = useCallback((placeValue: number, delta: number) => {
    const freq = currentTxFrequencyRef.current;
    const newFreq = Math.max(0, freq + delta * placeValue);
    if (newFreq < 1_000_000 || newFreq > 1_000_000_000) return;
    applyTxFrequency(newFreq);
  }, [applyTxFrequency]);

  const setTxDigitAtPlace = useCallback((placeValue: number, newDigitValue: number) => {
    const freq = Math.round(currentTxFrequencyRef.current);
    const currentDigit = Math.floor(freq / placeValue) % 10;
    const delta = newDigitValue - currentDigit;
    if (delta === 0) return;
    const newFreq = freq + delta * placeValue;
    if (newFreq < 1_000_000 || newFreq > 1_000_000_000) return;
    applyTxFrequency(newFreq);
  }, [applyTxFrequency]);

  return (
    <Card className="relative w-full flex-shrink-0 bg-default-50 dark:bg-default-100/50 border border-default-200 dark:border-default-100" shadow="none">
      <div className="absolute right-1 top-1 z-10">
        <SplitSettingsPopover className="h-6 min-w-6" />
      </div>
      <CardBody className="px-3 py-1.5">
        {showSplitFrequencyControls ? (
          <SplitFrequencyLayout>
            {/* RX */}
            <div className={SPLIT_FREQUENCY_ROW_CLASS}>
              <span className="mr-2 text-[11px] font-semibold text-success-500">{t('frequency.rxLabel')}</span>
              <div className="flex flex-none items-center justify-center">
                {frequencyDigits.map((entry, i) => {
                  if (entry.isSeparator) {
                    return <span key={`cw-rx-sep-${i}`} className="mx-0.5 select-none text-2xl text-default-400">.</span>;
                  }
                  return (
                    <FrequencyDigit
                      key={`cw-rx-d-${i}`}
                      digit={entry.char}
                      placeValue={entry.placeValue}
                      disabled={!canWriteFrequency || !connection.state.isConnected}
                      isLeadingZero={entry.isLeadingZero}
                      digitClassName="text-2xl"
                      arrowClassName="h-3 text-[10px]"
                      onIncrement={() => changeDigitAtPlace(entry.placeValue, 1)}
                      onDecrement={() => changeDigitAtPlace(entry.placeValue, -1)}
                      onSetDigit={(v) => setDigitAtPlace(entry.placeValue, v)}
                    />
                  );
                })}
              </div>
              <span className="ml-2 flex-none self-center text-[11px] font-semibold text-default-400">{t('frequency.mhz')}</span>
            </div>
            {/* TX */}
            <div className={SPLIT_FREQUENCY_ROW_CLASS}>
              <span className="mr-2 text-[11px] font-semibold text-danger-500">{t('frequency.txLabel')}</span>
              <div className="flex flex-none items-center justify-center">
                {canEditSplitTxFrequency ? txFrequencyDigits.map((entry, i) => {
                  if (entry.isSeparator) {
                    return <span key={`cw-tx-sep-${i}`} className="mx-0.5 select-none text-2xl text-default-400">.</span>;
                  }
                  return (
                    <FrequencyDigit
                      key={`cw-tx-d-${i}`}
                      digit={entry.char}
                      placeValue={entry.placeValue}
                      disabled={!canWriteFrequency || !splitTxFrequencyWritable || !connection.state.isConnected}
                      isLeadingZero={entry.isLeadingZero}
                      digitClassName="text-2xl"
                      arrowClassName="h-3 text-[10px]"
                      onIncrement={() => changeTxDigitAtPlace(entry.placeValue, 1)}
                      onDecrement={() => changeTxDigitAtPlace(entry.placeValue, -1)}
                      onSetDigit={(v) => setTxDigitAtPlace(entry.placeValue, v)}
                    />
                  );
                }) : (
                  <span className="font-mono text-xl font-semibold tracking-wide text-default-400 select-none">
                    {t('frequency.txPending')}
                  </span>
                )}
              </div>
              <span className="ml-2 flex-none self-center text-[11px] font-semibold text-default-400">{t('frequency.mhz')}</span>
            </div>
          </SplitFrequencyLayout>
        ) : (
          <div className="flex items-center justify-center font-mono font-bold text-foreground">
            <div className="min-w-0 shrink overflow-hidden flex justify-end" aria-hidden="true">
              <span className="mr-2 translate-y-1 text-[11px] font-semibold text-default-400 invisible">{t('frequency.mhz')}</span>
            </div>
            <div className="flex flex-none items-center justify-center">
              {frequencyDigits.map((entry, i) => {
                if (entry.isSeparator) {
                  return <span key={`cw-sep-${i}`} className="mx-0.5 select-none text-2xl text-default-400">.</span>;
                }
                return (
                  <FrequencyDigit
                    key={`cw-d-${i}`}
                    digit={entry.char}
                    placeValue={entry.placeValue}
                    disabled={!canWriteFrequency || !connection.state.isConnected}
                    isLeadingZero={entry.isLeadingZero}
                    digitClassName="text-2xl"
                    arrowClassName="h-3 text-[10px]"
                    onIncrement={() => changeDigitAtPlace(entry.placeValue, 1)}
                    onDecrement={() => changeDigitAtPlace(entry.placeValue, -1)}
                    onSetDigit={(v) => setDigitAtPlace(entry.placeValue, v)}
                  />
                );
              })}
            </div>
            <span className="ml-2 flex-none self-center translate-y-1 text-[11px] font-semibold text-default-400">{t('frequency.mhz')}</span>
          </div>
        )}
      </CardBody>
    </Card>
  );
};
