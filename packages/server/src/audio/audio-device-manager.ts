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
  private convertNaudiodonDevice(device: any, type: 'input' | 'output', isSystemDefault: boolean = false): AudioDevice {
    const channels = type === 'input' ? device.maxInputChannels : device.maxOutputChannels;
    // 如果没有通道信息，根据类型设置默认值
    const defaultChannels = type === 'input' ? 1 : 2;
    const finalChannels = channels && channels > 0 ? channels : defaultChannels;
    
    console.log(`🔄 [AudioDeviceManager] 转换设备 ${device.name} (${type}): 原始通道=${channels}, 最终通道=${finalChannels}`);
    
    return {
      id: `${type}-${device.id}`,
      name: device.name || `${type === 'input' ? '输入' : '输出'}设备 ${device.id}`,
      isDefault: isSystemDefault,
      channels: finalChannels,
      sampleRate: device.defaultSampleRate || 48000,
      type: type,
    };
  }

  /**
   * 获取所有音频输入设备
   */
  async getInputDevices(): Promise<AudioDevice[]> {
    try {
      console.log('🎤 [AudioDeviceManager] 开始获取音频输入设备...');
      const devices = naudiodon.getDevices();
      console.log(`🎤 [AudioDeviceManager] naudiodon 返回 ${devices.length} 个设备`);
      
      // 详细记录所有设备信息
      devices.forEach((device, index) => {
        console.log(`🎤 [AudioDeviceManager] 设备 ${index}:`, {
          id: device.id,
          name: device.name,
          maxInputChannels: device.maxInputChannels,
          maxOutputChannels: device.maxOutputChannels,
          defaultSampleRate: device.defaultSampleRate
        });
      });
      
      // 过滤输入设备 - 非常宽松的条件，只要有可能是输入设备就保留
      const inputDevices = devices.filter((device, index) => {
        const hasInputChannels = device.maxInputChannels && device.maxInputChannels > 0;
        const isDefaultDevice = device.name && (
          device.name.toLowerCase().includes('default') || 
          device.name.toLowerCase().includes('sysdefault')
        );
        const isHardwareDevice = device.name && device.name.includes('hw:');
        // 如果是第一个设备，通常也是默认设备
        const isFirstDevice = index === 0;
        // 如果设备名称包含常见的输入设备关键词
        const isInputKeyword = device.name && (
          device.name.toLowerCase().includes('input') ||
          device.name.toLowerCase().includes('capture') ||
          device.name.toLowerCase().includes('mic') ||
          device.name.toLowerCase().includes('record')
        );
        // 如果设备有名称且不是明确的输出设备，也保留
        const hasNameNotOutput = device.name && !device.name.toLowerCase().includes('output');
        
        const shouldKeep = hasInputChannels || isDefaultDevice || isHardwareDevice || isFirstDevice || isInputKeyword || hasNameNotOutput;
        
        console.log(`🎤 [AudioDeviceManager] 设备 ${index} (${device.name}) 筛选结果: ${shouldKeep}`, {
          hasInputChannels,
          isDefaultDevice,
          isHardwareDevice,
          isFirstDevice,
          isInputKeyword,
          hasNameNotOutput
        });
        
        return shouldKeep;
      });
      
      console.log(`🎤 [AudioDeviceManager] 过滤后找到 ${inputDevices.length} 个输入设备`);
      
      const result = inputDevices.map((device, index) => {
        // 判断是否为默认设备
        const isSystemDefault = Boolean(device.name && (
          device.name.toLowerCase().includes('default') ||
          device.name.toLowerCase() === 'sysdefault'
        )) || index === 0;  // 第一个设备通常是默认设备
        
        console.log(`🎤 [AudioDeviceManager] 转换输入设备: ${device.name} (默认: ${isSystemDefault})`);
        return this.convertNaudiodonDevice(device, 'input', isSystemDefault);
      });
      
      // 如果没有找到任何设备，添加一个通用的默认设备
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
      
      console.log(`🎤 [AudioDeviceManager] 最终返回 ${result.length} 个输入设备:`, result.map(d => d.name));
      return result;
    } catch (error) {
      console.error('🎤 [AudioDeviceManager] 获取输入设备失败:', error);
      if (error instanceof Error) {
        console.error('🎤 [AudioDeviceManager] 错误详情:', error.stack);
      }
      
      // 返回模拟数据作为后备
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
      const devices = naudiodon.getDevices();
      console.log(`🔊 [AudioDeviceManager] naudiodon 返回 ${devices.length} 个设备`);
      
      // 过滤输出设备 - 非常宽松的条件，只要有可能是输出设备就保留
      const outputDevices = devices.filter((device, index) => {
        const hasOutputChannels = device.maxOutputChannels && device.maxOutputChannels > 0;
        const isDefaultDevice = device.name && (
          device.name.toLowerCase().includes('default') || 
          device.name.toLowerCase().includes('sysdefault')
        );
        const isHardwareDevice = device.name && device.name.includes('hw:');
        // 如果是第一个设备，通常也是默认设备
        const isFirstDevice = index === 0;
        // 如果设备名称包含常见的输出设备关键词
        const isOutputKeyword = device.name && (
          device.name.toLowerCase().includes('output') ||
          device.name.toLowerCase().includes('playback') ||
          device.name.toLowerCase().includes('speaker') ||
          device.name.toLowerCase().includes('headphone')
        );
        // 如果设备有名称且不是明确的输入设备，也保留
        const hasNameNotInput = device.name && !device.name.toLowerCase().includes('input');
        
        const shouldKeep = hasOutputChannels || isDefaultDevice || isHardwareDevice || isFirstDevice || isOutputKeyword || hasNameNotInput;
        
        console.log(`🔊 [AudioDeviceManager] 设备 ${index} (${device.name}) 筛选结果: ${shouldKeep}`, {
          hasOutputChannels,
          isDefaultDevice,
          isHardwareDevice,
          isFirstDevice,
          isOutputKeyword,
          hasNameNotInput
        });
        
        return shouldKeep;
      });
      
      console.log(`🔊 [AudioDeviceManager] 过滤后找到 ${outputDevices.length} 个输出设备`);
      
      const result = outputDevices.map((device, index) => {
        // 判断是否为默认设备
        const isSystemDefault = Boolean(device.name && (
          device.name.toLowerCase().includes('default') ||
          device.name.toLowerCase() === 'sysdefault'
        )) || index === 0;  // 第一个设备通常是默认设备
        
        console.log(`🔊 [AudioDeviceManager] 转换输出设备: ${device.name} (默认: ${isSystemDefault})`);
        return this.convertNaudiodonDevice(device, 'output', isSystemDefault);
      });
      
      // 如果没有找到任何设备，添加一个通用的默认设备
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
      
      console.log(`🔊 [AudioDeviceManager] 最终返回 ${result.length} 个输出设备:`, result.map(d => d.name));
      return result;
    } catch (error) {
      console.error('🔊 [AudioDeviceManager] 获取输出设备失败:', error);
      if (error instanceof Error) {
        console.error('🔊 [AudioDeviceManager] 错误详情:', error.stack);
      }
      
      // 返回模拟数据作为后备
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