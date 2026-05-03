import React, { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { createLogger } from '../../../utils/logger';
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
  AudioDeviceResolution,
  AudioDeviceSettings as AudioDeviceSettingsType,
  HamlibConfig,
} from '@tx5dr/contracts';
import {
  deriveBufferSizeOptions,
  deriveSampleRateOptions,
  FALLBACK_BUFFER_SIZE_OPTIONS,
  isVirtualAudioDevice,
  resolveAudioSettingNumber,
} from './audioDeviceOptions';
import {
  formatChannelText,
  formatDeviceText,
  getResolutionDescription,
  getResolutionTone,
} from './audioDeviceDisplay';

const logger = createLogger('AudioDeviceSettings');

interface AudioDeviceSettingsProps {
  onUnsavedChanges?: (hasChanges: boolean) => void;
  /** 受控模式：传入初始配置时不从 API 加载设置 */
  initialConfig?: AudioDeviceSettingsType;
  /** 受控模式：配置变更回调 */
  onChange?: (config: AudioDeviceSettingsType) => void;
  /** 受控模式下用于解析 ICOM WLAN 等虚拟音频设备 */
  radioType?: HamlibConfig['type'];
}

export interface AudioDeviceSettingsRef {
  hasUnsavedChanges: () => boolean;
  save: () => Promise<void>;
}

type Direction = 'input' | 'output';

const DEFAULT_SAMPLE_RATE = 48000;
const DEFAULT_BUFFER_SIZE = 768;

