/// <reference types="@tx5dr/plugin-api/bridge" />
import { useCallback, useEffect, useState } from 'react';
import { useAutoResize } from '../../../_shared/ui/useAutoResize';
import { useI18n } from '../../../_shared/ui/useI18n';
import './App.css';

interface MemoryItem {
  callsign: string;
  score: number;
}

interface MemoryListResponse {
  entries: MemoryItem[];
  blockThreshold: number;
}

const I18N: Record<string, Record<string, string>> = {
  zh: {
    refresh: '刷新',
    empty: '当前没有被记忆的呼号',
    clear: '清除',
    loading: '加载中...',
    failed: '操作失败',
    threshold: '低于 {value} 会过滤',
  },
  en: {
    refresh: 'Refresh',
    empty: 'No callsigns are currently remembered',
    clear: 'Clear',
    loading: 'Loading...',
    failed: 'Action failed',
    threshold: 'Filtered below {value}',
  },
};

export function App() {
  const t = useI18n(I18N);
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [blockThreshold, setBlockThreshold] = useState(50);
  const [draftScores, setDraftScores] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState('');

  useAutoResize();

  const loadMemory = useCallback(async () => {
    setError('');
    const response = await window.tx5dr.invoke('listMemory', {}) as MemoryListResponse;
    setItems(response.entries);
    setBlockThreshold(response.blockThreshold);
    setDraftScores(Object.fromEntries(response.entries.map((entry) => [
      entry.callsign,
      String(Math.round(entry.score)),
    ])));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadMemory()
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : t('failed'));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [loadMemory, t]);

  const handleRefresh = useCallback(async () => {
    setBusyKey('refresh');
    try {
      await loadMemory();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('failed'));
    } finally {
      setBusyKey(null);
    }
  }, [loadMemory, t]);

  const handleSave = useCallback(async (item: MemoryItem) => {
    const draft = draftScores[item.callsign] ?? String(Math.round(item.score));
    const score = Number(draft);
    if (!Number.isFinite(score) || score < 0 || score > 100 || Math.round(item.score) === score) {
      return;
    }

    const callsign = item.callsign;
    setBusyKey(`save:${callsign}`);
    setError('');
    try {
      await window.tx5dr.invoke('setScore', { callsign, score });
      await loadMemory();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('failed'));
    } finally {
      setBusyKey(null);
    }
  }, [draftScores, loadMemory, t]);

  const handleClear = useCallback(async (callsign: string) => {
    setBusyKey(`clear:${callsign}`);
    setError('');
    try {
      await window.tx5dr.invoke('clearCallsign', { callsign });
      await loadMemory();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('failed'));
    } finally {
      setBusyKey(null);
    }
  }, [loadMemory, t]);

  return (
    <div className="memory-panel">
      <div className="toolbar">
        <span>{t('threshold', { value: blockThreshold })}</span>
        <button
          type="button"
          className="refresh-button"
          disabled={busyKey === 'refresh'}
          onClick={() => void handleRefresh()}
        >
          {busyKey === 'refresh' ? t('loading') : t('refresh')}
        </button>
      </div>

      {error && <div className="alert">{error}</div>}

      {loading ? (
        <div className="empty">{t('loading')}</div>
      ) : items.length === 0 ? (
        <div className="empty">{t('empty')}</div>
      ) : (
        <div className="memory-list">
          {items.map((item) => {
            const draft = draftScores[item.callsign] ?? String(Math.round(item.score));
            const rawScore = Number(draft);
            const scoreValid = Number.isFinite(rawScore) && rawScore >= 0 && rawScore <= 100;
            const saveKey = `save:${item.callsign}`;
            const clearKey = `clear:${item.callsign}`;

            return (
              <div key={item.callsign} className="memory-row">
                <div className="callsign">{item.callsign}</div>
                <input
                  className={scoreValid ? '' : 'invalid'}
                  type="number"
                  min="0"
                  max="100"
                  step="1"
                  value={draft}
                  disabled={busyKey === saveKey}
                  onBlur={() => void handleSave(item)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.currentTarget.blur();
                    }
                  }}
                  onChange={(event) => {
                    setDraftScores((prev) => ({
                      ...prev,
                      [item.callsign]: event.target.value,
                    }));
                  }}
                />
                <button
                  type="button"
                  className="delete-button"
                  title={t('clear')}
                  disabled={busyKey === clearKey}
                  onClick={() => void handleClear(item.callsign)}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
