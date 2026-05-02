/* eslint-disable @typescript-eslint/no-explicit-any */
// AudioDeviceManager - 设备枚举

import { AudioDevice, type AudioDeviceResolution, type AudioDeviceResolutionSet, type AudioDeviceSettings } from '@tx5dr/contracts';
import audify from 'audify';
const { RtAudio } = audify;
type RtAudioInstance = InstanceType<typeof RtAudio>;

// RtAudioApi values from audify (const enum not importable under isolatedModules)
const RTAUDIO_API_UNSPECIFIED = 0;
const RTAUDIO_API_WINDOWS_WASAPI = 7;
import { ConfigManager } from '../config/config-manager.js';
import { createLogger } from '../utils/logger.js';
import { RadioError, RadioErrorCode, RadioErrorSeverity } from '../utils/errors/RadioError.js';

const logger = createLogger('AudioDeviceManager');
type RadioType = 'none' | 'network' | 'serial' | 'icom-wlan';
const RTAUDIO_BUFFER_SIZE_OPTIONS = [128, 256, 512, 768, 1024, 2048, 4096];
const FALLBACK_SAMPLE_RATES = [8000, 12000, 16000, 22050, 24000, 44100, 48000, 96000];

// 音频设备管理器
export class AudioDeviceManager {
  private static instance: AudioDeviceManager;
  private icomWlanConnectedCallback: (() => boolean) | null = null;
  private readonly rtAudioApi: number;

  private constructor() {
    // On Windows, explicitly use WASAPI to avoid ASIO exclusive-access conflicts.
    // ASIO only exposes ASIO devices (e.g. "Realtek ASIO"), hiding all WASAPI devices.
    // WASAPI sees all system audio devices and supports shared-mode access.
    this.rtAudioApi = process.platform === 'win32' ? RTAUDIO_API_WINDOWS_WASAPI : RTAUDIO_API_UNSPECIFIED;
    logger.info('Audify (RtAudio) audio enumeration initialized', { api: process.platform === 'win32' ? 'WASAPI' : 'auto' });
  }

  static getInstance(): AudioDeviceManager {
    if (!AudioDeviceManager.instance) {
      AudioDeviceManager.instance = new AudioDeviceManager();
    }
    return AudioDeviceManager.instance;
  }

  /**
   * 设置 ICOM WLAN 连接状态检查回调
   */
  setIcomWlanConnectedCallback(callback: () => boolean): void {
    this.icomWlanConnectedCallback = callback;
  }

  /**
   * 检查是否应该显示 ICOM WLAN 虚拟设备
   */
  /**
   * Get OpenWebRX stations as virtual input devices
   */
  private getOpenWebRXVirtualDevices(): AudioDevice[] {
    try {
      const configManager = ConfigManager.getInstance();
      const stations = configManager.getOpenWebRXStations();
      return stations.map(station => ({
        id: `openwebrx-${station.id}`,
        name: `[SDR] ${station.name}`,
        isDefault: false,
        channels: 1,
        sampleRate: 12000,
        sampleRates: [12000],
        type: 'input' as const,
      }));
    } catch {
      return [];
    }
  }

  private shouldShowIcomWlanDevice(): boolean {
    const configManager = ConfigManager.getInstance();
    const radioConfig = configManager.getRadioConfig();

    if (radioConfig.type !== 'icom-wlan') {
      return false;
    }

    if (this.icomWlanConnectedCallback) {
      return this.icomWlanConnectedCallback();
    }

    return true;
  }

  private createIcomWlanDevice(type: 'input' | 'output'): AudioDevice {
    return {
      id: `icom-wlan-${type}`,
      name: 'ICOM WLAN',
      isDefault: false,
      channels: 1,
      sampleRate: 12000,
      sampleRates: [12000],
      type,
    };
  }

  private normalizeSampleRates(sampleRates: unknown): number[] {
    if (!Array.isArray(sampleRates)) {
      return [];
    }

    return Array.from(new Set(sampleRates
      .map((rate) => Math.round(Number(rate)))
      .filter((rate) => Number.isFinite(rate) && rate > 0))).sort((a, b) => a - b);
  }

