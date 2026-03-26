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
import { faUser, faCertificate, faSync, faCheck, faExclamationTriangle, faSearch, faExternalLinkAlt } from '@fortawesome/free-solid-svg-icons';
import { api } from '@tx5dr/core';
import type {
  LoTWConfig,
  LoTWTQSLDetectResponse
} from '@tx5dr/contracts';
import { useTranslation } from 'react-i18next';
import { formatDateTime } from '../utils/dateFormatting';

export interface LoTWSettingsRef {
  hasUnsavedChanges: () => boolean;
  save: () => Promise<void>;
}

interface LoTWSettingsProps {
  callsign: string;
  onUnsavedChanges?: (hasChanges: boolean) => void;
}

export const LoTWSettings = forwardRef<LoTWSettingsRef, LoTWSettingsProps>(
  ({ callsign, onUnsavedChanges }, ref) => {
    const { t } = useTranslation('logbook');
    const [config, setConfig] = useState<LoTWConfig>({
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
        const response = await api.getLoTWConfig(callsign) as Record<string, unknown>;
        const data = response?.config || response;
        if (data && typeof data === 'object') {
          setConfig(prev => ({ ...prev, ...data }));
          setOriginalConfig(prev => ({ ...prev, ...data }));
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : t('lotwSettings.loadConfigFailed'));
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
          message: t('lotwSettings.fillUsernamePassword')
        });
        return;
      }

      setTesting(true);
      setTestResult(null);
      setError('');

      try {
        const response = await api.testLoTWConnection(callsign, {
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
          message: err instanceof Error ? err.message : t('lotwSettings.verifyFailed')
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
        const response = await api.detectTQSL(callsign, {
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
          message: err instanceof Error ? err.message : t('lotwSettings.detectFailed')
        });
      } finally {
        setDetecting(false);
      }
    };

    // 保存配置
    const handleSave = async () => {
      try {
        setError('');
        await api.updateLoTWConfig(callsign, config);
        setOriginalConfig({ ...config });
        setHasChanges(false);
        onUnsavedChanges?.(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : t('lotwSettings.saveConfigFailed'));
        throw err;
      }
    };

    if (loading) {
      return (
        <div className="flex justify-center items-center py-8">
          <Spinner size="md" />
          <span className="ml-2">{t('lotwSettings.loading')}</span>
        </div>
      );
    }

    return (
      <div className="space-y-6">
        <div>
          <h3 className="text-lg font-semibold">{t('lotwSettings.title')}</h3>
          <p className="text-sm text-default-500 mt-1">
            {t('lotwSettings.description')}
          </p>
        </div>

        {error && (
          <Alert color="danger" title={t('lotwSettings.errorTitle')} className="mb-4">
            <p className="font-medium">{error}</p>
          </Alert>
        )}

        {/* LoTW 账户 */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <FontAwesomeIcon icon={faUser} className="text-primary" />
              <span className="font-medium">{t('lotwSettings.account')}</span>
            </div>
          </CardHeader>
          <CardBody className="space-y-4">
            <Input
              label={t('lotwSettings.usernameLabel')}
              placeholder={t('lotwSettings.usernamePlaceholder')}
              value={config.username}
              onChange={(e) => updateConfig('username', e.target.value)}
              description={t('lotwSettings.usernameDesc')}
            />

            <Input
              label={t('lotwSettings.passwordLabel')}
              placeholder={t('lotwSettings.passwordPlaceholder')}
              value={config.password}
              onChange={(e) => updateConfig('password', e.target.value)}
              type="password"
              description={t('lotwSettings.passwordDesc')}
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
                {testing ? t('lotwSettings.verifying') : t('lotwSettings.verifyAccount')}
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
                {t('lotwSettings.verifySuccess')}
              </Alert>
            )}
          </CardBody>
        </Card>

        {/* TQSL 签名工具 */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <FontAwesomeIcon icon={faCertificate} className="text-primary" />
              <span className="font-medium">{t('lotwSettings.tqslTitle')}</span>
            </div>
          </CardHeader>
          <CardBody className="space-y-4">
            <Alert color="primary">
              <div>
                <p className="text-sm">
                  {t('lotwSettings.tqslInfo')}
                </p>
                <Button
                  size="sm"
                  variant="flat"
                  color="primary"
                  className="mt-2"
                  startContent={<FontAwesomeIcon icon={faExternalLinkAlt} />}
                  onPress={() => window.open('https://lotw.arrl.org/lotw-help/installation/', '_blank')}
                >
                  {t('lotwSettings.downloadTqsl')}
                </Button>
              </div>
            </Alert>

            <div className="flex gap-2 items-end">
              <Input
                label={t('lotwSettings.tqslPathLabel')}
                placeholder={t('lotwSettings.tqslPathPlaceholder')}
                value={config.tqslPath}
                onChange={(e) => updateConfig('tqslPath', e.target.value)}
                description={t('lotwSettings.tqslPathDesc')}
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
                {detecting ? t('lotwSettings.detecting') : t('lotwSettings.autoDetect')}
              </Button>
            </div>

            {detectResult && detectResult.found && (
              <>
                <Alert color="success">
                  <div className="space-y-1">
                    <p className="text-sm font-medium">{t('lotwSettings.tqslVersion', { version: detectResult.version })}</p>
                    <p className="text-sm">{t('lotwSettings.tqslPath', { path: detectResult.path })}</p>
                  </div>
                </Alert>

                {tqslStations.length > 0 && (
                  <Select
                    label="Station Location"
                    placeholder={t('lotwSettings.stationLocationPlaceholder')}
                    selectedKeys={config.stationCallsign ? [config.stationCallsign] : []}
                    onSelectionChange={(keys) => {
                      const selected = Array.from(keys as Set<string>)[0] || '';
                      updateConfig('stationCallsign', selected);
                    }}
                    description={t('lotwSettings.stationLocationDesc')}
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
                {t('lotwSettings.tqslNotFound')}
              </Alert>
            )}
          </CardBody>
        </Card>

        {/* 同步选项 */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <FontAwesomeIcon icon={faSync} className="text-primary" />
              <span className="font-medium">{t('lotwSettings.syncOptions')}</span>
            </div>
          </CardHeader>
          <CardBody className="space-y-4">
            <Switch
              isSelected={config.autoUploadQSO}
              onValueChange={(enabled) => updateConfig('autoUploadQSO', enabled)}
              isDisabled={!config.tqslPath || !config.stationCallsign}
              size="sm"
            >
              {t('lotwSettings.autoUpload')}
            </Switch>
            <p className="text-xs text-default-500 ml-6 -mt-2">
              {t('lotwSettings.autoUploadDesc')}
            </p>

            <Alert color="primary">
              <div className="text-sm">
                <p className="font-medium">{t('lotwSettings.manualOpsInfo')}</p>
                <ul className="mt-1 space-y-1">
                  <li>• {t('lotwSettings.manualUpload')}</li>
                  <li>• {t('lotwSettings.manualDownload')}</li>
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
                  <p>{t('lotwSettings.lastUpload', { time: formatDateTime(config.lastUploadTime) })}</p>
                )}
                {config.lastDownloadTime && (
                  <p>{t('lotwSettings.lastDownload', { time: formatDateTime(config.lastDownloadTime) })}</p>
                )}
              </div>
            </CardBody>
          </Card>
        )}

        {/* 使用说明 */}
        <div className="p-4 bg-default-50 rounded-lg">
          <h5 className="text-sm font-medium text-default-700 mb-2">{t('lotwSettings.usageTitle')}</h5>
          <ul className="text-xs text-default-600 space-y-1">
            <li>• {t('lotwSettings.usage1')}</li>
            <li>• {t('lotwSettings.usage2')}</li>
            <li>• {t('lotwSettings.usage3')}</li>
            <li>• {t('lotwSettings.usage4')}</li>
            <li>• {t('lotwSettings.usage5')}</li>
          </ul>
        </div>
      </div>
    );
  }
);

LoTWSettings.displayName = 'LoTWSettings';
