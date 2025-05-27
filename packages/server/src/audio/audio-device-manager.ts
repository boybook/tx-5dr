import { AudioDevice } from '@tx5dr/contracts';
import * as naudiodon from 'naudiodon2';

// 音频设备管理器
export class AudioDeviceManager {
  private static instance: AudioDeviceManager;

  private constructor() {
    // 初始化naudiodon
    this.initializeAudio();
  }

  static getInstance(): AudioDeviceManager {
    if (!AudioDeviceManager.instance) {
      AudioDeviceManager.instance = new AudioDeviceManager();
    }
    return AudioDeviceManager.instance;
  }

  /**
   * 初始化音频系统
   */
  private initializeAudio() {
    try {
      console.log('初始化naudiodon音频系统...');
      // naudiodon初始化会在第一次调用getDevices时自动进行
    } catch (error) {
      console.error('音频系统初始化失败:', error);
    }
  }

  /**
   * 将naudiodon设备信息转换为我们的AudioDevice格式
   */
  private convertNaudiodonDevice(device: any, type: 'input' | 'output'): AudioDevice {
    return {
      id: `${type}-${device.id}`,
      name: device.name || `${type === 'input' ? '输入' : '输出'}设备 ${device.id}`,
      isDefault: device.defaultSampleRate ? true : false,
      channels: device.maxInputChannels || device.maxOutputChannels || 2,
      sampleRate: device.defaultSampleRate || 48000,
      type: type,
    };
  }

  /**
   * 获取所有音频输入设备
   */
  async getInputDevices(): Promise<AudioDevice[]> {
    try {
      const devices = naudiodon.getDevices();
      const inputDevices = devices
        .filter(device => device.maxInputChannels > 0)
        .map(device => this.convertNaudiodonDevice(device, 'input'));
      
      console.log(`找到 ${inputDevices.length} 个输入设备`);
      return inputDevices;
    } catch (error) {
      console.error('获取输入设备失败:', error);
      // 返回模拟数据作为后备
      return [
        {
          id: 'input-fallback',
          name: '默认输入设备 (模拟)',
          isDefault: true,
          channels: 2,
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
      const devices = naudiodon.getDevices();
      const outputDevices = devices
        .filter(device => device.maxOutputChannels > 0)
        .map(device => this.convertNaudiodonDevice(device, 'output'));
      
      console.log(`找到 ${outputDevices.length} 个输出设备`);
      return outputDevices;
    } catch (error) {
      console.error('获取输出设备失败:', error);
      // 返回模拟数据作为后备
      return [
        {
          id: 'output-fallback',
          name: '默认输出设备 (模拟)',
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
    const [inputDevices, outputDevices] = await Promise.all([
      this.getInputDevices(),
      this.getOutputDevices(),
    ]);

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
   * 验证设备是否存在
   */
  async validateDevice(deviceId: string): Promise<boolean> {
    const device = await this.getDeviceById(deviceId);
    return device !== null;
  }
} 