  /**
   * 将 Audify 设备信息转换为 AudioDevice 格式
   */
  private convertAudifyDevice(device: any, type: 'input' | 'output', isSystemDefault: boolean = false): AudioDevice {
    const channels = type === 'input' ? device.inputChannels : device.outputChannels;
    const finalChannels = channels && channels > 0 ? channels : 0;

    logger.debug(`Converting device ${device.name} (${type}): rawChannels=${channels}, finalChannels=${finalChannels}`);

    const sampleRates = this.normalizeSampleRates(device.sampleRates);

    return {
      id: `${type}-${device.id}`,
      name: device.name || `${type === 'input' ? 'input' : 'output'} device ${device.id}`,
      isDefault: isSystemDefault,
      channels: finalChannels,
      sampleRate: device.preferredSampleRate || 48000,
      ...(sampleRates.length > 0 ? { sampleRates } : {}),
      type: type,
    };
  }

  private createRtAudioInstance(): RtAudioInstance {
    return new RtAudio(this.rtAudioApi);
  }

  private getRtAudioDevices(): any[] {
    const rtAudio = this.createRtAudioInstance();
    return rtAudio.getDevices();
  }

  /**
   * 获取所有音频输入设备
   */
  async getInputDevices(): Promise<AudioDevice[]> {
    try {
      logger.debug('Enumerating audio input devices');
      const devices = this.getRtAudioDevices();
      logger.debug(`Audify returned ${devices.length} devices`);

      devices.forEach((device: any, index: number) => {
        logger.debug(`Device ${index}: id=${device.id}, name=${device.name}, inputCh=${device.inputChannels}, outputCh=${device.outputChannels}, sampleRate=${device.preferredSampleRate}`);
      });

      // 过滤输入设备
      const inputDevices = devices.filter((device: any, index: number) => {
        const hasInputChannels = device.inputChannels && device.inputChannels > 0;
        logger.debug(`Device ${index} (${device.name}) input filter: ${hasInputChannels}`);
        return hasInputChannels;
      });

      logger.debug(`Found ${inputDevices.length} input devices after filter`);

      const result = inputDevices.map((device: any) => {
        const isSystemDefault = Boolean(device.isDefaultInput);
        logger.debug(`Converting input device: ${device.name} (default: ${isSystemDefault})`);
        return this.convertAudifyDevice(device, 'input', isSystemDefault);
      });

      if (result.length === 0) {
        logger.debug('No input devices found, adding generic default input device');
        result.push({
          id: 'input-default',
          name: 'Default audio input device',
          isDefault: true,
          channels: 1,
          sampleRate: 48000,
          sampleRates: FALLBACK_SAMPLE_RATES,
          type: 'input',
        });
      }

      // ICOM WLAN 虚拟设备注入
      if (this.shouldShowIcomWlanDevice()) {
        logger.debug('Injecting ICOM WLAN virtual input device');
        result.unshift(this.createIcomWlanDevice('input'));
      }

      // OpenWebRX SDR 虚拟设备注入
      const openwebrxDevices = this.getOpenWebRXVirtualDevices();
      if (openwebrxDevices.length > 0) {
        logger.debug(`Injecting ${openwebrxDevices.length} OpenWebRX virtual input device(s)`);
        result.push(...openwebrxDevices);
      }

      logger.debug(`Returning ${result.length} input devices: ${result.map((d: AudioDevice) => d.name).join(', ')}`);
      return result;
    } catch (error) {
      logger.error('Failed to get input devices', error);

      return [
        {
          id: 'input-fallback',
          name: 'Default input device (fallback)',
          isDefault: true,
          channels: 1,
          sampleRate: 48000,
          sampleRates: FALLBACK_SAMPLE_RATES,
          type: 'input',
        },
      ];
    }
  }

  /**
   * 获取所有音频输出设备
   */
  async getOutputDevices(): Promise<AudioDevice[]> {
    try {
      logger.debug('Enumerating audio output devices');
      const devices = this.getRtAudioDevices();
      logger.debug(`Audify returned ${devices.length} devices`);

      const outputDevices = devices.filter((device: any, index: number) => {
        const hasOutputChannels = device.outputChannels && device.outputChannels > 0;
        logger.debug(`Device ${index} (${device.name}) output filter: ${hasOutputChannels}`);
        return hasOutputChannels;
      });

      logger.debug(`Found ${outputDevices.length} output devices after filter`);

      const result = outputDevices.map((device: any) => {
        const isSystemDefault = Boolean(device.isDefaultOutput);
        logger.debug(`Converting output device: ${device.name} (default: ${isSystemDefault})`);
        return this.convertAudifyDevice(device, 'output', isSystemDefault);
      });

      if (result.length === 0) {
        logger.debug('No output devices found, adding generic default output device');
        result.push({
          id: 'output-default',
          name: 'Default audio output device',
          isDefault: true,
          channels: 2,
          sampleRate: 48000,
          sampleRates: FALLBACK_SAMPLE_RATES,
          type: 'output',
        });
      }

      // ICOM WLAN 虚拟设备注入
      if (this.shouldShowIcomWlanDevice()) {
        logger.debug('Injecting ICOM WLAN virtual output device');
        result.unshift(this.createIcomWlanDevice('output'));
      }

      logger.debug(`Returning ${result.length} output devices: ${result.map((d: AudioDevice) => d.name).join(', ')}`);
      return result;
    } catch (error) {
      logger.error('Failed to get output devices', error);

      return [
        {
          id: 'output-fallback',
          name: 'Default output device (fallback)',
          isDefault: true,
          channels: 2,
          sampleRate: 48000,
          sampleRates: FALLBACK_SAMPLE_RATES,
          type: 'output',
        },
      ];
    }
  }

