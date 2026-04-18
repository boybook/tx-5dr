/// <reference types="@tx5dr/plugin-api/bridge" />
import { useState, useEffect, useCallback, useRef } from 'react';
import { useI18n } from '../../../_shared/ui/useI18n';
import { useAutoResize } from '../../../_shared/ui/useAutoResize';
import './App.css';

// ===== DXCC location rules (mirrors contracts/lotw.schema.ts) =====
const LOTW_LOCATION_RULES: Record<number, {
  stateLabel: string;
  countyLabel: string | null;
}> = {
  1:   { stateLabel: 'Province',   countyLabel: null },
  5:   { stateLabel: 'Kunta',      countyLabel: null },
  6:   { stateLabel: 'State',      countyLabel: 'County' },
  15:  { stateLabel: 'Oblast',     countyLabel: null },
  54:  { stateLabel: 'Oblast',     countyLabel: null },
  61:  { stateLabel: 'Oblast',     countyLabel: null },
  110: { stateLabel: 'State',      countyLabel: 'County' },
  125: { stateLabel: 'Oblast',     countyLabel: null },
  150: { stateLabel: 'State',      countyLabel: null },
  151: { stateLabel: 'Oblast',     countyLabel: null },
  224: { stateLabel: 'Kunta',      countyLabel: null },
  291: { stateLabel: 'State',      countyLabel: 'County' },
  318: { stateLabel: 'Province',   countyLabel: null },
  339: { stateLabel: 'Prefecture', countyLabel: 'City / Gun / Ku' },
};

function getLocationRule(dxccId: number | null) {
  if (!dxccId) return { stateLabel: 'State / Province', countyLabel: null };
  return LOTW_LOCATION_RULES[dxccId] ?? { stateLabel: 'State / Province', countyLabel: null };
}

// ===== i18n =====
const I18N: Record<string, Record<string, string>> = {
  zh: {
    accountTitle: 'LoTW 账户',
    usernameLabel: '用户名',
    usernamePlaceholder: 'LoTW 用户名',
    passwordLabel: '密码',
    passwordPlaceholder: 'LoTW 密码',
    verifyBtn: '验证',
    verifying: '验证中...',
    connected: '连接成功',
    connectionFailed: '连接失败',
    authFailed: '用户名或密码错误',
    certTitle: '证书管理',
    certHint: '上传从 TQSL 导出的 .p12 证书文件（不带密码保护）。',
    uploadCertBtn: '上传 .p12 证书',
    uploading: '上传中...',
    certUploaded: '证书已导入',
    certUploadFailed: '导入失败',
    certPasswordProtected: '证书受密码保护，请导出无密码的 .p12 文件',
    certInvalid: '无效的证书文件',
    certEmpty: '尚未上传证书',
    certDeleteConfirm: '确定要删除此证书吗？',
    certValid: '有效',
    certExpired: '已过期',
    certNotYetValid: '尚未生效',
    certDxcc: 'DXCC',
    certValidRange: '证书有效期',
    certQsoRange: 'QSO 日期范围',
    deleteBtn: '删除',
    locationTitle: '上传台站位置',
    callsignLabel: '呼号',
    dxccLabel: 'DXCC 实体编号',
    gridLabel: '网格定位',
    iotaLabel: 'IOTA',
    cqZoneLabel: 'CQ 区',
    ituZoneLabel: 'ITU 区',
    stateLabel: '州/省/地区',
    countyLabel: '县/区',
    syncTitle: '同步设置',
    autoUpload: 'QSO 完成后自动上传',
    autoUploadDesc: '通联完成时自动签名并上传 QSO 记录到 LoTW',
    checkReadiness: '检查上传就绪状态',
    checking: '检查中...',
    preflightReady: '已就绪，可以上传',
    preflightNotReady: '未就绪，存在问题',
    saveBtn: '保存',
    saving: '保存中...',
    saved: '已保存',
    saveFailed: '保存失败',
    missingRequired: '请先填写用户名、密码和上传台站呼号',
    lastUpload: '上次上传',
    lastDownload: '上次下载',
  },
  en: {
    accountTitle: 'LoTW Account',
    usernameLabel: 'Username',
    usernamePlaceholder: 'LoTW username',
    passwordLabel: 'Password',
    passwordPlaceholder: 'LoTW password',
    verifyBtn: 'Verify',
    verifying: 'Verifying...',
    connected: 'Connected',
    connectionFailed: 'Connection failed',
    authFailed: 'Invalid username or password',
    certTitle: 'Certificates',
    certHint: 'Upload your .p12 certificate file exported from TQSL (without password protection).',
    uploadCertBtn: 'Upload .p12 Certificate',
    uploading: 'Uploading...',
    certUploaded: 'Certificate imported',
    certUploadFailed: 'Import failed',
    certPasswordProtected: 'Certificate is password protected. Export a .p12 file without a password.',
    certInvalid: 'Invalid certificate file',
    certEmpty: 'No certificates uploaded yet',
    certDeleteConfirm: 'Delete this certificate?',
    certValid: 'Valid',
    certExpired: 'Expired',
    certNotYetValid: 'Not Yet Valid',
    certDxcc: 'DXCC',
    certValidRange: 'Certificate validity',
    certQsoRange: 'QSO date range',
    deleteBtn: 'Delete',
    locationTitle: 'Upload Location',
    callsignLabel: 'Callsign',
    dxccLabel: 'DXCC Entity ID',
    gridLabel: 'Grid Square',
    iotaLabel: 'IOTA',
    cqZoneLabel: 'CQ Zone',
    ituZoneLabel: 'ITU Zone',
    stateLabel: 'State / Province',
    countyLabel: 'County',
    syncTitle: 'Sync Options',
    autoUpload: 'Auto-upload after QSO',
    autoUploadDesc: 'Automatically sign and upload QSO records to LoTW when a contact is completed',
    checkReadiness: 'Check Readiness',
    checking: 'Checking...',
    preflightReady: 'Ready to upload',
    preflightNotReady: 'Not ready, issues found',
    saveBtn: 'Save',
    saving: 'Saving...',
    saved: 'Saved',
    saveFailed: 'Save failed',
    missingRequired: 'Please fill in username, password and upload-station callsign',
    lastUpload: 'Last upload',
    lastDownload: 'Last download',
  },
};


