/* eslint-disable @typescript-eslint/no-explicit-any */
// AudioDeviceManager - 设备枚举

import { AudioDevice } from '@tx5dr/contracts';
import audify from 'audify';
const { RtAudio } = audify;
type RtAudioInstance = InstanceType<typeof RtAudio>;
import { ConfigManager } from '../config/config-manager.js';

// 音频设备管理器
export class AudioDeviceManager {
  private static instance: AudioDeviceManager;
  private icomWlanConnectedCallback: (() => boolean) | null = null;
  private rtAudio: RtAudioInstance;

  private constructor() {
    this.rtAudio = new RtAudio();
    console.log('初始化 Audify (RtAudio) 音频系统...');
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

    console.log(`🔄 [AudioDeviceManager] 转换设备 ${device.name} (${type}): 原始通道=${channels}, 最终通道=${finalChannels}`);

    return {
      id: `${type}-${device.id}`,
      name: device.name || `${type === 'input' ? '输入' : '输出'}设备 ${device.id}`,
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
      console.log('🎤 [AudioDeviceManager] 开始获取音频输入设备...');
      const devices = this.rtAudio.getDevices();
      console.log(`🎤 [AudioDeviceManager] Audify 返回 ${devices.length} 个设备`);

      devices.forEach((device: any, index: number) => {
        console.log(`🎤 [AudioDeviceManager] 设备 ${index}:`, {
          id: device.id,
          name: device.name,
          inputChannels: device.inputChannels,
          outputChannels: device.outputChannels,
          preferredSampleRate: device.preferredSampleRate
        });
      });

      // 过滤输入设备
      const inputDevices = devices.filter((device: any, index: number) => {
        const hasInputChannels = device.inputChannels && device.inputChannels > 0;
        console.log(`🎤 [AudioDeviceManager] 设备 ${index} (${device.name}) 筛选结果: ${hasInputChannels}`);
        return hasInputChannels;
      });

      console.log(`🎤 [AudioDeviceManager] 过滤后找到 ${inputDevices.length} 个输入设备`);

      const result = inputDevices.map((device: any) => {
        const isSystemDefault = Boolean(device.isDefaultInput);
        console.log(`🎤 [AudioDeviceManager] 转换输入设备: ${device.name} (默认: ${isSystemDefault})`);
        return this.convertAudifyDevice(device, 'input', isSystemDefault);
      });

      if (result.length === 0) {
        console.log('🎤 [AudioDeviceManager] 未找到具体设备，添加通用默认输入设备');
        result.push({
          id: 'input-default',
          name: '默认音频输入设备',
          isDefault: true,
          channels: 1,
          sampleRate: 48000,
          type: 'input',
        });
      }

      // ICOM WLAN 虚拟设备注入
      if (this.shouldShowIcomWlanDevice()) {
        console.log('📡 [AudioDeviceManager] 注入 ICOM WLAN 虚拟输入设备');
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

      console.log(`🎤 [AudioDeviceManager] 最终返回 ${result.length} 个输入设备:`, result.map((d: AudioDevice) => d.name));
      return result;
    } catch (error) {
      console.error('🎤 [AudioDeviceManager] 获取输入设备失败:', error);
      if (error instanceof Error) {
        console.error('🎤 [AudioDeviceManager] 错误详情:', error.stack);
      }

      return [
        {
          id: 'input-fallback',
          name: '默认输入设备 (后备)',
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
      console.log('🔊 [AudioDeviceManager] 开始获取音频输出设备...');
      const devices = this.rtAudio.getDevices();
      console.log(`🔊 [AudioDeviceManager] Audify 返回 ${devices.length} 个设备`);

      const outputDevices = devices.filter((device: any, index: number) => {
        const hasOutputChannels = device.outputChannels && device.outputChannels > 0;
        console.log(`🔊 [AudioDeviceManager] 设备 ${index} (${device.name}) 筛选结果: ${hasOutputChannels}`);
        return hasOutputChannels;
      });

      console.log(`🔊 [AudioDeviceManager] 过滤后找到 ${outputDevices.length} 个输出设备`);

      const result = outputDevices.map((device: any) => {
        const isSystemDefault = Boolean(device.isDefaultOutput);
        console.log(`🔊 [AudioDeviceManager] 转换输出设备: ${device.name} (默认: ${isSystemDefault})`);
        return this.convertAudifyDevice(device, 'output', isSystemDefault);
      });

      if (result.length === 0) {
        console.log('🔊 [AudioDeviceManager] 未找到具体设备，添加通用默认输出设备');
        result.push({
          id: 'output-default',
          name: '默认音频输出设备',
          isDefault: true,
          channels: 2,
          sampleRate: 48000,
          type: 'output',
        });
      }

      // ICOM WLAN 虚拟设备注入
      if (this.shouldShowIcomWlanDevice()) {
        console.log('📡 [AudioDeviceManager] 注入 ICOM WLAN 虚拟输出设备');
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

      console.log(`🔊 [AudioDeviceManager] 最终返回 ${result.length} 个输出设备:`, result.map((d: AudioDevice) => d.name));
      return result;
    } catch (error) {
      console.error('🔊 [AudioDeviceManager] 获取输出设备失败:', error);
      if (error instanceof Error) {
        console.error('🔊 [AudioDeviceManager] 错误详情:', error.stack);
      }

      return [
        {
          id: 'output-fallback',
          name: '默认输出设备 (后备)',
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
    console.log('📻 [AudioDeviceManager] 获取所有音频设备...');
    const [inputDevices, outputDevices] = await Promise.all([
      this.getInputDevices(),
      this.getOutputDevices(),
    ]);

    console.log(`📻 [AudioDeviceManager] 设备汇总: ${inputDevices.length} 个输入设备, ${outputDevices.length} 个输出设备`);

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
      console.error(`🎤 [AudioDeviceManager] 根据名称查找输入设备失败:`, error);
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
      console.error(`🔊 [AudioDeviceManager] 根据名称查找输出设备失败:`, error);
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
      console.error(`🎤 [AudioDeviceManager] 获取默认输入设备失败:`, error);
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
      console.error(`🔊 [AudioDeviceManager] 获取默认输出设备失败:`, error);
      return null;
    }
  }

  /**
   * 根据设备名称解析为设备ID，如果找不到则使用默认设备
   */
  async resolveInputDeviceId(deviceName?: string): Promise<string | undefined> {
    if (!deviceName) {
      const defaultDevice = await this.getDefaultInputDevice();
      console.log(`🎤 [AudioDeviceManager] 使用默认输入设备: ${defaultDevice?.name || '无'}`);
      return defaultDevice?.id;
    }

    const device = await this.getInputDeviceByName(deviceName);
    if (device) {
      console.log(`🎤 [AudioDeviceManager] 找到配置的输入设备: ${device.name} -> ${device.id}`);
      return device.id;
    }

    console.warn(`🎤 [AudioDeviceManager] 输入设备 "${deviceName}" 未找到，回退到默认设备`);
    const defaultDevice = await this.getDefaultInputDevice();
    console.log(`🎤 [AudioDeviceManager] 回退到默认输入设备: ${defaultDevice?.name || '无'}`);
    return defaultDevice?.id;
  }

  /**
   * 根据设备名称解析为设备ID，如果找不到则使用默认设备
   */
  async resolveOutputDeviceId(deviceName?: string): Promise<string | undefined> {
    if (!deviceName) {
      const defaultDevice = await this.getDefaultOutputDevice();
      console.log(`🔊 [AudioDeviceManager] 使用默认输出设备: ${defaultDevice?.name || '无'}`);
      return defaultDevice?.id;
    }

    const device = await this.getOutputDeviceByName(deviceName);
    if (device) {
      console.log(`🔊 [AudioDeviceManager] 找到配置的输出设备: ${device.name} -> ${device.id}`);
      return device.id;
    }

    console.warn(`🔊 [AudioDeviceManager] 输出设备 "${deviceName}" 未找到，回退到默认设备`);
    const defaultDevice = await this.getDefaultOutputDevice();
    console.log(`🔊 [AudioDeviceManager] 回退到默认输出设备: ${defaultDevice?.name || '无'}`);
    return defaultDevice?.id;
  }

  /**
   * 验证设备是否存在
   */
  async validateDevice(deviceId: string): Promise<boolean> {
    try {
      const device = await this.getDeviceById(deviceId);
      const exists = device !== null;
      console.log(`🔍 [AudioDeviceManager] 验证设备 ${deviceId}: ${exists ? '存在' : '不存在'}`);
      return exists;
    } catch (error) {
      console.error(`🔍 [AudioDeviceManager] 验证设备 ${deviceId} 失败:`, error);
      return false;
    }
  }
}
