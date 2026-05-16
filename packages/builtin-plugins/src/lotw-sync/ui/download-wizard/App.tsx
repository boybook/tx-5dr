/// <reference types="@tx5dr/plugin-api/bridge" />
import { useState, useEffect, useRef, useCallback } from 'react';
import { useI18n } from '../../../_shared/ui/useI18n';
import { useAutoResize } from '../../../_shared/ui/useAutoResize';
import './App.css';

// ===== i18n =====
const I18N: Record<string, Record<string, string>> = {
  zh: {
    description: '选择从 LoTW 下载确认记录的起始日期。',
    sinceDateLabel: '下载确认记录，起始日期',
    untilDateLabel: '截止日期',
    invalidRange: '开始日期不能晚于截止日期',
    downloadBtn: '开始下载',
    downloading: '正在下载...',
    resultTitle: '下载结果',
    downloaded: '下载',
    matched: '匹配本地记录',
    updated: '新增导入',
    imported: '新增导入',
    windows: '请求分段',
    errors: '错误',
    retryable: '可重试',
    success: '下载完成',
    failed: '下载失败',
    progressPreparing: '正在准备下载请求...',
    progressWaiting: 'LoTW 限流保护，等待 {seconds} 秒',
    progressDownloading: '第 {current}/{total} 段：正在下载 {range}',
    progressRetrying: 'LoTW 限流或超时，等待 {seconds} 秒后重试',
    progressProcessing: '正在处理本段记录',
    progressDone: '第 {current}/{total} 段完成',
    progressFailed: '第 {current}/{total} 段失败',
    progressFinished: '下载同步完成',
    progressCounts: '已下载 {downloaded}，已匹配 {matched}，已导入 {imported}，失败 {failed}',
  },
  ja: {
    description: 'LoTWから確認記録をダウンロードする開始日を選択します。',
    sinceDateLabel: 'ダウンロード確認記録、開始日',
    untilDateLabel: '締め切り',
    invalidRange: '開始日は期日より後にすることはできません',
    downloadBtn: 'ダウンロードを開始する',
    downloading: 'ダウンロード中...',
    resultTitle: 'ダウンロード結果',
    downloaded: 'ダウンロード',
    matched: 'ローカルレコードと一致する',
    updated: '新規インポート',
    imported: '新規インポート',
    windows: 'リクエストセグメント',
    errors: 'エラー',
    retryable: '再試行可能',
    success: 'ダウンロード完了',
    failed: '操作失敗',
    progressPreparing: 'ダウンロード要求を準備しています...',
    progressWaiting: 'LoTW 電流制限保護、{seconds} 秒待ちます',
    progressDownloading: 'セクション {current}/{total}: {range} のダウンロード',
    progressRetrying: 'LoTW 電流制限またはタイムアウト。{seconds} 秒待ってから再試行してください',
    progressProcessing: 'このレコードは処理中です',
    progressDone: 'セクション {current}/{total} 完了',
    progressFailed: 'セクション {current}/{total} が失敗しました',
    progressFinished: 'ダウンロードの同期が完了しました',
    progressCounts: 'ダウンロード {downloaded}、照合 {matched}、インポート {imported}、失敗 {failed}',
  },
  en: {
    description: 'Select the date range for downloading LoTW confirmations.',
    sinceDateLabel: 'Download confirmations since',
    untilDateLabel: 'Download confirmations until',
    invalidRange: 'Start date cannot be later than end date',
    downloadBtn: 'Download',
    downloading: 'Downloading...',
    resultTitle: 'Results',
    downloaded: 'Downloaded',
    matched: 'Matched local QSOs',
    updated: 'New imports',
    imported: 'New imports',
    windows: 'Request windows',
    errors: 'Errors',
    retryable: 'Retryable',
    success: 'Download complete',
    failed: 'Download failed',
    progressPreparing: 'Preparing download requests...',
    progressWaiting: 'LoTW rate-limit guard: waiting {seconds}s',
    progressDownloading: 'Window {current}/{total}: downloading {range}',
    progressRetrying: 'LoTW limited or timed out; retrying in {seconds}s',
    progressProcessing: 'Processing this window',
    progressDone: 'Window {current}/{total} complete',
    progressFailed: 'Window {current}/{total} failed',
    progressFinished: 'Download sync complete',
    progressCounts: 'Downloaded {downloaded}, matched {matched}, imported {imported}, failed {failed}',
  },
};


