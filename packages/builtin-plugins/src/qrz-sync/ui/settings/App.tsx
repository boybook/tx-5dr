/// <reference types="@tx5dr/plugin-api/bridge" />
import { useState, useEffect, useCallback } from 'react';
import { useI18n } from '../../../_shared/ui/useI18n';
import { useAutoResize } from '../../../_shared/ui/useAutoResize';
import './App.css';

// ===== i18n =====
const I18N: Record<string, Record<string, string>> = {
  zh: {
    connectionTitle: 'QRZ.com 连接设置',
    apiKeyLabel: 'API 密钥',
    apiKeyPlaceholder: '输入 QRZ.com API 密钥',
    testBtn: '测试连接',
    testing: '测试中...',
    syncTitle: '同步设置',
    autoUpload: 'QSO 完成后自动上传',
    autoUploadDesc: '通联完成时自动将 QSO 记录上传到 QRZ.com',
    saveBtn: '保存',
    saving: '保存中...',
    saved: '已保存',
    saveFailed: '保存失败',
    connected: '连接成功',
    connectionFailed: '连接失败',
    lastSync: '上次同步',
    logbookInfo: '呼号: {callsign}, 日志数: {count}',
  },
  en: {
    connectionTitle: 'QRZ.com Connection',
    apiKeyLabel: 'API Key',
    apiKeyPlaceholder: 'Enter QRZ.com API key',
    testBtn: 'Test Connection',
    testing: 'Testing...',
    syncTitle: 'Sync Options',
    autoUpload: 'Auto-upload after QSO',
    autoUploadDesc: 'Automatically upload QSO records to QRZ.com when a contact is completed',
    saveBtn: 'Save',
    saving: 'Saving...',
    saved: 'Saved',
    saveFailed: 'Save failed',
    connected: 'Connected',
    connectionFailed: 'Connection failed',
    lastSync: 'Last sync',
    logbookInfo: 'Callsign: {callsign}, Logs: {count}',
  },
};


interface TestResult {
  message: string;
  type: 'success' | 'error';
}

interface SaveResult {
  message: string;
  type: 'success' | 'error';
}

export function App() {
  const t = useI18n(I18N);
  const callsign = window.tx5dr.params.callsign || '';

  const [apiKey, setApiKey] = useState('');
  const [autoUploadQSO, setAutoUploadQSO] = useState(true);
  const [lastSyncTime, setLastSyncTime] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [saveResult, setSaveResult] = useState<SaveResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  // Load config on mount
  useEffect(() => {
    window.tx5dr.invoke('getConfig', { callsign }).then((config: any) => {
      if (!config) return;
      setApiKey(config.apiKey || '');
      setAutoUploadQSO(!!config.autoUploadQSO);
      if (config.lastSyncTime) {
        setLastSyncTime(new Date(config.lastSyncTime).toLocaleString());
      }
    }).catch(() => {});
  }, [callsign]);

  useAutoResize();

  // Test connection
  const handleTest = useCallback(async () => {
    const key = apiKey.trim();
    if (!key) return;

    setTesting(true);
    setTestResult(null);

    try {
      const result: any = await window.tx5dr.invoke('testConnection', { callsign, apiKey: key });
      if (result.success) {
        const info = t('logbookInfo', {
          callsign: result.callsign || '?',
          count: result.logbookCount != null ? result.logbookCount : '?',
        });
        setTestResult({ message: `${t('connected')} - ${info}`, type: 'success' });
      } else {
        setTestResult({ message: result.message || t('connectionFailed'), type: 'error' });
      }
    } catch (err: any) {
      setTestResult({ message: err.message || t('connectionFailed'), type: 'error' });
    } finally {
      setTesting(false);
    }
  }, [apiKey, callsign, t]);

  // Save config
  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveResult(null);

    try {
      await window.tx5dr.invoke('saveConfig', {
        callsign,
        config: { apiKey: apiKey.trim(), autoUploadQSO },
      });
      setSaveResult({ message: t('saved'), type: 'success' });
      setTimeout(() => setSaveResult(null), 2000);
    } catch (err: any) {
      setSaveResult({ message: `${t('saveFailed')}: ${err.message || ''}`, type: 'error' });
    } finally {
      setSaving(false);
    }
  }, [apiKey, autoUploadQSO, callsign, t]);

  return (
    <div className="container">
      <div className="section-title">{t('connectionTitle')}</div>
      <div className="form-group">
        <label htmlFor="apiKey">{t('apiKeyLabel')}</label>
        <input
          type="password"
          id="apiKey"
          placeholder={t('apiKeyPlaceholder')}
          value={apiKey}
          onChange={e => setApiKey(e.target.value)}
        />
      </div>
      <div className="btn-row">
        <button
          className="btn btn-secondary"
          disabled={testing || !apiKey.trim()}
          onClick={handleTest}
        >
          {testing && <span className="spinner" />}
          <span className="btn-text">{testing ? t('testing') : t('testBtn')}</span>
        </button>
        {testResult && (
          <span className={`chip ${testResult.type === 'success' ? 'chip-success' : 'chip-danger'}`}>
            {testResult.message}
          </span>
        )}
      </div>

      <hr className="section-divider" />

      <div className="section-title">{t('syncTitle')}</div>
      <div className="toggle-row">
        <div>
          <div className="toggle-label">{t('autoUpload')}</div>
          <div className="toggle-desc">{t('autoUploadDesc')}</div>
        </div>
        <label className="switch">
          <input
            type="checkbox"
            checked={autoUploadQSO}
            onChange={e => setAutoUploadQSO(e.target.checked)}
          />
          <span className="slider" />
        </label>
      </div>

      <hr className="section-divider" />

      <div className="btn-row">
        <button
          className="btn btn-primary"
          disabled={saving}
          onClick={handleSave}
        >
          <span className="btn-text">{saving ? t('saving') : t('saveBtn')}</span>
        </button>
        {saveResult && (
          <span className={`chip ${saveResult.type === 'success' ? 'chip-success' : 'chip-danger'}`}>
            {saveResult.message}
          </span>
        )}
      </div>

      {lastSyncTime && (
        <div className="status-row">
          {t('lastSync')}: {lastSyncTime}
        </div>
      )}
    </div>
  );
}
