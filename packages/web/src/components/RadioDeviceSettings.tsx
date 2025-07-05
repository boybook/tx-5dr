import React, { useState, useEffect, forwardRef, useImperativeHandle } from 'react';
import { Input, Select, SelectItem, Button } from '@heroui/react';
import { api } from '@tx5dr/core';

export interface RadioDeviceSettingsRef {
  hasUnsavedChanges: () => boolean;
  save: () => Promise<void>;
}

export const RadioDeviceSettings = forwardRef<RadioDeviceSettingsRef>((_, ref) => {
  const [config, setConfig] = useState<any>({ type: 'none' });
  const [rigs, setRigs] = useState<any[]>([]);
  const [ports, setPorts] = useState<any[]>([]);

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
    setRigs(rigList.rigs || []);
    setPorts(portList.ports || []);
  };

  const hasUnsavedChanges = () => false; // simplified
  useImperativeHandle(ref, () => ({ hasUnsavedChanges, save: handleSave }), [config]);

  const handleSave = async () => {
    await api.updateRadioConfig(config);
  };

  return (
    <div className="flex flex-col gap-2">
      <Select
        label="模式"
        selectedKeys={[config.type]}
        onSelectionChange={(keys) => setConfig({ ...config, type: Array.from(keys)[0] })}
      >
        <SelectItem key="none">无电台</SelectItem>
        <SelectItem key="network">网络RigCtrl</SelectItem>
        <SelectItem key="serial">串口Rig</SelectItem>
      </Select>
      {config.type === 'network' && (
        <>
          <Input label="主机" value={config.host || ''} onChange={e => setConfig({ ...config, host: e.target.value })} />
          <Input label="端口" value={config.port || ''} onChange={e => setConfig({ ...config, port: Number(e.target.value) })} />
        </>
      )}
      {config.type === 'serial' && (
        <>
          <Select label="串口" selectedKeys={[config.path || '']} onSelectionChange={keys => setConfig({ ...config, path: Array.from(keys)[0] })}>
            {ports.map(p => <SelectItem key={p.path}>{p.path}</SelectItem>)}
          </Select>
          <Select label="电台型号" selectedKeys={[String(config.rigModel || '')]} onSelectionChange={keys => setConfig({ ...config, rigModel: Number(Array.from(keys)[0]) })}>
            {rigs.map(r => <SelectItem key={r.rigModel}>{r.mfgName} {r.modelName}</SelectItem>)}
          </Select>
        </>
      )}
      <Button onClick={handleSave}>保存</Button>
    </div>
  );
});

RadioDeviceSettings.displayName = 'RadioDeviceSettings';