// ===== Types =====
interface Certificate {
  id: string;
  callsign: string;
  status: 'valid' | 'expired' | 'not_yet_valid';
  dxccId: number;
  validFrom: string;
  validTo: string;
  qsoStartDate: string;
  qsoEndDate: string;
}

interface PreflightIssue {
  severity: 'error' | 'warning' | 'info';
  message: string;
}

interface PreflightResult {
  ready: boolean;
  issues: PreflightIssue[];
}

interface ChipState {
  message: string;
  type: 'success' | 'danger';
}

// ===== Component =====
export function App() {
  const t = useI18n(I18N);
  const callsign = window.tx5dr.params.callsign ?? '';
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Account
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<ChipState | null>(null);

  // Certificates
  const [certificates, setCertificates] = useState<Certificate[]>([]);
  const [uploading, setUploading] = useState(false);
  const [certUploadResult, setCertUploadResult] = useState<ChipState | null>(null);

  // Upload Location
  const [locCallsign, setLocCallsign] = useState('');
  const [locDxcc, setLocDxcc] = useState('');
  const [locGrid, setLocGrid] = useState('');
  const [locIota, setLocIota] = useState('');
  const [locCqZone, setLocCqZone] = useState('');
  const [locItuZone, setLocItuZone] = useState('');
  const [locState, setLocState] = useState('');
  const [locCounty, setLocCounty] = useState('');

  // Sync Options
  const [autoUploadQSO, setAutoUploadQSO] = useState(false);
  const [checkingPreflight, setCheckingPreflight] = useState(false);
  const [preflightResult, setPreflightResult] = useState<PreflightResult | null>(null);

  // Save
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<ChipState | null>(null);

  // Last sync
  const [lastUploadTime, setLastUploadTime] = useState<string | null>(null);
  const [lastDownloadTime, setLastDownloadTime] = useState<string | null>(null);

  // Derived: location rule based on DXCC
  const dxccId = parseInt(locDxcc, 10) || null;
  const locationRule = getLocationRule(dxccId);

  useAutoResize();

  // ===== Load certificates =====
  const loadCertificates = useCallback(() => {
    window.tx5dr.invoke('getCertificates', { callsign }).then((result: any) => {
      setCertificates((result?.certificates) ?? []);
    }).catch(() => {
      setCertificates([]);
    });
  }, [callsign]);

  // ===== Load config on mount =====
  useEffect(() => {
    window.tx5dr.invoke('getConfig', { callsign }).then((config: any) => {
      if (!config) return;
      setUsername(config.username ?? '');
      setPassword(config.password ?? '');
      setAutoUploadQSO(!!config.autoUploadQSO);

      if (config.uploadLocation) {
        const loc = config.uploadLocation;
        setLocCallsign(loc.callsign ?? '');
        setLocDxcc(loc.dxccId != null ? String(loc.dxccId) : '');
        setLocGrid(loc.gridSquare ?? '');
        setLocIota(loc.iota ?? '');
        setLocCqZone(loc.cqZone ?? '');
        setLocItuZone(loc.ituZone ?? '');
        setLocState(loc.state ?? '');
        setLocCounty(loc.county ?? '');
      }

      if (config.lastUploadTime) {
        setLastUploadTime(new Date(config.lastUploadTime).toLocaleString());
      }
      if (config.lastDownloadTime) {
        setLastDownloadTime(new Date(config.lastDownloadTime).toLocaleString());
      }
    }).catch(() => {});

    loadCertificates();
  }, [callsign, loadCertificates]);

  // ===== Build config object =====
  const buildConfig = useCallback(() => {
    const dxccVal = parseInt(locDxcc, 10);
    return {
      username: username.trim(),
      password: password.trim(),
      uploadLocation: {
        callsign: locCallsign.trim().toUpperCase(),
        dxccId: isNaN(dxccVal) ? undefined : dxccVal,
        gridSquare: locGrid.trim().toUpperCase(),
        cqZone: locCqZone.trim(),
        ituZone: locItuZone.trim(),
        iota: locIota.trim().toUpperCase() || undefined,
        state: locState.trim().toUpperCase() || undefined,
        county: locCounty.trim().toUpperCase() || undefined,
      },
      autoUploadQSO,
    };
  }, [username, password, locCallsign, locDxcc, locGrid, locIota, locCqZone, locItuZone, locState, locCounty, autoUploadQSO]);

  // ===== Verify connection =====
  const handleVerify = useCallback(async () => {
    setVerifying(true);
    setVerifyResult(null);

    try {
      const result: any = await window.tx5dr.invoke('testConnectionDraft', {
        callsign,
        config: buildConfig(),
      });
      if (result?.success) {
        setVerifyResult({ message: t('connected'), type: 'success' });
      } else {
        const msg = result?.message;
        if (msg === 'lotw_auth_failed') {
          setVerifyResult({ message: t('authFailed'), type: 'danger' });
        } else {
          setVerifyResult({ message: msg || t('connectionFailed'), type: 'danger' });
        }
      }
    } catch (err: any) {
      setVerifyResult({ message: err.message || t('connectionFailed'), type: 'danger' });
    } finally {
      setVerifying(false);
    }
  }, [callsign, buildConfig, t]);

  // ===== Certificate upload =====
  const handleCertUpload = useCallback(async (file: File) => {
    setUploading(true);
    setCertUploadResult(null);

    const uploadPath = `certificates/uploads/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

    try {
      await window.tx5dr.fileUpload(uploadPath, file);
      const result: any = await window.tx5dr.invoke('importCertificate', {
        callsign,
        path: uploadPath,
      });

      if (result?.success) {
        setCertUploadResult({ message: t('certUploaded'), type: 'success' });
        loadCertificates();
      } else {
        setCertUploadResult({ message: t('certUploadFailed'), type: 'danger' });
      }
      setTimeout(() => setCertUploadResult(null), 3000);
    } catch (err: any) {
      const msg = err?.message ?? '';
      let text: string;
      if (msg.includes('password_protected')) {
        text = t('certPasswordProtected');
      } else if (msg.includes('callsign_mismatch')) {
        text = `${t('certUploadFailed')}: ${callsign}`;
      } else if (msg.includes('invalid')) {
        text = t('certInvalid');
      } else {
        text = t('certUploadFailed') + (msg ? `: ${msg}` : '');
      }
      setCertUploadResult({ message: text, type: 'danger' });
      setTimeout(() => setCertUploadResult(null), 5000);
    } finally {
      setUploading(false);
    }
  }, [callsign, loadCertificates, t]);

  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    handleCertUpload(file);
  }, [handleCertUpload]);

  // ===== Delete certificate =====
  const handleDeleteCert = useCallback((certId: string) => {
    if (!confirm(t('certDeleteConfirm'))) return;
    window.tx5dr.invoke('deleteCertificate', { callsign, id: certId }).then(() => {
      loadCertificates();
    }).catch(() => {});
  }, [callsign, loadCertificates, t]);

  // ===== Preflight check =====
  const handlePreflight = useCallback(async () => {
    setCheckingPreflight(true);
    setPreflightResult(null);

    try {
      const result = await window.tx5dr.invoke('getUploadPreflightDraft', {
        callsign,
        config: buildConfig(),
      }) as PreflightResult | null;

      if (result) {
        setPreflightResult(result);
      }
    } catch (err: any) {
      setPreflightResult({
        ready: false,
        issues: [{ severity: 'error', message: err.message || 'Check failed' }],
      });
    } finally {
      setCheckingPreflight(false);
    }
  }, [callsign, buildConfig]);

  // ===== Save =====
  const handleSave = useCallback(async () => {
    const nextConfig = buildConfig();
    if (
      !nextConfig.username.trim()
      || !nextConfig.password.trim()
      || !nextConfig.uploadLocation.callsign.trim()
    ) {
      setSaveResult({ message: t('missingRequired'), type: 'danger' });
      return;
    }

    setSaving(true);
    setSaveResult(null);

    try {
      await window.tx5dr.invoke('saveConfig', {
        callsign,
        config: nextConfig,
      });
      setSaveResult({ message: t('saved'), type: 'success' });
      // Close the host modal so the parent can refresh "configured" state.
      setTimeout(() => {
        setSaveResult(null);
        window.tx5dr.requestClose();
      }, 600);
    } catch (err: any) {
      setSaveResult({ message: `${t('saveFailed')}: ${err.message || ''}`, type: 'danger' });
    } finally {
      setSaving(false);
    }
  }, [callsign, buildConfig, t]);

  // ===== Certificate status helpers =====
  const certStatusText = (status: string) => {
    if (status === 'valid') return t('certValid');
    if (status === 'expired') return t('certExpired');
    return t('certNotYetValid');
  };

  const certStatusClass = (status: string) => `cert-status cert-status-${status}`;

  // ===== Preflight severity icon =====
  const severityIcon = (severity: string) => {
    if (severity === 'error') return '\u2716';
    if (severity === 'warning') return '\u26A0';
    return '\u2139';
  };

  // ===== Render =====
  return (
    <div className="container">
      {/* Account Section */}
      <div className="section-title">{t('accountTitle')}</div>
      <div className="form-group">
        <label>{t('usernameLabel')}</label>
        <input
          type="text"
          placeholder={t('usernamePlaceholder')}
          value={username}
          onChange={e => setUsername(e.target.value)}
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
      </div>
      <div className="btn-row">
        <button
          className="btn btn-secondary"
          disabled={verifying}
          onClick={handleVerify}
        >
          {verifying && <span className="spinner" />}
          <span className="btn-text">{verifying ? t('verifying') : t('verifyBtn')}</span>
        </button>
        {verifyResult && (
          <span className={`chip chip-${verifyResult.type}`}>
            {verifyResult.message}
          </span>
        )}
      </div>

      <hr className="section-divider" />

      {/* Certificates Section */}
      <div className="section-title">{t('certTitle')}</div>
      <div className="cert-hint">{t('certHint')}</div>
      <div className="btn-row">
        <button
          className="btn btn-secondary"
          disabled={uploading}
          onClick={() => fileInputRef.current?.click()}
        >
          {uploading && <span className="spinner" />}
          <span className="btn-text">{uploading ? t('uploading') : t('uploadCertBtn')}</span>
        </button>
        {certUploadResult && (
          <span className={`chip chip-${certUploadResult.type}`}>
            {certUploadResult.message}
          </span>
        )}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept=".p12,.pfx"
        style={{ display: 'none' }}
        onChange={handleFileInputChange}
      />

      <div className="cert-list">
        {certificates.length === 0 ? (
          <div className="cert-empty">{t('certEmpty')}</div>
        ) : (
          certificates.map(cert => (
            <div className="cert-card" key={cert.id}>
              <div className="cert-info">
                <div className="cert-callsign">
                  {cert.callsign}{' '}
                  <span className={certStatusClass(cert.status)}>
                    {certStatusText(cert.status)}
                  </span>
                </div>
                <div className="cert-meta">
                  {t('certDxcc')}: {cert.dxccId}<br />
                  {t('certValidRange')}: {new Date(cert.validFrom).toLocaleDateString()} ~ {new Date(cert.validTo).toLocaleDateString()}<br />
                  {t('certQsoRange')}: {new Date(cert.qsoStartDate).toLocaleDateString()} ~ {new Date(cert.qsoEndDate).toLocaleDateString()}
                </div>
              </div>
              <div className="cert-actions">
                <button
                  className="btn btn-danger"
                  onClick={() => handleDeleteCert(cert.id)}
                >
                  {t('deleteBtn')}
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      <hr className="section-divider" />

      {/* Upload Location Section */}
      <div className="section-title">{t('locationTitle')}</div>
      <div className="form-row">
        <div className="form-group form-half">
          <label>{t('callsignLabel')}</label>
          <input
            type="text"
            placeholder="W1ABC"
            value={locCallsign}
            onChange={e => setLocCallsign(e.target.value)}
          />
        </div>
        <div className="form-group form-half">
          <label>{t('dxccLabel')}</label>
          <input
            type="number"
            placeholder="291"
            min={1}
            value={locDxcc}
            onChange={e => setLocDxcc(e.target.value)}
          />
        </div>
      </div>
      <div className="form-row">
        <div className="form-group form-half">
          <label>{t('gridLabel')}</label>
          <input
            type="text"
            placeholder="FN31"
            maxLength={6}
            value={locGrid}
            onChange={e => setLocGrid(e.target.value)}
          />
        </div>
        <div className="form-group form-half">
          <label>{t('iotaLabel')}</label>
          <input
            type="text"
            placeholder="NA-001"
            value={locIota}
            onChange={e => setLocIota(e.target.value)}
          />
        </div>
      </div>
      <div className="form-row">
        <div className="form-group form-half">
          <label>{t('cqZoneLabel')}</label>
          <input
            type="text"
            placeholder="5"
            value={locCqZone}
            onChange={e => setLocCqZone(e.target.value)}
          />
        </div>
        <div className="form-group form-half">
          <label>{t('ituZoneLabel')}</label>
          <input
            type="text"
            placeholder="8"
            value={locItuZone}
            onChange={e => setLocItuZone(e.target.value)}
          />
        </div>
      </div>
      <div className="form-row">
        <div className="form-group form-half">
          <label>{locationRule.stateLabel || t('stateLabel')}</label>
          <input
            type="text"
            value={locState}
            onChange={e => setLocState(e.target.value)}
          />
        </div>
        {locationRule.countyLabel && (
          <div className="form-group form-half">
            <label>{locationRule.countyLabel}</label>
            <input
              type="text"
              value={locCounty}
              onChange={e => setLocCounty(e.target.value)}
            />
          </div>
        )}
      </div>

      <hr className="section-divider" />

      {/* Sync Options Section */}
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

      <div className="btn-row" style={{ marginTop: 'var(--tx5dr-spacing-sm)' }}>
        <button
          className="btn btn-secondary"
          disabled={checkingPreflight}
          onClick={handlePreflight}
        >
          {checkingPreflight && <span className="spinner" />}
          <span className="btn-text">{checkingPreflight ? t('checking') : t('checkReadiness')}</span>
        </button>
      </div>

      {preflightResult && (
        <div className="preflight-result">
          <div className={`preflight-ready ${preflightResult.ready ? 'preflight-ready-yes' : 'preflight-ready-no'}`}>
            {preflightResult.ready ? t('preflightReady') : t('preflightNotReady')}
          </div>
          {preflightResult.issues.map((issue, i) => (
            <div key={i} className={`preflight-issue preflight-issue-${issue.severity}`}>
              <span className="preflight-icon">{severityIcon(issue.severity)}</span>
              <span>{issue.message}</span>
            </div>
          ))}
        </div>
      )}

      <hr className="section-divider" />

      {/* Save */}
      <div className="btn-row">
        <button
          className="btn btn-primary"
          disabled={saving}
          onClick={handleSave}
        >
          <span className="btn-text">{saving ? t('saving') : t('saveBtn')}</span>
        </button>
        {saveResult && (
          <span className={`chip chip-${saveResult.type}`}>
            {saveResult.message}
          </span>
        )}
      </div>

      {(lastUploadTime || lastDownloadTime) && (
        <div className="status-row">
          {lastUploadTime && <span>{t('lastUpload')}: {lastUploadTime}</span>}
          {lastUploadTime && lastDownloadTime && <span>|</span>}
          {lastDownloadTime && <span>{t('lastDownload')}: {lastDownloadTime}</span>}
        </div>
      )}
    </div>
  );
}
