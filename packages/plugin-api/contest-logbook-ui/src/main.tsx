/// <reference types="@tx5dr/plugin-api/bridge" />
import { createRoot } from 'react-dom/client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import './style.css';

type Status = 'included' | 'review' | 'excluded' | 'x-qso';
type Row = {
  id: string;
  callsign: string;
  band: string;
  mode: 'FT8' | 'FT4';
  time: number;
  status: Status;
  fields?: Record<string, unknown>;
  [key: string]: unknown;
};
type State = {
  schemaVersion: number;
  contest: {
    id: string;
    editionId: string;
    rulesetVersion: string;
    title?: string;
    officialUrl?: string;
    startAt?: string;
    endAt?: string;
    modes?: string[];
    bands?: string[];
    exchangeId?: string;
    exchangeSummary?: string;
    completionId?: string;
    ruleSummary?: string;
    scoringSummary?: string;
  };
  health: { state: string; readable: boolean; writable: boolean; error?: string };
  settings: { value: Record<string, unknown>; valid: boolean; issues: string[]; fields?: Field[] };
  score: { claimedScore: number; qsoPoints: number; multiplierCount: number; details?: ScoreDetails };
  qsos: Row[];
  review: { pendingCount: number; issues: Issue[] };
  import: { state: string; token?: string; preview?: Preview; error?: string };
  export: { formats: Format[] };
  columns?: Column[];
  presentation?: Presentation;
};
type Field = { key: string; label?: string; type?: string; description?: string; options?: { label: string; value: string }[] };
type Column = { key: string; label: string };
type Issue = { code: string; message: string; qsoId?: string; field?: string; severity?: string };
type Format = { id: string; label: string; extension: string; enabled: boolean };
type Preview = { [key: string]: unknown };
type Presentation = { title?: string; labels?: Record<string, string> };
type ScoreDetails = { moduleId?: string; summary?: string; qsoCount?: number; multiplierCount?: number; total?: number };

