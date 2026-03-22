import React, { useState, useEffect } from 'react';
import { useConnection } from '../../store/radioStore';
import { useTranslation } from 'react-i18next';
import { createLogger } from '../../utils/logger';
import type { VoiceQSORecord } from '@tx5dr/contracts';

const logger = createLogger('VoiceRecentQSOList');

/**
 * Voice Recent QSO List
 *
 * Flat table (no Card wrapper) displaying recent voice QSO records.
 * Subscribes to WS events for real-time updates.
 */
export const VoiceRecentQSOList: React.FC = () => {
  const { t } = useTranslation('voice');
  const connection = useConnection();
  const [recentQSOs, setRecentQSOs] = useState<VoiceQSORecord[]>([]);

  // Subscribe to voice QSO events (if the server broadcasts them)
  useEffect(() => {
    const radioService = connection.state.radioService;
    if (!radioService) return;

    const wsClient = radioService.wsClientInstance;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handleVoiceQSOAdded = (data: any) => {
      logger.debug('Voice QSO added:', data);
      setRecentQSOs(prev => {
        const updated = [data as VoiceQSORecord, ...prev];
        return updated.slice(0, 50); // Keep last 50
      });
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wsClient.onWSEvent('voiceQSOAdded' as any, handleVoiceQSOAdded);

    return () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wsClient.offWSEvent('voiceQSOAdded' as any, handleVoiceQSOAdded);
    };
  }, [connection.state.radioService]);

  const formatTime = (timestamp: number): string => {
    return new Date(timestamp).toISOString().slice(11, 16); // HH:MM
  };

  const formatFreq = (freqHz: number): string => {
    return (freqHz / 1000000).toFixed(3);
  };

  return (
    <div className="flex flex-col h-full">
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
            <span className="w-12">{t('recentQSO.time')}</span>
            <span className="flex-1">{t('recentQSO.callsign')}</span>
            <span className="w-20 text-right">{t('recentQSO.freq')}</span>
            <span className="w-10 text-center">{t('recentQSO.mode')}</span>
            <span className="w-10 text-center">{t('recentQSO.rst')}</span>
          </div>
          {/* QSO entries */}
          {recentQSOs.map((qso) => (
            <div
              key={qso.id}
              className="flex text-sm py-1.5 border-b border-divider/50 gap-2 items-center hover:bg-default-100 transition-colors px-1"
            >
              <span className="w-12 font-mono text-xs text-default-400">
                {formatTime(qso.startTime)}
              </span>
              <span className="flex-1 font-mono font-semibold text-foreground">
                {qso.callsign}
              </span>
              <span className="w-20 text-right font-mono text-xs text-default-500">
                {formatFreq(qso.frequency)}
              </span>
              <span className="w-10 text-center text-xs text-default-400">
                {qso.radioMode}
              </span>
              <span className="w-10 text-center font-mono text-xs text-default-400">
                {qso.rstSent}/{qso.rstReceived}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
