import React, { useState, useEffect, forwardRef, useImperativeHandle, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  Alert,
  Button,
  Card,
  CardBody,
  Input,
  Select,
  SelectItem,
  Switch,
  Chip,
} from '@heroui/react';
import { addToast } from '@heroui/toast';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCheck, faCopy, faDownload, faGripVertical, faPlus, faTrash } from '@fortawesome/free-solid-svg-icons';
import { Reorder, useDragControls } from 'framer-motion';
import { api, ApiError } from '@tx5dr/core';
import type {
  DecodeWindowSettings,
  PSKReporterConfig,
  PSKReporterStatus,
  AuthStatus,
  NetworkInfo,
  RealtimeSettingsResponseData,
  RealtimeTransportPolicy,
  DesktopHttpsStatus,
  DesktopHttpsMode,
  ServerCpuProfileStatus,
} from '@tx5dr/contracts';
import { DEFAULT_DECODE_WINDOW_SETTINGS, FT8_WINDOW_PRESETS, FT4_WINDOW_PRESETS, isValidNtpServerHost } from '@tx5dr/contracts';
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
  latestCommitTitle: string | null;
  recentCommits: Array<{
    id: string;
    shortId: string;
    title: string;
    publishedAt: string | null;
  }>;
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
const DESKTOP_UPDATE_COMMITS_URL = 'https://github.com/boybook/tx-5dr/commits/main';

interface NtpServerDraftItem {
  id: string;
  value: string;
}

