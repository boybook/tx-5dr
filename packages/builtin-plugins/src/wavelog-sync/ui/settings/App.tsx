/// <reference types="@tx5dr/plugin-api/bridge" />
import { useState, useEffect, useCallback } from 'react';
import { useI18n } from '../../../_shared/ui/useI18n';
import { useAutoResize } from '../../../_shared/ui/useAutoResize';
import { resolveSelectedStationId } from './stationSelection';
import { App as SyncApp } from '../sync/App';
import './App.css';

interface Station {
  station_id: string;
  station_profile_name: string;
  station_callsign: string;
  station_gridsquare?: string;
}

/** Launch correlation IDs are not credentials; keep working on plain http origins. */
function createLaunchId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `sync-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const I18N: Record<string, Record<string, string>> = {
  zh: {
    connectionTitle: 'WaveLog 连接设置',
    urlLabel: '服务器 URL',
    urlPlaceholder: 'https://your-wavelog.example.com',
    apiKeyLabel: 'API 密钥',
    apiKeyPlaceholder: '输入 WaveLog API 密钥',
    savedKey: '已保存密钥；留空保留原值',
    protocol: 'API 版本',
    testBtn: '测试连接',
    testing: '测试中...',
    stationLabel: '电台配置',
    stationPlaceholder: '请先测试连接',
    radioNameLabel: '电台名称',
    syncTitle: '同步设置',
    autoUpload: 'QSO 完成后自动上传',
    autoUploadDesc: '通联完成时自动将 QSO 记录上传到 WaveLog',
    saveBtn: '保存',
    saving: '保存中...',
    saved: '已保存',
    saveFailed: '保存失败',
    missingRequired: '请先填写 URL、API 密钥，并通过"测试连接"选择电台配置',
    connected: '连接成功',
    connectionFailed: '连接失败',
    lastSync: '上次同步',
    advanced: '高级操作', reconcile: '重新对账',
  },
  ja: {
    connectionTitle: '接続設定',
    urlLabel: 'サーバーURL',
    urlPlaceholder: 'https://your-wavelog.example.com',
    apiKeyLabel: 'APIキー',
    apiKeyPlaceholder: 'WaveLog APIキーを入力してください',
    savedKey: '保存済みキー：空欄で保持',
    protocol: 'API バージョン',
    testBtn: '接続テスト',
    testing: 'テスト中...',
    stationLabel: '無線機設定',
    stationPlaceholder: 'まず接続をテストしてください',
    radioNameLabel: '局名',
    syncTitle: '同期設定',
    autoUpload: 'QSO完了後に自動アップロード',
    autoUploadDesc: '交信が完了すると、QSO記録が WaveLog に自動的にアップロードされます',
    saveBtn: '保存',
    saving: '保存中...',
    saved: '保存しました',
    saveFailed: '保存失敗',
    missingRequired: 'まず URL と APIキーを入力し、「接続のテスト」で無線設定を選択してください。',
    connected: '接続成功',
    connectionFailed: '接続失敗',
    lastSync: '前回同期',
    advanced: '詳細操作', reconcile: '再照合',
  },
  en: {
    connectionTitle: 'WaveLog Connection',
    urlLabel: 'Server URL',
    urlPlaceholder: 'https://your-wavelog.example.com',
    apiKeyLabel: 'API Key',
    apiKeyPlaceholder: 'Enter WaveLog API key',
    savedKey: 'Saved credential; leave blank to keep',
    protocol: 'API version',
    testBtn: 'Test Connection',
    testing: 'Testing...',
    stationLabel: 'Station Profile',
    stationPlaceholder: 'Test connection first',
    radioNameLabel: 'Radio Name',
    syncTitle: 'Sync Options',
    autoUpload: 'Auto-upload after QSO',
    autoUploadDesc: 'Automatically upload QSO records to WaveLog when a contact is completed',
    saveBtn: 'Save',
    saving: 'Saving...',
    saved: 'Saved',
    saveFailed: 'Save failed',
    missingRequired: 'Please fill in URL, API key, and select a station via "Test Connection"',
    connected: 'Connected',
    connectionFailed: 'Connection failed',
    lastSync: 'Last sync',
    advanced: 'Advanced', reconcile: 'Reconcile',
  },
};

export function App() {
  const t = useI18n(I18N);
  const callsign = window.tx5dr.params.callsign ?? '';

  const [reconcileEntry, setReconcileEntry] = useState<{ intent: string; operation: string; launchId: string } | null>(null);
  const [url, setUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [stations, setStations] = useState<Station[]>([]);
  const [stationId, setStationId] = useState('');
  const [hasApiKey, setHasApiKey] = useState(false);
  const [apiVersion, setApiVersion] = useState<'v1' | 'v2'>('v2');
  const [autoUpload, setAutoUpload] = useState(true);
  const [lastSyncTime, setLastSyncTime] = useState<string | null>(null);

  const [testing, setTesting] = useState(false);
  const [testStatus, setTestStatus] = useState<{ type: 'success' | 'danger'; text: string } | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<{ type: 'success' | 'danger'; text: string } | null>(null);

  useAutoResize();

  // Load config on mount
  useEffect(() => {
    const bridge = window.tx5dr;

    bridge.invoke('getSyncStatus').then((status: any) => {
      if (status?.lastSuccessAt) setLastSyncTime(new Date(status.lastSuccessAt).toLocaleString());
    }).catch(() => {});

    bridge.invoke('getConfig', { callsign }).then((config: any) => {
      if (!config) return;
      setUrl(config.url || '');
      setHasApiKey(!!config.hasApiKey);
      setApiVersion(config.apiVersion || 'v1');
      setAutoUpload(!!config.autoUploadQSO);

      // If we have url+apiKey, try to fetch stations
      if (config.url && config.hasApiKey) {
        bridge.invoke('getStations', {
          callsign,
          url: config.url,
          apiKey: '',
          apiVersion: config.apiVersion,
        }).then((result: any) => {
          if (result?.stations) {
            setStations(result.stations);
            setStationId(resolveSelectedStationId(result.stations, config.stationId));
          }
        }).catch(() => {
          // If station fetch fails but we have a saved stationId, show fallback
          if (config.stationId) {
            setStations([{
              station_id: config.stationId,
              station_profile_name: `Station #${config.stationId}`,
              station_callsign: '',
            }]);
            setStationId(config.stationId);
          }
        });
      }
    }).catch(() => {});
  }, [callsign]);

  // Test connection
  const handleTest = useCallback(() => {
    const trimmedUrl = url.trim();
    const trimmedKey = apiKey.trim();
    if (!trimmedUrl || (!trimmedKey && !hasApiKey)) return;

    setTesting(true);
    setTestStatus(null);

    window.tx5dr.invoke('testConnection', {
      callsign,
      url: trimmedUrl,
      apiKey: trimmedKey,
      apiVersion,
    }).then((result: any) => {
      setTesting(false);
      if (result.success) {
        setTestStatus({ type: 'success', text: t('connected') });
        if (result.stations) {
          setStations(result.stations);
          setStationId(resolveSelectedStationId(result.stations, stationId));
        }
      } else {
        setTestStatus({
          type: 'danger',
          text: result.message || t('connectionFailed'),
        });
      }
    }).catch((err: any) => {
      setTesting(false);
      setTestStatus({
        type: 'danger',
        text: err.message || t('connectionFailed'),
      });
    });
  }, [url, apiKey, apiVersion, hasApiKey, callsign, stationId, t]);

  // Save config
  const handleSave = useCallback(() => {
    const trimmedUrl = url.trim();
    const trimmedKey = apiKey.trim();
    const trimmedStation = stationId.trim();
    if (!trimmedUrl || (!trimmedKey && !hasApiKey) || !trimmedStation) {
      setSaveStatus({ type: 'danger', text: t('missingRequired') });
      return;
    }

    setSaving(true);
    setSaveStatus(null);

    window.tx5dr.invoke('saveConfig', {
      callsign,
      config: {
        url: trimmedUrl,
        apiKey: trimmedKey,
        stationId: trimmedStation,
        apiVersion,
        autoUploadQSO: autoUpload,
      },
    }).then(() => {
      setSaving(false);
      setSaveStatus({ type: 'success', text: t('saved') });
      // Close the host modal shortly after showing the toast so the parent
      // can refresh its "configured" state without forcing the user to click.
      setTimeout(() => {
        setSaveStatus(null);
        window.tx5dr.requestClose();
      }, 600);
    }).catch((err: any) => {
      setSaving(false);
      setSaveStatus({
        type: 'danger',
        text: `${t('saveFailed')}: ${err.message || ''}`,
      });
    });
  }, [callsign, url, apiKey, stationId, apiVersion, hasApiKey, autoUpload, t]);

  // Build station option label
  const stationLabel = (s: Station) => {
    let label = s.station_profile_name;
    if (s.station_callsign) label += ` (${s.station_callsign})`;
    if (s.station_gridsquare) label += ` [${s.station_gridsquare}]`;
    return label;
  };

  if (reconcileEntry) return <SyncApp entry={reconcileEntry} />;
  return (
    <div className="container">
      {/* Connection section */}
      <div className="tx5dr-heading">{t('connectionTitle')}</div>

      <div className="tx5dr-field">
        <label className="tx5dr-label" htmlFor="url">{t('urlLabel')}</label>
        <input
          id="url" className="tx5dr-input"
          type="url"
          placeholder={t('urlPlaceholder')}
          value={url}
          onChange={e => {
            setUrl(e.target.value);
            setStations([]);
            setStationId('');
            setTestStatus(null);
          }}
        />
      </div>

      <div className="tx5dr-field">
        <label className="tx5dr-label" htmlFor="apiKey">{t('apiKeyLabel')}</label>
        <input
          id="apiKey" className="tx5dr-input"
          type="password"
          placeholder={t(hasApiKey ? 'savedKey' : 'apiKeyPlaceholder')}
          value={apiKey}
          onChange={e => {
            setApiKey(e.target.value);
            if (e.target.value.trim()) setApiVersion(e.target.value.trim().startsWith('wl2_') ? 'v2' : 'v1');
            setStations([]);
            setStationId('');
            setTestStatus(null);
          }}
        />
      </div>

      <div className="tx5dr-actions">
        <button
          className="tx5dr-button"
          disabled={testing || !url.trim() || (!apiKey.trim() && !hasApiKey)}
          onClick={handleTest}
        >
          {testing && <span className="tx5dr-spinner" />}
          <span>{testing ? t('testing') : t('testBtn')}</span>
        </button>
        {testStatus && (
          <span className={`tx5dr-chip tx5dr-chip--${testStatus.type}`}>
            {testStatus.text}
          </span>
        )}
      </div>

      <div className="tx5dr-field" style={{ marginTop: 'var(--tx5dr-spacing-md)' }}>
        <label className="tx5dr-label" htmlFor="station">{t('stationLabel')}</label>
        <select
          id="station" className="tx5dr-input"
          value={stationId}
          onChange={e => setStationId(e.target.value)}
        >
          {stations.length === 0 ? (
            <option value="">{t('stationPlaceholder')}</option>
          ) : (
            stations.map(s => (
              <option key={s.station_id} value={s.station_id}>
                {stationLabel(s)}
              </option>
            ))
          )}
        </select>
      </div>

      <div className="tx5dr-field">
        <label className="tx5dr-label" htmlFor="protocol">{t('protocol')}</label>
        <select id="protocol" className="tx5dr-input" value={apiVersion} onChange={e => { setApiVersion(e.target.value as 'v1' | 'v2'); setStations([]); setStationId(''); }}>
          <option value="v1">v1</option>
          <option value="v2">v2</option>
        </select>
      </div>

      <hr className="tx5dr-divider" />

      {/* Sync section */}
      <div className="tx5dr-heading">{t('syncTitle')}</div>

      <div className="toggle-row">
        <div>
          <div className="toggle-label">{t('autoUpload')}</div>
          <div className="toggle-desc">{t('autoUploadDesc')}</div>
        </div>
        <input className="tx5dr-switch" type="checkbox" aria-label={t('autoUpload')} checked={autoUpload} onChange={e => setAutoUpload(e.target.checked)} />
      </div>

      <hr className="tx5dr-divider" />

      {/* Save */}
      <div className="tx5dr-actions">
        <button
          className="tx5dr-button tx5dr-button--primary"
          disabled={saving}
          onClick={handleSave}
        >
          <span>{saving ? t('saving') : t('saveBtn')}</span>
        </button>
        {saveStatus && (
          <span className={`tx5dr-chip tx5dr-chip--${saveStatus.type}`}>
            {saveStatus.text}
          </span>
        )}
      </div>

      <details className="advanced-actions"><summary>{t('advanced')}</summary>
        <button className="tx5dr-button" onClick={() => setReconcileEntry({ intent: 'start', operation: 'reconcile', launchId: createLaunchId() })}>{t('reconcile')}</button>
      </details>
      {lastSyncTime && (
        <div className="status-row">
          {t('lastSync')}: {lastSyncTime}
        </div>
      )}
    </div>
  );
}