  /**
   * 获取所有音频设备
   */
  async getAllDevices() {
    logger.debug('Getting all audio devices');
    const [inputDevices, outputDevices] = await Promise.all([
      this.getInputDevices(),
      this.getOutputDevices(),
    ]);

    logger.debug(`Device summary: ${inputDevices.length} input, ${outputDevices.length} output`);

    return {
      inputDevices,
      outputDevices,
      inputBufferSizes: RTAUDIO_BUFFER_SIZE_OPTIONS,
      outputBufferSizes: RTAUDIO_BUFFER_SIZE_OPTIONS,
    };
  }

  async resolveAudioSettings(
    settings: AudioDeviceSettings,
    radioType?: RadioType,
  ): Promise<AudioDeviceResolutionSet> {
    const devices = await this.getAllDevices();
    const effectiveRadioType = radioType ?? ConfigManager.getInstance().getRadioConfig().type;

    return {
      input: this.resolveDeviceDirection({
        configuredDeviceName: settings.inputDeviceName ?? null,
        devices: devices.inputDevices,
        direction: 'input',
        radioType: effectiveRadioType,
      }),
      output: this.resolveDeviceDirection({
        configuredDeviceName: settings.outputDeviceName ?? null,
        devices: devices.outputDevices,
        direction: 'output',
        radioType: effectiveRadioType,
      }),
    };
  }

  private resolveDeviceDirection(params: {
    configuredDeviceName: string | null;
    devices: AudioDevice[];
    direction: 'input' | 'output';
    radioType: RadioType;
  }): AudioDeviceResolution {
    const { configuredDeviceName, devices, direction, radioType } = params;
    const defaultDevice = devices.find((device) => device.isDefault) ?? devices[0] ?? null;

    if (!configuredDeviceName) {
      return {
        configuredDeviceName: null,
        configuredDevice: null,
        effectiveDevice: defaultDevice,
        status: 'default',
        reason: defaultDevice ? null : 'no-default-device',
      };
    }

    const configuredDevice = devices.find((device) => device.name === configuredDeviceName) ?? null;
    if (configuredDevice) {
      return {
        configuredDeviceName,
        configuredDevice,
        effectiveDevice: configuredDevice,
        status: configuredDevice.id.startsWith('openwebrx-') || configuredDevice.id.startsWith('icom-wlan-')
          ? 'virtual-selected'
          : 'selected',
        reason: null,
      };
    }

    if (configuredDeviceName === 'ICOM WLAN' && radioType === 'icom-wlan') {
      const virtualDevice = this.createIcomWlanDevice(direction);
      return {
        configuredDeviceName,
        configuredDevice: virtualDevice,
        effectiveDevice: virtualDevice,
        status: 'virtual-selected',
        reason: 'icom-wlan-radio-audio',
      };
    }

    if (configuredDeviceName.startsWith('[SDR]')) {
      return {
        configuredDeviceName,
        configuredDevice: null,
        effectiveDevice: null,
        status: 'missing',
        reason: direction === 'input' ? 'openwebrx-station-missing' : 'openwebrx-output-unsupported',
      };
    }

    return {
      configuredDeviceName,
      configuredDevice: null,
      effectiveDevice: null,
      status: 'missing',
      reason: 'configured-device-missing',
    };
  }

  /**
   * 根据ID获取设备信息
   */
  async getDeviceById(deviceId: string): Promise<AudioDevice | null> {
    const allDevices = await this.getAllDevices();
    const allDevicesList = [...allDevices.inputDevices, ...allDevices.outputDevices];

    return allDevicesList.find(device => device.id === deviceId) || null;
  }

  /**
   * 根据设备名称查找输入设备
   */
  async getInputDeviceByName(deviceName: string): Promise<AudioDevice | null> {
    try {
      const inputDevices = await this.getInputDevices();
      return inputDevices.find(device => device.name === deviceName) || null;
    } catch (error) {
      logger.error('Failed to find input device by name', error);
      return null;
    }
  }

