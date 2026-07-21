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
  AudioOutputChannelMode,
  AudioOutputSampleFormat,
  HamlibConfig,
} from '@tx5dr/contracts';
import {
  deriveBufferSizeOptions,
  deriveSampleRateOptions,
  FALLBACK_BUFFER_SIZE_OPTIONS,
  getFixedAudioDeviceNumber,
  isAudioDeviceControlConfigurable,
  isVirtualAudioDevice,
  resolveAudioSettingNumber,
} from './audioDeviceOptions';
import {
  formatChannelText,
  formatDeviceText,
  getAudioDeviceCategory,
  getAudioDeviceStatusBadges,
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
  getSettings: () => AudioDeviceSettingsType;
  save: () => Promise<void>;
}

export type Direction = 'input' | 'output';

const DEFAULT_SAMPLE_RATE = 48000;
const DEFAULT_BUFFER_SIZE = 1024;
const DEFAULT_OUTPUT_SAMPLE_FORMAT: AudioOutputSampleFormat = 'float32';
const DEFAULT_OUTPUT_CHANNEL_MODE: AudioOutputChannelMode = 'mono';
const OUTPUT_SAMPLE_FORMAT_OPTIONS: AudioOutputSampleFormat[] = ['float32', 'int16'];
const OUTPUT_CHANNEL_MODE_OPTIONS: AudioOutputChannelMode[] = ['mono', 'left', 'right', 'both'];

export function makeAudioDeviceSelectKey(direction: Direction, identity: string): string {
  return `${direction}::${identity}`;
}

