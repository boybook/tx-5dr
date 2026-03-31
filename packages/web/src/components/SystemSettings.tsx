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
  PSKReporterConfig,
  PSKReporterStatus,
  AuthStatus,
  NetworkInfo,
  RealtimeConnectivityHints,
  RealtimeConnectivityErrorCode,
  RealtimeCredentialStatus,
  RealtimeSettingsResponseData,
  RealtimeTransportKind,
  RealtimeTransportPolicy,
} from '@tx5dr/contracts';
import { FT8_WINDOW_PRESETS, FT4_WINDOW_PRESETS } from '@tx5dr/contracts';
import { showErrorToast } from '../utils/errorToast';
import { createLogger } from '../utils/logger';
import { useConnection } from '../store/radioStore';
import { useWSEvent } from '../hooks/useWSEvent';

interface DecodeWindowState {
  ft8Preset: string;
  ft8CustomWindows: number[];
  ft4Preset: string;
  ft4CustomWindows: number[];
}

type RealtimeRuntimeView = {
  liveKitEnabled: boolean;
  connectivityHints: RealtimeConnectivityHints;
  radioReceiveTransport: RealtimeTransportKind;
  radioBridgeHealthy: boolean;
  radioBridgeIssueCode: RealtimeConnectivityErrorCode | null;
  credentialStatus: RealtimeCredentialStatus;
};

const SETTINGS_CARD_CLASS_NAMES = {
  base: 'border border-divider bg-content1',
} as const;

const DEFAULT_DECODE_WINDOW_STATE: DecodeWindowState = {
  ft8Preset: 'maximum',
  ft8CustomWindows: [-1500, -1000, -500, 0, 250],
  ft4Preset: 'balanced',
  ft4CustomWindows: [0],
};

function buildLiveKitExampleUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.port = '7880';
    url.pathname = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return 'ws://127.0.0.1:7880';
  }
}

