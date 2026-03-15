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
import { faPlug, faUser, faCertificate, faSync, faCheck, faExclamationTriangle, faSearch, faExternalLinkAlt } from '@fortawesome/free-solid-svg-icons';
import { api } from '@tx5dr/core';
import type {
  LoTWConfig,
  LoTWTQSLDetectResponse
} from '@tx5dr/contracts';

export interface LoTWSettingsRef {
  hasUnsavedChanges: () => boolean;
  save: () => Promise<void>;
}

interface LoTWSettingsProps {
  onUnsavedChanges?: (hasChanges: boolean) => void;
}

export const LoTWSettings = forwardRef<LoTWSettingsRef, LoTWSettingsProps>(
  ({ onUnsavedChanges }, ref) => {
    const [config, setConfig] = useState<LoTWConfig>({
      enabled: false,
      username: '',
      password: '',
      tqslPath: '',
      stationCallsign: '',
      autoUploadQSO: false,
    });

    const [originalConfig, setOriginalConfig] = useState<LoTWConfig>(config);
    const [loading, setLoading] = useState(true);
    const [hasChanges, setHasChanges] = useState(false);
    const [error, setError] = useState<string>('');
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState<{
      success: boolean;
      message: string;
    } | null>(null);
    const [detecting, setDetecting] = useState(false);
    const [detectResult, setDetectResult] = useState<LoTWTQSLDetectResponse | null>(null);
    const [tqslStations, setTqslStations] = useState<string[]>([]);

    // 暴露给父组件的方法
    useImperativeHandle(ref, () => ({
      hasUnsavedChanges: () => hasChanges,
      save: handleSave
    }));

    // 加载 LoTW 配置
    const loadConfig = async () => {
      try {
        setLoading(true);
        setError('');
        const response = await api.getLoTWConfig();
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
    const updateConfig = (field: keyof LoTWConfig, value: string | boolean | number) => {
      setConfig(prev => ({
        ...prev,
        [field]: value
      }));

      // 修改用户名/密码时清除验证结果
      if (field === 'username' || field === 'password') {
        setTestResult(null);
      }
    };

    // 验证账户
    const testConnection = async () => {
      if (!config.username || !config.password) {
        setTestResult({
          success: false,
          message: '请先填写用户名和密码'
        });
        return;
      }

      setTesting(true);
      setTestResult(null);
      setError('');

      try {
        const response = await api.testLoTWConnection({
          username: config.username,
          password: config.password
        });

        setTestResult({
          success: response.success,
          message: response.message
        });
      } catch (err) {
        setTestResult({
          success: false,
          message: err instanceof Error ? err.message : '验证失败'
        });
      } finally {
        setTesting(false);
      }
    };

    // 自动检测 TQSL
    const detectTQSL = async () => {
      setDetecting(true);
      setDetectResult(null);
      setError('');

      try {
        const response = await api.detectTQSL({
          tqslPath: config.tqslPath || undefined
        });

        setDetectResult(response);

        if (response.found) {
          // 检测成功，自动填入路径
          if (response.path) {
            updateConfig('tqslPath', response.path);
          }
          // 加载 station 列表
          if (response.stations && response.stations.length > 0) {
            setTqslStations(response.stations);
            // 如果只有一个 station，自动选择
            if (response.stations.length === 1 && !config.stationCallsign) {
              updateConfig('stationCallsign', response.stations[0]);
            }
          }
        }
      } catch (err) {
        setDetectResult({
          found: false,
          message: err instanceof Error ? err.message : '检测失败'
        });
      } finally {
        setDetecting(false);
      }
    };

    // 保存配置
    const handleSave = async () => {
      try {
        setError('');
        await api.updateLoTWConfig(config);
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
          <span className="ml-2">加载 LoTW 配置中...</span>
        </div>
      );
    }

    return (
      <div className="space-y-6">
        <div>
          <h3 className="text-lg font-semibold">LoTW 同步设置</h3>
          <p className="text-sm text-default-500 mt-1">
            ARRL Logbook of The World QSL 确认系统
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
              <span className="font-medium">启用 LoTW 同步</span>
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
              启用后可查询 QSL 确认状态并上传通联日志
            </p>
          </CardBody>
        </Card>

        {/* LoTW 账户 */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <FontAwesomeIcon icon={faUser} className="text-primary" />
              <span className="font-medium">LoTW 账户（下载确认用）</span>
            </div>
          </CardHeader>
          <CardBody className="space-y-4">
            <Input
              label="用户名（呼号）"
              placeholder="请输入您的呼号"
              value={config.username}
              onChange={(e) => updateConfig('username', e.target.value)}
              description="您在 LoTW 注册的呼号"
            />

            <Input
              label="密码"
              placeholder="请输入 LoTW 密码"
              value={config.password}
              onChange={(e) => updateConfig('password', e.target.value)}
              type="password"
              description="LoTW 网站登录密码"
            />

            <div className="flex gap-2">
              <Button
                color="primary"
                variant="flat"
                onPress={testConnection}
                isLoading={testing}
                isDisabled={!config.username || !config.password}
                startContent={!testing && <FontAwesomeIcon icon={faCheck} />}
                className="flex-shrink-0"
              >
                {testing ? '验证中...' : '验证账户'}
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

            {testResult?.success && (
              <Alert color="success">
                账户验证通过，可以下载 QSL 确认记录
              </Alert>
            )}
          </CardBody>
        </Card>

        {/* TQSL 签名工具 */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <FontAwesomeIcon icon={faCertificate} className="text-primary" />
              <span className="font-medium">TQSL 签名工具（上传日志用）</span>
            </div>
          </CardHeader>
          <CardBody className="space-y-4">
            <Alert color="primary">
              <div>
                <p className="text-sm">
                  上传到 LoTW 需要通过 ARRL 的 TQSL 工具对日志进行数字签名。请先安装 TQSL 并完成证书配置。
                </p>
                <Button
                  size="sm"
                  variant="flat"
                  color="primary"
                  className="mt-2"
                  startContent={<FontAwesomeIcon icon={faExternalLinkAlt} />}
                  onPress={() => window.open('https://lotw.arrl.org/lotw-help/installation/', '_blank')}
                >
                  下载 TQSL
                </Button>
              </div>
            </Alert>

            <div className="flex gap-2 items-end">
              <Input
                label="TQSL 路径"
                placeholder="TQSL 可执行文件路径"
                value={config.tqslPath}
                onChange={(e) => updateConfig('tqslPath', e.target.value)}
                description="TQSL 可执行文件的完整路径"
                className="flex-1"
              />
              <Button
                color="primary"
                variant="flat"
                onPress={detectTQSL}
                isLoading={detecting}
                startContent={!detecting && <FontAwesomeIcon icon={faSearch} />}
                className="flex-shrink-0 mb-6"
              >
                {detecting ? '检测中...' : '自动检测'}
              </Button>
            </div>

            {detectResult && detectResult.found && (
              <>
                <Alert color="success">
                  <div className="space-y-1">
                    <p className="text-sm font-medium">TQSL 版本: {detectResult.version}</p>
                    <p className="text-sm">路径: {detectResult.path}</p>
                  </div>
                </Alert>

                {tqslStations.length > 0 && (
                  <Select
                    label="Station Location"
                    placeholder="选择台站位置"
                    selectedKeys={config.stationCallsign ? [config.stationCallsign] : []}
                    onSelectionChange={(keys) => {
                      const selected = Array.from(keys as Set<string>)[0] || '';
                      updateConfig('stationCallsign', selected);
                    }}
                    description="选择 TQSL 中配置的台站位置"
                  >
                    {tqslStations.map((station) => (
                      <SelectItem key={station} textValue={station}>
                        {station}
                      </SelectItem>
                    ))}
                  </Select>
                )}
              </>
            )}

            {detectResult && !detectResult.found && (
              <Alert color="warning">
                未检测到 TQSL，请安装 TQSL 或手动指定路径
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
              isDisabled={!config.tqslPath || !config.stationCallsign}
              size="sm"
            >
              自动上传新 QSO
            </Switch>
            <p className="text-xs text-default-500 ml-6 -mt-2">
              完成通联后自动通过 TQSL 签名上传到 LoTW
            </p>

            <Alert color="primary">
              <div className="text-sm">
                <p className="font-medium">手动操作请前往「通联日志」页面：</p>
                <ul className="mt-1 space-y-1">
                  <li>• 「上传到 LoTW」— 通过 TQSL 签名上传</li>
                  <li>• 「下载确认」— 查询 QSL 确认状态</li>
                </ul>
              </div>
            </Alert>
          </CardBody>
        </Card>

        {/* 最后操作时间 */}
        {(config.lastUploadTime || config.lastDownloadTime) && (
          <Card>
            <CardBody>
              <div className="text-sm text-default-600 space-y-1">
                {config.lastUploadTime && (
                  <p>最后上传时间：{new Date(config.lastUploadTime).toLocaleString('zh-CN', { timeZone: 'UTC' })} UTC</p>
                )}
                {config.lastDownloadTime && (
                  <p>最后下载时间：{new Date(config.lastDownloadTime).toLocaleString('zh-CN', { timeZone: 'UTC' })} UTC</p>
                )}
              </div>
            </CardBody>
          </Card>
        )}

        {/* 使用说明 */}
        <div className="p-4 bg-default-50 rounded-lg">
          <h5 className="text-sm font-medium text-default-700 mb-2">使用说明</h5>
          <ul className="text-xs text-default-600 space-y-1">
            <li>• LoTW 是 ARRL 的官方 QSL 确认系统</li>
            <li>• 下载确认只需 LoTW 账户密码</li>
            <li>• 上传日志需要安装 TQSL 并配置数字证书</li>
            <li>• TQSL 证书需在 ARRL 网站申请并激活</li>
            <li>• 首次使用请先在 TQSL 中完成台站位置配置</li>
          </ul>
        </div>
      </div>
    );
  }
);

LoTWSettings.displayName = 'LoTWSettings';
