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

export interface QRZSettingsRef {
  hasUnsavedChanges: () => boolean;
  save: () => Promise<void>;
}

interface QRZSettingsProps {
  onUnsavedChanges?: (hasChanges: boolean) => void;
}

export const QRZSettings = forwardRef<QRZSettingsRef, QRZSettingsProps>(
  ({ onUnsavedChanges }, ref) => {
    const [config, setConfig] = useState<QRZConfig>({
      enabled: false,
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
        const response = await api.getQRZConfig();
        setConfig(response);
        setOriginalConfig(response);
      } catch (err) {
        setError(err instanceof Error ? err.message : '加载配置失败');
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
          message: '请先填写API Key'
        });
        return;
      }

      setTesting(true);
      setTestResult(null);
      setError('');

      try {
        const response = await api.testQRZConnection({
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
          message: err instanceof Error ? err.message : '连接失败'
        });
      } finally {
        setTesting(false);
      }
    };

    // 保存配置
    const handleSave = async () => {
      try {
        setError('');
        await api.updateQRZConfig(config);
        setOriginalConfig({ ...config });
        setHasChanges(false);
        onUnsavedChanges?.(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : '保存配置失败');
        throw err;
      }
    };

    if (loading) {
      return (
        <div className="flex justify-center items-center py-8">
          <Spinner size="md" />
          <span className="ml-2">加载QRZ.com配置中...</span>
        </div>
      );
    }

    return (
      <div className="space-y-6">
        <div>
          <h3 className="text-lg font-semibold">QRZ.com Logbook 同步设置</h3>
          <p className="text-sm text-default-500 mt-1">
            将通联日志同步到 QRZ.com Logbook
          </p>
        </div>

        {error && (
          <Alert color="danger" title="错误" className="mb-4">
            <p className="font-medium">{error}</p>
          </Alert>
        )}

        {/* 启用开关 */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <FontAwesomeIcon icon={faPlug} className="text-primary" />
              <span className="font-medium">启用QRZ.com同步</span>
            </div>
          </CardHeader>
          <CardBody>
            <Switch
              isSelected={config.enabled}
              onValueChange={(enabled) => updateConfig('enabled', enabled)}
              size="md"
            >
              {config.enabled ? '已启用' : '已禁用'}
            </Switch>
            <p className="text-xs text-default-500 mt-2">
              启用后将自动与QRZ.com Logbook同步通联日志
            </p>
          </CardBody>
        </Card>

        {/* API密钥设置 */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <FontAwesomeIcon icon={faKey} className="text-primary" />
              <span className="font-medium">API 密钥设置</span>
            </div>
          </CardHeader>
          <CardBody className="space-y-4">
            <Input
              label="API Key"
              placeholder="输入QRZ.com API Key"
              value={config.apiKey}
              onChange={(e) => updateConfig('apiKey', e.target.value)}
              isRequired
              type="password"
              description="在 QRZ.com → My Logbook → Settings 中获取 API Key"
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
                {testing ? '测试中...' : '测试连接'}
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
              <Alert color="success" title="连接成功">
                <div className="space-y-1">
                  <p>呼号: {testResult.callsign}</p>
                  {testResult.logbookCount !== undefined && (
                    <p>Logbook 共有 {testResult.logbookCount} 条 QSO 记录</p>
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
              <span className="font-medium">同步选项</span>
            </div>
          </CardHeader>
          <CardBody className="space-y-4">
            <Switch
              isSelected={config.autoUploadQSO}
              onValueChange={(enabled) => updateConfig('autoUploadQSO', enabled)}
              size="sm"
            >
              自动上传新QSO
            </Switch>
            <p className="text-xs text-default-500 ml-6 -mt-2">
              成功完成QSO后自动上传到QRZ.com Logbook
            </p>

            <div className="p-3 bg-primary-50 rounded-lg border border-primary-200">
              <div className="flex items-start gap-2">
                <FontAwesomeIcon icon={faSync} className="text-primary-600 mt-1" />
                <div>
                  <p className="text-sm font-medium text-primary-800">下载与手动同步</p>
                  <p className="text-xs text-primary-700 mt-1">
                    下载和手动同步请在<strong>通联日志页面</strong>操作。
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
                <p>最后同步时间：{new Date(config.lastSyncTime).toLocaleString('zh-CN', { timeZone: 'UTC' })} UTC</p>
              </div>
            </CardBody>
          </Card>
        )}

        {/* 使用说明 */}
        <div className="p-4 bg-default-50 rounded-lg">
          <h5 className="text-sm font-medium text-default-700 mb-2">使用说明</h5>
          <ul className="text-xs text-default-600 space-y-1">
            <li>• QRZ.com Logbook API 需要 XML Logbook Data 订阅</li>
            <li>• 上传的 QSO 使用 ADIF 格式</li>
          </ul>
        </div>
      </div>
    );
  }
);

QRZSettings.displayName = 'QRZSettings';
