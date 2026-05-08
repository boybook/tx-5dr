/* eslint-disable @typescript-eslint/no-explicit-any */
// AudioDeviceManager - 设备枚举

import { AudioDevice, type AudioDeviceResolution, type AudioDeviceResolutionSet, type AudioDeviceSettings } from '@tx5dr/contracts';
import { createRtAudioInstance, describeConfiguredRtAudioBackend, type RtAudioInstance } from './rtaudio-api.js';
import { ConfigManager } from '../config/config-manager.js';
import { createLogger } from '../utils/logger.js';
import { RadioError, RadioErrorCode, RadioErrorSeverity } from '../utils/errors/RadioError.js';

const logger = createLogger('AudioDeviceManager');
type RadioType = 'none' | 'network' | 'serial' | 'icom-wlan';
type AudioDirection = 'input' | 'output';
type AudioDeviceAvailability = 'available' | 'cached' | 'active';

type RegisteredAudioDevice = AudioDevice & {
  availability: AudioDeviceAvailability;
  isActiveByTx5dr: boolean;
  lastSeenAt?: number;
  lastRtAudioId?: string;
};

type StreamDeviceResolution = {
  actualDeviceId: number;
  persistedDeviceId: string;
  deviceName: string;
};

const RTAUDIO_BUFFER_SIZE_OPTIONS = [128, 256, 512, 768, 1024, 2048, 4096];
const FALLBACK_SAMPLE_RATES = [8000, 12000, 16000, 22050, 24000, 44100, 48000, 96000];

// 音频设备管理器
export class AudioDeviceManager {
  private static instance: AudioDeviceManager;
  private icomWlanConnectedCallback: (() => boolean) | null = null;
  private readonly deviceRegistry: Record<AudioDirection, Map<string, RegisteredAudioDevice>> = {
    input: new Map(),
    output: new Map(),
  };
  private registryInitialized = false;
  private refreshInFlight: Promise<void> | null = null;

