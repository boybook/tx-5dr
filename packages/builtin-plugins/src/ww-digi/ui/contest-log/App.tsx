import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
  setup: { status: 'unconfirmed' | 'confirmed'; confirmedAt?: number };
  station: { callsign: string; grid: string; requiresSection: boolean };
}

const text = {
  zh: {
    reconcile: '重新对账', download: '下载 Cabrillo', empty: '暂无比赛通联', time: 'UTC', call: '对方呼号',
    exchange: '交换', mode: '模式', band: '波段', source: '来源', status: '状态', included: '计入', excluded: 'X-QSO', review: '待审核',
    dupe: '重复', save: '保存并确认比赛设置', setupRequired: '请确认本届比赛设置；确认前仅接收，发射已禁用。',
    contestTitle: 'WW Digi {{year}}', station: '参赛电台', grid: '网格', deadline: '日志提交截止',
    settingsTitle: '参赛与日志设置', settingsDesc: '这些信息将写入 Cabrillo 日志头部，并决定最终参赛类别。',
    expandSettings: '展开设置', collapseSettings: '收起设置', unsaved: '未保存',
    setupStatus: '比赛设置', confirmed: '已确认', unconfirmed: '未确认', ledgerStatus: '日志状态',
    operatorLabel: '操作员类别', operatorHelp: '选择由一人完成全部操作与日志，或由多人共同参赛。',
    transmitterLabel: '发射机类别', bandLabel: '参赛波段', powerLabel: '功率类别',
    locationLabel: 'Cabrillo 位置', locationSectionHelp: '美国和加拿大电台必须填写 ARRL/RAC 分区，例如 OH、EMA 或 ON。',
    locationDxHelp: '美国和加拿大以外的电台按官方要求使用 DX。',
    operatorsLabel: '操作员呼号', operatorsRequired: '多人组必填；使用空格或逗号分隔。',
    operatorsOptional: '单人组可留空；若在他人电台操作，可填写实际操作员呼号。',
    invalidGrid: '电台操作员的网格必须是有效的 4 位 Maidenhead 网格。',
    missingLocation: '请填写参赛地点对应的 ARRL/RAC 分区。', missingOperators: '多人组至少需要一位操作员呼号。',
    operatorOptions: { 'SINGLE-OP': '单人（SINGLE-OP）', 'MULTI-OP': '多人（MULTI-OP）', CHECKLOG: '检查日志，不计分（CHECKLOG）' },
    transmitterOptions: { ONE: '单发射机（ONE）', TWO: '双发射机（TWO）', UNLIMITED: '多发射机（UNLIMITED）' },
    transmitterHelp: {
      ONE: '同一时间只允许一个发射信号；多人组每小时最多换波段 8 次。',
      TWO: '仅多人组：可在两个不同波段同时发射；每条 QSO 必须标记发射机 0 或 1。',
      UNLIMITED: '仅限全波段，可同时启用六个比赛波段。',
    },
    bandOptions: { ALL: '全波段（ALL）', '160M': '160 米（160M）', '80M': '80 米（80M）', '40M': '40 米（40M）', '20M': '20 米（20M）', '15M': '15 米（15M）', '10M': '10 米（10M）' },
    bandHelp: '选择单波段参赛时仍需上报全部波段 QSO，但只有所选波段计分。',
    powerOptions: { HIGH: '高功率（不超过 1500 W）', LOW: '低功率（不超过 100 W）', QRP: 'QRP（不超过 5 W）' },
    powerHelp: '功率限制按每个波段任一时刻的总输出功率计算。',
    health: { healthy: '正常', degraded: '需处理', unknown: '检查中' },
  },
  ja: {
    reconcile: '照合', download: 'Cabrillo を保存', empty: 'QSO はありません', time: 'UTC', call: '相手局',
    exchange: '交換', mode: 'モード', band: 'バンド', source: '出所', status: '状態', included: '有効', excluded: 'X-QSO', review: '要確認',
    dupe: '重複', save: '保存して競技設定を確認', setupRequired: 'この大会の設定を確認してください。確認するまで受信のみで、送信は無効です。',
    contestTitle: 'WW Digi {{year}}', station: '参加局', grid: 'グリッド', deadline: 'ログ提出期限',
    settingsTitle: '参加カテゴリとログ設定', settingsDesc: 'この情報は Cabrillo ヘッダーに記録され、参加カテゴリを決定します。',
    expandSettings: '設定を開く', collapseSettings: '設定を閉じる', unsaved: '未保存',
    setupStatus: '大会設定', confirmed: '確認済み', unconfirmed: '未確認', ledgerStatus: 'ログ状態',
    operatorLabel: 'オペレーター区分', operatorHelp: '全操作と記録を一人で行うか、複数人で参加するかを選択します。',
    transmitterLabel: '送信機区分', bandLabel: '参加バンド', powerLabel: '出力区分',
    locationLabel: 'Cabrillo ロケーション', locationSectionHelp: '米国・カナダ局は OH、EMA、ON などの ARRL/RAC セクションが必要です。',
    locationDxHelp: '米国・カナダ以外の局は公式指定の DX を使用します。',
    operatorsLabel: 'オペレーターコール', operatorsRequired: 'マルチオペでは必須です。空白またはコンマで区切ります。',
    operatorsOptional: 'シングルオペでは省略できます。他局設備で運用した場合は実際のオペレーターを記載できます。',
    invalidGrid: 'オペレーター局のグリッドは有効な4桁 Maidenhead グリッドである必要があります。',
    missingLocation: '運用地点の ARRL/RAC セクションを入力してください。', missingOperators: 'マルチオペでは1局以上のオペレーターが必要です。',
    operatorOptions: { 'SINGLE-OP': 'シングルオペ（SINGLE-OP）', 'MULTI-OP': 'マルチオペ（MULTI-OP）', CHECKLOG: 'チェックログ・得点なし（CHECKLOG）' },
    transmitterOptions: { ONE: '1送信機（ONE）', TWO: '2送信機（TWO）', UNLIMITED: '複数送信機（UNLIMITED）' },
    transmitterHelp: {
      ONE: '同時に送信できる信号は1つです。マルチオペでは1時間に最大8回のバンド変更が可能です。',
      TWO: 'マルチオペのみ。異なる2バンドで同時送信でき、各 QSO に送信機 0/1 の記録が必要です。',
      UNLIMITED: 'オールバンドのみ。6つのコンテストバンドを同時に使用できます。',
    },
    bandOptions: { ALL: 'オールバンド（ALL）', '160M': '160 m（160M）', '80M': '80 m（80M）', '40M': '40 m（40M）', '20M': '20 m（20M）', '15M': '15 m（15M）', '10M': '10 m（10M）' },
    bandHelp: 'シングルバンド参加でも全バンドの QSO を提出し、指定バンドのみが得点になります。',
    powerOptions: { HIGH: 'ハイパワー（1500 W以下）', LOW: 'ローパワー（100 W以下）', QRP: 'QRP（5 W以下）' },
    powerHelp: '出力制限は各バンドで任意の時点における合計送信出力です。',
    health: { healthy: '正常', degraded: '要確認', unknown: '確認中' },
  },
  en: {
    reconcile: 'Reconcile', download: 'Download Cabrillo', empty: 'No contest QSOs', time: 'UTC', call: 'Callsign',
    exchange: 'Exchange', mode: 'Mode', band: 'Band', source: 'Source', status: 'Status', included: 'Included', excluded: 'X-QSO', review: 'Review',
    dupe: 'Dupe', save: 'Save and confirm contest settings', setupRequired: 'Confirm this contest edition before transmitting. Receive-only operation remains available.',
    contestTitle: 'WW Digi {{year}}', station: 'Entrant station', grid: 'Grid', deadline: 'Log submission deadline',
    settingsTitle: 'Entry and log settings', settingsDesc: 'These values are written to the Cabrillo header and determine the entry category.',
    expandSettings: 'Expand settings', collapseSettings: 'Collapse settings', unsaved: 'Unsaved',
    setupStatus: 'Contest settings', confirmed: 'Confirmed', unconfirmed: 'Not confirmed', ledgerStatus: 'Log status',
    operatorLabel: 'Operator category', operatorHelp: 'Choose whether one person performs all operating and logging, or multiple operators participate.',
    transmitterLabel: 'Transmitter category', bandLabel: 'Entry band', powerLabel: 'Power category',
    locationLabel: 'Cabrillo location', locationSectionHelp: 'US and Canadian stations must enter an ARRL/RAC section such as OH, EMA, or ON.',
    locationDxHelp: 'Stations outside the US and Canada use the official DX location value.',
    operatorsLabel: 'Operator callsigns', operatorsRequired: 'Required for multi-operator entries; separate callsigns with spaces or commas.',
    operatorsOptional: 'Optional for single-operator entries; use it when operating at another station.',
    invalidGrid: 'The radio operator must have a valid four-character Maidenhead grid.',
    missingLocation: 'Enter the ARRL/RAC section for the station location.', missingOperators: 'A multi-operator entry requires at least one operator callsign.',
    operatorOptions: { 'SINGLE-OP': 'Single operator (SINGLE-OP)', 'MULTI-OP': 'Multi-operator (MULTI-OP)', CHECKLOG: 'Checklog, no score (CHECKLOG)' },
    transmitterOptions: { ONE: 'One transmitter (ONE)', TWO: 'Two transmitters (TWO)', UNLIMITED: 'Multiple transmitters (UNLIMITED)' },
    transmitterHelp: {
      ONE: 'Only one transmitted signal is permitted at a time. MULTI-ONE allows at most eight band changes per clock hour.',
      TWO: 'Multi-operator only: transmit on two different bands and identify transmitter 0 or 1 for every QSO.',
      UNLIMITED: 'All-band only; the six contest bands may be activated simultaneously.',
    },
    bandOptions: { ALL: 'All bands (ALL)', '160M': '160 metres (160M)', '80M': '80 metres (80M)', '40M': '40 metres (40M)', '20M': '20 metres (20M)', '15M': '15 metres (15M)', '10M': '10 metres (10M)' },
    bandHelp: 'Single-band entries must still submit every QSO; only the selected band is scored.',
    powerOptions: { HIGH: 'High power (up to 1500 W)', LOW: 'Low power (up to 100 W)', QRP: 'QRP (up to 5 W)' },
    powerHelp: 'The limit is total transmitter output on each band at any time.',
    health: { healthy: 'Healthy', degraded: 'Needs attention', unknown: 'Checking' },
  },
};