export const AudioDeviceSettings = forwardRef<AudioDeviceSettingsRef, AudioDeviceSettingsProps>(({ onUnsavedChanges, initialConfig, onChange, radioType }, ref) => {
  const { t } = useTranslation('settings');
  const isControlled = initialConfig !== undefined;
  const [inputDevices, setInputDevices] = useState<AudioDevice[]>([]);
  const [outputDevices, setOutputDevices] = useState<AudioDevice[]>([]);
  const [inputBufferSizes, setInputBufferSizes] = useState<number[]>(FALLBACK_BUFFER_SIZE_OPTIONS);
  const [outputBufferSizes, setOutputBufferSizes] = useState<number[]>(FALLBACK_BUFFER_SIZE_OPTIONS);
  const [currentSettings, setCurrentSettings] = useState<AudioDeviceSettingsType>(initialConfig ?? {});
  const [selectedInputDeviceName, setSelectedInputDeviceName] = useState<string>(initialConfig?.inputDeviceName || '');
  const [selectedOutputDeviceName, setSelectedOutputDeviceName] = useState<string>(initialConfig?.outputDeviceName || '');
  const [inputSampleRate, setInputSampleRate] = useState<number>(resolveAudioSettingNumber(initialConfig, 'inputSampleRate', 'sampleRate', DEFAULT_SAMPLE_RATE));
  const [outputSampleRate, setOutputSampleRate] = useState<number>(resolveAudioSettingNumber(initialConfig, 'outputSampleRate', 'sampleRate', DEFAULT_SAMPLE_RATE));
  const [inputBufferSize, setInputBufferSize] = useState<number>(resolveAudioSettingNumber(initialConfig, 'inputBufferSize', 'bufferSize', DEFAULT_BUFFER_SIZE));
  const [outputBufferSize, setOutputBufferSize] = useState<number>(resolveAudioSettingNumber(initialConfig, 'outputBufferSize', 'bufferSize', DEFAULT_BUFFER_SIZE));
  const [deviceResolution, setDeviceResolution] = useState<{
    input: AudioDeviceResolution;
    output: AudioDeviceResolution;
  } | null>(null);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshingDevices, setRefreshingDevices] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Sync internal state when initialConfig changes externally (e.g. auto-match from parent).
  // Uses a ref to suppress the onChange effect during sync so the parent doesn't
  // interpret the programmatic update as a manual user change.
  const initialLoadDoneRef = useRef(false);
  const syncingFromParentRef = useRef(false);
  useEffect(() => {
    if (loading) return;
    if (!initialLoadDoneRef.current) {
      initialLoadDoneRef.current = true;
      return;
    }
    if (!isControlled || !initialConfig) return;
    syncingFromParentRef.current = true;
    setSelectedInputDeviceName(initialConfig.inputDeviceName || '');
    setSelectedOutputDeviceName(initialConfig.outputDeviceName || '');
    setInputSampleRate(resolveAudioSettingNumber(initialConfig, 'inputSampleRate', 'sampleRate', DEFAULT_SAMPLE_RATE));
    setOutputSampleRate(resolveAudioSettingNumber(initialConfig, 'outputSampleRate', 'sampleRate', DEFAULT_SAMPLE_RATE));
    setInputBufferSize(resolveAudioSettingNumber(initialConfig, 'inputBufferSize', 'bufferSize', DEFAULT_BUFFER_SIZE));
    setOutputBufferSize(resolveAudioSettingNumber(initialConfig, 'outputBufferSize', 'bufferSize', DEFAULT_BUFFER_SIZE));
    return () => { syncingFromParentRef.current = false; };
  }, [initialConfig, loading, isControlled]);

  const buildSettings = (): AudioDeviceSettingsType => ({
    inputDeviceName: selectedInputDeviceName || undefined,
    outputDeviceName: selectedOutputDeviceName || undefined,
    inputSampleRate,
    outputSampleRate,
    inputBufferSize,
    outputBufferSize,
  });

  const hasUnsavedChanges = () => {
    return (
      selectedInputDeviceName !== (currentSettings.inputDeviceName || '') ||
      selectedOutputDeviceName !== (currentSettings.outputDeviceName || '') ||
      inputSampleRate !== resolveAudioSettingNumber(currentSettings, 'inputSampleRate', 'sampleRate', DEFAULT_SAMPLE_RATE) ||
      outputSampleRate !== resolveAudioSettingNumber(currentSettings, 'outputSampleRate', 'sampleRate', DEFAULT_SAMPLE_RATE) ||
      inputBufferSize !== resolveAudioSettingNumber(currentSettings, 'inputBufferSize', 'bufferSize', DEFAULT_BUFFER_SIZE) ||
      outputBufferSize !== resolveAudioSettingNumber(currentSettings, 'outputBufferSize', 'bufferSize', DEFAULT_BUFFER_SIZE)
    );
  };

  useImperativeHandle(ref, () => ({
    hasUnsavedChanges,
    save: handleSubmit
  }), [selectedInputDeviceName, selectedOutputDeviceName, inputSampleRate, outputSampleRate, inputBufferSize, outputBufferSize, currentSettings]);

  useEffect(() => {
    onUnsavedChanges?.(hasUnsavedChanges());
  }, [selectedInputDeviceName, selectedOutputDeviceName, inputSampleRate, outputSampleRate, inputBufferSize, outputBufferSize, currentSettings, onUnsavedChanges]);

  useEffect(() => {
    if (!isControlled || loading) return;
    if (syncingFromParentRef.current) return;
    onChange?.(buildSettings());
  }, [selectedInputDeviceName, selectedOutputDeviceName, inputSampleRate, outputSampleRate, inputBufferSize, outputBufferSize]);

  useEffect(() => {
    loadAudioData();
  }, []);

  useEffect(() => {
    if (loading) return;
    let active = true;

    api.resolveAudioSettings({ audio: buildSettings(), radioType })
      .then((response) => {
        if (active) {
          setDeviceResolution(response.deviceResolution);
        }
      })
      .catch((err) => {
        logger.debug('Failed to resolve audio device status:', err);
      });

    return () => {
      active = false;
    };
  }, [selectedInputDeviceName, selectedOutputDeviceName, inputSampleRate, outputSampleRate, inputBufferSize, outputBufferSize, radioType, loading]);

  const inputEffectiveDevice = getEffectiveDevice('input');
  const outputEffectiveDevice = getEffectiveDevice('output');

  useEffect(() => {
    if (inputEffectiveDevice && isVirtualAudioDevice(inputEffectiveDevice) && inputEffectiveDevice.sampleRate > 0 && inputSampleRate !== inputEffectiveDevice.sampleRate) {
      setInputSampleRate(inputEffectiveDevice.sampleRate);
    }
  }, [inputEffectiveDevice?.id, inputEffectiveDevice?.sampleRate, inputSampleRate]);

  useEffect(() => {
    if (outputEffectiveDevice && isVirtualAudioDevice(outputEffectiveDevice) && outputEffectiveDevice.sampleRate > 0 && outputSampleRate !== outputEffectiveDevice.sampleRate) {
      setOutputSampleRate(outputEffectiveDevice.sampleRate);
    }
  }, [outputEffectiveDevice?.id, outputEffectiveDevice?.sampleRate, outputSampleRate]);

  const loadAudioData = async () => {
    try {
      setLoading(true);
      setError(null);

      if (isControlled) {
        const [devicesResponse, resolutionResponse] = await Promise.all([
          api.getAudioDevices(),
          api.resolveAudioSettings({ audio: initialConfig ?? {}, radioType }),
        ]);
        applyDeviceResponse(devicesResponse);
        setDeviceResolution(resolutionResponse.deviceResolution);
      } else {
        const [devicesResponse, settingsResponse] = await Promise.all([
          api.getAudioDevices(),
          api.getAudioSettings()
        ]);

        applyDeviceResponse(devicesResponse);

        const settings = settingsResponse.currentSettings;
        setCurrentSettings(settings);
        setSelectedInputDeviceName(settings.inputDeviceName || '');
        setSelectedOutputDeviceName(settings.outputDeviceName || '');
        setInputSampleRate(resolveAudioSettingNumber(settings, 'inputSampleRate', 'sampleRate', DEFAULT_SAMPLE_RATE));
        setOutputSampleRate(resolveAudioSettingNumber(settings, 'outputSampleRate', 'sampleRate', DEFAULT_SAMPLE_RATE));
        setInputBufferSize(resolveAudioSettingNumber(settings, 'inputBufferSize', 'bufferSize', DEFAULT_BUFFER_SIZE));
        setOutputBufferSize(resolveAudioSettingNumber(settings, 'outputBufferSize', 'bufferSize', DEFAULT_BUFFER_SIZE));
        setDeviceResolution(settingsResponse.deviceResolution);
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

      const devicesResponse = await api.getAudioDevices();
      applyDeviceResponse(devicesResponse);
      const resolutionResponse = await api.resolveAudioSettings({
        audio: buildSettings(),
        radioType,
      });
      setDeviceResolution(resolutionResponse.deviceResolution);

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

      const response = await api.updateAudioSettings(buildSettings());

      if (response.success) {
        setCurrentSettings(response.currentSettings);
        setDeviceResolution(response.deviceResolution);
        setSuccessMessage(response.message || t('audio.updateSuccess'));
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

  function applyDeviceResponse(devicesResponse: Awaited<ReturnType<typeof api.getAudioDevices>>) {
    setInputDevices(devicesResponse.inputDevices);
    setOutputDevices(devicesResponse.outputDevices);
    setInputBufferSizes(devicesResponse.inputBufferSizes?.length ? devicesResponse.inputBufferSizes : FALLBACK_BUFFER_SIZE_OPTIONS);
    setOutputBufferSizes(devicesResponse.outputBufferSizes?.length ? devicesResponse.outputBufferSizes : FALLBACK_BUFFER_SIZE_OPTIONS);
  }

  function getEffectiveDevice(direction: Direction): AudioDevice | null {
    const selectedName = direction === 'input' ? selectedInputDeviceName : selectedOutputDeviceName;
    const devices = direction === 'input' ? inputDevices : outputDevices;
    const resolution = direction === 'input' ? deviceResolution?.input : deviceResolution?.output;
    return devices.find((device) => device.name === selectedName) ?? resolution?.effectiveDevice ?? null;
  }

  const renderResolutionItem = (
    selectedName: string,
    resolution: AudioDeviceResolution | null | undefined,
    devices: AudioDevice[],
  ) => {
    if (!selectedName || devices.some((device) => device.name === selectedName)) {
      return undefined;
    }

    const device = resolution?.configuredDevice ?? resolution?.effectiveDevice;
    const tone = getResolutionTone(resolution);
    const description = getResolutionDescription(t, resolution);
    const labelClass = tone === 'warning'
      ? 'text-warning'
      : tone === 'virtual'
        ? 'text-primary'
        : 'text-default-700';
    const detailClass = tone === 'warning'
      ? 'text-warning-400'
      : tone === 'virtual'
        ? 'text-primary-400'
        : 'text-default-400';
    const statusText = t('audio.deviceUnavailableShort');

    return (
      <SelectItem
        key={selectedName}
        textValue={resolution?.status === 'virtual-selected'
          ? selectedName
          : `${selectedName} (${statusText})`}
        className={tone === 'warning' ? 'text-warning' : undefined}
      >
        <div className="flex flex-col">
          <span className={labelClass}>
            {selectedName}
            {tone === 'warning' ? ` (${statusText})` : ''}
          </span>
          {device && (
            <span className="text-xs text-default-400">
              {formatChannelText(t, device.channels)}, {formatHertz(device.sampleRate)}
            </span>
          )}
          {description && <span className={`text-xs ${detailClass}`}>{description}</span>}
        </div>
      </SelectItem>
    );
  };

  const renderDeviceItems = (devices: AudioDevice[]) => devices.map((device) => (
    <SelectItem
      key={device.name}
      textValue={formatDeviceText(t, device)}
    >
      <div className="flex flex-col">
        <span className="flex items-center gap-2">
          {formatDeviceText(t, device)}
          {device.name.startsWith('[SDR]') && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-primary-100 text-primary-700 dark:bg-primary-900 dark:text-primary-300">
              WebSDR
            </span>
          )}
        </span>
        <span className="text-xs text-default-400">{formatChannelText(t, device.channels)}, {formatHertz(device.sampleRate)}</span>
      </div>
    </SelectItem>
  ));

  const renderDirectionSection = (direction: Direction) => {
    const isInput = direction === 'input';
    const selectedName = isInput ? selectedInputDeviceName : selectedOutputDeviceName;
    const setSelectedName = isInput ? setSelectedInputDeviceName : setSelectedOutputDeviceName;
    const devices = isInput ? inputDevices : outputDevices;
    const resolution = isInput ? deviceResolution?.input : deviceResolution?.output;
    const effectiveDevice = isInput ? inputEffectiveDevice : outputEffectiveDevice;
    const sampleRate = isInput ? inputSampleRate : outputSampleRate;
    const setSampleRate = isInput ? setInputSampleRate : setOutputSampleRate;
    const bufferSize = isInput ? inputBufferSize : outputBufferSize;
    const setBufferSize = isInput ? setInputBufferSize : setOutputBufferSize;
    const bufferSizes = isInput ? inputBufferSizes : outputBufferSizes;
    const sampleOptions = deriveSampleRateOptions(effectiveDevice, sampleRate);
    const bufferOptions = deriveBufferSizeOptions(bufferSizes, bufferSize);
    const isVirtual = isVirtualAudioDevice(effectiveDevice);

    return (
      <div className="space-y-3 rounded-xl border border-divider bg-content1 p-4">
        <h4 className="text-sm font-semibold text-default-700">
          {isInput ? t('audio.inputSectionTitle') : t('audio.outputSectionTitle')}
        </h4>

        <Select
          label={isInput ? t('audio.inputDevice') : t('audio.outputDevice')}
          placeholder={isInput ? t('audio.inputDevicePlaceholder') : t('audio.outputDevicePlaceholder')}
          selectedKeys={selectedName ? [selectedName] : []}
          onSelectionChange={(keys) => {
            const selected = Array.from(keys)[0] as string;
            setSelectedName(selected || '');
          }}
          isDisabled={saving}
          aria-label={isInput ? t('audio.selectInput') : t('audio.selectOutput')}
        >
          {renderResolutionItem(selectedName, resolution, devices) as unknown as React.ReactElement}
          {renderDeviceItems(devices) as unknown as React.ReactElement}
        </Select>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="space-y-1">
            <Select
              label={t('audio.sampleRate')}
              selectedKeys={[sampleRate.toString()]}
              onSelectionChange={(keys) => {
                const selected = Array.from(keys)[0] as string;
                setSampleRate(parseInt(selected, 10));
              }}
              isDisabled={saving || isVirtual}
              aria-label={isInput ? t('audio.selectInputSampleRate') : t('audio.selectOutputSampleRate')}
            >
              {sampleOptions.values.map((value) => (
                <SelectItem key={value.toString()} textValue={formatHertz(value)}>
                  {formatHertz(value)}
                </SelectItem>
              )) as unknown as React.ReactElement}
            </Select>
            {renderOptionHint(sampleOptions.isFallback, sampleOptions.isCurrentUnsupported, isVirtual, 'sampleRate')}
          </div>

          <div className="space-y-1">
            <Select
              label={t('audio.bufferSize')}
              selectedKeys={[bufferSize.toString()]}
              onSelectionChange={(keys) => {
                const selected = Array.from(keys)[0] as string;
                setBufferSize(parseInt(selected, 10));
              }}
              isDisabled={saving || isVirtual}
              aria-label={isInput ? t('audio.selectInputBufferSize') : t('audio.selectOutputBufferSize')}
            >
              {bufferOptions.values.map((value) => (
                <SelectItem key={value.toString()} textValue={formatNumber(value)}>
                  {formatNumber(value)}
                </SelectItem>
              )) as unknown as React.ReactElement}
            </Select>
            {renderOptionHint(bufferOptions.isFallback, bufferOptions.isCurrentUnsupported, isVirtual, 'bufferSize')}
          </div>
        </div>
      </div>
    );
  };

  const renderOptionHint = (
    isFallback: boolean,
    isCurrentUnsupported: boolean,
    isVirtual: boolean,
    kind: 'sampleRate' | 'bufferSize',
  ) => {
    if (isVirtual) {
      return <p className="text-xs text-primary-500">{t('audio.virtualAudioFixed')}</p>;
    }
    if (isCurrentUnsupported) {
      return <p className="text-xs text-warning-500">{t(kind === 'sampleRate' ? 'audio.sampleRateUnsupported' : 'audio.bufferSizeUnsupported')}</p>;
    }
    if (isFallback) {
      return <p className="text-xs text-default-400">{t(kind === 'sampleRate' ? 'audio.sampleRateFallback' : 'audio.bufferSizeFallback')}</p>;
    }
    return <p className="text-xs text-default-400">{t(kind === 'sampleRate' ? 'audio.sampleRateFromDevice' : 'audio.bufferSizeFromBackend')}</p>;
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
      {error && (
        <Alert color="danger" variant="flat" title={t('common.error')}>
          {error}
        </Alert>
      )}

      {successMessage && (
        <Alert color="success" variant="flat" title={t('common.success')}>
          {successMessage}
        </Alert>
      )}

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

        {renderDirectionSection('input')}
        {renderDirectionSection('output')}

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

function formatHertz(value: number): string {
  return `${formatNumber(value)} Hz`;
}

function formatNumber(value: number): string {
  return value.toLocaleString('en-US');
}
