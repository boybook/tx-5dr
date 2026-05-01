import audify from 'audify';
const { RtAudio } = audify;
type RtAudioInstance = InstanceType<typeof RtAudio>;

// RtAudioFormat/RtAudioApi 是 const enum，isolatedModules 下无法直接导入，使用数值常量
const RTAUDIO_FLOAT32 = 0x10;
const RTAUDIO_API_UNSPECIFIED = 0;
const RTAUDIO_API_WINDOWS_WASAPI = 7;
import { RingBufferAudioProvider } from './AudioBufferProvider.js';
import { EventEmitter } from 'eventemitter3';
import { clearResamplerCache, resampleAudioProfessional } from '../utils/audioUtils.js';
import { ConfigManager } from '../config/config-manager.js';
import { AudioDeviceManager } from './audio-device-manager.js';
import { performance } from 'node:perf_hooks';
import type { IcomWlanAudioAdapter } from './IcomWlanAudioAdapter.js';
import type { OpenWebRXAudioAdapter } from '../openwebrx/OpenWebRXAudioAdapter.js';
import { createLogger } from '../utils/logger.js';
import type { VoiceTxFrameMeta, VoiceTxProcessedFrameStats } from '../voice/VoiceTxDiagnostics.js';
import { RadioError, RadioErrorCode, RadioErrorSeverity } from '../utils/errors/RadioError.js';
import { VoiceTxOutputPipeline, type VoiceTxOutputSinkState } from './VoiceTxOutputPipeline.js';

const logger = createLogger('AudioStreamManager');
const INTERNAL_SAMPLE_RATE = 12000;
const ICOM_WLAN_TX_CHUNK_SIZE = 1200;
const ICOM_WLAN_TX_TARGET_BUFFER_LEAD_MS = 150;
const ICOM_WLAN_TX_MAX_WAIT_SLICE_MS = 20;

export type NativeAudioInputSourceKind = 'audio-device' | 'icom-wlan';

export interface NativeAudioInputFrame {
  samples: Float32Array;
  sampleRate: number;
  channels: number;
  timestamp: number;
  sequence: number;
  sourceKind: NativeAudioInputSourceKind;
}

export interface AudioStreamEvents {
  'audioData': (samples: Float32Array) => void;
  'nativeAudioInputData': (frame: NativeAudioInputFrame) => void;
  'txMonitorAudioData': (data: { samples: Float32Array; sampleRate: number }) => void;
  'error': (error: Error) => void;
  'started': () => void;
  'stopped': () => void;
}

export interface VoiceTxOutputObserver {
  onFrameEnqueued?: (data: {
    meta: VoiceTxFrameMeta;
    queueDepthFrames: number;
    queuedAudioMs: number;
  }) => void;
  onFrameDropped?: (data: {
    meta: VoiceTxFrameMeta;
    queueDepthFrames: number;
    queuedAudioMs: number;
    reason: 'backpressure' | 'output-unavailable' | 'stale' | 'jitter-trim';
  }) => void;
  onFrameProcessed?: (data: VoiceTxProcessedFrameStats) => void;
  onWriteFailure?: (data: {
    meta: VoiceTxFrameMeta;
    queueDepthFrames: number;
    queuedAudioMs: number;
  }) => void;
}

interface RtAudioDeviceDescriptor {
  id: number;
  name: string;
  inputChannels?: number;
  outputChannels?: number;
}

interface ResolvedStreamDevice {
  actualDeviceId: number;
  persistedDeviceId: string;
}

export interface PlayAudioOptions {
  /**
   * Mirrors the audio chunks written to the TX output into the monitor broadcast
   * side path. This is intentionally opt-in: normal RX monitor, spectrum, and
   * decoding must continue to use the physical input ring buffer only.
   */
  injectIntoMonitor?: boolean;
  playbackKind?: PlaybackKind;
}

export type PlaybackKind = 'digital' | 'voice-keyer' | 'tune-tone';

