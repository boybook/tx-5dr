import { useCallback, useEffect, useMemo, useState } from 'react';

interface ContestQso {
  qsoId: string;
  callsign: string;
  myCallsign: string;
  sentGrid: string;
  receivedGrid?: string;
  frequencyHz: number;
  band: string;
  mode: 'FT4' | 'FT8';
  startTime: number;
  status: 'included' | 'x-qso';
}

interface PageState {
  config: { callsign: string; location: string; categoryBand: string; categoryPower: string };
  contestYear: number;
  records: ContestQso[];
  health: { state?: string; error?: string };
}

const text = {
  zh: {
    reconcile: '重新对账', download: '下载 Cabrillo', empty: '暂无比赛通联', time: 'UTC', call: '对方呼号',
    exchange: '交换', mode: '模式', band: '波段', status: '状态', included: '计入', excluded: 'X-QSO',
    dupe: '重复', health: { healthy: '正常', degraded: '需处理', unknown: '检查中' },
  },
  ja: {
    reconcile: '照合', download: 'Cabrillo を保存', empty: 'QSO はありません', time: 'UTC', call: '相手局',
    exchange: '交換', mode: 'モード', band: 'バンド', status: '状態', included: '有効', excluded: 'X-QSO',
    dupe: '重複', health: { healthy: '正常', degraded: '要確認', unknown: '確認中' },
  },
  en: {
    reconcile: 'Reconcile', download: 'Download Cabrillo', empty: 'No contest QSOs', time: 'UTC', call: 'Callsign',
    exchange: 'Exchange', mode: 'Mode', band: 'Band', status: 'Status', included: 'Included', excluded: 'X-QSO',
    dupe: 'Dupe', health: { healthy: 'Healthy', degraded: 'Needs attention', unknown: 'Checking' },
  },
};

export function App() {
  const [bridgeLocale, setBridgeLocale] = useState('en');
  const locale = bridgeLocale.startsWith('zh') ? 'zh' : bridgeLocale.startsWith('ja') ? 'ja' : 'en';
  const t = text[locale];
  const [state, setState] = useState<PageState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const healthState = stateHealth(state?.health.state);

  const load = useCallback(async () => {
    setError('');
    setState(await tx5dr.invoke('getState', {}) as PageState);
  }, []);

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    let handleStateChanged: (() => void) | undefined;
    void tx5dr.ready.then(async (bridgeState) => {
      if (!active) return;
      setBridgeLocale(bridgeState.locale);
      unsubscribe = tx5dr.onLocaleChange((nextLocale) => {
        if (active) setBridgeLocale(nextLocale);
      });
      handleStateChanged = () => {
        if (active) void load();
      };
      tx5dr.onPush('stateChanged', handleStateChanged);
      await load();
      if (!active) tx5dr.offPush('stateChanged', handleStateChanged);
    }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => {
      active = false;
      unsubscribe?.();
      if (handleStateChanged) tx5dr.offPush('stateChanged', handleStateChanged);
    };
  }, [load]);

  const rows = useMemo(() => {
    const worked = new Set<string>();
    return [...(state?.records ?? [])].sort((a, b) => a.startTime - b.startTime).map((record) => {
      const key = `${record.callsign.toUpperCase()}:${record.band}`;
      const dupe = record.status === 'included' && worked.has(key);
      if (record.status === 'included') worked.add(key);
      return { ...record, dupe };
    });
  }, [state?.records]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await action(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const reconcile = () => run(async () => { await tx5dr.invoke('reconcile', {}); await load(); });
  const download = () => run(async () => {
    const result = await tx5dr.invoke('renderCabrillo', {}) as { text: string };
    const blob = new Blob([result.text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${state?.config.callsign || 'ww-digi'}-ww-digi-${state?.contestYear || 'log'}.log`;
    anchor.click();
    URL.revokeObjectURL(url);
  });
  const toggle = (record: ContestQso) => run(async () => {
    await tx5dr.invoke('setStatus', { qsoId: record.qsoId, status: record.status === 'included' ? 'x-qso' : 'included' });
    await load();
  });

  return (
    <main>
      <header className="summary-bar">
        <div className="summary-copy">
          <h1>{state ? `${state.config.callsign} · ${state.contestYear}` : 'WW Digi'}</h1>
          <p>{state ? `${state.config.categoryBand} / ${state.config.categoryPower} / ${state.config.location}` : ''}</p>
        </div>
        <div className="actions">
          <span
            className={`health health-${healthState}`}
            title={state?.health.error}
          >
            {t.health[healthState]}
          </span>
          <button className="button button-sm button-flat" type="button" disabled={busy} onClick={() => void reconcile()}>
            {t.reconcile}
          </button>
          <button
            type="button"
            className="button button-sm button-solid button-primary"
            disabled={busy || !state || state.health.state !== 'healthy'}
            onClick={() => void download()}
          >{t.download}</button>
        </div>
      </header>
      {error && <div role="alert" className="error">{error}</div>}
      <div className="table-shell">
        <table>
          <thead><tr><th>{t.time}</th><th>{t.call}</th><th>{t.exchange}</th><th>{t.mode}</th><th>{t.band}</th><th>{t.status}</th></tr></thead>
          <tbody>
            {rows.map((record) => (
              <tr key={record.qsoId} className={record.status === 'x-qso' ? 'excluded' : ''}>
                <td>{new Date(record.startTime).toISOString().slice(5, 16).replace('T', ' ')}</td>
                <td className="call">{record.callsign}</td>
                <td>{record.sentGrid} / {record.receivedGrid || 'ZZ00'}</td>
                <td>{record.mode}</td><td>{record.band}</td>
                <td>
                  <button
                    type="button"
                    className={`button button-xs button-flat status status-${record.status === 'x-qso' ? 'excluded' : record.dupe ? 'dupe' : 'included'}`}
                    disabled={busy}
                    onClick={() => void toggle(record)}
                  >
                    {record.status === 'x-qso' ? t.excluded : record.dupe ? t.dupe : t.included}
                  </button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={6} className="empty">{t.empty}</td></tr>}
          </tbody>
        </table>
      </div>
    </main>
  );
}

function stateHealth(value: string | undefined): 'healthy' | 'degraded' | 'unknown' {
  if (value === 'healthy' || value === 'degraded') return value;
  return 'unknown';
}