  /**
   * 根据设备名称查找输出设备
   */
  async getOutputDeviceByName(deviceName: string): Promise<AudioDevice | null> {
    try {
      const outputDevices = await this.getOutputDevices();
      return outputDevices.find(device => device.name === deviceName) || null;
    } catch (error) {
      logger.error('Failed to find output device by name', error);
      return null;
    }
  }

  /**
   * 获取默认输入设备
   */
  async getDefaultInputDevice(): Promise<AudioDevice | null> {
    try {
      const inputDevices = await this.getInputDevices();
      const defaultDevice = inputDevices.find(device => device.isDefault);
      return defaultDevice || inputDevices[0] || null;
    } catch (error) {
      logger.error('Failed to get default input device', error);
      return null;
    }
  }

  /**
   * 获取默认输出设备
   */
  async getDefaultOutputDevice(): Promise<AudioDevice | null> {
    try {
      const outputDevices = await this.getOutputDevices();
      const defaultDevice = outputDevices.find(device => device.isDefault);
      return defaultDevice || outputDevices[0] || null;
    } catch (error) {
      logger.error('Failed to get default output device', error);
      return null;
    }
  }

  /**
   * 根据设备名称解析为输入设备ID；空设备名使用默认设备，已配置设备缺失时交给 sidecar 重试。
   */
  async resolveInputDeviceId(deviceName?: string): Promise<string | undefined> {
    if (!deviceName) {
      const defaultDevice = await this.getDefaultInputDevice();
      logger.debug(`Using default input device: ${defaultDevice?.name || 'none'}`);
      return defaultDevice?.id;
    }

    if (deviceName === 'ICOM WLAN') {
      return 'icom-wlan-input';
    }

    const device = await this.getInputDeviceByName(deviceName);
    if (device) {
      logger.debug(`Found configured input device: ${device.name} -> ${device.id}`);
      return device.id;
    }

    logger.warn(`Input device "${deviceName}" not found, waiting for automatic retry`);
    throw this.createMissingConfiguredDeviceError('input', deviceName);
  }

  /**
   * 根据设备名称解析为输出设备ID；空设备名使用默认设备，已配置设备缺失时交给 sidecar 重试。
   */
  async resolveOutputDeviceId(deviceName?: string): Promise<string | undefined> {
    if (!deviceName) {
      const defaultDevice = await this.getDefaultOutputDevice();
      logger.debug(`Using default output device: ${defaultDevice?.name || 'none'}`);
      return defaultDevice?.id;
    }

    if (deviceName === 'ICOM WLAN') {
      return 'icom-wlan-output';
    }

    const device = await this.getOutputDeviceByName(deviceName);
    if (device) {
      logger.debug(`Found configured output device: ${device.name} -> ${device.id}`);
      return device.id;
    }

    logger.warn(`Output device "${deviceName}" not found, waiting for automatic retry`);
    throw this.createMissingConfiguredDeviceError('output', deviceName);
  }

  private createMissingConfiguredDeviceError(direction: 'input' | 'output', deviceName: string): RadioError {
    return new RadioError({
      code: RadioErrorCode.DEVICE_NOT_FOUND,
      message: `Configured audio ${direction} device "${deviceName}" is temporarily unavailable`,
      userMessage: `Configured audio ${direction} device "${deviceName}" is temporarily unavailable. The system will keep retrying automatically.`,
      userMessageKey: direction === 'input'
        ? 'radio:audioSidecar.errorInputDeviceUnavailable'
        : 'radio:audioSidecar.errorOutputDeviceUnavailable',
      userMessageParams: { deviceName },
      severity: RadioErrorSeverity.ERROR,
      suggestions: [
        'Reconnect the audio device and wait for the operating system to finish enumerating it',
        'Check the audio device list to confirm the configured device name appears again',
        'Keep the current profile selected so automatic retry can recover the audio connection',
      ],
      context: {
        deviceName,
        direction,
        temporaryUnavailable: true,
        recoverable: true,
      },
    });
  }

  /**
   * 验证设备是否存在
   */
  async validateDevice(deviceId: string): Promise<boolean> {
    try {
      const device = await this.getDeviceById(deviceId);
      const exists = device !== null;
      logger.debug(`Validate device ${deviceId}: ${exists ? 'found' : 'not found'}`);
      return exists;
    } catch (error) {
      logger.error(`Failed to validate device ${deviceId}`, error);
      return false;
    }
  }
}
