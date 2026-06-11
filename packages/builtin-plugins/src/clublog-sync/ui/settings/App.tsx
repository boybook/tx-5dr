/// <reference types="@tx5dr/plugin-api/bridge" />
import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '../../../_shared/ui/useI18n';
import { useAutoResize } from '../../../_shared/ui/useAutoResize';
import './App.css';

interface ClubLogConfig {
  email: string;
  password: string;
  autoUploadQSO: boolean;
  lastRealtimeUploadTime?: number;
  lastBatchUploadTime?: number;
}

const I18N: Record<string, Record<string, string>> = {
  zh: {
    connectionTitle: 'Club Log 连接设置',
    emailLabel: 'Club Log 邮箱',
    emailPlaceholder: 'your@example.com',
    passwordLabel: 'Application Password',
    passwordPlaceholder: '输入 Club Log Application Password',
    passwordHint: '建议在 Club Log 中创建专用 Application Password，不要使用主密码。',
    apiKeyLabel: '内置 API Key',
    apiKeyReady: '可用',
    apiKeyMissing: '当前构建未包含 API Key',
    testBtn: '测试连接',
    testing: '测试中...',
    connected: 'Club Log 服务可访问；账号和密码会在首次上传时验证。',
    connectionFailed: '连接失败',
    syncTitle: '同步设置',
    autoUpload: 'QSO 完成后自动上传',
    autoUploadDesc: '通联完成时自动将新 QSO 实时上传到 Club Log',
    lastRealtime: '上次实时上传',
    lastBatch: '上次批量提交',
    never: '从未',
    saveBtn: '保存',
    saving: '保存中...',
    saved: '已保存',
    saveFailed: '保存失败',
    missingRequired: '请填写邮箱和 Application Password，并确保当前构建包含 Club Log API Key',
  },
  ja: {
    connectionTitle: 'Club Log 接続設定',
    emailLabel: 'Club Log メール',
    emailPlaceholder: 'your@example.com',
    passwordLabel: 'Application Password',
    passwordPlaceholder: 'Club Log Application Password を入力してください',
    passwordHint: 'Club Log で専用の Application Password を作成することを推奨します。',
    apiKeyLabel: '組み込み API Key',
    apiKeyReady: '利用可能',
    apiKeyMissing: 'このビルドには API Key が含まれていません',
    testBtn: '接続テスト',
    testing: 'テスト中...',
    connected: 'Club Log サービスに接続できます。アカウントとパスワードは初回アップロード時に検証されます。',
    connectionFailed: '接続失敗',
    syncTitle: '同期設定',
    autoUpload: 'QSO 完了後に自動アップロード',
    autoUploadDesc: '交信完了時に新しい QSO を Club Log にリアルタイムアップロードします',
    lastRealtime: '前回リアルタイムアップロード',
    lastBatch: '前回一括送信',
    never: 'なし',
    saveBtn: '保存',
    saving: '保存中...',
    saved: '保存しました',
    saveFailed: '保存失敗',
    missingRequired: 'メール、Application Password を入力し、このビルドに Club Log API Key が含まれていることを確認してください',
  },
  en: {
    connectionTitle: 'Club Log Connection',
    emailLabel: 'Club Log Email',
    emailPlaceholder: 'your@example.com',
    passwordLabel: 'Application Password',
    passwordPlaceholder: 'Enter Club Log application password',
    passwordHint: 'Use a dedicated Club Log application password instead of your main password.',
    apiKeyLabel: 'Built-in API Key',
    apiKeyReady: 'Available',
    apiKeyMissing: 'Missing from this build',
    testBtn: 'Test Connection',
    testing: 'Testing...',
    connected: 'Club Log endpoint is reachable. Your credentials will be verified on first upload.',
    connectionFailed: 'Connection failed',
    syncTitle: 'Sync Options',
    autoUpload: 'Auto-upload after QSO',
    autoUploadDesc: 'Upload new QSO records to Club Log as contacts are completed',
    lastRealtime: 'Last realtime upload',
    lastBatch: 'Last batch submit',
    never: 'Never',
    saveBtn: 'Save',
    saving: 'Saving...',
    saved: 'Saved',
    saveFailed: 'Save failed',
    missingRequired: 'Fill in email and application password, and make sure this build includes a Club Log API key',
  },
};

function formatTime(value?: number, never = 'Never'): string {
  return value ? new Date(value).toLocaleString() : never;
}

