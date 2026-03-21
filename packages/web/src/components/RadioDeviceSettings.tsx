import React, { useState, useEffect, forwardRef, useImperativeHandle } from 'react';
import { useTranslation } from 'react-i18next';
import { Input, Select, SelectItem, Autocomplete, AutocompleteItem, Tabs, Tab, Card, CardBody, Divider, Button, Chip, Tooltip } from '@heroui/react';
import { api } from '@tx5dr/core';
import type { HamlibConfig, SerialConfig, PttMethod } from '@tx5dr/contracts';

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
  const { t } = useTranslation('settings');
  const isControlled = initialConfig !== undefined;
  const [config, setConfig] = useState<HamlibConfig>(initialConfig ?? { type: 'none' } as HamlibConfig);
  const [originalConfig, setOriginalConfig] = useState<HamlibConfig>(initialConfig ?? { type: 'none' } as HamlibConfig);
  const [rigs, setRigs] = useState<RigInfo[]>([]);
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [_isSaving, setIsSaving] = useState(false);
  const [isTestingConnection, setIsTestingConnection] = useState(false);
  const [isTestingPTT, setIsTestingPTT] = useState(false);
  const [isRefreshingPorts, setIsRefreshingPorts] = useState(false);
  const [testResult, setTestResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

    useEffect(() => {
      loadData();
    }, []);

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
        console.error('刷新串口列表失败:', error);
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

  // 更新串口配置
  const updateSerialConfig = (updates: Partial<SerialConfig>) => {
    setConfig((prev) => {
      const next = {
        ...prev,
        serial: {
          path: prev.serial?.path ?? '',
          rigModel: prev.serial?.rigModel ?? 0,
          serialConfig: { ...prev.serial?.serialConfig, ...updates }
        }
      };
      onChange?.(next);
      return next;
    });
    // 清除之前的测试结果
    setTestResult(null);
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
        message: error instanceof Error ? error.message : t('radio.testConnectionFailedCheck')
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
                    value={config.network?.port || ''}
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
                </div>
                <p className="text-sm text-default-600">{t('radio.serialDesc')}</p>
                <Divider />
                <div className="space-y-4">
                  <Autocomplete
                    label={t('radio.serialPort')}
                    placeholder={t('radio.serialPortPlaceholder')}
                    allowsCustomValue
                    inputValue={config.serial?.path || ''}
                    selectedKey={config.serial?.path || null}
                    onInputChange={value => {
                      updateConfig({ serial: { path: value, rigModel: config.serial?.rigModel ?? 0, serialConfig: config.serial?.serialConfig } });
                    }}
                    onSelectionChange={selectedKey => {
                      if (selectedKey !== null) {
                        updateConfig({ serial: { path: String(selectedKey), rigModel: config.serial?.rigModel ?? 0, serialConfig: config.serial?.serialConfig } });
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
                  <Autocomplete
                    label={t('radio.rigModel')}
                    placeholder={t('radio.rigModelPlaceholder')}
                    selectedKey={config.serial?.rigModel ? String(config.serial.rigModel) : null}
                    onSelectionChange={selectedKey => {
                      if (selectedKey) {
                        console.log('📡 [RadioDeviceSettings] 选择电台型号:', selectedKey);
                        updateConfig({ serial: { path: config.serial?.path ?? '', rigModel: Number(selectedKey), serialConfig: config.serial?.serialConfig } });
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
                  <Divider />
                  
                  {/* 串口参数配置 */}
                  <div className="space-y-4">
                    <h5 className="font-medium text-default-700">{t('radio.serialParamsTitle')}</h5>

                    {/* 基础串口设置 */}
                    <div>
                      <h6 className="text-sm font-medium text-default-600 mb-2">{t('radio.serialBasicSettings')}</h6>
                      <div className="grid grid-cols-2 gap-3">
                        {/* 波特率 */}
                        <Select
                          label={t('radio.baudRate')}
                          size="sm"
                          selectedKeys={config.serial?.serialConfig?.rate ? [config.serial?.serialConfig.rate.toString()] : ['9600']}
                          onSelectionChange={keys => {
                            const value = Array.from(keys)[0] as string;
                            updateSerialConfig({ rate: parseInt(value) });
                          }}
                          variant="flat"
                        >
                          <SelectItem key="1200" textValue="1200">1200</SelectItem>
                          <SelectItem key="2400" textValue="2400">2400</SelectItem>
                          <SelectItem key="4800" textValue="4800">4800</SelectItem>
                          <SelectItem key="9600" textValue="9600">9600 ({t('radio.defaultValue')})</SelectItem>
                          <SelectItem key="19200" textValue="19200">19200</SelectItem>
                          <SelectItem key="38400" textValue="38400">38400</SelectItem>
                          <SelectItem key="57600" textValue="57600">57600</SelectItem>
                          <SelectItem key="115200" textValue="115200">115200</SelectItem>
                        </Select>

                        {/* 数据位 */}
                        <Select
                          label={t('radio.dataBits')}
                          size="sm"
                          selectedKeys={config.serial?.serialConfig?.data_bits ? [config.serial?.serialConfig.data_bits] : ['8']}
                          onSelectionChange={keys => {
                            const value = Array.from(keys)[0] as string;
                            updateSerialConfig({ data_bits: value as '5' | '6' | '7' | '8' });
                          }}
                          variant="flat"
                        >
                          <SelectItem key="5" textValue="5">{t('radio.bits', { n: 5 })}</SelectItem>
                          <SelectItem key="6" textValue="6">{t('radio.bits', { n: 6 })}</SelectItem>
                          <SelectItem key="7" textValue="7">{t('radio.bits', { n: 7 })}</SelectItem>
                          <SelectItem key="8" textValue="8">{t('radio.bits', { n: 8 })} ({t('radio.defaultValue')})</SelectItem>
                        </Select>

                        {/* 停止位 */}
                        <Select
                          label={t('radio.stopBits')}
                          size="sm"
                          selectedKeys={config.serial?.serialConfig?.stop_bits ? [config.serial?.serialConfig.stop_bits] : ['1']}
                          onSelectionChange={keys => {
                            const value = Array.from(keys)[0] as string;
                            updateSerialConfig({ stop_bits: value as '1' | '2' });
                          }}
                          variant="flat"
                        >
                          <SelectItem key="1" textValue="1">{t('radio.bits', { n: 1 })} ({t('radio.defaultValue')})</SelectItem>
                          <SelectItem key="2" textValue="2">{t('radio.bits', { n: 2 })}</SelectItem>
                        </Select>

                        {/* 奇偶校验 */}
                        <Select
                          label={t('radio.parity')}
                          size="sm"
                          selectedKeys={config.serial?.serialConfig?.serial_parity ? [config.serial?.serialConfig.serial_parity] : ['None']}
                          onSelectionChange={keys => {
                            const value = Array.from(keys)[0] as string;
                            updateSerialConfig({ serial_parity: value as 'None' | 'Even' | 'Odd' | 'Mark' | 'Space' });
                          }}
                          variant="flat"
                        >
                          <SelectItem key="None" textValue="None">{t('radio.parityNone')} ({t('radio.defaultValue')})</SelectItem>
                          <SelectItem key="Even" textValue="Even">{t('radio.parityEven')}</SelectItem>
                          <SelectItem key="Odd" textValue="Odd">{t('radio.parityOdd')}</SelectItem>
                          <SelectItem key="Mark" textValue="Mark">{t('radio.parityMark')}</SelectItem>
                          <SelectItem key="Space" textValue="Space">{t('radio.paritySpace')}</SelectItem>
                        </Select>
                      </div>
                    </div>

                    {/* 流控和控制信号 */}
                    <div>
                      <h6 className="text-sm font-medium text-default-600 mb-2">{t('radio.flowControl')}</h6>
                      <div className="grid grid-cols-3 gap-3">
                        {/* 握手方式 */}
                        <Select
                          label={t('radio.handshake')}
                          size="sm"
                          selectedKeys={config.serial?.serialConfig?.serial_handshake ? [config.serial?.serialConfig.serial_handshake] : ['None']}
                          onSelectionChange={keys => {
                            const value = Array.from(keys)[0] as string;
                            updateSerialConfig({ serial_handshake: value as 'None' | 'Hardware' | 'Software' });
                          }}
                          variant="flat"
                        >
                          <SelectItem key="None" textValue="None">{t('radio.parityNone')} ({t('radio.defaultValue')})</SelectItem>
                          <SelectItem key="Software" textValue="Software">{t('radio.handshakeSoftware')}</SelectItem>
                          <SelectItem key="Hardware" textValue="Hardware">{t('radio.handshakeHardware')}</SelectItem>
                        </Select>

                        {/* RTS控制线 */}
                        <Select
                          label={t('radio.rtsControl')}
                          size="sm"
                          selectedKeys={config.serial?.serialConfig?.rts_state ? [config.serial?.serialConfig.rts_state] : ['UNSET']}
                          onSelectionChange={keys => {
                            const value = Array.from(keys)[0] as string;
                            updateSerialConfig({ rts_state: value === 'UNSET' ? undefined : value as 'ON' | 'OFF' | 'UNSET' });
                          }}
                          variant="flat"
                        >
                          <SelectItem key="UNSET" textValue="UNSET">{t('radio.defaultValue')}</SelectItem>
                          <SelectItem key="OFF" textValue="OFF">{t('radio.low')}</SelectItem>
                          <SelectItem key="ON" textValue="ON">{t('radio.high')}</SelectItem>
                        </Select>

                        {/* DTR控制线 */}
                        <Select
                          label={t('radio.dtrControl')}
                          size="sm"
                          selectedKeys={config.serial?.serialConfig?.dtr_state ? [config.serial?.serialConfig.dtr_state] : ['UNSET']}
                          onSelectionChange={keys => {
                            const value = Array.from(keys)[0] as string;
                            updateSerialConfig({ dtr_state: value === 'UNSET' ? undefined : value as 'ON' | 'OFF' | 'UNSET' });
                          }}
                          variant="flat"
                        >
                          <SelectItem key="UNSET" textValue="UNSET">{t('radio.defaultValue')}</SelectItem>
                          <SelectItem key="OFF" textValue="OFF">{t('radio.low')}</SelectItem>
                          <SelectItem key="ON" textValue="ON">{t('radio.high')}</SelectItem>
                        </Select>
                      </div>
                    </div>

                    {/* 时序与重试设置 */}
                    <div>
                      <h6 className="text-sm font-medium text-default-600 mb-2">{t('radio.timingRetry')}</h6>
                      <div className="grid grid-cols-2 gap-3">
                        {/* 超时时间 */}
                        <Input
                          label={t('radio.timeout')}
                          size="sm"
                          type="number"
                          min="0"
                          max="60000"
                          value={config.serial?.serialConfig?.timeout?.toString() || ''}
                          onChange={e => {
                            const value = e.target.value;
                            updateSerialConfig({ timeout: value ? parseInt(value) : undefined });
                          }}
                          variant="flat"
                          placeholder={t('radio.defaultValue')}
                        />

                        {/* 重试次数 */}
                        <Input
                          label={t('radio.retryCount')}
                          size="sm"
                          type="number"
                          min="0"
                          max="10"
                          value={config.serial?.serialConfig?.retry?.toString() || ''}
                          onChange={e => {
                            const value = e.target.value;
                            updateSerialConfig({ retry: value ? parseInt(value) : undefined });
                          }}
                          variant="flat"
                          placeholder={t('radio.defaultValue')}
                        />

                        {/* 字节间延迟 */}
                        <Input
                          label={t('radio.writeDelay')}
                          size="sm"
                          type="number"
                          min="0"
                          max="1000"
                          value={config.serial?.serialConfig?.write_delay?.toString() || ''}
                          onChange={e => {
                            const value = e.target.value;
                            updateSerialConfig({ write_delay: value ? parseInt(value) : undefined });
                          }}
                          variant="flat"
                          placeholder={t('radio.defaultValue')}
                        />

                        {/* 命令间延迟 */}
                        <Input
                          label={t('radio.postWriteDelay')}
                          size="sm"
                          type="number"
                          min="0"
                          max="5000"
                          value={config.serial?.serialConfig?.post_write_delay?.toString() || ''}
                          onChange={e => {
                            const value = e.target.value;
                            updateSerialConfig({ post_write_delay: value ? parseInt(value) : undefined });
                          }}
                          variant="flat"
                          placeholder={t('radio.defaultValue')}
                        />
                      </div>
                    </div>

                    <div className="text-xs text-default-400 space-y-1 bg-default-50 p-3 rounded-lg">
                      <p className="font-medium">💡 {t('radio.serialConfigTips')}</p>
                      <p>• {t('radio.tipModernRadio')}</p>
                      <p>• {t('radio.tipOldRadio')}</p>
                      <p>• {t('radio.tipUnstableConnection')}</p>
                      <p>• {t('radio.tipPTTIssue')}</p>
                    </div>
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
                      isDisabled={!config.serial?.path || !config.serial?.rigModel || isTestingPTT}
                    >
                      {isTestingConnection ? t('radio.testingConnection') : t('radio.testConnection')}
                    </Button>
                    <Button
                      size="sm"
                      variant="flat"
                      color="secondary"
                      onPress={handleTestPTT}
                      isLoading={isTestingPTT}
                      isDisabled={!config.serial?.path || !config.serial?.rigModel || config.pttMethod === 'vox' || isTestingConnection}
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
                    onChange={e => updateConfig({ icomWlan: { ip: e.target.value, port: config.icomWlan?.port ?? 50001, userName: config.icomWlan?.userName, password: config.icomWlan?.password } })}
                  />
                  <Input
                    label={t('radio.port')}
                    placeholder="50001"
                    type="number"
                    value={config.icomWlan?.port || ''}
                    onChange={e => updateConfig({ icomWlan: { ip: config.icomWlan?.ip ?? '', port: Number(e.target.value), userName: config.icomWlan?.userName, password: config.icomWlan?.password } })}
                  />
                  <Input
                    label={t('radio.username')}
                    placeholder="admin"
                    value={config.icomWlan?.userName || ''}
                    onChange={e => updateConfig({ icomWlan: { ip: config.icomWlan?.ip ?? '', port: config.icomWlan?.port ?? 50001, userName: e.target.value, password: config.icomWlan?.password } })}
                  />
                  <Input
                    label={t('radio.password')}
                    placeholder={t('radio.password')}
                    type="password"
                    value={config.icomWlan?.password || ''}
                    onChange={e => updateConfig({ icomWlan: { ip: config.icomWlan?.ip ?? '', port: config.icomWlan?.port ?? 50001, userName: config.icomWlan?.userName, password: e.target.value } })}
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
            <Tab key="network" title={`🌐 ${t('radio.modeNetwork')}`} />
            <Tab key="serial" title={`🔌 ${t('radio.modeSerial')}`} />
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
