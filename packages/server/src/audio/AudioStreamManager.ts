import audify from 'audify';
const { RtAudio } = audify;
type RtAudioInstance = InstanceType<typeof RtAudio>;

// RtAudioFormat 是 const enum，isolatedModules 下无法直接导入，使用数值常量
const RTAUDIO_FLOAT32 = 0x10;
import { RingBufferAudioProvider } from './AudioBufferProvider.js';
import { EventEmitter } from 'eventemitter3';
import { clearResamplerCache, resampleAudioProfessional } from '../utils/audioUtils.js';
import { ConfigManager } from '../config/config-manager.js';
import { AudioDeviceManager } from './audio-device-manager.js';
import { performance } from 'node:perf_hooks';
import type { IcomWlanAudioAdapter } from './IcomWlanAudioAdapter.js';
import type { OpenWebRXAudioAdapter } from '../openwebrx/OpenWebRXAudioAdapter.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('AudioStreamManager');

export interface AudioStreamEvents {
  'audioData': (samples: Float32Array) => void;
  'error': (error: Error) => void;
  'started': () => void;
  'stopped': () => void;
}

/**
 * 音频流管理器 - 负责从音频设备捕获实时音频数据
 * 支持传统声卡（Audify/RtAudio）和 ICOM WLAN 虚拟设备
 */
export class AudioStreamManager extends EventEmitter<AudioStreamEvents> {
  private rtAudioInput: RtAudioInstance | null = null;
  private rtAudioOutput: RtAudioInstance | null = null;
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

  // OpenWebRX 音频适配器（外部注入）
  private openwebrxAudioAdapter: OpenWebRXAudioAdapter | null = null;
  private usingOpenWebRXInput = false;

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