// ===== Types =====
interface DownloadResult {
  downloaded?: number;
  matched?: number;
  updated?: number;
  imported?: number;
  windowCount?: number;
  failures?: Array<{
    code: string;
    message: string;
    qsoCallsign?: string;
    httpStatus?: number;
    detail?: string;
    retryable?: boolean;
  }>;
}

type DownloadProgressStage =
  | 'preparing'
  | 'window_waiting'
  | 'window_downloading'
  | 'window_retrying'
  | 'window_processing'
  | 'window_done'
  | 'window_failed'
  | 'finished';

interface DownloadProgress {
  stage: DownloadProgressStage;
  windowIndex?: number;
  windowCount?: number;
  range?: string;
  waitSeconds?: number;
  attempt?: number;
  recordCount?: number;
  downloaded?: number;
  matched?: number;
  updated?: number;
  imported?: number;
  failed?: number;
  failureCount?: number;
  message?: string;
}

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

function progressText(progress: DownloadProgress, t: (key: string, vars?: Record<string, string | number>) => string): string {
  const vars = {
    current: progress.windowIndex ?? 0,
    total: progress.windowCount ?? 0,
    range: progress.range ?? '',
    seconds: progress.waitSeconds ?? 0,
  };
  switch (progress.stage) {
    case 'preparing': return t('progressPreparing');
    case 'window_waiting': return t('progressWaiting', vars);
    case 'window_downloading': return t('progressDownloading', vars);
    case 'window_retrying': return progress.message ? `${t('progressRetrying', vars)}: ${progress.message}` : t('progressRetrying', vars);
    case 'window_processing': return t('progressProcessing');
    case 'window_done': return t('progressDone', vars);
    case 'window_failed': return progress.message ? `${t('progressFailed', vars)}: ${progress.message}` : t('progressFailed', vars);
    case 'finished': return t('progressFinished');
    default: return progress.stage;
  }
}

