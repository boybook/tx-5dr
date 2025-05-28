import { useState, useEffect } from 'react';
import { api } from '@tx5dr/core';
import type { 
  AudioDevice, 
  AudioDevicesResponse, 
  AudioDeviceSettings,
  AudioDeviceSettingsResponse 
} from '@tx5dr/contracts';
import './AudioDeviceSettings.css';

interface AudioDeviceSettingsProps {
  apiBaseUrl?: string;
}

export function AudioDeviceSettings({ apiBaseUrl = 'http://localhost:4000/api' }: AudioDeviceSettingsProps) {
  
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

      // 并行获取设备列表和当前设置
      const [devicesResponse, settingsResponse] = await Promise.all([
        api.getAudioDevices(apiBaseUrl),
        api.getAudioSettings(apiBaseUrl)
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

      const response = await api.updateAudioSettings(newSettings, apiBaseUrl);
      
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

      const response = await api.resetAudioSettings(apiBaseUrl);
      
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
      <div className="audio-settings">
        <h2>音频设备设置</h2>
        <div className="loading">正在加载音频设备...</div>
      </div>
    );
  }

  return (
    <div className="audio-settings">
      <h2>音频设备设置</h2>
      
      {error && (
        <div className="error-message">
          错误: {error}
        </div>
      )}
      
      {successMessage && (
        <div className="success-message">
          {successMessage}
        </div>
      )}

      <div className="current-settings">
        <h3>当前设置</h3>
        <div className="settings-info">
          <p><strong>输入设备:</strong> {
            currentSettings.inputDeviceId 
              ? inputDevices.find(d => d.id === currentSettings.inputDeviceId)?.name || '未知设备'
              : '未设置'
          }</p>
          <p><strong>输出设备:</strong> {
            currentSettings.outputDeviceId 
              ? outputDevices.find(d => d.id === currentSettings.outputDeviceId)?.name || '未知设备'
              : '未设置'
          }</p>
          <p><strong>采样率:</strong> {currentSettings.sampleRate} Hz</p>
          <p><strong>缓冲区大小:</strong> {currentSettings.bufferSize} samples</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="settings-form">
        <div className="form-group">
          <label htmlFor="input-device">音频输入设备:</label>
          <select
            id="input-device"
            value={selectedInputDevice}
            onChange={(e) => setSelectedInputDevice(e.target.value)}
            disabled={saving}
          >
            <option value="">请选择输入设备</option>
            {inputDevices.map((device) => (
              <option key={device.id} value={device.id}>
                {device.name} {device.isDefault ? '(默认)' : ''} - {device.channels}ch, {device.sampleRate}Hz
              </option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label htmlFor="output-device">音频输出设备:</label>
          <select
            id="output-device"
            value={selectedOutputDevice}
            onChange={(e) => setSelectedOutputDevice(e.target.value)}
            disabled={saving}
          >
            <option value="">请选择输出设备</option>
            {outputDevices.map((device) => (
              <option key={device.id} value={device.id}>
                {device.name} {device.isDefault ? '(默认)' : ''} - {device.channels}ch, {device.sampleRate}Hz
              </option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label htmlFor="sample-rate">采样率 (Hz):</label>
          <select
            id="sample-rate"
            value={sampleRate}
            onChange={(e) => setSampleRate(Number(e.target.value))}
            disabled={saving}
          >
            <option value={44100}>44100 Hz</option>
            <option value={48000}>48000 Hz</option>
            <option value={96000}>96000 Hz</option>
          </select>
        </div>

        <div className="form-group">
          <label htmlFor="buffer-size">缓冲区大小 (samples):</label>
          <select
            id="buffer-size"
            value={bufferSize}
            onChange={(e) => setBufferSize(Number(e.target.value))}
            disabled={saving}
          >
            <option value={256}>256</option>
            <option value={512}>512</option>
            <option value={1024}>1024</option>
            <option value={2048}>2048</option>
          </select>
        </div>

        <div className="form-actions">
          <button 
            type="submit" 
            disabled={saving}
            className="submit-button"
          >
            {saving ? '保存中...' : '保存设置'}
          </button>
          
          <button 
            type="button" 
            onClick={handleReset}
            disabled={saving}
            className="reset-button"
          >
            重置为默认
          </button>
          
          <button 
            type="button" 
            onClick={loadAudioData}
            disabled={saving}
            className="refresh-button"
          >
            刷新设备列表
          </button>
        </div>
      </form>
    </div>
  );
} 