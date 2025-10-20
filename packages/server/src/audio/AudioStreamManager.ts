import * as naudiodon from 'naudiodon2';
import { RingBufferAudioProvider } from './AudioBufferProvider.js';
import { EventEmitter } from 'eventemitter3';
import { clearResamplerCache } from '../utils/audioUtils.js';
import { ConfigManager } from '../config/config-manager.js';
import { AudioDeviceManager } from './audio-device-manager.js';
import { once } from 'events';
import { performance } from 'node:perf_hooks';
import type { IcomWlanAudioAdapter } from './IcomWlanAudioAdapter.js';

export interface AudioStreamEvents {
  'audioData': (samples: Float32Array) => void;
  'error': (error: Error) => void;
  'started': () => void;
  'stopped': () => void;
}

/**
 * 音频流管理器 - 负责从音频设备捕获实时音频数据
 * 支持传统声卡和 ICOM WLAN 虚拟设备
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

  // ICOM WLAN 音频适配器（外部注入）
  private icomWlanAudioAdapter: IcomWlanAudioAdapter | null = null;
  private usingIcomWlanInput = false; // 是否使用 ICOM WLAN 输入
  private usingIcomWlanOutput = false; // 是否使用 ICOM WLAN 输出

  // 播放状态跟踪（用于重新混音兜底方案）
  private playing: boolean = false;             // 是否正在播放
  private playbackStartTime: number = 0;        // 播放开始时间戳
  private currentPlaybackPromise: Promise<void> | null = null;  // 当前播放的Promise
  private shouldStopPlayback: boolean = false;  // 停止播放标志
  
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
   * 设置 ICOM WLAN 音频适配器（由 DigitalRadioEngine 注入）
   */
  setIcomWlanAudioAdapter(adapter: IcomWlanAudioAdapter | null): void {
    this.icomWlanAudioAdapter = adapter;
    console.log(`📡 [AudioStreamManager] ICOM WLAN 音频适配器已${adapter ? '设置' : '清除'}`);
  }

  /**
   * 获取采样率（供外部使用）
   */
  getSampleRate(): number {
    return this.sampleRate;
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
      let resolvedDeviceId: string | undefined;

      if (deviceId) {
        resolvedDeviceId = deviceId;
      } else {
        // 使用配置中的设备名称解析为ID
        resolvedDeviceId = await audioDeviceManager.resolveInputDeviceId(audioConfig.inputDeviceName);
      }

      // 检测是否为 ICOM WLAN 虚拟设备
      if (resolvedDeviceId === 'icom-wlan-input' || audioConfig.inputDeviceName === 'ICOM WLAN') {
        console.log('📡 [AudioStreamManager] 检测到 ICOM WLAN 虚拟输入设备');

        if (!this.icomWlanAudioAdapter) {
          throw new Error('ICOM WLAN 音频适配器未设置，请先连接 ICOM 电台');
        }

        // 使用 ICOM WLAN 音频适配器
        this.usingIcomWlanInput = true;
        this.icomWlanAudioAdapter.startReceiving();

        // 订阅音频数据
        this.icomWlanAudioAdapter.on('audioData', (samples: Float32Array) => {
          this.audioProvider.writeAudio(samples);
          this.emit('audioData', samples);
        });

        this.icomWlanAudioAdapter.on('error', (error: Error) => {
          console.error('❌ [AudioStreamManager] ICOM WLAN 音频错误:', error);
          this.emit('error', error);
        });

        this.deviceId = 'icom-wlan-input';
        this.isStreaming = true;
        console.log(`✅ [AudioStreamManager] ICOM WLAN 音频输入启动成功 (12kHz → 48kHz)`);
        this.emit('started');
        return;
      }

      // 传统声卡模式：解析设备ID
      if (resolvedDeviceId) {
        if (resolvedDeviceId.startsWith('input-')) {
          actualDeviceId = parseInt(resolvedDeviceId.replace('input-', ''));
        } else if (!isNaN(parseInt(resolvedDeviceId))) {
          actualDeviceId = parseInt(resolvedDeviceId);
        }
        console.log(`🎯 解析到音频输入设备: ${audioConfig.inputDeviceName || '默认设备'} -> ID ${actualDeviceId}`);
      } else {
        console.log('🎯 使用系统默认音频输入设备');
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

      // 停止 ICOM WLAN 音频输入
      if (this.usingIcomWlanInput && this.icomWlanAudioAdapter) {
        this.icomWlanAudioAdapter.stopReceiving();
        this.icomWlanAudioAdapter.removeAllListeners('audioData');
        this.icomWlanAudioAdapter.removeAllListeners('error');
        this.usingIcomWlanInput = false;
        console.log('✅ ICOM WLAN 音频输入已停止');
      }

      // 停止传统声卡输入
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
      let resolvedOutputDeviceId: string | undefined;

      if (outputDeviceId) {
        resolvedOutputDeviceId = outputDeviceId;
      } else {
        // 使用配置中的设备名称解析为ID
        resolvedOutputDeviceId = await audioDeviceManager.resolveOutputDeviceId(audioConfig.outputDeviceName);
      }

      // 检测是否为 ICOM WLAN 虚拟设备
      if (resolvedOutputDeviceId === 'icom-wlan-output' || audioConfig.outputDeviceName === 'ICOM WLAN') {
        console.log('📡 [AudioStreamManager] 检测到 ICOM WLAN 虚拟输出设备');

        if (!this.icomWlanAudioAdapter) {
          throw new Error('ICOM WLAN 音频适配器未设置，请先连接 ICOM 电台');
        }

        // 标记使用 ICOM WLAN 输出
        this.usingIcomWlanOutput = true;
        this.outputDeviceId = 'icom-wlan-output';
        this.isOutputting = true;
        console.log(`✅ [AudioStreamManager] ICOM WLAN 音频输出启动成功 (48kHz → 12kHz)`);
        return;
      }

      // 传统声卡模式：解析设备ID
      if (resolvedOutputDeviceId) {
        if (resolvedOutputDeviceId.startsWith('output-')) {
          actualOutputDeviceId = parseInt(resolvedOutputDeviceId.replace('output-', ''));
        } else if (!isNaN(parseInt(resolvedOutputDeviceId))) {
          actualOutputDeviceId = parseInt(resolvedOutputDeviceId);
        }
        console.log(`🎯 解析到音频输出设备: ${audioConfig.outputDeviceName || '默认设备'} -> ID ${actualOutputDeviceId}`);
      } else {
        console.log('🎯 使用系统默认音频输出设备');
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

      // ICOM WLAN 输出只需要清除标志，不需要额外操作
      if (this.usingIcomWlanOutput) {
        this.usingIcomWlanOutput = false;
        console.log('✅ ICOM WLAN 音频输出已停止');
      }

      // 停止传统声卡输出
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
   * 检查是否正在播放音频
   * @returns 是否正在播放
   */
  public isPlaying(): boolean {
    return this.playing;
  }

  /**
   * 停止当前正在播放的音频（用于重新混音）
   * @returns 已播放的时间(ms)
   */
  public async stopCurrentPlayback(): Promise<number> {
    if (!this.playing) {
      console.log('🛑 [音频播放] 没有正在播放的音频');
      return 0;
    }

    const now = Date.now();
    const elapsedTime = now - this.playbackStartTime;

    console.log(`🛑 [音频播放] 停止当前播放, 已播放时间: ${elapsedTime}ms`);

    // 设置停止标志,让播放循环自动退出
    this.shouldStopPlayback = true;

    // 等待当前播放完全停止
    if (this.currentPlaybackPromise) {
      try {
        await this.currentPlaybackPromise;
      } catch (error) {
        // 播放被中断是预期的行为
        console.log(`🛑 [音频播放] 播放已被中断`);
      }
    }

    this.playing = false;
    this.shouldStopPlayback = false;
    this.currentPlaybackPromise = null;

    console.log(`✅ [音频播放] 停止完成, 已播放: ${elapsedTime}ms`);

    return elapsedTime;
  }

  /**
   * 播放编码后的音频数据
   */
  async playAudio(audioData: Float32Array, targetSampleRate: number = 48000): Promise<void> {
    const playStartTime = Date.now();

    // 检查是否使用 ICOM WLAN 输出
    if (this.usingIcomWlanOutput && this.icomWlanAudioAdapter) {
      console.log(`📡 [AudioStreamManager] 使用 ICOM WLAN 输出播放音频:`);
      console.log(`   样本数: ${audioData.length}`);
      console.log(`   采样率: ${targetSampleRate}Hz → 12kHz`);
      console.log(`   时长: ${(audioData.length / targetSampleRate).toFixed(2)}s`);

      try {
        // 应用音量增益
        const gainedData = new Float32Array(audioData.length);
        for (let i = 0; i < audioData.length; i++) {
          gainedData[i] = audioData[i] * this.volumeGain;
        }

        // 发送到 ICOM WLAN（内部会进行重采样）
        await this.icomWlanAudioAdapter.sendAudio(gainedData);
        console.log(`✅ [AudioStreamManager] ICOM WLAN 音频发送完成`);
      } catch (error) {
        console.error(`❌ [AudioStreamManager] ICOM WLAN 音频发送失败:`, error);
        throw error;
      }
      return;
    }

    // 传统声卡输出
    if (!this.isOutputting || !this.audioOutput) {
      throw new Error('音频输出流未启动');
    }

    // 保存播放状态
    this.playing = true;
    this.playbackStartTime = playStartTime;
    this.shouldStopPlayback = false;

    console.log(`🔊 [音频播放] 开始播放音频 (${new Date(playStartTime).toISOString()}):`);
    console.log(`   原始样本数: ${audioData.length}`);
    console.log(`   原始采样率: ${targetSampleRate}Hz`);
    console.log(`   原始时长: ${(audioData.length / targetSampleRate).toFixed(2)}s`);
    console.log(`   目标采样率: ${this.sampleRate}Hz`);
    console.log(`   音量增益: ${this.volumeGain.toFixed(2)}`);

    // 保存当前播放的Promise
    this.currentPlaybackPromise = (async () => {
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

      // 保存当前播放的音频数据（仅用于调试/查询，不再原地修改）
      this.currentAudioData = playbackData;
      this.currentSampleRate = this.sampleRate;
      
      // 分块播放，使用背压与时间节奏双重节流，避免过度预写导致无法即时停止
      const framesPerBuffer = Math.max(64, this.bufferSize || 1024); // 与 outOptions.framesPerBuffer 对齐
      const chunkSize = framesPerBuffer * this.channels; // 单声道时等于 framesPerBuffer
      const totalChunks = Math.ceil(playbackData.length / chunkSize);

      // 目标预缓冲时长，避免定时器抖动导致咔哒声（约 80~120ms）
      const prebufferMs = Math.max(60, Math.min(200, Math.round((framesPerBuffer / this.sampleRate) * 1000 * 4)));

      console.log(`🔊 [音频播放] 分块播放: ${totalChunks} 块，chunk=${chunkSize} 样本，预缓冲≈${prebufferMs}ms`);

      const chunkStartTime = Date.now();
      const hrStart = performance.now();
      let samplesWritten = 0;

      const wait = (ms: number) => new Promise<void>(res => setTimeout(res, ms));

      for (let i = 0; i < totalChunks; i++) {
        if (this.shouldStopPlayback) {
          console.log(`🛑 [音频播放] 检测到停止信号,中断播放 (已提交${i}/${totalChunks}块)`);
          throw new Error('播放已被中断');
        }

        const start = i * chunkSize;
        const end = Math.min(start + chunkSize, playbackData.length);
        const chunk = playbackData.subarray(start, end);

        // 节拍控制：确保最多领先 prebufferMs
        const elapsedMs = performance.now() - hrStart;
        const producedMs = (samplesWritten / this.sampleRate) * 1000;
        const leadMs = producedMs - elapsedMs;
        if (leadMs > prebufferMs) {
          // 过度领先，等待至窗口内
          await wait(Math.min(20, Math.max(1, Math.floor(leadMs - prebufferMs))));
        }

        // 转换为 Buffer
        const buffer = Buffer.allocUnsafe(chunk.length * 4);
        // 在写入时应用当前音量增益，避免全局原地放大导致的阻塞/中断
        const gain = this.volumeGain;
        for (let j = 0; j < chunk.length; j++) {
          const s = chunk[j] * gain;
          // 可选限幅，防止异常爆音
          const clamped = s > 1 ? 1 : (s < -1 ? -1 : s);
          buffer.writeFloatLE(clamped, j * 4);
        }

        // 背压控制：当 write 返回 false 时等待 'drain'，若无 drain 则兜底短暂等待
        const ok: boolean = this.audioOutput.write(buffer);
        if (!ok) {
          try {
            await Promise.race<unknown>([
              once(this.audioOutput, 'drain') as unknown as Promise<unknown>,
              wait(25),
            ]);
          } catch {
            // 忽略事件等待中的异常（如流被停止）
          }
        }

        samplesWritten += chunk.length;
      }

      const chunkEndTime = Date.now();
      const chunkDuration = chunkEndTime - chunkStartTime;
      console.log(`📝 [音频播放] 分块写入完成 (${new Date(chunkEndTime).toISOString()}), 耗时: ${chunkDuration}ms`);

      const playEndTime = Date.now();
      const playDuration = playEndTime - playStartTime;
      console.log(`✅ [音频播放] 播放完成 (${new Date(playEndTime).toISOString()}), 耗时: ${playDuration}ms`);

      } catch (error) {
        console.error('❌ [音频播放] 播放失败:', error);
        throw error;
      } finally {
        // 清理播放状态
        this.playing = false;
        this.currentAudioData = null;
        this.currentPlaybackPromise = null;
      }
    })();

    // 等待播放完成
    return this.currentPlaybackPromise;
  }
} 
