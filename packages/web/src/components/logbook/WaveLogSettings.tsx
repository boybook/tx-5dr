import React, { useState, useEffect, forwardRef, useImperativeHandle } from 'react';
import {
  Button,
  Input,
  Select,
  SelectItem,
  Switch,
  Card,
  CardBody,
  CardHeader,
  Chip,
  Spinner,
  Alert
} from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPlug, faServer, faSync, faCheck, faExclamationTriangle } from '@fortawesome/free-solid-svg-icons';
import { api } from '@tx5dr/core';
import type {
  WaveLogConfig,
  WaveLogStation
} from '@tx5dr/contracts';
import { useTranslation } from 'react-i18next';
import { formatDateTime } from '../../utils/dateFormatting';

export interface WaveLogSettingsRef {
  hasUnsavedChanges: () => boolean;
  save: () => Promise<void>;
}

interface WaveLogSettingsProps {
  callsign: string;
  onUnsavedChanges?: (hasChanges: boolean) => void;
}

export const WaveLogSettings = forwardRef<WaveLogSettingsRef, WaveLogSettingsProps>(
  ({ callsign, onUnsavedChanges }, ref) => {
    const { t } = useTranslation('logbook');
    const [config, setConfig] = useState<WaveLogConfig>({
      url: '',
      apiKey: '',
      stationId: '',
      radioName: 'TX5DR',
      autoUploadQSO: true,
    });

    const [originalConfig, setOriginalConfig] = useState<WaveLogConfig>(config);
    const [stations, setStations] = useState<WaveLogStation[]>([]);
    const [loading, setLoading] = useState(true);
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState<{
      success: boolean;
      message: string;
    } | null>(null);
    const [error, setError] = useState<string>('');
    const [hasChanges, setHasChanges] = useState(false);

    // 暴露给父组件的方法
    useImperativeHandle(ref, () => ({
      hasUnsavedChanges: () => hasChanges,
      save: handleSave
    }));

    // 加载WaveLog配置
    const loadConfig = async () => {
      try {
        setLoading(true);
        setError('');
        const response = await api.getWaveLogConfig(callsign) as Record<string, unknown>;
        const data = response?.config || response;
        if (data && typeof data === 'object') {
          setConfig(prev => ({ ...prev, ...data }));
          setOriginalConfig(prev => ({ ...prev, ...data }));
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : t('wavelogSettings.loadConfigFailed'));
      } finally {
        setLoading(false);
      }
    };

    useEffect(() => {
      loadConfig();
    }, []);

    // 检查配置是否有变化
    useEffect(() => {
      const hasAnyChanges = JSON.stringify(config) !== JSON.stringify(originalConfig);
      setHasChanges(hasAnyChanges);
      onUnsavedChanges?.(hasAnyChanges);
    }, [config, originalConfig, onUnsavedChanges]);

    // 更新配置字段
    const updateConfig = (field: keyof WaveLogConfig, value: string | boolean | number) => {
      setConfig(prev => ({
        ...prev,
        [field]: value
      }));

      // 清除之前的测试结果
      if (field === 'url' || field === 'apiKey') {
        setTestResult(null);
        setStations([]);
      }
    };

    // 测试连接并获取Station列表
    const testConnection = async () => {
      if (!config.url || !config.apiKey) {
        setTestResult({
          success: false,
          message: t('wavelogSettings.fillUrlApiKey')
        });
        return;
      }

      setTesting(true);
      setTestResult(null);
      setError('');

      try {
        const response = await api.testWaveLogConnection(callsign, {
          url: config.url,
          apiKey: config.apiKey
        });

        setTestResult({
          success: response.success,
          message: response.message
        });

        if (response.success && response.stations) {
          setStations(response.stations);
          // 如果当前没有选择station且只有一个可用，自动选择
          if (!config.stationId && response.stations.length === 1) {
            updateConfig('stationId', response.stations[0].station_id);
          }
        }
      } catch (err) {
        setTestResult({
          success: false,
          message: err instanceof Error ? err.message : t('wavelogSettings.connectFailed')
        });
      } finally {
        setTesting(false);
      }
    };

    // 保存配置
    const handleSave = async () => {
      try {
        setError('');
        await api.updateWaveLogConfig(callsign, config);
        setOriginalConfig({ ...config });
        setHasChanges(false);
        onUnsavedChanges?.(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : t('wavelogSettings.saveConfigFailed'));
        throw err; // 重新抛出错误，让上层处理
      }
    };

    if (loading) {
      return (
        <div className="flex justify-center items-center py-8">
          <Spinner size="md" />
          <span className="ml-2">{t('wavelogSettings.loading')}</span>
        </div>
      );
    }

    return (
      <div className="space-y-6">
        <div>
          <h3 className="text-lg font-semibold">{t('wavelogSettings.title')}</h3>
          <p className="text-sm text-default-500 mt-1">
            {t('wavelogSettings.description')}
          </p>
        </div>

        {error && (
          <Alert color="danger" title={t('wavelogSettings.connectionError')} className="mb-4">
            <div className="space-y-2">
              <p className="font-medium">{error}</p>
              {error.includes(t('wavelogSettings.serverClosed')) && (
                <div className="text-sm bg-danger-50 p-3 rounded border">
                  <p className="font-medium text-danger-800 mb-2">{t('wavelogSettings.commonSolutions')}</p>
                  <ul className="list-disc list-inside text-danger-700 space-y-1">
                    <li>{t('wavelogSettings.solution1')}</li>
                    <li>{t('wavelogSettings.solution2')}</li>
                    <li>{t('wavelogSettings.solution3')}</li>
                    <li>{t('wavelogSettings.solution4')}</li>
                  </ul>
                </div>
              )}
              {error.includes(t('wavelogSettings.timeoutError')) && (
                <div className="text-sm bg-danger-50 p-3 rounded border">
                  <p className="font-medium text-danger-800 mb-2">{t('wavelogSettings.networkIssue')}</p>
                  <ul className="list-disc list-inside text-danger-700 space-y-1">
                    <li>{t('wavelogSettings.networkSolution1')}</li>
                    <li>{t('wavelogSettings.networkSolution2')}</li>
                    <li>{t('wavelogSettings.networkSolution3')}</li>
                  </ul>
                </div>
              )}
              {error.includes(t('wavelogSettings.dnsError')) && (
                <div className="text-sm bg-danger-50 p-3 rounded border">
                  <p className="font-medium text-danger-800 mb-2">{t('wavelogSettings.urlIssue')}</p>
                  <ul className="list-disc list-inside text-danger-700 space-y-1">
                    <li>{t('wavelogSettings.urlSolution1')}</li>
                    <li>{t('wavelogSettings.urlSolution2')}</li>
                    <li>{t('wavelogSettings.urlSolution3')}</li>
                  </ul>
                </div>
              )}
            </div>
          </Alert>
        )}

        {/* 连接设置 */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <FontAwesomeIcon icon={faServer} className="text-primary" />
              <span className="font-medium">{t('wavelogSettings.connectionSettings')}</span>
            </div>
          </CardHeader>
          <CardBody className="space-y-4">
            <Input
              label={t('wavelogSettings.urlLabel')}
              placeholder="https://your-wavelog.domain.com"
              value={config.url}
              onChange={(e) => updateConfig('url', e.target.value)}
              isRequired
              type="url"
              description={t('wavelogSettings.urlDesc')}
            />

            <Input
              label={t('wavelogSettings.apiKeyLabel')}
              placeholder={t('wavelogSettings.apiKeyPlaceholder')}
              value={config.apiKey}
              onChange={(e) => updateConfig('apiKey', e.target.value)}
              isRequired
              type="password"
              description={t('wavelogSettings.apiKeyDesc')}
            />

            <div className="flex gap-2">
              <Button
                color="primary"
                variant="flat"
                onPress={testConnection}
                isLoading={testing}
                isDisabled={!config.url || !config.apiKey}
                startContent={!testing && <FontAwesomeIcon icon={faPlug} />}
                className="flex-shrink-0"
              >
                {testing ? t('wavelogSettings.testing') : t('wavelogSettings.testConnection')}
              </Button>

              {testResult && (
                <div className="flex items-center gap-2 flex-1">
                  <Chip
                    size="sm"
                    color={testResult.success ? 'success' : 'danger'}
                    variant="flat"
                    startContent={
                      <FontAwesomeIcon
                        icon={testResult.success ? faCheck : faExclamationTriangle}
                      />
                    }
                  >
                    {testResult.message}
                  </Chip>
                </div>
              )}
            </div>

            {stations.length > 0 && (
              <Select
                label="Station"
                placeholder={t('wavelogSettings.stationPlaceholder')}
                selectedKeys={config.stationId ? [config.stationId] : []}
                onSelectionChange={(keys) => {
                  const selected = Array.from(keys as Set<string>)[0] || '';
                  updateConfig('stationId', selected);
                }}
                isRequired
                description={t('wavelogSettings.stationDesc')}
              >
                {stations.map((station) => (
                  <SelectItem key={station.station_id} textValue={station.station_profile_name}>
                    {station.station_profile_name}
                  </SelectItem>
                ))}
              </Select>
            )}

            <Input
              label={t('wavelogSettings.radioNameLabel')}
              placeholder="TX5DR"
              value={config.radioName}
              onChange={(e) => updateConfig('radioName', e.target.value)}
              description={t('wavelogSettings.radioNameDesc')}
            />
          </CardBody>
        </Card>

        {/* 同步选项 */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <FontAwesomeIcon icon={faSync} className="text-primary" />
              <span className="font-medium">{t('wavelogSettings.syncOptions')}</span>
            </div>
          </CardHeader>
          <CardBody className="space-y-4">
            <Switch
              isSelected={config.autoUploadQSO}
              onValueChange={(enabled) => updateConfig('autoUploadQSO', enabled)}
              size="sm"
            >
              {t('wavelogSettings.autoUpload')}
            </Switch>
            <p className="text-xs text-default-500 ml-6 -mt-2">
              {t('wavelogSettings.autoUploadDesc')}
            </p>

            <div className="p-3 bg-primary-50 rounded-lg border border-primary-200">
              <div className="flex items-start gap-2">
                <FontAwesomeIcon icon={faSync} className="text-primary-600 mt-1" />
                <div>
                  <p className="text-sm font-medium text-primary-800">{t('wavelogSettings.downloadSyncTitle')}</p>
                  <p className="text-xs text-primary-700 mt-1">
                    {t('wavelogSettings.downloadSyncDesc')}
                  </p>
                </div>
              </div>
            </div>
          </CardBody>
        </Card>

        {/* 状态信息 */}
        {config.lastSyncTime && (
          <Card>
            <CardBody>
              <div className="text-sm text-default-600">
                <p>{t('wavelogSettings.lastSync', { time: formatDateTime(config.lastSyncTime) })}</p>
              </div>
            </CardBody>
          </Card>
        )}

        {/* 说明信息 */}
        <div className="p-4 bg-default-50 rounded-lg">
          <h5 className="text-sm font-medium text-default-700 mb-2">{t('wavelogSettings.usageTitle')}</h5>
          <ul className="text-xs text-default-600 space-y-1">
            <li>• {t('wavelogSettings.usage1')}</li>
            <li>• {t('wavelogSettings.usage2')}</li>
            <li>• {t('wavelogSettings.usage3')}</li>
            <li>• {t('wavelogSettings.usage4')}</li>
            <li className="text-primary-600">• <strong>{t('wavelogSettings.usage5')}</strong></li>
          </ul>
        </div>
      </div>
    );
  }
);

WaveLogSettings.displayName = 'WaveLogSettings';