export interface StopPlaybackOptions {
  kind?: PlaybackKind;
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
  private volumeGain: number = Math.pow(10, -10 / 20); // 默认 -10dB
  private volumeGainDb: number = -10; // 以dB为单位的增益值
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
  private currentPlaybackKind: PlaybackKind | null = null;
  private shouldStopPlayback: boolean = false;  // 停止播放标志
  private voiceOutputObserver: VoiceTxOutputObserver | null = null;
  private voiceTxOutputPipeline: VoiceTxOutputPipeline;
  private nativeAudioInputSequence = 0;

  constructor() {
    super();

    // 从配置管理器获取音频设置
    const configManager = ConfigManager.getInstance();
    const audioConfig = configManager.getAudioConfig();

    this.sampleRate = audioConfig.sampleRate || 48000;
    this.bufferSize = audioConfig.bufferSize || 1024;
    this.currentSampleRate = this.sampleRate;

    // 创建音频缓冲区提供者，使用统一的内部采样率（12kHz）
    this.audioProvider = new RingBufferAudioProvider(INTERNAL_SAMPLE_RATE, INTERNAL_SAMPLE_RATE * 5); // 5秒缓冲
    this.voiceTxOutputPipeline = new VoiceTxOutputPipeline({
      getSinkState: () => this.getVoiceTxOutputSinkState(),
      getObserver: () => this.voiceOutputObserver,
      getVolumeGain: () => this.volumeGain,
      writeOutputChunk: (samples, sink) => this.writeVoiceTxOutputChunk(samples, sink),
    });
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
      const configuredInputDeviceName = audioConfig.inputDeviceName;
      
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
          this.emitNativeAudioInputData(samples, this.icomWlanAudioAdapter?.getSampleRate() ?? INTERNAL_SAMPLE_RATE, 'icom-wlan');
          this.audioProvider.writeAudio(samples);
          this.emit('audioData', samples);
        });

        this.icomWlanAudioAdapter.on('error', (error: Error) => {
          logger.error('ICOM WLAN audio error', error);
          this.emit('error', error);
        });

        this.deviceId = 'icom-wlan-input';
        this.isStreaming = true;
        logger.info('ICOM WLAN audio input started (native 12kHz)');
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
      await this.createAndStartInputWithTimeout(actualDeviceId, resolvedDeviceId ?? deviceId, configuredInputDeviceName);
      
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
      const configuredOutputDeviceName = audioConfig.outputDeviceName;
      
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

      await this.createAndStartOutputWithTimeout(actualOutputDeviceId, resolvedOutputDeviceId ?? outputDeviceId, configuredOutputDeviceName);

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
  private async createAndStartInputWithTimeout(
    actualDeviceId: number | undefined,
    deviceId?: string,
    configuredDeviceName?: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        logger.error('audio input create/start timed out (15s)');
        reject(new Error('audio input create/start timed out'));
      }, 15000);

      try {
        setImmediate(() => {
          void (async () => {
            try {
            logger.info('creating audio input stream (Audify/RtAudio)');

            const inputApi = process.platform === 'win32' ? RTAUDIO_API_WINDOWS_WASAPI : RTAUDIO_API_UNSPECIFIED;
            this.rtAudioInput = new RtAudio(inputApi);
            let resolvedDevice = await this.resolveCurrentStreamDevice({
              rtAudio: this.rtAudioInput,
              direction: 'input',
              configuredDeviceName,
              requestedDeviceId: deviceId,
              actualDeviceId,
            });

            // 打开输入流（回调式 API）
            try {
              this.openInputStream(resolvedDevice.actualDeviceId);
            } catch (error) {
              if (!configuredDeviceName || !this.isInvalidDeviceIdError(error)) {
                throw error;
              }

              logger.warn('Audio input stream failed with stale device ID, retrying after rebinding', {
                deviceName: configuredDeviceName,
                previousDeviceId: resolvedDevice.actualDeviceId,
              });

              this.rtAudioInput = new RtAudio(inputApi);
              resolvedDevice = await this.resolveCurrentStreamDevice({
                rtAudio: this.rtAudioInput,
                direction: 'input',
                configuredDeviceName,
                requestedDeviceId: deviceId,
                actualDeviceId: undefined,
              });
              this.openInputStream(resolvedDevice.actualDeviceId);
            }

            logger.info('audio input stream created');
            this.deviceId = resolvedDevice.persistedDeviceId;

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
          })();
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
  private async createAndStartOutputWithTimeout(
    actualOutputDeviceId: number | undefined,
    outputDeviceId?: string,
    configuredDeviceName?: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        logger.error('audio output create/start timed out (15s)');
        reject(new Error('audio output create/start timed out'));
      }, 15000);

      try {
        setImmediate(() => {
          void (async () => {
            try {
            logger.info('creating audio output stream (Audify/RtAudio)');

            const outputApi = process.platform === 'win32' ? RTAUDIO_API_WINDOWS_WASAPI : RTAUDIO_API_UNSPECIFIED;
            this.rtAudioOutput = new RtAudio(outputApi);
            let resolvedDevice = await this.resolveCurrentStreamDevice({
              rtAudio: this.rtAudioOutput,
              direction: 'output',
              configuredDeviceName,
              requestedDeviceId: outputDeviceId,
              actualDeviceId: actualOutputDeviceId,
            });

            try {
              this.openOutputStream(resolvedDevice.actualDeviceId);
            } catch (error) {
              if (!configuredDeviceName || !this.isInvalidDeviceIdError(error)) {
                throw error;
              }

              logger.warn('Audio output stream failed with stale device ID, retrying after rebinding', {
                deviceName: configuredDeviceName,
                previousDeviceId: resolvedDevice.actualDeviceId,
              });

              this.rtAudioOutput = new RtAudio(outputApi);
              resolvedDevice = await this.resolveCurrentStreamDevice({
                rtAudio: this.rtAudioOutput,
                direction: 'output',
                configuredDeviceName,
                requestedDeviceId: outputDeviceId,
                actualDeviceId: undefined,
              });
              this.openOutputStream(resolvedDevice.actualDeviceId);
            }

            logger.info('audio output stream created');
            this.outputDeviceId = resolvedDevice.persistedDeviceId;

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
          })();
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
      this.clearVoicePlaybackQueue();

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

  private parseNumericDeviceId(deviceId?: string): number | undefined {
    if (!deviceId) {
      return undefined;
    }

    if (deviceId.startsWith('input-')) {
      const parsed = Number.parseInt(deviceId.replace('input-', ''), 10);
      return Number.isNaN(parsed) ? undefined : parsed;
    }

    if (deviceId.startsWith('output-')) {
      const parsed = Number.parseInt(deviceId.replace('output-', ''), 10);
      return Number.isNaN(parsed) ? undefined : parsed;
    }

    const parsed = Number.parseInt(deviceId, 10);
    return Number.isNaN(parsed) ? undefined : parsed;
  }

  private isInvalidDeviceIdError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    return error.message.toLowerCase().includes('device id is invalid');
  }

  private async resolveCurrentStreamDevice(options: {
    rtAudio: RtAudioInstance;
    direction: 'input' | 'output';
    configuredDeviceName?: string;
    requestedDeviceId?: string;
    actualDeviceId?: number;
  }): Promise<ResolvedStreamDevice> {
    const {
      rtAudio,
      direction,
      configuredDeviceName,
      requestedDeviceId,
      actualDeviceId,
    } = options;

    const devices = rtAudio.getDevices() as RtAudioDeviceDescriptor[];
    const channelKey = direction === 'input' ? 'inputChannels' : 'outputChannels';
    const availableDevices = devices.filter((device) => (device[channelKey] || 0) > 0);
    const targetDevice = actualDeviceId === undefined
      ? undefined
      : availableDevices.find((device) => device.id === actualDeviceId);

    if (targetDevice) {
      const channelCount = targetDevice[channelKey] || 0;
      if (channelCount < (this.channels || 1)) {
        throw new Error(
          `${direction === 'input' ? 'Input' : 'Output'} device "${targetDevice.name}" (ID ${actualDeviceId}) does not support ${this.channels} channel ${direction}` +
          ` (available ${direction} channels: ${channelCount}). Please select the correct audio ${direction} device in settings.`
        );
      }

      return {
        actualDeviceId: actualDeviceId as number,
        persistedDeviceId: requestedDeviceId || `${direction}-${actualDeviceId}`,
      };
    }

    if (actualDeviceId !== undefined) {
      logger.warn(`Configured audio ${direction} device ID is missing from current RtAudio enumeration`, {
        deviceName: configuredDeviceName || 'default',
        previousDeviceId: actualDeviceId,
        availableDeviceNames: availableDevices.map((device) => device.name),
      });
    }

    if (configuredDeviceName) {
      const audioDeviceManager = AudioDeviceManager.getInstance();
      const reboundDevice = direction === 'input'
        ? await audioDeviceManager.getInputDeviceByName(configuredDeviceName)
        : await audioDeviceManager.getOutputDeviceByName(configuredDeviceName);

      const reboundNumericId = this.parseNumericDeviceId(reboundDevice?.id);
      if (reboundDevice && reboundNumericId !== undefined) {
        logger.info(`Rebound audio ${direction} device after refresh`, {
          deviceName: configuredDeviceName,
          previousDeviceId: actualDeviceId,
          currentDeviceId: reboundNumericId,
        });

        return {
          actualDeviceId: reboundNumericId,
          persistedDeviceId: reboundDevice.id,
        };
      }

      throw new RadioError({
        code: RadioErrorCode.DEVICE_NOT_FOUND,
        message: `Configured audio ${direction} device "${configuredDeviceName}" is temporarily unavailable after USB reconnect`,
        userMessage: `Configured audio ${direction} device "${configuredDeviceName}" is temporarily unavailable. The system will keep retrying automatically when reconnect is active.`,
        userMessageKey: direction === 'input'
          ? 'radio:audioSidecar.errorInputDeviceUnavailable'
          : 'radio:audioSidecar.errorOutputDeviceUnavailable',
        userMessageParams: { deviceName: configuredDeviceName },
        severity: RadioErrorSeverity.ERROR,
        suggestions: [
          'Reconnect the USB audio device and wait for the operating system to finish re-enumerating it',
          'Check the audio device list to confirm the configured device name appears again',
          'Keep the current profile selected so automatic reconnect can retry',
        ],
        context: {
          deviceName: configuredDeviceName,
          direction,
          previousDeviceId: actualDeviceId,
          temporaryUnavailable: true,
          recoverable: true,
          availableDeviceNames: availableDevices.map((device) => device.name),
        },
      });
    }

    const fallbackDeviceId = direction === 'input'
      ? rtAudio.getDefaultInputDevice()
      : rtAudio.getDefaultOutputDevice();

    logger.info(`Using default audio ${direction} device`, {
      deviceId: fallbackDeviceId,
      reason: actualDeviceId === undefined ? 'no configured device' : 'configured device id missing and no device name available',
    });

    return {
      actualDeviceId: fallbackDeviceId,
      persistedDeviceId: requestedDeviceId || 'default',
    };
  }

  private openInputStream(inputDeviceId: number): void {
    if (!this.rtAudioInput) {
      throw new Error('audio input instance not initialized');
    }

    this.rtAudioInput.openStream(
      null,
      { deviceId: inputDeviceId, nChannels: this.channels, firstChannel: 0 },
      RTAUDIO_FLOAT32,
      this.sampleRate,
      this.bufferSize,
      'TX5DR-Input',
      (pcm: Buffer) => {
        try {
          if (!pcm || pcm.length === 0) return;
          if (pcm.length % 4 !== 0) {
            logger.warn(`audio data length is not a multiple of 4: ${pcm.length}`);
            return;
          }

          const samples = this.convertBufferToFloat32(pcm);
          if (samples.length === 0) return;
          this.emitNativeAudioInputData(samples, this.sampleRate, 'audio-device');

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
      null
    );
  }

  private emitNativeAudioInputData(
    samples: Float32Array,
    sampleRate: number,
    sourceKind: NativeAudioInputSourceKind,
  ): void {
    if (this.listenerCount('nativeAudioInputData') === 0 || samples.length === 0) {
      return;
    }

    this.emit('nativeAudioInputData', {
      samples: new Float32Array(samples),
      sampleRate,
      channels: this.channels,
      timestamp: Date.now(),
      sequence: this.nativeAudioInputSequence++,
      sourceKind,
    });
  }

  private openOutputStream(outputDeviceId: number): void {
    if (!this.rtAudioOutput) {
      throw new Error('audio output instance not initialized');
    }

    this.rtAudioOutput.openStream(
      { deviceId: outputDeviceId, nChannels: this.channels, firstChannel: 0 },
      null,
      RTAUDIO_FLOAT32,
      this.sampleRate,
      this.bufferSize,
      'TX5DR-Output',
      null,
      null
    );
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

  setVoiceOutputObserver(observer: VoiceTxOutputObserver | null): void {
    this.voiceOutputObserver = observer;
  }

  clearVoicePlaybackQueue(): void {
    this.voiceTxOutputPipeline.clear();
  }

  setVoiceTxOutputEnabled(enabled: boolean): void {
    this.voiceTxOutputPipeline.setOutputEnabled(enabled);
  }

  /**
   * 检查是否正在播放音频
   * @returns 是否正在播放
   */
  public isPlaying(kind?: PlaybackKind): boolean {
    return this.playing && (!kind || this.currentPlaybackKind === kind);
  }

  public getCurrentPlaybackKind(): PlaybackKind | null {
    return this.playing ? this.currentPlaybackKind : null;
  }

  /**
   * 停止当前正在播放的音频（用于重新混音）
   * @returns 已播放的时间(ms)
   */
  public async stopCurrentPlayback(options: StopPlaybackOptions = {}): Promise<number> {
    if (!this.playing) {
      logger.debug('no audio currently playing');
      return 0;
    }

    if (options.kind && this.currentPlaybackKind !== options.kind) {
      logger.debug(`current playback kind is ${this.currentPlaybackKind ?? 'unknown'}, skip stop for ${options.kind}`);
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
    this.currentPlaybackKind = null;

    logger.debug(`playback stopped, elapsed: ${elapsedTime}ms`);

    return elapsedTime;
  }

  /**
   * 播放编码后的音频数据
   */
  async playAudio(audioData: Float32Array, targetSampleRate: number = 48000, options: PlayAudioOptions = {}): Promise<void> {
    const playStartTime = Date.now();
    const playbackKind = options.playbackKind ?? 'digital';

    // 检查是否使用 ICOM WLAN 输出（零重采样优化）
    if (this.usingIcomWlanOutput && this.icomWlanAudioAdapter) {
      const icomWlanAudioAdapter = this.icomWlanAudioAdapter;
      logger.info('playing audio via ICOM WLAN output (zero-resample)', {
        samples: audioData.length,
        sampleRate: targetSampleRate,
        duration: `${(audioData.length / targetSampleRate).toFixed(2)}s`,
        volumeGain: this.volumeGain.toFixed(2),
      });

      // 设置播放状态
      this.playing = true;
      this.playbackStartTime = playStartTime;
      this.currentPlaybackKind = playbackKind;
      this.shouldStopPlayback = false;

      const playbackPromise = (async () => {
        // 分块发送音频，支持实时音量调整
        // 块大小：1200样本（≈100ms @ 12kHz），并维持少量预缓冲避免 ICOM 侧 underrun。
        const chunkSize = ICOM_WLAN_TX_CHUNK_SIZE;
        const totalChunks = Math.ceil(audioData.length / chunkSize);

        logger.debug(`ICOM WLAN chunked send: ${totalChunks} chunks, chunkSize=${chunkSize}, targetLeadMs=${ICOM_WLAN_TX_TARGET_BUFFER_LEAD_MS}`);

        const chunkStartTime = Date.now();
        const hrStart = performance.now();
        let samplesWritten = 0;

        const assertNotStopped = () => {
          if (this.shouldStopPlayback) {
            throw new Error('playback interrupted');
          }
        };

        const waitRespectingStop = async (ms: number): Promise<void> => {
          let remainingMs = Math.max(0, ms);
          while (remainingMs > 0) {
            assertNotStopped();
            const sleepMs = Math.min(ICOM_WLAN_TX_MAX_WAIT_SLICE_MS, remainingMs);
            await new Promise<void>(res => setTimeout(res, sleepMs));
            remainingMs -= sleepMs;
          }
          assertNotStopped();
        };

        const getBufferedLeadMs = () => {
          const elapsedMs = performance.now() - hrStart;
          const producedMs = (samplesWritten / targetSampleRate) * 1000;
          return producedMs - elapsedMs;
        };

        for (let i = 0; i < totalChunks; i++) {
          // 检查是否需要停止播放
          try {
            assertNotStopped();
          } catch (error) {
            logger.debug(`ICOM WLAN stop signal received, aborting playback (sent ${i}/${totalChunks} chunks)`);
            throw error;
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

          // 节奏控制：保持约 150ms 的 ICOM 侧预缓冲，既不让缓冲见底，也避免数倍速灌入后过早结束 PTT。
          const leadMs = getBufferedLeadMs();
          if (leadMs > ICOM_WLAN_TX_TARGET_BUFFER_LEAD_MS) {
            await waitRespectingStop(leadMs - ICOM_WLAN_TX_TARGET_BUFFER_LEAD_MS);
          }

          // 发送音频数据
          await icomWlanAudioAdapter.sendAudio(chunk);
          if (options.injectIntoMonitor) {
            this.emit('txMonitorAudioData', { samples: chunk, sampleRate: targetSampleRate });
          }

          samplesWritten += chunk.length;
        }

        // 等待已注入的最后一段预缓冲自然播放完，避免上层 PTT 轮询把“发送完成”误判为“音频结束”。
        const remainingBufferedMs = getBufferedLeadMs();
        if (remainingBufferedMs > 0) {
          await waitRespectingStop(remainingBufferedMs);
        }

        const chunkEndTime = Date.now();
        const chunkDuration = chunkEndTime - chunkStartTime;
        logger.info(`ICOM WLAN audio send complete, duration: ${chunkDuration}ms`);
      })();

      this.currentPlaybackPromise = playbackPromise;

      try {
        await playbackPromise;
      } catch (error) {
        const isInterrupted = error instanceof Error && error.message === 'playback interrupted';
        if (!isInterrupted) {
          logger.error('ICOM WLAN audio send failed', error);
        }
        throw error;
      } finally {
        // 清理播放状态
        if (this.currentPlaybackPromise === playbackPromise) {
          this.playing = false;
          this.currentPlaybackPromise = null;
          this.currentPlaybackKind = null;
          this.currentAudioData = null;
          this.currentSampleRate = 0;
        }
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
    this.currentPlaybackKind = playbackKind;
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
    let playbackPromise: Promise<void> | null = null;
    playbackPromise = (async () => {
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

      const totalSamples = playbackData.length;
      const expectedDurationMs = Math.round((totalSamples / this.sampleRate) * 1000);
      logger.debug(`chunked playback: ${totalChunks} chunks, chunkSize=${chunkSize}, prebuffer~${prebufferMs}ms, tick=${TICK_MS}ms, totalSamples=${totalSamples}, expectedDuration=${expectedDurationMs}ms`);

      const chunkStartTime = Date.now();

      // setInterval-based playback loop wrapped in a Promise
      await new Promise<void>((resolve, reject) => {
        const hrStart = performance.now();
        let cursor = 0;
        let samplesWritten = 0;
        let writeFailCount = 0;
        let lastProgressSec = -1;

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
            // RtAudio requires exactly chunkSize frames per write; pad short last chunk with silence
            const bufferSamples = chunkSize;
            const buffer = Buffer.allocUnsafe(bufferSamples * 4);
            const monitorChunk = options.injectIntoMonitor ? new Float32Array(chunk.length) : null;
            for (let j = 0; j < chunk.length; j++) {
              const s = chunk[j] * gain;
              const clamped = s > 1 ? 1 : (s < -1 ? -1 : s);
              buffer.writeFloatLE(clamped, j * 4);
              if (monitorChunk) {
                monitorChunk[j] = clamped;
              }
            }
            // Zero-fill remainder (silence padding for short last chunk)
            for (let j = chunk.length; j < bufferSamples; j++) {
              buffer.writeFloatLE(0, j * 4);
            }
            this.rtAudioOutput.write(buffer);
            if (monitorChunk && monitorChunk.length > 0) {
              this.emit('txMonitorAudioData', { samples: monitorChunk, sampleRate: this.sampleRate });
            }
            samplesWritten += chunk.length;
            return true;
          } catch {
            writeFailCount++;
            if (writeFailCount <= 3 || writeFailCount % 100 === 0) {
              logger.debug(`writeChunk failed: chunk=${idx}/${totalChunks}, written=${samplesWritten}/${totalSamples}, fails=${writeFailCount}`);
            }
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
              const playDuration = Date.now() - playStartTime;
              logger.debug(`chunked write complete, duration: ${chunkDuration}ms`);
              logger.info(`playback complete, duration: ${playDuration}ms, expected: ${expectedDurationMs}ms, overhead: ${playDuration - expectedDurationMs}ms, writeFails: ${writeFailCount}`);
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

            // Periodic progress log (every 2 seconds)
            const elapsedSec = Math.floor(elapsedMs / 1000);
            if (elapsedSec >= 2 && elapsedSec !== lastProgressSec && elapsedSec % 2 === 0) {
              lastProgressSec = elapsedSec;
              logger.debug(`playback progress: ${cursor}/${totalChunks} chunks, ${samplesWritten}/${totalSamples} samples, elapsed=${Math.round(elapsedMs)}ms, target=${targetSamples}, fails=${writeFailCount}`);
            }
          } catch (err) {
            clearInterval(interval);
            reject(err);
          }
        }, TICK_MS);
      });

      } catch (error) {
        if (error instanceof Error && error.message.includes('playback interrupted')) {
          logger.debug('audio playback interrupted');
        } else {
          logger.error('audio playback failed', error);
        }
        throw error;
      } finally {
        // 清理播放状态
        if (this.currentPlaybackPromise === playbackPromise) {
          this.playing = false;
          this.currentAudioData = null;
          this.currentPlaybackPromise = null;
          this.currentPlaybackKind = null;
        }
      }
    })();
    this.currentPlaybackPromise = playbackPromise;

    // 等待播放完成
    return playbackPromise;
  }

  async playVoiceAudio(pcmData: Float32Array, frameSampleRate: number, meta: VoiceTxFrameMeta): Promise<void> {
    this.voiceTxOutputPipeline.ingest(pcmData, frameSampleRate, meta);
    return;
  }

  recordVoiceTxTimingProbe(data: {
    participantIdentity: string;
    transport: VoiceTxFrameMeta['transport'];
    codec?: VoiceTxFrameMeta['codec'];
    sequence: number;
    sentAtMs: number;
    receivedAtMs: number;
    intervalMs: number;
    voiceTxBufferPolicy?: VoiceTxFrameMeta['voiceTxBufferPolicy'];
  }): void {
    this.voiceTxOutputPipeline.recordTimingProbe(data);
  }

  private getVoiceTxOutputSinkState(): VoiceTxOutputSinkState {
    if (this.usingIcomWlanOutput && this.icomWlanAudioAdapter) {
      const outputSampleRate = this.icomWlanAudioAdapter.getSampleRate();
      return {
        available: this.isOutputting,
        kind: 'icom-wlan',
        outputSampleRate,
        outputBufferSize: Math.max(80, Math.round(outputSampleRate * 0.01)),
      };
    }

    return {
      available: this.isOutputting && Boolean(this.rtAudioOutput),
      kind: 'rtaudio',
      outputSampleRate: this.sampleRate,
      outputBufferSize: Math.max(64, this.bufferSize || 1024),
    };
  }

  private async writeVoiceTxOutputChunk(samples: Float32Array, sink: VoiceTxOutputSinkState): Promise<boolean> {
    if (sink.kind === 'icom-wlan') {
      if (!this.icomWlanAudioAdapter) {
        return false;
      }
      try {
        await this.icomWlanAudioAdapter.sendAudio(samples);
        return true;
      } catch (error) {
        logger.error('Voice audio ICOM WLAN send failed', error);
        return false;
      }
    }

    if (!this.rtAudioOutput) {
      return false;
    }

    try {
      const buffer = Buffer.allocUnsafe(samples.length * 4);
      for (let index = 0; index < samples.length; index += 1) {
        buffer.writeFloatLE(samples[index] ?? 0, index * 4);
      }
      this.rtAudioOutput.write(buffer);
      return true;
    } catch (error) {
      logger.debug('Voice audio RtAudio write failed', error);
      return false;
    }
  }

}
