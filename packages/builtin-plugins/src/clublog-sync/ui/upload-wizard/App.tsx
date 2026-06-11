/// <reference types="@tx5dr/plugin-api/bridge" />
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../../_shared/ui/useI18n';
import { useAutoResize } from '../../../_shared/ui/useAutoResize';
import './App.css';

const I18N: Record<string, Record<string, string>> = {
  zh: {
    description: '批量上传会把 ADIF 文件提交到 Club Log 队列。Club Log 接受文件不代表已逐条导入完成，请稍后在 Club Log 网站查看最终结果。',
    rangeTitle: '上传时间范围',
    sinceDateLabel: '开始日期',
    untilDateLabel: '截止日期',
    includeUploaded: '包含已提交到 Club Log 的 QSO',
    includeUploadedDesc: '忽略本地上传账本，重新提交匹配时间范围内的记录',
    invalidRange: '开始日期不能晚于截止日期',
    loading: '正在检查上传准备状态...',
    pending: '待处理',
    uploadable: '可上传',
    skipped: '已跳过',
    blocked: '被阻塞',
    issueListTitle: '需要处理或跳过的 QSO',
    readyTitle: '可以提交到 Club Log',
    blockedTitle: '上传被阻塞',
    noPending: '当前没有可提交的 QSO。',
    refresh: '重新检查',
    uploadAll: '批量提交到 Club Log',
    skipAndUpload: '跳过阻塞 QSO 并提交',
    uploading: '正在提交...',
    success: '批量提交完成',
    failed: '批量提交失败',
    submitted: '已提交',
    uploaded: '已标记提交',
    failedCount: '失败',
    errors: '错误',
    retryable: '可重试',
    progressPreparing: '正在准备上传记录...',
    progressPrepared: '已准备 {uploadable} 条可上传 QSO',
    progressUploadingBatch: '正在提交 {count} 条 QSO 到 Club Log',
    progressAccepted: 'Club Log 已接受批量文件',
    progressFailed: '批量提交失败',
    progressFinished: '上传流程结束',
    progressCounts: '已提交 {submitted}，已标记 {uploaded}，已跳过 {skipped}，失败 {failed}',
  },
  ja: {
    description: '一括アップロードでは ADIF ファイルを Club Log のキューに送信します。ファイルの受付は各 QSO の最終インポート完了を意味しません。後で Club Log で結果を確認してください。',
    rangeTitle: 'アップロード時間範囲',
    sinceDateLabel: '開始日',
    untilDateLabel: '終了日',
    includeUploaded: 'Club Log に送信済みの QSO も含める',
    includeUploadedDesc: 'ローカル送信記録を無視して、範囲内の記録を再送信します',
    invalidRange: '開始日は終了日より後にできません',
    loading: 'アップロード準備状態を確認しています...',
    pending: '対象',
    uploadable: 'アップロード可能',
    skipped: 'スキップ済み',
    blocked: 'ブロック',
    issueListTitle: '処理またはスキップが必要な QSO',
    readyTitle: 'Club Log に送信できます',
    blockedTitle: 'アップロードがブロックされました',
    noPending: '送信可能な QSO はありません。',
    refresh: '再確認',
    uploadAll: 'Club Log に一括送信',
    skipAndUpload: 'ブロックされた QSO をスキップして送信',
    uploading: '送信中...',
    success: '一括送信完了',
    failed: '一括送信失敗',
    submitted: '送信済み',
    uploaded: '送信マーク済み',
    failedCount: '失敗',
    errors: 'エラー',
    retryable: '再試行可能',
    progressPreparing: 'アップロード記録を準備しています...',
    progressPrepared: '{uploadable} 件の QSO を準備しました',
    progressUploadingBatch: '{count} 件の QSO を Club Log に送信しています',
    progressAccepted: 'Club Log が一括ファイルを受け付けました',
    progressFailed: '一括送信失敗',
    progressFinished: 'アップロード処理が終了しました',
    progressCounts: '送信 {submitted}、マーク済み {uploaded}、スキップ {skipped}、失敗 {failed}',
  },
  en: {
    description: 'Batch upload submits an ADIF file to the Club Log queue. Acceptance does not mean each QSO has finished importing; check Club Log later for final results.',
    rangeTitle: 'Upload date range',
    sinceDateLabel: 'Start date',
    untilDateLabel: 'End date',
    includeUploaded: 'Include QSOs already submitted to Club Log',
    includeUploadedDesc: 'Ignore the local upload ledger and resubmit records in the selected range',
    invalidRange: 'Start date cannot be later than end date',
    loading: 'Checking upload readiness...',
    pending: 'Pending',
    uploadable: 'Uploadable',
    skipped: 'Skipped',
    blocked: 'Blocked',
    issueListTitle: 'QSOs to fix or skip',
    readyTitle: 'Ready to submit to Club Log',
    blockedTitle: 'Upload is blocked',
    noPending: 'There are no QSOs to submit.',
    refresh: 'Check again',
    uploadAll: 'Submit batch to Club Log',
    skipAndUpload: 'Skip blocked QSOs and submit',
    uploading: 'Submitting...',
    success: 'Batch submitted',
    failed: 'Batch submit failed',
    submitted: 'Submitted',
    uploaded: 'Marked submitted',
    failedCount: 'Failed',
    errors: 'Errors',
    retryable: 'Retryable',
    progressPreparing: 'Preparing upload records...',
    progressPrepared: 'Prepared {uploadable} uploadable QSOs',
    progressUploadingBatch: 'Submitting {count} QSOs to Club Log',
    progressAccepted: 'Club Log accepted the batch file',
    progressFailed: 'Batch submit failed',
    progressFinished: 'Upload flow finished',
    progressCounts: 'Submitted {submitted}, marked {uploaded}, skipped {skipped}, failed {failed}',
  },
};

