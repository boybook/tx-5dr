import React, { useState, useEffect, forwardRef, useImperativeHandle, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Card,
  CardBody,
  Switch,
  Input,
  Select,
  SelectItem,
  Chip,
  Divider,
} from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCopy, faCheck } from '@fortawesome/free-solid-svg-icons';
import { Button } from '@heroui/react';
import { api, ApiError } from '@tx5dr/core';
import type {
  DecodeWindowSettings,
  PSKReporterConfig,
  PSKReporterStatus,
  AuthStatus,
  NetworkInfo,
  LiveKitNetworkMode,
  RealtimeSettingsResponseData,
  RealtimeTransportKind,
  RealtimeTransportPolicy,
  DesktopHttpsStatus,
  DesktopHttpsMode,
} from '@tx5dr/contracts';
import { DEFAULT_DECODE_WINDOW_SETTINGS, FT8_WINDOW_PRESETS, FT4_WINDOW_PRESETS } from '@tx5dr/contracts';
import { showErrorToast } from '../../utils/errorToast';
import { createLogger } from '../../utils/logger';
import { useConnection } from '../../store/radioStore';
import { useWSEvent } from '../../hooks/useWSEvent';

interface DecodeWindowState {
  ft8Preset: string;
  ft8CustomWindows: number[];
  ft4Preset: string;
  ft4CustomWindows: number[];
}

interface DesktopUpdateState {
  channel: 'release' | 'nightly';
  currentVersion: string;
  currentCommit: string | null;
  checking: boolean;
  updateAvailable: boolean;
  latestVersion: string | null;
  latestCommit: string | null;
  publishedAt: string | null;
  releaseNotes: string | null;
  downloadUrl: string | null;
  downloadOptions: Array<{
    name: string;
    url: string;
    packageType: string;
    platform: string;
    arch: string;
    recommended: boolean;
    source: 'oss' | 'github';
  }>;
  metadataSource: 'oss' | 'github' | null;
  downloadSource: 'oss' | 'github' | null;
  errorMessage: string | null;
}

type RealtimeRuntimeView = NonNullable<RealtimeSettingsResponseData['runtime']>;

const SETTINGS_CARD_CLASS_NAMES = {
  base: 'border border-divider bg-content1',
} as const;

const SETTINGS_CARD_BODY_CLASS = 'p-5 space-y-4';
const SETTINGS_CARD_TITLE_CLASS = 'text-base font-semibold text-default-900';
const SETTINGS_CARD_DESC_CLASS = 'text-sm leading-6 text-default-600';
const SETTINGS_SUBTITLE_CLASS = 'text-sm font-medium text-default-900';
const SETTINGS_SUBDESC_CLASS = 'text-xs leading-5 text-default-500';
const SETTINGS_MUTED_CLASS = 'text-xs leading-5 text-default-400';
const SETTINGS_PANEL_CLASS = 'rounded-medium border border-divider bg-default-50 px-3 py-3 dark:bg-default-100/5';
const SETTINGS_SOFT_PANEL_CLASS = 'rounded-medium bg-default-50 px-3 py-3 dark:bg-default-100/5';
const SETTINGS_METRIC_CLASS = 'rounded-medium bg-content1 px-3 py-2';

const DEFAULT_DECODE_WINDOW_STATE: DecodeWindowState = {
  ft8Preset: DEFAULT_DECODE_WINDOW_SETTINGS.ft8?.preset ?? 'balanced',
  ft8CustomWindows: [...FT8_WINDOW_PRESETS[DEFAULT_DECODE_WINDOW_SETTINGS.ft8?.preset ?? 'balanced']],
  ft4Preset: DEFAULT_DECODE_WINDOW_SETTINGS.ft4?.preset ?? 'balanced',
  ft4CustomWindows: [...FT4_WINDOW_PRESETS[DEFAULT_DECODE_WINDOW_SETTINGS.ft4?.preset ?? 'balanced']],
};

function buildLiveKitExampleUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/livekit';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '/livekit');
  } catch {
    return 'ws://127.0.0.1/livekit';
  }
}

function formatDateTimeValue(value?: string | null): string {
  if (!value) return '-';
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return value;
  return time.toLocaleString();
}

function getDesktopHttpsStatusColor(status: DesktopHttpsStatus['certificateStatus'] | undefined): 'success' | 'warning' | 'danger' {
  if (status === 'valid') return 'success';
  if (status === 'invalid') return 'danger';
  return 'warning';
}

function getDesktopUpdateSourceColor(source: DesktopUpdateState['metadataSource']): 'success' | 'primary' | 'default' {
  if (source === 'oss') return 'success';
  if (source === 'github') return 'primary';
  return 'default';
}

function getDesktopUpdateOptionLabel(
  packageType: string,
  t: (key: string) => string,
): string {
  switch (packageType) {
    case 'msi':
      return t('system.desktopUpdatePackageType.msi');
    case 'dmg':
      return t('system.desktopUpdatePackageType.dmg');
    case '7z':
      return t('system.desktopUpdatePackageType.7z');
    case 'zip':
      return t('system.desktopUpdatePackageType.zip');
    case 'deb':
      return t('system.desktopUpdatePackageType.deb');
    case 'rpm':
      return t('system.desktopUpdatePackageType.rpm');
    case 'AppImage':
      return t('system.desktopUpdatePackageType.AppImage');
    default:
      return packageType.toUpperCase();
  }
}

function getWindowCount(preset: string, customWindows: number[], presets: Record<string, number[]>): number {
  if (preset === 'custom') return customWindows.length;
  return presets[preset]?.length ?? 1;
}

function buildDecodeWindowState(settings?: DecodeWindowSettings): DecodeWindowState {
  const resolvedSettings = settings ?? DEFAULT_DECODE_WINDOW_SETTINGS;

  const ft8Preset = resolvedSettings.ft8?.preset ?? DEFAULT_DECODE_WINDOW_STATE.ft8Preset;
  const ft4Preset = resolvedSettings.ft4?.preset ?? DEFAULT_DECODE_WINDOW_STATE.ft4Preset;

  return {
    ft8Preset,
    ft8CustomWindows: resolvedSettings.ft8?.customWindowTiming ?? [...(FT8_WINDOW_PRESETS[ft8Preset] ?? DEFAULT_DECODE_WINDOW_STATE.ft8CustomWindows)],
    ft4Preset,
    ft4CustomWindows: resolvedSettings.ft4?.customWindowTiming ?? [...(FT4_WINDOW_PRESETS[ft4Preset] ?? DEFAULT_DECODE_WINDOW_STATE.ft4CustomWindows)],
  };
}

function getCpuLoadInfo(count: number, t: (key: string) => string): { label: string; color: 'success' | 'primary' | 'warning' | 'danger' } {
  if (count <= 1) return { label: t('system.cpuVeryLow'), color: 'success' };
  if (count <= 2) return { label: t('system.cpuLow'), color: 'success' };
  if (count <= 3) return { label: t('system.cpuMedium'), color: 'primary' };
  if (count <= 5) return { label: t('system.cpuHigh'), color: 'warning' };
  return { label: t('system.cpuVeryHigh'), color: 'danger' };
}

function getRealtimeTransportLabel(
  transport: 'livekit' | 'ws-compat' | null | undefined,
  t: (key: string) => string,
): string {
  if (transport === 'livekit') {
    return t('system.realtimePathLiveKit');
  }
  if (transport === 'ws-compat') {
    return t('system.realtimePathCompat');
  }
  return t('system.realtimeUnknown');
}

function getRealtimeIssueLabel(
  issueCode: RealtimeConnectivityErrorCode | null | undefined,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (!issueCode) {
    return t('system.realtimeNoRecentIssue');
  }

  switch (issueCode) {
    case 'PUBLIC_URL_MISCONFIGURED':
      return t('radio:realtime.publicUrlMisconfigured', { scope: t('radio:realtime.scopeRadio') });
    case 'SIGNALING_UNREACHABLE':
      return t('radio:realtime.signalingUnreachable', { scope: t('radio:realtime.scopeRadio') });
    case 'ICE_CONNECTION_FAILED':
      return t('radio:realtime.iceFailed', { scope: t('radio:realtime.scopeRadio') });
    case 'NO_AUDIO_TRACK':
      return t('radio:realtime.noAudioTrack', { scope: t('radio:realtime.scopeRadio') });
    case 'AUDIO_PLAYBACK_BLOCKED':
      return t('radio:realtime.audioPlaybackBlocked', { scope: t('radio:realtime.scopeRadio') });
    case 'MEDIA_DEVICE_PERMISSION_DENIED':
      return t('radio:realtime.mediaPermissionDenied');
    case 'SESSION_EXPIRED_OR_INVALID':
      return t('radio:realtime.sessionExpired', { scope: t('radio:realtime.scopeRadio') });
    case 'TOKEN_REQUEST_FAILED':
      return t('radio:realtime.tokenRequestFailed', { scope: t('radio:realtime.scopeRadio') });
    default:
      return t('radio:realtime.unknownFailure', { scope: t('radio:realtime.scopeRadio') });
  }
}

function getRealtimeCredentialSourceLabel(
  source: RealtimeCredentialStatus['source'] | null | undefined,
  t: (key: string) => string,
): string {
  switch (source) {
    case 'managed-file':
      return t('system.realtimeCredentialManaged');
    case 'environment-override':
      return t('system.realtimeCredentialEnvOverride');
    case 'missing':
      return t('system.realtimeCredentialMissing');
    default:
      return t('system.realtimeUnknown');
  }
}

const logger = createLogger('SystemSettings');

export interface SystemSettingsRef {
  hasUnsavedChanges: () => boolean;
  save: () => Promise<void>;
}

interface SystemSettingsProps {
  onUnsavedChanges?: (hasChanges: boolean) => void;
}

function getReportIntervalOptions(t: (key: string) => string) {
  return [
    { value: '10', label: t('settings:reportInterval.10s') },
    { value: '15', label: t('settings:reportInterval.15s') },
    { value: '30', label: t('settings:reportInterval.30s') },
    { value: '60', label: t('settings:reportInterval.60s') },
  ];
}

export const SystemSettings = forwardRef<
  SystemSettingsRef,
  SystemSettingsProps
