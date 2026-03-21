import React, { useState, useEffect, forwardRef, useImperativeHandle } from 'react';
import { createLogger } from '../utils/logger';

const logger = createLogger('AudioDeviceSettings');
import { useTranslation } from 'react-i18next';
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
  /** 受控模式：传入初始配置时不从 API 加载设置 */
  initialConfig?: AudioDeviceSettingsType;
  /** 受控模式：配置变更回调 */
  onChange?: (config: AudioDeviceSettingsType) => void;
}

export interface AudioDeviceSettingsRef {
  hasUnsavedChanges: () => boolean;
  save: () => Promise<void>;
}

export const AudioDeviceSettings = forwardRef<AudioDeviceSettingsRef, AudioDeviceSettingsProps>(({ onUnsavedChanges, initialConfig, onChange }, ref) => {
  const { t } = useTranslation('settings');
  const isControlled = initialConfig !== undefined;
  // 状态管理
  const [inputDevices, setInputDevices] = useState<AudioDevice[]>([]);
  const [outputDevices, setOutputDevices] = useState<AudioDevice[]>([]);
  const [currentSettings, setCurrentSettings] = useState<AudioDeviceSettingsType>(initialConfig ?? {});
  const [selectedInputDeviceName, setSelectedInputDeviceName] = useState<string>(initialConfig?.inputDeviceName || '');
  const [selectedOutputDeviceName, setSelectedOutputDeviceName] = useState<string>(initialConfig?.outputDeviceName || '');
  const [sampleRate, setSampleRate] = useState<number>(initialConfig?.sampleRate || 48000);
  const [bufferSize, setBufferSize] = useState<number>(initialConfig?.bufferSize || 1024);
  
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

  // 监听更改并通知父组件
  useEffect(() => {
    onUnsavedChanges?.(hasUnsavedChanges());
  }, [selectedInputDeviceName, selectedOutputDeviceName, sampleRate, bufferSize, currentSettings, onUnsavedChanges]);

  // 受控模式：配置变更时通知父组件
  useEffect(() => {
    if (!isControlled || loading) return;
    onChange?.({
      inputDeviceName: selectedInputDeviceName || undefined,
      outputDeviceName: selectedOutputDeviceName || undefined,
      sampleRate,
      bufferSize,
    });
  }, [selectedInputDeviceName, selectedOutputDeviceName, sampleRate, bufferSize]);

  // 加载音频设备和当前设置
  useEffect(() => {
    loadAudioData();
  }, []);

  const loadAudioData = async () => {
    try {
      setLoading(true);
      setError(null);

      if (isControlled) {
        // 受控模式：只加载设备列表，不加载设置
        const devicesResponse = await api.getAudioDevices();
        setInputDevices(devicesResponse.inputDevices);
        setOutputDevices(devicesResponse.outputDevices);
      } else {
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
      }

    } catch (err) {
      setError(err instanceof Error ? err.message : t('audio.loadFailed'));
      logger.error('Failed to load audio devices:', err);
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
      
      logger.debug('Audio device list refreshed');
      
    } catch (err) {
      setError(err instanceof Error ? err.message : t('audio.refreshFailed'));
      logger.error('Failed to refresh audio devices:', err);
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
        setSuccessMessage(response.message || t('audio.updateSuccess'));
        
        // 不自动关闭弹窗，让父组件控制
        // setTimeout(() => {
        //   onClose?.();
        // }, 2000);
      } else {
        setError(t('audio.updateFailedGeneric'));
      }

    } catch (err) {
      setError(err instanceof Error ? err.message : t('audio.updateFailed'));
      logger.error('Failed to update audio device settings:', err);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <Spinner size="lg" />
          <p className="mt-4 text-default-500">{t('audio.loading')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* 错误提示 */}
      {error && (
        <Alert color="danger" variant="flat" title={t('common.error')}>
          {error}
        </Alert>
      )}

      {/* 成功提示 */}
      {successMessage && (
        <Alert color="success" variant="flat" title={t('common.success')}>
          {successMessage}
        </Alert>
      )}

      {/* 设备配置表单 */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">{t('audio.deviceConfig')}</h3>
          <Button
            variant="flat"
            color="primary"
            size="sm"
            onPress={refreshDevices}
            isLoading={refreshingDevices}
            isDisabled={saving}
            startContent={refreshingDevices ? undefined : <FontAwesomeIcon icon={faRotateRight} />}
          >
            {refreshingDevices ? t('audio.refreshing') : t('audio.refreshDevices')}
          </Button>
        </div>
        
        <Select
          label={t('audio.inputDevice')}
          placeholder={t('audio.inputDevicePlaceholder')}
          selectedKeys={selectedInputDeviceName ? [selectedInputDeviceName] : []}
          onSelectionChange={(keys) => {
            const selected = Array.from(keys)[0] as string;
            setSelectedInputDeviceName(selected || '');
          }}
          isDisabled={saving}
          aria-label={t('audio.selectInput')}
        >
          {/* 当前选中的设备如果不在可用设备列表中，则显示为失效状态 */}
          {selectedInputDeviceName && !inputDevices.find(d => d.name === selectedInputDeviceName) && (
            <SelectItem
              key={selectedInputDeviceName}
              textValue={`${selectedInputDeviceName} (${t('audio.deviceUnavailableShort')})`}
              className="text-warning"
            >
              <div className="flex flex-col">
                <span className="text-warning">{selectedInputDeviceName} ({t('audio.deviceUnavailableShort')})</span>
                <span className="text-xs text-warning-400">{t('audio.deviceUnavailable')}</span>
              </div>
            </SelectItem>
          )}
          {/* 可用设备列表 */}
          {inputDevices.map((device) => (
            <SelectItem
              key={device.name}
              textValue={`${device.name} ${device.isDefault ? `(${t('audio.default')})` : ''}`}
            >
              <div className="flex flex-col">
                <span>{device.name} {device.isDefault ? `(${t('audio.default')})` : ''}</span>
                <span className="text-xs text-default-400">{device.channels}{t('audio.channels')}, {device.sampleRate}Hz</span>
              </div>
            </SelectItem>
          ))}
        </Select>

        <Select
          label={t('audio.outputDevice')}
          placeholder={t('audio.outputDevicePlaceholder')}
          selectedKeys={selectedOutputDeviceName ? [selectedOutputDeviceName] : []}
          onSelectionChange={(keys) => {
            const selected = Array.from(keys)[0] as string;
            setSelectedOutputDeviceName(selected || '');
          }}
          isDisabled={saving}
          aria-label={t('audio.selectOutput')}
        >
          {/* 当前选中的设备如果不在可用设备列表中，则显示为失效状态 */}
          {selectedOutputDeviceName && !outputDevices.find(d => d.name === selectedOutputDeviceName) && (
            <SelectItem
              key={selectedOutputDeviceName}
              textValue={`${selectedOutputDeviceName} (${t('audio.deviceUnavailableShort')})`}
              className="text-warning"
            >
              <div className="flex flex-col">
                <span className="text-warning">{selectedOutputDeviceName} ({t('audio.deviceUnavailableShort')})</span>
                <span className="text-xs text-warning-400">{t('audio.deviceUnavailable')}</span>
              </div>
            </SelectItem>
          )}
          {/* 可用设备列表 */}
          {outputDevices.map((device) => (
            <SelectItem
              key={device.name}
              textValue={`${device.name} ${device.isDefault ? `(${t('audio.default')})` : ''}`}
            >
              <div className="flex flex-col">
                <span>{device.name} {device.isDefault ? `(${t('audio.default')})` : ''}</span>
                <span className="text-xs text-default-400">{device.channels}{t('audio.channels')}, {device.sampleRate}Hz</span>
              </div>
            </SelectItem>
          ))}
        </Select>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Select
            label={t('audio.sampleRate')}
            selectedKeys={[sampleRate.toString()]}
            onSelectionChange={(keys) => {
              const selected = Array.from(keys)[0] as string;
              setSampleRate(parseInt(selected));
            }}
            isDisabled={saving}
            aria-label={t('audio.selectSampleRate')}
          >
            <SelectItem key="8000" textValue="8,000 Hz">8,000 Hz</SelectItem>
            <SelectItem key="16000" textValue="16,000 Hz">16,000 Hz</SelectItem>
            <SelectItem key="22050" textValue="22,050 Hz">22,050 Hz</SelectItem>
            <SelectItem key="44100" textValue="44,100 Hz">44,100 Hz</SelectItem>
            <SelectItem key="48000" textValue="48,000 Hz">48,000 Hz</SelectItem>
            <SelectItem key="96000" textValue="96,000 Hz">96,000 Hz</SelectItem>
          </Select>

          <Select
            label={t('audio.bufferSize')}
            selectedKeys={[bufferSize.toString()]}
            onSelectionChange={(keys) => {
              const selected = Array.from(keys)[0] as string;
              setBufferSize(parseInt(selected));
            }}
            isDisabled={saving}
            aria-label={t('audio.selectBufferSize')}
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
          <h4 className="text-sm font-medium text-default-700 mb-2">{t('audio.settingsNote')}</h4>
          <ul className="text-xs text-default-600 space-y-1">
            <li>• {t('audio.noteInput')}</li>
            <li>• {t('audio.noteOutput')}</li>
            <li>• {t('audio.noteSampleRate')}</li>
            <li>• {t('audio.noteBuffer')}</li>
          </ul>
        </div>
      </div>
    </div>
  );
}); 