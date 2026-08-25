import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@tx5dr/core';
import type { ImageHistoryEntry, ImageRxEvent, SstvTxStatus } from '@tx5dr/contracts';

import { useConnection, useCurrentOperatorId, useOperators, useRadioModeState } from '../store/radioStore';

export type ImageHistoryDirection = 'all' | 'rx' | 'tx';

export function useImageHistory(direction: ImageHistoryDirection) {
  const connection = useConnection();
  const radioMode = useRadioModeState();
  const { currentOperatorId } = useCurrentOperatorId();
  const { operators } = useOperators();
  const operatorId = currentOperatorId ?? operators[0]?.id;
  const family = radioMode.currentMode?.name === 'FAX' ? 'fax' : 'sstv';
  const effectiveDirection = family === 'fax' ? 'rx' : direction;
  const [entries, setEntries] = useState<ImageHistoryEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const requestGenerationRef = useRef(0);

  const load = useCallback(async (cursor?: string) => {
    const generation = cursor ? requestGenerationRef.current : ++requestGenerationRef.current;
    cursor ? setLoadingMore(true) : setLoading(true);
    setError(false);
    try {
      const result = await api.getImageHistory({
        family,
        direction: effectiveDirection,
        operatorId: effectiveDirection === 'rx' ? undefined : operatorId,
        limit: 50,
        cursor,
      });
      if (generation !== requestGenerationRef.current) return;
      setEntries((current) => {
        if (!cursor) return result.entries;
        const known = new Set(current.map((entry) => entry.record.id));
        return [...current, ...result.entries.filter((entry) => !known.has(entry.record.id))];
      });
      setNextCursor(result.nextCursor);
    } catch {
      if (generation === requestGenerationRef.current) setError(true);
    } finally {
      if (generation === requestGenerationRef.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [effectiveDirection, family, operatorId]);

  const refresh = useCallback(() => load(), [load]);
  const loadMore = useCallback(() => nextCursor ? load(nextCursor) : Promise.resolve(), [load, nextCursor]);

  useEffect(() => {
    if (radioMode.engineMode !== 'image') return;
    void refresh();
  }, [radioMode.engineMode, refresh]);

  useEffect(() => {
    const service = connection.state.radioService;
    if (!service || !connection.state.isReady || radioMode.engineMode !== 'image') return;
    const ws = service.wsClientInstance;
    const onRxEvent = (event: ImageRxEvent) => {
      if (event.type === 'captureSaved') void refresh();
    };
    const onTxStatus = (status: SstvTxStatus) => {
      if (status.phase === 'completed' || status.phase === 'cancelled' || status.phase === 'error' || status.phase === 'ptt_unknown') {
        void refresh();
      }
    };
    ws.onWSEvent('imageRxEvent', onRxEvent);
    ws.onWSEvent('sstvTxStatus', onTxStatus);
    return () => {
      ws.offWSEvent('imageRxEvent', onRxEvent);
      ws.offWSEvent('sstvTxStatus', onTxStatus);
    };
  }, [connection.state.isReady, connection.state.radioService, radioMode.engineMode, refresh]);

  return {
    entries,
    loading,
    loadingMore,
    error,
    hasMore: Boolean(nextCursor),
    refresh,
    loadMore,
  };
}
