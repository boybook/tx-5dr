import * as naudiodon from 'naudiodon2';
import { RingBufferAudioProvider } from './AudioBufferProvider.js';
import { EventEmitter } from 'eventemitter3';
import { clearResamplerCache } from '../utils/audioUtils.js';
import { ConfigManager } from '../config/config-manager.js';
import { AudioDeviceManager } from './audio-device-manager.js';

export interface AudioStreamEvents {
  'audioData': (samples: Float32Array) => void;
  'error': (error: Error) => void;
  'started': () => void;
  'stopped': () => void;
}

/**
 * 音频流管理器 - 负责从音频设备捕获实时音频数据
 * 简化版本：只进行基本的数据验证和转换
 */
export class AudioStreamManager extends EventEmitter<AudioStreamEvents> {
  private audioInput: any = null;
  private audioOutput: any = null;
  private isStreaming = false;
  private isOutputting = false;
  private audioProvider: RingBufferAudioProvider;
  private deviceId: string | null = null;
  private outputDeviceId: string | null = null;
  private sampleRate: number;
  private bufferSize: number;
  private channels: number = 1;
  private volumeGain: number = 1.0; // 默认音量为1.0（100%），对应0dB
  private volumeGainDb: number = 0.0; // 以dB为单位的增益值
  private currentAudioData: Float32Array | null = null; // 当前正在播放的音频数据
  private currentSampleRate: number; // 当前音频的采样率
  
  constructor() {
    super();
    
    // 从配置管理器获取音频设置
    const configManager = ConfigManager.getInstance();
    const audioConfig = configManager.getAudioConfig();
    
    this.sampleRate = audioConfig.sampleRate || 48000;
    this.bufferSize = audioConfig.bufferSize || 1024;
    this.currentSampleRate = this.sampleRate;
    
    console.log(`🎵 [AudioStreamManager] 使用音频配置: 采样率=${this.sampleRate}Hz, 缓冲区=${this.bufferSize}帧`);
    
    // 创建音频缓冲区提供者，使用配置的采样率
    this.audioProvider = new RingBufferAudioProvider(this.sampleRate, this.sampleRate * 5); // 5秒缓冲
  }
  
  /**
   * 启动音频流
   */
  async startStream(deviceId?: string): Promise<void> {
    if (this.isStreaming) {
      console.log('⚠️ 音频流已经在运行中');
      return;
    }
    
    try {
      console.log('🎤 启动音频流...');
      
      // 从配置获取设备名称并解析为设备ID
      const configManager = ConfigManager.getInstance();
      const audioConfig = configManager.getAudioConfig();
      const audioDeviceManager = AudioDeviceManager.getInstance();
      
      // 解析输入设备ID
      let actualDeviceId: number | undefined = undefined;
      if (deviceId) {
        // 如果提供了设备ID，直接使用
        if (deviceId.startsWith('input-')) {
          actualDeviceId = parseInt(deviceId.replace('input-', ''));
        } else {
          actualDeviceId = parseInt(deviceId);
        }
        console.log(`🎯 使用指定音频输入设备 ID: ${actualDeviceId}`);
      } else {
        // 使用配置中的设备名称解析为ID
        const resolvedDeviceId = await audioDeviceManager.resolveInputDeviceId(audioConfig.inputDeviceName);
        if (resolvedDeviceId) {
          if (resolvedDeviceId.startsWith('input-')) {
            actualDeviceId = parseInt(resolvedDeviceId.replace('input-', ''));
          } else {
            actualDeviceId = parseInt(resolvedDeviceId);
          }
          console.log(`🎯 解析到音频输入设备: ${audioConfig.inputDeviceName || '默认设备'} -> ID ${actualDeviceId}`);
        } else {
          console.log('🎯 使用系统默认音频输入设备');
        }
      }
      
      // 配置音频输入参数 - 使用配置的设置
      const inputOptions: any = {
        channelCount: this.channels,
        sampleFormat: naudiodon.SampleFormatFloat32, // 使用 float32 格式
        sampleRate: this.sampleRate,
        deviceId: actualDeviceId,
        // 使用配置的缓冲区大小
        framesPerBuffer: this.bufferSize,
        // 根据缓冲区大小计算建议延迟
        suggestedLatency: (this.bufferSize / this.sampleRate) * 2 // 缓冲区大小的2倍作为延迟
      };
      
      console.log('音频输入配置:', inputOptions);
      
      // 创建和启动音频输入流（带超时保护）
      await this.createAndStartInputWithTimeout(inputOptions, deviceId);
      
      this.isStreaming = true;
      console.log(`✅ 音频流启动成功 (${this.sampleRate}Hz, 缓冲区: ${inputOptions.framesPerBuffer} 帧)`);
      this.emit('started');
      
    } catch (error) {
      console.error('启动音频流失败:', error);
      // 清理失败的输入流
      if (this.audioInput) {
        try {
          this.audioInput.quit();
        } catch (cleanupError) {
          console.error('清理音频输入流失败:', cleanupError);
        }
        this.audioInput = null;
      }
      this.isStreaming = false;
      this.deviceId = null;
      this.emit('error', error as Error);
      throw error;
    }
  }
  