function getWindowCount(preset: string, customWindows: number[], presets: Record<string, number[]>): number {
  if (preset === 'custom') return customWindows.length;
  return presets[preset]?.length ?? 1;
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
        const settings = result.data.settings as Record<string, { preset?: string; customWindowTiming?: number[] }>;
        const state: DecodeWindowState = {
          ft8Preset: settings.ft8?.preset ?? 'maximum',
          ft8CustomWindows: settings.ft8?.customWindowTiming ?? [...(FT8_WINDOW_PRESETS['maximum'])],
          ft4Preset: settings.ft4?.preset ?? 'balanced',
          ft4CustomWindows: settings.ft4?.customWindowTiming ?? [...(FT4_WINDOW_PRESETS['balanced'])],
        };
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

  const applyRealtimeSettingsSnapshot = useCallback((
    data: RealtimeSettingsResponseData,
    options?: { preserveDraft?: boolean },
  ) => {
    const nextPublicUrl = data.publicWsUrl ?? '';
    const nextPolicy = data.transportPolicy ?? 'auto';
    const preserveDraft = options?.preserveDraft === true;
    const hasLocalDraft = liveKitPublicUrl !== originalLiveKitPublicUrl
      || realtimeTransportPolicy !== originalRealtimeTransportPolicy;

    if (!preserveDraft || !hasLocalDraft) {
      setLiveKitPublicUrl(nextPublicUrl);
      setRealtimeTransportPolicy(nextPolicy);
    }

    setOriginalLiveKitPublicUrl(nextPublicUrl);
    setOriginalRealtimeTransportPolicy(nextPolicy);
    setRealtimeRuntime(data.runtime ?? null);
  }, [
    liveKitPublicUrl,
    originalLiveKitPublicUrl,
    realtimeTransportPolicy,
    originalRealtimeTransportPolicy,
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
      (isElectron && closeBehavior !== originalCloseBehavior)
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

      if (liveKitPublicUrl !== originalLiveKitPublicUrl || realtimeTransportPolicy !== originalRealtimeTransportPolicy) {
        const normalizedPublicUrl = liveKitPublicUrl.trim();
        const realtimeResult = await api.updateRealtimeSettings({
          publicWsUrl: normalizedPublicUrl || null,
          transportPolicy: realtimeTransportPolicy,
        });
        applyRealtimeSettingsSnapshot(realtimeResult.data);
      }

      // 保存 Electron 关闭行为设置
      if (isElectron && closeBehavior !== originalCloseBehavior) {
        await window.electronAPI?.config?.set('closeBehavior', closeBehavior);
        setOriginalCloseBehavior(closeBehavior);
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
  }, [decodeWhileTransmitting, spectrumWhileTransmitting, originalDecodeValue, originalSpectrumValue, authConfig, originalAuthConfig, pskrConfig, originalPskrConfig, decodeWindowState, originalDecodeWindowState, liveKitPublicUrl, originalLiveKitPublicUrl, realtimeTransportPolicy, originalRealtimeTransportPolicy, closeBehavior, originalCloseBehavior, onUnsavedChanges]);

  const runtimeHints = realtimeRuntime?.connectivityHints ?? null;
  const runtimeIssueLabel = getRealtimeIssueLabel(realtimeRuntime?.radioBridgeIssueCode ?? null, t);
  const runtimeCredential = realtimeRuntime?.credentialStatus ?? null;

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
          <CardBody className="p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <h4 className="font-semibold text-default-900 mb-1">{t('system.allowPublicViewing')}</h4>
                <div className="text-sm text-default-600 space-y-1">
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
                <p className="text-xs text-default-400 mb-1.5">
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

      <Card shadow="none" radius="lg" classNames={SETTINGS_CARD_CLASS_NAMES}>
        <CardBody className="p-4 space-y-3">
          <div>
            <h4 className="font-semibold text-default-900">{t('system.realtimeSettingsCardTitle')}</h4>
            <p className="mt-1 text-sm text-default-600">{t('system.realtimeSettingsCardDesc')}</p>
          </div>

          <div className="pt-3 border-t border-divider space-y-2">
            <div>
              <h5 className="text-sm font-medium text-default-900">{t('system.liveKitPublicUrl')}</h5>
              <p className="text-xs text-default-500 mt-1">{t('system.liveKitPublicUrlDesc')}</p>
            </div>
            <Input
              value={liveKitPublicUrl}
              onValueChange={setLiveKitPublicUrl}
              placeholder={t('system.liveKitPublicUrlPlaceholder')}
              isDisabled={isSaving}
              size="sm"
              variant="bordered"
            />
            <p className="text-xs text-default-400">
              {liveKitPublicUrl.trim()
                ? t('system.liveKitPublicUrlManualHint')
                : t('system.liveKitPublicUrlAutoHint')}
            </p>
            {networkInfo && networkInfo.addresses.length > 0 && (
              <p className="text-xs text-default-400">
                {t('system.liveKitPublicUrlExample', {
                  url: buildLiveKitExampleUrl(networkInfo.addresses[0].url),
                })}
              </p>
            )}
            {isMacElectron && (
              <Alert color="warning" variant="flat" className="text-xs">
                <p>{t('system.liveKitMacInstallHint')}</p>
                <p className="mt-1 font-mono">brew install livekit</p>
                <p className="mt-1">{t('system.liveKitMacFallbackHint')}</p>
              </Alert>
            )}
          </div>

          <div className="pt-3 border-t border-divider space-y-2">
            <div>
              <h5 className="text-sm font-medium text-default-900">{t('system.realtimeTransportPolicy')}</h5>
              <p className="text-xs text-default-500 mt-1">{t('system.realtimeTransportPolicyDesc')}</p>
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
            <p className="text-xs text-default-400">
              {realtimeTransportPolicy === 'force-compat'
                ? t('system.realtimeTransportPolicyCompatHint')
                : t('system.realtimeTransportPolicyAutoHint')}
            </p>
          </div>

          <div className="pt-3 border-t border-divider space-y-3">
            <div>
              <h5 className="text-sm font-medium text-default-900">{t('system.realtimeAdminGuideTitle')}</h5>
              <p className="text-xs text-default-500 mt-1">{t('system.realtimeAdminGuideDesc')}</p>
            </div>

            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              <div className="rounded-medium border border-divider bg-default-50 px-3 py-2 dark:bg-default-100/5">
                <p className="text-xs text-default-500">{t('system.realtimeCurrentPolicyLabel')}</p>
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

              <div className="rounded-medium border border-divider bg-default-50 px-3 py-2 dark:bg-default-100/5">
                <p className="text-xs text-default-500">{t('system.realtimeCurrentPathLabel')}</p>
                <div className="mt-2">
                  <Chip
                    size="sm"
                    color={(realtimeRuntime?.radioReceiveTransport ?? 'ws-compat') === 'livekit' ? 'primary' : 'warning'}
                    variant="flat"
                  >
                    {getRealtimeTransportLabel(realtimeRuntime?.radioReceiveTransport ?? null, t)}
                  </Chip>
                </div>
                <p className="mt-2 text-xs text-default-400">{t('system.realtimeCurrentPathHint')}</p>
              </div>

              <div className="rounded-medium border border-divider bg-default-50 px-3 py-2 dark:bg-default-100/5">
                <p className="text-xs text-default-500">{t('system.realtimeLiveKitServiceLabel')}</p>
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

              <div className="rounded-medium border border-divider bg-default-50 px-3 py-2 dark:bg-default-100/5">
                <p className="text-xs text-default-500">{t('system.realtimeBridgeHealthLabel')}</p>
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
                <p className="mt-2 text-xs text-default-400">{runtimeIssueLabel}</p>
              </div>

              <div className="rounded-medium border border-divider bg-default-50 px-3 py-2 dark:bg-default-100/5">
                <p className="text-xs text-default-500">{t('system.realtimeCredentialStatusLabel')}</p>
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
                <p className="mt-2 text-xs text-default-400">
                  {runtimeCredential?.apiKeyPreview
                    ? t('system.realtimeCredentialPreview', { value: runtimeCredential.apiKeyPreview })
                    : t('system.realtimeCredentialMissingHint')}
                </p>
                {runtimeCredential?.rotatedAt && (
                  <p className="mt-1 text-xs text-default-400">
                    {t('system.realtimeCredentialRotatedAt', { value: runtimeCredential.rotatedAt })}
                  </p>
                )}
                {runtimeCredential?.filePath && (
                  <p className="mt-1 break-all text-xs text-default-400">
                    {t('system.realtimeCredentialFile', { value: runtimeCredential.filePath })}
                  </p>
                )}
              </div>
            </div>

            <div className="rounded-medium border border-divider bg-default-50 px-3 py-3 dark:bg-default-100/5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h6 className="text-sm font-medium text-default-900">{t('system.realtimePortRequirementsTitle')}</h6>
                  <p className="mt-1 text-xs text-default-500">{t('system.realtimePortRequirementsDesc')}</p>
                </div>
                <Chip size="sm" color="default" variant="flat">{t('system.realtimeAdminOnly')}</Chip>
              </div>

              <div className="mt-3 space-y-2 text-sm">
                <div className="flex items-center justify-between gap-3 rounded-medium bg-content1 px-3 py-2">
                  <span className="text-default-700">{t('system.realtimePortSignaling')}</span>
                  <code className="text-xs text-default-500">{runtimeHints?.signalingPort ?? 7880}</code>
                </div>
                <div className="flex items-center justify-between gap-3 rounded-medium bg-content1 px-3 py-2">
                  <span className="text-default-700">{t('system.realtimePortIceTcp')}</span>
                  <code className="text-xs text-default-500">{runtimeHints?.rtcTcpPort ?? 7881}</code>
                </div>
                <div className="flex items-center justify-between gap-3 rounded-medium bg-content1 px-3 py-2">
                  <span className="text-default-700">{t('system.realtimePortUdp')}</span>
                  <code className="text-xs text-default-500">{runtimeHints?.udpPortRange ?? '50000-50100'}</code>
                </div>
                <div className="flex items-center justify-between gap-3 rounded-medium bg-content1 px-3 py-2">
                  <span className="text-default-700">{t('system.realtimePortCompat')}</span>
                  <code className="text-xs text-default-500">{t('system.realtimeCompatEndpointValue')}</code>
                </div>
                <div className="rounded-medium bg-content1 px-3 py-2">
                  <p className="text-xs text-default-500">{t('system.realtimeEffectiveUrlLabel')}</p>
                  <code className="mt-1 block break-all text-xs text-default-600">
                    {runtimeHints?.signalingUrl || t('system.realtimeUrlPending')}
                  </code>
                </div>
              </div>

              <div className="mt-3 space-y-1 text-xs text-default-500">
                <p>{t('system.realtimePortHintAuto')}</p>
                <p>{t('system.realtimePortHintCompat')}</p>
                <p>{t('system.realtimePortHintFallback')}</p>
                <p>{t('system.realtimeCredentialLinuxHint')}</p>
              </div>
            </div>
          </div>
        </CardBody>
      </Card>

      <Divider className="my-4" />

      {/* 发射时解码设置 */}
      <Card shadow="none" radius="lg" classNames={{
        base: "border border-divider bg-content1"
      }}>
        <CardBody className="p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1">
              <h4 className="font-semibold text-default-900 mb-1">{t('system.decodeWhileTransmitting')}</h4>
              <div className="text-sm text-default-600 space-y-1">
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
      <Card shadow="none" radius="lg" classNames={{
        base: "border border-divider bg-content1"
      }}>
        <CardBody className="p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1">
              <h4 className="font-semibold text-default-900 mb-1">{t('system.spectrumWhileTransmitting')}</h4>
              <div className="text-sm text-default-600 space-y-1">
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

      <Card shadow="none" radius="lg" classNames={{
        base: "border border-divider bg-content1"
      }}>
        <CardBody className="p-4 space-y-4">
          <div>
            <h4 className="font-semibold text-default-900 mb-1">{t('system.decodeWindowTitle')}</h4>
            <p className="text-sm text-default-600">{t('system.decodeWindowDesc')}</p>
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
                <SelectItem key="maximum" textValue={`${t('system.presetMaximum')}${t('system.presetDefault')}`}>{t('system.presetMaximum')}{t('system.presetDefault')}</SelectItem>
                <SelectItem key="balanced" textValue={t('system.presetBalanced')}>{t('system.presetBalanced')}</SelectItem>
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
            <div className="space-y-2 p-3 border border-divider rounded-lg">
              <p className="text-sm font-medium text-default-700">FT8 {t('system.presetCustom')}</p>
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
                      ft8CustomWindows: [...FT8_WINDOW_PRESETS['maximum']],
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
            <div className="space-y-2 p-3 border border-divider rounded-lg">
              <p className="text-sm font-medium text-default-700">FT4 {t('system.presetCustom')}</p>
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

      {/* PSKReporter 启用开关卡片 */}
      <Card shadow="none" radius="lg" classNames={{
        base: "border border-divider bg-content1"
      }}>
        <CardBody className="p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-1">
                <h4 className="font-semibold text-default-900">{t('system.pskrTitle')}</h4>
                {pskrConfig?.enabled && pskrStatus && (
                  <div className="flex gap-1">
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
              <div className="text-sm text-default-600 space-y-1">
                <p>
                  {t('system.pskrDesc')} <a href="https://pskreporter.info" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">PSKReporter</a>
                </p>
                {pskrConfig?.enabled && pskrStatus?.activeCallsign && (
                  <p className="text-default-500">
                    {t('system.pskrActiveInfo', { callsign: pskrStatus.activeCallsign, locator: pskrStatus.activeLocator || t('system.gridNotSet') })}
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
        </CardBody>
      </Card>

      {/* PSKReporter 详细配置（启用后显示） */}
      {pskrConfig?.enabled && (
        <>
          {/* 接收站信息卡片 */}
          <Card shadow="none" radius="lg" classNames={{
            base: "border border-divider bg-content1"
          }}>
            <CardBody className="p-4 space-y-4">
              <div>
                <h4 className="font-semibold text-default-900 mb-1">{t('system.receiverInfo')}</h4>
                <p className="text-sm text-default-500">
                  {t('system.receiverInfoDesc')}
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
            </CardBody>
          </Card>

          {/* 可选配置卡片 */}
          <Card shadow="none" radius="lg" classNames={{
            base: "border border-divider bg-content1"
          }}>
            <CardBody className="p-4 space-y-4">
              <div>
                <h4 className="font-semibold text-default-900 mb-1">{t('system.optionalConfig')}</h4>
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

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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

                <div className="flex items-center justify-between p-3 border border-divider rounded-lg">
                  <div>
                    <p className="text-sm font-medium text-default-700">{t('system.testServer')}</p>
                    <p className="text-xs text-default-500">{t('system.testServerDesc')}</p>
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
            </CardBody>
          </Card>

          {/* 统计信息卡片 */}
          <Card shadow="none" radius="lg" classNames={{
            base: "border border-divider bg-content1"
          }}>
            <CardBody className="p-4">
              <div className="flex items-center justify-between mb-3">
                <h4 className="font-semibold text-default-900">{t('system.runningStatus')}</h4>
                <Chip
                  size="sm"
                  color={pskrStatus?.isReporting ? 'primary' : 'default'}
                  variant="flat"
                >
                  {pskrStatus?.isReporting ? t('system.reporting') : t('system.waiting')}
                </Chip>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                <div>
                  <p className="text-default-500">{t('system.todayCount')}</p>
                  <p className="font-semibold text-default-900">
                    {pskrConfig.stats?.todayReportCount ?? 0}
                  </p>
                </div>
                <div>
                  <p className="text-default-500">{t('system.totalCount')}</p>
                  <p className="font-semibold text-default-900">
                    {pskrConfig.stats?.totalReportCount ?? 0}
                  </p>
                </div>
                <div>
                  <p className="text-default-500">{t('system.lastReport')}</p>
                  <p className="font-semibold text-default-900">
                    {formatTime(pskrStatus?.lastReportTime)}
                  </p>
                </div>
                <div>
                  <p className="text-default-500">{t('system.nextReport')}</p>
                  <p className="font-semibold text-default-900">
                    {formatNextReport(pskrStatus?.nextReportIn)}
                  </p>
                </div>
              </div>

              {pskrStatus?.lastError && (
                <div className="mt-3 p-2 bg-danger-50 border border-danger-200 rounded-lg">
                  <p className="text-sm text-danger-700">{pskrStatus.lastError}</p>
                </div>
              )}
            </CardBody>
          </Card>
        </>
      )}

      {/* 桌面应用设置 - 仅 Electron 环境显示 */}
      {isElectron && (
        <>
          <Divider className="my-4" />
          <Card shadow="none" radius="lg" classNames={{
            base: "border border-divider bg-content1"
          }}>
            <CardBody className="p-4">
              <div className="space-y-3">
                <div>
                  <h4 className="font-semibold text-default-900 mb-1">{t('system.closeBehavior')}</h4>
                  <p className="text-sm text-default-600">{t('system.closeBehaviorDesc')}</p>
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
