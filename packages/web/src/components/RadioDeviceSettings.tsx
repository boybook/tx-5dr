import React, { useState, useEffect, forwardRef, useImperativeHandle, useMemo } from 'react';
import { Input, Select, SelectItem, Autocomplete, AutocompleteItem, Tabs, Tab, Card, CardBody, Divider, Button, Chip } from '@heroui/react';
import { api } from '@tx5dr/core';
import { SerialConfig } from '@tx5dr/contracts';

export interface RadioDeviceSettingsRef {
  hasUnsavedChanges: () => boolean;
  save: () => Promise<void>;
}

interface RadioDeviceSettingsProps {
  onUnsavedChanges?: (hasChanges: boolean) => void;
}

export const RadioDeviceSettings = forwardRef<RadioDeviceSettingsRef, RadioDeviceSettingsProps>(
  ({ onUnsavedChanges }, ref) => {
  const [config, setConfig] = useState<any>({ type: 'none' });
  const [originalConfig, setOriginalConfig] = useState<any>({ type: 'none' });
  const [rigs, setRigs] = useState<any[]>([]);
  const [ports, setPorts] = useState<any[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [isTestingConnection, setIsTestingConnection] = useState(false);
  const [isTestingPTT, setIsTestingPTT] = useState(false);
  const [testResult, setTestResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

    useEffect(() => {
      loadData();
    }, []);

    const loadData = async () => {
      const [cfg, rigList, portList] = await Promise.all([
        api.getRadioConfig(),
        api.getSupportedRigs(),
        api.getSerialPorts(),
      ]);
      setConfig(cfg.config);
      setOriginalConfig(cfg.config);
      setRigs(rigList.rigs || []);
      setPorts(portList.ports || []);
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
  const updateConfig = (updates: Partial<any>) => {
    setConfig((prev: any) => ({ ...prev, ...updates }));
    // 清除之前的测试结果
    setTestResult(null);
  };

  // 更新串口配置
  const updateSerialConfig = (updates: Partial<SerialConfig>) => {
    setConfig((prev: any) => ({ 
      ...prev, 
      serialConfig: { ...prev.serialConfig, ...updates }
    }));
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
      const response = await api.testPTT();
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
                    value={config.host || ''}
                    onChange={e => updateConfig({ host: e.target.value })}
                  />
                  <Input
                    label="端口"
                    placeholder="4532"
                    type="number"
                    value={config.port || ''}
                    onChange={e => updateConfig({ port: Number(e.target.value) })}
                  />
                  <Divider />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="flat"
                      color="primary"
                      onPress={handleTestConnection}
                      isLoading={isTestingConnection}
                      isDisabled={!config.host || !config.port}
                    >
                      {isTestingConnection ? '测试连接中...' : '测试连接'}
                    </Button>
                    <Button
                      size="sm"
                      variant="flat"
                      color="secondary"
                      onPress={handleTestPTT}
                      isLoading={isTestingPTT}
                      isDisabled={!config.host || !config.port}
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
                </div>
              </CardBody>
            </Card>
          );
        case 'serial':
          return (
            <Card shadow="none" radius="lg" classNames={{ base: "border border-divider bg-content1" }}>
              <CardBody className="space-y-4 p-4">
                <h4 className="font-semibold text-default-900">串口Rig设置</h4>
                <p className="text-sm text-default-600">通过串口直接连接电台</p>
                <Divider />
                <div className="space-y-4">
                  <Select
                    label="串口"
                    placeholder="选择串口"
                    selectedKeys={config.path ? [config.path] : []}
                    onSelectionChange={keys => {
                      const selectedKey = Array.from(keys)[0];
                      if (selectedKey) {
                        updateConfig({ path: selectedKey });
                      }
                    }}
                    variant="flat"
                    size="md"
                  >
                    {ports.map(p => (
                      <SelectItem key={p.path}>
                        {p.path}
                      </SelectItem>
                    ))}
                  </Select>
                  <Autocomplete
                    label="电台型号"
                    placeholder="搜索或选择电台型号"
                    selectedKey={config.rigModel ? String(config.rigModel) : null}
                    onSelectionChange={selectedKey => {
                      if (selectedKey) {
                        console.log('📡 [RadioDeviceSettings] 选择电台型号:', selectedKey);
                        updateConfig({ rigModel: Number(selectedKey) });
                      }
                    }}
                    variant="flat"
                    size="md"
                    isVirtualized
                    showScrollIndicators={false}
                    defaultItems={rigs}
                  >
                    {(item: any) => (
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
                          selectedKeys={config.serialConfig?.rate ? [config.serialConfig.rate.toString()] : ['9600']}
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
                          selectedKeys={config.serialConfig?.data_bits ? [config.serialConfig.data_bits] : ['8']}
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
                          selectedKeys={config.serialConfig?.stop_bits ? [config.serialConfig.stop_bits] : ['1']}
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
                          selectedKeys={config.serialConfig?.serial_parity ? [config.serialConfig.serial_parity] : ['None']}
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
                          selectedKeys={config.serialConfig?.serial_handshake ? [config.serialConfig.serial_handshake] : ['None']}
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
                          selectedKeys={config.serialConfig?.rts_state ? [config.serialConfig.rts_state] : ['UNSET']}
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
                          selectedKeys={config.serialConfig?.dtr_state ? [config.serialConfig.dtr_state] : ['UNSET']}
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
                          value={config.serialConfig?.timeout?.toString() || ''}
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
                          value={config.serialConfig?.retry?.toString() || ''}
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
                          value={config.serialConfig?.write_delay?.toString() || ''}
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
                          value={config.serialConfig?.post_write_delay?.toString() || ''}
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
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="flat"
                      color="primary"
                      onPress={handleTestConnection}
                      isLoading={isTestingConnection}
                      isDisabled={!config.path || !config.rigModel}
                    >
                      {isTestingConnection ? '测试连接中...' : '测试连接'}
                    </Button>
                    <Button
                      size="sm"
                      variant="flat"
                      color="secondary"
                      onPress={handleTestPTT}
                      isLoading={isTestingPTT}
                      isDisabled={!config.path || !config.rigModel}
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
            onSelectionChange={(key) => updateConfig({ type: key })}
            size="lg"
          >
            <Tab key="none" title="📻 无电台" />
            <Tab key="network" title="🌐 网络RigCtrl" />
            <Tab key="serial" title="🔌 串口Rig" />
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