  /**
   * 停止音频流
   */
  async stopStream(): Promise<void> {
    if (!this.isStreaming) {
      console.log('⚠️ 音频流未运行');
      return;
    }
    
    try {
      console.log('🛑 停止音频流...');
      
      if (this.audioInput) {
        this.audioInput.quit();
        this.audioInput = null;
      }
      
      // 清理重采样器缓存
      clearResamplerCache();
      
      this.isStreaming = false;
      this.deviceId = null;
      
      console.log('✅ 音频流停止成功');
      this.emit('stopped');
      
    } catch (error) {
      console.error('停止音频流失败:', error);
      this.emit('error', error as Error);
      throw error;
    }
  }
  
  /**
   * 获取音频缓冲区提供者
   */
  getAudioProvider(): RingBufferAudioProvider {
    return this.audioProvider;
  }
  
  /**
   * 获取当前采样率
   */
  getCurrentSampleRate(): number {
    return this.sampleRate;
  }

  /**
   * 重新加载音频配置
   * 注意：需要重启音频流才能生效
   */
  reloadAudioConfig(): void {
    const configManager = ConfigManager.getInstance();
    const audioConfig = configManager.getAudioConfig();
    
    const oldSampleRate = this.sampleRate;
    const oldBufferSize = this.bufferSize;
    
    this.sampleRate = audioConfig.sampleRate || 48000;
    this.bufferSize = audioConfig.bufferSize || 1024;
    this.currentSampleRate = this.sampleRate;
    
    console.log(`🔄 [AudioStreamManager] 音频配置已重新加载:`);
    console.log(`   采样率: ${oldSampleRate}Hz -> ${this.sampleRate}Hz`);
    console.log(`   缓冲区: ${oldBufferSize}帧 -> ${this.bufferSize}帧`);
    console.log(`   ⚠️ 需要重启音频流才能生效`);
  }
  
  /**
   * 获取流状态
   */
  getStatus() {
    return {
      isStreaming: this.isStreaming,
      isOutputting: this.isOutputting,
      inputDeviceId: this.deviceId,
      outputDeviceId: this.outputDeviceId,
      sampleRate: this.sampleRate,
      channels: this.channels,
      bufferStatus: this.audioProvider.getStatus()
    };
  }
  
