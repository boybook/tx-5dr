import React, { useState, useEffect, forwardRef, useImperativeHandle } from 'react';
import { 
  Select, 
  SelectItem,
  Spinner,
  Alert
} from '@heroui/react';
import { api } from '@tx5dr/core';
import type { 
  AudioDevice, 
  AudioDevicesResponse, 
  AudioDeviceSettings as AudioDeviceSettingsType,
  AudioDeviceSettingsResponse 
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
  const [selectedInputDevice, setSelectedInputDevice] = useState<string>('');
  const [selectedOutputDevice, setSelectedOutputDevice] = useState<string>('');
  const [sampleRate, setSampleRate] = useState<number>(48000);
  const [bufferSize, setBufferSize] = useState<number>(1024);
  
  // 加载状态
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // 检查是否有未保存的更改
  const hasUnsavedChanges = () => {
    return (
      selectedInputDevice !== (currentSettings.inputDeviceId || '') ||
      selectedOutputDevice !== (currentSettings.outputDeviceId || '') ||
      sampleRate !== (currentSettings.sampleRate || 48000) ||
      bufferSize !== (currentSettings.bufferSize || 1024)
    );
  };

  // 暴露给父组件的方法
  useImperativeHandle(ref, () => ({
    hasUnsavedChanges,
    save: handleSubmit
  }), [selectedInputDevice, selectedOutputDevice, sampleRate, bufferSize, currentSettings]);

  // 监听更改并通知父组件
  useEffect(() => {
    onUnsavedChanges?.(hasUnsavedChanges());
  }, [selectedInputDevice, selectedOutputDevice, sampleRate, bufferSize, currentSettings, onUnsavedChanges]);

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
      setSelectedInputDevice(settings.inputDeviceId || '');
      setSelectedOutputDevice(settings.outputDeviceId || '');
      setSampleRate(settings.sampleRate || 48000);
      setBufferSize(settings.bufferSize || 1024);

    } catch (err) {
      setError(err instanceof Error ? err.message : '加载音频设备失败');
      console.error('加载音频设备失败:', err);
    } finally {
      setLoading(false);
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
        inputDeviceId: selectedInputDevice || undefined,
        outputDeviceId: selectedOutputDevice || undefined,
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

  const handleReset = async () => {
    try {
      setSaving(true);
      setError(null);
      setSuccessMessage(null);

      const response = await api.resetAudioSettings();
      
      if (response.success) {
        setCurrentSettings(response.currentSettings);
        setSelectedInputDevice(response.currentSettings.inputDeviceId || '');
        setSelectedOutputDevice(response.currentSettings.outputDeviceId || '');
        setSampleRate(response.currentSettings.sampleRate || 48000);
        setBufferSize(response.currentSettings.bufferSize || 1024);
        setSuccessMessage(response.message || '音频设备设置已重置');
      }

    } catch (err) {
      setError(err instanceof Error ? err.message : '重置音频设备设置失败');
      console.error('重置音频设备设置失败:', err);
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

      {/* 设备配置表单 */}
      <div className="space-y-4">
        <h3 className="text-lg font-semibold">音频设备配置</h3>
        
        <Select
          label="音频输入设备"
          placeholder="请选择输入设备"
          selectedKeys={selectedInputDevice ? [selectedInputDevice] : []}
          onSelectionChange={(keys) => {
            const selected = Array.from(keys)[0] as string;
            setSelectedInputDevice(selected || '');
          }}
          isDisabled={saving}
          aria-label="选择音频输入设备"
        >
          {inputDevices.map((device) => (
            <SelectItem 
              key={device.id}
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
          selectedKeys={selectedOutputDevice ? [selectedOutputDevice] : []}
          onSelectionChange={(keys) => {
            const selected = Array.from(keys)[0] as string;
            setSelectedOutputDevice(selected || '');
          }}
          isDisabled={saving}
          aria-label="选择音频输出设备"
        >
          {outputDevices.map((device) => (
            <SelectItem 
              key={device.id}
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
          </ul>
        </div>
      </div>
    </div>
  );
}); 