interface PreflightIssue {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  detail?: string;
  qsoId?: string;
  qsoCallsign?: string;
}

interface PreflightResult {
  ready: boolean;
  pendingCount: number;
  uploadableCount: number;
  blockedCount: number;
  issues?: PreflightIssue[];
  canSkipBlocked?: boolean;
}

interface UploadFailure {
  code: string;
  message: string;
  qsoId?: string;
  qsoCallsign?: string;
  httpStatus?: number;
  retryable?: boolean;
  detail?: string;
}

interface UploadResult {
  submitted?: number;
  uploaded?: number;
  skipped?: number;
  failed?: number;
  failures?: UploadFailure[];
}

interface UploadProgress {
  stage: string;
  batchIndex?: number;
  batchCount?: number;
  qsoCount?: number;
  uploadableCount?: number;
  submitted?: number;
  uploaded?: number;
  skipped?: number;
  failed?: number;
  message?: string;
}

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

function parseDate(value: string, endOfDay = false): number | undefined {
  if (!value) return undefined;
  const suffix = endOfDay ? 'T23:59:59.999Z' : 'T00:00:00.000Z';
  return Date.parse(`${value}${suffix}`);
}

function progressText(progress: UploadProgress, t: (key: string, vars?: Record<string, string | number>) => string): string {
  const vars = {
    uploadable: progress.uploadableCount ?? 0,
    count: progress.qsoCount ?? 0,
    submitted: progress.submitted ?? 0,
    uploaded: progress.uploaded ?? 0,
    skipped: progress.skipped ?? 0,
    failed: progress.failed ?? 0,
  };
  switch (progress.stage) {
    case 'preparing': return t('progressPreparing');
    case 'prepared': return t('progressPrepared', vars);
    case 'batch_uploading': return t('progressUploadingBatch', vars);
    case 'batch_accepted': return t('progressAccepted');
    case 'batch_failed': return progress.message ? `${t('progressFailed')}: ${progress.message}` : t('progressFailed');
    case 'finished': return t('progressFinished');
    default: return progress.message || progress.stage;
  }
}

