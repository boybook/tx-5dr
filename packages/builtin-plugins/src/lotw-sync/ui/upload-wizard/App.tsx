/// <reference types="@tx5dr/plugin-api/bridge" />
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../../_shared/ui/useI18n';
import { useAutoResize } from '../../../_shared/ui/useAutoResize';
import './App.css';

const I18N: Record<string, Record<string, string>> = {
  zh: {
    description: '上传前会先检查待上传 QSO 是否能匹配 LoTW 证书。遇到个别 QSO 阻碍时，可以跳过它们并继续上传其余记录。',
    rangeTitle: '上传时间范围',
    sinceDateLabel: '开始日期',
    untilDateLabel: '截止日期',
    filterSentLabel: '只上传尚未上传到 LoTW 的 QSO',
    invalidDate: '请选择有效的上传时间范围',
    invalidRange: '开始日期不能晚于截止日期',
    loading: '正在检查上传准备状态...',
    pending: '待上传',
    uploadable: '可上传',
    blocked: '被阻挡',
    readyTitle: '可以上传',
    blockedTitle: '上传被阻挡',
    issueListTitle: '需要处理或跳过的 QSO',
    uploadAll: '上传全部可上传 QSO',
    skipAndUpload: '跳过这些 QSO 并继续上传',
    refresh: '重新检查',
    uploading: '正在上传...',
    success: '上传完成',
    failed: '上传失败',
    successHint: 'LoTW 已 accepted 的 QSO 已标记为已上传。后续请运行下载同步获取 LoTW 确认。',
    submitted: '已提交到 LoTW',
    uploaded: '已标记上传',
    skipped: '已跳过',
    failedCount: '失败',
    errors: '错误',
    retryable: '可重试',
    noPending: '当前没有待上传 QSO。',
    cannotSkip: '这些阻碍不是单条 QSO 可跳过的问题，需要先修正配置或证书。',
    issue_certificate_date_range_mismatch: '该 QSO 不匹配任何已上传的 LoTW 证书',
    issue_qso_callsign_missing: '该 QSO 缺少本台呼号信息',
    issue_qso_callsign_mismatch: '该 QSO 属于其他本台呼号',
    issue_certificate_missing: '尚未上传 LoTW 证书',
    issue_upload_location_callsign_missing: 'LoTW 上传台站呼号未配置',
    issue_upload_location_dxcc_missing: 'LoTW 上传 DXCC 未配置',
    issue_upload_location_grid_missing: 'LoTW 上传网格定位未配置',
    issue_upload_location_cq_missing: 'LoTW 上传 CQ 区未配置',
    issue_upload_location_itu_missing: 'LoTW 上传 ITU 区未配置',
    issue_upload_location_state_missing: '该 DXCC 需要填写州/省/地区',
    issue_upload_location_county_missing: '该 DXCC 需要填写县/区',
    issuePrefix: '问题',
    progressPreparing: '正在准备上传记录...',
    progressPrepared: '已准备 {uploadable} 条可上传 QSO，拆分为 {batches} 个批次',
    progressUploadingBatch: '第 {current}/{total} 批：正在签名并上传',
    progressAccepted: '第 {current}/{total} 批：LoTW 已 accepted',
    progressFailed: '第 {current}/{total} 批：失败',
    progressUpdatingLocal: '正在更新本地上传状态',
    progressFinished: '上传完成，后续请运行下载同步获取 LoTW 确认',
    progressCounts: '已提交 {submitted}，已标记上传 {uploaded}，已跳过 {skipped}，失败 {failed}',
  },
  ja: {
    description: 'アップロードする前に、アップロードする QSO が LoTW 証明書と一致するかどうかがチェックされます。個々の QSO ブロッカーが発生した場合は、それらをスキップして、残りのレコードのアップロードを続行できます。',
    rangeTitle: 'アップロード時間範囲',
    sinceDateLabel: '開始日',
    untilDateLabel: '締め切り',
    filterSentLabel: 'LoTWにまだアップロードされていないQSOのみをアップロードしてください',
    invalidDate: '有効なアップロード時間範囲を選択してください',
    invalidRange: '開始日は期日より後にすることはできません',
    loading: '読み込み中...',
    pending: 'アップロード予定',
    uploadable: 'アップロード可能',
    blocked: 'ブロックされました',
    readyTitle: 'アップロード可能',
    blockedTitle: 'アップロードがブロックされました',
    issueListTitle: '処理またはスキップする必要がある QSO',
    uploadAll: 'すべてアップロード QSO をアップロードできます',
    skipAndUpload: 'これらの QSO をスキップしてアップロードを続行してください',
    refresh: '更新',
    uploading: 'アップロード中...',
    success: 'アップロード完了',
    failed: '操作失敗',
    successHint: 'LoTW で受け入れられた QSO はアップロード済みとしてマークされます。 LoTW の確認を取得するには、後でダウンロード同期を実行してください。',
    submitted: 'LoTWに提出されました',
    uploaded: 'アップロードのフラグが立てられました',
    skipped: 'スキップしました',
    failedCount: '失敗しました',
    errors: 'エラー',
    retryable: '再試行可能',
    noPending: '現在保留中の QSO はありません。',
    cannotSkip: 'これらのブロッカーは 1 つの QSO でスキップできる問題ではないため、最初に構成または証明書の修正が必要です。',
    issue_certificate_date_range_mismatch: 'この QSO はアップロードされた LoTW 証明書と一致しません',
    issue_qso_callsign_missing: 'この QSO には自局のコールサイン情報がありません',
    issue_qso_callsign_mismatch: 'このQSOは自局の別のコールサインに属します',
    issue_certificate_missing: 'LoTW証明書はまだアップロードされていません',
    issue_upload_location_callsign_missing: 'LoTW アップロード局のコールサインが設定されていません',
    issue_upload_location_dxcc_missing: 'LoTW アップロード DXCC が設定されていません',
    issue_upload_location_grid_missing: 'LoTW アップロード グリッド ポジショニングが構成されていません',
    issue_upload_location_cq_missing: 'LoTW アップロード CQ エリアが設定されていません',
    issue_upload_location_itu_missing: 'LoTW アップロード ITU エリアが構成されていません',
    issue_upload_location_state_missing: 'DXCC には州/県/地域が必要です',
    issue_upload_location_county_missing: 'DXCC では郡/地区の入力が必要です',
    issuePrefix: '質問',
    progressPreparing: 'レコードをアップロードする準備をしています...',
    progressPrepared: '{uploadable} QSO が準備されており、{batches} バッチに分割してアップロードできます',
    progressUploadingBatch: 'バッチ {current}/{total}: 署名とアップロード',
    progressAccepted: 'バッチ {current}/{total}: LoTW が受け入れられました',
    progressFailed: 'バッチ {current}/{total}: 失敗しました',
    progressUpdatingLocal: 'ローカルアップロードステータスを更新しています',
    progressFinished: 'アップロードが完了しました。 LoTW の確認を取得するには、後でダウンロード同期を実行してください。',
    progressCounts: '送信 {submitted}、アップロード済み {uploaded}、スキップ {skipped}、失敗 {failed}',
  },
  en: {
    description: 'Before uploading, TX-5DR checks whether pending QSOs match an uploaded LoTW certificate. If only individual QSOs are blocked, you can skip them and upload the rest.',
    rangeTitle: 'Upload date range',
    sinceDateLabel: 'Start date',
    untilDateLabel: 'End date',
    filterSentLabel: 'Only upload QSOs not yet uploaded to LoTW',
    invalidDate: 'Select a valid upload date range',
    invalidRange: 'Start date cannot be later than end date',
    loading: 'Checking upload readiness...',
    pending: 'Pending',
    uploadable: 'Uploadable',
    blocked: 'Blocked',
    readyTitle: 'Ready to upload',
    blockedTitle: 'Upload is blocked',
    issueListTitle: 'QSOs to fix or skip',
    uploadAll: 'Upload all uploadable QSOs',
    skipAndUpload: 'Skip these QSOs and continue',
    refresh: 'Check again',
    uploading: 'Uploading...',
    success: 'Upload complete',
    failed: 'Upload failed',
    successHint: 'LoTW accepted QSOs have been marked as uploaded. Run download sync later to fetch LoTW confirmations.',
    submitted: 'Submitted to LoTW',
    uploaded: 'Marked uploaded',
    skipped: 'Skipped',
    failedCount: 'Failed',
    errors: 'Errors',
    retryable: 'Retryable',
    noPending: 'There are no pending QSOs to upload.',
    cannotSkip: 'These blockers are not per-QSO issues. Fix the configuration or certificate first.',
    issue_certificate_date_range_mismatch: 'This QSO does not match any uploaded LoTW certificate',
    issue_qso_callsign_missing: 'This QSO is missing station callsign information',
    issue_qso_callsign_mismatch: 'This QSO belongs to a different station callsign',
    issue_certificate_missing: 'No LoTW certificate has been uploaded yet',
    issue_upload_location_callsign_missing: 'LoTW upload callsign is not configured',
    issue_upload_location_dxcc_missing: 'LoTW upload DXCC is not configured',
    issue_upload_location_grid_missing: 'LoTW upload grid square is not configured',
    issue_upload_location_cq_missing: 'LoTW upload CQ zone is not configured',
    issue_upload_location_itu_missing: 'LoTW upload ITU zone is not configured',
    issue_upload_location_state_missing: 'State/province is required for this DXCC',
    issue_upload_location_county_missing: 'County is required for this DXCC',
    issuePrefix: 'Issue',
    progressPreparing: 'Preparing upload records...',
    progressPrepared: 'Prepared {uploadable} uploadable QSOs in {batches} batches',
    progressUploadingBatch: 'Batch {current}/{total}: signing and uploading',
    progressAccepted: 'Batch {current}/{total}: LoTW accepted',
    progressFailed: 'Batch {current}/{total}: failed',
    progressUpdatingLocal: 'Updating local upload status',
    progressFinished: 'Upload complete. Run download sync later to fetch LoTW confirmations.',
    progressCounts: 'Submitted {submitted}, marked uploaded {uploaded}, skipped {skipped}, failed {failed}',
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
  canSkipBlocked?: boolean;
  issues?: PreflightIssue[];
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
  verified?: number;
  uploaded?: number;
  skipped?: number;
  failed?: number;
  failures?: UploadFailure[];
}

type UploadProgressStage =
  | 'preparing'
  | 'prepared'
  | 'batch_uploading'
  | 'batch_accepted'
  | 'batch_failed'
  | 'updating_local'
  | 'finished';

interface UploadProgress {
  stage: UploadProgressStage;
  callsign?: string;
  batchIndex?: number;
  batchCount?: number;
  qsoCount?: number;
  pendingCount?: number;
  uploadableCount?: number;
  blockedCount?: number;
  submitted?: number;
  uploaded?: number;
  verified?: number;
  skipped?: number;
  failed?: number;
  failureCount?: number;
  message?: string;
}

function issueTitle(issue: PreflightIssue, t: (key: string) => string): string {
  const qso = [issue.qsoCallsign, issue.qsoId ? `#${issue.qsoId}` : ''].filter(Boolean).join(' ');
  const localized = t(`issue_${issue.code}`);
  const text = localized === `issue_${issue.code}` ? issue.message : localized;
  return qso ? `${qso}: ${text}` : text;
}

function progressText(progress: UploadProgress, t: (key: string, vars?: Record<string, string | number>) => string): string {
  const vars = {
    current: progress.batchIndex ?? 0,
    total: progress.batchCount ?? 0,
    uploadable: progress.uploadableCount ?? 0,
    batches: progress.batchCount ?? 0,
    submitted: progress.submitted ?? 0,
    uploaded: progress.uploaded ?? 0,
    skipped: progress.skipped ?? 0,
    failed: progress.failed ?? 0,
  };
  switch (progress.stage) {
    case 'preparing': return t('progressPreparing');
    case 'prepared': return t('progressPrepared', vars);
    case 'batch_uploading': return t('progressUploadingBatch', vars);
    case 'batch_accepted': return t('progressAccepted', vars);
    case 'batch_failed': return progress.message ? `${t('progressFailed', vars)}: ${progress.message}` : t('progressFailed', vars);
    case 'updating_local': return t('progressUpdatingLocal');
    case 'finished': return t('progressFinished');
    default: return progress.stage;
  }
}

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

export function App() {
  const t = useI18n(I18N);
  const callsign = window.tx5dr.params.callsign ?? '';
  const [sinceDate, setSinceDate] = useState(() => {
    const start = new Date();
    start.setDate(start.getDate() - 30);
    return formatDate(start);
  });
  const [untilDate, setUntilDate] = useState(() => formatDate(new Date()));
  const [filterAlreadyUploaded, setFilterAlreadyUploaded] = useState(true);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [status, setStatus] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  useAutoResize();

  const blockingIssues = useMemo(() => (
    preflight?.issues?.filter((issue) => issue.severity === 'error') ?? []
  ), [preflight]);

  const buildUploadRange = useCallback((): { since?: number; until?: number; error?: string } => {
    const since = sinceDate ? Date.parse(`${sinceDate}T00:00:00.000Z`) : undefined;
    const until = untilDate ? Date.parse(`${untilDate}T23:59:59.999Z`) : undefined;
    if ((sinceDate && !Number.isFinite(since)) || (untilDate && !Number.isFinite(until))) {
      return { error: t('invalidDate') };
    }
    if (typeof since === 'number' && typeof until === 'number' && since > until) {
      return { error: t('invalidRange') };
    }
    return { since, until };
  }, [sinceDate, untilDate, t]);

  const loadPreflight = useCallback(async (options?: { preserveResult?: boolean }) => {
    if (!options?.preserveResult) {
      setLoading(true);
    }
    if (!options?.preserveResult) {
      setStatus(null);
      setResult(null);
    }
    const range = buildUploadRange();
    if (range.error) {
      setPreflight(null);
      setStatus({ text: range.error, type: 'error' });
      setLoading(false);
      return;
    }
    try {
      const next = await window.tx5dr.invoke('getUploadPreflight', {
        callsign,
        since: range.since,
        until: range.until,
        includeAlreadyUploaded: !filterAlreadyUploaded,
      }) as PreflightResult;
      setPreflight(next);
    } catch (err: any) {
      setStatus({ text: `${t('failed')}: ${err.message || err}`, type: 'error' });
    } finally {
      if (!options?.preserveResult) {
        setLoading(false);
      }
    }
  }, [buildUploadRange, callsign, filterAlreadyUploaded, t]);

  useEffect(() => {
    void loadPreflight();
  }, [loadPreflight]);

  useEffect(() => {
    const handleProgress = (next: UploadProgress) => {
      setProgress(next);
    };
    window.tx5dr.onPush('uploadProgress', handleProgress);
    return () => {
      window.tx5dr.offPush?.('uploadProgress', handleProgress);
    };
  }, []);

  const performUpload = useCallback(async (skipBlockedQsos: boolean) => {
    setUploading(true);
    setStatus(null);
    setResult(null);
    setProgress(null);
    const range = buildUploadRange();
    if (range.error) {
      setStatus({ text: range.error, type: 'error' });
      setUploading(false);
      return;
    }
    try {
      const res = await window.tx5dr.invoke('performUpload', {
        callsign,
        skipBlockedQsos,
        since: range.since,
        until: range.until,
        includeAlreadyUploaded: !filterAlreadyUploaded,
      }) as UploadResult;
      setResult(res);
      if (res.failures?.length || (res.failed ?? 0) > 0) {
        setStatus({ text: t('failed'), type: 'error' });
      } else {
        setStatus({ text: t('success'), type: 'success' });
      }
      await loadPreflight({ preserveResult: true });
    } catch (err: any) {
      setStatus({ text: `${t('failed')}: ${err.message || err}`, type: 'error' });
    } finally {
      setUploading(false);
    }
  }, [buildUploadRange, callsign, filterAlreadyUploaded, loadPreflight, t]);

  return (
    <div className="container">
      <p className="description">{t('description')}</p>

      <div className="range-box">
        <div className="result-title">{t('rangeTitle')}</div>
        <div className="range-grid">
          <div className="form-group">
            <label>{t('sinceDateLabel')}</label>
            <input
              type="date"
              value={sinceDate}
              onChange={e => setSinceDate(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label>{t('untilDateLabel')}</label>
            <input
              type="date"
              value={untilDate}
              onChange={e => setUntilDate(e.target.value)}
            />
          </div>
        </div>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={filterAlreadyUploaded}
            onChange={e => setFilterAlreadyUploaded(e.target.checked)}
          />
          <span>{t('filterSentLabel')}</span>
        </label>
      </div>

      {status && <div className={`status status-block ${status.type}`}>{status.text}</div>}

      {loading && <div className="empty">{t('loading')}</div>}

      {!loading && preflight && (
        <>
          <div className="summary-grid">
            <div className="summary-card"><span className="summary-label">{t('pending')}</span><span className="summary-value">{preflight.pendingCount}</span></div>
            <div className="summary-card"><span className="summary-label">{t('uploadable')}</span><span className="summary-value">{preflight.uploadableCount}</span></div>
            <div className="summary-card"><span className="summary-label">{t('blocked')}</span><span className="summary-value">{preflight.blockedCount}</span></div>
          </div>

          {preflight.pendingCount === 0 && <div className="empty">{t('noPending')}</div>}

          {progress && (
            <div className="progress-box">
              <div className="progress-title">{progressText(progress, t)}</div>
              {progress.batchCount ? (
                <div className="progress-bar" aria-label={progressText(progress, t)}>
                  <div
                    className="progress-bar-fill"
                    style={{
                      width: `${Math.min(100, Math.max(3, ((progress.batchIndex ?? 0) / progress.batchCount) * 100))}%`,
                    }}
                  />
                </div>
              ) : null}
              <div className="progress-meta">
                {t('progressCounts', {
                  submitted: progress.submitted ?? 0,
                  uploaded: progress.uploaded ?? 0,
                  skipped: progress.skipped ?? 0,
                  failed: progress.failed ?? 0,
                })}
              </div>
            </div>
          )}

          {blockingIssues.length > 0 && (
            <div className="result-box">
              <div className="result-title">{preflight.canSkipBlocked ? t('issueListTitle') : t('blockedTitle')}</div>
              {!preflight.canSkipBlocked && <p className="description">{t('cannotSkip')}</p>}
              <div className="issue-list">
                {blockingIssues.map((issue, index) => (
                  <div className="issue-item" key={`${issue.code}:${issue.qsoId ?? index}:${issue.message}`}>
                    <div className="issue-head">
                      <span>{issueTitle(issue, t)}</span>
                      <span className="issue-code">{issue.code}</span>
                    </div>
                    {issue.detail && issue.detail !== issue.message && (
                      <div className="issue-detail">{issue.detail}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {result && (
            <div className="result-box">
              <div className="result-title">
                {status?.type === 'success'
                  ? t('success')
                  : t('failed')}
              </div>
              {status?.type === 'success' && (
                <p className="result-hint">{t('successHint')}</p>
              )}
              <div className="stat"><span>{t('submitted')}</span><span className="stat-value">{result.submitted ?? 0}</span></div>
              <div className="stat"><span>{t('uploaded')}</span><span className="stat-value">{result.uploaded ?? 0}</span></div>
              <div className="stat"><span>{t('skipped')}</span><span className="stat-value">{result.skipped ?? 0}</span></div>
              <div className="stat"><span>{t('failedCount')}</span><span className="stat-value">{result.failed ?? 0}</span></div>
              {result.failures?.length ? (
                <div className="failure-list">
                  {result.failures.map((failure, index) => (
                    <div className="issue-detail" key={`${failure.code}:${failure.qsoId ?? index}`}>
                      {failure.qsoCallsign ? `${failure.qsoCallsign}: ` : ''}{failure.message || failure.code}
                      {failure.httpStatus ? ` (HTTP ${failure.httpStatus})` : ''}
                      {failure.retryable ? ` - ${t('retryable')}` : ''}
                      {failure.detail && failure.detail !== failure.message ? ` - ${failure.detail}` : ''}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          )}

          <div className="actions">
            <button className="btn btn-secondary" disabled={loading || uploading} onClick={loadPreflight}>{t('refresh')}</button>
            {preflight.ready && preflight.uploadableCount > 0 && (
              <button className="btn btn-primary" disabled={uploading} onClick={() => performUpload(false)}>
                {uploading ? t('uploading') : t('uploadAll')}
              </button>
            )}
            {!preflight.ready && preflight.canSkipBlocked && preflight.uploadableCount > 0 && (
              <button className="btn btn-primary" disabled={uploading} onClick={() => performUpload(true)}>
                {uploading ? t('uploading') : t('skipAndUpload')}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
