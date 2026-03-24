import React, { useState, useEffect } from 'react';
import { useConnection, useOperators, useCurrentOperatorId } from '../../store/radioStore';
import { useTranslation } from 'react-i18next';
import { createLogger } from '../../utils/logger';
import { api } from '@tx5dr/core';
import type { QSORecord } from '@tx5dr/contracts';

const logger = createLogger('VoiceRecentQSOList');

// Modes used by the digital engine — exclude these from the voice QSO list
const DIGITAL_MODES = 'FT8,FT4,JS8,WSPR,JT65,JT9,MSK144,FST4,FST4W';

interface VoiceRecentQSOListProps {
  selectedQSOId?: string | null;
  onSelectQSO?: (qso: QSORecord) => void;
  onDeselectQSO?: () => void;
  lastUpdatedQSO?: QSORecord | null;
  lastDeletedId?: string | null;
}

/**
 * Voice Recent QSO List
 *
 * Flat table (no Card wrapper) displaying recent voice QSO records.
 * Loads existing records from the server on mount and subscribes to
 * WS events for real-time updates.
 */
export const VoiceRecentQSOList: React.FC<VoiceRecentQSOListProps> = ({
  selectedQSOId,
  onSelectQSO,
  onDeselectQSO,
  lastUpdatedQSO,
  lastDeletedId,
}) => {
  const { t } = useTranslation('voice');
  const connection = useConnection();
  const { operators } = useOperators();
  const { currentOperatorId } = useCurrentOperatorId();
  const [recentQSOs, setRecentQSOs] = useState<QSORecord[]>([]);

  // Derive current operator's callsign (logbook ID)
  const currentOperator = operators.find(op => op.id === currentOperatorId);
  const myCallsign = currentOperator?.context?.myCall || '';

  // Load existing QSOs from server when operator changes
  useEffect(() => {
    if (!myCallsign) return;

    api.getLogBookQSOs(myCallsign, {
      excludeModes: DIGITAL_MODES,
      limit: 50,
      offset: 0,
    }).then(result => {
      if (result.success && Array.isArray(result.data)) {
        setRecentQSOs(result.data);
      }
    }).catch(err => {
      logger.warn('Failed to load voice QSOs from server', err);
    });
  }, [myCallsign]);

  // Subscribe to real-time QSO events
  useEffect(() => {
    const radioService = connection.state.radioService;
    if (!radioService) return;

    const wsClient = radioService.wsClientInstance;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handleQSORecordAdded = (data: any) => {
      const qsoRecord = data?.qsoRecord as QSORecord | undefined;
      if (!qsoRecord) return;
      // Only show voice-mode QSOs (exclude digital modes)
      if (DIGITAL_MODES.split(',').includes((qsoRecord.mode || '').toUpperCase())) return;
      logger.debug('Voice QSO added', { callsign: qsoRecord.callsign });
      setRecentQSOs(prev => {
        if (prev.some(q => q.id === qsoRecord.id)) return prev;
        return [qsoRecord, ...prev].slice(0, 50);
      });
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wsClient.onWSEvent('qsoRecordAdded' as any, handleQSORecordAdded);

    return () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wsClient.offWSEvent('qsoRecordAdded' as any, handleQSORecordAdded);
    };
  }, [connection.state.radioService]);

  // Update local list when a QSO is edited
  useEffect(() => {
    if (!lastUpdatedQSO) return;
    setRecentQSOs(prev => prev.map(q => q.id === lastUpdatedQSO.id ? lastUpdatedQSO : q));
  }, [lastUpdatedQSO]);

  // Remove from local list when a QSO is deleted
  useEffect(() => {
    if (!lastDeletedId) return;
    setRecentQSOs(prev => prev.filter(q => q.id !== lastDeletedId));
  }, [lastDeletedId]);

  const formatTime = (timestamp: number): string => {
    return new Date(timestamp).toISOString().slice(11, 16); // HH:MM
  };

  const formatFreq = (freqHz: number): string => {
    return (freqHz / 1000000).toFixed(3);
  };

  const getDateKey = (timestamp: number): string => {
    const d = new Date(timestamp);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  };

  const formatDateLabel = (timestamp: number): string => {
    const d = new Date(timestamp);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    if (getDateKey(timestamp) === getDateKey(today.getTime())) return t('recentQSO.today');
    if (getDateKey(timestamp) === getDateKey(yesterday.getTime())) return t('recentQSO.yesterday');
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  };

  return (
    <div className="flex flex-col h-full" onClick={() => onDeselectQSO?.()}>
      {recentQSOs.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center cursor-default select-none">
          <div className="text-default-400 mb-2 text-4xl">🎙️</div>
          <p className="text-default-500 mb-1">{t('recentQSO.empty')}</p>
          <p className="text-default-400 text-sm">{t('recentQSO.emptyHint')}</p>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto">
          {/* Header row */}
          <div className="flex text-xs text-default-400 font-semibold py-1 border-b border-divider gap-2 px-1 sticky top-0 bg-background z-10">
            <span className="w-12 shrink-0">{t('recentQSO.time')}</span>
            <span className="flex-1 md:flex-none md:w-20 md:shrink-0">{t('recentQSO.callsign')}</span>
            <span className="hidden md:block flex-1">{t('recentQSO.qth')}</span>
            <span className="w-16 text-right shrink-0">{t('recentQSO.freq')}</span>
            <span className="w-10 text-center shrink-0">{t('recentQSO.mode')}</span>
            <span className="md:hidden w-16 text-center shrink-0">{t('recentQSO.rst')}</span>
            <span className="hidden md:block w-10 text-center shrink-0">{t('recentQSO.rstSent')}</span>
            <span className="hidden md:block w-10 text-center shrink-0">{t('recentQSO.rstReceived')}</span>
          </div>
          {/* QSO entries with date separators */}
          {recentQSOs.map((qso, index) => {
            const isSelected = qso.id === selectedQSOId;
            const dateKey = getDateKey(qso.startTime);
            const prevDateKey = index > 0 ? getDateKey(recentQSOs[index - 1].startTime) : null;
            const showDateSep = dateKey !== prevDateKey;
            return (
              <React.Fragment key={qso.id}>
                {showDateSep && (
                  <div className="px-1 pt-1 pb-1 sticky top-6 z-[5] bg-background/80 backdrop-blur-sm border-b border-default-200 dark:border-white/10">
                    <span className="text-xs text-default-400 font-medium">
                      {formatDateLabel(qso.startTime)}
                    </span>
                  </div>
                )}
              <div
                onClick={(e) => {
                  e.stopPropagation();
                  isSelected ? onDeselectQSO?.() : onSelectQSO?.(qso);
                }}
                className={[
                  'flex text-sm py-1.5 border-b gap-2 items-center transition-colors px-1 cursor-pointer',
                  isSelected
                    ? 'bg-primary-100 dark:bg-primary-950/60 border-primary-200 dark:border-white/15'
                    : 'border-default-200 dark:border-white/10 hover:bg-default-100',
                ].join(' ')}
              >
                <span className="w-12 font-mono text-xs text-default-400 shrink-0">
                  {formatTime(qso.startTime)}
                </span>
                <span className="flex-1 md:flex-none md:w-20 md:shrink-0 flex flex-col min-w-0">
                  <span className="font-mono font-semibold text-foreground truncate">
                    {qso.callsign}
                  </span>
                  {/* QTH as sub-line on mobile only */}
                  {(qso.grid || qso.qth) && (
                    <span className="md:hidden text-xs text-default-400 truncate">
                      {[qso.grid, qso.qth].filter(Boolean).join(' · ')}
                    </span>
                  )}
                </span>
                {/* QTH as separate column on desktop */}
                <span className="hidden md:block flex-1 min-w-0 text-xs text-default-400 whitespace-normal break-words leading-tight">
                  {[qso.grid, qso.qth].filter(Boolean).join(' · ')}
                </span>
                <span className="w-16 text-right font-mono text-xs text-default-500 shrink-0">
                  {formatFreq(qso.frequency)}
                </span>
                <span className="w-10 text-center text-xs text-default-400 shrink-0">
                  {qso.mode}
                </span>
                {/* Mobile: merged RST */}
                <span className="md:hidden w-16 text-center font-mono text-xs text-default-400 shrink-0">
                  {qso.reportSent ?? '?'}/{qso.reportReceived ?? '?'}
                </span>
                {/* Desktop: separate RST columns */}
                <span className="hidden md:block w-10 text-center font-mono text-xs text-default-400 shrink-0">
                  {qso.reportSent ?? '?'}
                </span>
                <span className="hidden md:block w-10 text-center font-mono text-xs text-default-400 shrink-0">
                  {qso.reportReceived ?? '?'}
                </span>
              </div>
              </React.Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
};