    // 创建音频缓冲区提供者，使用统一的内部采样率（12kHz）
    const INTERNAL_SAMPLE_RATE = 12000;
    this.audioProvider = new RingBufferAudioProvider(INTERNAL_SAMPLE_RATE, INTERNAL_SAMPLE_RATE * 5); // 5秒缓冲
    logger.info('audio stream manager initialized', { sampleRate: this.sampleRate, bufferSize: this.bufferSize, internalSampleRate: INTERNAL_SAMPLE_RATE });
  }

  /**
   * 设置 ICOM WLAN 音频适配器（由 DigitalRadioEngine 注入）
   */
  setIcomWlanAudioAdapter(adapter: IcomWlanAudioAdapter | null): void {
    this.icomWlanAudioAdapter = adapter;
    logger.info(`ICOM WLAN audio adapter ${adapter ? 'set' : 'cleared'}`);
  }

  /**
   * Set OpenWebRX audio adapter (injected by EngineLifecycle)
   */
  setOpenWebRXAudioAdapter(adapter: OpenWebRXAudioAdapter | null): void {
    this.openwebrxAudioAdapter = adapter;
    logger.info(`OpenWebRX audio adapter ${adapter ? 'set' : 'cleared'}`);
  }

  /**
   * 获取采样率（供外部使用）
   */
  getSampleRate(): number {
    return this.sampleRate;
  }

  /**
   * 获取内部处理采样率（固定12kHz）
   * 用于频谱分析等内部处理模块
   */
  getInternalSampleRate(): number {
    return 12000;
  }
  
  /**
   * 启动音频流
   */
  async startStream(deviceId?: string): Promise<void> {
    if (this.isStreaming) {
      logger.warn('audio stream is already running');
      return;
    }
    
    try {
      logger.info('starting audio stream');
      
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
        logger.info('ICOM WLAN virtual input device detected');

        if (!this.icomWlanAudioAdapter) {
          // ICOM 适配器未设置时，输出警告并跳过音频流启动
          logger.warn('ICOM WLAN audio adapter not set, skipping audio stream start');

          this.deviceId = 'icom-wlan-input';
          this.usingIcomWlanInput = false;
          this.isStreaming = true;
          this.emit('started');
          return;
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
          logger.error('ICOM WLAN audio error', error);
          this.emit('error', error);
        });

        this.deviceId = 'icom-wlan-input';
        this.isStreaming = true;
        logger.info('ICOM WLAN audio input started (12kHz -> 48kHz)');
        this.emit('started');
        return;
      }

      // 检测是否为 OpenWebRX SDR 虚拟设备
      if (resolvedDeviceId?.startsWith('openwebrx-') || audioConfig.inputDeviceName?.startsWith('[SDR]')) {
        logger.info('OpenWebRX virtual input device detected');

        if (!this.openwebrxAudioAdapter) {
          logger.warn('OpenWebRX audio adapter not set, skipping audio stream start');
          this.deviceId = resolvedDeviceId || 'openwebrx-unknown';
          this.usingOpenWebRXInput = false;
          this.isStreaming = true;
          this.emit('started');
          return;
        }

        // Use OpenWebRX audio adapter
        this.usingOpenWebRXInput = true;
        this.openwebrxAudioAdapter.startReceiving();

        // Subscribe to audio data
        this.openwebrxAudioAdapter.on('audioData', (samples: Float32Array) => {
          this.audioProvider.writeAudio(samples);
          this.emit('audioData', samples);
        });

        this.openwebrxAudioAdapter.on('error', (error: Error) => {
          logger.error('OpenWebRX audio error', error);
          this.emit('error', error);
        });

        this.deviceId = resolvedDeviceId || 'openwebrx-unknown';
        this.isStreaming = true;
        logger.info('OpenWebRX audio input started (12kHz, zero resample)');
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
        logger.info('resolved audio input device', { name: audioConfig.inputDeviceName || 'default', id: actualDeviceId });
      } else {
        logger.info('using system default audio input device');
      }

      logger.info('audio input starting', {
        deviceId: actualDeviceId,
        channels: this.channels,
        sampleRate: this.sampleRate,
        frameSize: this.bufferSize,
        format: 'Float32',
      });

      // 创建和启动音频输入流（带超时保护）
      await this.createAndStartInputWithTimeout(actualDeviceId, deviceId);
      
      this.isStreaming = true;
      logger.info('audio stream started', { sampleRate: this.sampleRate, bufferSize: this.bufferSize });
      this.emit('started');

    } catch (error) {
      logger.error('failed to start audio stream', error);
      // 清理失败的输入流
      if (this.rtAudioInput) {
        try {
          this.rtAudioInput.stop();
          this.rtAudioInput.closeStream();
        } catch (cleanupError) {
          logger.error('failed to cleanup audio input stream', cleanupError);
        }
        this.rtAudioInput = null;
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
      logger.warn('audio stream is not running');
      return;
    }

    try {
      logger.info('stopping audio stream');

      // 停止 ICOM WLAN 音频输入
      if (this.usingIcomWlanInput && this.icomWlanAudioAdapter) {
        this.icomWlanAudioAdapter.stopReceiving();
        this.icomWlanAudioAdapter.removeAllListeners('audioData');
        this.icomWlanAudioAdapter.removeAllListeners('error');
        this.usingIcomWlanInput = false;
        logger.info('ICOM WLAN audio input stopped');
      }

      // 停止传统声卡输入
      if (this.rtAudioInput) {
        try {
          this.rtAudioInput.stop();
          this.rtAudioInput.closeStream();
        } catch (e) {
          logger.error('failed to cleanup audio input stream', e);
        }
        this.rtAudioInput = null;
      }

      // 清理重采样器缓存
      clearResamplerCache();

      this.isStreaming = false;
      this.deviceId = null;

      logger.info('audio stream stopped');
      this.emit('stopped');

    } catch (error) {
      logger.error('failed to stop audio stream', error);
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

    logger.info('audio config reloaded (restart required)', {
      sampleRate: `${oldSampleRate}Hz -> ${this.sampleRate}Hz`,
      bufferSize: `${oldBufferSize} -> ${this.bufferSize}`,
    });
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
        logger.warn(`buffer length is not a multiple of 4: ${buffer.length}`);
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
        logger.warn('invalid audio sample values detected, replaced with 0');
      }

      return samples;
    } catch (error) {
      logger.error('buffer conversion error', error);
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
      logger.warn('audio output is already running');
      return;
    }

    try {
      logger.info('starting audio output');
      
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
        logger.info('ICOM WLAN virtual output device detected');

        if (!this.icomWlanAudioAdapter) {
          // ICOM 适配器未设置时，回退到默认声卡而不是抛出错误
          logger.warn('ICOM WLAN audio adapter not set, falling back to default audio device');
          // 清除虚拟设备 ID，让后续代码使用传统声卡模式
          resolvedOutputDeviceId = undefined;
          actualOutputDeviceId = undefined;
          // 继续执行传统声卡初始化逻辑，不 return
        } else {
          // 标记使用 ICOM WLAN 输出
          this.usingIcomWlanOutput = true;
          this.outputDeviceId = 'icom-wlan-output';
          this.isOutputting = true;
          logger.info('ICOM WLAN audio output started (48kHz -> 12kHz)');
          return;
        }
      }

      // 传统声卡模式：解析设备ID
      if (resolvedOutputDeviceId) {
        if (resolvedOutputDeviceId.startsWith('output-')) {
          actualOutputDeviceId = parseInt(resolvedOutputDeviceId.replace('output-', ''));
        } else if (!isNaN(parseInt(resolvedOutputDeviceId))) {
          actualOutputDeviceId = parseInt(resolvedOutputDeviceId);
        }
        logger.info('resolved audio output device', { name: audioConfig.outputDeviceName || 'default', id: actualOutputDeviceId });
      } else {
        logger.info('using system default audio output device');
      }

      logger.info('audio output starting', {
        deviceId: actualOutputDeviceId,
        channels: this.channels,
        sampleRate: this.sampleRate,
        frameSize: this.bufferSize,
        format: 'Float32',
      });

      await this.createAndStartOutputWithTimeout(actualOutputDeviceId, outputDeviceId);

      this.isOutputting = true;
      logger.info('audio output started', { sampleRate: this.sampleRate });

    } catch (error) {
      logger.error('failed to start audio output', error);
      // 清理失败的输出流
      if (this.rtAudioOutput) {
        try {
          this.rtAudioOutput.stop();
          this.rtAudioOutput.closeStream();
        } catch (cleanupError) {
          logger.error('failed to cleanup audio output stream', cleanupError);
        }
        this.rtAudioOutput = null;
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
  private async createAndStartInputWithTimeout(actualDeviceId: number | undefined, deviceId?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        logger.error('audio input create/start timed out (15s)');
        reject(new Error('audio input create/start timed out'));
      }, 15000);

      try {
        setImmediate(() => {
          try {
            logger.info('creating audio input stream (Audify/RtAudio)');

            this.rtAudioInput = new RtAudio();

            // 验证设备能力
            if (actualDeviceId !== undefined) {
              const allDevices = this.rtAudioInput.getDevices();
              const targetDevice = allDevices.find((d: any) => d.id === actualDeviceId);
              if (targetDevice && targetDevice.inputChannels < (this.channels || 1)) {
                throw new Error(
                  `Input device "${targetDevice.name}" (ID ${actualDeviceId}) does not support ${this.channels} channel input` +
                  ` (available input channels: ${targetDevice.inputChannels}). Please select the correct audio input device in settings.`
                );
              }
            }

            // 确定设备 ID
            const inputDeviceId = actualDeviceId ?? this.rtAudioInput.getDefaultInputDevice();

            // 打开输入流（回调式 API）
            this.rtAudioInput.openStream(
              null, // 无输出
              { deviceId: inputDeviceId, nChannels: this.channels, firstChannel: 0 },
              RTAUDIO_FLOAT32,
              this.sampleRate,
              this.bufferSize,
              'TX5DR-Input',
              (pcm: Buffer) => {
                // 音频数据回调 — 替代原来的 on('data') 事件
                try {
                  if (!pcm || pcm.length === 0) return;
                  if (pcm.length % 4 !== 0) {
                    logger.warn(`audio data length is not a multiple of 4: ${pcm.length}`);
                    return;
                  }

                  let samples = this.convertBufferToFloat32(pcm);
                  if (samples.length === 0) return;

                  const INTERNAL_SAMPLE_RATE = 12000;
                  if (this.sampleRate !== INTERNAL_SAMPLE_RATE) {
                    resampleAudioProfessional(
                      samples,
                      this.sampleRate,
                      INTERNAL_SAMPLE_RATE,
                      1
                    ).then((resampled) => {
                      this.audioProvider.writeAudio(resampled);
                      this.emit('audioData', resampled);
                    }).catch((error) => {
                      logger.error('audio resample error', error);
                      this.emit('error', error as Error);
                    });
                  } else {
                    this.audioProvider.writeAudio(samples);
                    this.emit('audioData', samples);
                  }
                } catch (error) {
                  logger.error('audio data processing error', error);
                  this.emit('error', error as Error);
                }
              },
              null // frameOutputCallback
            );

            logger.info('audio input stream created');
            this.deviceId = deviceId || 'default';

            logger.info('starting audio input stream');
            this.rtAudioInput.start();

            logger.info('audio input stream started');
            clearTimeout(timeout);
            resolve();

          } catch (error) {
            logger.error('audio input create/start failed', error);
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
  private async createAndStartOutputWithTimeout(actualOutputDeviceId: number | undefined, outputDeviceId?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        logger.error('audio output create/start timed out (15s)');
        reject(new Error('audio output create/start timed out'));
      }, 15000);

      try {
        setImmediate(() => {
          try {
            logger.info('creating audio output stream (Audify/RtAudio)');

            this.rtAudioOutput = new RtAudio();

            const outputId = actualOutputDeviceId ?? this.rtAudioOutput.getDefaultOutputDevice();

            this.rtAudioOutput.openStream(
              { deviceId: outputId, nChannels: this.channels, firstChannel: 0 },
              null, // 无输入
              RTAUDIO_FLOAT32,
              this.sampleRate,
              this.bufferSize,
              'TX5DR-Output',
              null, // 纯输出，无输入回调
              null  // frameOutputCallback
            );

            logger.info('audio output stream created');
            this.outputDeviceId = outputDeviceId || 'default';

            logger.info('starting audio output stream');
            this.rtAudioOutput.start();

            logger.info('audio output stream started');
            clearTimeout(timeout);
            resolve();

          } catch (error) {
            logger.error('audio output create/start failed', error);
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
      logger.warn('audio output is not running');
      return;
    }

    try {
      logger.info('stopping audio output');

      // ICOM WLAN 输出只需要清除标志，不需要额外操作
      if (this.usingIcomWlanOutput) {
        this.usingIcomWlanOutput = false;
        logger.info('ICOM WLAN audio output stopped');
      }

      // 停止传统声卡输出
      if (this.rtAudioOutput) {
        try {
          this.rtAudioOutput.stop();
          this.rtAudioOutput.closeStream();
        } catch (e) {
          logger.error('failed to cleanup audio output stream', e);
        }
        this.rtAudioOutput = null;
      }

      this.isOutputting = false;
      this.outputDeviceId = null;

      logger.info('audio output stopped');

    } catch (error) {
      logger.error('failed to stop audio output', error);
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
    
    logger.info('volume gain set', { db: this.volumeGainDb.toFixed(1), linear: this.volumeGain.toFixed(3) });
  }

  /**
   * 设置音量增益（线性单位，向后兼容）
   * @param gain 增益值（0.001 - 10.0）
   */
  setVolumeGain(gain: number): void {
    // 限制增益范围
    this.volumeGain = Math.max(0.001, Math.min(10.0, gain));
    this.volumeGainDb = this.gainToDb(this.volumeGain);
    
    logger.info('volume gain set', { linear: this.volumeGain.toFixed(3), db: this.volumeGainDb.toFixed(1) });
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
      logger.debug('no audio currently playing');
      return 0;
    }

    const now = Date.now();
    const elapsedTime = now - this.playbackStartTime;

    logger.debug(`stopping current playback, elapsed: ${elapsedTime}ms`);

    // 设置停止标志,让播放循环自动退出
    this.shouldStopPlayback = true;

    // 等待当前播放完全停止
    if (this.currentPlaybackPromise) {
      try {
        await this.currentPlaybackPromise;
      } catch (error) {
        // 播放被中断是预期的行为
        logger.debug('playback interrupted');
      }
    }

    this.playing = false;
    this.shouldStopPlayback = false;
    this.currentPlaybackPromise = null;

    logger.debug(`playback stopped, elapsed: ${elapsedTime}ms`);

    return elapsedTime;
  }

  /**
   * 播放编码后的音频数据
   */
  async playAudio(audioData: Float32Array, targetSampleRate: number = 48000): Promise<void> {
    const playStartTime = Date.now();

    // 检查是否使用 ICOM WLAN 输出（零重采样优化）
    if (this.usingIcomWlanOutput && this.icomWlanAudioAdapter) {
      logger.info('playing audio via ICOM WLAN output (zero-resample)', {
        samples: audioData.length,
        sampleRate: targetSampleRate,
        duration: `${(audioData.length / targetSampleRate).toFixed(2)}s`,
        volumeGain: this.volumeGain.toFixed(2),
      });

      // 设置播放状态
      this.playing = true;
      this.playbackStartTime = playStartTime;
      this.shouldStopPlayback = false;

      try {
        // 分块发送音频，支持实时音量调整
        // 块大小：1200样本（≈100ms @ 12kHz），与普通声卡路径保持一致的响应速度
        const chunkSize = 1200;
        const totalChunks = Math.ceil(audioData.length / chunkSize);

        logger.debug(`ICOM WLAN chunked send: ${totalChunks} chunks, chunkSize=${chunkSize}`);

        const chunkStartTime = Date.now();
        const hrStart = performance.now();
        let samplesWritten = 0;

        const wait = (ms: number) => new Promise<void>(res => setTimeout(res, ms));

        for (let i = 0; i < totalChunks; i++) {
          // 检查是否需要停止播放
          if (this.shouldStopPlayback) {
            logger.debug(`ICOM WLAN stop signal received, aborting playback (sent ${i}/${totalChunks} chunks)`);
            throw new Error('playback interrupted');
          }

          const start = i * chunkSize;
          const end = Math.min(start + chunkSize, audioData.length);
          const sourceChunk = audioData.subarray(start, end);

          // 应用当前音量增益（每个chunk读取最新值，支持实时调整）
          const chunk = new Float32Array(sourceChunk.length);
          const gain = this.volumeGain;
          for (let j = 0; j < sourceChunk.length; j++) {
            const s = sourceChunk[j] * gain;
            // 限幅保护，防止异常爆音
            chunk[j] = s > 1 ? 1 : (s < -1 ? -1 : s);
          }

          // 节奏控制：确保按照实际播放速度发送，避免过度领先
          const elapsedMs = performance.now() - hrStart;
          const producedMs = (samplesWritten / targetSampleRate) * 1000;
          const leadMs = producedMs - elapsedMs;

          // 如果领先超过100ms，等待至合理窗口内
          if (leadMs > 100) {
            await wait(Math.min(20, Math.max(1, Math.floor(leadMs - 50))));
          }

          // 发送音频数据
          await this.icomWlanAudioAdapter.sendAudio(chunk);

          samplesWritten += chunk.length;
        }

        const chunkEndTime = Date.now();
        const chunkDuration = chunkEndTime - chunkStartTime;
        logger.info(`ICOM WLAN audio send complete, duration: ${chunkDuration}ms`);

      } catch (error) {
        logger.error('ICOM WLAN audio send failed', error);
        throw error;
      } finally {
        // 清理播放状态
        this.playing = false;
        this.currentAudioData = null;
        this.currentSampleRate = 0;
      }
      return;
    }

    // 传统声卡输出
    if (!this.isOutputting || !this.rtAudioOutput) {
      throw new Error('audio output stream not started');
    }

    // 保存播放状态
    this.playing = true;
    this.playbackStartTime = playStartTime;
    this.shouldStopPlayback = false;

    logger.info('starting audio playback', {
      startTime: new Date(playStartTime).toISOString(),
      samples: audioData.length,
      sourceSampleRate: targetSampleRate,
      duration: `${(audioData.length / targetSampleRate).toFixed(2)}s`,
      targetSampleRate: this.sampleRate,
      volumeGain: this.volumeGain.toFixed(2),
    });

    // 保存当前播放的Promise
    this.currentPlaybackPromise = (async () => {
      try {
      let playbackData: Float32Array;

      // 检查是否需要重采样（12kHz → 设备采样率）
      if (targetSampleRate !== this.sampleRate) {
        logger.debug(`resampling for playback: ${targetSampleRate}Hz -> ${this.sampleRate}Hz`);
        playbackData = await resampleAudioProfessional(
          audioData,
          targetSampleRate,
          this.sampleRate,
          1 // 单声道
        );
        logger.debug(`resample complete: ${audioData.length} -> ${playbackData.length} samples`);
      } else {
        logger.debug('sample rate matches, no resample needed');
        playbackData = audioData;
      }

      // 保存当前播放的音频数据（仅用于调试/查询，不再原地修改）
      this.currentAudioData = playbackData;
      this.currentSampleRate = this.sampleRate;
      
      // 分块播放，使用 setInterval 高频轮询 + 追赶写入
      // 相比链式 await setTimeout，setInterval 在事件循环延迟后能立即追赶
      const TICK_MS = 5;
      const framesPerBuffer = Math.max(64, this.bufferSize || 1024);
      const chunkSize = framesPerBuffer * this.channels;
      const totalChunks = Math.ceil(playbackData.length / chunkSize);

      // 预缓冲目标（~85ms），控制延迟的同时避免 underrun
      const prebufferMs = Math.max(60, Math.min(200, Math.round((framesPerBuffer / this.sampleRate) * 1000 * 4)));
      const prebufferSamples = Math.ceil((prebufferMs / 1000) * this.sampleRate);

      logger.debug(`chunked playback: ${totalChunks} chunks, chunkSize=${chunkSize}, prebuffer~${prebufferMs}ms, tick=${TICK_MS}ms`);

      const chunkStartTime = Date.now();

      // setInterval-based playback loop wrapped in a Promise
      await new Promise<void>((resolve, reject) => {
        const hrStart = performance.now();
        let cursor = 0;
        let samplesWritten = 0;

        const writeChunk = (idx: number): boolean => {
          if (!this.rtAudioOutput) {
            return false;
          }
          try {
            const start = idx * chunkSize;
            const end = Math.min(start + chunkSize, playbackData.length);
            const chunk = playbackData.subarray(start, end);
            // Apply gain at write time so volume changes take effect immediately
            const gain = this.volumeGain;
            const buffer = Buffer.allocUnsafe(chunk.length * 4);
            for (let j = 0; j < chunk.length; j++) {
              const s = chunk[j] * gain;
              buffer.writeFloatLE(s > 1 ? 1 : (s < -1 ? -1 : s), j * 4);
            }
            this.rtAudioOutput.write(buffer);
            samplesWritten += chunk.length;
            return true;
          } catch {
            // write failed (e.g. buffer full), skip this tick
            return false;
          }
        };

        const interval = setInterval(() => {
          try {
            // Check stop signal
            if (this.shouldStopPlayback) {
              clearInterval(interval);
              logger.debug(`stop signal received, aborting playback (submitted ${cursor}/${totalChunks} chunks)`);
              reject(new Error('playback interrupted'));
              return;
            }

            // Check completion
            if (cursor >= totalChunks) {
              clearInterval(interval);
              const chunkDuration = Date.now() - chunkStartTime;
              logger.debug(`chunked write complete, duration: ${chunkDuration}ms`);
              const playDuration = Date.now() - playStartTime;
              logger.info(`playback complete, duration: ${playDuration}ms`);
              resolve();
              return;
            }

            // Calculate target: how many samples should have been written by now + prebuffer
            const elapsedMs = performance.now() - hrStart;
            const targetSamples = Math.floor((elapsedMs / 1000) * this.sampleRate) + prebufferSamples;

            // Catch-up write: write multiple chunks in one tick if behind schedule
            while (cursor < totalChunks && samplesWritten < targetSamples) {
              if (this.shouldStopPlayback) break;
              if (!writeChunk(cursor)) break;
              cursor++;
            }
          } catch (err) {
            clearInterval(interval);
            reject(err);
          }
        }, TICK_MS);
      });

      } catch (error) {
        logger.error('audio playback failed', error);
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

  /**
   * Stream voice audio frames for real-time playback.
   * Unlike playAudio() which plays a complete FT8 audio clip,
   * this method accepts small PCM frames (e.g. 20ms Opus decoded)
   * and writes them directly to the output device with minimal latency.
   *
   * @param pcmData PCM audio data (Float32Array, -1.0 to 1.0)
   * @param frameSampleRate Sample rate of the input data (typically 48000)
   */
  /** Accumulation buffer for voice audio frames (adapts Opus frame size to RtAudio buffer size) */
  private voiceAccumBuffer: Float32Array = new Float32Array(0);

  playVoiceAudio(pcmData: Float32Array, frameSampleRate: number): void {
    // ICOM WLAN output path
    if (this.usingIcomWlanOutput && this.icomWlanAudioAdapter) {
      const gain = this.volumeGain;
      const processed = new Float32Array(pcmData.length);
      for (let i = 0; i < pcmData.length; i++) {
        const s = pcmData[i] * gain;
        processed[i] = s > 1 ? 1 : (s < -1 ? -1 : s);
      }
      this.icomWlanAudioAdapter.sendAudio(processed).catch((err) => {
        logger.error('Voice audio ICOM WLAN send failed', err);
      });
      return;
    }

    // RtAudio output path
    if (!this.isOutputting || !this.rtAudioOutput) {
      return;
    }

    if (frameSampleRate !== this.sampleRate) {
      logger.warn(`Voice audio sample rate mismatch: ${frameSampleRate} vs device ${this.sampleRate}, dropping frame`);
      return;
    }

    // Accumulate incoming samples (Opus frame = 960 samples, RtAudio buffer = bufferSize samples)
    const newBuf = new Float32Array(this.voiceAccumBuffer.length + pcmData.length);
    newBuf.set(this.voiceAccumBuffer);
    newBuf.set(pcmData, this.voiceAccumBuffer.length);
    this.voiceAccumBuffer = newBuf;

    // Write complete bufferSize chunks to RtAudio
    const gain = this.volumeGain;
    while (this.voiceAccumBuffer.length >= this.bufferSize) {
      const chunk = this.voiceAccumBuffer.subarray(0, this.bufferSize);
      this.voiceAccumBuffer = this.voiceAccumBuffer.slice(this.bufferSize);

      const buffer = Buffer.allocUnsafe(this.bufferSize * 4);
      for (let i = 0; i < this.bufferSize; i++) {
        const s = chunk[i] * gain;
        const clamped = s > 1 ? 1 : (s < -1 ? -1 : s);
        buffer.writeFloatLE(clamped, i * 4);
      }

      try {
        this.rtAudioOutput.write(buffer);
      } catch {
        // Buffer full or device error - drop frame silently
      }
    }
  }
} 
