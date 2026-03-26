/* eslint-disable @typescript-eslint/no-explicit-any */
// AudioDeviceManager - 设备枚举

import { AudioDevice } from '@tx5dr/contracts';
import audify from 'audify';
const { RtAudio } = audify;
type RtAudioInstance = InstanceType<typeof RtAudio>;

// RtAudioApi values from audify (const enum not importable under isolatedModules)
const RTAUDIO_API_UNSPECIFIED = 0;
const RTAUDIO_API_WINDOWS_WASAPI = 7;
import { ConfigManager } from '../config/config-manager.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('AudioDeviceManager');

// 音频设备管理器
export class AudioDeviceManager {
  private static instance: AudioDeviceManager;
  private icomWlanConnectedCallback: (() => boolean) | null = null;
  private rtAudio: RtAudioInstance;

  private constructor() {
    // On Windows, explicitly use WASAPI to avoid ASIO exclusive-access conflicts.
    // ASIO only exposes ASIO devices (e.g. "Realtek ASIO"), hiding all WASAPI devices.
    // WASAPI sees all system audio devices and supports shared-mode access.
    const api = process.platform === 'win32' ? RTAUDIO_API_WINDOWS_WASAPI : RTAUDIO_API_UNSPECIFIED;
    this.rtAudio = new RtAudio(api);
    logger.info('Audify (RtAudio) audio system initialized', { api: process.platform === 'win32' ? 'WASAPI' : 'auto' });
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

  /**
   * 将 Audify 设备信息转换为 AudioDevice 格式
   */
  private convertAudifyDevice(device: any, type: 'input' | 'output', isSystemDefault: boolean = false): AudioDevice {
    const channels = type === 'input' ? device.inputChannels : device.outputChannels;
    const finalChannels = channels && channels > 0 ? channels : 0;

    logger.debug(`Converting device ${device.name} (${type}): rawChannels=${channels}, finalChannels=${finalChannels}`);

    return {
      id: `${type}-${device.id}`,
      name: device.name || `${type === 'input' ? 'input' : 'output'} device ${device.id}`,
      isDefault: isSystemDefault,
      channels: finalChannels,
      sampleRate: device.preferredSampleRate || 48000,
      type: type,
    };
  }

  /**
   * 获取所有音频输入设备
   */
  async getInputDevices(): Promise<AudioDevice[]> {
    try {
      logger.debug('Enumerating audio input devices');
      const devices = this.rtAudio.getDevices();
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
          type: 'input',
        });
      }

      // ICOM WLAN 虚拟设备注入
      if (this.shouldShowIcomWlanDevice()) {
        logger.debug('Injecting ICOM WLAN virtual input device');
        const icomWlanInputDevice: AudioDevice = {
          id: 'icom-wlan-input',
          name: 'ICOM WLAN',
          isDefault: false,
          channels: 1,
          sampleRate: 12000,
          type: 'input'
        };
        result.unshift(icomWlanInputDevice);
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
      const devices = this.rtAudio.getDevices();
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
          type: 'output',
        });
      }

      // ICOM WLAN 虚拟设备注入
      if (this.shouldShowIcomWlanDevice()) {
        logger.debug('Injecting ICOM WLAN virtual output device');
        const icomWlanOutputDevice: AudioDevice = {
          id: 'icom-wlan-output',
          name: 'ICOM WLAN',
          isDefault: false,
          channels: 1,
          sampleRate: 12000,
          type: 'output'
        };
        result.unshift(icomWlanOutputDevice);
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
   * 根据设备名称解析为设备ID，如果找不到则使用默认设备
   */
  async resolveInputDeviceId(deviceName?: string): Promise<string | undefined> {
    if (!deviceName) {
      const defaultDevice = await this.getDefaultInputDevice();
      logger.debug(`Using default input device: ${defaultDevice?.name || 'none'}`);
      return defaultDevice?.id;
    }

    const device = await this.getInputDeviceByName(deviceName);
    if (device) {
      logger.debug(`Found configured input device: ${device.name} -> ${device.id}`);
      return device.id;
    }

    logger.warn(`Input device "${deviceName}" not found, falling back to default`);
    const defaultDevice = await this.getDefaultInputDevice();
    logger.debug(`Fallback to default input device: ${defaultDevice?.name || 'none'}`);
    return defaultDevice?.id;
  }

  /**
   * 根据设备名称解析为设备ID，如果找不到则使用默认设备
   */
  async resolveOutputDeviceId(deviceName?: string): Promise<string | undefined> {
    if (!deviceName) {
      const defaultDevice = await this.getDefaultOutputDevice();
      logger.debug(`Using default output device: ${defaultDevice?.name || 'none'}`);
      return defaultDevice?.id;
    }

    const device = await this.getOutputDeviceByName(deviceName);
    if (device) {
      logger.debug(`Found configured output device: ${device.name} -> ${device.id}`);
      return device.id;
    }

    logger.warn(`Output device "${deviceName}" not found, falling back to default`);
    const defaultDevice = await this.getDefaultOutputDevice();
    logger.debug(`Fallback to default output device: ${defaultDevice?.name || 'none'}`);
    return defaultDevice?.id;
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