type ContestConfig = PageState['config'];
type OperatorCategory = 'SINGLE-OP' | 'MULTI-OP' | 'CHECKLOG';
type TransmitterCategory = 'ONE' | 'TWO' | 'UNLIMITED';
type PowerCategory = 'HIGH' | 'LOW' | 'QRP';
const BANDS = ['ALL', '160M', '80M', '40M', '20M', '15M', '10M'] as const;

function operatorCategory(config: ContestConfig): OperatorCategory {
  return (config.categoryOperator ?? 'SINGLE-OP') as OperatorCategory;
}

function transmitterCategory(config: ContestConfig): TransmitterCategory {
  return (config.categoryTransmitter ?? 'ONE') as TransmitterCategory;
}

function normalizeCategoryDraft(config: ContestConfig): ContestConfig {
  const next = { ...config };
  const operator = operatorCategory(next);
  let transmitter = transmitterCategory(next);
  if (operator === 'SINGLE-OP' && transmitter === 'TWO') transmitter = 'ONE';
  next.categoryTransmitter = transmitter;
  if (operator === 'MULTI-OP' || transmitter === 'UNLIMITED') next.categoryBand = 'ALL';
  if (operator === 'MULTI-OP' && transmitter === 'ONE' && next.categoryPower === 'QRP') next.categoryPower = 'LOW';
  if (operator === 'MULTI-OP' && transmitter !== 'ONE') next.categoryPower = 'HIGH';
  return next;
}

