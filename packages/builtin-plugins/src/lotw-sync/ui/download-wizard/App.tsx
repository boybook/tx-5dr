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
    downloadBtn: '开始下载',
    downloading: '正在下载...',
    resultTitle: '下载结果',
    downloaded: '下载',
    matched: '匹配本地记录',
    updated: '新增导入',
    errors: '错误',
    success: '下载完成',
    failed: '下载失败',
  },
  en: {
    description: 'Select the date range for downloading LoTW confirmations.',
    sinceDateLabel: 'Download confirmations since',
    downloadBtn: 'Download',
    downloading: 'Downloading...',
    resultTitle: 'Results',
    downloaded: 'Downloaded',
    matched: 'Matched local QSOs',
    updated: 'New imports',
    errors: 'Errors',
    success: 'Download complete',
    failed: 'Download failed',
  },
};


// ===== Types =====
interface DownloadResult {
  downloaded?: number;
  matched?: number;
  updated?: number;
  errors?: string[];
  error?: string;
}

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

// ===== Component =====
export function App() {
  const t = useI18n(I18N);
  const callsign = window.tx5dr.params.callsign ?? '';

  const defaultDate = new Date();
  defaultDate.setDate(defaultDate.getDate() - 30);

  const [sinceDate, setSinceDate] = useState(formatDate(defaultDate));
  const [downloading, setDownloading] = useState(false);
  const [status, setStatus] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [result, setResult] = useState<DownloadResult | null>(null);
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

  // ===== Download =====
  const handleDownload = useCallback(async () => {
    const since = new Date(sinceDate).getTime();
    if (!since || isNaN(since)) return;

    setDownloading(true);
    setStatus(null);
    setResult(null);

    try {
      const res = await window.tx5dr.invoke('performDownload', {
        callsign,
        since,
      }) as DownloadResult;

      if (res.error) {
        setStatus({ text: `${t('failed')}: ${res.error}`, type: 'error' });
        return;
      }

      setStatus({ text: t('success'), type: 'success' });
      setResult(res);
    } catch (err: any) {
      setStatus({ text: `${t('failed')}: ${err.message || err}`, type: 'error' });
    } finally {
      setDownloading(false);
    }
  }, [sinceDate, callsign, t]);

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
              <span>{t('updated')}</span>
              <span className="stat-value">{result.updated ?? 0}</span>
            </div>
            {result.errors && result.errors.length > 0 && (
              <>
                <div className="stat">
                  <span>{t('errors')}</span>
                  <span className="stat-value" style={{ color: 'var(--tx5dr-danger)' }}>
                    {result.errors.length}
                  </span>
                </div>
                {result.errors.map((errMsg, i) => (
                  <div
                    key={i}
                    style={{
                      color: 'var(--tx5dr-danger)',
                      fontSize: 'var(--tx5dr-font-size-sm)',
                      marginTop: '4px',
                    }}
                  >
                    {errMsg}
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