function createNtpServerDraftItem(value = ''): NtpServerDraftItem {
  return {
    id: `ntp-server-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    value,
  };
}

function toNtpServerDraftItems(servers: string[]): NtpServerDraftItem[] {
  return servers.map((server) => createNtpServerDraftItem(server));
}

function getNtpServerValues(items: NtpServerDraftItem[]): string[] {
  return items.map((item) => item.value.trim());
}

function areStringArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

interface NtpServerReorderItemProps {
  item: NtpServerDraftItem;
  total: number;
  isSaving: boolean;
  onValueChange: (id: string, value: string) => void;
  onRemove: (id: string) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}

function NtpServerReorderItem({
  item,
  total,
  isSaving,
  onValueChange,
  onRemove,
  t,
}: NtpServerReorderItemProps) {
  const dragControls = useDragControls();
  const trimmedValue = item.value.trim();
  const isInvalid = trimmedValue.length > 0 && !isValidNtpServerHost(trimmedValue);

  return (
    <Reorder.Item
      value={item}
      as="div"
      dragListener={false}
      dragControls={dragControls}
      className="flex w-full items-start gap-2"
    >
      <button
        type="button"
        className="flex h-8 w-4 shrink-0 items-center justify-center cursor-grab text-default-300 transition-colors hover:text-default-500 active:cursor-grabbing"
        onPointerDown={(event) => dragControls.start(event)}
        aria-label={t('system.ntpDragHandle')}
      >
        <FontAwesomeIcon icon={faGripVertical} className="text-xs leading-none" />
      </button>
      <Input
        size="sm"
        placeholder={t('system.ntpServerPlaceholder')}
        value={item.value}
        onValueChange={(value) => onValueChange(item.id, value)}
        isDisabled={isSaving}
        isInvalid={isInvalid}
        errorMessage={isInvalid ? t('system.ntpServerInvalid') : undefined}
        className="flex-1"
        classNames={{ input: 'font-mono text-sm' }}
      />
      <Button
        size="sm"
        variant="light"
        color="danger"
        isIconOnly
        isDisabled={isSaving || total <= 1}
        onPress={() => onRemove(item.id)}
        aria-label={t('system.ntpRemove')}
      >
        <FontAwesomeIcon icon={faTrash} className="text-xs" />
      </Button>
    </Reorder.Item>
  );
}

const DEFAULT_DECODE_WINDOW_STATE: DecodeWindowState = {
  ft8Preset: DEFAULT_DECODE_WINDOW_SETTINGS.ft8?.preset ?? 'balanced',
  ft8CustomWindows: [...FT8_WINDOW_PRESETS[DEFAULT_DECODE_WINDOW_SETTINGS.ft8?.preset ?? 'balanced']],
  ft4Preset: DEFAULT_DECODE_WINDOW_SETTINGS.ft4?.preset ?? 'balanced',
  ft4CustomWindows: [...FT4_WINDOW_PRESETS[DEFAULT_DECODE_WINDOW_SETTINGS.ft4?.preset ?? 'balanced']],
};

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

function getCpuProfileChipColor(state: ServerCpuProfileStatus['state']): 'default' | 'warning' | 'success' | 'danger' | 'primary' {
  switch (state) {
    case 'armed':
      return 'warning';
    case 'running':
      return 'primary';
    case 'completed':
      return 'success';
    case 'interrupted':
    case 'missing':
      return 'danger';
    case 'env-override':
      return 'warning';
    default:
      return 'default';
  }
}

function getCpuProfileStateLabel(
  state: ServerCpuProfileStatus['state'],
  t: TFunction,
): string {
  switch (state) {
    case 'armed':
      return t('system.cpuProfile.state.armed', 'Armed');
    case 'running':
      return t('system.cpuProfile.state.running', 'Running');
    case 'completed':
      return t('system.cpuProfile.state.completed', 'Completed');
    case 'interrupted':
      return t('system.cpuProfile.state.interrupted', 'Interrupted');
    case 'missing':
      return t('system.cpuProfile.state.missing', 'Missing');
    case 'env-override':
      return t('system.cpuProfile.state.envOverride', 'External Override');
    default:
      return t('system.cpuProfile.state.idle', 'Idle');
  }
}

function getCpuProfileRuntimeLabel(
  distribution: ServerCpuProfileStatus['distribution'],
  t: TFunction,
): string {
  switch (distribution) {
    case 'electron':
      return t('system.cpuProfile.runtime.electron', 'Electron');
    case 'docker':
      return t('system.cpuProfile.runtime.docker', 'Docker');
    case 'linux-service':
      return t('system.cpuProfile.runtime.linuxService', 'Linux Server');
    case 'web-dev':
      return t('system.cpuProfile.runtime.dev', 'Dev');
    default:
      return t('system.cpuProfile.runtime.generic', 'Server');
  }
}

function getCpuProfileRecommendedAction(
  distribution: ServerCpuProfileStatus['distribution'],
  phase: 'start' | 'finish',
  t: TFunction,
  fallback?: string,
): string {
  const keyBase = phase === 'finish'
    ? 'system.cpuProfile.recommended.finish'
    : 'system.cpuProfile.recommended.start';

  switch (distribution) {
    case 'electron':
      return t(`${keyBase}.electron`, fallback || 'Restart app');
    case 'docker':
      return t(`${keyBase}.docker`, fallback || 'docker restart tx5dr');
    case 'linux-service':
      return t(`${keyBase}.linuxService`, fallback || 'sudo tx5dr restart');
    case 'web-dev':
      return t(`${keyBase}.dev`, fallback || 'Restart the server normally');
    default:
      return t(`${keyBase}.generic`, fallback || 'Restart the server normally');
  }
}

function getCpuLoadInfo(count: number, t: (key: string) => string): { label: string; color: 'success' | 'primary' | 'warning' | 'danger' } {
  if (count <= 1) return { label: t('system.cpuVeryLow'), color: 'success' };
  if (count <= 2) return { label: t('system.cpuLow'), color: 'success' };
  if (count <= 3) return { label: t('system.cpuMedium'), color: 'primary' };
  if (count <= 5) return { label: t('system.cpuHigh'), color: 'warning' };
  return { label: t('system.cpuVeryHigh'), color: 'danger' };
}

function getRealtimeTransportLabel(
  transport: 'rtc-data-audio' | 'ws-compat' | null | undefined,
  t: (key: string) => string,
): string {
  if (transport === 'rtc-data-audio') {
    return t('system.realtimePathRtcDataAudio');
  }
  if (transport === 'ws-compat') {
    return t('system.realtimePathCompat');
  }
  return t('system.realtimeUnknown');
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
  const [realtimeTransportPolicy, setRealtimeTransportPolicy] = useState<RealtimeTransportPolicy>('auto');
  const [originalRealtimeTransportPolicy, setOriginalRealtimeTransportPolicy] = useState<RealtimeTransportPolicy>('auto');
  const [rtcDataAudioPublicHost, setRtcDataAudioPublicHost] = useState('');
  const [originalRtcDataAudioPublicHost, setOriginalRtcDataAudioPublicHost] = useState('');
  const [rtcDataAudioPublicUdpPort, setRtcDataAudioPublicUdpPort] = useState('');
  const [originalRtcDataAudioPublicUdpPort, setOriginalRtcDataAudioPublicUdpPort] = useState('');
  const [realtimeRuntime, setRealtimeRuntime] = useState<RealtimeRuntimeView | null>(null);
  const [urlCopied, setUrlCopied] = useState(false);
  const [ntpServers, setNtpServers] = useState<NtpServerDraftItem[]>([]);
  const [originalNtpServers, setOriginalNtpServers] = useState<string[]>([]);
  const [defaultNtpServers, setDefaultNtpServers] = useState<string[]>([]);

  // 解码窗口设置
  const [decodeWindowState, setDecodeWindowState] = useState<DecodeWindowState>({ ...DEFAULT_DECODE_WINDOW_STATE });
  const [originalDecodeWindowState, setOriginalDecodeWindowState] = useState<DecodeWindowState>({ ...DEFAULT_DECODE_WINDOW_STATE });

  // Electron 关闭行为设置（仅桌面应用）
  const [closeBehavior, setCloseBehavior] = useState<string>('ask');
  const [originalCloseBehavior, setOriginalCloseBehavior] = useState<string>('ask');
  const isElectron = typeof window !== 'undefined' && !!window.electronAPI;
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
  const [desktopUpdateExpanded, setDesktopUpdateExpanded] = useState(false);
  const [cpuProfileStatus, setCpuProfileStatus] = useState<ServerCpuProfileStatus | null>(null);
  const [cpuProfileBusy, setCpuProfileBusy] = useState(false);
  const [cpuProfilePathCopied, setCpuProfilePathCopied] = useState(false);
  const [cpuProfileDownloadBusy, setCpuProfileDownloadBusy] = useState(false);

  // 加载配置
  useEffect(() => {
    loadSettings();
    loadAuthConfig();
    loadPSKReporterConfig();
    loadPSKReporterStatus();
    loadDecodeWindowSettings();
    loadRealtimeSettings();
    loadNtpServerListSettings();
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

  const loadCpuProfileStatus = useCallback(async () => {
    try {
      const status = await api.getServerCpuProfileStatus();
      setCpuProfileStatus(status);
    } catch (err) {
      logger.error('Failed to load CPU profile status:', err);
    }
  }, []);

  const runCpuProfileAction = useCallback(async (
    action: () => Promise<ServerCpuProfileStatus>,
    successTitle: string,
  ) => {
    setCpuProfileBusy(true);
    try {
      const status = await action();
      setCpuProfileStatus(status);
      addToast({ title: successTitle, color: 'success', timeout: 2500 });
    } catch (err) {
      logger.error('CPU profile action failed:', err);
      if (err instanceof ApiError) {
        showErrorToast({
          userMessage: err.userMessage,
          suggestions: err.suggestions,
          severity: err.severity,
          code: err.code,
        });
      } else {
        showErrorToast({
          userMessage: err instanceof Error ? err.message : t('system.saveFailed'),
          severity: 'error',
        });
      }
    } finally {
      setCpuProfileBusy(false);
    }
  }, [t]);

  const handleCopyCpuProfilePath = useCallback(async (pathValue: string | null | undefined) => {
    if (!pathValue) return;
    try {
      await navigator.clipboard.writeText(pathValue);
      setCpuProfilePathCopied(true);
      window.setTimeout(() => setCpuProfilePathCopied(false), 1500);
    } catch (err) {
      logger.error('Failed to copy CPU profile path:', err);
    }
  }, []);

  const handleOpenCpuProfileFolder = useCallback(async () => {
    if (!cpuProfileStatus?.profilePath || !window.electronAPI?.shell?.openPath) {
      return;
    }

    try {
      const normalized = cpuProfileStatus.profilePath.replace(/\\/g, '/');
      const folderPath = normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) : cpuProfileStatus.profilePath;
      await window.electronAPI.shell.openPath(folderPath);
    } catch (err) {
      logger.error('Failed to open CPU profile folder:', err);
    }
  }, [cpuProfileStatus?.profilePath]);

  const handleDownloadCpuProfile = useCallback(async () => {
    if (!cpuProfileStatus?.profilePath) {
      return;
    }

    setCpuProfileDownloadBusy(true);
    try {
      const blob = await api.downloadServerCpuProfile();
      const objectUrl = URL.createObjectURL(blob);
      const fileName = cpuProfileStatus.profilePath.split(/[\\/]/).pop() || 'server.cpuprofile';
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(objectUrl);
    } catch (err) {
      logger.error('Failed to download CPU profile:', err);
      if (err instanceof ApiError) {
        showErrorToast({
          userMessage: err.userMessage,
          suggestions: err.suggestions,
          severity: err.severity,
          code: err.code,
        });
      } else {
        showErrorToast({
          userMessage: t('system.cpuProfile.downloadFailed', 'Failed to download CPU profile'),
          severity: 'error',
        });
      }
    } finally {
      setCpuProfileDownloadBusy(false);
    }
  }, [cpuProfileStatus?.profilePath, t]);

  const handleRestartAppForCpuProfile = useCallback(async () => {
    if (!window.electronAPI?.app?.restart) {
      return;
    }

    setCpuProfileBusy(true);
    try {
      await window.electronAPI.app.restart();
    } catch (err) {
      logger.error('Failed to restart app for CPU profile flow:', err);
      setCpuProfileBusy(false);
      showErrorToast({
        userMessage: err instanceof Error ? err.message : t('system.saveFailed'),
        severity: 'error',
      });
    }
  }, [t]);

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
      if (typeof value === 'string') {
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
      setDesktopUpdateExpanded(false);
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
      setDesktopUpdateExpanded(false);
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

  const handleOpenDesktopUpdateCommits = useCallback(async () => {
    if (!window.electronAPI?.shell?.openExternal) return;
    setDesktopUpdateBusy(true);
    setDesktopUpdateError('');
    try {
      await window.electronAPI.shell.openExternal(DESKTOP_UPDATE_COMMITS_URL);
    } catch (err) {
      logger.error('Failed to open desktop update commits page:', err);
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
    const nextPolicy = data.transportPolicy ?? 'auto';
    const nextRtcPublicHost = data.rtcDataAudioPublicHost ?? '';
    const nextRtcPublicUdpPort = data.rtcDataAudioPublicUdpPort ? String(data.rtcDataAudioPublicUdpPort) : '';
    const preserveDraft = options?.preserveDraft === true;
    const hasLocalDraft = realtimeTransportPolicy !== originalRealtimeTransportPolicy
      || rtcDataAudioPublicHost !== originalRtcDataAudioPublicHost
      || rtcDataAudioPublicUdpPort !== originalRtcDataAudioPublicUdpPort;

    if (!preserveDraft || !hasLocalDraft) {
      setRealtimeTransportPolicy(nextPolicy);
      setRtcDataAudioPublicHost(nextRtcPublicHost);
      setRtcDataAudioPublicUdpPort(nextRtcPublicUdpPort);
    }

    setOriginalRealtimeTransportPolicy(nextPolicy);
    setOriginalRtcDataAudioPublicHost(nextRtcPublicHost);
    setOriginalRtcDataAudioPublicUdpPort(nextRtcPublicUdpPort);
    setRealtimeRuntime(data.runtime ?? null);
  }, [
    realtimeTransportPolicy,
    originalRealtimeTransportPolicy,
    rtcDataAudioPublicHost,
    originalRtcDataAudioPublicHost,
    rtcDataAudioPublicUdpPort,
    originalRtcDataAudioPublicUdpPort,
  ]);

  const loadRealtimeSettings = useCallback(async () => {
    try {
      const result = await api.getRealtimeSettings();
      applyRealtimeSettingsSnapshot(result.data, { preserveDraft: true });
    } catch (err) {
      logger.error('Failed to load realtime settings:', err);
    }
  }, [applyRealtimeSettingsSnapshot]);

  const loadNtpServerListSettings = useCallback(async () => {
    try {
      const settings = await api.getNtpServerListSettings();
      setNtpServers(toNtpServerDraftItems(settings.servers));
      setOriginalNtpServers([...settings.servers]);
      setDefaultNtpServers([...settings.defaultServers]);
    } catch (err) {
      logger.error('Failed to load NTP server list settings:', err);
    }
  }, []);

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

  useEffect(() => {
    void loadCpuProfileStatus();
  }, [loadCpuProfileStatus]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void loadCpuProfileStatus();
    }, 5000);

    return () => window.clearInterval(interval);
  }, [loadCpuProfileStatus]);

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

  const hasNtpServerChanges = () => !areStringArraysEqual(getNtpServerValues(ntpServers), originalNtpServers);

  // 检查是否有未保存的更改
  const hasUnsavedChanges = () => {
    return (
      decodeWhileTransmitting !== originalDecodeValue ||
      spectrumWhileTransmitting !== originalSpectrumValue ||
      hasAuthChanges() ||
      hasPskrChanges() ||
      hasDecodeWindowChanges() ||
      hasNtpServerChanges() ||
      realtimeTransportPolicy !== originalRealtimeTransportPolicy ||
      rtcDataAudioPublicHost !== originalRtcDataAudioPublicHost ||
      rtcDataAudioPublicUdpPort !== originalRtcDataAudioPublicUdpPort ||
      (isElectron && closeBehavior !== originalCloseBehavior) ||
      (isElectron && (
        desktopHttpsEnabled !== originalDesktopHttpsEnabled ||
        desktopHttpsMode !== originalDesktopHttpsMode ||
        desktopHttpsPort !== originalDesktopHttpsPort ||
        desktopHttpsRedirectExternalHttp !== originalDesktopHttpsRedirectExternalHttp
      ))
    );
  };

  const handleNtpServerValueChange = useCallback((id: string, value: string) => {
    setNtpServers((current) => current.map((item) => (item.id === id ? { ...item, value } : item)));
  }, []);

  const handleAddNtpServer = useCallback(() => {
    setNtpServers((current) => [createNtpServerDraftItem(''), ...current]);
  }, []);

  const handleRemoveNtpServer = useCallback((id: string) => {
    setNtpServers((current) => (current.length <= 1 ? current : current.filter((item) => item.id !== id)));
  }, []);

  const handleRestoreDefaultNtpServers = useCallback(() => {
    setNtpServers(toNtpServerDraftItems(defaultNtpServers));
  }, [defaultNtpServers]);

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

      if (hasNtpServerChanges()) {
        const ntpResult = await api.updateNtpServerListSettings({
          servers: getNtpServerValues(ntpServers),
        });
        setNtpServers(toNtpServerDraftItems(ntpResult.servers));
        setOriginalNtpServers([...ntpResult.servers]);
        setDefaultNtpServers([...ntpResult.defaultServers]);
      }

      if (
        realtimeTransportPolicy !== originalRealtimeTransportPolicy
        || rtcDataAudioPublicHost !== originalRtcDataAudioPublicHost
        || rtcDataAudioPublicUdpPort !== originalRtcDataAudioPublicUdpPort
      ) {
        const normalizedRtcPublicHost = rtcDataAudioPublicHost.trim();
        const normalizedRtcPublicUdpPort = rtcDataAudioPublicUdpPort.trim();
        const parsedRtcPublicUdpPort = normalizedRtcPublicUdpPort
          ? Number.parseInt(normalizedRtcPublicUdpPort, 10)
          : null;
        const realtimeResult = await api.updateRealtimeSettings({
          transportPolicy: realtimeTransportPolicy,
          rtcDataAudioPublicHost: normalizedRtcPublicHost || null,
          rtcDataAudioPublicUdpPort: Number.isFinite(parsedRtcPublicUdpPort) ? parsedRtcPublicUdpPort : null,
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
  }, [decodeWhileTransmitting, spectrumWhileTransmitting, originalDecodeValue, originalSpectrumValue, authConfig, originalAuthConfig, pskrConfig, originalPskrConfig, decodeWindowState, originalDecodeWindowState, ntpServers, originalNtpServers, realtimeTransportPolicy, originalRealtimeTransportPolicy, rtcDataAudioPublicHost, originalRtcDataAudioPublicHost, rtcDataAudioPublicUdpPort, originalRtcDataAudioPublicUdpPort, closeBehavior, originalCloseBehavior, desktopHttpsEnabled, originalDesktopHttpsEnabled, desktopHttpsMode, originalDesktopHttpsMode, desktopHttpsPort, originalDesktopHttpsPort, desktopHttpsRedirectExternalHttp, originalDesktopHttpsRedirectExternalHttp, onUnsavedChanges]);

  const runtimeHints = realtimeRuntime?.connectivityHints ?? null;
  const rtcDataAudioRuntime = realtimeRuntime?.rtcDataAudio ?? null;
  const rtcPublicEndpointLabel = rtcDataAudioRuntime?.publicEndpoint
    ? `${rtcDataAudioRuntime.publicEndpoint.host}:${rtcDataAudioRuntime.publicEndpoint.port}`
    : t('system.rtcDataAudioPublicCandidateDisabled');
  const desktopHttpsCertificateMeta = desktopHttpsStatus?.certificateMeta ?? null;
  const desktopHttpsBrowserUrl = desktopHttpsStatus?.browserAccessUrl ?? null;
  const desktopUpdateSourceLabel = desktopUpdateStatus?.metadataSource
    ? t(`system.desktopUpdateSourceValue.${desktopUpdateStatus.metadataSource}`)
    : t('system.desktopUpdateSourceValue.unknown');
  const desktopDownloadOptions = desktopUpdateStatus?.downloadOptions || [];
  const desktopRecentCommits = desktopUpdateStatus?.recentCommits || [];
  const ntpCanRestoreDefaults = !areStringArraysEqual(getNtpServerValues(ntpServers), defaultNtpServers);
  const cpuProfileState = cpuProfileStatus?.state ?? 'idle';
  const cpuProfilePrimaryAction = cpuProfileStatus
    ? getCpuProfileRecommendedAction(
        cpuProfileStatus.distribution,
        cpuProfileState === 'running' ? 'finish' : 'start',
        t,
        cpuProfileState === 'running'
          ? cpuProfileStatus.recommendedFinishAction
          : cpuProfileStatus.recommendedStartAction,
      )
    : null;
  const isCpuProfileElectronFlow = cpuProfileStatus?.distribution === 'electron' && Boolean(window.electronAPI?.app?.restart);

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

  const cpuProfileCard = cpuProfileStatus && (
    <Card shadow="none" radius="lg" className="order-[10]" classNames={SETTINGS_CARD_CLASS_NAMES}>
      <CardBody className={SETTINGS_CARD_BODY_CLASS}>
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className={SETTINGS_CARD_TITLE_CLASS}>
                {t('system.cpuProfile.title', 'Performance Diagnostics')}
              </h4>
              <Chip size="sm" color={getCpuProfileChipColor(cpuProfileState)} variant="flat">
                {getCpuProfileStateLabel(cpuProfileState, t)}
              </Chip>
            </div>
            <p className={`mt-1 ${SETTINGS_CARD_DESC_CLASS}`}>
              {t(
                'system.cpuProfile.desc',
                'If TX5DR feels sluggish, responds slowly, or keeps using a lot of CPU, run a diagnosis and send the result to the developers.',
              )}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {cpuProfileState === 'idle' && (
              <Button
                size="sm"
                color="primary"
                onPress={() => void runCpuProfileAction(
                  () => api.armServerCpuProfile(),
                  t('system.cpuProfile.armedToast', 'CPU profile capture armed'),
                )}
                isDisabled={cpuProfileBusy}
              >
                {t('system.cpuProfile.start', 'Start Diagnosis')}
              </Button>
            )}
            {cpuProfileState === 'armed' && (
              <Button
                size="sm"
                variant="flat"
                onPress={() => void runCpuProfileAction(
                  () => api.cancelServerCpuProfile(),
                  t('system.cpuProfile.cancelledToast', 'CPU profile capture cancelled'),
                )}
                isDisabled={cpuProfileBusy}
              >
                {t('system.cpuProfile.cancel', 'Cancel Diagnosis')}
              </Button>
            )}
            {(cpuProfileState === 'completed' || cpuProfileState === 'interrupted' || cpuProfileState === 'missing') && (
              <Button
                size="sm"
                variant="flat"
                onPress={() => void runCpuProfileAction(
                  () => api.dismissServerCpuProfile(),
                  t('system.cpuProfile.dismissedToast', 'CPU profile status cleared'),
                )}
                isDisabled={cpuProfileBusy}
              >
                {t('system.cpuProfile.dismiss', 'Dismiss Result')}
              </Button>
            )}
          </div>
        </div>

        <div className={SETTINGS_SOFT_PANEL_CLASS}>
          <p className={SETTINGS_SUBTITLE_CLASS}>
            {t('system.cpuProfile.serverOnlyTitle', 'When to use this')}
          </p>
          <p className={`mt-1 ${SETTINGS_SUBDESC_CLASS}`}>
            {t(
              'system.cpuProfile.serverOnlyDesc',
              'Use this when sluggishness or high CPU usage can be reproduced. Start the diagnosis, repeat the action that causes the problem, then finish it as prompted.',
            )}
          </p>
        </div>

        {cpuProfileState === 'idle' && (
          <Alert
            color="default"
            variant="flat"
            title={t('system.cpuProfile.idleTitle', 'Ready to record one slow moment')}
            description={t(
              'system.cpuProfile.idleDesc',
              'Start here, restart TX5DR when prompted, then reproduce the sluggishness or high CPU usage.',
            )}
          />
        )}

        {cpuProfileState === 'armed' && (
          <Alert
            color="warning"
            variant="flat"
            title={t('system.cpuProfile.armedTitle', 'Diagnosis will start after restart')}
            description={t(
              'system.cpuProfile.armedDesc',
              'Restart TX5DR normally. After it starts again, TX5DR will record the problem while you reproduce it.',
            )}
          />
        )}

        {cpuProfileState === 'running' && (
          <Alert
            color="primary"
            variant="flat"
            title={t('system.cpuProfile.runningTitle', 'Recording the problem now')}
            description={t(
              'system.cpuProfile.runningDesc',
              'Reproduce the sluggishness, slow response, or high CPU usage now. When done, use the recommended action below to finish the diagnosis.',
            )}
          />
        )}

        {(cpuProfileState === 'interrupted' || cpuProfileState === 'missing') && (
          <Alert
            color="danger"
            variant="flat"
            title={t('system.cpuProfile.failedTitle', 'This diagnosis did not produce a usable result')}
            description={t(
              'system.cpuProfile.failedDesc',
              'This usually happens when TX5DR did not close normally. Start again and use the buttons on this page to restart and finish.',
            )}
          />
        )}

        {cpuProfileState === 'env-override' && (
          <Alert
            color="warning"
            variant="flat"
            title={t('system.cpuProfile.overrideTitle', 'Diagnosis is enabled by external configuration')}
            description={t(
              'system.cpuProfile.overrideDesc',
              'This environment has diagnosis enabled outside the app, so the guided flow on this page is read-only.',
            )}
          />
        )}

        {cpuProfileState === 'completed' && (
          <Alert
            color="success"
            variant="flat"
            title={t('system.cpuProfile.completedTitle', 'Diagnosis file generated')}
            description={t(
              'system.cpuProfile.completedDesc',
              'Download or copy this file, then include what you were doing, how long the slowdown lasted, and roughly how high CPU usage was when reporting the issue.',
            )}
          />
        )}

        <div className="grid gap-3 md:grid-cols-2">
          <div className={SETTINGS_PANEL_CLASS}>
            <p className={SETTINGS_SUBTITLE_CLASS}>{t('system.cpuProfile.runtimeLabel', 'Runtime')}</p>
            <p className={`mt-1 ${SETTINGS_SUBDESC_CLASS}`}>{getCpuProfileRuntimeLabel(cpuProfileStatus.distribution, t)}</p>
          </div>
          <div className={SETTINGS_PANEL_CLASS}>
            <p className={SETTINGS_SUBTITLE_CLASS}>{t('system.cpuProfile.outputDirLabel', 'Output directory')}</p>
            <p className={`mt-1 break-all font-mono ${SETTINGS_SUBDESC_CLASS}`}>{cpuProfileStatus.outputDir}</p>
            {cpuProfileStatus.hostOutputDirHint && (
              <p className={`mt-1 break-all font-mono ${SETTINGS_MUTED_CLASS}`}>
                {t('system.cpuProfile.hostDirHint', 'Host path')}: {cpuProfileStatus.hostOutputDirHint}
              </p>
            )}
          </div>
        </div>

        {(cpuProfileState === 'armed' || cpuProfileState === 'running') && cpuProfilePrimaryAction && (
          <div className={SETTINGS_PANEL_CLASS}>
            <p className={SETTINGS_SUBTITLE_CLASS}>
              {cpuProfileState === 'running'
                ? t('system.cpuProfile.finishActionTitle', 'Recommended way to finish')
                : t('system.cpuProfile.startActionTitle', 'Recommended way to start')}
            </p>
            <p className={`mt-2 break-all font-mono ${SETTINGS_SUBDESC_CLASS}`}>{cpuProfilePrimaryAction}</p>
            {isCpuProfileElectronFlow && (
              <Button
                size="sm"
                color="primary"
                variant="flat"
                className="mt-3"
                onPress={() => void handleRestartAppForCpuProfile()}
                isDisabled={cpuProfileBusy}
              >
                {cpuProfileState === 'running'
                  ? t('system.cpuProfile.restartToFinish', 'Restart App and Finish Diagnosis')
                  : t('system.cpuProfile.restartToStart', 'Restart App and Start Diagnosis')}
              </Button>
            )}
          </div>
        )}

        {cpuProfileState === 'completed' && cpuProfileStatus.profilePath && (
          <div className={SETTINGS_PANEL_CLASS}>
            <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
              <div className="flex-1">
                <p className={SETTINGS_SUBTITLE_CLASS}>{t('system.cpuProfile.profilePathLabel', 'Diagnosis file')}</p>
                <p className={`mt-2 break-all font-mono ${SETTINGS_SUBDESC_CLASS}`}>{cpuProfileStatus.profilePath}</p>
                {cpuProfileStatus.hostProfilePathHint && (
                  <p className={`mt-1 break-all font-mono ${SETTINGS_MUTED_CLASS}`}>
                    {t('system.cpuProfile.hostPathHint', 'Host file')}: {cpuProfileStatus.hostProfilePathHint}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  color="primary"
                  variant="flat"
                  startContent={<FontAwesomeIcon icon={faDownload} />}
                  onPress={() => void handleDownloadCpuProfile()}
                  isDisabled={cpuProfileDownloadBusy}
                  isLoading={cpuProfileDownloadBusy}
                >
                  {t('system.cpuProfile.download', 'Download')}
                </Button>
                <Button
                  size="sm"
                  variant="flat"
                  startContent={<FontAwesomeIcon icon={cpuProfilePathCopied ? faCheck : faCopy} />}
                  onPress={() => void handleCopyCpuProfilePath(cpuProfileStatus.profilePath)}
                >
                  {cpuProfilePathCopied ? t('system.cpuProfile.copied', 'Copied') : t('system.cpuProfile.copyPath', 'Copy path')}
                </Button>
                {cpuProfileState === 'completed' && isElectron && window.electronAPI?.shell?.openPath && (
                  <Button
                    size="sm"
                    variant="flat"
                    onPress={() => void handleOpenCpuProfileFolder()}
                  >
                    {t('system.cpuProfile.openFolder', 'Open Folder')}
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}

        {cpuProfileState === 'completed' && (
          <div className={SETTINGS_PANEL_CLASS}>
            <p className={SETTINGS_SUBTITLE_CLASS}>{t('system.cpuProfile.feedbackTitle', 'When sending feedback, include')}</p>
            <div className={`mt-2 space-y-1 ${SETTINGS_SUBDESC_CLASS}`}>
              <p>{t('system.cpuProfile.feedback1', '1. The diagnosis file generated here.')}</p>
              <p>{t('system.cpuProfile.feedback2', '2. The app version and whether you use Desktop, Docker, or a server deployment.')}</p>
              <p>{t('system.cpuProfile.feedback3', '3. What you were doing when it slowed down and how long it lasted.')}</p>
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );

  return (
    <div className="flex flex-col gap-6">
      {/* 页面标题和描述 */}
      <div className="order-0">
        <h3 className="text-xl font-bold text-default-900 mb-2">{t('system.title')}</h3>
        <p className="text-default-600">
          {t('system.description')}
        </p>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="order-1 p-3 bg-danger-50 border border-danger-200 rounded-lg">
          <p className="text-danger-700 text-sm">{error}</p>
        </div>
      )}

      <Card shadow="none" radius="lg" className="order-[9]" classNames={SETTINGS_CARD_CLASS_NAMES}>
        <CardBody className={SETTINGS_CARD_BODY_CLASS}>
          <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
            <div className="flex-1">
              <h4 className={SETTINGS_CARD_TITLE_CLASS}>{t('system.ntpTitle')}</h4>
              <p className={`mt-1 ${SETTINGS_CARD_DESC_CLASS}`}>{t('system.ntpDesc')}</p>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="flat"
                onPress={handleRestoreDefaultNtpServers}
                isDisabled={isSaving || defaultNtpServers.length === 0 || !ntpCanRestoreDefaults}
              >
                {t('system.ntpRestoreDefaults')}
              </Button>
              <Button
                size="sm"
                color="primary"
                variant="flat"
                startContent={<FontAwesomeIcon icon={faPlus} />}
                onPress={handleAddNtpServer}
                isDisabled={isSaving}
              >
                {t('system.ntpAddServer')}
              </Button>
            </div>
          </div>

          <div className={SETTINGS_SOFT_PANEL_CLASS}>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <p className={SETTINGS_SUBTITLE_CLASS}>{t('system.ntpPriorityTitle')}</p>
              <p className={SETTINGS_SUBDESC_CLASS}>{t('system.ntpPriorityDesc')}</p>
            </div>
            <p className={`mt-2 ${SETTINGS_MUTED_CLASS}`}>{t('system.ntpPortHint')}</p>
          </div>

          <Reorder.Group
            axis="y"
            values={ntpServers}
            onReorder={setNtpServers}
            className="space-y-2"
            as="div"
          >
            {ntpServers.map((item) => (
              <NtpServerReorderItem
                key={item.id}
                item={item}
                total={ntpServers.length}
                isSaving={isSaving}
                onValueChange={handleNtpServerValueChange}
                onRemove={handleRemoveNtpServer}
                t={t}
              />
            ))}
          </Reorder.Group>

        </CardBody>
      </Card>

      {/* 公开查看权限 */}
      {authConfig && (
        <Card shadow="none" radius="lg" className="order-2" classNames={SETTINGS_CARD_CLASS_NAMES}>
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
        <Card shadow="none" radius="lg" className="order-3" classNames={SETTINGS_CARD_CLASS_NAMES}>
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
                  {desktopHttpsStatus && (
                    <p className={SETTINGS_SUBDESC_CLASS}>
                      {t('system.desktopHttpsEffectivePorts', {
                        httpPort: desktopHttpsStatus.httpPort,
                        httpsPort: desktopHttpsStatus.effectiveHttpsPort ?? t('system.desktopHttpsPortInactive'),
                      })}
                    </p>
                  )}
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

      <Card shadow="none" radius="lg" className="order-8" classNames={SETTINGS_CARD_CLASS_NAMES}>
        <CardBody className={SETTINGS_CARD_BODY_CLASS}>
          <div>
            <h4 className={SETTINGS_CARD_TITLE_CLASS}>{t('system.realtimeSettingsCardTitle')}</h4>
            <p className={`mt-1 ${SETTINGS_CARD_DESC_CLASS}`}>{t('system.realtimeSettingsCardDesc')}</p>
          </div>

          <Alert color="default" variant="flat" className="text-xs">
            {t('system.realtimeSettingsSimpleGuide')}
          </Alert>

          <Alert color="primary" variant="flat" className="text-xs">
            <p>{t('system.realtimeRtcDataAudioBenefitsTitle')}</p>
            <p className="mt-1">{t('system.realtimeRtcDataAudioBenefitsDesc')}</p>
          </Alert>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <div className={`${SETTINGS_PANEL_CLASS} space-y-3`}>
              <div>
                <p className={SETTINGS_MUTED_CLASS}>01</p>
                <h5 className={SETTINGS_SUBTITLE_CLASS}>{t('system.realtimeBrowserEntryTitle')}</h5>
                <p className={`mt-1 ${SETTINGS_SUBDESC_CLASS}`}>{t('system.realtimeBrowserEntryDesc')}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Chip size="sm" color="primary" variant="flat">rtc-data-audio</Chip>
                <Chip
                  size="sm"
                  color={(runtimeHints?.signalingUrl || '').startsWith('wss:') ? 'success' : 'default'}
                  variant="flat"
                >
                  {(runtimeHints?.signalingUrl || '').startsWith('wss:') ? 'WSS' : 'WS'}
                </Chip>
                <Chip size="sm" color="default" variant="flat">fallback: ws-compat</Chip>
              </div>
              <div className="space-y-2">
                <p className={SETTINGS_SUBDESC_CLASS}>{t('system.realtimeBrowserEntryCurrentLabel')}</p>
                <code className="block break-all text-xs leading-5 text-default-600">
                  {runtimeHints?.signalingUrl || t('system.realtimeUrlPending')}
                </code>
              </div>
              <p className={SETTINGS_MUTED_CLASS}>{t('system.realtimeBrowserEntryRtcHint')}</p>
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

            <div className={`${SETTINGS_PANEL_CLASS} space-y-3 xl:col-span-2`}>
              <div>
                <p className={SETTINGS_MUTED_CLASS}>03</p>
                <h5 className={SETTINGS_SUBTITLE_CLASS}>{t('system.rtcDataAudioPublicUdpTitle')}</h5>
                <p className={`mt-1 ${SETTINGS_SUBDESC_CLASS}`}>{t('system.rtcDataAudioPublicUdpDesc')}</p>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_180px]">
                <Input
                  value={rtcDataAudioPublicHost}
                  onValueChange={setRtcDataAudioPublicHost}
                  placeholder={t('system.rtcDataAudioPublicHostPlaceholder')}
                  isDisabled={isSaving}
                  size="sm"
                  variant="bordered"
                  label={t('system.rtcDataAudioPublicHostLabel')}
                />
                <Input
                  value={rtcDataAudioPublicUdpPort}
                  onValueChange={setRtcDataAudioPublicUdpPort}
                  placeholder={String(rtcDataAudioRuntime?.localUdpPort ?? 50110)}
                  isDisabled={isSaving}
                  size="sm"
                  variant="bordered"
                  type="number"
                  min={1}
                  max={65535}
                  label={t('system.rtcDataAudioPublicUdpPortLabel')}
                />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Chip
                  size="sm"
                  color={rtcDataAudioRuntime?.publicCandidateEnabled ? 'success' : 'default'}
                  variant="flat"
                >
                  {rtcDataAudioRuntime?.publicCandidateEnabled
                    ? t('system.rtcDataAudioPublicCandidateEnabled')
                    : t('system.rtcDataAudioPublicCandidateDisabled')}
                </Chip>
                <Chip size="sm" color="primary" variant="flat">
                  {t('system.rtcDataAudioLocalUdpPort', { port: rtcDataAudioRuntime?.localUdpPort ?? 50110 })}
                </Chip>
                <Chip size="sm" color="default" variant="flat">
                  {t('system.rtcDataAudioPublicEndpoint', { endpoint: rtcPublicEndpointLabel })}
                </Chip>
              </div>
              <p className={SETTINGS_MUTED_CLASS}>
                {rtcDataAudioRuntime?.publicEndpoint
                  ? t('system.rtcDataAudioPublicEndpointActive', {
                      host: rtcDataAudioRuntime.publicEndpoint.host,
                      port: rtcDataAudioRuntime.publicEndpoint.port,
                    })
                  : t('system.rtcDataAudioPublicUdpHint')}
              </p>
            </div>
          </div>

          <Alert color="warning" variant="flat" className="text-xs">
            <p>{t('system.realtimeFrpHintTitle')}</p>
            <p className="mt-1">{t('system.realtimeFrpHintDesc')}</p>
          </Alert>

          <Alert color="default" variant="flat" className="text-xs">
            {t('system.realtimeRtcDataAudioApplyHint')}
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
                      color={(realtimeRuntime?.radioReceiveTransport ?? 'ws-compat') === 'rtc-data-audio' ? 'primary' : 'warning'}
                      variant="flat"
                    >
                      {getRealtimeTransportLabel(realtimeRuntime?.radioReceiveTransport ?? null, t)}
                    </Chip>
                  </div>
                  <p className={`mt-2 ${SETTINGS_MUTED_CLASS}`}>{t('system.realtimeCurrentPathHint')}</p>
                </div>

                <div className={`${SETTINGS_PANEL_CLASS} py-2`}>
                  <p className={SETTINGS_SUBDESC_CLASS}>{t('system.rtcDataAudioPublicUdpTitle')}</p>
                  <div className="mt-2">
                    <Chip
                      size="sm"
                      color={rtcDataAudioRuntime?.publicCandidateEnabled ? 'success' : 'default'}
                      variant="flat"
                    >
                      {rtcDataAudioRuntime?.publicCandidateEnabled
                        ? t('system.rtcDataAudioPublicCandidateEnabled')
                        : t('system.rtcDataAudioPublicCandidateDisabled')}
                    </Chip>
                  </div>
                  <p className={`mt-2 ${SETTINGS_MUTED_CLASS}`}>{rtcPublicEndpointLabel}</p>
                </div>
              </div>

              <div className={SETTINGS_PANEL_CLASS}>
                <h6 className={SETTINGS_SUBTITLE_CLASS}>{t('system.realtimePortRequirementsTitle')}</h6>
                <p className={`mt-1 ${SETTINGS_SUBDESC_CLASS}`}>{t('system.realtimePortRequirementsDesc')}</p>

                <div className="mt-3 grid grid-cols-1 gap-2 lg:grid-cols-2">
                  <div className={`flex items-center justify-between gap-3 ${SETTINGS_METRIC_CLASS}`}>
                    <span className="text-default-700">{t('system.realtimePortSignaling')}</span>
                    <code className={SETTINGS_SUBDESC_CLASS}>/api/realtime/rtc-data-audio</code>
                  </div>
                  <div className={`flex items-center justify-between gap-3 ${SETTINGS_METRIC_CLASS}`}>
                    <span className="text-default-700">{t('system.realtimePortUdp')}</span>
                    <code className={SETTINGS_SUBDESC_CLASS}>{rtcDataAudioRuntime?.localUdpPort ?? 50110}/udp</code>
                  </div>
                  <div className={`flex items-center justify-between gap-3 ${SETTINGS_METRIC_CLASS}`}>
                    <span className="text-default-700">{t('system.rtcDataAudioPublicEndpointLabel')}</span>
                    <code className={SETTINGS_SUBDESC_CLASS}>{rtcPublicEndpointLabel}</code>
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
                  <p>{t('system.realtimePortHintRtcDataAudio')}</p>
                  <p>{t('system.realtimePortHintCompat')}</p>
                  <p>{t('system.realtimePortHintFallback')}</p>
                </div>
              </div>
            </div>
          </details>
        </CardBody>
      </Card>

      {/* 发射时解码设置 */}
      <Card shadow="none" radius="lg" className="order-4" classNames={SETTINGS_CARD_CLASS_NAMES}>
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
      <Card shadow="none" radius="lg" className="order-6" classNames={SETTINGS_CARD_CLASS_NAMES}>
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
      <Card shadow="none" radius="lg" className="order-5" classNames={SETTINGS_CARD_CLASS_NAMES}>
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

      {/* PSKReporter 设置 */}
      <Card shadow="none" radius="lg" className="order-7" classNames={SETTINGS_CARD_CLASS_NAMES}>
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
          <Card shadow="none" radius="lg" className="order-[11]" classNames={SETTINGS_CARD_CLASS_NAMES}>
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

          <Card shadow="none" radius="lg" className="order-[12]" classNames={SETTINGS_CARD_CLASS_NAMES}>
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

                <div>
                  <p className={SETTINGS_SUBTITLE_CLASS}>{t('system.desktopUpdateLatestSummary')}</p>
                  <p className={`mt-1 ${SETTINGS_SUBDESC_CLASS}`}>
                    {desktopUpdateStatus?.latestCommitTitle || t('system.desktopUpdateNoSummary')}
                  </p>
                </div>

                {desktopRecentCommits.length > 0 && (
                  <div className="rounded-medium border border-divider bg-content1 px-3 py-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className={SETTINGS_SUBTITLE_CLASS}>{t('system.desktopUpdateRecentCommitsTitle')}</p>
                        <p className={`mt-1 ${SETTINGS_SUBDESC_CLASS}`}>{t('system.desktopUpdateRecentCommitsDesc')}</p>
                      </div>
                      <Button
                        size="sm"
                        variant="light"
                        onPress={() => setDesktopUpdateExpanded((value) => !value)}
                      >
                        {desktopUpdateExpanded
                          ? t('system.desktopUpdateRecentCommitsCollapse')
                          : t('system.desktopUpdateRecentCommitsExpand')}
                      </Button>
                    </div>

                    {desktopUpdateExpanded && (
                      <div className="mt-3 space-y-2">
                        {desktopRecentCommits.map((commit) => (
                          <div key={`${commit.id}-${commit.publishedAt || commit.shortId}`} className="rounded-medium border border-divider bg-default-50 px-3 py-3 dark:bg-default-100/5">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <p className={SETTINGS_SUBTITLE_CLASS}>
                                {commit.title || t('system.desktopUpdateNoSummary')}
                              </p>
                              <Chip size="sm" color="default" variant="flat">
                                {commit.shortId || commit.id || '-'}
                              </Chip>
                            </div>
                            <p className={`mt-2 ${SETTINGS_SUBDESC_CLASS}`}>
                              {t('system.desktopUpdateRecentCommitTime', { value: formatDateTimeValue(commit.publishedAt) })}
                            </p>
                            <p className={`mt-1 break-all ${SETTINGS_MUTED_CLASS}`}>
                              {t('system.desktopUpdateRecentCommitId', { value: commit.id || commit.shortId || '-' })}
                            </p>
                          </div>
                        ))}

                        <Button
                          size="sm"
                          variant="flat"
                          onPress={() => { void handleOpenDesktopUpdateCommits(); }}
                          isDisabled={desktopUpdateBusy}
                        >
                          {t('system.desktopUpdateViewAllCommits')}
                        </Button>
                      </div>
                    )}
                  </div>
                )}

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

      {cpuProfileCard}

      {/* 提示信息 */}
      {hasUnsavedChanges() && (
        <div className="order-last text-sm text-default-500">
          {t('unsavedChanges')}
        </div>
      )}
    </div>
  );
});

SystemSettings.displayName = 'SystemSettings';
