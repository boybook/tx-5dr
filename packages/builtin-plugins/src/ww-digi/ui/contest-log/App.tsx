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
  status: 'included' | 'x-qso' | 'review';
  source?: string;
  transmitterId?: 0 | 1;
}

interface PageState {
  config: {
    callsign: string; location: string; categoryBand: string; categoryPower: string;
    categoryOperator?: string; categoryTransmitter?: string; operators?: string[];
  };
  contestYear: number;
  deadline?: number;
  records: ContestQso[];
  health: { state?: string; error?: string };
}

const text = {
  zh: {
    reconcile: '重新对账', download: '下载 Cabrillo', empty: '暂无比赛通联', time: 'UTC', call: '对方呼号',
    exchange: '交换', mode: '模式', band: '波段', source: '来源', status: '状态', included: '计入', excluded: 'X-QSO', review: '待审核', save: '保存会话',
    dupe: '重复', health: { healthy: '正常', degraded: '需处理', unknown: '检查中' },
  },
  ja: {
    reconcile: '照合', download: 'Cabrillo を保存', empty: 'QSO はありません', time: 'UTC', call: '相手局',
    exchange: '交換', mode: 'モード', band: 'バンド', source: '出所', status: '状態', included: '有効', excluded: 'X-QSO', review: '要確認', save: 'セッションを保存',
    dupe: '重複', health: { healthy: '正常', degraded: '要確認', unknown: '確認中' },
  },
  en: {
    reconcile: 'Reconcile', download: 'Download Cabrillo', empty: 'No contest QSOs', time: 'UTC', call: 'Callsign',
    exchange: 'Exchange', mode: 'Mode', band: 'Band', source: 'Source', status: 'Status', included: 'Included', excluded: 'X-QSO', review: 'Review', save: 'Save session',
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
  const [draft, setDraft] = useState<PageState['config'] | null>(null);
  const healthState = stateHealth(state?.health.state);

  const load = useCallback(async () => {
    setError('');
    const next = await tx5dr.invoke('getState', {}) as PageState;
    setState(next);
    setDraft(next.config);
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
  const saveSession = () => run(async () => {
    if (!draft) return;
    await tx5dr.invoke('updateSession', { ...draft, operators: draft.operators ?? [] });
    await load();
  });
  const setTransmitter = (record: ContestQso, transmitterId: 0 | 1) => run(async () => {
    await tx5dr.invoke('setTransmitter', { qsoId: record.qsoId, transmitterId });
    await load();
  });

  return (
    <main>
      <header className="summary-bar">
        <div className="summary-copy">
          <h1>{state ? `${state.config.callsign} · ${state.contestYear}` : 'WW Digi'}</h1>
          <p>{state ? `${state.config.categoryOperator ?? 'SINGLE-OP'} / ${state.config.categoryTransmitter ?? 'ONE'} / ${state.config.categoryBand} / ${state.config.categoryPower}` : ''}</p>
          {state?.deadline && <p>{new Date(state.deadline).toISOString().replace('.000Z', 'Z')}</p>}
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
      {draft && (
        <div className="session-form">
          <select value={draft.categoryOperator ?? 'SINGLE-OP'} onChange={(event) => setDraft({ ...draft, categoryOperator: event.target.value })}>
            {['SINGLE-OP', 'MULTI-OP', 'CHECKLOG'].map((value) => <option key={value}>{value}</option>)}
          </select>
          <select value={draft.categoryTransmitter ?? 'ONE'} onChange={(event) => setDraft({ ...draft, categoryTransmitter: event.target.value })}>
            {['ONE', 'TWO', 'UNLIMITED'].map((value) => <option key={value}>{value}</option>)}
          </select>
          <select value={draft.categoryBand} onChange={(event) => setDraft({ ...draft, categoryBand: event.target.value })}>
            {['ALL', '160M', '80M', '40M', '20M', '15M', '10M'].map((value) => <option key={value}>{value}</option>)}
          </select>
          <select value={draft.categoryPower} onChange={(event) => setDraft({ ...draft, categoryPower: event.target.value })}>
            {['HIGH', 'LOW', 'QRP'].map((value) => <option key={value}>{value}</option>)}
          </select>
          <input value={draft.location} placeholder="LOCATION" onChange={(event) => setDraft({ ...draft, location: event.target.value.toUpperCase() })} />
          <input value={(draft.operators ?? []).join(', ')} placeholder="OPERATORS" onChange={(event) => setDraft({ ...draft, operators: event.target.value.split(/[\s,]+/).filter(Boolean).map((value) => value.toUpperCase()) })} />
          <button className="button button-sm button-bordered" type="button" disabled={busy} onClick={() => void saveSession()}>{t.save}</button>
        </div>
      )}
      <div className="table-shell">
        <table>
          <thead><tr><th>{t.time}</th><th>{t.call}</th><th>{t.exchange}</th><th>{t.mode}</th><th>{t.band}</th><th>{t.source}</th><th>{t.status}</th></tr></thead>
          <tbody>
            {rows.map((record) => (
              <tr key={record.qsoId} className={record.status === 'x-qso' ? 'excluded' : ''}>
                <td>{new Date(record.startTime).toISOString().slice(5, 16).replace('T', ' ')}</td>
                <td className="call">{record.callsign}</td>
                <td>{record.sentGrid} / {record.receivedGrid || 'ZZ00'}</td>
                <td>{record.mode}</td><td>{record.band}</td><td>{record.source ?? 'reconciled'}</td>
                <td>
                  {state?.config.categoryTransmitter === 'TWO' && (
                    <select
                      className="tx-select"
                      value={record.transmitterId ?? ''}
                      disabled={busy}
                      onChange={(event) => void setTransmitter(record, Number(event.target.value) === 1 ? 1 : 0)}
                    >
                      <option value="" disabled>TX</option><option value="0">0</option><option value="1">1</option>
                    </select>
                  )}
                  <button
                    type="button"
                    className={`button button-xs button-flat status status-${record.status === 'x-qso' ? 'excluded' : record.status === 'review' ? 'dupe' : record.dupe ? 'dupe' : 'included'}`}
                    disabled={busy}
                    onClick={() => void toggle(record)}
                  >
                    {record.status === 'x-qso' ? t.excluded : record.status === 'review' ? t.review : record.dupe ? t.dupe : t.included}
                  </button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={7} className="empty">{t.empty}</td></tr>}
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