>(({ onUnsavedChanges }, ref) => {
  const { t } = useTranslation();
  const connection = useConnection();
  const REPORT_INTERVAL_OPTIONS = useMemo(() => getReportIntervalOptions(t), [t]);
  const [decodeWhileTransmitting, setDecodeWhileTransmitting] = useState(false);
  const [originalDecodeValue, setOriginalDecodeValue] = useState(false);
  const [spectrumWhileTransmitting, setSpectrumWhileTransmitting] = useState(true);
  const [originalSpectrumValue, setOriginalSpectrumValue] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string>('');

  // 认证配置
  const [authConfig, setAuthConfig] = useState<AuthStatus | null>(null);
  const [originalAuthConfig, setOriginalAuthConfig] = useState<AuthStatus | null>(null);

  // PSKReporter 状态
  const [pskrConfig, setPskrConfig] = useState<PSKReporterConfig | null>(null);
  const [originalPskrConfig, setOriginalPskrConfig] = useState<PSKReporterConfig | null>(null);
  const [pskrStatus, setPskrStatus] = useState<PSKReporterStatus | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_pskrStatusLoading, setPskrStatusLoading] = useState(false);

  // 网络信息
  const [networkInfo, setNetworkInfo] = useState<NetworkInfo | null>(null);
  const [liveKitPublicUrl, setLiveKitPublicUrl] = useState('');
  const [originalLiveKitPublicUrl, setOriginalLiveKitPublicUrl] = useState('');
  const [realtimeTransportPolicy, setRealtimeTransportPolicy] = useState<RealtimeTransportPolicy>('auto');
  const [originalRealtimeTransportPolicy, setOriginalRealtimeTransportPolicy] = useState<RealtimeTransportPolicy>('auto');
  const [liveKitNetworkMode, setLiveKitNetworkMode] = useState<LiveKitNetworkMode>('lan');
  const [originalLiveKitNetworkMode, setOriginalLiveKitNetworkMode] = useState<LiveKitNetworkMode>('lan');
  const [liveKitNodeIp, setLiveKitNodeIp] = useState('');
  const [originalLiveKitNodeIp, setOriginalLiveKitNodeIp] = useState('');
  const [realtimeRuntime, setRealtimeRuntime] = useState<RealtimeRuntimeView | null>(null);
  const [urlCopied, setUrlCopied] = useState(false);

  // 解码窗口设置
  const [decodeWindowState, setDecodeWindowState] = useState<DecodeWindowState>({ ...DEFAULT_DECODE_WINDOW_STATE });
  const [originalDecodeWindowState, setOriginalDecodeWindowState] = useState<DecodeWindowState>({ ...DEFAULT_DECODE_WINDOW_STATE });

  // Electron 关闭行为设置（仅桌面应用）
  const [closeBehavior, setCloseBehavior] = useState<string>('ask');
  const [originalCloseBehavior, setOriginalCloseBehavior] = useState<string>('ask');
  const isElectron = typeof window !== 'undefined' && !!window.electronAPI;
  const isMacElectron = isElectron && typeof window !== 'undefined' && window.navigator.userAgent.includes('Macintosh');
  const [desktopHttpsStatus, setDesktopHttpsStatus] = useState<DesktopHttpsStatus | null>(null);
  const [desktopHttpsEnabled, setDesktopHttpsEnabled] = useState(false);
  const [originalDesktopHttpsEnabled, setOriginalDesktopHttpsEnabled] = useState(false);
  const [desktopHttpsMode, setDesktopHttpsMode] = useState<DesktopHttpsMode>('self-signed');
  const [originalDesktopHttpsMode, setOriginalDesktopHttpsMode] = useState<DesktopHttpsMode>('self-signed');
  const [desktopHttpsPort, setDesktopHttpsPort] = useState('8443');
  const [originalDesktopHttpsPort, setOriginalDesktopHttpsPort] = useState('8443');
  const [desktopHttpsRedirectExternalHttp, setDesktopHttpsRedirectExternalHttp] = useState(true);
  const [originalDesktopHttpsRedirectExternalHttp, setOriginalDesktopHttpsRedirectExternalHttp] = useState(true);
  const [desktopHttpsBusy, setDesktopHttpsBusy] = useState(false);
  const [desktopHttpsUrlCopied, setDesktopHttpsUrlCopied] = useState(false);
  const [desktopUpdateStatus, setDesktopUpdateStatus] = useState<DesktopUpdateState | null>(null);
  const [desktopUpdateBusy, setDesktopUpdateBusy] = useState(false);
  const [desktopUpdateError, setDesktopUpdateError] = useState('');

  // 加载配置
  useEffect(() => {
    loadSettings();
    loadAuthConfig();
    loadPSKReporterConfig();
    loadPSKReporterStatus();
    loadDecodeWindowSettings();
    loadRealtimeSettings();
    api.getNetworkInfo().then(setNetworkInfo).catch(() => {});
    loadElectronCloseBehavior();
    if (isElectron) {
      void loadDesktopHttpsSettings();
      void loadDesktopUpdateStatus();
    }
  }, []);

  const loadSettings = async () => {
    try {
      const result = await api.getFT8Settings();
      const ft8Data = result.data as { decodeWhileTransmitting?: boolean; spectrumWhileTransmitting?: boolean } | undefined;
      const decodeValue = ft8Data?.decodeWhileTransmitting ?? false;
      const spectrumValue = ft8Data?.spectrumWhileTransmitting ?? true;

      setDecodeWhileTransmitting(decodeValue);
      setOriginalDecodeValue(decodeValue);
      setSpectrumWhileTransmitting(spectrumValue);
      setOriginalSpectrumValue(spectrumValue);
    } catch (err) {
      logger.error('Failed to load FT8 settings:', err);
      if (err instanceof ApiError) {
        setError(err.userMessage);
        showErrorToast({
          userMessage: err.userMessage,
          suggestions: err.suggestions,
          severity: err.severity,
          code: err.code
        });
      } else {
        setError(t('system.loadFailed'));
      }
    }
  };

  // 加载认证配置
  const loadAuthConfig = async () => {
    try {
      const status = await api.getAuthStatus();
      setAuthConfig(status);
      setOriginalAuthConfig(status);
    } catch (err) {
      logger.error('Failed to load auth config:', err);
    }
  };

  // 加载 PSKReporter 配置
  const loadPSKReporterConfig = async () => {
    try {
      const result = await api.getPSKReporterConfig();
      if (result.success && result.data) {
        setPskrConfig(result.data);
        setOriginalPskrConfig(result.data);
      }
    } catch (err) {
      logger.error('Failed to load PSKReporter config:', err);
    }
  };

  // 加载 PSKReporter 状态
  const loadPSKReporterStatus = useCallback(async () => {
    setPskrStatusLoading(true);
    try {
      const result = await api.getPSKReporterStatus();
      if (result.success && result.data) {
        setPskrStatus(result.data);
      }
    } catch (err) {
      logger.error('Failed to load PSKReporter status:', err);
    } finally {
      setPskrStatusLoading(false);
    }
  }, []);

  // 加载解码窗口设置
  const loadDecodeWindowSettings = async () => {
    try {
      const result = await api.getDecodeWindowSettings();
      if (result.success && result.data) {
        const settings = result.data.settings as DecodeWindowSettings | undefined;
        const state = buildDecodeWindowState(settings);
        setDecodeWindowState(state);
        setOriginalDecodeWindowState({ ...state });
      }
    } catch (err) {
      logger.error('Failed to load decode window settings:', err);
    }
  };

  // 加载 Electron 关闭行为设置
  const loadElectronCloseBehavior = async () => {
    try {
      const value = await window.electronAPI?.config?.get('closeBehavior');
      if (value) {
        setCloseBehavior(value);
        setOriginalCloseBehavior(value);
      }
    } catch {
      // Not in Electron environment, ignore
    }
  };

  const applyDesktopHttpsSnapshot = useCallback((
    status: DesktopHttpsStatus,
    options?: { preserveDraft?: boolean },
  ) => {
    const preserveDraft = options?.preserveDraft === true;
    const hasLocalDraft = (
      desktopHttpsEnabled !== originalDesktopHttpsEnabled ||
      desktopHttpsMode !== originalDesktopHttpsMode ||
      desktopHttpsPort !== originalDesktopHttpsPort ||
      desktopHttpsRedirectExternalHttp !== originalDesktopHttpsRedirectExternalHttp
    );

    if (!preserveDraft || !hasLocalDraft) {
      setDesktopHttpsEnabled(status.enabled);
      setDesktopHttpsMode(status.mode);
      setDesktopHttpsPort(String(status.httpsPort));
      setDesktopHttpsRedirectExternalHttp(status.redirectExternalHttp);
    }

    setOriginalDesktopHttpsEnabled(status.enabled);
    setOriginalDesktopHttpsMode(status.mode);
    setOriginalDesktopHttpsPort(String(status.httpsPort));
    setOriginalDesktopHttpsRedirectExternalHttp(status.redirectExternalHttp);
    setDesktopHttpsStatus(status);
  }, [
    desktopHttpsEnabled,
    originalDesktopHttpsEnabled,
    desktopHttpsMode,
    originalDesktopHttpsMode,
    desktopHttpsPort,
    originalDesktopHttpsPort,
    desktopHttpsRedirectExternalHttp,
    originalDesktopHttpsRedirectExternalHttp,
  ]);

  const loadDesktopHttpsSettings = useCallback(async () => {
    if (!window.electronAPI?.https?.getStatus) return;
    try {
      const status = await window.electronAPI.https.getStatus();
      applyDesktopHttpsSnapshot(status, { preserveDraft: true });
    } catch (err) {
      logger.error('Failed to load desktop HTTPS settings:', err);
    }
  }, [applyDesktopHttpsSnapshot]);

  const loadDesktopUpdateStatus = useCallback(async () => {
    if (!window.electronAPI?.updater?.getStatus) return;
    try {
      const status = await window.electronAPI.updater.getStatus();
      setDesktopUpdateStatus(status);
      setDesktopUpdateError(status.errorMessage || '');
    } catch (err) {
      logger.error('Failed to load desktop update status:', err);
      setDesktopUpdateError(err instanceof Error ? err.message : t('system.desktopUpdateCheckFailed'));
    }
  }, [t]);

  const handleCheckDesktopUpdate = useCallback(async () => {
    if (!window.electronAPI?.updater?.check) return;
    setDesktopUpdateBusy(true);
    setDesktopUpdateError('');
    try {
      const status = await window.electronAPI.updater.check();
      setDesktopUpdateStatus(status);
      setDesktopUpdateError(status.errorMessage || '');
    } catch (err) {
      logger.error('Failed to check desktop update:', err);
      setDesktopUpdateError(err instanceof Error ? err.message : t('system.desktopUpdateCheckFailed'));
    } finally {
      setDesktopUpdateBusy(false);
    }
  }, [t]);

  const handleOpenDesktopUpdateDownload = useCallback(async (url?: string) => {
    if (!window.electronAPI?.updater?.openDownload) return;
    setDesktopUpdateBusy(true);
    setDesktopUpdateError('');
    try {
      await window.electronAPI.updater.openDownload(url);
    } catch (err) {
      logger.error('Failed to open desktop update download:', err);
      setDesktopUpdateError(err instanceof Error ? err.message : t('system.desktopUpdateOpenFailed'));
    } finally {
      setDesktopUpdateBusy(false);
    }
  }, [t]);

  const copyDesktopHttpsUrl = useCallback(async () => {
    const url = desktopHttpsStatus?.browserAccessUrl;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setDesktopHttpsUrlCopied(true);
      window.setTimeout(() => setDesktopHttpsUrlCopied(false), 1500);
    } catch (err) {
      logger.error('Failed to copy desktop HTTPS URL:', err);
    }
  }, [desktopHttpsStatus?.browserAccessUrl]);

  const handleGenerateSelfSignedCertificate = useCallback(async () => {
    if (!window.electronAPI?.https?.generateSelfSigned) return;
    setDesktopHttpsBusy(true);
    setError('');
    try {
      await window.electronAPI.https.generateSelfSigned();

      const parsedPort = Number.parseInt(desktopHttpsPort, 10);
      const status = await window.electronAPI.https.applySettings?.({
        enabled: true,
        mode: 'self-signed',
        httpsPort: Number.isFinite(parsedPort) ? parsedPort : 8443,
        redirectExternalHttp: desktopHttpsRedirectExternalHttp,
      });

      if (status) {
        applyDesktopHttpsSnapshot(status);
      } else {
        setDesktopHttpsEnabled(true);
        setDesktopHttpsMode('self-signed');
      }
    } catch (err) {
      logger.error('Failed to generate self-signed certificate:', err);
      setError(err instanceof Error ? err.message : t('system.saveFailed'));
    } finally {
      setDesktopHttpsBusy(false);
    }
  }, [applyDesktopHttpsSnapshot, desktopHttpsPort, desktopHttpsRedirectExternalHttp, t]);

  const handleImportDesktopCertificate = useCallback(async () => {
    if (!window.electronAPI?.fs?.selectFile || !window.electronAPI?.https?.importPemCertificate) return;
    setDesktopHttpsBusy(true);
    setError('');
    try {
      const certPath = await window.electronAPI.fs.selectFile({
        title: t('system.desktopHttpsSelectCertTitle'),
        filters: [{ name: 'PEM Certificate', extensions: ['pem', 'crt', 'cer'] }],
      });
      if (!certPath) return;

      const keyPath = await window.electronAPI.fs.selectFile({
        title: t('system.desktopHttpsSelectKeyTitle'),
        filters: [{ name: 'PEM Private Key', extensions: ['pem', 'key'] }],
      });
      if (!keyPath) return;

      await window.electronAPI.https.importPemCertificate(certPath, keyPath);

      const parsedPort = Number.parseInt(desktopHttpsPort, 10);
      const status = await window.electronAPI.https.applySettings?.({
        enabled: true,
        mode: 'imported-pem',
        httpsPort: Number.isFinite(parsedPort) ? parsedPort : 8443,
        redirectExternalHttp: desktopHttpsRedirectExternalHttp,
      });

      if (status) {
        applyDesktopHttpsSnapshot(status);
      } else {
        setDesktopHttpsMode('imported-pem');
        setDesktopHttpsEnabled(true);
      }
    } catch (err) {
      logger.error('Failed to import desktop HTTPS certificate:', err);
      setError(err instanceof Error ? err.message : t('system.saveFailed'));
    } finally {
      setDesktopHttpsBusy(false);
    }
  }, [applyDesktopHttpsSnapshot, desktopHttpsPort, desktopHttpsRedirectExternalHttp, t]);

  const applyRealtimeSettingsSnapshot = useCallback((
    data: RealtimeSettingsResponseData,
    options?: { preserveDraft?: boolean },
  ) => {
    const nextPublicUrl = data.publicWsUrl ?? '';
    const nextPolicy = data.transportPolicy ?? 'auto';
    const nextNetworkMode = data.networkMode ?? 'lan';
    const nextNodeIp = data.nodeIp ?? '';
    const preserveDraft = options?.preserveDraft === true;
    const hasLocalDraft = liveKitPublicUrl !== originalLiveKitPublicUrl
      || realtimeTransportPolicy !== originalRealtimeTransportPolicy
      || liveKitNetworkMode !== originalLiveKitNetworkMode
      || liveKitNodeIp !== originalLiveKitNodeIp;

    if (!preserveDraft || !hasLocalDraft) {
      setLiveKitPublicUrl(nextPublicUrl);
      setRealtimeTransportPolicy(nextPolicy);
      setLiveKitNetworkMode(nextNetworkMode);
      setLiveKitNodeIp(nextNodeIp);
    }

    setOriginalLiveKitPublicUrl(nextPublicUrl);
    setOriginalRealtimeTransportPolicy(nextPolicy);
    setOriginalLiveKitNetworkMode(nextNetworkMode);
    setOriginalLiveKitNodeIp(nextNodeIp);
    setRealtimeRuntime(data.runtime ?? null);
  }, [
    liveKitPublicUrl,
    originalLiveKitPublicUrl,
    realtimeTransportPolicy,
    originalRealtimeTransportPolicy,
    liveKitNetworkMode,
    originalLiveKitNetworkMode,
    liveKitNodeIp,
    originalLiveKitNodeIp,
  ]);

  const loadRealtimeSettings = useCallback(async () => {
    try {
      const result = await api.getRealtimeSettings();
      applyRealtimeSettingsSnapshot(result.data, { preserveDraft: true });
    } catch (err) {
      logger.error('Failed to load realtime settings:', err);
    }
  }, [applyRealtimeSettingsSnapshot]);

  useWSEvent(
    connection.state.radioService,
    'realtimeSettingsChanged',
    (data) => {
      logger.debug('Realtime settings changed via WebSocket', data);
      applyRealtimeSettingsSnapshot(data, { preserveDraft: true });
    },
    [applyRealtimeSettingsSnapshot],
  );

  useEffect(() => {
    const interval = window.setInterval(() => {
      void loadRealtimeSettings();
    }, 15000);

    return () => window.clearInterval(interval);
  }, [loadRealtimeSettings]);

  // 定期刷新 PSKReporter 状态
  useEffect(() => {
    if (!pskrConfig?.enabled) return;

    const interval = setInterval(loadPSKReporterStatus, 30000); // 每30秒刷新
    return () => clearInterval(interval);
  }, [pskrConfig?.enabled, loadPSKReporterStatus]);

  // 检查 PSKReporter 配置是否有变化
  const hasPskrChanges = () => {
    if (!pskrConfig || !originalPskrConfig) return false;
    return (
      pskrConfig.enabled !== originalPskrConfig.enabled ||
      pskrConfig.receiverCallsign !== originalPskrConfig.receiverCallsign ||
      pskrConfig.receiverLocator !== originalPskrConfig.receiverLocator ||
      pskrConfig.antennaInformation !== originalPskrConfig.antennaInformation ||
      pskrConfig.reportIntervalSeconds !== originalPskrConfig.reportIntervalSeconds ||
      pskrConfig.useTestServer !== originalPskrConfig.useTestServer
    );
  };

  // 检查认证配置是否有变化
  const hasAuthChanges = () => {
    if (!authConfig || !originalAuthConfig) return false;
    return authConfig.allowPublicViewing !== originalAuthConfig.allowPublicViewing;
  };

  // 检查解码窗口设置是否有变化
  const hasDecodeWindowChanges = () => {
    return (
      decodeWindowState.ft8Preset !== originalDecodeWindowState.ft8Preset ||
      decodeWindowState.ft4Preset !== originalDecodeWindowState.ft4Preset ||
      JSON.stringify(decodeWindowState.ft8CustomWindows) !== JSON.stringify(originalDecodeWindowState.ft8CustomWindows) ||
      JSON.stringify(decodeWindowState.ft4CustomWindows) !== JSON.stringify(originalDecodeWindowState.ft4CustomWindows)
    );
  };

  // 检查是否有未保存的更改
  const hasUnsavedChanges = () => {
    return (
      decodeWhileTransmitting !== originalDecodeValue ||
      spectrumWhileTransmitting !== originalSpectrumValue ||
      hasAuthChanges() ||
      hasPskrChanges() ||
      hasDecodeWindowChanges() ||
      liveKitPublicUrl !== originalLiveKitPublicUrl ||
      realtimeTransportPolicy !== originalRealtimeTransportPolicy ||
      liveKitNetworkMode !== originalLiveKitNetworkMode ||
      liveKitNodeIp !== originalLiveKitNodeIp ||
      (isElectron && closeBehavior !== originalCloseBehavior) ||
      (isElectron && (
        desktopHttpsEnabled !== originalDesktopHttpsEnabled ||
        desktopHttpsMode !== originalDesktopHttpsMode ||
        desktopHttpsPort !== originalDesktopHttpsPort ||
        desktopHttpsRedirectExternalHttp !== originalDesktopHttpsRedirectExternalHttp
      ))
    );
  };

  // 保存配置
  const handleSave = async () => {
    setIsSaving(true);
    setError('');
    try {
      // 保存 FT8 设置
      const result = await api.updateFT8Settings({
        decodeWhileTransmitting,
        spectrumWhileTransmitting,
      });

      if (result.success) {
        setOriginalDecodeValue(decodeWhileTransmitting);
        setOriginalSpectrumValue(spectrumWhileTransmitting);
      } else {
        throw new Error(result.message || t('system.saveFailed'));
      }

      // 保存认证配置
      if (authConfig && hasAuthChanges()) {
        const authResult = await api.updateAuthConfig({
          allowPublicViewing: authConfig.allowPublicViewing,
        });
        setAuthConfig(authResult);
        setOriginalAuthConfig(authResult);
      }

      // 保存 PSKReporter 设置
      if (pskrConfig && hasPskrChanges()) {
        const pskrResult = await api.updatePSKReporterConfig({
          enabled: pskrConfig.enabled,
          receiverCallsign: pskrConfig.receiverCallsign,
          receiverLocator: pskrConfig.receiverLocator,
          antennaInformation: pskrConfig.antennaInformation,
          reportIntervalSeconds: pskrConfig.reportIntervalSeconds,
          useTestServer: pskrConfig.useTestServer,
        });

        if (pskrResult.success && pskrResult.data) {
          setPskrConfig(pskrResult.data);
          setOriginalPskrConfig(pskrResult.data);
          // 刷新状态
          loadPSKReporterStatus();
        } else {
          throw new Error(pskrResult.message || t('system.pskrSaveFailed'));
        }
      }

      // 保存解码窗口设置
      if (hasDecodeWindowChanges()) {
        const dwSettings: Record<string, unknown> = {
          ft8: {
            preset: decodeWindowState.ft8Preset,
            ...(decodeWindowState.ft8Preset === 'custom' ? { customWindowTiming: decodeWindowState.ft8CustomWindows } : {}),
          },
          ft4: {
            preset: decodeWindowState.ft4Preset,
            ...(decodeWindowState.ft4Preset === 'custom' ? { customWindowTiming: decodeWindowState.ft4CustomWindows } : {}),
          },
        };
        await api.updateDecodeWindowSettings(dwSettings);
        setOriginalDecodeWindowState({ ...decodeWindowState });
      }

      if (
        liveKitPublicUrl !== originalLiveKitPublicUrl
        || realtimeTransportPolicy !== originalRealtimeTransportPolicy
        || liveKitNetworkMode !== originalLiveKitNetworkMode
        || liveKitNodeIp !== originalLiveKitNodeIp
      ) {
        const normalizedPublicUrl = liveKitPublicUrl.trim();
        const normalizedNodeIp = liveKitNodeIp.trim();
        const realtimeResult = await api.updateRealtimeSettings({
          publicWsUrl: normalizedPublicUrl || null,
          transportPolicy: realtimeTransportPolicy,
          networkMode: liveKitNetworkMode,
          nodeIp: normalizedNodeIp || null,
        });
        applyRealtimeSettingsSnapshot(realtimeResult.data);
      }

      // 保存 Electron 关闭行为设置
      if (isElectron && closeBehavior !== originalCloseBehavior) {
        await window.electronAPI?.config?.set('closeBehavior', closeBehavior);
        setOriginalCloseBehavior(closeBehavior);
      }

      if (isElectron && window.electronAPI?.https?.applySettings) {
        const hasDesktopHttpsChanges = (
          desktopHttpsEnabled !== originalDesktopHttpsEnabled ||
          desktopHttpsMode !== originalDesktopHttpsMode ||
          desktopHttpsPort !== originalDesktopHttpsPort ||
          desktopHttpsRedirectExternalHttp !== originalDesktopHttpsRedirectExternalHttp
        );

        if (hasDesktopHttpsChanges) {
          const parsedPort = Number.parseInt(desktopHttpsPort, 10);
          const status = await window.electronAPI.https.applySettings({
            enabled: desktopHttpsEnabled,
            mode: desktopHttpsMode,
            httpsPort: Number.isFinite(parsedPort) ? parsedPort : 8443,
            redirectExternalHttp: desktopHttpsRedirectExternalHttp,
          });
          applyDesktopHttpsSnapshot(status);
        }
      }

      onUnsavedChanges?.(false);
    } catch (err) {
      logger.error('Failed to save settings:', err);
      if (err instanceof ApiError) {
        setError(err.userMessage);
        showErrorToast({
          userMessage: err.userMessage,
          suggestions: err.suggestions,
          severity: err.severity,
          code: err.code
        });
      } else {
        setError(err instanceof Error ? err.message : t('system.saveFailed'));
      }
      throw err;
    } finally {
      setIsSaving(false);
    }
  };

  // 暴露方法给父组件
  useImperativeHandle(ref, () => ({
    hasUnsavedChanges,
    save: handleSave,
  }));

  // 监听设置变化
  useEffect(() => {
    const hasChanges = hasUnsavedChanges();
    onUnsavedChanges?.(hasChanges);
  }, [decodeWhileTransmitting, spectrumWhileTransmitting, originalDecodeValue, originalSpectrumValue, authConfig, originalAuthConfig, pskrConfig, originalPskrConfig, decodeWindowState, originalDecodeWindowState, liveKitPublicUrl, originalLiveKitPublicUrl, realtimeTransportPolicy, originalRealtimeTransportPolicy, liveKitNetworkMode, originalLiveKitNetworkMode, liveKitNodeIp, originalLiveKitNodeIp, closeBehavior, originalCloseBehavior, desktopHttpsEnabled, originalDesktopHttpsEnabled, desktopHttpsMode, originalDesktopHttpsMode, desktopHttpsPort, originalDesktopHttpsPort, desktopHttpsRedirectExternalHttp, originalDesktopHttpsRedirectExternalHttp, onUnsavedChanges]);

  const runtimeHints = realtimeRuntime?.connectivityHints ?? null;
  const runtimeIssueLabel = getRealtimeIssueLabel(realtimeRuntime?.radioBridgeIssueCode ?? null, t);
  const runtimeCredential = realtimeRuntime?.credentialStatus ?? null;
  const realtimeUrlOverrideActive = runtimeHints?.publicUrlOverrideActive ?? false;
  const liveKitApplyHint = isElectron
    ? t('system.liveKitNetworkModeApplyHintElectron')
    : t('system.liveKitNetworkModeApplyHintServer');
  const manualNodeIpVisible = liveKitNetworkMode === 'internet-manual';
  const desktopHttpsCertificateMeta = desktopHttpsStatus?.certificateMeta ?? null;
  const desktopHttpsBrowserUrl = desktopHttpsStatus?.browserAccessUrl ?? null;
  const desktopUpdateSourceLabel = desktopUpdateStatus?.metadataSource
    ? t(`system.desktopUpdateSourceValue.${desktopUpdateStatus.metadataSource}`)
    : t('system.desktopUpdateSourceValue.unknown');
  const desktopDownloadOptions = desktopUpdateStatus?.downloadOptions || [];

  // PSKReporter 配置更新辅助函数
  const updatePskrConfig = (updates: Partial<PSKReporterConfig>) => {
    if (pskrConfig) {
      setPskrConfig({ ...pskrConfig, ...updates });
    }
  };

  // 格式化时间显示
  const formatTime = (timestamp: number | undefined) => {
    if (!timestamp) return '-';
    return new Date(timestamp).toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  // 格式化下次上报时间
  const formatNextReport = (seconds: number | undefined) => {
    if (!seconds || seconds <= 0) return t('system.reportSoon');
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (mins > 0) {
      return t('system.reportInMins', { mins, secs });
    }
    return t('system.reportInSecs', { secs });
  };

  return (
    <div className="space-y-6">
      {/* 页面标题和描述 */}
      <div>
        <h3 className="text-xl font-bold text-default-900 mb-2">{t('system.title')}</h3>
        <p className="text-default-600">
          {t('system.description')}
        </p>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="p-3 bg-danger-50 border border-danger-200 rounded-lg">
          <p className="text-danger-700 text-sm">{error}</p>
        </div>
      )}

      {/* 公开查看权限 */}
      {authConfig && (
        <Card shadow="none" radius="lg" classNames={SETTINGS_CARD_CLASS_NAMES}>
          <CardBody className={SETTINGS_CARD_BODY_CLASS}>
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <h4 className={SETTINGS_CARD_TITLE_CLASS}>{t('system.allowPublicViewing')}</h4>
                <div className={`${SETTINGS_CARD_DESC_CLASS} mt-1 space-y-1`}>
                  <p>
                    <strong>{t('system.on')}</strong>：{t('system.allowPublicViewingOnDesc')}
                  </p>
                  <p>
                    <strong>{t('system.off')}</strong>：{t('system.allowPublicViewingOffDesc')}
                  </p>
                </div>
              </div>
              <Switch
                isSelected={authConfig.allowPublicViewing}
                onValueChange={(v) => setAuthConfig({ ...authConfig, allowPublicViewing: v })}
                isDisabled={isSaving}
                size="lg"
              />
            </div>
            {/* 网络访问地址 */}
            {networkInfo && networkInfo.addresses.length > 0 && (
              <div className="mt-3 pt-3 border-t border-divider">
                <p className={`${SETTINGS_MUTED_CLASS} mb-1.5`}>
                  {t('common:remoteAccess.networkAddress')}
                </p>
                {networkInfo.addresses.map((addr) => (
                  <div key={addr.ip} className="flex items-center gap-1.5 bg-default-100 rounded-md px-2 py-1 mb-1">
                    <code className="flex-1 text-xs text-default-500 truncate">{addr.url}</code>
                    <Button
                      size="sm"
                      variant="light"
                      isIconOnly
                      className="min-w-6 w-6 h-6"
                      onPress={async () => {
                        try {
                          await navigator.clipboard.writeText(addr.url);
                          setUrlCopied(true);
                          setTimeout(() => setUrlCopied(false), 2000);
                        } catch { /* ignore */ }
                      }}
                      title={t('common:remoteAccess.copyLink')}
                    >
                      <FontAwesomeIcon
                        icon={urlCopied ? faCheck : faCopy}
                        className={urlCopied ? 'text-success text-xs' : 'text-default-400 text-xs'}
                      />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardBody>
        </Card>
      )}

      {isElectron && (
        <Card shadow="none" radius="lg" classNames={SETTINGS_CARD_CLASS_NAMES}>
          <CardBody className={SETTINGS_CARD_BODY_CLASS}>
            <div>
              <h4 className={SETTINGS_CARD_TITLE_CLASS}>{t('system.desktopHttpsTitle')}</h4>
              <p className={`mt-1 ${SETTINGS_CARD_DESC_CLASS}`}>{t('system.desktopHttpsDesc')}</p>
            </div>

            <Alert color="primary" variant="flat" className="text-xs">
              {t('system.desktopHttpsPurpose')}
            </Alert>

            <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
              <div className={SETTINGS_PANEL_CLASS}>
                <p className={SETTINGS_MUTED_CLASS}>01</p>
                <p className={SETTINGS_SUBTITLE_CLASS}>{t('system.desktopHttpsScenarioDesktopTitle')}</p>
                <p className={`mt-1 ${SETTINGS_SUBDESC_CLASS}`}>{t('system.desktopHttpsScenarioDesktopDesc')}</p>
              </div>
              <div className="rounded-medium border border-primary/20 bg-primary-50/60 px-3 py-3 dark:bg-primary-500/10">
                <p className={SETTINGS_MUTED_CLASS}>02</p>
                <p className={SETTINGS_SUBTITLE_CLASS}>{t('system.desktopHttpsScenarioLanTitle')}</p>
                <p className={`mt-1 ${SETTINGS_SUBDESC_CLASS}`}>{t('system.desktopHttpsScenarioLanDesc')}</p>
              </div>
              <div className={SETTINGS_PANEL_CLASS}>
                <p className={SETTINGS_MUTED_CLASS}>03</p>
                <p className={SETTINGS_SUBTITLE_CLASS}>{t('system.desktopHttpsScenarioPublicTitle')}</p>
                <p className={`mt-1 ${SETTINGS_SUBDESC_CLASS}`}>{t('system.desktopHttpsScenarioPublicDesc')}</p>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
              <div className="space-y-4">
                <div className={`${SETTINGS_PANEL_CLASS} space-y-4`}>
                  <div className="flex flex-col gap-3 border-b border-divider pb-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="space-y-1">
                      <p className={SETTINGS_SUBTITLE_CLASS}>{t('system.desktopHttpsEnable')}</p>
                      <p className={SETTINGS_SUBDESC_CLASS}>{t('system.desktopHttpsEnableDesc')}</p>
                    </div>
                    <Switch
                      isSelected={desktopHttpsEnabled}
                      onValueChange={setDesktopHttpsEnabled}
                      isDisabled={isSaving || desktopHttpsBusy}
                    />
                  </div>

                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <Select
                      selectedKeys={[desktopHttpsMode]}
                      onSelectionChange={(keys) => {
                        const value = Array.from(keys)[0] as DesktopHttpsMode | undefined;
                        if (value) {
                          setDesktopHttpsMode(value);
                        }
                      }}
                      isDisabled={isSaving || desktopHttpsBusy}
                      size="sm"
                      variant="bordered"
                      label={t('system.desktopHttpsMode')}
                    >
                      <SelectItem key="self-signed">{t('system.desktopHttpsModeSelfSigned')}</SelectItem>
                      <SelectItem key="imported-pem">{t('system.desktopHttpsModeImported')}</SelectItem>
                    </Select>

                    <Input
                      label={t('system.desktopHttpsPort')}
                      value={desktopHttpsPort}
                      onValueChange={setDesktopHttpsPort}
                      isDisabled={isSaving || desktopHttpsBusy}
                      size="sm"
                      variant="bordered"
                      type="number"
                    />
                  </div>

                  <div className={`${SETTINGS_SOFT_PANEL_CLASS} space-y-3`}>
                    <div>
                      <p className={SETTINGS_SUBTITLE_CLASS}>
                        {desktopHttpsMode === 'self-signed'
                          ? t('system.desktopHttpsModeSelfSigned')
                          : t('system.desktopHttpsModeImported')}
                      </p>
                      <p className={`mt-1 ${SETTINGS_SUBDESC_CLASS}`}>
                        {desktopHttpsMode === 'self-signed'
                          ? t('system.desktopHttpsModeSelfSignedDesc')
                          : t('system.desktopHttpsModeImportedDesc')}
                      </p>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant={desktopHttpsMode === 'self-signed' ? 'solid' : 'flat'}
                        color="primary"
                        isLoading={desktopHttpsBusy}
                        isDisabled={isSaving || desktopHttpsBusy}
                        onPress={() => void handleGenerateSelfSignedCertificate()}
                      >
                        {t('system.desktopHttpsGenerate')}
                      </Button>
                      <Button
                        size="sm"
                        variant={desktopHttpsMode === 'imported-pem' ? 'solid' : 'flat'}
                        color="secondary"
                        isLoading={desktopHttpsBusy}
                        isDisabled={isSaving || desktopHttpsBusy}
                        onPress={() => void handleImportDesktopCertificate()}
                      >
                        {t('system.desktopHttpsImport')}
                      </Button>
                    </div>
                  </div>

                  <div className="border-t border-divider pt-4">
                    <Switch
                      isSelected={desktopHttpsRedirectExternalHttp}
                      onValueChange={setDesktopHttpsRedirectExternalHttp}
                      isDisabled={isSaving || desktopHttpsBusy}
                      size="sm"
                    >
                      {t('system.desktopHttpsRedirect')}
                    </Switch>
                  </div>
                </div>

                {desktopHttpsStatus?.usingSelfSigned && (
                  <Alert color="warning" variant="flat" className="text-xs">
                    {t('system.desktopHttpsSelfSignedLimitations')}
                  </Alert>
                )}

                {desktopHttpsMode === 'imported-pem' && (
                  <Alert color="secondary" variant="flat" className="text-xs">
                    {t('system.desktopHttpsImportedHint')}
                  </Alert>
                )}
              </div>

              <div className={`${SETTINGS_PANEL_CLASS} space-y-4`}>
                <div>
                  <p className={SETTINGS_SUBTITLE_CLASS}>{t('system.desktopHttpsStatusTitle')}</p>
                  <p className={`mt-1 ${SETTINGS_SUBDESC_CLASS}`}>{t('system.desktopHttpsStatusDesc')}</p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Chip size="sm" color={getDesktopHttpsStatusColor(desktopHttpsStatus?.certificateStatus)} variant="flat">
                    {t(`system.desktopHttpsCertificateStatusValue.${desktopHttpsStatus?.certificateStatus ?? 'missing'}`)}
                  </Chip>
                  {desktopHttpsStatus?.usingSelfSigned && (
                    <Chip size="sm" color="warning" variant="flat">
                      {t('system.desktopHttpsSelfSignedBadge')}
                    </Chip>
                  )}
                  <Chip size="sm" color={desktopHttpsStatus?.activeScheme === 'https' ? 'success' : 'default'} variant="flat">
                    {desktopHttpsStatus?.activeScheme?.toUpperCase() || 'HTTP'}
                  </Chip>
                </div>

                <div className="space-y-2">
                  <p className={SETTINGS_SUBDESC_CLASS}>{t('system.desktopHttpsAccessUrl')}</p>
                  <p className="break-all text-sm text-default-700">
                    {desktopHttpsBrowserUrl || t('system.desktopHttpsAccessUrlPending')}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {desktopHttpsStatus?.browserAccessUrl && (
                      <Button
                        size="sm"
                        variant="flat"
                        startContent={<FontAwesomeIcon icon={desktopHttpsUrlCopied ? faCheck : faCopy} />}
                        isDisabled={isSaving || desktopHttpsBusy}
                        onPress={() => void copyDesktopHttpsUrl()}
                      >
                        {desktopHttpsUrlCopied ? t('system.desktopHttpsCopied') : t('system.desktopHttpsCopyUrl')}
                      </Button>
                    )}
                  </div>
                </div>

                <div className={`space-y-2 ${SETTINGS_SUBDESC_CLASS}`}>
                  <p>{desktopHttpsCertificateMeta?.subject || t('system.desktopHttpsNoCertificate')}</p>
                  <p>{t('system.desktopHttpsValidTo', { value: formatDateTimeValue(desktopHttpsCertificateMeta?.validTo) })}</p>
                  <p>{desktopHttpsStatus?.shareUrls?.slice(1).join(' · ') || t('system.desktopHttpsLanHint')}</p>
                </div>
              </div>
            </div>
          </CardBody>
        </Card>
      )}

      <Card shadow="none" radius="lg" classNames={SETTINGS_CARD_CLASS_NAMES}>
        <CardBody className={SETTINGS_CARD_BODY_CLASS}>
          <div>
            <h4 className={SETTINGS_CARD_TITLE_CLASS}>{t('system.realtimeSettingsCardTitle')}</h4>
            <p className={`mt-1 ${SETTINGS_CARD_DESC_CLASS}`}>{t('system.realtimeSettingsCardDesc')}</p>
          </div>

          <Alert color="default" variant="flat" className="text-xs">
            {t('system.realtimeSettingsSimpleGuide')}
          </Alert>

          <Alert color="primary" variant="flat" className="text-xs">
            <p>{t('system.realtimeLiveKitBenefitsTitle')}</p>
            <p className="mt-1">{t('system.realtimeLiveKitBenefitsDesc')}</p>
          </Alert>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <div className={`${SETTINGS_PANEL_CLASS} space-y-3`}>
              <div>
                <p className={SETTINGS_MUTED_CLASS}>01</p>
                <h5 className={SETTINGS_SUBTITLE_CLASS}>{t('system.realtimeBrowserEntryTitle')}</h5>
                <p className={`mt-1 ${SETTINGS_SUBDESC_CLASS}`}>{t('system.realtimeBrowserEntryDesc')}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Chip
                  size="sm"
                  color={realtimeUrlOverrideActive ? 'warning' : 'success'}
                  variant="flat"
                >
                  {realtimeUrlOverrideActive
                    ? t('system.realtimeBrowserEntryOverrideBadge')
                    : t('system.realtimeBrowserEntryDefaultBadge')}
                </Chip>
                <Chip
                  size="sm"
                  color={(runtimeHints?.signalingUrl || '').startsWith('wss:') ? 'success' : 'default'}
                  variant="flat"
                >
                  {(runtimeHints?.signalingUrl || '').startsWith('wss:') ? 'WSS' : 'WS'}
                </Chip>
              </div>
              <div className="space-y-2">
                <p className={SETTINGS_SUBDESC_CLASS}>{t('system.realtimeBrowserEntryCurrentLabel')}</p>
                <code className="block break-all text-xs leading-5 text-default-600">
                  {runtimeHints?.signalingUrl || t('system.realtimeUrlPending')}
                </code>
              </div>
              <p className={SETTINGS_MUTED_CLASS}>
                {realtimeUrlOverrideActive
                  ? t('system.liveKitPublicUrlManualHint')
                  : t('system.liveKitPublicUrlAutoHint')}
              </p>
              {networkInfo && networkInfo.addresses.length > 0 && (
                <p className={SETTINGS_MUTED_CLASS}>
                  {t('system.liveKitPublicUrlExample', {
                    url: buildLiveKitExampleUrl(networkInfo.addresses[0].url),
                  })}
                </p>
              )}
            </div>

            <div className={`${SETTINGS_PANEL_CLASS} space-y-3`}>
              <div>
                <p className={SETTINGS_MUTED_CLASS}>02</p>
                <h5 className={SETTINGS_SUBTITLE_CLASS}>{t('system.realtimeTransportPolicy')}</h5>
                <p className={`mt-1 ${SETTINGS_SUBDESC_CLASS}`}>{t('system.realtimeTransportPolicyDesc')}</p>
              </div>
              <Select
                selectedKeys={[realtimeTransportPolicy]}
                onSelectionChange={(keys) => {
                  const value = Array.from(keys)[0] as RealtimeTransportPolicy | undefined;
                  if (value) {
                    setRealtimeTransportPolicy(value);
                  }
                }}
                isDisabled={isSaving}
                size="sm"
                variant="bordered"
              >
                <SelectItem key="auto">{t('system.realtimeTransportPolicyAuto')}</SelectItem>
                <SelectItem key="force-compat">{t('system.realtimeTransportPolicyCompat')}</SelectItem>
              </Select>
              <p className={SETTINGS_MUTED_CLASS}>
                {realtimeTransportPolicy === 'force-compat'
                  ? t('system.realtimeTransportPolicyCompatHint')
                  : t('system.realtimeTransportPolicyAutoHint')}
              </p>
            </div>

            <div className={`${SETTINGS_PANEL_CLASS} space-y-3`}>
              <div>
                <p className={SETTINGS_MUTED_CLASS}>03</p>
                <h5 className={SETTINGS_SUBTITLE_CLASS}>{t('system.liveKitNetworkModeTitle')}</h5>
                <p className={`mt-1 ${SETTINGS_SUBDESC_CLASS}`}>{t('system.liveKitNetworkModeDesc')}</p>
              </div>
              <Select
                selectedKeys={[liveKitNetworkMode]}
                onSelectionChange={(keys) => {
                  const value = Array.from(keys)[0] as LiveKitNetworkMode | undefined;
                  if (value) {
                    setLiveKitNetworkMode(value);
                  }
                }}
                isDisabled={isSaving}
                size="sm"
                variant="bordered"
              >
                <SelectItem key="lan">{t('system.liveKitNetworkModeLan')}</SelectItem>
                <SelectItem key="internet-auto">{t('system.liveKitNetworkModeInternetAuto')}</SelectItem>
                <SelectItem key="internet-manual">{t('system.liveKitNetworkModeInternetManual')}</SelectItem>
              </Select>
              <p className={SETTINGS_MUTED_CLASS}>
                {liveKitNetworkMode === 'internet-manual'
                  ? t('system.liveKitNetworkModeInternetManualHint')
                  : liveKitNetworkMode === 'internet-auto'
                    ? t('system.liveKitNetworkModeInternetAutoHint')
                    : t('system.liveKitNetworkModeLanHint')}
              </p>
            </div>

            <div className={`${SETTINGS_PANEL_CLASS} space-y-3`}>
              <div>
                <p className={SETTINGS_MUTED_CLASS}>04</p>
                <h5 className={SETTINGS_SUBTITLE_CLASS}>{t('system.liveKitNodeIpTitle')}</h5>
                <p className={`mt-1 ${SETTINGS_SUBDESC_CLASS}`}>{t('system.liveKitNodeIpDesc')}</p>
              </div>
              <Input
                value={liveKitNodeIp}
                onValueChange={setLiveKitNodeIp}
                placeholder={t('system.liveKitNodeIpPlaceholder')}
                isDisabled={isSaving || !manualNodeIpVisible}
                size="sm"
                variant="bordered"
              />
              <p className={SETTINGS_MUTED_CLASS}>
                {manualNodeIpVisible
                  ? t('system.liveKitNodeIpManualHint')
                  : t('system.liveKitNodeIpAutoHint')}
              </p>
            </div>
          </div>

          <Alert color="warning" variant="flat" className="text-xs">
            <p>{t('system.realtimeFrpHintTitle')}</p>
            <p className="mt-1">{t('system.realtimeFrpHintDesc')}</p>
          </Alert>

          <Alert color="default" variant="flat" className="text-xs">
            {liveKitApplyHint}
          </Alert>

          <details className="pt-3 border-t border-divider group">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 py-1">
              <div>
                <h5 className={SETTINGS_SUBTITLE_CLASS}>{t('system.realtimeAdminGuideTitle')}</h5>
                <p className={`mt-1 ${SETTINGS_SUBDESC_CLASS}`}>{t('system.realtimeAdminGuideDesc')}</p>
              </div>
              <Chip size="sm" color="default" variant="flat">{t('system.realtimeAdminOnly')}</Chip>
            </summary>

            <div className="mt-4 space-y-3">
              <div className={`${SETTINGS_PANEL_CLASS} space-y-3`}>
                <div>
                  <p className={SETTINGS_MUTED_CLASS}>{t('system.advanced')}</p>
                  <h6 className={SETTINGS_SUBTITLE_CLASS}>{t('system.liveKitPublicUrl')}</h6>
                  <p className={`mt-1 ${SETTINGS_SUBDESC_CLASS}`}>{t('system.liveKitPublicUrlDesc')}</p>
                </div>
                <Input
                  value={liveKitPublicUrl}
                  onValueChange={setLiveKitPublicUrl}
                  placeholder={t('system.liveKitPublicUrlPlaceholder')}
                  isDisabled={isSaving}
                  size="sm"
                  variant="bordered"
                />
                <p className={SETTINGS_MUTED_CLASS}>
                  {liveKitPublicUrl.trim()
                    ? t('system.liveKitPublicUrlManualHint')
                    : t('system.liveKitPublicUrlAutoHint')}
                </p>
                {isMacElectron && (
                  <Alert color="warning" variant="flat" className="text-xs">
                    <p>{t('system.liveKitMacInstallHint')}</p>
                    <p className="mt-1 font-mono">brew install livekit</p>
                    <p className="mt-1">{t('system.liveKitMacFallbackHint')}</p>
                  </Alert>
                )}
              </div>

              <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
                <div className={`${SETTINGS_PANEL_CLASS} py-2`}>
                  <p className={SETTINGS_SUBDESC_CLASS}>{t('system.realtimeCurrentPolicyLabel')}</p>
                  <div className="mt-2">
                    <Chip
                      size="sm"
                      color={realtimeTransportPolicy === 'force-compat' ? 'warning' : 'primary'}
                      variant="flat"
                    >
                      {realtimeTransportPolicy === 'force-compat'
                        ? t('system.realtimeTransportPolicyCompat')
                        : t('system.realtimeTransportPolicyAuto')}
                    </Chip>
                  </div>
                </div>

                <div className={`${SETTINGS_PANEL_CLASS} py-2`}>
                  <p className={SETTINGS_SUBDESC_CLASS}>{t('system.realtimeCurrentPathLabel')}</p>
                  <div className="mt-2">
                    <Chip
                      size="sm"
                      color={(realtimeRuntime?.radioReceiveTransport ?? 'ws-compat') === 'livekit' ? 'primary' : 'warning'}
                      variant="flat"
                    >
                      {getRealtimeTransportLabel(realtimeRuntime?.radioReceiveTransport ?? null, t)}
                    </Chip>
                  </div>
                  <p className={`mt-2 ${SETTINGS_MUTED_CLASS}`}>{t('system.realtimeCurrentPathHint')}</p>
                </div>

                <div className={`${SETTINGS_PANEL_CLASS} py-2`}>
                  <p className={SETTINGS_SUBDESC_CLASS}>{t('system.realtimeLiveKitServiceLabel')}</p>
                  <div className="mt-2">
                    <Chip
                      size="sm"
                      color={realtimeRuntime?.liveKitEnabled ? 'success' : 'warning'}
                      variant="flat"
                    >
                      {realtimeRuntime?.liveKitEnabled
                        ? t('system.realtimeStatusEnabled')
                        : t('system.realtimeStatusDisabled')}
                    </Chip>
                  </div>
                </div>

                <div className={`${SETTINGS_PANEL_CLASS} py-2`}>
                  <p className={SETTINGS_SUBDESC_CLASS}>{t('system.realtimeBridgeHealthLabel')}</p>
                  <div className="mt-2">
                    <Chip
                      size="sm"
                      color={realtimeRuntime?.radioBridgeHealthy === false ? 'danger' : 'success'}
                      variant="flat"
                    >
                      {realtimeRuntime?.radioBridgeHealthy === false
                        ? t('system.realtimeBridgeHealthUnhealthy')
                        : t('system.realtimeBridgeHealthHealthy')}
                    </Chip>
                  </div>
                  <p className={`mt-2 ${SETTINGS_MUTED_CLASS}`}>{runtimeIssueLabel}</p>
                </div>

                <div className={`${SETTINGS_PANEL_CLASS} py-2 md:col-span-2 xl:col-span-2`}>
                  <p className={SETTINGS_SUBDESC_CLASS}>{t('system.realtimeCredentialStatusLabel')}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Chip
                      size="sm"
                      color={runtimeCredential?.initialized ? 'success' : 'danger'}
                      variant="flat"
                    >
                      {runtimeCredential?.initialized
                        ? t('system.realtimeCredentialReady')
                        : t('system.realtimeCredentialMissing')}
                    </Chip>
                    <Chip
                      size="sm"
                      color={runtimeCredential?.source === 'environment-override' ? 'warning' : 'default'}
                      variant="flat"
                    >
                      {getRealtimeCredentialSourceLabel(runtimeCredential?.source ?? null, t)}
                    </Chip>
                  </div>
                  <p className={`mt-2 ${SETTINGS_MUTED_CLASS}`}>
                    {runtimeCredential?.apiKeyPreview
                      ? t('system.realtimeCredentialPreview', { value: runtimeCredential.apiKeyPreview })
                      : t('system.realtimeCredentialMissingHint')}
                  </p>
                  {runtimeCredential?.rotatedAt && (
                    <p className={`mt-1 ${SETTINGS_MUTED_CLASS}`}>
                      {t('system.realtimeCredentialRotatedAt', { value: runtimeCredential.rotatedAt })}
                    </p>
                  )}
                  {runtimeCredential?.filePath && (
                    <p className={`mt-1 break-all ${SETTINGS_MUTED_CLASS}`}>
                      {t('system.realtimeCredentialFile', { value: runtimeCredential.filePath })}
                    </p>
                  )}
                </div>
              </div>

              <div className={SETTINGS_PANEL_CLASS}>
                <h6 className={SETTINGS_SUBTITLE_CLASS}>{t('system.realtimePortRequirementsTitle')}</h6>
                <p className={`mt-1 ${SETTINGS_SUBDESC_CLASS}`}>{t('system.realtimePortRequirementsDesc')}</p>

                <div className="mt-3 grid grid-cols-1 gap-2 lg:grid-cols-2">
                  <div className={`flex items-center justify-between gap-3 ${SETTINGS_METRIC_CLASS}`}>
                    <span className="text-default-700">{t('system.realtimePortSignaling')}</span>
                    <code className={SETTINGS_SUBDESC_CLASS}>{runtimeHints?.signalingPort ?? 7880}</code>
                  </div>
                  <div className={`flex items-center justify-between gap-3 ${SETTINGS_METRIC_CLASS}`}>
                    <span className="text-default-700">{t('system.realtimePortIceTcp')}</span>
                    <code className={SETTINGS_SUBDESC_CLASS}>{runtimeHints?.rtcTcpPort ?? 7881}</code>
                  </div>
                  <div className={`flex items-center justify-between gap-3 ${SETTINGS_METRIC_CLASS}`}>
                    <span className="text-default-700">{t('system.realtimePortUdp')}</span>
                    <code className={SETTINGS_SUBDESC_CLASS}>{runtimeHints?.udpPortRange ?? '50000-50100'}</code>
                  </div>
                  <div className={`flex items-center justify-between gap-3 ${SETTINGS_METRIC_CLASS}`}>
                    <span className="text-default-700">{t('system.realtimePortCompat')}</span>
                    <code className={SETTINGS_SUBDESC_CLASS}>{t('system.realtimeCompatEndpointValue')}</code>
                  </div>
                  <div className={`${SETTINGS_METRIC_CLASS} lg:col-span-2`}>
                    <p className={SETTINGS_SUBDESC_CLASS}>{t('system.realtimeEffectiveUrlLabel')}</p>
                    <code className="mt-1 block break-all text-xs leading-5 text-default-600">
                      {runtimeHints?.signalingUrl || t('system.realtimeUrlPending')}
                    </code>
                  </div>
                </div>

                <div className={`mt-3 space-y-1 ${SETTINGS_SUBDESC_CLASS}`}>
                  <p>{t('system.realtimePortHintAuto')}</p>
                  <p>{t('system.realtimePortHintCompat')}</p>
                  <p>{t('system.realtimePortHintFallback')}</p>
                  <p>{t('system.realtimeCredentialLinuxHint')}</p>
                </div>
              </div>
            </div>
          </details>
        </CardBody>
      </Card>

      <Divider className="my-4" />

      {/* 发射时解码设置 */}
      <Card shadow="none" radius="lg" classNames={SETTINGS_CARD_CLASS_NAMES}>
        <CardBody className={SETTINGS_CARD_BODY_CLASS}>
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1">
              <h4 className={SETTINGS_CARD_TITLE_CLASS}>{t('system.decodeWhileTransmitting')}</h4>
              <div className={`${SETTINGS_CARD_DESC_CLASS} mt-1 space-y-1`}>
                <p>
                  <strong>{t('system.off')}（{t('system.recommended')}）</strong>：{t('system.decodeWhileTransmittingOffDesc')}
                </p>
                <p>
                  <strong>{t('system.on')}（{t('system.advanced')}）</strong>：{t('system.decodeWhileTransmittingOnDesc')}
                </p>
              </div>
            </div>
            <Switch
              isSelected={decodeWhileTransmitting}
              onValueChange={setDecodeWhileTransmitting}
              isDisabled={isSaving}
              size="lg"
              color={decodeWhileTransmitting ? 'warning' : 'success'}
            />
          </div>
        </CardBody>
      </Card>

      {/* 发射时频谱分析设置 */}
      <Card shadow="none" radius="lg" classNames={SETTINGS_CARD_CLASS_NAMES}>
        <CardBody className={SETTINGS_CARD_BODY_CLASS}>
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1">
              <h4 className={SETTINGS_CARD_TITLE_CLASS}>{t('system.spectrumWhileTransmitting')}</h4>
              <div className={`${SETTINGS_CARD_DESC_CLASS} mt-1 space-y-1`}>
                <p>
                  <strong>{t('system.on')}（{t('system.recommended')}）</strong>：{t('system.spectrumWhileTransmittingOnDesc')}
                </p>
                <p>
                  <strong>{t('system.off')}</strong>：{t('system.spectrumWhileTransmittingOffDesc')}
                </p>
              </div>
            </div>
            <Switch
              isSelected={spectrumWhileTransmitting}
              onValueChange={setSpectrumWhileTransmitting}
              isDisabled={isSaving}
              size="lg"
              color={spectrumWhileTransmitting ? 'success' : 'warning'}
            />
          </div>
        </CardBody>
      </Card>

      {/* 解码窗口设置 */}
      <Divider className="my-4" />

      <Card shadow="none" radius="lg" classNames={SETTINGS_CARD_CLASS_NAMES}>
        <CardBody className={SETTINGS_CARD_BODY_CLASS}>
          <div>
            <h4 className={SETTINGS_CARD_TITLE_CLASS}>{t('system.decodeWindowTitle')}</h4>
            <p className={`mt-1 ${SETTINGS_CARD_DESC_CLASS}`}>{t('system.decodeWindowDesc')}</p>
          </div>

          {/* FT8 解码策略 */}
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <Select
                label={t('system.ft8DecodeWindow')}
                selectedKeys={[decodeWindowState.ft8Preset]}
                onSelectionChange={(keys) => {
                  const value = Array.from(keys)[0] as string;
                  if (value) {
                    setDecodeWindowState(prev => ({
                      ...prev,
                      ft8Preset: value,
                      ft8CustomWindows: value === 'custom'
                        ? prev.ft8CustomWindows
                        : FT8_WINDOW_PRESETS[value] ?? prev.ft8CustomWindows,
                    }));
                  }
                }}
                isDisabled={isSaving}
                variant="bordered"
                className="flex-1"
              >
                <SelectItem key="maximum" textValue={t('system.presetMaximum')}>{t('system.presetMaximum')}</SelectItem>
                <SelectItem key="balanced" textValue={`${t('system.presetBalanced')}${t('system.presetDefault')}`}>{t('system.presetBalanced')}{t('system.presetDefault')}</SelectItem>
                <SelectItem key="lightweight" textValue={t('system.presetLightweight')}>{t('system.presetLightweight')}</SelectItem>
                <SelectItem key="minimum" textValue={t('system.presetMinimum')}>{t('system.presetMinimum')}</SelectItem>
                <SelectItem key="custom" textValue={t('system.presetCustom')}>{t('system.presetCustom')}</SelectItem>
              </Select>
            </div>
            {(() => {
              const count = getWindowCount(decodeWindowState.ft8Preset, decodeWindowState.ft8CustomWindows, FT8_WINDOW_PRESETS);
              const cpuInfo = getCpuLoadInfo(count, t);
              return (
                <div className="flex items-center gap-2 text-sm text-default-500">
                  <span>{t('system.decodesPerSlot', { count })}</span>
                  <Chip size="sm" color={cpuInfo.color} variant="flat">{cpuInfo.label}</Chip>
                </div>
              );
            })()}
          </div>

          {/* FT4 解码策略 */}
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <Select
                label={t('system.ft4DecodeWindow')}
                selectedKeys={[decodeWindowState.ft4Preset]}
                onSelectionChange={(keys) => {
                  const value = Array.from(keys)[0] as string;
                  if (value) {
                    setDecodeWindowState(prev => ({
                      ...prev,
                      ft4Preset: value,
                      ft4CustomWindows: value === 'custom'
                        ? prev.ft4CustomWindows
                        : FT4_WINDOW_PRESETS[value] ?? prev.ft4CustomWindows,
                    }));
                  }
                }}
                isDisabled={isSaving}
                variant="bordered"
                className="flex-1"
              >
                <SelectItem key="maximum" textValue={t('system.presetMaximum')}>{t('system.presetMaximum')}</SelectItem>
                <SelectItem key="balanced" textValue={`${t('system.presetBalanced')}${t('system.presetDefault')}`}>{t('system.presetBalanced')}{t('system.presetDefault')}</SelectItem>
                <SelectItem key="custom" textValue={t('system.presetCustom')}>{t('system.presetCustom')}</SelectItem>
              </Select>
            </div>
            {(() => {
              const count = getWindowCount(decodeWindowState.ft4Preset, decodeWindowState.ft4CustomWindows, FT4_WINDOW_PRESETS);
              const cpuInfo = getCpuLoadInfo(count, t);
              return (
                <div className="flex items-center gap-2 text-sm text-default-500">
                  <span>{t('system.decodesPerSlot', { count })}</span>
                  <Chip size="sm" color={cpuInfo.color} variant="flat">{cpuInfo.label}</Chip>
                </div>
              );
            })()}
          </div>

          {/* FT8 自定义编辑区 */}
          {decodeWindowState.ft8Preset === 'custom' && (
            <div className={`${SETTINGS_PANEL_CLASS} space-y-2`}>
              <p className={SETTINGS_SUBTITLE_CLASS}>FT8 {t('system.presetCustom')}</p>
              {decodeWindowState.ft8CustomWindows.map((offset, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <Input
                    label={t('system.windowOffset', { idx: idx + 1 })}
                    type="number"
                    value={String(offset)}
                    onValueChange={(v) => {
                      const val = parseInt(v) || 0;
                      setDecodeWindowState(prev => {
                        const windows = [...prev.ft8CustomWindows];
                        windows[idx] = Math.max(-2000, Math.min(1000, val));
                        return { ...prev, ft8CustomWindows: windows };
                      });
                    }}
                    isDisabled={isSaving}
                    size="sm"
                    variant="bordered"
                    className="flex-1"
                    endContent={<span className="text-xs text-default-400">{t('system.offsetUnit')}</span>}
                  />
                  <Button
                    size="sm"
                    variant="light"
                    color="danger"
                    isIconOnly
                    isDisabled={isSaving || decodeWindowState.ft8CustomWindows.length <= 1}
                    onPress={() => {
                      setDecodeWindowState(prev => ({
                        ...prev,
                        ft8CustomWindows: prev.ft8CustomWindows.filter((_, i) => i !== idx),
                      }));
                    }}
                    title={t('system.removeWindow')}
                  >
                    ×
                  </Button>
                </div>
              ))}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="flat"
                  isDisabled={isSaving || decodeWindowState.ft8CustomWindows.length >= 8}
                  onPress={() => {
                    setDecodeWindowState(prev => ({
                      ...prev,
                      ft8CustomWindows: [...prev.ft8CustomWindows, 0],
                    }));
                  }}
                >
                  {t('system.addWindow')}
                </Button>
                <Button
                  size="sm"
                  variant="flat"
                  isDisabled={isSaving}
                  onPress={() => {
                    setDecodeWindowState(prev => ({
                      ...prev,
                      ft8CustomWindows: [...FT8_WINDOW_PRESETS['balanced']],
                    }));
                  }}
                >
                  {t('system.resetDefault')}
                </Button>
              </div>
              {decodeWindowState.ft8CustomWindows.length >= 8 && (
                <p className="text-xs text-warning-600">{t('system.windowLimitReached', { max: 8 })}</p>
              )}
            </div>
          )}

          {/* FT4 自定义编辑区 */}
          {decodeWindowState.ft4Preset === 'custom' && (
            <div className={`${SETTINGS_PANEL_CLASS} space-y-2`}>
              <p className={SETTINGS_SUBTITLE_CLASS}>FT4 {t('system.presetCustom')}</p>
              {decodeWindowState.ft4CustomWindows.map((offset, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <Input
                    label={t('system.windowOffset', { idx: idx + 1 })}
                    type="number"
                    value={String(offset)}
                    onValueChange={(v) => {
                      const val = parseInt(v) || 0;
                      setDecodeWindowState(prev => {
                        const windows = [...prev.ft4CustomWindows];
                        windows[idx] = Math.max(-2000, Math.min(1000, val));
                        return { ...prev, ft4CustomWindows: windows };
                      });
                    }}
                    isDisabled={isSaving}
                    size="sm"
                    variant="bordered"
                    className="flex-1"
                    endContent={<span className="text-xs text-default-400">{t('system.offsetUnit')}</span>}
                  />
                  <Button
                    size="sm"
                    variant="light"
                    color="danger"
                    isIconOnly
                    isDisabled={isSaving || decodeWindowState.ft4CustomWindows.length <= 1}
                    onPress={() => {
                      setDecodeWindowState(prev => ({
                        ...prev,
                        ft4CustomWindows: prev.ft4CustomWindows.filter((_, i) => i !== idx),
                      }));
                    }}
                    title={t('system.removeWindow')}
                  >
                    ×
                  </Button>
                </div>
              ))}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="flat"
                  isDisabled={isSaving || decodeWindowState.ft4CustomWindows.length >= 8}
                  onPress={() => {
                    setDecodeWindowState(prev => ({
                      ...prev,
                      ft4CustomWindows: [...prev.ft4CustomWindows, 0],
                    }));
                  }}
                >
                  {t('system.addWindow')}
                </Button>
                <Button
                  size="sm"
                  variant="flat"
                  isDisabled={isSaving}
                  onPress={() => {
                    setDecodeWindowState(prev => ({
                      ...prev,
                      ft4CustomWindows: [...FT4_WINDOW_PRESETS['balanced']],
                    }));
                  }}
                >
                  {t('system.resetDefault')}
                </Button>
              </div>
              {decodeWindowState.ft4CustomWindows.length >= 8 && (
                <p className="text-xs text-warning-600">{t('system.windowLimitReached', { max: 8 })}</p>
              )}
            </div>
          )}
        </CardBody>
      </Card>

      {/* PSKReporter 设置分隔 */}
      <Divider className="my-4" />

      <Card shadow="none" radius="lg" classNames={SETTINGS_CARD_CLASS_NAMES}>
        <CardBody className={SETTINGS_CARD_BODY_CLASS}>
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h4 className={SETTINGS_CARD_TITLE_CLASS}>{t('system.pskrTitle')}</h4>
                {pskrConfig?.enabled && pskrStatus && (
                  <div className="flex flex-wrap gap-1">
                    {pskrStatus.configValid ? (
                      <Chip size="sm" color="success" variant="flat">{t('system.configValid')}</Chip>
                    ) : (
                      <Chip size="sm" color="warning" variant="flat">{t('system.configIncomplete')}</Chip>
                    )}
                    {pskrStatus.pendingSpots > 0 && (
                      <Chip size="sm" color="primary" variant="flat">
                        {t('system.pendingSpots', { count: pskrStatus.pendingSpots })}
                      </Chip>
                    )}
                  </div>
                )}
              </div>
              <div className={SETTINGS_CARD_DESC_CLASS}>
                <p>
                  {t('system.pskrDesc')}{' '}
                  <a href="https://pskreporter.info" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                    PSKReporter
                  </a>
                </p>
                {pskrConfig?.enabled && pskrStatus?.activeCallsign && (
                  <p className={`mt-1 ${SETTINGS_SUBDESC_CLASS}`}>
                    {t('system.pskrActiveInfo', {
                      callsign: pskrStatus.activeCallsign,
                      locator: pskrStatus.activeLocator || t('system.gridNotSet'),
                    })}
                  </p>
                )}
              </div>
            </div>
            <Switch
              isSelected={pskrConfig?.enabled ?? false}
              onValueChange={(enabled) => updatePskrConfig({ enabled })}
              isDisabled={isSaving || !pskrConfig}
              size="lg"
              color={pskrConfig?.enabled ? 'success' : 'default'}
            />
          </div>

          {pskrConfig?.enabled && (
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
              <div className={`${SETTINGS_PANEL_CLASS} space-y-4`}>
                <div>
                  <p className={SETTINGS_MUTED_CLASS}>01</p>
                  <h5 className={SETTINGS_SUBTITLE_CLASS}>{t('system.receiverInfo')}</h5>
                  <p className={`mt-1 ${SETTINGS_SUBDESC_CLASS}`}>{t('system.receiverInfoDesc')}</p>
                </div>

                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <Input
                    label={t('system.rxCallsign')}
                    placeholder={t('system.rxCallsignPlaceholder')}
                    value={pskrConfig.receiverCallsign}
                    onValueChange={(v) => updatePskrConfig({ receiverCallsign: v.toUpperCase() })}
                    isDisabled={isSaving}
                    size="sm"
                    variant="bordered"
                    description={pskrStatus?.activeCallsign && !pskrConfig.receiverCallsign
                      ? t('system.willUse', { val: pskrStatus.activeCallsign })
                      : undefined}
                  />
                  <Input
                    label={t('system.rxLocator')}
                    placeholder={t('system.rxLocatorPlaceholder')}
                    value={pskrConfig.receiverLocator}
                    onValueChange={(v) => updatePskrConfig({ receiverLocator: v.toUpperCase() })}
                    isDisabled={isSaving}
                    size="sm"
                    variant="bordered"
                    description={pskrStatus?.activeLocator && !pskrConfig.receiverLocator
                      ? t('system.willUse', { val: pskrStatus.activeLocator })
                      : undefined}
                  />
                </div>
              </div>

              <div className={`${SETTINGS_PANEL_CLASS} space-y-4`}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className={SETTINGS_MUTED_CLASS}>03</p>
                    <h5 className={SETTINGS_SUBTITLE_CLASS}>{t('system.runningStatus')}</h5>
                  </div>
                  <Chip
                    size="sm"
                    color={pskrStatus?.isReporting ? 'primary' : 'default'}
                    variant="flat"
                  >
                    {pskrStatus?.isReporting ? t('system.reporting') : t('system.waiting')}
                  </Chip>
                </div>

                <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                  <div className={SETTINGS_METRIC_CLASS}>
                    <p className={SETTINGS_SUBDESC_CLASS}>{t('system.todayCount')}</p>
                    <p className="mt-1 text-sm font-semibold text-default-900">
                      {pskrConfig.stats?.todayReportCount ?? 0}
                    </p>
                  </div>
                  <div className={SETTINGS_METRIC_CLASS}>
                    <p className={SETTINGS_SUBDESC_CLASS}>{t('system.totalCount')}</p>
                    <p className="mt-1 text-sm font-semibold text-default-900">
                      {pskrConfig.stats?.totalReportCount ?? 0}
                    </p>
                  </div>
                  <div className={SETTINGS_METRIC_CLASS}>
                    <p className={SETTINGS_SUBDESC_CLASS}>{t('system.lastReport')}</p>
                    <p className="mt-1 text-sm font-semibold text-default-900">
                      {formatTime(pskrStatus?.lastReportTime)}
                    </p>
                  </div>
                  <div className={SETTINGS_METRIC_CLASS}>
                    <p className={SETTINGS_SUBDESC_CLASS}>{t('system.nextReport')}</p>
                    <p className="mt-1 text-sm font-semibold text-default-900">
                      {formatNextReport(pskrStatus?.nextReportIn)}
                    </p>
                  </div>
                </div>

                {pskrStatus?.lastError && (
                  <div className="rounded-medium border border-danger-200 bg-danger-50 px-3 py-2">
                    <p className="text-sm text-danger-700">{pskrStatus.lastError}</p>
                  </div>
                )}
              </div>

              <div className={`${SETTINGS_PANEL_CLASS} space-y-4 xl:col-span-2`}>
                <div>
                  <p className={SETTINGS_MUTED_CLASS}>02</p>
                  <h5 className={SETTINGS_SUBTITLE_CLASS}>{t('system.optionalConfig')}</h5>
                </div>

                <Input
                  label={t('system.antennaInfo')}
                  placeholder={t('system.antennaInfoPlaceholder')}
                  value={pskrConfig.antennaInformation}
                  onValueChange={(v) => updatePskrConfig({ antennaInformation: v })}
                  isDisabled={isSaving}
                  size="sm"
                  variant="bordered"
                  maxLength={64}
                />

                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <Select
                    label={t('system.reportInterval')}
                    selectedKeys={[String(pskrConfig.reportIntervalSeconds)]}
                    onSelectionChange={(keys) => {
                      const value = Array.from(keys)[0] as string;
                      if (value) {
                        updatePskrConfig({ reportIntervalSeconds: parseInt(value) });
                      }
                    }}
                    isDisabled={isSaving}
                    size="sm"
                    variant="bordered"
                  >
                    {REPORT_INTERVAL_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value}>{opt.label}</SelectItem>
                    ))}
                  </Select>

                  <div className={`${SETTINGS_SOFT_PANEL_CLASS} flex items-center justify-between gap-3`}>
                    <div>
                      <p className={SETTINGS_SUBTITLE_CLASS}>{t('system.testServer')}</p>
                      <p className={`mt-1 ${SETTINGS_SUBDESC_CLASS}`}>{t('system.testServerDesc')}</p>
                    </div>
                    <Switch
                      isSelected={pskrConfig.useTestServer}
                      onValueChange={(v) => updatePskrConfig({ useTestServer: v })}
                      isDisabled={isSaving}
                      size="sm"
                      color="warning"
                    />
                  </div>
                </div>
              </div>
            </div>
          )}
        </CardBody>
      </Card>

      {/* 桌面应用设置 - 仅 Electron 环境显示 */}
      {isElectron && (
        <>
          <Divider className="my-4" />
          <Card shadow="none" radius="lg" classNames={SETTINGS_CARD_CLASS_NAMES}>
            <CardBody className={`${SETTINGS_CARD_BODY_CLASS} space-y-3`}>
              <div>
                <h4 className={SETTINGS_CARD_TITLE_CLASS}>{t('system.closeBehavior')}</h4>
                <p className={`mt-1 ${SETTINGS_CARD_DESC_CLASS}`}>{t('system.closeBehaviorDesc')}</p>
              </div>
              <Select
                selectedKeys={[closeBehavior]}
                onSelectionChange={(keys) => {
                  const value = Array.from(keys)[0] as string;
                  if (value) setCloseBehavior(value);
                }}
                isDisabled={isSaving}
                variant="bordered"
                className="max-w-xs"
              >
                <SelectItem key="ask">{t('system.closeBehaviorAsk')}</SelectItem>
                <SelectItem key="tray">{t('system.closeBehaviorTray')}</SelectItem>
                <SelectItem key="quit">{t('system.closeBehaviorQuit')}</SelectItem>
              </Select>
            </CardBody>
          </Card>

          <Card shadow="none" radius="lg" classNames={SETTINGS_CARD_CLASS_NAMES}>
            <CardBody className={`${SETTINGS_CARD_BODY_CLASS} space-y-4`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h4 className={SETTINGS_CARD_TITLE_CLASS}>{t('system.desktopUpdateTitle')}</h4>
                  <p className={`mt-1 ${SETTINGS_CARD_DESC_CLASS}`}>{t('system.desktopUpdateDesc')}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Chip size="sm" color="default" variant="flat">
                    {desktopUpdateStatus?.channel === 'nightly'
                      ? t('system.desktopUpdateChannelNightly')
                      : t('system.desktopUpdateChannelRelease')}
                  </Chip>
                  <Chip size="sm" color={getDesktopUpdateSourceColor(desktopUpdateStatus?.metadataSource ?? null)} variant="flat">
                    {t('system.desktopUpdateSource')}: {desktopUpdateSourceLabel}
                  </Chip>
                </div>
              </div>

              {desktopUpdateError && (
                <Alert color="danger" variant="flat" title={desktopUpdateError} />
              )}

              <div className="grid gap-3 md:grid-cols-2">
                <div className={SETTINGS_SOFT_PANEL_CLASS}>
                  <p className={SETTINGS_SUBTITLE_CLASS}>{t('system.desktopUpdateCurrentVersion')}</p>
                  <p className={`mt-1 ${SETTINGS_CARD_DESC_CLASS}`}>{desktopUpdateStatus?.currentVersion || '-'}</p>
                  <p className={`mt-2 ${SETTINGS_MUTED_CLASS}`}>
                    {t('system.desktopUpdateCurrentCommit', { value: desktopUpdateStatus?.currentCommit || '-' })}
                  </p>
                </div>

                <div className={SETTINGS_SOFT_PANEL_CLASS}>
                  <p className={SETTINGS_SUBTITLE_CLASS}>{t('system.desktopUpdateLatestVersion')}</p>
                  <p className={`mt-1 ${SETTINGS_CARD_DESC_CLASS}`}>{desktopUpdateStatus?.latestVersion || '-'}</p>
                  <p className={`mt-2 ${SETTINGS_MUTED_CLASS}`}>
                    {t('system.desktopUpdatePublishedAt', { value: formatDateTimeValue(desktopUpdateStatus?.publishedAt) })}
                  </p>
                </div>
              </div>

              <div className={`${SETTINGS_SOFT_PANEL_CLASS} space-y-2`}>
                <div className="flex flex-wrap items-center gap-2">
                  <Chip
                    size="sm"
                    color={desktopUpdateStatus?.updateAvailable ? 'warning' : 'success'}
                    variant="flat"
                  >
                    {desktopUpdateStatus?.updateAvailable
                      ? t('system.desktopUpdateAvailable')
                      : t('system.desktopUpdateUpToDate')}
                  </Chip>
                  {desktopUpdateStatus?.latestCommit && (
                    <Chip size="sm" color="default" variant="flat">
                      {t('system.desktopUpdateLatestCommit', { value: desktopUpdateStatus.latestCommit })}
                    </Chip>
                  )}
                </div>

                <p className={`${SETTINGS_SUBDESC_CLASS} whitespace-pre-wrap`}>
                  {desktopUpdateStatus?.releaseNotes || t('system.desktopUpdateNoNotes')}
                </p>
              </div>

              {desktopDownloadOptions.length > 0 && (
                <div className={`${SETTINGS_SOFT_PANEL_CLASS} space-y-3`}>
                  <div>
                    <p className={SETTINGS_SUBTITLE_CLASS}>{t('system.desktopUpdateDownloadOptionsTitle')}</p>
                    <p className={`mt-1 ${SETTINGS_SUBDESC_CLASS}`}>{t('system.desktopUpdateDownloadOptionsDesc')}</p>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    {desktopDownloadOptions.map((option) => (
                      <div key={option.url} className="rounded-medium border border-divider bg-content1 px-3 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className={SETTINGS_SUBTITLE_CLASS}>{getDesktopUpdateOptionLabel(option.packageType, t)}</p>
                          {option.recommended && (
                            <Chip size="sm" color="primary" variant="flat">
                              {t('system.recommended')}
                            </Chip>
                          )}
                        </div>
                        <p className={`mt-1 break-all ${SETTINGS_MUTED_CLASS}`}>{option.name}</p>
                        <div className="mt-3">
                          <Button
                            size="sm"
                            color={option.recommended ? 'primary' : 'default'}
                            variant={option.recommended ? 'solid' : 'flat'}
                            onPress={() => { void handleOpenDesktopUpdateDownload(option.url); }}
                            isDisabled={!desktopUpdateStatus?.updateAvailable || isSaving || desktopUpdateBusy}
                          >
                            {t('system.desktopUpdateDownload')}
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex flex-wrap gap-3">
                <Button
                  color="primary"
                  variant="flat"
                  onPress={() => { void handleCheckDesktopUpdate(); }}
                  isLoading={desktopUpdateBusy || desktopUpdateStatus?.checking}
                  isDisabled={isSaving || desktopHttpsBusy}
                >
                  {t('system.desktopUpdateCheck')}
                </Button>

                {desktopDownloadOptions.length === 0 && (
                  <Button
                    color="primary"
                    onPress={() => { void handleOpenDesktopUpdateDownload(); }}
                    isDisabled={!desktopUpdateStatus?.downloadUrl || !desktopUpdateStatus?.updateAvailable || isSaving || desktopUpdateBusy}
                  >
                    {t('system.desktopUpdateDownload')}
                  </Button>
                )}
              </div>
            </CardBody>
          </Card>
        </>
      )}

      {/* 提示信息 */}
      {hasUnsavedChanges() && (
        <div className="text-sm text-default-500">
          {t('unsavedChanges')}
        </div>
      )}
    </div>
  );
});

SystemSettings.displayName = 'SystemSettings';
