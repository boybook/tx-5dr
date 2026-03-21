import React, { useState, useEffect, forwardRef, useImperativeHandle, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Card,
  CardBody,
  Switch,
  Input,
  Select,
  SelectItem,
  Chip,
  Divider,
} from '@heroui/react';
import { api, ApiError } from '@tx5dr/core';
import type { PSKReporterConfig, PSKReporterStatus, AuthStatus } from '@tx5dr/contracts';
import { showErrorToast } from '../utils/errorToast';

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

  // 加载配置
  useEffect(() => {
    loadSettings();
    loadAuthConfig();
    loadPSKReporterConfig();
    loadPSKReporterStatus();
  }, []);

  const loadSettings = async () => {
    try {
      const result = await api.getFT8Settings();
      const decodeValue = result.data?.decodeWhileTransmitting ?? false;
      const spectrumValue = result.data?.spectrumWhileTransmitting ?? true;

      setDecodeWhileTransmitting(decodeValue);
      setOriginalDecodeValue(decodeValue);
      setSpectrumWhileTransmitting(spectrumValue);
      setOriginalSpectrumValue(spectrumValue);
    } catch (err) {
      console.error('加载FT8配置失败:', err);
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
      console.error('加载认证配置失败:', err);
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
      console.error('加载 PSKReporter 配置失败:', err);
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
      console.error('加载 PSKReporter 状态失败:', err);
    } finally {
      setPskrStatusLoading(false);
    }
  }, []);

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

  // 检查是否有未保存的更改
  const hasUnsavedChanges = () => {
    return (
      decodeWhileTransmitting !== originalDecodeValue ||
      spectrumWhileTransmitting !== originalSpectrumValue ||
      hasAuthChanges() ||
      hasPskrChanges()
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

      onUnsavedChanges?.(false);
    } catch (err) {
      console.error('保存配置失败:', err);
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
  }, [decodeWhileTransmitting, spectrumWhileTransmitting, originalDecodeValue, originalSpectrumValue, authConfig, originalAuthConfig, pskrConfig, originalPskrConfig, onUnsavedChanges]);

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
        <Card shadow="none" radius="lg" classNames={{
          base: "border border-divider bg-content1"
        }}>
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
          </CardBody>
        </Card>
      )}

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
