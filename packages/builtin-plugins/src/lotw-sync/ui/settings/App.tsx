/// <reference types="@tx5dr/plugin-api/bridge" />
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useI18n } from '../../../_shared/ui/useI18n';
import { useAutoResize } from '../../../_shared/ui/useAutoResize';
import './App.css';
import {
  getLoTWDXCCEntity,
  getLoTWDXCCOptions,
  getLoTWLocationRule,
  getLoTWSubdivisionOptions,
  suggestStationLocation,
  validateStationLocation,
  type LoTWStationSuggestion,
} from '@tx5dr/core';

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
    certDeleteConfirm: '再次点击确认删除',
    certDeleteCancel: '取消',
    certDeleted: '证书已删除',
    certDeleteFailed: '删除失败',
    deleting: '删除中...',
    certValid: '有效',
    certExpired: '已过期',
    certNotYetValid: '尚未生效',
    certDxcc: 'DXCC',
    certValidRange: '证书有效期',
    certQsoRange: 'QSO 日期范围',
    deleteBtn: '删除',
    locationTitle: '上传台站位置',
    callsignLabel: '呼号',
    dxccLabel: 'DXCC 实体',
    dxccPlaceholder: '选择 DXCC 实体',
    suggestedTitle: '建议的台站字段',
    applySuggestions: '应用建议',
    suggestionSource_cty: 'BigCTY',
    suggestionSource_dxcc: 'DXCC 默认值',
    suggestionSource_grid: '网格定位',
    suggestionSource_adif: 'ADIF 标准',
    suggestionConfidence_high: '高可信',
    suggestionConfidence_medium: '中等可信',
    suggestionConfidence_low: '低可信',
    noSuggestion: '暂无可应用建议',
    locationWarningTitle: '台站位置提示',
    stateOptionPlaceholder: '选择州/省/地区',
    issue_lotw_location_callsign_missing: 'LoTW 上传台站呼号未配置',
    issue_lotw_location_dxcc_missing: 'LoTW 上传 DXCC 未配置',
    issue_lotw_location_grid_missing: 'LoTW 上传网格定位未配置',
    issue_lotw_location_cq_missing: 'LoTW 上传 CQ 区未配置',
    issue_lotw_location_itu_missing: 'LoTW 上传 ITU 区未配置',
    issue_lotw_location_state_missing: '该 DXCC 需要选择州/省/地区',
    issue_lotw_location_county_missing: '该 DXCC 需要填写县/区',
    issue_lotw_location_state_invalid: '州/省/地区不是该 DXCC 的有效 ADIF 代码',
    issue_lotw_location_state_suggested: '州/省/地区将按 ADIF 标准规范化',
    issue_lotw_location_zone_mismatch: 'CQ/ITU 分区与建议值不一致',
    issue_lotw_location_grid_mismatch: 'QSO 的 MY_* 台站字段与上传台站位置不一致',
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
    issue_certificate_date_range_mismatch: '部分 QSO 不匹配任何已上传的 LoTW 证书',
    issue_qso_callsign_missing: '部分 QSO 缺少本台呼号信息',
    issue_qso_callsign_mismatch: '部分 QSO 属于其他本台呼号',
    issue_certificate_missing: '尚未上传 LoTW 证书',
    issue_upload_location_callsign_missing: 'LoTW 上传台站呼号未配置',
    issue_upload_location_dxcc_missing: 'LoTW 上传 DXCC 未配置',
    issue_upload_location_grid_missing: 'LoTW 上传网格定位未配置',
    issue_upload_location_cq_missing: 'LoTW 上传 CQ 区未配置',
    issue_upload_location_itu_missing: 'LoTW 上传 ITU 区未配置',
    issue_upload_location_state_missing: '该 DXCC 需要填写州/省/地区',
    issue_upload_location_county_missing: '该 DXCC 需要填写县/区',
    saveBtn: '保存',
    saving: '保存中...',
    saved: '已保存',
    saveFailed: '保存失败',
    missingRequired: '请先填写用户名、密码和上传台站呼号',
    lastUpload: '上次上传',
    lastDownload: '上次下载',
  },
  ja: {
    accountTitle: 'LoTWアカウント',
    usernameLabel: 'ユーザー名',
    usernamePlaceholder: 'LoTW ユーザー名',
    passwordLabel: 'パスワード',
    passwordPlaceholder: 'LoTWパスワード',
    verifyBtn: '検証する',
    verifying: '確認中...',
    connected: '接続成功',
    connectionFailed: '接続失敗',
    authFailed: 'ユーザー名またはパスワードが間違っています',
    certTitle: '証明書の管理',
    certHint: 'TQSL からエクスポートした .p12 証明書ファイルをアップロードします (パスワード保護なし)。',
    uploadCertBtn: '.p12 証明書をアップロードする',
    uploading: 'アップロード中...',
    certUploaded: '証明書がインポートされました',
    certUploadFailed: 'インポートに失敗しました',
    certPasswordProtected: '証明書はパスワードで保護されています。パスワードなしの .p12 ファイルをエクスポートしてください。',
    certInvalid: '無効な証明書ファイル',
    certEmpty: '証明書はまだアップロードされていません',
    certDeleteConfirm: 'もう一度クリックして削除を確認します',
    certDeleteCancel: 'キャンセル',
    certDeleted: '証明書が削除されました',
    certDeleteFailed: '削除に失敗しました',
    deleting: '削除中...',
    certValid: '有効な',
    certExpired: '期限切れ',
    certNotYetValid: 'まだ効果がありません',
    certDxcc: 'DXCC',
    certValidRange: '証明書の有効期間',
    certQsoRange: 'QSO日付範囲',
    deleteBtn: '削除',
    locationTitle: '局の位置をアップロードする',
    callsignLabel: 'コールサイン',
    dxccLabel: 'DXCCエンティティ',
    dxccPlaceholder: 'DXCCエンティティの選択',
    suggestedTitle: '推奨される局フィールド',
    applySuggestions: 'アプリケーションの提案',
    suggestionSource_cty: 'BigCTY',
    suggestionSource_dxcc: 'DXCCのデフォルト値',
    suggestionSource_grid: 'グリッドロケーター',
    suggestionSource_adif: 'ADIF規格',
    suggestionConfidence_high: '高い信頼性',
    suggestionConfidence_medium: '中程度に信頼できる',
    suggestionConfidence_low: '自信が低い',
    noSuggestion: 'アプリケーションの提案はまだありません',
    locationWarningTitle: '局の場所のヒント',
    stateOptionPlaceholder: '州/県/地域を選択してください',
    issue_lotw_location_callsign_missing: 'LoTW アップロード局のコールサインが設定されていません',
    issue_lotw_location_dxcc_missing: 'LoTW アップロード DXCC が設定されていません',
    issue_lotw_location_grid_missing: 'LoTW アップロード グリッド ポジショニングが構成されていません',
    issue_lotw_location_cq_missing: 'LoTW アップロード CQ エリアが設定されていません',
    issue_lotw_location_itu_missing: 'LoTW アップロード ITU エリアが構成されていません',
    issue_lotw_location_state_missing: 'この DXCC には州/県/地域の選択が必要です',
    issue_lotw_location_county_missing: 'DXCC では郡/地区の入力が必要です',
    issue_lotw_location_state_invalid: '州/県/地域は、この DXCC の有効な ADIF コードではありません',
    issue_lotw_location_state_suggested: '州/県/地域はADIF標準に標準化されます',
    issue_lotw_location_zone_mismatch: 'CQ/ITU ゾーニングが推奨値と矛盾しています',
    issue_lotw_location_grid_mismatch: 'QSO の MY_* 局 フィールドが、アップロードされた局の位置と一致しません。',
    gridLabel: 'グリッドロケーター',
    iotaLabel: 'IOTA',
    cqZoneLabel: 'CQエリア',
    ituZoneLabel: 'ITUエリア',
    stateLabel: '州/県/地域',
    countyLabel: '郡/地区',
    syncTitle: '同期設定',
    autoUpload: 'QSO完了後に自動アップロード',
    autoUploadDesc: '交信完了時にQSOレコードに自動署名してLoTWにアップロード',
    checkReadiness: 'アップロードの準備ステータスを確認する',
    checking: '確認中...',
    preflightReady: 'アップロードの準備ができました',
    preflightNotReady: '準備ができていません、問題があります',
    issue_certificate_date_range_mismatch: '一部の QSO はアップロードされた LoTW 証明書と一致しません',
    issue_qso_callsign_missing: '一部の QSO には、局のコールサイン情報がありません。',
    issue_qso_callsign_mismatch: '一部のQSOは他局のコールサインに属します',
    issue_certificate_missing: 'LoTW証明書はまだアップロードされていません',
    issue_upload_location_callsign_missing: 'LoTW アップロード局のコールサインが設定されていません',
    issue_upload_location_dxcc_missing: 'LoTW アップロード DXCC が設定されていません',
    issue_upload_location_grid_missing: 'LoTW アップロード グリッド ポジショニングが構成されていません',
    issue_upload_location_cq_missing: 'LoTW アップロード CQ エリアが設定されていません',
    issue_upload_location_itu_missing: 'LoTW アップロード ITU エリアが構成されていません',
    issue_upload_location_state_missing: 'DXCC には州/県/地域が必要です',
    issue_upload_location_county_missing: 'DXCC では郡/地区の入力が必要です',
    saveBtn: '保存',
    saving: '保存中...',
    saved: '保存しました',
    saveFailed: '保存失敗',
    missingRequired: '最初にユーザー名、パスワードを入力し、局のコールサインをアップロードしてください。',
    lastUpload: '最後のアップロード',
    lastDownload: '前回ダウンロード',
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
    certDeleteConfirm: 'Click again to confirm',
    certDeleteCancel: 'Cancel',
    certDeleted: 'Certificate deleted',
    certDeleteFailed: 'Delete failed',
    deleting: 'Deleting...',
    certValid: 'Valid',
    certExpired: 'Expired',
    certNotYetValid: 'Not Yet Valid',
    certDxcc: 'DXCC',
    certValidRange: 'Certificate validity',
    certQsoRange: 'QSO date range',
    deleteBtn: 'Delete',
    locationTitle: 'Upload Location',
    callsignLabel: 'Callsign',
    dxccLabel: 'DXCC Entity',
    dxccPlaceholder: 'Select DXCC entity',
    suggestedTitle: 'Suggested Station Fields',
    applySuggestions: 'Apply suggestions',
    suggestionSource_cty: 'BigCTY',
    suggestionSource_dxcc: 'DXCC default',
    suggestionSource_grid: 'Grid locator',
    suggestionSource_adif: 'ADIF standard',
    suggestionConfidence_high: 'high confidence',
    suggestionConfidence_medium: 'medium confidence',
    suggestionConfidence_low: 'low confidence',
    noSuggestion: 'No suggestions to apply',
    locationWarningTitle: 'Station location notice',
    stateOptionPlaceholder: 'Select state/province',
    issue_lotw_location_callsign_missing: 'LoTW upload callsign is not configured',
    issue_lotw_location_dxcc_missing: 'LoTW upload DXCC is not configured',
    issue_lotw_location_grid_missing: 'LoTW upload grid square is not configured',
    issue_lotw_location_cq_missing: 'LoTW upload CQ zone is not configured',
    issue_lotw_location_itu_missing: 'LoTW upload ITU zone is not configured',
    issue_lotw_location_state_missing: 'State/province is required for this DXCC',
    issue_lotw_location_county_missing: 'County is required for this DXCC',
    issue_lotw_location_state_invalid: 'State/province is not a valid ADIF code for this DXCC',
    issue_lotw_location_state_suggested: 'State/province will be normalized to the ADIF code',
    issue_lotw_location_zone_mismatch: 'CQ/ITU zone differs from the suggestion',
    issue_lotw_location_grid_mismatch: 'QSO MY_* station fields differ from the upload station location',
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
    issue_certificate_date_range_mismatch: 'Some QSOs do not match any uploaded LoTW certificate',
    issue_qso_callsign_missing: 'Some QSOs are missing station callsign information',
    issue_qso_callsign_mismatch: 'Some QSOs belong to a different station callsign',
    issue_certificate_missing: 'No LoTW certificate has been uploaded yet',
    issue_upload_location_callsign_missing: 'LoTW upload callsign is not configured',
    issue_upload_location_dxcc_missing: 'LoTW upload DXCC is not configured',
    issue_upload_location_grid_missing: 'LoTW upload grid square is not configured',
    issue_upload_location_cq_missing: 'LoTW upload CQ zone is not configured',
    issue_upload_location_itu_missing: 'LoTW upload ITU zone is not configured',
    issue_upload_location_state_missing: 'State/province is required for this DXCC',
    issue_upload_location_county_missing: 'County is required for this DXCC',
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
  code?: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  detail?: string;
  qsoId?: string;
  qsoCallsign?: string;
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
  const [certDeleteResult, setCertDeleteResult] = useState<ChipState | null>(null);
  const [confirmingDeleteCertId, setConfirmingDeleteCertId] = useState<string | null>(null);
  const [deletingCertId, setDeletingCertId] = useState<string | null>(null);

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
  const dxccOptions = useMemo(() => getLoTWDXCCOptions(), []);
  const dxccId = parseInt(locDxcc, 10) || null;
  const dxccEntity = useMemo(() => getLoTWDXCCEntity(dxccId), [dxccId]);
  const locationRule = useMemo(() => getLoTWLocationRule(dxccId), [dxccId]);
  const stateOptions = useMemo(() => getLoTWSubdivisionOptions(dxccId), [dxccId]);
  const currentLocation = useMemo(() => ({
    callsign: locCallsign,
    dxccId: dxccId ?? undefined,
    gridSquare: locGrid,
    cqZone: locCqZone,
    ituZone: locItuZone,
    iota: locIota,
    state: locState,
    county: locCounty,
  }), [locCallsign, dxccId, locGrid, locCqZone, locItuZone, locIota, locState, locCounty]);
  const stationSuggestionResult = useMemo(() => suggestStationLocation({
    callsign: locCallsign,
    dxccId: dxccId ?? undefined,
    gridSquare: locGrid,
    current: currentLocation,
  }), [locCallsign, dxccId, locGrid, currentLocation]);
  const locationValidationIssues = useMemo(() => validateStationLocation(currentLocation), [currentLocation]);
  const actionableSuggestions = stationSuggestionResult.suggestions.filter((suggestion) => {
    if (suggestion.field === 'cqZone') return locCqZone.trim() !== String(suggestion.value);
    if (suggestion.field === 'ituZone') return locItuZone.trim() !== String(suggestion.value);
    if (suggestion.field === 'state') return locState.trim().toUpperCase() !== String(suggestion.value).toUpperCase();
    return false;
  });

  useAutoResize();

  const formatIssueMessage = useCallback((issue: PreflightIssue): string => {
    if (!issue.code) return issue.message;
    const key = `issue_${issue.code}`;
    const translated = t(key);
    return translated === key ? issue.message : translated;
  }, [t]);

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

  const formatSuggestion = useCallback((suggestion: LoTWStationSuggestion): string => {
    const source = t(`suggestionSource_${suggestion.source}`);
    const confidence = t(`suggestionConfidence_${suggestion.confidence}`);
    const label = suggestion.label ? ` - ${suggestion.label}` : '';
    return `${suggestion.field}: ${suggestion.value}${label} (${source}, ${confidence})`;
  }, [t]);

  const applySuggestion = useCallback((suggestion: LoTWStationSuggestion) => {
    const value = String(suggestion.value);
    if (suggestion.field === 'cqZone') setLocCqZone(value);
    if (suggestion.field === 'ituZone') setLocItuZone(value);
    if (suggestion.field === 'state') setLocState(value);
  }, []);

  const applyAllSuggestions = useCallback(() => {
    for (const suggestion of actionableSuggestions) {
      applySuggestion(suggestion);
    }
  }, [actionableSuggestions, applySuggestion]);

  const firstLocationError = useMemo(
    () => locationValidationIssues.find((issue) => issue.severity === 'error'),
    [locationValidationIssues],
  );

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
      const storedPath = await window.tx5dr.fileUpload(uploadPath, file);
      const result: any = await window.tx5dr.invoke('importCertificate', {
        callsign,
        path: storedPath,
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
  const handleDeleteCert = useCallback(async (certId: string) => {
    if (confirmingDeleteCertId !== certId) {
      setConfirmingDeleteCertId(certId);
      setCertDeleteResult(null);
      return;
    }

    setDeletingCertId(certId);
    setCertDeleteResult(null);
    try {
      const result = await window.tx5dr.invoke('deleteCertificate', { callsign, id: certId }) as { success?: boolean } | null;
      if (!result?.success) {
        setConfirmingDeleteCertId(null);
        loadCertificates();
        setCertDeleteResult({ message: t('certDeleteFailed'), type: 'danger' });
        setTimeout(() => setCertDeleteResult(null), 5000);
        return;
      }
      setConfirmingDeleteCertId(null);
      setCertDeleteResult({ message: t('certDeleted'), type: 'success' });
      loadCertificates();
      setTimeout(() => setCertDeleteResult(null), 3000);
    } catch (err: any) {
      setConfirmingDeleteCertId(null);
      loadCertificates();
      const detail = err?.message ? `: ${err.message}` : '';
      setCertDeleteResult({ message: `${t('certDeleteFailed')}${detail}`, type: 'danger' });
      setTimeout(() => setCertDeleteResult(null), 5000);
    } finally {
      setDeletingCertId(null);
    }
  }, [callsign, confirmingDeleteCertId, loadCertificates, t]);

  const handleCancelDeleteCert = useCallback(() => {
    setConfirmingDeleteCertId(null);
    setCertDeleteResult(null);
  }, []);

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
    if (firstLocationError) {
      setSaveResult({
        message: formatIssueMessage({
          severity: firstLocationError.severity,
          code: firstLocationError.code,
          message: firstLocationError.message,
          detail: firstLocationError.detail,
        }),
        type: 'danger',
      });
      return;
    }

    setSaving(true);
    setSaveResult(null);

    try {
      const result: any = await window.tx5dr.invoke('saveConfig', {
        callsign,
        config: nextConfig,
      });
      if (result?.success === false) {
        const issue = result.issues?.find((item: PreflightIssue) => item.severity === 'error') ?? result.issues?.[0];
        setSaveResult({
          message: issue ? formatIssueMessage(issue) : t('saveFailed'),
          type: 'danger',
        });
        return;
      }
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
  }, [callsign, buildConfig, firstLocationError, formatIssueMessage, t]);

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
        {certDeleteResult && (
          <span className={`chip chip-${certDeleteResult.type}`}>
            {certDeleteResult.message}
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
                  disabled={deletingCertId === cert.id}
                  onClick={() => handleDeleteCert(cert.id)}
                >
                  {deletingCertId === cert.id && <span className="spinner" />}
                  <span className="btn-text">
                    {deletingCertId === cert.id
                      ? t('deleting')
                      : confirmingDeleteCertId === cert.id
                        ? t('certDeleteConfirm')
                        : t('deleteBtn')}
                  </span>
                </button>
                {confirmingDeleteCertId === cert.id && deletingCertId !== cert.id && (
                  <button
                    className="btn btn-secondary"
                    onClick={handleCancelDeleteCert}
                  >
                    {t('certDeleteCancel')}
                  </button>
                )}
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
          <select
            value={locDxcc}
            onChange={e => { setLocDxcc(e.target.value); setLocState(''); setLocCounty(''); }}
          >
            <option value="">{t('dxccPlaceholder')}</option>
            {dxccOptions.map(entity => (
              <option key={entity.entityCode} value={String(entity.entityCode)}>
                {entity.flag ? `${entity.flag} ` : ''}{entity.name} ({entity.entityCode})
              </option>
            ))}
          </select>
          {dxccEntity && <div className="field-hint">{dxccEntity.name} ({dxccEntity.entityCode})</div>}
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
      {locationRule?.stateField && (
        <div className="form-row">
          <div className="form-group form-half">
            <label>{locationRule.stateLabel || t('stateLabel')}</label>
            {stateOptions.length > 0 ? (
              <select value={locState} onChange={e => setLocState(e.target.value)}>
                <option value="">{t('stateOptionPlaceholder')}</option>
                {stateOptions.map(option => (
                  <option key={option.code} value={option.code}>{option.code} - {option.name}</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={locState}
                onChange={e => setLocState(e.target.value)}
              />
            )}
          </div>
          {locationRule?.countyField && (
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
      )}

      {(actionableSuggestions.length > 0 || locationValidationIssues.some(issue => issue.severity !== 'info')) && (
        <div className="suggestion-card">
          <div className="suggestion-title">{t('suggestedTitle')}</div>
          {actionableSuggestions.length > 0 ? (
            <>
              <div className="suggestion-list">
                {actionableSuggestions.map((suggestion, index) => (
                  <button
                    key={`${suggestion.field}-${index}`}
                    type="button"
                    className="suggestion-pill"
                    onClick={() => applySuggestion(suggestion)}
                  >
                    {formatSuggestion(suggestion)}
                  </button>
                ))}
              </div>
              <button type="button" className="btn btn-secondary" onClick={applyAllSuggestions}>
                {t('applySuggestions')}
              </button>
            </>
          ) : (
            <div className="field-hint">{t('noSuggestion')}</div>
          )}
          {locationValidationIssues.some(issue => issue.severity !== 'info') && (
            <div className="location-warning-list">
              <div className="location-warning-title">{t('locationWarningTitle')}</div>
              {locationValidationIssues
                .filter(issue => issue.severity !== 'info')
                .map((issue, index) => (
                  <div key={index} className={`preflight-issue preflight-issue-${issue.severity}`}>
                    <span className="preflight-icon">{severityIcon(issue.severity)}</span>
                    <span>{formatIssueMessage({ severity: issue.severity, code: issue.code, message: issue.message, detail: issue.detail })}</span>
                  </div>
                ))}
            </div>
          )}
        </div>
      )}

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
              <span>
                {formatIssueMessage(issue)}
                {(issue.qsoCallsign || issue.qsoId || issue.detail) && (
                  <span className="preflight-issue-detail">
                    {' '}
                    {[
                      issue.qsoCallsign ? `QSO=${issue.qsoCallsign}` : '',
                      issue.qsoId ? `id=${issue.qsoId}` : '',
                      issue.detail && issue.detail !== issue.message ? issue.detail : '',
                    ].filter(Boolean).join('; ')}
                  </span>
                )}
              </span>
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