  /**
   * 将 Buffer 转换为 Float32Array
   */
  private convertBufferToFloat32(buffer: Buffer): Float32Array {
    try {
      // 确保缓冲区长度是4的倍数（Float32 = 4字节）
      if (buffer.length % 4 !== 0) {
        console.warn(`⚠️ Buffer 长度不是4的倍数: ${buffer.length}`);
        // 截断到最近的4的倍数
        const truncatedLength = Math.floor(buffer.length / 4) * 4;
        buffer = buffer.subarray(0, truncatedLength);
      }
      
      // 创建 Float32Array 视图
      const samples = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4);
      
      // 检查是否有无效值（NaN 或 Infinity）
      let hasInvalidValues = false;
      for (let i = 0; i < samples.length; i++) {
        const sample = samples[i];
        if (sample === undefined || !isFinite(sample)) {
          samples[i] = 0; // 将无效值替换为0
          hasInvalidValues = true;
        }
      }
      
      if (hasInvalidValues) {
        console.warn('⚠️ 检测到无效音频样本值，已替换为0');
      }
      
      return samples;
    } catch (error) {
      console.error('Buffer 转换错误:', error);
      // 返回空数组作为后备
      return new Float32Array(0);
    }
  }
  
  /**
   * 清空音频缓冲区
   */
  clearBuffer(): void {
    this.audioProvider.clear();
  }
  
  /**
   * 启动音频输出流
   */
  async startOutput(outputDeviceId?: string): Promise<void> {
    if (this.isOutputting) {
      console.log('⚠️ 音频输出已经在运行中');
      return;
    }
    
    try {
      console.log('🔊 启动音频输出...');
      
      // 从配置获取设备名称并解析为设备ID
      const configManager = ConfigManager.getInstance();
      const audioConfig = configManager.getAudioConfig();
      const audioDeviceManager = AudioDeviceManager.getInstance();
      
      // 解析输出设备ID
      let actualOutputDeviceId: number | undefined = undefined;
      if (outputDeviceId) {
        // 如果提供了设备ID，直接使用
        if (outputDeviceId.startsWith('output-')) {
          actualOutputDeviceId = parseInt(outputDeviceId.replace('output-', ''));
        } else {
          actualOutputDeviceId = parseInt(outputDeviceId);
        }
        console.log(`🎯 使用指定音频输出设备 ID: ${actualOutputDeviceId}`);
      } else {
        // 使用配置中的设备名称解析为ID
        const resolvedDeviceId = await audioDeviceManager.resolveOutputDeviceId(audioConfig.outputDeviceName);
        if (resolvedDeviceId) {
          if (resolvedDeviceId.startsWith('output-')) {
            actualOutputDeviceId = parseInt(resolvedDeviceId.replace('output-', ''));
          } else {
            actualOutputDeviceId = parseInt(resolvedDeviceId);
          }
          console.log(`🎯 解析到音频输出设备: ${audioConfig.outputDeviceName || '默认设备'} -> ID ${actualOutputDeviceId}`);
        } else {
          console.log('🎯 使用系统默认音频输出设备');
        }
      }
      
      // 配置音频输出参数 - 使用配置的设置
      const outputOptions: any = {
        channelCount: this.channels,
        sampleFormat: naudiodon.SampleFormatFloat32,
        sampleRate: this.sampleRate,
        deviceId: actualOutputDeviceId,
        // 使用配置的缓冲区大小
        framesPerBuffer: this.bufferSize,
        // 根据缓冲区大小计算建议延迟
        suggestedLatency: (this.bufferSize / this.sampleRate) * 2
      };
      
      console.log('音频输出配置:', outputOptions);
      
      // 创建和启动音频输出流（带超时保护）
      console.log('🔧 创建音频输出流...');
      await this.createAndStartOutputWithTimeout(outputOptions, outputDeviceId);
      
      this.isOutputting = true;
      console.log(`✅ 音频输出启动成功 (${this.sampleRate}Hz)`);
      
    } catch (error) {
      console.error('启动音频输出失败:', error);
      // 清理失败的输出流
      if (this.audioOutput) {
        try {
          this.audioOutput.quit();
        } catch (cleanupError) {
          console.error('清理音频输出流失败:', cleanupError);
        }
        this.audioOutput = null;
      }
      this.isOutputting = false;
      this.outputDeviceId = null;
      this.emit('error', error as Error);
      throw error;
    }
  }
  
  /**
   * 带超时保护的音频输入创建和启动
   */
  private async createAndStartInputWithTimeout(inputOptions: any, deviceId?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        console.error('⏰ 音频输入创建/启动超时 (15秒)');
        reject(new Error('音频输入创建/启动超时'));
      }, 15000); // 15秒超时
      
      try {
        // 使用 setImmediate 异步化整个创建和启动过程
        setImmediate(() => {
          try {
            console.log('🔄 执行音频输入创建...');
            
            // 创建 AudioIO 实例
            this.audioInput = new (naudiodon as any).AudioIO({
              inOptions: inputOptions
            });
            
            console.log('✅ 音频输入流创建成功');
            this.deviceId = deviceId || 'default';
            
            // 监听音频数据
            this.audioInput.on('data', async (chunk: Buffer) => {
              try {
                // 检查数据完整性
                if (!chunk || chunk.length === 0) {
                  console.warn('⚠️ 收到空音频数据块');
                  return;
                }
                
                // 确保数据长度是4的倍数（Float32）
                if (chunk.length % 4 !== 0) {
                  console.warn(`⚠️ 音频数据长度不是4的倍数: ${chunk.length}`);
                  return;
                }
                
                // 将 Buffer 转换为 Float32Array（已经是 float 格式）
                const samples = this.convertBufferToFloat32(chunk);
                
                // 检查样本数据的有效性
                if (samples.length === 0) {
                  console.warn('⚠️ 转换后的音频样本为空');
                  return;
                }
                
                // 存储到环形缓冲区（保持原始采样率）
                this.audioProvider.writeAudio(samples);
                
                // 发出事件
                this.emit('audioData', samples);
                
              } catch (error) {
                console.error('音频数据处理错误:', error);
                this.emit('error', error as Error);
              }
            });
            
            // 设置错误监听器
            this.audioInput.on('error', (error: Error) => {
              console.error('音频输入错误:', error);
              this.emit('error', error);
            });
            
            console.log('🚀 启动音频输入流...');
            
            // 启动音频输入流
            this.audioInput.start();
            
            console.log('✅ 音频输入流启动成功');
            clearTimeout(timeout);
            resolve();
            
          } catch (error) {
            console.error('❌ 音频输入创建/启动失败:', error);
            clearTimeout(timeout);
            reject(error);
          }
        });
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  /**
   * 带超时保护的音频输出创建和启动
   */
  private async createAndStartOutputWithTimeout(outputOptions: any, outputDeviceId?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        console.error('⏰ 音频输出创建/启动超时 (15秒)');
        reject(new Error('音频输出创建/启动超时'));
      }, 15000); // 15秒超时，给创建过程更多时间
      
      try {
        // 使用 setImmediate 异步化整个创建和启动过程
        setImmediate(() => {
          try {
            console.log('🔄 执行音频输出创建...');
            
            // 创建 AudioIO 实例
            this.audioOutput = new (naudiodon as any).AudioIO({
              outOptions: outputOptions
            });
            
            console.log('✅ 音频输出流创建成功');
            this.outputDeviceId = outputDeviceId || 'default';
            
            // 设置错误监听器
            this.audioOutput.on('error', (error: Error) => {
              console.error('音频输出错误:', error);
              this.emit('error', error);
            });
            
            console.log('🚀 启动音频输出流...');
            
            // 启动音频输出流
            this.audioOutput.start();
            
            console.log('✅ 音频输出流启动成功');
            clearTimeout(timeout);
            resolve();
            
          } catch (error) {
            console.error('❌ 音频输出创建/启动失败:', error);
            clearTimeout(timeout);
            reject(error);
          }
        });
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
  }
  
  /**
   * 停止音频输出流
   */
  async stopOutput(): Promise<void> {
    if (!this.isOutputting) {
      console.log('⚠️ 音频输出未运行');
      return;
    }
    
    try {
      console.log('🛑 停止音频输出...');
      
      if (this.audioOutput) {
        this.audioOutput.quit();
        this.audioOutput = null;
      }
      
      this.isOutputting = false;
      this.outputDeviceId = null;
      
      console.log('✅ 音频输出停止成功');
      
    } catch (error) {
      console.error('停止音频输出失败:', error);
      this.emit('error', error as Error);
      throw error;
    }
  }
  
  /**
   * 将dB值转换为线性增益
   * @param db dB值
   * @returns 线性增益值
   */
  private dbToGain(db: number): number {
    return Math.pow(10, db / 20);
  }

  /**
   * 将线性增益转换为dB值
   * @param gain 线性增益值
   * @returns dB值
   */
  private gainToDb(gain: number): number {
    return 20 * Math.log10(Math.max(0.001, gain));
  }

  /**
   * 设置音量增益（dB单位）
   * @param db dB值（-60 到 +20 dB）
   */
  setVolumeGainDb(db: number): void {
    // 限制dB范围在-60到+20之间
    this.volumeGainDb = Math.max(-60.0, Math.min(20.0, db));
    this.volumeGain = this.dbToGain(this.volumeGainDb);
    
    console.log(`🔊 设置音量增益: ${this.volumeGainDb.toFixed(1)}dB (线性: ${this.volumeGain.toFixed(3)})`);
    
    // 如果当前有正在播放的音频，立即应用新的音量
    if (this.currentAudioData) {
      this.applyVolumeGain(this.currentAudioData);
    }
  }

  /**
   * 设置音量增益（线性单位，向后兼容）
   * @param gain 增益值（0.001 - 10.0）
   */
  setVolumeGain(gain: number): void {
    // 限制增益范围
    this.volumeGain = Math.max(0.001, Math.min(10.0, gain));
    this.volumeGainDb = this.gainToDb(this.volumeGain);
    
    console.log(`🔊 设置音量增益: ${this.volumeGain.toFixed(3)} (${this.volumeGainDb.toFixed(1)}dB)`);
    
    // 如果当前有正在播放的音频，立即应用新的音量
    if (this.currentAudioData) {
      this.applyVolumeGain(this.currentAudioData);
    }
  }

  /**
   * 应用音量增益到音频数据
   */
  private applyVolumeGain(audioData: Float32Array): void {
    if (this.volumeGain !== 1.0) {
      for (let i = 0; i < audioData.length; i++) {
        audioData[i] *= this.volumeGain;
      }
    }
  }
  
  /**
   * 获取当前音量增益（线性单位）
   */
  getVolumeGain(): number {
    return this.volumeGain;
  }

  /**
   * 获取当前音量增益（dB单位）
   */
  getVolumeGainDb(): number {
    return this.volumeGainDb;
  }
  
  /**
   * 播放编码后的音频数据
   */
  async playAudio(audioData: Float32Array, targetSampleRate: number = 48000): Promise<void> {
    const playStartTime = Date.now();
    
    if (!this.isOutputting || !this.audioOutput) {
      throw new Error('音频输出流未启动');
    }
    
    console.log(`🔊 [音频播放] 开始播放音频 (${new Date(playStartTime).toISOString()}):`);
    console.log(`   原始样本数: ${audioData.length}`);
    console.log(`   原始采样率: ${targetSampleRate}Hz`);
    console.log(`   原始时长: ${(audioData.length / targetSampleRate).toFixed(2)}s`);
    console.log(`   目标采样率: ${this.sampleRate}Hz`);
    console.log(`   音量增益: ${this.volumeGain.toFixed(2)}`);
    
    try {
      let playbackData: Float32Array;
      
      // 检查是否需要重采样
      if (targetSampleRate !== this.sampleRate) {
        console.log(`🔄 [音频播放] 重采样: ${targetSampleRate}Hz -> ${this.sampleRate}Hz`);
        // 使用更准确的重采样
        const ratio = this.sampleRate / targetSampleRate;
        const newLength = Math.floor(audioData.length * ratio);
        playbackData = new Float32Array(newLength);
        
        for (let i = 0; i < newLength; i++) {
          const sourceIndex = i / ratio;
          const index = Math.floor(sourceIndex);
          const fraction = sourceIndex - index;
          
          if (index + 1 < audioData.length) {
            playbackData[i] = audioData[index] * (1 - fraction) + audioData[index + 1] * fraction;
          } else {
            playbackData[i] = audioData[index] || 0;
          }
        }
        
        console.log(`🔄 [音频播放] 重采样完成: ${audioData.length} -> ${playbackData.length} 样本`);
      } else {
        console.log(`✅ [音频播放] 采样率匹配，无需重采样`);
        playbackData = audioData;
      }

      // 保存当前播放的音频数据
      this.currentAudioData = playbackData;
      this.currentSampleRate = this.sampleRate;

      // 应用音量增益
      this.applyVolumeGain(playbackData);
      
      // 分块播放，避免缓冲区溢出
      const chunkSize = 4096; // 4K 样本一块
      const totalChunks = Math.ceil(playbackData.length / chunkSize);
      
      console.log(`🔊 [音频播放] 分块播放: ${totalChunks} 块，每块 ${chunkSize} 样本`);
      
      const chunkStartTime = Date.now();
      console.log(`📝 [音频播放] 开始分块写入 (${new Date(chunkStartTime).toISOString()})`);
      
      for (let i = 0; i < totalChunks; i++) {
        const start = i * chunkSize;
        const end = Math.min(start + chunkSize, playbackData.length);
        const chunk = playbackData.slice(start, end);
        
        // 转换为 Buffer
        const buffer = Buffer.allocUnsafe(chunk.length * 4);
        for (let j = 0; j < chunk.length; j++) {
          buffer.writeFloatLE(chunk[j], j * 4);
        }
        
        // 写入音频输出流
        const written = this.audioOutput.write(buffer);
        if (!written) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        
        // 控制播放速度，避免缓冲区溢出
        if (i % 10 === 0) { // 每10块暂停一下
          await new Promise(resolve => setTimeout(resolve, 1));
        }
      }
      
      const chunkEndTime = Date.now();
      const chunkDuration = chunkEndTime - chunkStartTime;
      console.log(`📝 [音频播放] 分块写入完成 (${new Date(chunkEndTime).toISOString()}), 耗时: ${chunkDuration}ms`);
      
      // 播放完成后清除当前音频数据
      this.currentAudioData = null;
      
      const playEndTime = Date.now();
      const playDuration = playEndTime - playStartTime;
      console.log(`✅ [音频播放] 播放完成 (${new Date(playEndTime).toISOString()}), 耗时: ${playDuration}ms`);
      
    } catch (error) {
      console.error('❌ [音频播放] 播放失败:', error);
      this.currentAudioData = null;
      throw error;
    }
  }
} 