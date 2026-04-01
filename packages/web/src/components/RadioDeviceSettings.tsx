import React, { useState, useEffect, forwardRef, useImperativeHandle, useRef } from 'react';
import { createLogger } from '../utils/logger';
import { localizeHamlibConfigText } from '../utils/hamlibConfigTextMap';

const logger = createLogger('RadioDeviceSettings');
import { useTranslation } from 'react-i18next';
import { Input, Select, SelectItem, Autocomplete, AutocompleteItem, Tabs, Tab, Card, CardBody, Divider, Button, Chip, Tooltip, Accordion, AccordionItem } from '@heroui/react';
import { api, ApiError } from '@tx5dr/core';
import type { HamlibConfig, HamlibConfigField, PttMethod, RigConfigSchemaResponse } from '@tx5dr/contracts';

interface RigInfo {
  rigModel: number;
  mfgName: string;
  modelName: string;
}

interface PortInfo {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  pnpId?: string;
  vendorId?: string;
  productId?: string;
}

const HIDDEN_BACKEND_FIELD_NAMES = new Set([
  'rig_pathname',
  'ptt_type',
  'ptt_pathname',
  'ptt_bitnum',
  'dcd_type',
  'dcd_pathname',
]);

const CONNECTION_FIELD_ORDER = [
  'serial_speed',
  'serial_data_bits',
  'serial_stop_bits',
  'serial_parity',
  'serial_handshake',
  'timeout',
  'retry',
  'write_delay',
  'post_write_delay',
  'post_ptt_delay',
  'poll_interval',
  'client',
] as const;

const MULTICAST_FIELD_ORDER = [
  'multicast_data_addr',
  'multicast_data_port',
  'multicast_cmd_addr',
  'multicast_cmd_port',
] as const;

const CONNECTION_FIELD_NAME_SET = new Set(CONNECTION_FIELD_ORDER);
const MULTICAST_FIELD_NAME_SET = new Set(MULTICAST_FIELD_ORDER);
const FIELD_ORDER = [...CONNECTION_FIELD_ORDER, ...MULTICAST_FIELD_ORDER] as const;

function orderHamlibFields(fields: HamlibConfigField[]): HamlibConfigField[] {
  return [...fields].sort((left, right) => {
    const leftIndex = FIELD_ORDER.indexOf(left.name as typeof FIELD_ORDER[number]);
    const rightIndex = FIELD_ORDER.indexOf(right.name as typeof FIELD_ORDER[number]);

    const normalizedLeft = leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex;
    const normalizedRight = rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex;

    if (normalizedLeft !== normalizedRight) {
      return normalizedLeft - normalizedRight;
    }

    return left.name.localeCompare(right.name);
  });
}

function getFieldEffectiveDefaultValue(field: HamlibConfigField): string | undefined {
  return field.effectiveDefaultValue || field.defaultValue || undefined;
}

function formatFieldDefaultLabel(t: (key: string, options?: Record<string, unknown>) => string, field: HamlibConfigField): string | undefined {
  const effectiveDefaultValue = getFieldEffectiveDefaultValue(field);
  if (!effectiveDefaultValue) {
    return undefined;
  }

  if (field.type === 'checkbutton') {
    const normalized = effectiveDefaultValue.toLowerCase();
    const label = normalized === '1' || normalized === 'true'
      ? t('radio.toggleOn')
      : t('radio.toggleOff');
    return t('radio.defaultOption', { value: label });
  }

  return t('radio.defaultOption', { value: effectiveDefaultValue });
}

function buildFieldDescription(
  _t: (key: string, options?: Record<string, unknown>) => string,
  field: HamlibConfigField,
  tooltip: string | undefined,
): string | undefined {
  return tooltip || undefined;
}

export interface RadioDeviceSettingsRef {
  hasUnsavedChanges: () => boolean;
  save: () => Promise<void>;
}

interface RadioDeviceSettingsProps {
  onUnsavedChanges?: (hasChanges: boolean) => void;
  /** 受控模式：传入初始配置时不从 API 加载 */
  initialConfig?: HamlibConfig;
  /** 受控模式：配置变更回调 */
  onChange?: (config: HamlibConfig) => void;
}

