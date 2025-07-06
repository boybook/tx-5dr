import React, { useState, useEffect, forwardRef, useImperativeHandle } from 'react';
import { Input, Select, SelectItem, Tabs, Tab, Card, CardBody, Divider, Button, Chip } from '@heroui/react';
import { api } from '@tx5dr/core';

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
                  <Select
                    label="电台型号"
                    placeholder="选择电台型号"
                    selectedKeys={config.rigModel ? [String(config.rigModel)] : []}
                    onSelectionChange={keys => {
                      const selectedKey = Array.from(keys)[0];
                      if (selectedKey) {
                        console.log('📡 [RadioDeviceSettings] 选择电台型号:', selectedKey);
                        updateConfig({ rigModel: Number(selectedKey) });
                      }
                    }}
                    variant="flat"
                    size="md"
                  >
                    {rigs.map(r => (
                      <SelectItem key={String(r.rigModel)}>
                        {r.mfgName} {r.modelName}
                      </SelectItem>
                    ))}
                  </Select>
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
