import React, { useState, useEffect, forwardRef, useImperativeHandle } from 'react';
import { 
  Select, 
  SelectItem,
  Spinner,
  Alert,
  Button
} from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faRotateRight } from '@fortawesome/free-solid-svg-icons';
import { api } from '@tx5dr/core';
import type {
  AudioDevice,
  AudioDeviceSettings as AudioDeviceSettingsType
} from '@tx5dr/contracts';

interface AudioDeviceSettingsProps {
  onUnsavedChanges?: (hasChanges: boolean) => void;
}

export interface AudioDeviceSettingsRef {
  hasUnsavedChanges: () => boolean;
  save: () => Promise<void>;
}

export const AudioDeviceSettings = forwardRef<AudioDeviceSettingsRef, AudioDeviceSettingsProps>(({ onUnsavedChanges }, ref) => {
  // 状态管理
  const [inputDevices, setInputDevices] = useState<AudioDevice[]>([]);
  const [outputDevices, setOutputDevices] = useState<AudioDevice[]>([]);
  const [currentSettings, setCurrentSettings] = useState<AudioDeviceSettingsType>({});
  const [selectedInputDeviceName, setSelectedInputDeviceName] = useState<string>('');
  const [selectedOutputDeviceName, setSelectedOutputDeviceName] = useState<string>('');
  const [sampleRate, setSampleRate] = useState<number>(48000);
  const [bufferSize, setBufferSize] = useState<number>(1024);
  
  // 加载状态
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshingDevices, setRefreshingDevices] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // 检查是否有未保存的更改
  const hasUnsavedChanges = () => {
    return (
      selectedInputDeviceName !== (currentSettings.inputDeviceName || '') ||
      selectedOutputDeviceName !== (currentSettings.outputDeviceName || '') ||
      sampleRate !== (currentSettings.sampleRate || 48000) ||
      bufferSize !== (currentSettings.bufferSize || 1024)
    );
  };

  // 暴露给父组件的方法
  useImperativeHandle(ref, () => ({
    hasUnsavedChanges,
    save: handleSubmit
  }), [selectedInputDeviceName, selectedOutputDeviceName, sampleRate, bufferSize, currentSettings]);

  // 检查是否选择了相同的设备
  const isSameDevice = () => {
    if (!selectedInputDeviceName || !selectedOutputDeviceName) {
      return false;
    }
    
    // 根据设备名称找到对应的设备对象，比较它们的底层ID
    const inputDevice = inputDevices.find(device => device.name === selectedInputDeviceName);
    const outputDevice = outputDevices.find(device => device.name === selectedOutputDeviceName);
    
    if (!inputDevice || !outputDevice) {
      return false;
    }
    
    // 提取实际的设备ID进行比较（去除 input- 和 output- 前缀）
    const inputDeviceId = inputDevice.id.replace('input-', '');
    const outputDeviceId = outputDevice.id.replace('output-', '');
    
    return inputDeviceId === outputDeviceId;
  };

  // 监听更改并通知父组件
  useEffect(() => {
    onUnsavedChanges?.(hasUnsavedChanges());
  }, [selectedInputDeviceName, selectedOutputDeviceName, sampleRate, bufferSize, currentSettings, onUnsavedChanges]);

  // 加载音频设备和当前设置
  useEffect(() => {
    loadAudioData();
  }, []);

  const loadAudioData = async () => {
    try {
      setLoading(true);
      setError(null);

      // 并行获取设备列表和当前设置
      const [devicesResponse, settingsResponse] = await Promise.all([
        api.getAudioDevices(),
        api.getAudioSettings()
      ]);

      // 设置设备列表
      setInputDevices(devicesResponse.inputDevices);
      setOutputDevices(devicesResponse.outputDevices);

      // 设置当前配置
      const settings = settingsResponse.currentSettings;
      setCurrentSettings(settings);
      setSelectedInputDeviceName(settings.inputDeviceName || '');
      setSelectedOutputDeviceName(settings.outputDeviceName || '');
      setSampleRate(settings.sampleRate || 48000);
      setBufferSize(settings.bufferSize || 1024);

    } catch (err) {
      setError(err instanceof Error ? err.message : '加载音频设备失败');
      console.error('加载音频设备失败:', err);
    } finally {
      setLoading(false);
    }
  };

  const refreshDevices = async () => {
    try {
      setRefreshingDevices(true);
      setError(null);

      // 重新获取设备列表
      const devicesResponse = await api.getAudioDevices();
      
      setInputDevices(devicesResponse.inputDevices);
      setOutputDevices(devicesResponse.outputDevices);
      
      console.log('🔄 音频设备列表已刷新');
      
    } catch (err) {
      setError(err instanceof Error ? err.message : '刷新音频设备列表失败');
      console.error('刷新音频设备失败:', err);
    } finally {
      setRefreshingDevices(false);
    }
  };

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) {
      e.preventDefault();
    }
    
    try {
      setSaving(true);
      setError(null);
      setSuccessMessage(null);

      const newSettings: AudioDeviceSettingsType = {
        inputDeviceName: selectedInputDeviceName || undefined,
        outputDeviceName: selectedOutputDeviceName || undefined,
        sampleRate,
        bufferSize,
      };

      const response = await api.updateAudioSettings(newSettings);
      
      if (response.success) {
        setCurrentSettings(response.currentSettings);
        setSuccessMessage(response.message || '音频设备设置更新成功');
        
        // 不自动关闭弹窗，让父组件控制
        // setTimeout(() => {
        //   onClose?.();
        // }, 2000);
      } else {
        setError('更新失败');
      }

    } catch (err) {
      setError(err instanceof Error ? err.message : '更新音频设备设置失败');
      console.error('更新音频设备设置失败:', err);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <Spinner size="lg" />
          <p className="mt-4 text-default-500">正在加载音频设备...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* 错误提示 */}
      {error && (
        <Alert color="danger" variant="flat" title="错误">
          {error}
        </Alert>
      )}
      
      {/* 成功提示 */}
      {successMessage && (
        <Alert color="success" variant="flat" title="成功">
          {successMessage}
        </Alert>
      )}

      {/* 相同设备警告 */}
      {isSameDevice() && (
        <Alert color="warning" variant="flat" title="您选择了相同的音频设备作为输入和输出设备。">
          <ul className="text-sm list-disc list-inside space-y-1 ml-2 pt-2">
            <li>可能导致音频流冲突，导致输入数据接收不稳定</li>
            <li>可能出现音频暂停或断续现象</li>
          </ul>
        </Alert>
      )}

      {/* 设备配置表单 */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">音频设备配置</h3>
          <Button
            variant="flat"
            color="primary"
            size="sm"
            onPress={refreshDevices}
            isLoading={refreshingDevices}
            isDisabled={saving}
            startContent={refreshingDevices ? undefined : <FontAwesomeIcon icon={faRotateRight} />}
          >
            {refreshingDevices ? '刷新中...' : '刷新设备'}
          </Button>
        </div>
        
        <Select
          label="音频输入设备"
          placeholder="请选择输入设备"
          selectedKeys={selectedInputDeviceName ? [selectedInputDeviceName] : []}
          onSelectionChange={(keys) => {
            const selected = Array.from(keys)[0] as string;
            setSelectedInputDeviceName(selected || '');
          }}
          isDisabled={saving}
          aria-label="选择音频输入设备"
        >
          {/* 当前选中的设备如果不在可用设备列表中，则显示为失效状态 */}
          {selectedInputDeviceName && !inputDevices.find(d => d.name === selectedInputDeviceName) && (
            <SelectItem 
              key={selectedInputDeviceName}
              textValue={`${selectedInputDeviceName} (暂时失效)`}
              className="text-warning"
            >
              <div className="flex flex-col">
                <span className="text-warning">{selectedInputDeviceName} (暂时失效)</span>
                <span className="text-xs text-warning-400">设备当前不可用，请重新选择</span>
              </div>
            </SelectItem>
          )}
          {/* 可用设备列表 */}
          {inputDevices.map((device) => (
            <SelectItem 
              key={device.name}
              textValue={`${device.name} ${device.isDefault ? '(默认)' : ''}`}
            >
              <div className="flex flex-col">
                <span>{device.name} {device.isDefault ? '(默认)' : ''}</span>
                <span className="text-xs text-default-400">{device.channels}声道, {device.sampleRate}Hz</span>
              </div>
            </SelectItem>
          ))}
        </Select>

        <Select
          label="音频输出设备"
          placeholder="请选择输出设备"
          selectedKeys={selectedOutputDeviceName ? [selectedOutputDeviceName] : []}
          onSelectionChange={(keys) => {
            const selected = Array.from(keys)[0] as string;
            setSelectedOutputDeviceName(selected || '');
          }}
          isDisabled={saving}
          aria-label="选择音频输出设备"
        >
          {/* 当前选中的设备如果不在可用设备列表中，则显示为失效状态 */}
          {selectedOutputDeviceName && !outputDevices.find(d => d.name === selectedOutputDeviceName) && (
            <SelectItem 
              key={selectedOutputDeviceName}
              textValue={`${selectedOutputDeviceName} (暂时失效)`}
              className="text-warning"
            >
              <div className="flex flex-col">
                <span className="text-warning">{selectedOutputDeviceName} (暂时失效)</span>
                <span className="text-xs text-warning-400">设备当前不可用，请重新选择</span>
              </div>
            </SelectItem>
          )}
          {/* 可用设备列表 */}
          {outputDevices.map((device) => (
            <SelectItem 
              key={device.name}
              textValue={`${device.name} ${device.isDefault ? '(默认)' : ''}`}
            >
              <div className="flex flex-col">
                <span>{device.name} {device.isDefault ? '(默认)' : ''}</span>
                <span className="text-xs text-default-400">{device.channels}声道, {device.sampleRate}Hz</span>
              </div>
            </SelectItem>
          ))}
        </Select>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Select
            label="采样率 (Hz)"
            selectedKeys={[sampleRate.toString()]}
            onSelectionChange={(keys) => {
              const selected = Array.from(keys)[0] as string;
              setSampleRate(parseInt(selected));
            }}
            isDisabled={saving}
            aria-label="选择采样率"
          >
            <SelectItem key="8000" textValue="8,000 Hz">8,000 Hz</SelectItem>
            <SelectItem key="16000" textValue="16,000 Hz">16,000 Hz</SelectItem>
            <SelectItem key="22050" textValue="22,050 Hz">22,050 Hz</SelectItem>
            <SelectItem key="44100" textValue="44,100 Hz">44,100 Hz</SelectItem>
            <SelectItem key="48000" textValue="48,000 Hz">48,000 Hz</SelectItem>
            <SelectItem key="96000" textValue="96,000 Hz">96,000 Hz</SelectItem>
          </Select>

          <Select
            label="缓冲区大小 (samples)"
            selectedKeys={[bufferSize.toString()]}
            onSelectionChange={(keys) => {
              const selected = Array.from(keys)[0] as string;
              setBufferSize(parseInt(selected));
            }}
            isDisabled={saving}
            aria-label="选择缓冲区大小"
          >
            <SelectItem key="128" textValue="128">128</SelectItem>
            <SelectItem key="256" textValue="256">256</SelectItem>
            <SelectItem key="512" textValue="512">512</SelectItem>
            <SelectItem key="1024" textValue="1,024">1,024</SelectItem>
            <SelectItem key="2048" textValue="2,048">2,048</SelectItem>
            <SelectItem key="4096" textValue="4,096">4,096</SelectItem>
          </Select>
        </div>

        <div className="mt-6 p-4 bg-default-50 rounded-lg">
          <h4 className="text-sm font-medium text-default-700 mb-2">设置说明</h4>
          <ul className="text-xs text-default-600 space-y-1">
            <li>• 输入设备：用于接收FT8音频信号的设备</li>
            <li>• 输出设备：用于发送FT8音频信号的设备</li>
            <li>• 采样率：建议使用48kHz以获得最佳音质</li>
            <li>• 缓冲区：较大的缓冲区可以减少音频爆音，但会增加延迟</li>
            <li>• ⚠️ 避免选择相同设备：输入输出使用同一设备可能导致音频冲突</li>
          </ul>
        </div>
      </div>
    </div>
  );
}); 