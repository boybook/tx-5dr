import React, { useState, useEffect, forwardRef, useImperativeHandle } from 'react';
import {
  Button,
  Input,
  Switch,
  Card,
  CardBody,
  CardHeader,
  Chip,
  Spinner,
  Alert
} from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPlug, faKey, faSync, faCheck, faExclamationTriangle } from '@fortawesome/free-solid-svg-icons';
import { api } from '@tx5dr/core';
import type { QRZConfig } from '@tx5dr/contracts';
import { useTranslation } from 'react-i18next';
import { formatDateTime } from '../../utils/dateFormatting';

export interface QRZSettingsRef {
  hasUnsavedChanges: () => boolean;
  save: () => Promise<void>;
}

interface QRZSettingsProps {
  callsign: string;
  onUnsavedChanges?: (hasChanges: boolean) => void;
}

export const QRZSettings = forwardRef<QRZSettingsRef, QRZSettingsProps>(
  ({ callsign, onUnsavedChanges }, ref) => {
    const { t } = useTranslation('logbook');
    const [config, setConfig] = useState<QRZConfig>({
      apiKey: '',
      autoUploadQSO: false,
    });

    const [originalConfig, setOriginalConfig] = useState<QRZConfig>(config);
    const [loading, setLoading] = useState(true);
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState<{
      success: boolean;
      message: string;
      callsign?: string;
      logbookCount?: number;
    } | null>(null);
    const [error, setError] = useState<string>('');
    const [hasChanges, setHasChanges] = useState(false);

    // 暴露给父组件的方法
    useImperativeHandle(ref, () => ({
      hasUnsavedChanges: () => hasChanges,
      save: handleSave
    }));

    // 加载QRZ配置
    const loadConfig = async () => {
      try {
        setLoading(true);
        setError('');
        const response = await api.getQRZConfig(callsign) as Record<string, unknown>;
        const data = response?.config || response;
        if (data && typeof data === 'object') {
          setConfig(prev => ({ ...prev, ...data }));
          setOriginalConfig(prev => ({ ...prev, ...data }));
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : t('qrzSettings.loadConfigFailed'));
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
    const updateConfig = (field: keyof QRZConfig, value: string | boolean | number) => {
      setConfig(prev => ({
        ...prev,
        [field]: value
      }));

      // 修改apiKey时清除测试结果
      if (field === 'apiKey') {
        setTestResult(null);
      }
    };

    // 测试连接
    const testConnection = async () => {
      if (!config.apiKey) {
        setTestResult({
          success: false,
          message: t('qrzSettings.fillApiKey')
        });
        return;
      }

      setTesting(true);
      setTestResult(null);
      setError('');

      try {
        const response = await api.testQRZConnection(callsign, {
          apiKey: config.apiKey
        });

        setTestResult({
          success: response.success,
          message: response.message,
          callsign: response.callsign,
          logbookCount: response.logbookCount,
        });
      } catch (err) {
        setTestResult({
          success: false,
          message: err instanceof Error ? err.message : t('qrzSettings.connectFailed')
        });
      } finally {
        setTesting(false);
      }
    };

    // 保存配置
    const handleSave = async () => {
      try {
        setError('');
        await api.updateQRZConfig(callsign, config);
        setOriginalConfig({ ...config });
        setHasChanges(false);
        onUnsavedChanges?.(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : t('qrzSettings.saveConfigFailed'));
        throw err;
      }
    };

    if (loading) {
      return (
        <div className="flex justify-center items-center py-8">
          <Spinner size="md" />
          <span className="ml-2">{t('qrzSettings.loading')}</span>
        </div>
      );
    }

    return (
      <div className="space-y-6">
        <div>
          <h3 className="text-lg font-semibold">{t('qrzSettings.title')}</h3>
          <p className="text-sm text-default-500 mt-1">
            {t('qrzSettings.description')}
          </p>
        </div>

        {error && (
          <Alert color="danger" title={t('qrzSettings.errorTitle')} className="mb-4">
            <p className="font-medium">{error}</p>
          </Alert>
        )}

        {/* API密钥设置 */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <FontAwesomeIcon icon={faKey} className="text-primary" />
              <span className="font-medium">{t('qrzSettings.apiKeySettings')}</span>
            </div>
          </CardHeader>
          <CardBody className="space-y-4">
            <Input
              label="API Key"
              placeholder={t('qrzSettings.apiKeyPlaceholder')}
              value={config.apiKey}
              onChange={(e) => updateConfig('apiKey', e.target.value)}
              isRequired
              type="password"
              description={t('qrzSettings.apiKeyDesc')}
            />

            <div className="flex gap-2">
              <Button
                color="primary"
                variant="flat"
                onPress={testConnection}
                isLoading={testing}
                isDisabled={!config.apiKey}
                startContent={!testing && <FontAwesomeIcon icon={faPlug} />}
                className="flex-shrink-0"
              >
                {testing ? t('qrzSettings.testing') : t('qrzSettings.testConnection')}
              </Button>

              {testResult && !testResult.success && (
                <div className="flex items-center gap-2 flex-1">
                  <Chip
                    size="sm"
                    color="danger"
                    variant="flat"
                    startContent={<FontAwesomeIcon icon={faExclamationTriangle} />}
                  >
                    {testResult.message}
                  </Chip>
                </div>
              )}

              {testResult && testResult.success && (
                <div className="flex items-center gap-2 flex-1">
                  <Chip
                    size="sm"
                    color="success"
                    variant="flat"
                    startContent={<FontAwesomeIcon icon={faCheck} />}
                  >
                    {testResult.message}
                  </Chip>
                </div>
              )}
            </div>

            {testResult?.success && testResult.callsign && (
              <Alert color="success" title={t('qrzSettings.connectSuccess')}>
                <div className="space-y-1">
                  <p>{t('qrzSettings.callsign', { callsign: testResult.callsign })}</p>
                  {testResult.logbookCount !== undefined && (
                    <p>{t('qrzSettings.logbookCount', { count: testResult.logbookCount })}</p>
                  )}
                </div>
              </Alert>
            )}
          </CardBody>
        </Card>

        {/* 同步选项 */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <FontAwesomeIcon icon={faSync} className="text-primary" />
              <span className="font-medium">{t('qrzSettings.syncOptions')}</span>
            </div>
          </CardHeader>
          <CardBody className="space-y-4">
            <Switch
              isSelected={config.autoUploadQSO}
              onValueChange={(enabled) => updateConfig('autoUploadQSO', enabled)}
              size="sm"
            >
              {t('qrzSettings.autoUpload')}
            </Switch>
            <p className="text-xs text-default-500 ml-6 -mt-2">
              {t('qrzSettings.autoUploadDesc')}
            </p>

            <div className="p-3 bg-primary-50 rounded-lg border border-primary-200">
              <div className="flex items-start gap-2">
                <FontAwesomeIcon icon={faSync} className="text-primary-600 mt-1" />
                <div>
                  <p className="text-sm font-medium text-primary-800">{t('qrzSettings.downloadSyncTitle')}</p>
                  <p className="text-xs text-primary-700 mt-1">
                    {t('qrzSettings.downloadSyncDesc')}
                  </p>
                </div>
              </div>
            </div>
          </CardBody>
        </Card>

        {/* 最后同步时间 */}
        {config.lastSyncTime && (
          <Card>
            <CardBody>
              <div className="text-sm text-default-600">
                <p>{t('qrzSettings.lastSync', { time: formatDateTime(config.lastSyncTime) })}</p>
              </div>
            </CardBody>
          </Card>
        )}

        {/* 使用说明 */}
        <div className="p-4 bg-default-50 rounded-lg">
          <h5 className="text-sm font-medium text-default-700 mb-2">{t('qrzSettings.usageTitle')}</h5>
          <ul className="text-xs text-default-600 space-y-1">
            <li>• {t('qrzSettings.usage1')}</li>
            <li>• {t('qrzSettings.usage2')}</li>
          </ul>
        </div>
      </div>
    );
  }
);

QRZSettings.displayName = 'QRZSettings';
