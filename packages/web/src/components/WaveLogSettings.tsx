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

export interface WaveLogSettingsRef {
  hasUnsavedChanges: () => boolean;
  save: () => Promise<void>;
}

interface WaveLogSettingsProps {
  onUnsavedChanges?: (hasChanges: boolean) => void;
}

export const WaveLogSettings = forwardRef<WaveLogSettingsRef, WaveLogSettingsProps>(
  ({ onUnsavedChanges }, ref) => {
    const [config, setConfig] = useState<WaveLogConfig>({
      enabled: false,
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
        const response = await api.getWaveLogConfig();
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
          message: '请先填写WaveLog URL和API密钥'
        });
        return;
      }

      setTesting(true);
      setTestResult(null);
      setError('');

      try {
        const response = await api.testWaveLogConnection({
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
        await api.updateWaveLogConfig(config);
        setOriginalConfig({ ...config });
        setHasChanges(false);
        onUnsavedChanges?.(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : '保存配置失败');
        throw err; // 重新抛出错误，让上层处理
      }
    };

    if (loading) {
      return (
        <div className="flex justify-center items-center py-8">
          <Spinner size="md" />
          <span className="ml-2">加载WaveLog配置中...</span>
        </div>
      );
    }

    return (
      <div className="space-y-6">
        <div>
          <h3 className="text-lg font-semibold">WaveLog同步设置</h3>
          <p className="text-sm text-default-500 mt-1">
            配置与WaveLog服务器的连接和同步选项
          </p>
        </div>

        {error && (
          <Alert color="danger" title="连接错误" className="mb-4">
            <div className="space-y-2">
              <p className="font-medium">{error}</p>
              {error.includes('连接被服务器关闭') && (
                <div className="text-sm bg-danger-50 p-3 rounded border">
                  <p className="font-medium text-danger-800 mb-2">常见解决方案：</p>
                  <ul className="list-disc list-inside text-danger-700 space-y-1">
                    <li>检查WaveLog服务器是否正在运行</li>
                    <li>确认URL格式是否正确 (如: http://192.168.1.100:8086)</li>
                    <li>检查网络连接和防火墙设置</li>
                    <li>尝试在浏览器中直接访问WaveLog URL</li>
                  </ul>
                </div>
              )}
              {error.includes('连接超时') && (
                <div className="text-sm bg-danger-50 p-3 rounded border">
                  <p className="font-medium text-danger-800 mb-2">网络连接问题：</p>
                  <ul className="list-disc list-inside text-danger-700 space-y-1">
                    <li>检查网络连接是否稳定</li>
                    <li>确认WaveLog服务器响应正常</li>
                    <li>检查防火墙是否阻止连接</li>
                  </ul>
                </div>
              )}
              {error.includes('域名解析失败') && (
                <div className="text-sm bg-danger-50 p-3 rounded border">
                  <p className="font-medium text-danger-800 mb-2">URL地址问题：</p>
                  <ul className="list-disc list-inside text-danger-700 space-y-1">
                    <li>检查URL拼写是否正确</li>
                    <li>确认域名是否存在</li>
                    <li>如使用IP地址，确认IP是否正确</li>
                  </ul>
                </div>
              )}
            </div>
          </Alert>
        )}

        {/* 启用开关 */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <FontAwesomeIcon icon={faPlug} className="text-primary" />
              <span className="font-medium">启用WaveLog同步</span>
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
              启用后将自动与WaveLog服务器同步通联日志
            </p>
          </CardBody>
        </Card>

        {/* 连接设置 */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <FontAwesomeIcon icon={faServer} className="text-primary" />
              <span className="font-medium">连接设置</span>
            </div>
          </CardHeader>
          <CardBody className="space-y-4">
            <Input
              label="WaveLog URL"
              placeholder="https://your-wavelog.domain.com"
              value={config.url}
              onChange={(e) => updateConfig('url', e.target.value)}
              isDisabled={!config.enabled}
              isRequired
              type="url"
              description="完整的WaveLog服务器地址，包含协议(https://)"
            />

            <Input
              label="API密钥"
              placeholder="在WaveLog中生成的API密钥"
              value={config.apiKey}
              onChange={(e) => updateConfig('apiKey', e.target.value)}
              isDisabled={!config.enabled}
              isRequired
              type="password"
              description="在WaveLog右侧菜单 → API Keys 中生成"
            />

            <div className="flex gap-2">
              <Button
                color="primary"
                variant="flat"
                onPress={testConnection}
                isLoading={testing}
                isDisabled={!config.enabled || !config.url || !config.apiKey}
                startContent={!testing && <FontAwesomeIcon icon={faPlug} />}
                className="flex-shrink-0"
              >
                {testing ? '测试中...' : '测试连接'}
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
                label="Station配置"
                placeholder="选择要使用的Station配置"
                selectedKeys={config.stationId ? [config.stationId] : []}
                onSelectionChange={(keys) => {
                  const selected = Array.from(keys as Set<string>)[0] || '';
                  updateConfig('stationId', selected);
                }}
                isDisabled={!config.enabled}
                isRequired
                description="选择在WaveLog中创建的Station配置"
              >
                {stations.map((station) => (
                  <SelectItem key={station.station_id} textValue={station.station_profile_name}>
                    {station.station_profile_name}
                  </SelectItem>
                ))}
              </Select>
            )}

            <Input
              label="电台名称"
              placeholder="TX5DR"
              value={config.radioName}
              onChange={(e) => updateConfig('radioName', e.target.value)}
              isDisabled={!config.enabled}
              description="在WaveLog中显示的电台设备名称"
            />
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
              isDisabled={!config.enabled}
              size="sm"
            >
              自动上传新QSO
            </Switch>
            <p className="text-xs text-default-500 ml-6 -mt-2">
              成功完成QSO后自动上传到WaveLog服务器
            </p>

            <div className="p-3 bg-primary-50 rounded-lg border border-primary-200">
              <div className="flex items-start gap-2">
                <FontAwesomeIcon icon={faSync} className="text-primary-600 mt-1" />
                <div>
                  <p className="text-sm font-medium text-primary-800">下载同步说明</p>
                  <p className="text-xs text-primary-700 mt-1">
                    不提供自动下载同步功能。请在<strong>通联日志页面</strong>使用手动同步按钮来下载和同步WaveLog中的QSO记录。
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
                <p>最后同步时间：{new Date(config.lastSyncTime).toLocaleString('zh-CN', { timeZone: 'UTC' })} UTC</p>
              </div>
            </CardBody>
          </Card>
        )}

        {/* 说明信息 */}
        <div className="p-4 bg-default-50 rounded-lg">
          <h5 className="text-sm font-medium text-default-700 mb-2">使用说明</h5>
          <ul className="text-xs text-default-600 space-y-1">
            <li>• 需要WaveLog服务器启用HTTPS才能使用此功能</li>
            <li>• 在WaveLog的 Station Locations 中查看Station ID</li>
            <li>• 在WaveLog的 API Keys 中生成API密钥</li>
            <li>• 上传的QSO数据将使用ADIF格式</li>
            <li className="text-primary-600">• <strong>下载同步请在通联日志页面使用手动同步按钮</strong></li>
          </ul>
        </div>
      </div>
    );
  }
);

WaveLogSettings.displayName = 'WaveLogSettings';