const text = {
  en: { title: 'Contest log', loading: 'Loading…', health: 'Health', score: 'Score', qsoPoints: 'QSO points', multipliers: 'Multipliers', qsos: 'QSOs', review: 'Review', rules: 'Contest rules', ruleSummary: 'Rule summary', officialRules: 'Official rules', openOfficialRules: 'Open official rules', contestWindow: 'Contest window', modes: 'Modes', bands: 'Bands', exchange: 'Exchange', completion: 'Completion', scoringDetails: 'Scoring details', scoringModule: 'Scoring module', scoreFormula: 'Scoring summary', totalScore: 'Total score', notProvided: 'Not provided', settings: 'Settings', expand: 'Expand section', collapse: 'Collapse section', save: 'Save', saved: 'Saved', import: 'Import ADIF', export: 'Export', chooseFile: 'Choose ADIF file', preview: 'Preview', commit: 'Commit import', cancel: 'Cancel', noRows: 'No QSOs yet', included: 'Included', reviewStatus: 'Review', excluded: 'Excluded', xQso: 'X-QSO', download: 'Download', invalid: 'Invalid settings', noExport: 'No export formats available', ready: 'Ready', degraded: 'Degraded', error: 'Error', issueLabels: { outside_edition: 'Outside contest edition', review: 'Needs review', dupe: 'Duplicate', unsupported_mode: 'Unsupported mode', unsupported_band: 'Unsupported band', x_qso: 'Excluded QSO', excluded: 'Excluded', missing_grid: 'Missing grid exchange' }, fieldLabels: { contestYear: 'Contest year', location: 'Location', categoryBand: 'Band category', categoryPower: 'Power category', categoryOperator: 'Operator category', categoryTransmitter: 'Transmitter category', operators: 'Operators' } },
  zh: { title: '比赛日志', loading: '加载中…', health: '健康状态', score: '分数', qsoPoints: 'QSO 分', multipliers: '系数', qsos: 'QSO', review: '待审核', rules: '比赛规则', ruleSummary: '规则简介', officialRules: '官方规则', openOfficialRules: '查看官方网站规则', contestWindow: '比赛时间', modes: '模式', bands: '波段', exchange: '交换字段', completion: '完成条件', scoringDetails: '计分详情', scoringModule: '计分模块', scoreFormula: '计分说明', totalScore: '总分', notProvided: '暂无信息', settings: '设置', expand: '展开区块', collapse: '收起区块', save: '保存', saved: '已保存', import: '导入 ADIF', export: '导出', chooseFile: '选择 ADIF 文件', preview: '预览', commit: '提交导入', cancel: '取消', noRows: '暂无 QSO', included: '计入', reviewStatus: '待审核', excluded: '排除', xQso: 'X-QSO', download: '下载', invalid: '设置无效', noExport: '暂无可用导出格式', ready: '正常', degraded: '降级', error: '错误', issueLabels: { outside_edition: '超出比赛时间', review: '需要审核', dupe: '重复通联', unsupported_mode: '不支持的模式', unsupported_band: '不支持的波段', x_qso: '排除的 QSO', excluded: '已排除', missing_grid: '缺少网格交换字段' }, fieldLabels: { contestYear: '比赛年份', location: '地区', categoryBand: '波段类别', categoryPower: '功率类别', categoryOperator: '操作员类别', categoryTransmitter: '发射机类别', operators: '操作员' } },
  ja: { title: 'コンテストログ', loading: '読み込み中…', health: '状態', score: 'スコア', qsoPoints: 'QSO 点', multipliers: 'マルチ', qsos: 'QSO', review: '要確認', rules: 'コンテスト規則', ruleSummary: '規則概要', officialRules: '公式規則', openOfficialRules: '公式サイトの規則を開く', contestWindow: '開催期間', modes: 'モード', bands: 'バンド', exchange: '交換項目', completion: '完了条件', scoringDetails: '得点詳細', scoringModule: '得点モジュール', scoreFormula: '得点概要', totalScore: '合計スコア', notProvided: '情報なし', settings: '設定', expand: 'セクションを展開', collapse: 'セクションを折りたたむ', save: '保存', saved: '保存済み', import: 'ADIF 取込', export: '出力', chooseFile: 'ADIF ファイルを選択', preview: 'プレビュー', commit: '取込を確定', cancel: 'キャンセル', noRows: 'QSO はありません', included: '有効', reviewStatus: '要確認', excluded: '除外', xQso: 'X-QSO', download: 'ダウンロード', invalid: '設定が無効です', noExport: '出力形式がありません', ready: '正常', degraded: '低下', error: 'エラー', issueLabels: { outside_edition: 'コンテスト期間外', review: '要確認', dupe: '重複', unsupported_mode: '未対応モード', unsupported_band: '未対応バンド', x_qso: '除外 QSO', excluded: '除外済み', missing_grid: 'グリッド交換がありません' }, fieldLabels: { contestYear: 'コンテスト年', location: '地域', categoryBand: 'バンド区分', categoryPower: '電力区分', categoryOperator: 'オペレーター区分', categoryTransmitter: '送信機区分', operators: 'オペレーター' } },
} as const;

function localeKey(): keyof typeof text {
  const locale = window.tx5dr?.locale?.toLowerCase() ?? 'en';
  if (locale.startsWith('zh')) return 'zh';
  if (locale.startsWith('ja')) return 'ja';
  return 'en';
}

function labelFor(value: unknown, labels: Record<string, string> | undefined, fallback: string): string {
  if (typeof value === 'string' && labels?.[value]) return labels[value];
  return fallback;
}

function formatTime(value: unknown): string {
  const timestamp = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(timestamp)) return '';
  return new Date(timestamp).toISOString().replace('T', ' ').slice(0, 16);
}

function formatDateRange(startAt: string | undefined, endAt: string | undefined): string {
  const start = startAt ? new Date(startAt) : undefined;
  const end = endAt ? new Date(endAt) : undefined;
  const format = (value: Date | undefined) => value && Number.isFinite(value.getTime()) ? value.toLocaleString() : '';
  const startText = format(start);
  const endText = format(end);
  if (startText && endText) return `${startText} – ${endText}`;
  return startText || endText;
}

