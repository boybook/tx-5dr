import React, { useState, useEffect } from 'react';
import { 
  Card, 
  CardBody, 
  CardHeader, 
  Button, 
  Select, 
  SelectItem,
  Input,
  Divider,
  Spinner,
  Chip
} from '@heroui/react';
import { api } from '@tx5dr/core';
import type { 
  AudioDevice, 
  AudioDevicesResponse, 
  AudioDeviceSettings,
  AudioDeviceSettingsResponse 
} from '@tx5dr/contracts';

export function AudioDeviceSettings() {
  // 状态管理
  const [inputDevices, setInputDevices] = useState<AudioDevice[]>([]);
  const [outputDevices, setOutputDevices] = useState<AudioDevice[]>([]);
  const [currentSettings, setCurrentSettings] = useState<AudioDeviceSettings>({});
  const [selectedInputDevice, setSelectedInputDevice] = useState<string>('');
  const [selectedOutputDevice, setSelectedOutputDevice] = useState<string>('');
  const [sampleRate, setSampleRate] = useState<number>(48000);
  const [bufferSize, setBufferSize] = useState<number>(1024);
  
  // 加载状态
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // 加载音频设备和当前设置
  useEffect(() => {
    loadAudioData();
  }, []);

  const loadAudioData = async () => {
    try {
      setLoading(true);
      setError(null);

      // 并行获取设备列表和当前设置，直接调用API
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    try {
      setSaving(true);
      setError(null);
      setSuccessMessage(null);

      const newSettings: AudioDeviceSettings = {
        inputDeviceId: selectedInputDevice || undefined,
        outputDeviceId: selectedOutputDevice || undefined,
        sampleRate,
        bufferSize,
      };

      const response = await api.updateAudioSettings(newSettings);
      
      if (response.success) {
        setCurrentSettings(response.currentSettings);
        setSuccessMessage(response.message || '音频设备设置更新成功');
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
      <Card>
        <CardBody className="flex items-center justify-center py-12">
          <div className="text-center">
            <Spinner size="lg" />
            <p className="mt-4 text-default-500">正在加载音频设备...</p>
          </div>
        </CardBody>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <h2 className="text-xl font-bold">🎤 音频设备设置</h2>
        </CardHeader>
      </Card>
      
      {error && (
        <Card>
          <CardBody>
            <div className="bg-danger-50 border border-danger-200 rounded-lg p-4">
              <p className="text-danger-800 font-medium">错误: {error}</p>
            </div>
          </CardBody>
        </Card>
      )}
      
      {successMessage && (
        <Card>
          <CardBody>
            <div className="bg-success-50 border border-success-200 rounded-lg p-4">
              <p className="text-success-800 font-medium">{successMessage}</p>
            </div>
          </CardBody>
        </Card>
      )}

      {/* 当前设置 */}
      <Card>
        <CardHeader>
          <h3 className="text-lg font-semibold">当前设置</h3>
        </CardHeader>
        <CardBody>
          <div className="space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-default-600">输入设备:</span>
              <Chip color="primary" variant="flat">
                {currentSettings.inputDeviceId 
                  ? inputDevices.find(d => d.id === currentSettings.inputDeviceId)?.name || '未知设备'
                  : '未设置'
                }
              </Chip>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-default-600">输出设备:</span>
              <Chip color="primary" variant="flat">
                {currentSettings.outputDeviceId 
                  ? outputDevices.find(d => d.id === currentSettings.outputDeviceId)?.name || '未知设备'
                  : '未设置'
                }
              </Chip>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-default-600">采样率:</span>
              <span className="font-mono">{currentSettings.sampleRate} Hz</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-default-600">缓冲区大小:</span>
              <span className="font-mono">{currentSettings.bufferSize} samples</span>
            </div>
          </div>
        </CardBody>
      </Card>

      {/* 设置表单 */}
      <Card>
        <CardHeader>
          <h3 className="text-lg font-semibold">设备配置</h3>
        </CardHeader>
        <CardBody>
          <form onSubmit={handleSubmit} className="space-y-6">
            <Select
              label="音频输入设备"
              placeholder="请选择输入设备"
              selectedKeys={selectedInputDevice ? [selectedInputDevice] : []}
              onSelectionChange={(keys) => {
                const selected = Array.from(keys)[0] as string;
                setSelectedInputDevice(selected || '');
              }}
              isDisabled={saving}
            >
              {inputDevices.map((device) => (
                <SelectItem 
                  key={device.id}
                  textValue={`${device.name} ${device.isDefault ? '(默认)' : ''} - ${device.channels}ch, ${device.sampleRate}Hz`}
                >
                  {device.name} {device.isDefault ? '(默认)' : ''} - {device.channels}ch, {device.sampleRate}Hz
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
            >
              {outputDevices.map((device) => (
                <SelectItem 
                  key={device.id}
                  textValue={`${device.name} ${device.isDefault ? '(默认)' : ''} - ${device.channels}ch, ${device.sampleRate}Hz`}
                >
                  {device.name} {device.isDefault ? '(默认)' : ''} - {device.channels}ch, {device.sampleRate}Hz
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
              >
                <SelectItem key="128" textValue="128">128</SelectItem>
                <SelectItem key="256" textValue="256">256</SelectItem>
                <SelectItem key="512" textValue="512">512</SelectItem>
                <SelectItem key="1024" textValue="1,024">1,024</SelectItem>
                <SelectItem key="2048" textValue="2,048">2,048</SelectItem>
                <SelectItem key="4096" textValue="4,096">4,096</SelectItem>
              </Select>
            </div>

            <Divider />

            <div className="flex gap-3">
              <Button 
                type="submit"
                color="primary"
                isLoading={saving}
                startContent={!saving ? "💾" : undefined}
              >
                {saving ? '保存中...' : '保存设置'}
              </Button>
              
              <Button 
                type="button"
                color="default"
                variant="bordered"
                onPress={handleReset}
                isLoading={saving}
                startContent={!saving ? "🔄" : undefined}
              >
                {saving ? '重置中...' : '重置为默认'}
              </Button>
              
              <Button 
                type="button"
                color="secondary"
                variant="bordered"
                onPress={loadAudioData}
                isLoading={loading}
                startContent={!loading ? "🔍" : undefined}
              >
                {loading ? '刷新中...' : '刷新设备列表'}
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>

      {/* 设备列表 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <h3 className="text-lg font-semibold">可用输入设备</h3>
          </CardHeader>
          <CardBody>
            <div className="space-y-2">
              {inputDevices.length === 0 ? (
                <p className="text-default-500">未找到输入设备</p>
              ) : (
                inputDevices.map((device) => (
                  <div key={device.id} className="p-3 border border-divider rounded-lg">
                    <div className="flex justify-between items-start">
                      <div>
                        <p className="font-medium">{device.name}</p>
                        <p className="text-sm text-default-500">
                          {device.channels}声道, {device.sampleRate}Hz
                        </p>
                      </div>
                      {device.isDefault && (
                        <Chip size="sm" color="success" variant="flat">默认</Chip>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <h3 className="text-lg font-semibold">可用输出设备</h3>
          </CardHeader>
          <CardBody>
            <div className="space-y-2">
              {outputDevices.length === 0 ? (
                <p className="text-default-500">未找到输出设备</p>
              ) : (
                outputDevices.map((device) => (
                  <div key={device.id} className="p-3 border border-divider rounded-lg">
                    <div className="flex justify-between items-start">
                      <div>
                        <p className="font-medium">{device.name}</p>
                        <p className="text-sm text-default-500">
                          {device.channels}声道, {device.sampleRate}Hz
                        </p>
                      </div>
                      {device.isDefault && (
                        <Chip size="sm" color="success" variant="flat">默认</Chip>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </CardBody>
        </Card>
      </div>
    </div>
  );
} 