export function App() {
  const t = useI18n(I18N);
  const callsign = window.tx5dr.params.callsign ?? '';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [autoUpload, setAutoUpload] = useState(false);
  const [apiKeyAvailable, setApiKeyAvailable] = useState(false);
  const [lastRealtimeUploadTime, setLastRealtimeUploadTime] = useState<number | undefined>();
  const [lastBatchUploadTime, setLastBatchUploadTime] = useState<number | undefined>();
  const [testing, setTesting] = useState(false);
  const [testStatus, setTestStatus] = useState<{ type: 'success' | 'danger'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<{ type: 'success' | 'danger'; text: string } | null>(null);

  useAutoResize();

  useEffect(() => {
    window.tx5dr.invoke('getConfig', { callsign }).then((result: any) => {
      const config = result?.config as ClubLogConfig | null;
      setApiKeyAvailable(!!result?.apiKeyStatus?.available);
      if (!config) return;
      setEmail(config.email || '');
      setPassword(config.password || '');
      setAutoUpload(!!config.autoUploadQSO);
      setLastRealtimeUploadTime(config.lastRealtimeUploadTime);
      setLastBatchUploadTime(config.lastBatchUploadTime);
    }).catch(() => {});
  }, [callsign]);

  const handleTest = useCallback(() => {
    setTesting(true);
    setTestStatus(null);
    window.tx5dr.invoke('testConnectionDraft', {
      callsign,
      config: { email: email.trim(), password, autoUploadQSO: autoUpload },
    }).then((result: any) => {
      setTesting(false);
      setApiKeyAvailable(!!result?.details?.apiKeyAvailable);
      setTestStatus({
        type: result.success ? 'success' : 'danger',
        text: result.success ? t('connected') : (result.message || t('connectionFailed')),
      });
    }).catch((err: any) => {
      setTesting(false);
      setTestStatus({ type: 'danger', text: err.message || t('connectionFailed') });
    });
  }, [callsign, email, password, autoUpload, t]);

  const handleSave = useCallback(() => {
    if (!email.trim() || !password || !apiKeyAvailable) {
      setSaveStatus({ type: 'danger', text: t('missingRequired') });
      return;
    }
    setSaving(true);
    setSaveStatus(null);
    window.tx5dr.invoke('saveConfig', {
      callsign,
      config: { email: email.trim(), password, autoUploadQSO: autoUpload },
    }).then((result: any) => {
      setSaving(false);
      setApiKeyAvailable(!!result?.apiKeyStatus?.available);
      setSaveStatus({ type: 'success', text: t('saved') });
      setTimeout(() => {
        setSaveStatus(null);
        window.tx5dr.requestClose();
      }, 600);
    }).catch((err: any) => {
      setSaving(false);
      setSaveStatus({ type: 'danger', text: `${t('saveFailed')}: ${err.message || ''}` });
    });
  }, [callsign, email, password, autoUpload, apiKeyAvailable, t]);

  return (
    <div className="container">
      <div className="section-title">{t('connectionTitle')}</div>

      <div className="form-group">
        <label>{t('emailLabel')}</label>
        <input
          type="email"
          placeholder={t('emailPlaceholder')}
          value={email}
          onChange={e => setEmail(e.target.value)}
        />
      </div>

      <div className="form-group">
        <label>{t('passwordLabel')}</label>
        <input
          type="password"
          placeholder={t('passwordPlaceholder')}
          value={password}
          onChange={e => setPassword(e.target.value)}
        />
        <div className="hint">{t('passwordHint')}</div>
      </div>

      <div className="status-row">
        <span>{t('apiKeyLabel')}</span>
        <span className={`chip ${apiKeyAvailable ? 'chip-success' : 'chip-danger'}`}>
          {apiKeyAvailable ? t('apiKeyReady') : t('apiKeyMissing')}
        </span>
      </div>

      <div className="btn-row">
        <button className="btn btn-secondary" onClick={handleTest} disabled={testing || !email.trim() || !password}>
          {testing && <span className="spinner" />}
          {testing ? t('testing') : t('testBtn')}
        </button>
        {testStatus && <span className={`chip chip-${testStatus.type}`}>{testStatus.text}</span>}
      </div>

      <hr className="section-divider" />
      <div className="section-title">{t('syncTitle')}</div>

      <div className="toggle-row">
        <div>
          <div className="toggle-label">{t('autoUpload')}</div>
          <div className="toggle-desc">{t('autoUploadDesc')}</div>
        </div>
        <label className="switch">
          <input type="checkbox" checked={autoUpload} onChange={e => setAutoUpload(e.target.checked)} />
          <span className="slider" />
        </label>
      </div>

      <div className="status-row"><span>{t('lastRealtime')}:</span><span>{formatTime(lastRealtimeUploadTime, t('never'))}</span></div>
      <div className="status-row"><span>{t('lastBatch')}:</span><span>{formatTime(lastBatchUploadTime, t('never'))}</span></div>

      <div className="btn-row">
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving && <span className="spinner" />}
          {saving ? t('saving') : t('saveBtn')}
        </button>
        {saveStatus && <span className={`chip chip-${saveStatus.type}`}>{saveStatus.text}</span>}
      </div>
    </div>
  );
}