export function App() {
  const t = useI18n(I18N);
  const callsign = window.tx5dr.params.callsign ?? '';
  const today = useMemo(() => formatDate(new Date()), []);
  const [sinceDate, setSinceDate] = useState('');
  const [untilDate, setUntilDate] = useState(today);
  const [includeAlreadyUploaded, setIncludeAlreadyUploaded] = useState(false);
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<UploadProgress[]>([]);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useAutoResize();

  const range = useMemo(() => {
    const since = parseDate(sinceDate);
    const until = parseDate(untilDate, true);
    const valid = !since || !until || since <= until;
    return { since, until, valid };
  }, [sinceDate, untilDate]);

  const refresh = useCallback(() => {
    if (!range.valid) return;
    setLoading(true);
    setError(null);
    window.tx5dr.invoke('getUploadPreflight', {
      callsign,
      since: range.since,
      until: range.until,
      includeAlreadyUploaded,
    }).then((value: PreflightResult) => {
      setPreflight(value);
      setLoading(false);
    }).catch((err: any) => {
      setLoading(false);
      setError(err.message || String(err));
    });
  }, [callsign, range.since, range.until, range.valid, includeAlreadyUploaded]);

  useEffect(() => {
    const off = window.tx5dr.onPush?.('uploadProgress', (value: UploadProgress) => {
      setProgress(prev => [...prev, value]);
    });
    return () => { off?.(); };
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const performUpload = useCallback((skipBlockedQsos: boolean) => {
    if (!range.valid) return;
    setUploading(true);
    setProgress([]);
    setResult(null);
    setError(null);
    window.tx5dr.invoke('performUpload', {
      callsign,
      since: range.since,
      until: range.until,
      includeAlreadyUploaded,
      skipBlockedQsos,
    }).then((value: UploadResult) => {
      setResult(value);
      setUploading(false);
      refresh();
    }).catch((err: any) => {
      setUploading(false);
      setError(err.message || String(err));
    });
  }, [callsign, range.since, range.until, range.valid, includeAlreadyUploaded, refresh]);

  const skippedCount = preflight ? Math.max(0, preflight.pendingCount - preflight.uploadableCount - preflight.blockedCount) : 0;
  const issues = preflight?.issues ?? [];
  const hasErrors = issues.some(issue => issue.severity === 'error');

  return (
    <div className="container">
      <div className="description">{t('description')}</div>
      <div className="section-title">{t('rangeTitle')}</div>

      <div className="form-row">
        <div className="form-group">
          <label>{t('sinceDateLabel')}</label>
          <input type="date" value={sinceDate} onChange={e => setSinceDate(e.target.value)} />
        </div>
        <div className="form-group">
          <label>{t('untilDateLabel')}</label>
          <input type="date" value={untilDate} onChange={e => setUntilDate(e.target.value)} />
        </div>
      </div>

      {!range.valid && <div className="status status-danger">{t('invalidRange')}</div>}

      <div className="toggle-row">
        <div>
          <div className="toggle-label">{t('includeUploaded')}</div>
          <div className="toggle-desc">{t('includeUploadedDesc')}</div>
        </div>
        <label className="switch">
          <input type="checkbox" checked={includeAlreadyUploaded} onChange={e => setIncludeAlreadyUploaded(e.target.checked)} />
          <span className="slider" />
        </label>
      </div>

      {loading && <div className="status"><span className="spinner" /> {t('loading')}</div>}
      {error && <div className="status status-danger">{error}</div>}

      {preflight && (
        <>
          <div className="stats">
            <div className="stat-card"><div className="stat-value">{preflight.pendingCount}</div><div className="stat-label">{t('pending')}</div></div>
            <div className="stat-card"><div className="stat-value">{preflight.uploadableCount}</div><div className="stat-label">{t('uploadable')}</div></div>
            <div className="stat-card"><div className="stat-value">{skippedCount}</div><div className="stat-label">{t('skipped')}</div></div>
            <div className="stat-card"><div className="stat-value">{preflight.blockedCount}</div><div className="stat-label">{t('blocked')}</div></div>
          </div>

          <div className={`status ${preflight.ready ? 'status-success' : hasErrors ? 'status-danger' : ''}`}>
            {preflight.ready ? t('readyTitle') : preflight.pendingCount === 0 ? t('noPending') : t('blockedTitle')}
          </div>

          {issues.length > 0 && (
            <>
              <div className="section-title">{t('issueListTitle')}</div>
              <ul className="issue-list">
                {issues.map((issue, index) => (
                  <li key={`${issue.code}-${issue.qsoId ?? index}`} className={`issue issue-${issue.severity}`}>
                    <div>{issue.qsoCallsign ? `${issue.qsoCallsign}: ` : ''}{issue.message}</div>
                    {issue.detail && <div className="issue-detail">{issue.detail}</div>}
                  </li>
                ))}
              </ul>
            </>
          )}

          <div className="btn-row">
            <button className="btn btn-secondary" onClick={refresh} disabled={loading || uploading}>{t('refresh')}</button>
            <button className="btn btn-primary" onClick={() => performUpload(false)} disabled={!preflight.ready || uploading || preflight.uploadableCount === 0}>
              {uploading && <span className="spinner" />}
              {uploading ? t('uploading') : t('uploadAll')}
            </button>
            {preflight.canSkipBlocked && preflight.uploadableCount > 0 && (
              <button className="btn btn-secondary" onClick={() => performUpload(true)} disabled={uploading}>{t('skipAndUpload')}</button>
            )}
          </div>
        </>
      )}

      {progress.length > 0 && (
        <div className="status">
          {progress.map((item, index) => <div key={index}>{progressText(item, t)}</div>)}
        </div>
      )}

      {result && (
        <div className={`status ${(result.failed ?? 0) > 0 ? 'status-danger' : 'status-success'}`}>
          <div>{(result.failed ?? 0) > 0 ? t('failed') : t('success')}</div>
          <div>{t('progressCounts', {
            submitted: result.submitted ?? 0,
            uploaded: result.uploaded ?? 0,
            skipped: result.skipped ?? 0,
            failed: result.failed ?? 0,
          })}</div>
          {result.failures && result.failures.length > 0 && (
            <ul className="failure-list">
              {result.failures.map((failure, index) => (
                <li key={index}>
                  {failure.qsoCallsign ? `${failure.qsoCallsign}: ` : ''}{failure.message}
                  {failure.httpStatus ? ` (HTTP ${failure.httpStatus})` : ''}
                  {failure.retryable ? ` — ${t('retryable')}` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