export const RadioDeviceSettings = forwardRef<RadioDeviceSettingsRef, RadioDeviceSettingsProps>(
  ({ onUnsavedChanges, initialConfig, onChange }, ref) => {
  const { t, i18n } = useTranslation('settings');
  const isControlled = initialConfig !== undefined;
  const [config, setConfig] = useState<HamlibConfig>(initialConfig ?? { type: 'none' } as HamlibConfig);
  const [originalConfig, setOriginalConfig] = useState<HamlibConfig>(initialConfig ?? { type: 'none' } as HamlibConfig);
  const [rigs, setRigs] = useState<RigInfo[]>([]);
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [rigConfigSchema, setRigConfigSchema] = useState<RigConfigSchemaResponse | null>(null);
  const [_isSaving, setIsSaving] = useState(false);
  const [isTestingConnection, setIsTestingConnection] = useState(false);
  const [isTestingPTT, setIsTestingPTT] = useState(false);
  const [isRefreshingPorts, setIsRefreshingPorts] = useState(false);
  const [isLoadingRigConfigSchema, setIsLoadingRigConfigSchema] = useState(false);
  const [testResult, setTestResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const pendingEndpointKindResetRef = useRef<{
    previousEndpointKind: RigConfigSchemaResponse['endpointKind'] | null;
    rigModel: number;
  } | null>(null);

  const selectedRig = rigs.find((item) => item.rigModel === config.serial?.rigModel);
  const rigConfigFields = rigConfigSchema?.fields || [];
  const visibleRigConfigFields = orderHamlibFields(
    rigConfigFields.filter((field) => (
      field.type !== 'button' &&
      field.type !== 'binary' &&
      !HIDDEN_BACKEND_FIELD_NAMES.has(field.name)
    ))
  );
  const connectionRigConfigFields = visibleRigConfigFields.filter((field) => CONNECTION_FIELD_NAME_SET.has(field.name));
  const multicastRigConfigFields = visibleRigConfigFields.filter((field) => MULTICAST_FIELD_NAME_SET.has(field.name));
  const advancedRigConfigFields = visibleRigConfigFields.filter((field) => !CONNECTION_FIELD_NAME_SET.has(field.name) && !MULTICAST_FIELD_NAME_SET.has(field.name));
  const endpointKind = rigConfigSchema?.endpointKind;
  const usesSerialPortEndpoint = endpointKind === 'serial-port';
  const usesNetworkEndpoint = endpointKind === 'network-address';
  const usesDevicePathEndpoint = endpointKind === 'device-path';
  const effectiveRigPath = config.serial?.backendConfig?.rig_pathname ?? config.serial?.path ?? '';

    useEffect(() => {
      loadData();
    }, []);

    useEffect(() => {
      const rigModel = config.type === 'serial' ? config.serial?.rigModel : undefined;
      if (!rigModel) {
        setRigConfigSchema(null);
        return;
      }

      let cancelled = false;
      setIsLoadingRigConfigSchema(true);
      setRigConfigSchema(null);

      api.getRigConfigSchema(rigModel)
        .then((response) => {
          if (!cancelled) {
            setRigConfigSchema(response);

            const pendingReset = pendingEndpointKindResetRef.current;
            if (pendingReset && pendingReset.rigModel === rigModel) {
              pendingEndpointKindResetRef.current = null;

              if (pendingReset.previousEndpointKind && pendingReset.previousEndpointKind !== response.endpointKind) {
                setConfig((prev) => {
                  if (prev.type !== 'serial' || prev.serial?.rigModel !== rigModel) {
                    return prev;
                  }

                  const currentBackendConfig = prev.serial.backendConfig || {};
                  if (!prev.serial.path && !currentBackendConfig.rig_pathname) {
                    return prev;
                  }

                  const nextBackendConfig = { ...currentBackendConfig };
                  delete nextBackendConfig.rig_pathname;

                  const next = {
                    ...prev,
                    serial: {
                      ...prev.serial,
                      path: '',
                      backendConfig: nextBackendConfig,
                    },
                  };
                  onChange?.(next);
                  return next;
                });
              }
            }
          }
        })
        .catch((error) => {
          logger.error('Failed to load rig config schema:', error);
          if (!cancelled) {
            setRigConfigSchema(null);
          }
        })
        .finally(() => {
          if (!cancelled) {
            setIsLoadingRigConfigSchema(false);
          }
        });

      return () => {
        cancelled = true;
      };
    }, [config.type, config.serial?.rigModel, onChange]);

    const loadData = async () => {
      if (isControlled) {
        // 受控模式：只加载 rigs 和 ports 列表，不加载配置
        const [rigList, portList] = await Promise.all([
          api.getSupportedRigs(),
          api.getSerialPorts(),
        ]);
        setRigs(rigList.rigs || []);
        setPorts(portList.ports || []);
      } else {
        const [cfg, rigList, portList] = await Promise.all([
          api.getRadioConfig(),
          api.getSupportedRigs(),
          api.getSerialPorts(),
        ]);
        setConfig(cfg.config);
        setOriginalConfig(cfg.config);
        setRigs(rigList.rigs || []);
        setPorts(portList.ports || []);
      }
    };

    // 刷新串口列表
    const refreshPorts = async () => {
      setIsRefreshingPorts(true);
      try {
        const portList = await api.getSerialPorts();
        setPorts(portList.ports || []);
      } catch (error) {
        logger.error('Failed to refresh serial port list:', error);
      } finally {
        setIsRefreshingPorts(false);
      }
    };

    // 检查是否有未保存的更改
    const hasUnsavedChanges = () => {
      return JSON.stringify(config) !== JSON.stringify(originalConfig);
    };

    // 暴露方法给父组件
    useImperativeHandle(ref, () => ({
      hasUnsavedChanges,
      save: async () => {
        setIsSaving(true);
        try {
          await api.updateRadioConfig(config);
          setOriginalConfig({ ...config });
          onUnsavedChanges?.(false);
        } finally {
          setIsSaving(false);
        }
      },
    }), [config, originalConfig, onUnsavedChanges]);

    // 监听设置变化
    useEffect(() => {
      const hasChanges = hasUnsavedChanges();
      onUnsavedChanges?.(hasChanges);
    }, [config, originalConfig, onUnsavedChanges]);


      // 更新配置
  const updateConfig = (updates: Partial<HamlibConfig>) => {
    setConfig((prev) => {
      const next = { ...prev, ...updates };
      onChange?.(next);
      return next;
    });
    // 清除之前的测试结果
    setTestResult(null);
  };

  // 更新 Hamlib backend 配置
  const updateBackendConfig = (name: string, value?: string) => {
    setConfig((prev) => {
      const prevSerial = prev.serial;
      const backendConfig = { ...(prevSerial?.backendConfig || {}) };

      if (!value) {
        delete backendConfig[name];
      } else {
        backendConfig[name] = value;
      }

      const path = name === 'rig_pathname'
        ? (value || '')
        : (prevSerial?.path ?? backendConfig.rig_pathname ?? '');

      const next = {
        ...prev,
        serial: {
          path,
          rigModel: prevSerial?.rigModel ?? 0,
          serialConfig: prevSerial?.serialConfig,
          backendConfig,
        }
      };
      onChange?.(next);
      return next;
    });
    // 清除之前的测试结果
    setTestResult(null);
  };

  const getBackendValue = (name: string): string => {
    if (name === 'rig_pathname') {
      return config.serial?.backendConfig?.rig_pathname ?? config.serial?.path ?? '';
    }
    return config.serial?.backendConfig?.[name] ?? '';
  };

  const renderHamlibConfigField = (field: HamlibConfigField) => {
    const currentValue = getBackendValue(field.name);
    const effectiveDefaultValue = getFieldEffectiveDefaultValue(field);
    const defaultLabel = formatFieldDefaultLabel(t, field);
    const localizedTooltip = localizeHamlibConfigText(field.tooltip, 'tooltip', i18n.language);
    const description = buildFieldDescription(t, field, localizedTooltip);
    const label = localizeHamlibConfigText(field.label, 'label', i18n.language) || field.name;

    if (field.name.endsWith('pathname')) {
      return (
        <Autocomplete
          key={field.name}
          label={label}
          description={description}
          allowsCustomValue
          inputValue={currentValue}
          selectedKey={currentValue || null}
          onInputChange={value => updateBackendConfig(field.name, value || undefined)}
          onSelectionChange={selectedKey => {
            if (selectedKey !== null) {
              updateBackendConfig(field.name, String(selectedKey) || undefined);
            }
          }}
          variant="flat"
          size="md"
          placeholder={effectiveDefaultValue || undefined}
          defaultItems={ports}
        >
          {(item: PortInfo) => (
            <AutocompleteItem key={item.path} textValue={item.path}>
              {item.path}
            </AutocompleteItem>
          )}
        </Autocomplete>
      );
    }

    if (field.type === 'combo' && field.options?.length) {
      return (
        <Select
          key={field.name}
          label={label}
          description={description}
          size="sm"
          selectedKeys={currentValue ? [currentValue] : []}
          onSelectionChange={keys => {
            const value = Array.from(keys)[0] as string | undefined;
            updateBackendConfig(field.name, value === '__default__' ? undefined : (value || undefined));
          }}
          variant="flat"
          placeholder={defaultLabel}
        >
          {defaultLabel ? (
            <SelectItem key="__default__" textValue={defaultLabel}>{defaultLabel}</SelectItem>
          ) : null}
          {field.options.map((option) => (
            <SelectItem key={option} textValue={option}>{option}</SelectItem>
          ))}
        </Select>
      );
    }

    if (field.type === 'checkbutton') {
      return (
        <Select
          key={field.name}
          label={label}
          description={description}
          size="sm"
          selectedKeys={currentValue ? [currentValue] : []}
          onSelectionChange={keys => {
            const value = Array.from(keys)[0] as string | undefined;
            if (value === '__default__' || !value) {
              updateBackendConfig(field.name, undefined);
              return;
            }
            updateBackendConfig(field.name, value === '1' ? '1' : '0');
          }}
          variant="flat"
          placeholder={defaultLabel}
        >
          {defaultLabel ? (
            <SelectItem key="__default__" textValue={defaultLabel}>{defaultLabel}</SelectItem>
          ) : null}
          <SelectItem key="1" textValue="1">{t('radio.toggleOn')}</SelectItem>
          <SelectItem key="0" textValue="0">{t('radio.toggleOff')}</SelectItem>
        </Select>
      );
    }

    const isNumeric = field.type === 'numeric' || field.type === 'int';

    return (
      <Input
        key={field.name}
        label={label}
        description={description}
        size="sm"
        type={isNumeric ? 'number' : field.name.toLowerCase().includes('password') ? 'password' : 'text'}
        min={field.numeric?.min !== undefined ? String(field.numeric.min) : undefined}
        max={field.numeric?.max !== undefined ? String(field.numeric.max) : undefined}
        step={field.numeric?.step !== undefined ? String(field.numeric.step) : undefined}
        value={currentValue}
        onChange={e => updateBackendConfig(field.name, e.target.value || undefined)}
        variant="flat"
        placeholder={effectiveDefaultValue || undefined}
      />
    );
  };

  // 测试连接
  const handleTestConnection = async () => {
    if (config.type === 'none') {
      setTestResult({ type: 'error', message: t('radio.noRadioNoTest') });
      return;
    }

    setIsTestingConnection(true);
    setTestResult(null);

    try {
      const response = await api.testRadio(config);
      if (response.success) {
        setTestResult({ type: 'success', message: t('radio.testConnectionSuccess') });
      } else {
        setTestResult({ type: 'error', message: response.message || t('radio.testConnectionFailed') });
      }
    } catch (error) {
      setTestResult({
        type: 'error',
        message: error instanceof ApiError
          ? t(`radio.testError.${error.code}`, { defaultValue: error.userMessage })
          : (error instanceof Error ? error.message : t('radio.testConnectionFailedCheck'))
      });
    } finally {
      setIsTestingConnection(false);
    }
  };

  // 测试PTT
  const handleTestPTT = async () => {
    setIsTestingPTT(true);
    setTestResult(null);

    try {
      const response = await api.testPTT(config);
      if (response.success) {
        setTestResult({ type: 'success', message: t('radio.testPTTSuccess') });
      } else {
        setTestResult({ type: 'error', message: response.message || t('radio.testPTTFailed') });
      }
    } catch (error) {
      setTestResult({
        type: 'error',
        message: error instanceof Error ? error.message : t('radio.testPTTFailedCheck')
      });
    } finally {
      setIsTestingPTT(false);
    }
  };

    // 渲染 PTT 配置区块（仅 serial / network 模式）
    const renderPttConfig = () => {
      const currentMethod = config.pttMethod || 'cat';
      const isNetwork = config.type === 'network';

      return (
        <div className="space-y-3">
          <h5 className="text-sm font-medium text-default-700">{t('radio.pttSection')}</h5>
          <Select
            label={t('radio.pttMethod')}
            size="sm"
            selectedKeys={[currentMethod]}
            onSelectionChange={keys => {
              const method = Array.from(keys)[0] as PttMethod;
              if (method === 'cat' || method === 'vox') {
                updateConfig({ pttMethod: method, pttPort: undefined });
              } else {
                updateConfig({ pttMethod: method });
              }
            }}
            variant="flat"
          >
            <SelectItem key="cat" textValue={t('radio.pttCat')}>{t('radio.pttCat')}</SelectItem>
            <SelectItem key="vox" textValue={t('radio.pttVox')}>{t('radio.pttVox')}</SelectItem>
            {isNetwork ? (
              <SelectItem key="dtr" textValue={t('radio.pttDtrDisabled')} isDisabled>{t('radio.pttDtrDisabled')}</SelectItem>
            ) : (
              <SelectItem key="dtr" textValue={t('radio.pttDtr')}>{t('radio.pttDtr')}</SelectItem>
            )}
            {isNetwork ? (
              <SelectItem key="rts" textValue={t('radio.pttRtsDisabled')} isDisabled>{t('radio.pttRtsDisabled')}</SelectItem>
            ) : (
              <SelectItem key="rts" textValue={t('radio.pttRts')}>{t('radio.pttRts')}</SelectItem>
            )}
          </Select>

          {/* 仅 DTR/RTS 时显示独立 PTT 串口选择（支持手动输入） */}
          {(currentMethod === 'dtr' || currentMethod === 'rts') && (
            <Autocomplete
              label={t('radio.pttPort')}
              size="sm"
              allowsCustomValue
              inputValue={config.pttPort || ''}
              selectedKey={config.pttPort || null}
              onInputChange={value => {
                updateConfig({ pttPort: value || undefined });
              }}
              onSelectionChange={key => {
                if (key !== null) {
                  updateConfig({ pttPort: String(key) || undefined });
                }
              }}
              variant="flat"
              placeholder={t('radio.pttPortPlaceholder')}
              description={t('radio.pttPortDesc')}
              defaultItems={ports}
            >
              {(item: PortInfo) => (
                <AutocompleteItem key={item.path} textValue={item.path}>
                  {item.path}
                </AutocompleteItem>
              )}
            </Autocomplete>
          )}

          <div className="text-xs text-default-400 space-y-1 bg-default-50 p-3 rounded-lg">
            <p className="font-medium">{t('radio.pttMethodNote')}</p>
            <p>• <strong>CAT</strong>：{t('radio.pttCatDesc')}</p>
            <p>• <strong>VOX</strong>：{t('radio.pttVoxDesc')}</p>
            <p>• <strong>DTR/RTS</strong>：{t('radio.pttDtrRtsDesc')}</p>
          </div>
        </div>
      );
    };

    // 渲染配置内容
    const renderConfigContent = () => {
      switch (config.type) {
        case 'network':
          return (
            <Card shadow="none" radius="lg" classNames={{ base: "border border-divider bg-content1" }}>
              <CardBody className="space-y-4 p-4">
                <h4 className="font-semibold text-default-900">{t('radio.networkTitle')}</h4>
                <p className="text-sm text-default-600">{t('radio.networkDesc')}</p>
                <Divider />
                <div className="space-y-4">
                  <Input
                    label={t('radio.host')}
                    placeholder="localhost"
                    value={config.network?.host || ''}
                    onChange={e => updateConfig({ network: { host: e.target.value, port: config.network?.port ?? 4532 } })}
                  />
                  <Input
                    label={t('radio.port')}
                    placeholder="4532"
                    type="number"
                    value={String(config.network?.port ?? '')}
                    onChange={e => updateConfig({ network: { host: config.network?.host ?? 'localhost', port: Number(e.target.value) } })}
                  />
                  <Divider />
                  {renderPttConfig()}
                  <Divider />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="flat"
                      color="primary"
                      onPress={handleTestConnection}
                      isLoading={isTestingConnection}
                      isDisabled={!config.network?.host || !config.network?.port || isTestingPTT}
                    >
                      {isTestingConnection ? t('radio.testingConnection') : t('radio.testConnection')}
                    </Button>
                    <Button
                      size="sm"
                      variant="flat"
                      color="secondary"
                      onPress={handleTestPTT}
                      isLoading={isTestingPTT}
                      isDisabled={!config.network?.host || !config.network?.port || config.pttMethod === 'vox' || isTestingConnection}
                    >
                      {config.pttMethod === 'vox' ? t('radio.voxNoTest') : isTestingPTT ? t('radio.testingPTT') : t('radio.testPTT')}
                    </Button>
                  </div>
                  {testResult && (
                    <Chip
                      color={testResult.type === 'success' ? 'success' : 'danger'}
                      variant="flat"
                      className="w-full"
                    >
                      {testResult.message}
                    </Chip>
                  )}

                  <Divider />

                  <div className="space-y-3">
                    <h5 className="text-sm font-medium text-default-700">
                      ⏱️ {t('radio.txCompensation')}
                    </h5>
                    <p className="text-xs text-default-500">
                      {t('radio.txCompensationNetworkDesc')}
                    </p>

                    <div className="flex items-center gap-3">
                      <Input
                        type="number"
                        label={t('radio.compensationValue')}
                        value={(config.transmitCompensationMs || 0).toString()}
                        onChange={e => {
                          const value = parseInt(e.target.value) || 0;
                          updateConfig({ transmitCompensationMs: value });
                        }}
                        min="-1000"
                        max="1000"
                        endContent={<span className="text-small text-default-400">ms</span>}
                        size="sm"
                        className="w-40"
                      />
                    </div>

                    <div className="flex gap-2 flex-wrap">
                      <Chip
                        size="sm"
                        variant="flat"
                        color="default"
                        onClick={() => updateConfig({ transmitCompensationMs: 0 })}
                        className="cursor-pointer hover:bg-default-200"
                      >
                        0ms
                      </Chip>
                      <Chip
                        size="sm"
                        variant="flat"
                        color="primary"
                        onClick={() => updateConfig({ transmitCompensationMs: 50 })}
                        className="cursor-pointer hover:bg-primary-100"
                      >
                        50ms（{t('radio.wired')}）
                      </Chip>
                      <Chip
                        size="sm"
                        variant="flat"
                        color="primary"
                        onClick={() => updateConfig({ transmitCompensationMs: 100 })}
                        className="cursor-pointer hover:bg-primary-100"
                      >
                        100ms（{t('radio.recommended')}）
                      </Chip>
                      <Chip
                        size="sm"
                        variant="flat"
                        color="primary"
                        onClick={() => updateConfig({ transmitCompensationMs: 200 })}
                        className="cursor-pointer hover:bg-primary-100"
                      >
                        200ms（{t('radio.wireless')}）
                      </Chip>
                    </div>

                    <div className="text-xs text-default-400 space-y-1 bg-default-50 p-3 rounded-lg">
                      <p className="font-medium">💡 {t('radio.usageTips')}</p>
                      <p>• {t('radio.tipWiredNetwork')}</p>
                      <p>• {t('radio.tipWirelessNetwork')}</p>
                      <p>• {t('radio.tipRemoteControl')}</p>
                      <p className="text-danger-600 font-semibold">⚠️ {t('radio.tipLargeWarning')}</p>
                      <p>• {t('radio.tipAdjustByStats')}</p>
                    </div>
                  </div>
                </div>
              </CardBody>
            </Card>
          );
        case 'serial':
          return (
            <Card shadow="none" radius="lg" classNames={{ base: "border border-divider bg-content1" }}>
              <CardBody className="space-y-4 p-4">
                <div className="flex items-center justify-between">
                  <h4 className="font-semibold text-default-900">{t('radio.serialTitle')}</h4>
                  {usesSerialPortEndpoint && (
                    <Tooltip content={t('radio.refreshPortsTooltip')} placement="left">
                      <Button
                        size="sm"
                        variant="light"
                        isIconOnly
                        onPress={refreshPorts}
                        isLoading={isRefreshingPorts}
                      >
                        {isRefreshingPorts ? '' : '↻'}
                      </Button>
                    </Tooltip>
                  )}
                </div>
                <p className="text-sm text-default-600">
                  {usesNetworkEndpoint
                    ? t('radio.backendEndpointModeDesc')
                    : usesDevicePathEndpoint
                      ? t('radio.deviceEndpointModeDesc')
                      : t('radio.serialDesc')}
                </p>
                <Divider />
                <div className="space-y-4">
                  <Autocomplete
                    label={t('radio.rigModel')}
                    placeholder={t('radio.rigModelPlaceholder')}
                    selectedKey={config.serial?.rigModel ? String(config.serial.rigModel) : null}
                    onSelectionChange={selectedKey => {
                      if (selectedKey) {
                        logger.debug('Radio model selected:', selectedKey);
                        const nextRigModel = Number(selectedKey);
                        const currentRigModel = config.serial?.rigModel;
                        const rigPath = config.serial?.backendConfig?.rig_pathname ?? config.serial?.path ?? '';

                        if (currentRigModel && currentRigModel !== nextRigModel) {
                          pendingEndpointKindResetRef.current = {
                            previousEndpointKind: endpointKind ?? null,
                            rigModel: nextRigModel,
                          };
                        }

                        updateConfig({
                          serial: {
                            path: rigPath,
                            rigModel: nextRigModel,
                            serialConfig: config.serial?.serialConfig,
                            backendConfig: rigPath ? { rig_pathname: rigPath } : {},
                          }
                        });
                      }
                    }}
                    variant="flat"
                    size="md"
                    isVirtualized
                    showScrollIndicators={false}
                    defaultItems={rigs}
                  >
                    {(item: RigInfo) => (
                      <AutocompleteItem 
                        key={String(item.rigModel)}
                        textValue={`${item.mfgName} ${item.modelName}`}
                      >
                        <div className="flex justify-between items-center">
                          <span className="text-small">{item.mfgName} {item.modelName}</span>
                          <span className="text-tiny text-default-400">ID: {item.rigModel}</span>
                        </div>
                      </AutocompleteItem>
                    )}
                  </Autocomplete>
                  {!config.serial?.rigModel ? (
                    <div className="text-xs text-default-400 bg-default-50 p-3 rounded-lg">
                      {t('radio.selectRigModelBeforeEndpoint')}
                    </div>
                  ) : isLoadingRigConfigSchema && !rigConfigSchema ? (
                    <div className="text-xs text-default-400 bg-default-50 p-3 rounded-lg">
                      {t('radio.loadingRigConfigSchema')}
                    </div>
                  ) : usesNetworkEndpoint ? (
                    <Input
                      label={t('radio.backendEndpoint')}
                      placeholder={t('radio.backendEndpointPlaceholder')}
                      description={selectedRig ? t('radio.backendEndpointDesc', { model: `${selectedRig.mfgName} ${selectedRig.modelName}` }) : t('radio.backendEndpointDescGeneric')}
                      value={effectiveRigPath}
                      onChange={e => {
                        const value = e.target.value;
                        updateConfig({
                          serial: {
                            path: value,
                            rigModel: config.serial?.rigModel ?? 0,
                            serialConfig: config.serial?.serialConfig,
                            backendConfig: {
                              ...(config.serial?.backendConfig || {}),
                              rig_pathname: value,
                            },
                          }
                        });
                      }}
                      variant="flat"
                      size="md"
                    />
                  ) : usesDevicePathEndpoint ? (
                    <Input
                      label={t('radio.deviceEndpoint')}
                      placeholder={t('radio.deviceEndpointPlaceholder')}
                      description={t('radio.deviceEndpointDesc')}
                      value={effectiveRigPath}
                      onChange={e => {
                        const value = e.target.value;
                        updateConfig({
                          serial: {
                            path: value,
                            rigModel: config.serial?.rigModel ?? 0,
                            serialConfig: config.serial?.serialConfig,
                            backendConfig: {
                              ...(config.serial?.backendConfig || {}),
                              rig_pathname: value,
                            },
                          }
                        });
                      }}
                      variant="flat"
                      size="md"
                    />
                  ) : (
                    <Autocomplete
                      label={t('radio.serialPort')}
                      placeholder={t('radio.serialPortPlaceholder')}
                      description={t('radio.serialPortDesc')}
                      allowsCustomValue
                      inputValue={effectiveRigPath}
                      selectedKey={effectiveRigPath || null}
                      onInputChange={value => {
                        updateConfig({
                          serial: {
                            path: value,
                            rigModel: config.serial?.rigModel ?? 0,
                            serialConfig: config.serial?.serialConfig,
                            backendConfig: {
                              ...(config.serial?.backendConfig || {}),
                              rig_pathname: value,
                            },
                          }
                        });
                      }}
                      onSelectionChange={selectedKey => {
                        if (selectedKey !== null) {
                          updateConfig({
                            serial: {
                              path: String(selectedKey),
                              rigModel: config.serial?.rigModel ?? 0,
                              serialConfig: config.serial?.serialConfig,
                              backendConfig: {
                                ...(config.serial?.backendConfig || {}),
                                rig_pathname: String(selectedKey),
                              },
                            }
                          });
                        }
                      }}
                      variant="flat"
                      size="md"
                      defaultItems={ports}
                    >
                      {(item: PortInfo) => (
                        <AutocompleteItem key={item.path} textValue={item.path}>
                          {item.path}
                        </AutocompleteItem>
                      )}
                    </Autocomplete>
                  )}
                  <Divider />
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <h5 className="font-medium text-default-700">{t('radio.hamlibBackendConfigTitle')}</h5>
                        <p className="text-xs text-default-500">{t('radio.hamlibBackendConfigDesc')}</p>
                      </div>
                      {isLoadingRigConfigSchema && (
                        <Chip size="sm" variant="flat" color="primary">
                          {t('radio.loadingRigConfigSchema')}
                        </Chip>
                      )}
                    </div>

                    {!config.serial?.rigModel ? (
                      <div className="text-xs text-default-400 bg-default-50 p-3 rounded-lg">
                        {t('radio.selectRigModelFirst')}
                      </div>
                    ) : visibleRigConfigFields.length === 0 ? (
                      <div className="text-xs text-default-400 bg-default-50 p-3 rounded-lg">
                        {t('radio.noRigConfigSchema')}
                      </div>
                    ) : (
                      <div className="space-y-4">
                        {connectionRigConfigFields.length > 0 && (
                          <div className="space-y-3">
                            <div>
                              <h6 className="text-sm font-medium text-default-700">{t('radio.connectionParamsTitle')}</h6>
                              <p className="text-xs text-default-500">{t('radio.connectionParamsDesc')}</p>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                              {connectionRigConfigFields.map((field) => renderHamlibConfigField(field))}
                            </div>
                          </div>
                        )}

                        {multicastRigConfigFields.length > 0 && (
                          <Accordion variant="light" className="px-0">
                            <AccordionItem
                              key="multicast"
                              aria-label={t('radio.multicastParamsTitle')}
                              className="px-0"
                              title={(
                                <div className="flex items-center justify-between gap-3">
                                  <div>
                                    <h6 className="text-sm font-medium text-default-700">{t('radio.multicastParamsTitle')}</h6>
                                    <p className="text-xs text-default-500">{t('radio.multicastParamsDesc')}</p>
                                  </div>
                                  <Chip size="sm" variant="flat">
                                    {multicastRigConfigFields.length}
                                  </Chip>
                                </div>
                              )}
                            >
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
                                {multicastRigConfigFields.map((field) => renderHamlibConfigField(field))}
                              </div>
                            </AccordionItem>
                          </Accordion>
                        )}

                        {advancedRigConfigFields.length > 0 && (
                          <Accordion variant="light" className="px-0">
                            <AccordionItem
                              key="advanced"
                              aria-label={t('radio.backendAdvancedTitle')}
                              className="px-0"
                              title={(
                                <div className="flex items-center justify-between gap-3">
                                  <div>
                                    <h6 className="text-sm font-medium text-default-700">{t('radio.backendAdvancedTitle')}</h6>
                                    <p className="text-xs text-default-500">{t('radio.backendAdvancedDesc')}</p>
                                  </div>
                                  <Chip size="sm" variant="flat">
                                    {advancedRigConfigFields.length}
                                  </Chip>
                                </div>
                              )}
                            >
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
                                {advancedRigConfigFields.map((field) => renderHamlibConfigField(field))}
                              </div>
                            </AccordionItem>
                          </Accordion>
                        )}
                      </div>
                    )}
                  </div>

                  <Divider />
                  {renderPttConfig()}
                  <Divider />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="flat"
                      color="primary"
                      onPress={handleTestConnection}
                      isLoading={isTestingConnection}
                      isDisabled={!effectiveRigPath || !config.serial?.rigModel || isTestingPTT}
                    >
                      {isTestingConnection ? t('radio.testingConnection') : t('radio.testConnection')}
                    </Button>
                    <Button
                      size="sm"
                      variant="flat"
                      color="secondary"
                      onPress={handleTestPTT}
                      isLoading={isTestingPTT}
                      isDisabled={!effectiveRigPath || !config.serial?.rigModel || config.pttMethod === 'vox' || isTestingConnection}
                    >
                      {config.pttMethod === 'vox' ? t('radio.voxNoTest') : isTestingPTT ? t('radio.testingPTT') : t('radio.testPTT')}
                    </Button>
                  </div>
                  {testResult && (
                    <Chip
                      color={testResult.type === 'success' ? 'success' : 'danger'}
                      variant="flat"
                      className="w-full"
                    >
                      {testResult.message}
                    </Chip>
                  )}

                  <Divider />

                  <div className="space-y-3">
                    <h5 className="text-sm font-medium text-default-700">
                      ⏱️ {t('radio.txCompensation')}
                    </h5>
                    <p className="text-xs text-default-500">
                      {t('radio.txCompensationSerialDesc')}
                    </p>

                    <div className="flex items-center gap-3">
                      <Input
                        type="number"
                        label={t('radio.compensationValue')}
                        value={(config.transmitCompensationMs || 0).toString()}
                        onChange={e => {
                          const value = parseInt(e.target.value) || 0;
                          updateConfig({ transmitCompensationMs: value });
                        }}
                        min="-1000"
                        max="1000"
                        endContent={<span className="text-small text-default-400">ms</span>}
                        size="sm"
                        className="w-40"
                      />
                    </div>

                    <div className="flex gap-2 flex-wrap">
                      <Chip
                        size="sm"
                        variant="flat"
                        color="default"
                        onClick={() => updateConfig({ transmitCompensationMs: 0 })}
                        className="cursor-pointer hover:bg-default-200"
                      >
                        0ms
                      </Chip>
                      <Chip
                        size="sm"
                        variant="flat"
                        color="success"
                        onClick={() => updateConfig({ transmitCompensationMs: 10 })}
                        className="cursor-pointer hover:bg-success-100"
                      >
                        10ms（{t('radio.fast')}）
                      </Chip>
                      <Chip
                        size="sm"
                        variant="flat"
                        color="success"
                        onClick={() => updateConfig({ transmitCompensationMs: 20 })}
                        className="cursor-pointer hover:bg-success-100"
                      >
                        20ms（{t('radio.recommended')}）
                      </Chip>
                      <Chip
                        size="sm"
                        variant="flat"
                        color="success"
                        onClick={() => updateConfig({ transmitCompensationMs: 50 })}
                        className="cursor-pointer hover:bg-success-100"
                      >
                        50ms（{t('radio.legacy')}）
                      </Chip>
                    </div>

                    <div className="text-xs text-default-400 space-y-1 bg-default-50 p-3 rounded-lg">
                      <p className="font-medium">💡 {t('radio.usageTips')}</p>
                      <p>• {t('radio.tipModernSerialRadio')}</p>
                      <p>• {t('radio.tipOldSerialRadio')}</p>
                      <p>• {t('radio.tipUsbSerial')}</p>
                      <p className="text-danger-600 font-semibold">⚠️ {t('radio.tipLargeWarning')}</p>
                      <p>• {t('radio.tipAdjustByStats')}</p>
                    </div>
                  </div>
                </div>
              </CardBody>
            </Card>
          );
        case 'icom-wlan':
          return (
            <Card shadow="none" radius="lg" classNames={{ base: "border border-divider bg-content1" }}>
              <CardBody className="space-y-4 p-4">
                <h4 className="font-semibold text-default-900">{t('radio.icomWlanTitle')}</h4>
                <p className="text-sm text-default-600">{t('radio.icomWlanDesc')}</p>
                <Divider />
                <div className="space-y-4">
                  <Input
                    label={t('radio.ipAddress')}
                    placeholder="192.168.1.100"
                    value={config.icomWlan?.ip || ''}
                    onChange={e => updateConfig({ icomWlan: { ip: e.target.value, port: config.icomWlan?.port ?? 50001, dataMode: config.icomWlan?.dataMode ?? false, userName: config.icomWlan?.userName, password: config.icomWlan?.password } })}
                  />
                  <Input
                    label={t('radio.port')}
                    placeholder="50001"
                    type="number"
                    value={String(config.icomWlan?.port ?? '')}
                    onChange={e => updateConfig({ icomWlan: { ip: config.icomWlan?.ip ?? '', port: Number(e.target.value), dataMode: config.icomWlan?.dataMode ?? false, userName: config.icomWlan?.userName, password: config.icomWlan?.password } })}
                  />
                  <Input
                    label={t('radio.username')}
                    placeholder="admin"
                    value={config.icomWlan?.userName || ''}
                    onChange={e => updateConfig({ icomWlan: { ip: config.icomWlan?.ip ?? '', port: config.icomWlan?.port ?? 50001, dataMode: config.icomWlan?.dataMode ?? false, userName: e.target.value, password: config.icomWlan?.password } })}
                  />
                  <Input
                    label={t('radio.password')}
                    placeholder={t('radio.password')}
                    type="password"
                    value={config.icomWlan?.password || ''}
                    onChange={e => updateConfig({ icomWlan: { ip: config.icomWlan?.ip ?? '', port: config.icomWlan?.port ?? 50001, dataMode: config.icomWlan?.dataMode ?? false, userName: config.icomWlan?.userName, password: e.target.value } })}
                  />
                  <Divider />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="flat"
                      color="primary"
                      onPress={handleTestConnection}
                      isLoading={isTestingConnection}
                      isDisabled={!config.icomWlan?.ip || !config.icomWlan?.port || !config.icomWlan?.userName || !config.icomWlan?.password || isTestingPTT}
                    >
                      {isTestingConnection ? t('radio.testingConnection') : t('radio.testConnection')}
                    </Button>
                    <Button
                      size="sm"
                      variant="flat"
                      color="secondary"
                      onPress={handleTestPTT}
                      isLoading={isTestingPTT}
                      isDisabled={!config.icomWlan?.ip || !config.icomWlan?.port || isTestingConnection}
                    >
                      {isTestingPTT ? t('radio.testingPTT') : t('radio.testPTT')}
                    </Button>
                  </div>
                  {testResult && (
                    <Chip
                      color={testResult.type === 'success' ? 'success' : 'danger'}
                      variant="flat"
                      className="w-full"
                    >
                      {testResult.message}
                    </Chip>
                  )}

                  <Divider />

                  <div className="space-y-3">
                    <h5 className="text-sm font-medium text-default-700">
                      ⏱️ {t('radio.txCompensation')}
                    </h5>
                    <p className="text-xs text-default-500">
                      {t('radio.txCompensationNetworkDesc')}
                    </p>

                    <div className="flex items-center gap-3">
                      <Input
                        type="number"
                        label={t('radio.compensationValue')}
                        value={(config.transmitCompensationMs || 0).toString()}
                        onChange={e => {
                          const value = parseInt(e.target.value) || 0;
                          updateConfig({ transmitCompensationMs: value });
                        }}
                        min="-1000"
                        max="1000"
                        endContent={<span className="text-small text-default-400">ms</span>}
                        size="sm"
                        className="w-40"
                      />
                    </div>

                    <div className="flex gap-2 flex-wrap">
                      <Chip
                        size="sm"
                        variant="flat"
                        color="default"
                        onClick={() => updateConfig({ transmitCompensationMs: 0 })}
                        className="cursor-pointer hover:bg-default-200"
                      >
                        0ms
                      </Chip>
                      <Chip
                        size="sm"
                        variant="flat"
                        color="primary"
                        onClick={() => updateConfig({ transmitCompensationMs: 50 })}
                        className="cursor-pointer hover:bg-primary-100"
                      >
                        50ms（{t('radio.wired')}）
                      </Chip>
                      <Chip
                        size="sm"
                        variant="flat"
                        color="primary"
                        onClick={() => updateConfig({ transmitCompensationMs: 100 })}
                        className="cursor-pointer hover:bg-primary-100"
                      >
                        100ms（{t('radio.recommended')}）
                      </Chip>
                      <Chip
                        size="sm"
                        variant="flat"
                        color="primary"
                        onClick={() => updateConfig({ transmitCompensationMs: 200 })}
                        className="cursor-pointer hover:bg-primary-100"
                      >
                        200ms（{t('radio.wireless')}）
                      </Chip>
                    </div>

                    <div className="text-xs text-default-400 space-y-1 bg-default-50 p-3 rounded-lg">
                      <p className="font-medium">💡 {t('radio.usageTips')}</p>
                      <p>• {t('radio.tipIcomWlan')}</p>
                      <p>• {t('radio.tipLocalNetwork')}</p>
                      <p>• {t('radio.tipRemoteNetwork')}</p>
                      <p className="text-danger-600 font-semibold">⚠️ {t('radio.tipLargeWarning')}</p>
                      <p>• {t('radio.tipIcomAudio')}</p>
                    </div>
                  </div>
                </div>
              </CardBody>
            </Card>
          );
        case 'none':
        default:
          return (
            <Card shadow="none" radius="lg" classNames={{ base: "border border-divider bg-content1" }}>
              <CardBody className="space-y-4 p-4">
                <h4 className="font-semibold text-default-900">{t('radio.noneTitle')}</h4>
                <p className="text-sm text-default-600">{t('radio.noneDesc')}</p>

                <Divider />

                <div className="space-y-3">
                  <h5 className="text-sm font-medium text-default-700">
                    ⏱️ {t('radio.txCompensation')}
                  </h5>
                  <p className="text-xs text-default-500">
                    {t('radio.txCompensationNoneDesc')}
                  </p>

                  <div className="flex items-center gap-3">
                    <Input
                      type="number"
                      label={t('radio.compensationValue')}
                      value={(config.transmitCompensationMs || 0).toString()}
                      onChange={e => {
                        const value = parseInt(e.target.value) || 0;
                        updateConfig({ transmitCompensationMs: value });
                      }}
                      min="-1000"
                      max="1000"
                      endContent={<span className="text-small text-default-400">ms</span>}
                      size="sm"
                      className="w-40"
                    />
                    <Button
                      size="sm"
                      variant="flat"
                      color="default"
                      onPress={() => updateConfig({ transmitCompensationMs: 0 })}
                    >
                      {t('radio.resetToZero')}
                    </Button>
                  </div>

                  <div className="text-xs text-default-400 space-y-1 bg-default-50 p-3 rounded-lg">
                    <p className="font-medium">💡 {t('radio.usageTips')}</p>
                    <p>• {t('radio.tipNoneMode')}</p>
                    <p className="text-danger-600 font-semibold">⚠️ {t('radio.tipLargeWarning')}</p>
                    <p>• {t('radio.tipAdjustByStats')}</p>
                  </div>
                </div>
              </CardBody>
            </Card>
          );
      }
    };

    return (
      <div className="space-y-6">
        {/* 页面标题和描述 */}
        <div>
          <h3 className="text-xl font-bold text-default-900 mb-2">{t('radio.pageTitle')}</h3>
          <p className="text-default-600">
            {t('radio.pageDescription')}
          </p>
        </div>

        {/* 模式选择 */}
        <div>
          <Tabs
            selectedKey={config.type}
            onSelectionChange={(key) => updateConfig({ type: key as HamlibConfig['type'] })}
            size="lg"
          >
            <Tab key="none" title={`📻 ${t('radio.modeNone')}`} />
            <Tab key="serial" title={`🔌 ${t('radio.modeSerial')}`} />
            <Tab key="network" title={`🌐 ${t('radio.modeNetwork')}`} />
            <Tab key="icom-wlan" title={`📡 ${t('radio.modeIcomWlan')}`} />
          </Tabs>
        </div>

        {/* 配置内容 */}
        <div>
          {renderConfigContent()}
        </div>

        {/* 状态提示 */}
        <div className="flex justify-end">
          <div className="text-sm text-default-500">
            {hasUnsavedChanges() && t('unsavedChanges')}
          </div>
        </div>
      </div>
    );
  }
);

RadioDeviceSettings.displayName = 'RadioDeviceSettings';
