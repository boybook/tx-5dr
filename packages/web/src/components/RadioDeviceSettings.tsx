import React, { useState, useEffect, forwardRef, useImperativeHandle } from 'react';
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
      setTestResult({ type: 'error', message: '无电台模式无需测试连接' });
      return;
    }

    setIsTestingConnection(true);
    setTestResult(null);

    try {
      const response = await api.testRadio(config);
      if (response.success) {
        setTestResult({ type: 'success', message: '连接测试成功！电台响应正常。' });
      } else {
        setTestResult({ type: 'error', message: response.message || '连接测试失败' });
      }
    } catch (error) {
      setTestResult({ 
        type: 'error', 
        message: error instanceof Error ? error.message : '连接测试失败，请检查配置'
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
        setTestResult({ type: 'success', message: 'PTT测试成功！电台已切换发射状态 0.5 秒。' });
      } else {
        setTestResult({ type: 'error', message: response.message || 'PTT测试失败' });
      }
    } catch (error) {
      setTestResult({ 
        type: 'error', 
        message: error instanceof Error ? error.message : 'PTT测试失败，请检查电台连接'
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
          <h5 className="text-sm font-medium text-default-700">PTT 方法</h5>
          <Select
            label="PTT 方法"
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
            <SelectItem key="cat" textValue="CAT 命令（推荐）">CAT 命令（推荐）</SelectItem>
            <SelectItem key="vox" textValue="VOX 声控">VOX 声控</SelectItem>
            {isNetwork ? (
              <SelectItem key="dtr" textValue="DTR 引脚（需串口）" isDisabled>DTR 引脚（需串口连接）</SelectItem>
            ) : (
              <SelectItem key="dtr" textValue="DTR 引脚">DTR 引脚</SelectItem>
            )}
            {isNetwork ? (
              <SelectItem key="rts" textValue="RTS 引脚（需串口）" isDisabled>RTS 引脚（需串口连接）</SelectItem>
            ) : (
              <SelectItem key="rts" textValue="RTS 引脚">RTS 引脚</SelectItem>
            )}
          </Select>

          {/* 仅 DTR/RTS 时显示独立 PTT 串口选择（支持手动输入） */}
          {(currentMethod === 'dtr' || currentMethod === 'rts') && (
            <Autocomplete
              label="PTT 串口"
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
              placeholder="使用 CAT 串口（默认）"
              description="指定独立的 PTT 控制串口，留空则复用 CAT 串口，可手动输入路径"
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
            <p className="font-medium">PTT 方法说明：</p>
            <p>• <strong>CAT</strong>：通过 CAT 命令控制，适用于大多数现代电台（推荐）</p>
            <p>• <strong>VOX</strong>：电台自动检测音频信号发射，适用于 SignaLink USB 等声卡接口</p>
            <p>• <strong>DTR/RTS</strong>：通过串口引脚控制，适用于古老电台或外部功放切换</p>
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
                <h4 className="font-semibold text-default-900">网络RigCtrl设置</h4>
                <p className="text-sm text-default-600">通过网络连接到电台控制程序</p>
                <Divider />
                <div className="space-y-4">
                  <Input
                    label="主机地址"
                    placeholder="localhost"
                    value={config.network?.host || ''}
                    onChange={e => updateConfig({ network: { host: e.target.value, port: config.network?.port ?? 4532 } })}
                  />
                  <Input
                    label="端口"
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
                      {isTestingConnection ? '测试连接中...' : '测试连接'}
                    </Button>
                    <Button
                      size="sm"
                      variant="flat"
                      color="secondary"
                      onPress={handleTestPTT}
                      isLoading={isTestingPTT}
                      isDisabled={!config.network?.host || !config.network?.port || config.pttMethod === 'vox' || isTestingConnection}
                    >
                      {config.pttMethod === 'vox' ? 'VOX 模式无需测试' : isTestingPTT ? '测试PTT中...' : '测试PTT'}
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
                      ⏱️ 发射时序补偿
                    </h5>
                    <p className="text-xs text-default-500">
                      补偿网络传输和电台处理延迟，确保发射时间精确对齐。正值表示提前发射，负值表示延后发射。
                    </p>

                    <div className="flex items-center gap-3">
                      <Input
                        type="number"
                        label="补偿值"
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
                        50ms（有线）
                      </Chip>
                      <Chip
                        size="sm"
                        variant="flat"
                        color="primary"
                        onClick={() => updateConfig({ transmitCompensationMs: 100 })}
                        className="cursor-pointer hover:bg-primary-100"
                      >
                        100ms（推荐）
                      </Chip>
                      <Chip
                        size="sm"
                        variant="flat"
                        color="primary"
                        onClick={() => updateConfig({ transmitCompensationMs: 200 })}
                        className="cursor-pointer hover:bg-primary-100"
                      >
                        200ms（无线）
                      </Chip>
                    </div>

                    <div className="text-xs text-default-400 space-y-1 bg-default-50 p-3 rounded-lg">
                      <p className="font-medium">💡 使用建议：</p>
                      <p>• 有线网络：50-100ms</p>
                      <p>• 无线网络：100-200ms</p>
                      <p>• 远程控制：200-500ms</p>
                      <p className="text-danger-600 font-semibold">⚠️ 设置过大（&gt;500ms）会压缩决策时间，可能影响自动回复功能</p>
                      <p>• 可通过查看发射延迟统计来调整补偿值</p>
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
                  <h4 className="font-semibold text-default-900">串口Rig设置</h4>
                  <Tooltip content="刷新串口列表" placement="left">
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
                <p className="text-sm text-default-600">通过串口直接连接电台</p>
                <Divider />
                <div className="space-y-4">
                  <Autocomplete
                    label="串口"
                    placeholder="选择或输入串口路径"
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
                    label="电台型号"
                    placeholder="搜索或选择电台型号"
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
                    <h5 className="font-medium text-default-700">串口参数配置</h5>
                    
                    {/* 基础串口设置 */}
                    <div>
                      <h6 className="text-sm font-medium text-default-600 mb-2">基础设置</h6>
                      <div className="grid grid-cols-2 gap-3">
                        {/* 波特率 */}
                        <Select 
                          label="波特率" 
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
                          <SelectItem key="9600" textValue="9600">9600 (默认)</SelectItem>
                          <SelectItem key="19200" textValue="19200">19200</SelectItem>
                          <SelectItem key="38400" textValue="38400">38400</SelectItem>
                          <SelectItem key="57600" textValue="57600">57600</SelectItem>
                          <SelectItem key="115200" textValue="115200">115200</SelectItem>
                        </Select>

                        {/* 数据位 */}
                        <Select 
                          label="数据位" 
                          size="sm"
                          selectedKeys={config.serial?.serialConfig?.data_bits ? [config.serial?.serialConfig.data_bits] : ['8']}
                          onSelectionChange={keys => {
                            const value = Array.from(keys)[0] as string;
                            updateSerialConfig({ data_bits: value as '5' | '6' | '7' | '8' });
                          }}
                          variant="flat"
                        >
                          <SelectItem key="5" textValue="5 位">5 位</SelectItem>
                          <SelectItem key="6" textValue="6 位">6 位</SelectItem>
                          <SelectItem key="7" textValue="7 位">7 位</SelectItem>
                          <SelectItem key="8" textValue="8 位">8 位 (默认)</SelectItem>
                        </Select>

                        {/* 停止位 */}
                        <Select 
                          label="停止位"
                          size="sm" 
                          selectedKeys={config.serial?.serialConfig?.stop_bits ? [config.serial?.serialConfig.stop_bits] : ['1']}
                          onSelectionChange={keys => {
                            const value = Array.from(keys)[0] as string;
                            updateSerialConfig({ stop_bits: value as '1' | '2' });
                          }}
                          variant="flat"
                        >
                          <SelectItem key="1" textValue="1 位">1 位 (默认)</SelectItem>
                          <SelectItem key="2" textValue="2 位">2 位</SelectItem>
                        </Select>

                        {/* 奇偶校验 */}
                        <Select 
                          label="奇偶校验"
                          size="sm"
                          selectedKeys={config.serial?.serialConfig?.serial_parity ? [config.serial?.serialConfig.serial_parity] : ['None']}
                          onSelectionChange={keys => {
                            const value = Array.from(keys)[0] as string;
                            updateSerialConfig({ serial_parity: value as 'None' | 'Even' | 'Odd' | 'Mark' | 'Space' });
                          }}
                          variant="flat"
                        >
                          <SelectItem key="None" textValue="无">无 (默认)</SelectItem>
                          <SelectItem key="Even" textValue="偶校验">偶校验</SelectItem>
                          <SelectItem key="Odd" textValue="奇校验">奇校验</SelectItem>
                          <SelectItem key="Mark" textValue="标记位">标记位</SelectItem>
                          <SelectItem key="Space" textValue="空格位">空格位</SelectItem>
                        </Select>
                      </div>
                    </div>

                    {/* 流控和控制信号 */}
                    <div>
                      <h6 className="text-sm font-medium text-default-600 mb-2">流控与控制信号</h6>
                      <div className="grid grid-cols-3 gap-3">
                        {/* 握手方式 */}
                        <Select 
                          label="流控方式"
                          size="sm"
                          selectedKeys={config.serial?.serialConfig?.serial_handshake ? [config.serial?.serialConfig.serial_handshake] : ['None']}
                          onSelectionChange={keys => {
                            const value = Array.from(keys)[0] as string;
                            updateSerialConfig({ serial_handshake: value as 'None' | 'Hardware' | 'Software' });
                          }}
                          variant="flat"
                        >
                          <SelectItem key="None" textValue="无">无 (默认)</SelectItem>
                          <SelectItem key="Software" textValue="软件流控">XON/XOFF</SelectItem>
                          <SelectItem key="Hardware" textValue="硬件流控">硬件流控</SelectItem>
                        </Select>

                        {/* RTS控制线 */}
                        <Select 
                          label="RTS控制"
                          size="sm"
                          selectedKeys={config.serial?.serialConfig?.rts_state ? [config.serial?.serialConfig.rts_state] : ['UNSET']}
                          onSelectionChange={keys => {
                            const value = Array.from(keys)[0] as string;
                            updateSerialConfig({ rts_state: value === 'UNSET' ? undefined : value as 'ON' | 'OFF' | 'UNSET' });
                          }}
                          variant="flat"
                        >
                          <SelectItem key="UNSET" textValue="默认">默认</SelectItem>
                          <SelectItem key="OFF" textValue="低电平">低电平</SelectItem>
                          <SelectItem key="ON" textValue="高电平">高电平</SelectItem>
                        </Select>

                        {/* DTR控制线 */}
                        <Select 
                          label="DTR控制"
                          size="sm"
                          selectedKeys={config.serial?.serialConfig?.dtr_state ? [config.serial?.serialConfig.dtr_state] : ['UNSET']}
                          onSelectionChange={keys => {
                            const value = Array.from(keys)[0] as string;
                            updateSerialConfig({ dtr_state: value === 'UNSET' ? undefined : value as 'ON' | 'OFF' | 'UNSET' });
                          }}
                          variant="flat"
                        >
                          <SelectItem key="UNSET" textValue="默认">默认</SelectItem>
                          <SelectItem key="OFF" textValue="低电平">低电平</SelectItem>
                          <SelectItem key="ON" textValue="高电平">高电平</SelectItem>
                        </Select>
                      </div>
                    </div>

                    {/* 时序与重试设置 */}
                    <div>
                      <h6 className="text-sm font-medium text-default-600 mb-2">时序与重试</h6>
                      <div className="grid grid-cols-2 gap-3">
                        {/* 超时时间 */}
                        <Input
                          label="超时时间 (ms)"
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
                          placeholder="默认值"
                        />

                        {/* 重试次数 */}
                        <Input
                          label="重试次数"
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
                          placeholder="默认值"
                        />

                        {/* 字节间延迟 */}
                        <Input
                          label="字节间延迟 (ms)"
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
                          placeholder="默认值"
                        />

                        {/* 命令间延迟 */}
                        <Input
                          label="命令间延迟 (ms)"
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
                          placeholder="默认值"
                        />
                      </div>
                    </div>

                    <div className="text-xs text-default-400 space-y-1 bg-default-50 p-3 rounded-lg">
                      <p className="font-medium">💡 配置建议：</p>
                      <p>• 大多数现代电台：9600波特率、8数据位、1停止位、无校验</p>
                      <p>• 老式电台可能需要：较低波特率(1200-4800)、7数据位、偶校验</p>
                      <p>• 连接不稳定时：增加超时时间、启用重试、添加命令间延迟</p>
                      <p>• PTT控制问题：尝试调整RTS/DTR设置</p>
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
                      {isTestingConnection ? '测试连接中...' : '测试连接'}
                    </Button>
                    <Button
                      size="sm"
                      variant="flat"
                      color="secondary"
                      onPress={handleTestPTT}
                      isLoading={isTestingPTT}
                      isDisabled={!config.serial?.path || !config.serial?.rigModel || config.pttMethod === 'vox' || isTestingConnection}
                    >
                      {config.pttMethod === 'vox' ? 'VOX 模式无需测试' : isTestingPTT ? '测试PTT中...' : '测试PTT'}
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
                      ⏱️ 发射时序补偿
                    </h5>
                    <p className="text-xs text-default-500">
                      补偿串口通信和电台处理延迟，确保发射时间精确对齐。正值表示提前发射，负值表示延后发射。
                    </p>

                    <div className="flex items-center gap-3">
                      <Input
                        type="number"
                        label="补偿值"
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
                        10ms（快速）
                      </Chip>
                      <Chip
                        size="sm"
                        variant="flat"
                        color="success"
                        onClick={() => updateConfig({ transmitCompensationMs: 20 })}
                        className="cursor-pointer hover:bg-success-100"
                      >
                        20ms（推荐）
                      </Chip>
                      <Chip
                        size="sm"
                        variant="flat"
                        color="success"
                        onClick={() => updateConfig({ transmitCompensationMs: 50 })}
                        className="cursor-pointer hover:bg-success-100"
                      >
                        50ms（老式）
                      </Chip>
                    </div>

                    <div className="text-xs text-default-400 space-y-1 bg-default-50 p-3 rounded-lg">
                      <p className="font-medium">💡 使用建议：</p>
                      <p>• 现代电台：10-30ms</p>
                      <p>• 老式电台：30-50ms</p>
                      <p>• USB-串口转换器：+10-20ms</p>
                      <p className="text-danger-600 font-semibold">⚠️ 设置过大（&gt;500ms）会压缩决策时间，可能影响自动回复功能</p>
                      <p>• 可通过查看发射延迟统计来调整补偿值</p>
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
                <h4 className="font-semibold text-default-900">ICOM WLAN 电台</h4>
                <p className="text-sm text-default-600">通过 ICOM WLAN 网络连接到电台，支持音频流和控制</p>
                <Divider />
                <div className="space-y-4">
                  <Input
                    label="IP 地址"
                    placeholder="192.168.1.100"
                    value={config.icomWlan?.ip || ''}
                    onChange={e => updateConfig({ icomWlan: { ip: e.target.value, port: config.icomWlan?.port ?? 50001, userName: config.icomWlan?.userName, password: config.icomWlan?.password } })}
                  />
                  <Input
                    label="端口"
                    placeholder="50001"
                    type="number"
                    value={config.icomWlan?.port || ''}
                    onChange={e => updateConfig({ icomWlan: { ip: config.icomWlan?.ip ?? '', port: Number(e.target.value), userName: config.icomWlan?.userName, password: config.icomWlan?.password } })}
                  />
                  <Input
                    label="用户名"
                    placeholder="admin"
                    value={config.icomWlan?.userName || ''}
                    onChange={e => updateConfig({ icomWlan: { ip: config.icomWlan?.ip ?? '', port: config.icomWlan?.port ?? 50001, userName: e.target.value, password: config.icomWlan?.password } })}
                  />
                  <Input
                    label="密码"
                    placeholder="密码"
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
                      {isTestingConnection ? '测试连接中...' : '测试连接'}
                    </Button>
                    <Button
                      size="sm"
                      variant="flat"
                      color="secondary"
                      onPress={handleTestPTT}
                      isLoading={isTestingPTT}
                      isDisabled={!config.icomWlan?.ip || !config.icomWlan?.port || isTestingConnection}
                    >
                      {isTestingPTT ? '测试PTT中...' : '测试PTT'}
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
                      ⏱️ 发射时序补偿
                    </h5>
                    <p className="text-xs text-default-500">
                      补偿网络传输和电台处理延迟，确保发射时间精确对齐。正值表示提前发射，负值表示延后发射。
                    </p>

                    <div className="flex items-center gap-3">
                      <Input
                        type="number"
                        label="补偿值"
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
                        50ms（有线）
                      </Chip>
                      <Chip
                        size="sm"
                        variant="flat"
                        color="primary"
                        onClick={() => updateConfig({ transmitCompensationMs: 100 })}
                        className="cursor-pointer hover:bg-primary-100"
                      >
                        100ms（推荐）
                      </Chip>
                      <Chip
                        size="sm"
                        variant="flat"
                        color="primary"
                        onClick={() => updateConfig({ transmitCompensationMs: 200 })}
                        className="cursor-pointer hover:bg-primary-100"
                      >
                        200ms（无线）
                      </Chip>
                    </div>

                    <div className="text-xs text-default-400 space-y-1 bg-default-50 p-3 rounded-lg">
                      <p className="font-medium">💡 使用建议：</p>
                      <p>• ICOM WLAN 模式：通常需要 50-150ms 补偿</p>
                      <p>• 本地网络：50-100ms</p>
                      <p>• 远程网络：100-200ms</p>
                      <p className="text-danger-600 font-semibold">⚠️ 设置过大（&gt;500ms）会压缩决策时间，可能影响自动回复功能</p>
                      <p>• 音频由 ICOM WLAN 直接提供，无需单独配置音频设备</p>
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
                <h4 className="font-semibold text-default-900">无电台控制</h4>
                <p className="text-sm text-default-600">不使用电台控制功能，仅进行FT8解码</p>

                <Divider />

                <div className="space-y-3">
                  <h5 className="text-sm font-medium text-default-700">
                    ⏱️ 发射时序补偿
                  </h5>
                  <p className="text-xs text-default-500">
                    补偿音频处理延迟，确保发射时间精确对齐。正值表示提前发射，负值表示延后发射。
                  </p>

                  <div className="flex items-center gap-3">
                    <Input
                      type="number"
                      label="补偿值"
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
                      重置为 0
                    </Button>
                  </div>

                  <div className="text-xs text-default-400 space-y-1 bg-default-50 p-3 rounded-lg">
                    <p className="font-medium">💡 使用建议：</p>
                    <p>• 无电台模式通常无需补偿</p>
                    <p className="text-danger-600 font-semibold">⚠️ 设置过大（&gt;500ms）会压缩决策时间，可能影响自动回复功能</p>
                    <p>• 可通过查看发射延迟统计来调整补偿值</p>
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
          <h3 className="text-xl font-bold text-default-900 mb-2">电台设备设置</h3>
          <p className="text-default-600">
            配置电台控制方式，支持网络RigCtrl和串口直连两种模式。
          </p>
        </div>

        {/* 模式选择 */}
        <div>
          <Tabs
            selectedKey={config.type}
            onSelectionChange={(key) => updateConfig({ type: key as HamlibConfig['type'] })}
            size="lg"
          >
            <Tab key="none" title="📻 无电台" />
            <Tab key="network" title="🌐 网络RigCtrl" />
            <Tab key="serial" title="🔌 串口Rig" />
            <Tab key="icom-wlan" title="📡 ICOM WLAN" />
          </Tabs>
        </div>

        {/* 配置内容 */}
        <div>
          {renderConfigContent()}
        </div>

        {/* 状态提示 */}
        <div className="flex justify-end">
          <div className="text-sm text-default-500">
            {hasUnsavedChanges() && "● 设置已修改，请保存更改"}
          </div>
        </div>
      </div>
    );
  }
);

RadioDeviceSettings.displayName = 'RadioDeviceSettings';