function isHttpUrl(value: string | undefined): value is string {
  return Boolean(value && /^https?:\/\//i.test(value));
}

function statusLabel(status: Status, dictionary: typeof text.en): string {
  if (status === 'review') return dictionary.reviewStatus;
  if (status === 'excluded') return dictionary.excluded;
  if (status === 'x-qso') return dictionary.xQso;
  return dictionary.included;
}

function issueLabel(issue: Issue, dictionary: typeof text.en): string {
  return dictionary.issueLabels[issue.code] ?? issue.message;
}

function downloadText(textValue: string, fileName: string, mediaType = 'text/plain'): void {
  const blob = new Blob([textValue], { type: mediaType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function App() {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const [fileName, setFileName] = useState('');
  const [dictionary, setDictionary] = useState(text[localeKey()]);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => window.tx5dr?.theme ?? 'dark');
  const [settingsExpanded, setSettingsExpanded] = useState(true);
  const [rulesExpanded, setRulesExpanded] = useState(true);
  const [scoreDetailsExpanded, setScoreDetailsExpanded] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const next = await window.tx5dr.invoke('get-state') as State;
      setState(next);
      setDraft(next.settings.value ?? {});
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  useEffect(() => {
    void window.tx5dr.ready.then(refresh);
    const onChanged = () => { void refresh(); };
    window.tx5dr.onPush('stateChanged', onChanged);
    const unsubscribeLocale = window.tx5dr.onLocaleChange(() => setDictionary(text[localeKey()]));
    const applyTheme = (nextTheme: 'dark' | 'light') => {
      setTheme(nextTheme);
      document.documentElement.style.colorScheme = nextTheme;
    };
    applyTheme(window.tx5dr.theme);
    const unsubscribeTheme = window.tx5dr.onThemeChange(applyTheme);
    return () => {
      window.tx5dr.offPush('stateChanged', onChanged);
      unsubscribeLocale();
      unsubscribeTheme();
    };
  }, [refresh]);

  const invoke = useCallback(async (action: string, payload?: unknown) => {
    setBusy(true);
    try {
      const result = await window.tx5dr.invoke(action, payload);
      await refresh();
      return result;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const columns = useMemo<Column[]>(() => state?.columns ?? [
    { key: 'callsign', label: 'Callsign' },
    { key: 'band', label: 'Band' },
    { key: 'mode', label: 'Mode' },
    { key: 'time', label: 'Time' },
    { key: 'status', label: dictionary.review },
  ], [dictionary.review, state?.columns]);
  const settingFields = state?.settings.fields ?? Object.keys(draft).map((key) => ({ key }));

  const handleImport = async (file: File) => {
    setFileName(file.name);
    const path = await window.tx5dr.fileUpload(`imports/${file.name}`, file);
    const result = await invoke('preview-import', { path, fileName: file.name });
    const response = result as { token?: string; preview?: Preview };
    setPreview({ ...(response.preview ?? response), ...(response.token ? { token: response.token } : {}) });
  };

  const handleExport = async (formatId: string) => {
    const result = await invoke('export', { formatId }) as { text: string; fileName?: string; mediaType?: string };
    downloadText(result.text, result.fileName ?? `contest-log.${formatId}`, result.mediaType);
  };

  if (!state && !error) return <main className="loading">{dictionary.loading}</main>;
  if (!state) return <main className="error" role="alert">{error}</main>;
  const presentation = state.presentation;
  const title = presentation?.title ?? state.contest.title ?? dictionary.title;
  const healthLabel = labelFor(state.health.state, presentation?.labels, state.health.state);
  const scoreDetails = state.score.details ?? {};
  const officialUrl = isHttpUrl(state.contest.officialUrl) ? state.contest.officialUrl : undefined;
  const ruleFacts = [
    state.contest.modes?.length ? { label: dictionary.modes, value: state.contest.modes.join(' / ') } : undefined,
    state.contest.bands?.length ? { label: dictionary.bands, value: state.contest.bands.join(', ') } : undefined,
    state.contest.exchangeId ? { label: dictionary.exchange, value: state.contest.exchangeSummary ?? state.contest.exchangeId } : undefined,
    state.contest.completionId ? { label: dictionary.completion, value: state.contest.completionId } : undefined,
    formatDateRange(state.contest.startAt, state.contest.endAt) ? { label: dictionary.contestWindow, value: formatDateRange(state.contest.startAt, state.contest.endAt) } : undefined,
  ].filter((fact): fact is { label: string; value: string } => Boolean(fact));
  const hasRules = Boolean(state.contest.ruleSummary || officialUrl || ruleFacts.length > 0);
  const hasScoreDetails = Boolean(state.contest.scoringSummary || scoreDetails.summary || scoreDetails.moduleId);

  return (
    <main className={`page theme-${theme}`}>
      <header className="header">
        <div><h1>{title}</h1><p>{state.contest.id} · {state.contest.editionId} · {state.contest.rulesetVersion}</p></div>
        <span className={`health health-${state.health.state}`}>{dictionary.health}: {healthLabel}</span>
      </header>
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      {state.health.error && <div className="alert alert-warning">{state.health.error}</div>}
      <section className="score-grid" aria-label={dictionary.score}>
        <div className="score primary"><span>{dictionary.score}</span><strong>{state.score.claimedScore}</strong></div>
        <div className="score"><span>{dictionary.qsoPoints}</span><strong>{state.score.qsoPoints}</strong></div>
        <div className="score"><span>{dictionary.multipliers}</span><strong>{state.score.multiplierCount}</strong></div>
        <div className={`score ${state.review.pendingCount > 0 ? 'score-warning' : ''}`}><span>{dictionary.review}</span><strong>{state.review.pendingCount}</strong></div>
      </section>
      {hasRules && <section className="section rules-section">
        <button className="section-toggle" type="button" aria-expanded={rulesExpanded} onClick={() => setRulesExpanded((expanded) => !expanded)}>
          <span>{dictionary.rules}</span>
          <span className={`disclosure-chevron ${rulesExpanded ? 'is-expanded' : ''}`} aria-hidden="true" />
          <span className="sr-only">{rulesExpanded ? dictionary.collapse : dictionary.expand}</span>
        </button>
        {rulesExpanded && <div className="rules-content">
          <p className="rule-summary">{state.contest.ruleSummary ?? dictionary.notProvided}</p>
          {ruleFacts.length > 0 && <div className="rule-facts">{ruleFacts.map((fact) => <div className="rule-fact" key={fact.label}><span>{fact.label}</span><strong>{fact.value}</strong></div>)}</div>}
          {officialUrl && <a className="official-link" href={officialUrl} target="_blank" rel="noreferrer" onClick={(event) => { event.preventDefault(); window.tx5dr.openExternal(officialUrl); }}>{dictionary.openOfficialRules}</a>}
        </div>}
      </section>}
      {hasScoreDetails && <section className="section score-details-section">
        <button className="section-toggle" type="button" aria-expanded={scoreDetailsExpanded} onClick={() => setScoreDetailsExpanded((expanded) => !expanded)}>
          <span>{dictionary.scoringDetails}</span>
          <span className={`disclosure-chevron ${scoreDetailsExpanded ? 'is-expanded' : ''}`} aria-hidden="true" />
          <span className="sr-only">{scoreDetailsExpanded ? dictionary.collapse : dictionary.expand}</span>
        </button>
        {scoreDetailsExpanded && <div className="score-details">
          <p className="rule-summary">{scoreDetails.summary ?? state.contest.scoringSummary ?? dictionary.notProvided}</p>
          <div className="detail-grid">
            {scoreDetails.moduleId && <div><span>{dictionary.scoringModule}</span><strong>{scoreDetails.moduleId}</strong></div>}
            {scoreDetails.qsoCount !== undefined && <div><span>{dictionary.qsos}</span><strong>{scoreDetails.qsoCount}</strong></div>}
            {scoreDetails.multiplierCount !== undefined && <div><span>{dictionary.multipliers}</span><strong>{scoreDetails.multiplierCount}</strong></div>}
            {scoreDetails.total !== undefined && <div><span>{dictionary.totalScore}</span><strong>{scoreDetails.total}</strong></div>}
          </div>
        </div>}
      </section>}
      {settingFields.length > 0 && <section className="section">
        <button className="section-toggle" type="button" aria-expanded={settingsExpanded} onClick={() => setSettingsExpanded((expanded) => !expanded)}>
          <span>{dictionary.settings}</span>
          <span className={`disclosure-chevron ${settingsExpanded ? 'is-expanded' : ''}`} aria-hidden="true" />
          <span className="sr-only">{settingsExpanded ? dictionary.collapse : dictionary.expand}</span>
        </button>
        {settingsExpanded && <>
        <div className="settings-grid">
          {settingFields.map((field) => (
            <label key={field.key} className="field">
              <span>{field.label && field.label !== field.key ? field.label : dictionary.fieldLabels[field.key] ?? field.key}</span>
              {field.options ? (
                <select value={String(draft[field.key] ?? '')} onChange={(event) => setDraft({ ...draft, [field.key]: event.target.value })}>
                  {field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              ) : (
                <input type={field.type === 'number' ? 'number' : field.type === 'boolean' ? 'checkbox' : 'text'} checked={field.type === 'boolean' ? draft[field.key] === true : undefined} value={field.type === 'boolean' ? undefined : String(draft[field.key] ?? '')} onChange={(event) => setDraft({ ...draft, [field.key]: field.type === 'boolean' ? event.target.checked : event.target.value })} />
              )}
            </label>
          ))}
        </div>
        {state.settings.issues.length > 0 && <div className="issues">{state.settings.issues.map((issue) => <div key={issue}>{issue}</div>)}</div>}
        <button disabled={busy || !state.settings.valid} onClick={() => { void invoke('save-settings', draft).then(() => { setSaved(true); window.setTimeout(() => setSaved(false), 1800); }); }}>{saved ? dictionary.saved : dictionary.save}</button>
        </>}
      </section>}
      <section className="section import-export">
        <div><h2>{dictionary.import}</h2><label className="file-button"><input type="file" accept=".adi,.adif,text/plain" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void handleImport(file); }} />{fileName || dictionary.chooseFile}</label>{preview && <div className="preview"><strong>{dictionary.preview}</strong><pre>{JSON.stringify(preview, null, 2)}</pre><button disabled={busy} onClick={() => { const token = (preview as { token?: string }).token; void invoke('commit-import', { token }).then(() => setPreview(null)); }}>{dictionary.commit}</button><button className="secondary" disabled={busy} onClick={() => { const token = (preview as { token?: string }).token; void invoke('cancel-import', { token }).then(() => setPreview(null)); }}>{dictionary.cancel}</button></div>}</div>
        <div><h2>{dictionary.export}</h2><div className="export-buttons">{state.export.formats.length === 0 ? <span className="muted">{dictionary.noExport}</span> : state.export.formats.map((format) => <button key={format.id} disabled={busy || !format.enabled} onClick={() => { void handleExport(format.id); }}>{format.label} {format.extension}</button>)}</div></div>
      </section>
      <section className="section"><h2>{dictionary.qsos} ({state.qsos.length})</h2><div className="table-wrap"><table><thead><tr>{columns.map((column) => <th key={column.key}>{column.label}</th>)}<th>{dictionary.review}</th></tr></thead><tbody>{state.qsos.length === 0 ? <tr><td colSpan={columns.length + 1} className="empty">{dictionary.noRows}</td></tr> : state.qsos.map((row) => <tr key={row.id}>{columns.map((column) => <td key={column.key}>{column.key === 'time' ? formatTime(row[column.key]) : String(row[column.key] ?? row.fields?.[column.key] ?? '')}</td>)}<td><select value={row.status} disabled={busy} onChange={(event) => { void invoke('set-qso-status', { qsoId: row.id, status: event.target.value }); }}>{(['included', 'review', 'excluded', 'x-qso'] as Status[]).map((status) => <option key={status} value={status}>{statusLabel(status, dictionary)}</option>)}</select></td></tr>)}</tbody></table></div></section>
      {state.review.issues.length > 0 && <section className="section"><h2>{dictionary.review}</h2><div className="issue-list">{state.review.issues.map((issue, index) => <div key={`${issue.qsoId ?? 'global'}-${issue.code}-${index}`}><strong>{issueLabel(issue, dictionary)}</strong>{issue.message !== issue.code && issue.message !== issueLabel(issue, dictionary) ? `: ${issue.message}` : ''}</div>)}</div></section>}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
