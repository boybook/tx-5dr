/// <reference types="@tx5dr/plugin-api/bridge" />
import { useState, useEffect, useCallback } from 'react';
import { useI18n } from '../../../_shared/ui/useI18n';
import { useAutoResize } from '../../../_shared/ui/useAutoResize';
import './App.css';

interface Station {
  station_id: string;
  station_profile_name: string;
  station_callsign: string;
  station_gridsquare?: string;
}

const I18N: Record<string, Record<string, string>> = {
  zh: {
    connectionTitle: 'WaveLog 连接设置',
    urlLabel: '服务器 URL',
    urlPlaceholder: 'https://your-wavelog.example.com',
    apiKeyLabel: 'API 密钥',
    apiKeyPlaceholder: '输入 WaveLog API 密钥',
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
    connected: '连接成功',
    connectionFailed: '连接失败',
    lastSync: '上次同步',
  },
  en: {
    connectionTitle: 'WaveLog Connection',
    urlLabel: 'Server URL',
    urlPlaceholder: 'https://your-wavelog.example.com',
    apiKeyLabel: 'API Key',
    apiKeyPlaceholder: 'Enter WaveLog API key',
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
    connected: 'Connected',
    connectionFailed: 'Connection failed',
    lastSync: 'Last sync',
  },
};

export function App() {
  const t = useI18n(I18N);
  const callsign = window.tx5dr.params.callsign ?? '';

  const [url, setUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [stations, setStations] = useState<Station[]>([]);
  const [stationId, setStationId] = useState('');
  const [radioName, setRadioName] = useState('TX5DR');
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

    bridge.invoke('getConfig', { callsign }).then((config: any) => {
      if (!config) return;
      setUrl(config.url || '');
      setApiKey(config.apiKey || '');
      setRadioName(config.radioName || 'TX5DR');
      setAutoUpload(!!config.autoUploadQSO);

      if (config.lastSyncTime) {
        setLastSyncTime(new Date(config.lastSyncTime).toLocaleString());
      }

      // If we have url+apiKey, try to fetch stations
      if (config.url && config.apiKey) {
        bridge.invoke('getStations', {
          callsign,
          url: config.url,
          apiKey: config.apiKey,
        }).then((result: any) => {
          if (result?.stations) {
            setStations(result.stations);
            // Set selected station
            if (config.stationId) {
              setStationId(config.stationId);
            } else if (result.stations.length === 1) {
              setStationId(result.stations[0].station_id);
            }
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
    if (!trimmedUrl || !trimmedKey) return;

    setTesting(true);
    setTestStatus(null);

    window.tx5dr.invoke('testConnection', {
      callsign,
      url: trimmedUrl,
      apiKey: trimmedKey,
    }).then((result: any) => {
      setTesting(false);
      if (result.success) {
        setTestStatus({ type: 'success', text: t('connected') });
        if (result.stations) {
          setStations(result.stations);
          // Preserve current selection if still valid
          const currentValid = result.stations.some(
            (s: Station) => s.station_id === stationId,
          );
          if (!currentValid && result.stations.length === 1) {
            setStationId(result.stations[0].station_id);
          } else if (!currentValid) {
            setStationId('');
          }
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
  }, [url, apiKey, callsign, stationId, t]);

  // Save config
  const handleSave = useCallback(() => {
    setSaving(true);
    setSaveStatus(null);

    window.tx5dr.invoke('saveConfig', {
      callsign,
      config: {
        url: url.trim(),
        apiKey: apiKey.trim(),
        stationId,
        radioName: radioName.trim() || 'TX5DR',
        autoUploadQSO: autoUpload,
      },
    }).then(() => {
      setSaving(false);
      setSaveStatus({ type: 'success', text: t('saved') });
      setTimeout(() => setSaveStatus(null), 2000);
    }).catch((err: any) => {
      setSaving(false);
      setSaveStatus({
        type: 'danger',
        text: `${t('saveFailed')}: ${err.message || ''}`,
      });
    });
  }, [callsign, url, apiKey, stationId, radioName, autoUpload, t]);

  // Build station option label
  const stationLabel = (s: Station) => {
    let label = s.station_profile_name;
    if (s.station_callsign) label += ` (${s.station_callsign})`;
    if (s.station_gridsquare) label += ` [${s.station_gridsquare}]`;
    return label;
  };

  return (
    <div className="container">
      {/* Connection section */}
      <div className="section-title">{t('connectionTitle')}</div>

      <div className="form-group">
        <label>{t('urlLabel')}</label>
        <input
          type="url"
          placeholder={t('urlPlaceholder')}
          value={url}
          onChange={e => setUrl(e.target.value)}
        />
      </div>

      <div className="form-group">
        <label>{t('apiKeyLabel')}</label>
        <input
          type="password"
          placeholder={t('apiKeyPlaceholder')}
          value={apiKey}
          onChange={e => setApiKey(e.target.value)}
        />
      </div>

      <div className="btn-row">
        <button
          className="btn btn-secondary"
          disabled={testing || !url.trim() || !apiKey.trim()}
          onClick={handleTest}
        >
          {testing && <span className="spinner" />}
          <span>{testing ? t('testing') : t('testBtn')}</span>
        </button>
        {testStatus && (
          <span className={`chip chip-${testStatus.type}`}>
            {testStatus.text}
          </span>
        )}
      </div>

      <div className="form-group" style={{ marginTop: 'var(--tx5dr-spacing-md)' }}>
        <label>{t('stationLabel')}</label>
        <select
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

      <div className="form-group">
        <label>{t('radioNameLabel')}</label>
        <input
          type="text"
          value={radioName}
          onChange={e => setRadioName(e.target.value)}
        />
      </div>

      <hr className="section-divider" />

      {/* Sync section */}
      <div className="section-title">{t('syncTitle')}</div>

      <div className="toggle-row">
        <div>
          <div className="toggle-label">{t('autoUpload')}</div>
          <div className="toggle-desc">{t('autoUploadDesc')}</div>
        </div>
        <label className="switch">
          <input
            type="checkbox"
            checked={autoUpload}
            onChange={e => setAutoUpload(e.target.checked)}
          />
          <span className="slider" />
        </label>
      </div>

      <hr className="section-divider" />

      {/* Save */}
      <div className="btn-row">
        <button
          className="btn btn-primary"
          disabled={saving}
          onClick={handleSave}
        >
          <span>{saving ? t('saving') : t('saveBtn')}</span>
        </button>
        {saveStatus && (
          <span className={`chip chip-${saveStatus.type}`}>
            {saveStatus.text}
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