// ===== Component =====
export function App() {
  const t = useI18n(I18N);
  const callsign = window.tx5dr.params.callsign ?? '';

  const defaultDate = new Date();
  defaultDate.setDate(defaultDate.getDate() - 30);
  const today = new Date();

  const [sinceDate, setSinceDate] = useState(formatDate(defaultDate));
  const [untilDate, setUntilDate] = useState(formatDate(today));
  const [downloading, setDownloading] = useState(false);
  const [status, setStatus] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [result, setResult] = useState<DownloadResult | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const dateInputRef = useRef<HTMLInputElement>(null);

  useAutoResize();

  // ===== Theme-aware date input =====
  useEffect(() => {
    const applyTheme = (theme: 'dark' | 'light') => {
      if (dateInputRef.current) {
        dateInputRef.current.style.colorScheme = theme === 'light' ? 'light' : 'dark';
      }
    };
    applyTheme(window.tx5dr.theme);
    window.tx5dr.onThemeChange(applyTheme);
  }, []);

  // ===== Load last download time =====
  useEffect(() => {
    window.tx5dr.invoke('getLastDownloadTime', { callsign }).then((res: any) => {
      if (res?.lastDownloadTime) {
        setSinceDate(formatDate(new Date(res.lastDownloadTime)));
      }
    }).catch(() => {});
  }, [callsign]);

  useEffect(() => {
    const handleProgress = (next: DownloadProgress) => {
      setProgress(next);
    };
    window.tx5dr.onPush('downloadProgress', handleProgress);
    return () => {
      window.tx5dr.offPush?.('downloadProgress', handleProgress);
    };
  }, []);

  // ===== Download =====
  const handleDownload = useCallback(async () => {
    const since = new Date(sinceDate).getTime();
    const until = new Date(`${untilDate}T23:59:59.999Z`).getTime();
    if (!since || isNaN(since) || !until || isNaN(until)) return;
    if (since > until) {
      setStatus({ text: t('invalidRange'), type: 'error' });
      return;
    }

    setDownloading(true);
    setStatus(null);
    setResult(null);
    setProgress(null);

    try {
      const res = await window.tx5dr.invoke('performDownload', {
        callsign,
        since,
        until,
      }) as DownloadResult;

      if (res.failures?.length) {
        setStatus({ text: `${t('failed')}: ${res.failures.map(f => f.message || f.code).join('; ')}`, type: 'error' });
        setResult(res);
        return;
      }

      setStatus({ text: t('success'), type: 'success' });
      setResult(res);
    } catch (err: any) {
      setStatus({ text: `${t('failed')}: ${err.message || err}`, type: 'error' });
    } finally {
      setDownloading(false);
    }
  }, [sinceDate, untilDate, callsign, t]);

  return (
    <div className="container">
      <p className="description">{t('description')}</p>

      <div className="form-group">
        <label>{t('sinceDateLabel')}</label>
        <input
          ref={dateInputRef}
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

      <div className="actions">
        <button
          className="btn btn-primary"
          disabled={downloading}
          onClick={handleDownload}
        >
          <span>{downloading ? t('downloading') : t('downloadBtn')}</span>
        </button>
      {status && (
          <span className={`status ${status.type}`}>
            {status.text}
          </span>
        )}
      </div>

      {progress && (
        <div className="progress-box">
          <div className="progress-title">{progressText(progress, t)}</div>
          {progress.windowCount ? (
            <div className="progress-bar" aria-label={progressText(progress, t)}>
              <div
                className="progress-bar-fill"
                style={{
                  width: `${Math.min(100, Math.max(3, ((progress.windowIndex ?? 0) / progress.windowCount) * 100))}%`,
                }}
              />
            </div>
          ) : null}
          <div className="progress-meta">
            {t('progressCounts', {
              downloaded: progress.downloaded ?? 0,
              matched: progress.matched ?? 0,
              imported: progress.imported ?? 0,
              failed: progress.failed ?? 0,
            })}
          </div>
        </div>
      )}

      {result && (
        <div className="result-box">
          <div className="result-title">{t('resultTitle')}</div>
          <div className="result-content">
            <div className="stat">
              <span>{t('downloaded')}</span>
              <span className="stat-value">{result.downloaded ?? 0}</span>
            </div>
            <div className="stat">
              <span>{t('matched')}</span>
              <span className="stat-value">{result.matched ?? 0}</span>
            </div>
            <div className="stat">
              <span>{t('imported')}</span>
              <span className="stat-value">{result.imported ?? result.updated ?? 0}</span>
            </div>
            <div className="stat">
              <span>{t('windows')}</span>
              <span className="stat-value">{result.windowCount ?? 1}</span>
            </div>
            {result.failures && result.failures.length > 0 && (
              <>
                <div className="stat">
                  <span>{t('errors')}</span>
                  <span className="stat-value" style={{ color: 'var(--tx5dr-danger)' }}>
                    {result.failures.length}
                  </span>
                </div>
                <div className="failure-list">
                  {result.failures.map((failure, i) => (
                    <div className="failure-item" key={i}>
                      {failure.qsoCallsign ? `${failure.qsoCallsign}: ` : ''}{failure.message || failure.code}
                      {failure.httpStatus ? ` (HTTP ${failure.httpStatus})` : ''}
                      {failure.retryable ? ` - ${t('retryable')}` : ''}
                      {failure.detail && failure.detail !== failure.message ? ` - ${failure.detail}` : ''}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