function transmitterOptions(config: ContestConfig): TransmitterCategory[] {
  if (operatorCategory(config) === 'SINGLE-OP') return ['ONE', 'UNLIMITED'];
  return ['ONE', 'TWO', 'UNLIMITED'];
}

function powerOptions(config: ContestConfig): PowerCategory[] {
  if (operatorCategory(config) !== 'MULTI-OP') return ['HIGH', 'LOW', 'QRP'];
  return transmitterCategory(config) === 'ONE' ? ['HIGH', 'LOW'] : ['HIGH'];
}

function bandOptions(config: ContestConfig): readonly (typeof BANDS)[number][] {
  return operatorCategory(config) === 'MULTI-OP' || transmitterCategory(config) === 'UNLIMITED'
    ? ['ALL']
    : BANDS;
}

function formatDeadline(timestamp?: number): string {
  if (!timestamp) return '';
  const iso = new Date(timestamp).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function configFingerprint(config?: ContestConfig | null): string {
  if (!config) return '';
  return JSON.stringify({
    operator: operatorCategory(config),
    transmitter: transmitterCategory(config),
    band: config.categoryBand,
    power: config.categoryPower,
    location: config.location.trim().toUpperCase(),
    operators: [...(config.operators ?? [])].map((value) => value.trim().toUpperCase()).filter(Boolean).sort(),
  });
}

export const wwDigiContestLogUiTestables = {
  normalizeCategoryDraft,
  transmitterOptions,
  powerOptions,
  bandOptions,
  formatDeadline,
};

export function App() {
  const [bridgeLocale, setBridgeLocale] = useState('en');
  const locale = bridgeLocale.startsWith('zh') ? 'zh' : bridgeLocale.startsWith('ja') ? 'ja' : 'en';
  const t = text[locale];
  const [state, setState] = useState<PageState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<PageState['config'] | null>(null);
  const [settingsExpanded, setSettingsExpanded] = useState(true);
  const settingsExpansionInitialized = useRef(false);
  const healthState = stateHealth(state?.health.state);

  const load = useCallback(async () => {
    setError('');
    const next = await tx5dr.invoke('getState', {}) as PageState;
    setState(next);
    setDraft(normalizeCategoryDraft({
      ...next.config,
      ...(!next.station.requiresSection ? { location: 'DX' } : {}),
    }));
    if (!settingsExpansionInitialized.current) {
      setSettingsExpanded(next.setup.status !== 'confirmed');
      settingsExpansionInitialized.current = true;
    }
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
      const countsAsWorked = record.status === 'included' || record.status === 'review';
      const dupe = countsAsWorked && worked.has(key);
      if (countsAsWorked) worked.add(key);
      return { ...record, dupe };
    });
  }, [state?.records]);

  const updateDraft = (patch: Partial<ContestConfig>) => {
    setDraft((current) => current ? normalizeCategoryDraft({ ...current, ...patch }) : current);
  };
  const draftOperator = draft ? operatorCategory(draft) : 'SINGLE-OP';
  const draftTransmitter = draft ? transmitterCategory(draft) : 'ONE';
  const settingsDirty = configFingerprint(draft) !== configFingerprint(state?.config);
  const settingsSummary = useMemo(() => {
    if (!draft) return '';
    const operators = (draft.operators ?? []).join(', ');
    return [
      t.operatorOptions[draftOperator],
      t.transmitterOptions[draftTransmitter],
      t.bandOptions[draft.categoryBand as keyof typeof t.bandOptions],
      t.powerOptions[draft.categoryPower as PowerCategory],
      draft.location.trim().toUpperCase(),
      operators ? `${t.operatorsLabel}: ${operators}` : undefined,
    ].filter(Boolean).join(' · ');
  }, [draft, draftOperator, draftTransmitter, t]);
  const formIssue = useMemo(() => {
    if (!state || !draft) return '';
    if (!/^[A-R]{2}\d{2}$/.test(state.station.grid)) return t.invalidGrid;
    if (state.station.requiresSection && (!draft.location.trim() || draft.location.trim().toUpperCase() === 'DX')) {
      return t.missingLocation;
    }
    if (operatorCategory(draft) === 'MULTI-OP' && (draft.operators ?? []).length === 0) {
      return t.missingOperators;
    }
    return '';
  }, [draft, state, t.invalidGrid, t.missingLocation, t.missingOperators]);

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
    setSettingsExpanded(false);
  });
  const setTransmitter = (record: ContestQso, transmitterId: 0 | 1) => run(async () => {
    await tx5dr.invoke('setTransmitter', { qsoId: record.qsoId, transmitterId });
    await load();
  });

  return (
    <main className={settingsExpanded ? 'settings-expanded' : 'settings-collapsed'}>
      <header className="summary-bar">
        <div className="summary-copy">
          <h1>{state ? t.contestTitle.replace('{{year}}', String(state.contestYear)) : 'WW Digi'}</h1>
          {state?.station && (
            <div className="summary-meta">
              <span><strong>{t.station}</strong> {state.station.callsign}</span>
              <span><strong>{t.grid}</strong> {state.station.grid}</span>
            </div>
          )}
          {state?.deadline && <p><strong>{t.deadline}</strong> {formatDeadline(state.deadline)}</p>}
        </div>
        <div className="actions">
          <span className={`health ${state?.setup.status === 'confirmed' ? 'health-healthy' : 'health-unconfirmed'}`}>
            {t.setupStatus}: {state?.setup.status === 'confirmed' ? t.confirmed : t.unconfirmed}
          </span>
          <span
            className={`health health-${healthState}`}
            title={state?.health.error}
          >
            {t.ledgerStatus}: {t.health[healthState]}
          </span>
          <button className="button button-sm button-flat" type="button" disabled={busy} onClick={() => void reconcile()}>
            {t.reconcile}
          </button>
          <button
            type="button"
            className="button button-sm button-solid button-primary"
            disabled={busy || !state || state.health.state !== 'healthy' || state.setup.status !== 'confirmed'}
            onClick={() => void download()}
          >{t.download}</button>
        </div>
      </header>
      {error && <div role="alert" className="error">{error}</div>}
      {state?.setup.status !== 'confirmed' && <div role="alert" className="setup-alert">{t.setupRequired}</div>}
      {draft && (
        <section className="settings-section" aria-labelledby="contest-settings-title">
          <div className="settings-heading">
            <button
              type="button"
              className="settings-toggle"
              aria-expanded={settingsExpanded}
              aria-controls="contest-settings-fields"
              onClick={() => setSettingsExpanded((expanded) => !expanded)}
            >
              <span className="settings-toggle-copy">
                <span className="settings-title-line">
                  <span id="contest-settings-title" className="settings-title">{t.settingsTitle}</span>
                  {settingsDirty && <span className="unsaved-indicator">{t.unsaved}</span>}
                </span>
                {settingsExpanded ? (
                  <span className="settings-description">{t.settingsDesc}</span>
                ) : (
                  <span className="settings-summary" title={settingsSummary}>{settingsSummary}</span>
                )}
              </span>
              <span className="settings-toggle-action">
                {settingsExpanded ? t.collapseSettings : t.expandSettings}
                <span className={`disclosure-chevron ${settingsExpanded ? 'is-expanded' : ''}`} aria-hidden="true" />
              </span>
            </button>
          </div>
          {settingsExpanded && <>
          <div id="contest-settings-fields" className="session-form">
            <label className="form-field">
              <span className="field-label">{t.operatorLabel}</span>
              <select
                value={draftOperator}
                onChange={(event) => updateDraft({ categoryOperator: event.target.value })}
              >
                {(['SINGLE-OP', 'MULTI-OP', 'CHECKLOG'] as OperatorCategory[]).map((value) => (
                  <option key={value} value={value}>{t.operatorOptions[value]}</option>
                ))}
              </select>
              <span className="field-help">{t.operatorHelp}</span>
            </label>

            <label className="form-field">
              <span className="field-label">{t.transmitterLabel}</span>
              <select
                value={draftTransmitter}
                onChange={(event) => updateDraft({ categoryTransmitter: event.target.value })}
              >
                {transmitterOptions(draft).map((value) => (
                  <option key={value} value={value}>{t.transmitterOptions[value]}</option>
                ))}
              </select>
              <span className="field-help">{t.transmitterHelp[draftTransmitter]}</span>
            </label>

            <label className="form-field">
              <span className="field-label">{t.bandLabel}</span>
              <select value={draft.categoryBand} onChange={(event) => updateDraft({ categoryBand: event.target.value })}>
                {bandOptions(draft).map((value) => <option key={value} value={value}>{t.bandOptions[value]}</option>)}
              </select>
              <span className="field-help">{t.bandHelp}</span>
            </label>

            <label className="form-field">
              <span className="field-label">{t.powerLabel}</span>
              <select value={draft.categoryPower} onChange={(event) => updateDraft({ categoryPower: event.target.value })}>
                {powerOptions(draft).map((value) => <option key={value} value={value}>{t.powerOptions[value]}</option>)}
              </select>
              <span className="field-help">{t.powerHelp}</span>
            </label>

            <label className="form-field">
              <span className="field-label">{t.locationLabel}</span>
              <input
                value={draft.location}
                disabled={!state?.station.requiresSection}
                required={state?.station.requiresSection}
                placeholder={state?.station.requiresSection ? 'OH / EMA / ON' : 'DX'}
                onChange={(event) => updateDraft({ location: event.target.value.toUpperCase() })}
              />
              <span className="field-help">{state?.station.requiresSection ? t.locationSectionHelp : t.locationDxHelp}</span>
            </label>

            <label className="form-field form-field-wide">
              <span className="field-label">{t.operatorsLabel}{draftOperator === 'MULTI-OP' ? ' *' : ''}</span>
              <input
                value={(draft.operators ?? []).join(', ')}
                required={draftOperator === 'MULTI-OP'}
                placeholder={draftOperator === 'MULTI-OP' ? 'K1ABC, JA1XYZ' : ''}
                onChange={(event) => updateDraft({
                  operators: event.target.value.split(/[\s,]+/).filter(Boolean).map((value) => value.toUpperCase()),
                })}
              />
              <span className="field-help">{draftOperator === 'MULTI-OP' ? t.operatorsRequired : t.operatorsOptional}</span>
            </label>
          </div>
          <div className="settings-footer">
            <span className="form-issue" role={formIssue ? 'alert' : undefined}>{formIssue}</span>
            <button
              className="button button-sm button-solid button-primary"
              type="button"
              disabled={busy || Boolean(formIssue)}
              onClick={() => void saveSession()}
            >{t.save}</button>
          </div>
          </>}
        </section>
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