export function getDeviceNameFromSelectKey(direction: Direction, key: string): string {
  const prefix = `${direction}::`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

export interface AudioDeviceSelectOption {
  key: string;
  deviceName: string;
  routeKey?: string;
  device: AudioDevice | null;
  isMissing: boolean;
}

export function buildAudioDeviceSelectOptions(
  direction: Direction,
  devices: AudioDevice[],
  selectedName: string,
  resolution?: AudioDeviceResolution | null,
  selectedRouteKey?: string,
): AudioDeviceSelectOption[] {
  const options: AudioDeviceSelectOption[] = devices.map((device) => ({
    key: makeAudioDeviceSelectKey(direction, device.routeKey ?? device.name),
    deviceName: device.name,
    routeKey: device.routeKey,
    device,
    isMissing: isUnavailableAudioDevice(device),
  }));

  const selectedDeviceExists = selectedRouteKey
    ? devices.some((device) => device.routeKey === selectedRouteKey)
    : selectedName
      ? devices.some((device) => device.name === selectedName)
      : true;
  const resolutionMatchesSelection = selectedRouteKey
    ? resolution?.configuredRouteKey === selectedRouteKey
    : !resolution?.configuredDeviceName || resolution.configuredDeviceName === selectedName;

  if ((selectedName || selectedRouteKey) && !selectedDeviceExists) {
    const resolvedOptionDevice = resolutionMatchesSelection && resolution?.status !== 'missing'
      ? resolution?.effectiveDevice ?? null
      : null;
    const displayName = selectedName || resolvedOptionDevice?.name || selectedRouteKey || '';
    options.push({
      key: makeAudioDeviceSelectKey(direction, selectedRouteKey ?? displayName),
      deviceName: displayName,
      routeKey: selectedRouteKey,
      device: resolvedOptionDevice,
      isMissing: !resolvedOptionDevice || isUnavailableAudioDevice(resolvedOptionDevice),
    });
  }

  return options;
}

function isUnavailableAudioDevice(device: AudioDevice): boolean {
  return device.availability === 'cached'
    || device.routeState === 'lost'
    || device.routeState === 'unavailable'
    || device.routeState === 'failed';
}

export function getSelectedAudioDeviceKey(
  direction: Direction,
  deviceName: string,
  routeKey?: string,
): string {
  return deviceName || routeKey
    ? makeAudioDeviceSelectKey(direction, routeKey ?? deviceName)
    : '';
}

export function resolveUniqueRouteKey(devices: AudioDevice[], deviceName: string): string {
  const matchingRouteKeys = devices
    .filter((device) => device.name === deviceName && device.routeKey)
    .map((device) => device.routeKey as string);
  return matchingRouteKeys.length === 1 ? matchingRouteKeys[0] : '';
}

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
  const [selectedInputRouteKey, setSelectedInputRouteKey] = useState<string>(initialConfig?.inputRouteKey || '');
  const [selectedOutputRouteKey, setSelectedOutputRouteKey] = useState<string>(initialConfig?.outputRouteKey || '');
  const [inputSampleRate, setInputSampleRate] = useState<number>(resolveAudioSettingNumber(initialConfig, 'inputSampleRate', 'sampleRate', DEFAULT_SAMPLE_RATE));
  const [outputSampleRate, setOutputSampleRate] = useState<number>(resolveAudioSettingNumber(initialConfig, 'outputSampleRate', 'sampleRate', DEFAULT_SAMPLE_RATE));
  const [inputBufferSize, setInputBufferSize] = useState<number>(resolveAudioSettingNumber(initialConfig, 'inputBufferSize', 'bufferSize', DEFAULT_BUFFER_SIZE));
  const [outputBufferSize, setOutputBufferSize] = useState<number>(resolveAudioSettingNumber(initialConfig, 'outputBufferSize', 'bufferSize', DEFAULT_BUFFER_SIZE));
  const [outputSampleFormat, setOutputSampleFormat] = useState<AudioOutputSampleFormat>(resolveOutputSampleFormat(initialConfig));
  const [outputChannelMode, setOutputChannelMode] = useState<AudioOutputChannelMode>(resolveOutputChannelMode(initialConfig));
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
  // The ref suppresses the echo onChange until local state has caught up with props.
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
    setSelectedInputRouteKey(initialConfig.inputRouteKey || '');
    setSelectedOutputRouteKey(initialConfig.outputRouteKey || '');
    setInputSampleRate(resolveAudioSettingNumber(initialConfig, 'inputSampleRate', 'sampleRate', DEFAULT_SAMPLE_RATE));
    setOutputSampleRate(resolveAudioSettingNumber(initialConfig, 'outputSampleRate', 'sampleRate', DEFAULT_SAMPLE_RATE));
    setInputBufferSize(resolveAudioSettingNumber(initialConfig, 'inputBufferSize', 'bufferSize', DEFAULT_BUFFER_SIZE));
    setOutputBufferSize(resolveAudioSettingNumber(initialConfig, 'outputBufferSize', 'bufferSize', DEFAULT_BUFFER_SIZE));
    setOutputSampleFormat(resolveOutputSampleFormat(initialConfig));
    setOutputChannelMode(resolveOutputChannelMode(initialConfig));
    return () => { syncingFromParentRef.current = false; };
  }, [initialConfig, loading, isControlled]);

  const buildSettings = (): AudioDeviceSettingsType => ({
    inputDeviceName: resolveSelectedDeviceName('input') || undefined,
    outputDeviceName: resolveSelectedDeviceName('output') || undefined,
    inputRouteKey: resolveSelectedRouteKey('input') || null,
    outputRouteKey: resolveSelectedRouteKey('output') || null,
    inputSampleRate,
    outputSampleRate,
    inputBufferSize,
    outputBufferSize,
    outputSampleFormat,
    outputChannelMode,
  });

  const hasUnsavedChanges = () => {
    return (
      resolveSelectedDeviceName('input') !== (currentSettings.inputDeviceName || '') ||
      resolveSelectedDeviceName('output') !== (currentSettings.outputDeviceName || '') ||
      resolveSelectedRouteKey('input') !== (currentSettings.inputRouteKey || '') ||
      resolveSelectedRouteKey('output') !== (currentSettings.outputRouteKey || '') ||
      inputSampleRate !== resolveAudioSettingNumber(currentSettings, 'inputSampleRate', 'sampleRate', DEFAULT_SAMPLE_RATE) ||
      outputSampleRate !== resolveAudioSettingNumber(currentSettings, 'outputSampleRate', 'sampleRate', DEFAULT_SAMPLE_RATE) ||
      inputBufferSize !== resolveAudioSettingNumber(currentSettings, 'inputBufferSize', 'bufferSize', DEFAULT_BUFFER_SIZE) ||
      outputBufferSize !== resolveAudioSettingNumber(currentSettings, 'outputBufferSize', 'bufferSize', DEFAULT_BUFFER_SIZE) ||
      outputSampleFormat !== resolveOutputSampleFormat(currentSettings) ||
      outputChannelMode !== resolveOutputChannelMode(currentSettings)
    );
  };

  useImperativeHandle(ref, () => ({
    hasUnsavedChanges,
    getSettings: buildSettings,
    save: handleSubmit
  }), [selectedInputDeviceName, selectedOutputDeviceName, selectedInputRouteKey, selectedOutputRouteKey, inputDevices, outputDevices, inputSampleRate, outputSampleRate, inputBufferSize, outputBufferSize, outputSampleFormat, outputChannelMode, currentSettings]);

  useEffect(() => {
    onUnsavedChanges?.(hasUnsavedChanges());
  }, [selectedInputDeviceName, selectedOutputDeviceName, selectedInputRouteKey, selectedOutputRouteKey, inputDevices, outputDevices, inputSampleRate, outputSampleRate, inputBufferSize, outputBufferSize, outputSampleFormat, outputChannelMode, currentSettings, onUnsavedChanges]);

  useEffect(() => {
    if (!isControlled || loading) return;
    const settings = buildSettings();
    if (syncingFromParentRef.current) {
      if (audioSettingsEqual(settings, initialConfig)) {
        syncingFromParentRef.current = false;
      }
      return;
    }
    if (audioSettingsEqual(settings, initialConfig)) {
      return;
    }
    onChange?.(settings);
  }, [selectedInputDeviceName, selectedOutputDeviceName, selectedInputRouteKey, selectedOutputRouteKey, inputDevices, outputDevices, inputSampleRate, outputSampleRate, inputBufferSize, outputBufferSize, outputSampleFormat, outputChannelMode, initialConfig]);

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
  }, [selectedInputDeviceName, selectedOutputDeviceName, selectedInputRouteKey, selectedOutputRouteKey, inputSampleRate, outputSampleRate, inputBufferSize, outputBufferSize, outputSampleFormat, outputChannelMode, radioType, loading]);

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

  useEffect(() => {
    const fixedSampleRate = getFixedAudioDeviceNumber(inputEffectiveDevice, 'sampleRate');
    const fixedBufferSize = getFixedAudioDeviceNumber(inputEffectiveDevice, 'bufferSize');
    if (fixedSampleRate && inputSampleRate !== fixedSampleRate) setInputSampleRate(fixedSampleRate);
    if (fixedBufferSize && inputBufferSize !== fixedBufferSize) setInputBufferSize(fixedBufferSize);
  }, [inputEffectiveDevice?.routeKey, inputEffectiveDevice?.capabilities, inputSampleRate, inputBufferSize]);

  useEffect(() => {
    const fixedSampleRate = getFixedAudioDeviceNumber(outputEffectiveDevice, 'sampleRate');
    const fixedBufferSize = getFixedAudioDeviceNumber(outputEffectiveDevice, 'bufferSize');
    const capabilities = outputEffectiveDevice?.capabilities;
    if (fixedSampleRate && outputSampleRate !== fixedSampleRate) setOutputSampleRate(fixedSampleRate);
    if (fixedBufferSize && outputBufferSize !== fixedBufferSize) setOutputBufferSize(fixedBufferSize);
    if (capabilities?.sampleFormatConfigurable === false && capabilities.sampleFormats?.length === 1) {
      setOutputSampleFormat(capabilities.sampleFormats[0]);
    }
    if ((capabilities?.channelModeConfigurable === false || capabilities?.fixedChannelCount === 1)
      && capabilities.channelModes?.length === 1) {
      setOutputChannelMode(capabilities.channelModes[0]);
    } else if (capabilities?.fixedChannelCount === 1) {
      setOutputChannelMode('mono');
    }
  }, [outputEffectiveDevice?.routeKey, outputEffectiveDevice?.capabilities, outputSampleRate, outputBufferSize]);

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
        setSelectedInputRouteKey(settings.inputRouteKey || '');
        setSelectedOutputRouteKey(settings.outputRouteKey || '');
        setInputSampleRate(resolveAudioSettingNumber(settings, 'inputSampleRate', 'sampleRate', DEFAULT_SAMPLE_RATE));
        setOutputSampleRate(resolveAudioSettingNumber(settings, 'outputSampleRate', 'sampleRate', DEFAULT_SAMPLE_RATE));
        setInputBufferSize(resolveAudioSettingNumber(settings, 'inputBufferSize', 'bufferSize', DEFAULT_BUFFER_SIZE));
        setOutputBufferSize(resolveAudioSettingNumber(settings, 'outputBufferSize', 'bufferSize', DEFAULT_BUFFER_SIZE));
        setOutputSampleFormat(resolveOutputSampleFormat(settings));
        setOutputChannelMode(resolveOutputChannelMode(settings));
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

  function resolveSelectedRouteKey(direction: Direction): string {
    const selectedRouteKey = direction === 'input' ? selectedInputRouteKey : selectedOutputRouteKey;
    if (selectedRouteKey) return selectedRouteKey;
    const selectedName = direction === 'input' ? selectedInputDeviceName : selectedOutputDeviceName;
    const devices = direction === 'input' ? inputDevices : outputDevices;
    return resolveUniqueRouteKey(devices, selectedName);
  }

  function resolveSelectedDeviceName(direction: Direction): string {
    const selectedName = direction === 'input' ? selectedInputDeviceName : selectedOutputDeviceName;
    const selectedRouteKey = direction === 'input' ? selectedInputRouteKey : selectedOutputRouteKey;
    const devices = direction === 'input' ? inputDevices : outputDevices;
    return (selectedRouteKey
      ? devices.find((device) => device.routeKey === selectedRouteKey)?.name
      : undefined) ?? selectedName;
  }

  function getEffectiveDevice(direction: Direction): AudioDevice | null {
    const selectedName = direction === 'input' ? selectedInputDeviceName : selectedOutputDeviceName;
    const selectedRouteKey = direction === 'input' ? selectedInputRouteKey : selectedOutputRouteKey;
    const devices = direction === 'input' ? inputDevices : outputDevices;
    const resolution = direction === 'input' ? deviceResolution?.input : deviceResolution?.output;
    const resolutionMatchesSelection = selectedRouteKey
      ? resolution?.configuredRouteKey === selectedRouteKey
      : (resolution?.configuredDeviceName ?? '') === selectedName;
    if (resolutionMatchesSelection && resolution?.status === 'missing') {
      return null;
    }
    return (resolutionMatchesSelection ? resolution?.effectiveDevice : undefined)
      ?? (selectedRouteKey ? devices.find((device) => device.routeKey === selectedRouteKey) : undefined)
      ?? devices.find((device) => device.name === selectedName)
      ?? null;
  }

  const renderDeviceItems = (options: AudioDeviceSelectOption[]) => options.map((option) => (
    <SelectItem
      key={option.key}
      textValue={option.device ? formatDeviceText(t, option.device) : `${option.deviceName} (${t('audio.deviceUnavailableShort')})`}
    >
      <div className="flex flex-col">
        <span className="flex items-center gap-2">
          {option.device ? formatDeviceText(t, option.device) : option.deviceName}
          {option.device && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-default-100 text-default-600 dark:bg-default-800 dark:text-default-300">
              {t(`audio.deviceCategory.${getAudioDeviceCategory(option.device)}`)}
            </span>
          )}
          {option.isMissing && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-warning-100 text-warning-700 dark:bg-warning-900 dark:text-warning-300">
              {t('audio.deviceUnavailableShort')}
            </span>
          )}
          {option.device && getAudioDeviceStatusBadges(option.device).map((badge) => (
            <span key={badge.key} className={getStatusBadgeClassName(badge.tone)}>
              {t(`audio.deviceStatus.${badge.key}`)}
            </span>
          ))}
        </span>
        <span className="text-xs text-default-400">
          {option.device
            ? `${formatChannelText(t, option.device.channels)}, ${formatHertz(option.device.sampleRate)}`
            : t('audio.deviceMissingPreservedShort')}
        </span>
        {option.device?.failureReason && (
          <span className="text-xs text-danger-500">{option.device.failureReason}</span>
        )}
      </div>
    </SelectItem>
  ));

  const renderDirectionSection = (direction: Direction) => {
    const isInput = direction === 'input';
    const selectedName = isInput ? selectedInputDeviceName : selectedOutputDeviceName;
    const setSelectedName = isInput ? setSelectedInputDeviceName : setSelectedOutputDeviceName;
    const selectedRouteKey = isInput ? selectedInputRouteKey : selectedOutputRouteKey;
    const setSelectedRouteKey = isInput ? setSelectedInputRouteKey : setSelectedOutputRouteKey;
    const devices = isInput ? inputDevices : outputDevices;
    const resolution = isInput ? deviceResolution?.input : deviceResolution?.output;
    const effectiveDevice = isInput ? inputEffectiveDevice : outputEffectiveDevice;
    const sampleRate = isInput ? inputSampleRate : outputSampleRate;
    const setSampleRate = isInput ? setInputSampleRate : setOutputSampleRate;
    const bufferSize = isInput ? inputBufferSize : outputBufferSize;
    const setBufferSize = isInput ? setInputBufferSize : setOutputBufferSize;
    const bufferSizes = isInput ? inputBufferSizes : outputBufferSizes;
    const displayOptions = buildAudioDeviceSelectOptions(direction, devices, selectedName, resolution, selectedRouteKey);
    const selectedOption = selectedRouteKey
      ? displayOptions.find((option) => option.routeKey === selectedRouteKey)
      : displayOptions.find((option) => option.deviceName === selectedName);
    const sampleOptions = deriveSampleRateOptions(effectiveDevice, sampleRate);
    const bufferOptions = deriveBufferSizeOptions(effectiveDevice?.capabilities?.bufferSizes ?? bufferSizes, bufferSize);
    const sampleRateConfigurable = effectiveDevice
      ? isAudioDeviceControlConfigurable(effectiveDevice, 'sampleRate')
      : true;
    const bufferSizeConfigurable = effectiveDevice
      ? isAudioDeviceControlConfigurable(effectiveDevice, 'bufferSize')
      : true;
    const sampleFormatConfigurable = effectiveDevice
      ? isAudioDeviceControlConfigurable(effectiveDevice, 'sampleFormat')
      : true;
    const channelModeConfigurable = effectiveDevice
      ? isAudioDeviceControlConfigurable(effectiveDevice, 'channelMode')
      : true;
    const sampleFormatOptions = effectiveDevice?.capabilities?.sampleFormats?.length
      ? effectiveDevice.capabilities.sampleFormats
      : OUTPUT_SAMPLE_FORMAT_OPTIONS;
    const channelModeOptions = effectiveDevice?.capabilities?.channelModes?.length
      ? effectiveDevice.capabilities.channelModes
      : OUTPUT_CHANNEL_MODE_OPTIONS;
    const resolutionMatchesSelection = selectedRouteKey
      ? resolution?.configuredRouteKey === selectedRouteKey
      : (resolution?.configuredDeviceName ?? '') === selectedName;
    const currentResolution = resolutionMatchesSelection ? resolution : null;
    const isVirtual = currentResolution?.status === 'virtual-selected' || isVirtualAudioDevice(effectiveDevice);
    const selectedStatusDevice = currentResolution?.configuredDevice ?? effectiveDevice;
    const resolutionDescription = getResolutionDescription(t, currentResolution);
    const routeFailureReason = currentResolution?.configuredDevice?.failureReason
      ?? effectiveDevice?.failureReason
      ?? (currentResolution?.configuredDevice?.routeState === 'lost'
        || currentResolution?.configuredDevice?.routeState === 'failed'
        || currentResolution?.configuredDevice?.routeState === 'unavailable'
        ? t('audio.deviceRouteLostDescription')
        : null);
    const resolutionTone = getResolutionTone(currentResolution);
    const resolutionClassName = resolutionTone === 'warning'
      ? 'text-warning-600'
      : resolutionTone === 'virtual'
        ? 'text-primary-500'
        : 'text-default-400';

    return (
      <div className="space-y-3 rounded-xl border border-divider bg-content1 p-4">
        <h4 className="text-sm font-semibold text-default-700">
          {isInput ? t('audio.inputSectionTitle') : t('audio.outputSectionTitle')}
        </h4>

        <Select
          label={isInput ? t('audio.inputDevice') : t('audio.outputDevice')}
          placeholder={isInput ? t('audio.inputDevicePlaceholder') : t('audio.outputDevicePlaceholder')}
          selectedKeys={selectedName || selectedRouteKey
            ? [selectedOption?.key ?? getSelectedAudioDeviceKey(direction, selectedName, selectedRouteKey)]
            : []}
          onSelectionChange={(keys) => {
            const selected = Array.from(keys)[0] as string;
            const option = displayOptions.find((item) => item.key === selected);
            setSelectedName(option?.deviceName ?? '');
            setSelectedRouteKey(option?.routeKey ?? '');
          }}
          isDisabled={saving}
          aria-label={isInput ? t('audio.selectInput') : t('audio.selectOutput')}
        >
          {renderDeviceItems(displayOptions) as unknown as React.ReactElement}
        </Select>
        {selectedStatusDevice && (
          <div className="flex flex-wrap items-center gap-1.5" aria-label={t('audio.selectedDeviceStatus')}>
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-default-100 text-default-600 dark:bg-default-800 dark:text-default-300">
              {t(`audio.deviceCategory.${getAudioDeviceCategory(selectedStatusDevice)}`)}
            </span>
            {getAudioDeviceStatusBadges(selectedStatusDevice).map((badge) => (
              <span key={badge.key} className={getStatusBadgeClassName(badge.tone)}>
                {t(`audio.deviceStatus.${badge.key}`)}
              </span>
            ))}
          </div>
        )}
        {resolutionDescription && (
          <p className={`text-xs ${resolutionClassName}`}>
            {resolutionDescription}
          </p>
        )}
        {routeFailureReason && currentResolution?.status !== 'missing' && (
          <p className="text-xs text-danger-500">{routeFailureReason}</p>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="space-y-1">
            {sampleRateConfigurable ? (
              <>
                <Select
                  label={t('audio.sampleRate')}
                  selectedKeys={[sampleRate.toString()]}
                  onSelectionChange={(keys) => {
                    const selected = Array.from(keys)[0] as string;
                    setSampleRate(parseInt(selected, 10));
                  }}
                  isDisabled={saving}
                  aria-label={isInput ? t('audio.selectInputSampleRate') : t('audio.selectOutputSampleRate')}
                >
                  {sampleOptions.values.map((value) => (
                    <SelectItem key={value.toString()} textValue={formatHertz(value)}>
                      {formatHertz(value)}
                    </SelectItem>
                  )) as unknown as React.ReactElement}
                </Select>
                {renderOptionHint(sampleOptions.isFallback, sampleOptions.isCurrentUnsupported, false, 'sampleRate')}
              </>
            ) : renderFixedControl(t('audio.sampleRate'), formatHertz(sampleRate), isVirtual)}
          </div>

          <div className="space-y-1">
            {bufferSizeConfigurable ? (
              <>
                <Select
                  label={t('audio.bufferSize')}
                  selectedKeys={[bufferSize.toString()]}
                  onSelectionChange={(keys) => {
                    const selected = Array.from(keys)[0] as string;
                    setBufferSize(parseInt(selected, 10));
                  }}
                  isDisabled={saving}
                  aria-label={isInput ? t('audio.selectInputBufferSize') : t('audio.selectOutputBufferSize')}
                >
                  {bufferOptions.values.map((value) => (
                    <SelectItem key={value.toString()} textValue={formatNumber(value)}>
                      {formatNumber(value)}
                    </SelectItem>
                  )) as unknown as React.ReactElement}
                </Select>
                {renderOptionHint(bufferOptions.isFallback, bufferOptions.isCurrentUnsupported, false, 'bufferSize')}
              </>
            ) : renderFixedControl(t('audio.bufferSize'), formatNumber(bufferSize), isVirtual)}
          </div>
        </div>

        {!isInput && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1">
              {sampleFormatConfigurable ? (
                <>
                  <Select
                    label={t('audio.outputSampleFormat')}
                    selectedKeys={[outputSampleFormat]}
                    onSelectionChange={(keys) => {
                      const selected = Array.from(keys)[0] as AudioOutputSampleFormat | undefined;
                      setOutputSampleFormat(resolveOutputSampleFormat({ outputSampleFormat: selected }));
                    }}
                    isDisabled={saving}
                    aria-label={t('audio.selectOutputSampleFormat')}
                  >
                    {sampleFormatOptions.map((value) => (
                      <SelectItem key={value} textValue={t(`audio.outputSampleFormatOptions.${value}`)}>
                        {t(`audio.outputSampleFormatOptions.${value}`)}
                      </SelectItem>
                    )) as unknown as React.ReactElement}
                  </Select>
                  <p className="text-xs text-default-400">{t('audio.outputSampleFormatHint')}</p>
                </>
              ) : renderFixedControl(
                t('audio.outputSampleFormat'),
                t(`audio.outputSampleFormatOptions.${outputSampleFormat}`),
                isVirtual,
              )}
            </div>

            <div className="space-y-1">
              {channelModeConfigurable ? (
                <>
                  <Select
                    label={t('audio.outputChannelMode')}
                    selectedKeys={[outputChannelMode]}
                    onSelectionChange={(keys) => {
                      const selected = Array.from(keys)[0] as AudioOutputChannelMode | undefined;
                      setOutputChannelMode(resolveOutputChannelMode({ outputChannelMode: selected }));
                    }}
                    isDisabled={saving}
                    aria-label={t('audio.selectOutputChannelMode')}
                  >
                    {channelModeOptions.map((value) => (
                      <SelectItem key={value} textValue={t(`audio.outputChannelModeOptions.${value}`)}>
                        {t(`audio.outputChannelModeOptions.${value}`)}
                      </SelectItem>
                    )) as unknown as React.ReactElement}
                  </Select>
                  <p className="text-xs text-default-400">{t('audio.outputChannelModeHint')}</p>
                </>
              ) : renderFixedControl(
                t('audio.outputChannelMode'),
                t(`audio.outputChannelModeOptions.${outputChannelMode}`),
                isVirtual,
              )}
            </div>
          </div>
        )}
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

  function renderFixedControl(label: string, value: string, isVirtual: boolean) {
    return (
      <div className="rounded-xl border border-divider bg-default-50 px-3 py-2.5">
        <div className="text-xs text-default-500">{label}</div>
        <div className="mt-0.5 text-sm font-medium text-default-700">{value}</div>
        <div className="mt-1 text-xs text-default-400">
          {isVirtual ? t('audio.virtualAudioFixed') : t('audio.deviceManagedFixed')}
        </div>
      </div>
    );
  }

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

export function audioSettingsEqual(
  a: AudioDeviceSettingsType,
  b: AudioDeviceSettingsType | undefined,
): boolean {
  return (a.inputDeviceName || '') === (b?.inputDeviceName || '')
    && (a.outputDeviceName || '') === (b?.outputDeviceName || '')
    && (a.inputRouteKey || '') === (b?.inputRouteKey || '')
    && (a.outputRouteKey || '') === (b?.outputRouteKey || '')
    && a.inputSampleRate === resolveAudioSettingNumber(b, 'inputSampleRate', 'sampleRate', DEFAULT_SAMPLE_RATE)
    && a.outputSampleRate === resolveAudioSettingNumber(b, 'outputSampleRate', 'sampleRate', DEFAULT_SAMPLE_RATE)
    && a.inputBufferSize === resolveAudioSettingNumber(b, 'inputBufferSize', 'bufferSize', DEFAULT_BUFFER_SIZE)
    && a.outputBufferSize === resolveAudioSettingNumber(b, 'outputBufferSize', 'bufferSize', DEFAULT_BUFFER_SIZE)
    && resolveOutputSampleFormat(a) === resolveOutputSampleFormat(b)
    && resolveOutputChannelMode(a) === resolveOutputChannelMode(b);
}

function getStatusBadgeClassName(tone: 'default' | 'primary' | 'success' | 'warning' | 'danger'): string {
  const colorClass = {
    default: 'bg-default-100 text-default-600 dark:bg-default-800 dark:text-default-300',
    primary: 'bg-primary-100 text-primary-700 dark:bg-primary-900 dark:text-primary-300',
    success: 'bg-success-100 text-success-700 dark:bg-success-900 dark:text-success-300',
    warning: 'bg-warning-100 text-warning-700 dark:bg-warning-900 dark:text-warning-300',
    danger: 'bg-danger-100 text-danger-700 dark:bg-danger-900 dark:text-danger-300',
  }[tone];
  return `inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${colorClass}`;
}

export function resolveOutputSampleFormat(settings: AudioDeviceSettingsType | undefined): AudioOutputSampleFormat {
  return settings?.outputSampleFormat === 'int16' ? 'int16' : DEFAULT_OUTPUT_SAMPLE_FORMAT;
}

export function resolveOutputChannelMode(settings: AudioDeviceSettingsType | undefined): AudioOutputChannelMode {
  const value = settings?.outputChannelMode;
  return value === 'left' || value === 'right' || value === 'both'
    ? value
    : DEFAULT_OUTPUT_CHANNEL_MODE;
}

function formatHertz(value: number): string {
  return `${formatNumber(value)} Hz`;
}

function formatNumber(value: number): string {
  return value.toLocaleString('en-US');
}