  private constructor() {
    logger.info('Audify (RtAudio) audio enumeration initialized', {
      api: describeConfiguredRtAudioBackend(),
    });
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

  async initializeDeviceRegistry(): Promise<void> {
    if (this.registryInitialized) {
      return;
    }

    await this.refreshDeviceRegistry();
    this.registryInitialized = true;
  }

  private getDeviceKey(direction: AudioDirection, name: string): string {
    return `${direction}:${name.trim().toLocaleLowerCase()}`;
  }

  private toPublicDevice(device: RegisteredAudioDevice): AudioDevice {
    const {
      lastRtAudioId: _lastRtAudioId,
      ...publicDevice
    } = device;
    return { ...publicDevice };
  }

  private parseNumericDeviceId(deviceId: string | undefined): number | null {
    if (!deviceId) return null;
    const normalized = deviceId.replace(/^(input|output)-/, '');
    const parsed = Number.parseInt(normalized, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private fallbackDevice(direction: AudioDirection): AudioDevice {
    return {
      id: `${direction}-fallback`,
      name: direction === 'input' ? 'Default input device (fallback)' : 'Default output device (fallback)',
      isDefault: true,
      channels: direction === 'input' ? 1 : 2,
      sampleRate: 48000,
      sampleRates: FALLBACK_SAMPLE_RATES,
      type: direction,
      availability: 'available',
      isActiveByTx5dr: false,
      lastSeenAt: Date.now(),
    };
  }

  private createRegisteredSnapshot(direction: AudioDirection): AudioDevice[] {
    const devices = Array.from(this.deviceRegistry[direction].values()).map((device) => this.toPublicDevice(device));
    if (devices.length === 0) {
      devices.push(this.fallbackDevice(direction));
    }

    if (direction === 'input') {
      if (this.shouldShowIcomWlanDevice()) {
        devices.unshift(this.createIcomWlanDevice('input'));
      }

      const openwebrxDevices = this.getOpenWebRXVirtualDevices();
      if (openwebrxDevices.length > 0) {
        devices.push(...openwebrxDevices);
      }
    } else if (this.shouldShowIcomWlanDevice()) {
      devices.unshift(this.createIcomWlanDevice('output'));
    }

    return devices;
  }

  private mergeLiveDevices(inputDevices: AudioDevice[], outputDevices: AudioDevice[], observedAt: number): void {
    const liveDevices: Record<AudioDirection, AudioDevice[]> = {
      input: inputDevices,
      output: outputDevices,
    };

    for (const direction of ['input', 'output'] as const) {
      for (const registered of this.deviceRegistry[direction].values()) {
        if (!registered.isActiveByTx5dr) {
          registered.availability = 'cached';
          registered.isActiveByTx5dr = false;
        }
      }

      for (const liveDevice of liveDevices[direction]) {
        const key = this.getDeviceKey(direction, liveDevice.name);
        const existing = this.deviceRegistry[direction].get(key);
        const isActive = existing?.isActiveByTx5dr === true;
        this.deviceRegistry[direction].set(key, {
          ...existing,
          ...liveDevice,
          availability: isActive ? 'active' : 'available',
          isActiveByTx5dr: isActive,
          lastSeenAt: observedAt,
          lastRtAudioId: liveDevice.id,
        });
      }
    }
  }

  private enumeratePhysicalDevicesFromRaw(rawDevices: any[]): {
    inputDevices: AudioDevice[];
    outputDevices: AudioDevice[];
  } {
    const inputDevices = rawDevices
      .filter((device: any) => device.inputChannels && device.inputChannels > 0)
      .map((device: any) => this.convertAudifyDevice(device, 'input', Boolean(device.isDefaultInput)));
    const outputDevices = rawDevices
      .filter((device: any) => device.outputChannels && device.outputChannels > 0)
      .map((device: any) => this.convertAudifyDevice(device, 'output', Boolean(device.isDefaultOutput)));

    return { inputDevices, outputDevices };
  }

  private async refreshDeviceRegistry(): Promise<void> {
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }

    this.refreshInFlight = Promise.resolve().then(() => {
      const observedAt = Date.now();
      logger.debug('Refreshing audio device registry');
      const rawDevices = this.getRtAudioDevices();
      logger.debug(`Audify returned ${rawDevices.length} devices`);
      rawDevices.forEach((device: any, index: number) => {
        logger.debug(`Device ${index}: id=${device.id}, name=${device.name}, inputCh=${device.inputChannels}, outputCh=${device.outputChannels}, sampleRate=${device.preferredSampleRate}`);
      });

      const { inputDevices, outputDevices } = this.enumeratePhysicalDevicesFromRaw(rawDevices);
      this.mergeLiveDevices(inputDevices, outputDevices, observedAt);
      logger.debug('Audio device registry refreshed', {
        inputDevices: this.deviceRegistry.input.size,
        outputDevices: this.deviceRegistry.output.size,
      });
    }).catch((error) => {
      logger.error('Failed to refresh audio device registry', error);
    }).finally(() => {
      this.refreshInFlight = null;
    });

    return this.refreshInFlight;
  }

  private async observeRtAudioInstance(rtAudio: RtAudioInstance): Promise<{
    inputDevices: AudioDevice[];
    outputDevices: AudioDevice[];
  }> {
    const observedAt = Date.now();
    const rawDevices = rtAudio.getDevices();
    const liveDevices = this.enumeratePhysicalDevicesFromRaw(rawDevices);
    this.mergeLiveDevices(liveDevices.inputDevices, liveDevices.outputDevices, observedAt);
    this.registryInitialized = true;
    return liveDevices;
  }

  private findRegisteredDeviceByName(direction: AudioDirection, deviceName: string): RegisteredAudioDevice | null {
    return this.deviceRegistry[direction].get(this.getDeviceKey(direction, deviceName)) ?? null;
  }

  private findDefaultDevice(devices: AudioDevice[]): AudioDevice | null {
    return devices.find((device) => device.isDefault && device.availability !== 'cached')
      ?? devices.find((device) => device.availability !== 'cached')
      ?? null;
  }

  private createUnavailableConfiguredDeviceError(direction: AudioDirection, deviceName: string, availability?: AudioDeviceAvailability): RadioError {
    return this.createMissingConfiguredDeviceError(direction, deviceName, availability);
  }

  async resolveInputDeviceForStream(
    deviceName: string | undefined,
    rtAudio: RtAudioInstance,
    requestedDeviceId?: string,
  ): Promise<StreamDeviceResolution> {
    return this.resolveDeviceForStream('input', deviceName, rtAudio, requestedDeviceId);
  }

  async resolveOutputDeviceForStream(
    deviceName: string | undefined,
    rtAudio: RtAudioInstance,
    requestedDeviceId?: string,
  ): Promise<StreamDeviceResolution> {
    return this.resolveDeviceForStream('output', deviceName, rtAudio, requestedDeviceId);
  }

  private async resolveDeviceForStream(
    direction: AudioDirection,
    deviceName: string | undefined,
    rtAudio: RtAudioInstance,
    requestedDeviceId?: string,
  ): Promise<StreamDeviceResolution> {
    const liveDevices = await this.observeRtAudioInstance(rtAudio);
    const directionalLiveDevices = direction === 'input' ? liveDevices.inputDevices : liveDevices.outputDevices;
    const requestedNumericId = this.parseNumericDeviceId(requestedDeviceId);

    if (requestedNumericId !== null) {
      const requestedLiveDevice = directionalLiveDevices.find((device) => this.parseNumericDeviceId(device.id) === requestedNumericId);
      if (requestedLiveDevice && (!deviceName || requestedLiveDevice.name === deviceName)) {
        return {
          actualDeviceId: requestedNumericId,
          persistedDeviceId: requestedLiveDevice.id,
          deviceName: requestedLiveDevice.name,
        };
      }
    }

    if (deviceName) {
      const liveDevice = directionalLiveDevices.find((device) => device.name === deviceName);
      if (liveDevice) {
        const actualDeviceId = this.parseNumericDeviceId(liveDevice.id);
        if (actualDeviceId !== null) {
          return {
            actualDeviceId,
            persistedDeviceId: liveDevice.id,
            deviceName: liveDevice.name,
          };
        }
      }

      const registeredDevice = this.findRegisteredDeviceByName(direction, deviceName);
      throw this.createUnavailableConfiguredDeviceError(direction, deviceName, registeredDevice?.availability);
    }

    const defaultDevice = this.findDefaultDevice(directionalLiveDevices);
    const defaultDeviceId = defaultDevice
      ? this.parseNumericDeviceId(defaultDevice.id)
      : (direction === 'input' ? rtAudio.getDefaultInputDevice() : rtAudio.getDefaultOutputDevice());

    if (defaultDeviceId === null || defaultDeviceId === undefined) {
      throw this.createUnavailableConfiguredDeviceError(direction, direction === 'input' ? 'default input device' : 'default output device');
    }

    return {
      actualDeviceId: defaultDeviceId,
      persistedDeviceId: defaultDevice?.id ?? `${direction}-${defaultDeviceId}`,
      deviceName: defaultDevice?.name ?? (direction === 'input' ? 'Default audio input device' : 'Default audio output device'),
    };
  }

  markDeviceActive(direction: AudioDirection, deviceName: string | undefined, deviceId: string | undefined, sampleRate: number, channels: number): void {
    if (!deviceName || !deviceId) {
      return;
    }

    const key = this.getDeviceKey(direction, deviceName);
    const existing = this.deviceRegistry[direction].get(key);
    this.deviceRegistry[direction].set(key, {
      ...(existing ?? {
        id: deviceId,
        name: deviceName,
        isDefault: false,
        channels: Math.max(1, channels || 1),
        sampleRate,
        type: direction,
      }),
      id: deviceId,
      name: deviceName,
      channels: existing?.channels ?? Math.max(1, channels || 1),
      sampleRate: existing?.sampleRate ?? sampleRate,
      availability: 'active',
      isActiveByTx5dr: true,
      lastSeenAt: existing?.lastSeenAt ?? Date.now(),
      lastRtAudioId: deviceId,
    });
  }

  clearActiveDevice(direction: AudioDirection, deviceName?: string | null): void {
    const entries = deviceName
      ? [[this.getDeviceKey(direction, deviceName), this.findRegisteredDeviceByName(direction, deviceName)] as const]
      : Array.from(this.deviceRegistry[direction].entries());

    for (const [key, device] of entries) {
      if (!device?.isActiveByTx5dr) continue;
      this.deviceRegistry[direction].set(key, {
        ...device,
        availability: 'cached',
        isActiveByTx5dr: false,
      });
    }
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
        availability: 'available' as const,
        isActiveByTx5dr: false,
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
      availability: 'available',
      isActiveByTx5dr: false,
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
    return createRtAudioInstance({ logger, purpose: 'audio-device-enumeration' });
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
      await this.refreshDeviceRegistry();
      const devices = this.createRegisteredSnapshot('input');
      logger.debug(`Returning ${devices.length} input devices: ${devices.map((d: AudioDevice) => d.name).join(', ')}`);
      return devices;
    } catch (error) {
      logger.error('Failed to get input devices', error);
      return this.createRegisteredSnapshot('input');
    }
  }

  /**
   * 获取所有音频输出设备
   */
  async getOutputDevices(): Promise<AudioDevice[]> {
    try {
      await this.refreshDeviceRegistry();
      const devices = this.createRegisteredSnapshot('output');
      logger.debug(`Returning ${devices.length} output devices: ${devices.map((d: AudioDevice) => d.name).join(', ')}`);
      return devices;
    } catch (error) {
      logger.error('Failed to get output devices', error);
      return this.createRegisteredSnapshot('output');
    }
  }

  /**
   * 获取所有音频设备
   */
  async getAllDevices() {
    logger.debug('Getting all audio devices');
    await this.refreshDeviceRegistry();
    const inputDevices = this.createRegisteredSnapshot('input');
    const outputDevices = this.createRegisteredSnapshot('output');

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
      await this.refreshDeviceRegistry();
      const registeredDevice = this.findRegisteredDeviceByName('input', deviceName);
      if (registeredDevice) {
        return this.toPublicDevice(registeredDevice);
      }
      return this.createRegisteredSnapshot('input').find(device => device.name === deviceName) || null;
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
      await this.refreshDeviceRegistry();
      const registeredDevice = this.findRegisteredDeviceByName('output', deviceName);
      if (registeredDevice) {
        return this.toPublicDevice(registeredDevice);
      }
      return this.createRegisteredSnapshot('output').find(device => device.name === deviceName) || null;
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
      return this.findDefaultDevice(inputDevices);
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
      return this.findDefaultDevice(outputDevices);
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
      if (device.availability === 'cached' && !device.isActiveByTx5dr) {
        throw this.createUnavailableConfiguredDeviceError('input', deviceName, 'cached');
      }
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
      if (device.availability === 'cached' && !device.isActiveByTx5dr) {
        throw this.createUnavailableConfiguredDeviceError('output', deviceName, 'cached');
      }
      logger.debug(`Found configured output device: ${device.name} -> ${device.id}`);
      return device.id;
    }

    logger.warn(`Output device "${deviceName}" not found, waiting for automatic retry`);
    throw this.createMissingConfiguredDeviceError('output', deviceName);
  }

  private createMissingConfiguredDeviceError(direction: 'input' | 'output', deviceName: string, availability?: AudioDeviceAvailability): RadioError {
    return new RadioError({
      code: RadioErrorCode.DEVICE_NOT_FOUND,
      message: `Configured audio ${direction} device "${deviceName}" is temporarily unavailable`,
      userMessage: availability === 'cached'
        ? `Configured audio ${direction} device "${deviceName}" is currently unavailable or busy.`
        : `Configured audio ${direction} device "${deviceName}" is temporarily unavailable. The system will keep retrying automatically.`,
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
        availability,
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
