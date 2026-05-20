import { createRtAudioInstance, type RtAudioInstance } from './rtaudio-api.js';
import { RingBufferAudioProvider } from './AudioBufferProvider.js';
import type { AudioClock } from './ringBuffer.js';
import { EventEmitter } from 'eventemitter3';
import { clearResamplerCache, resampleAudioProfessional } from '../utils/audioUtils.js';
import { ConfigManager } from '../config/config-manager.js';
import { AudioDeviceManager } from './audio-device-manager.js';
import { performance } from 'node:perf_hooks';
import type { IcomWlanAudioAdapter } from './IcomWlanAudioAdapter.js';
import type { OpenWebRXAudioAdapter } from '../openwebrx/OpenWebRXAudioAdapter.js';
import { createLogger } from '../utils/logger.js';
import type { VoiceTxFrameMeta, VoiceTxProcessedFrameStats } from '../voice/VoiceTxDiagnostics.js';
import { VoiceTxOutputPipeline, type VoiceTxOutputSinkState } from './VoiceTxOutputPipeline.js';
import { AndroidAudioInputSocket, AndroidAudioOutputSocket } from './AndroidAudioSocketBackend.js';
import { isAndroidAudioDeviceId, isAndroidBridgeRuntime, isLegacyAndroidAudioDeviceName } from './android-audio-devices.js';

const logger = createLogger('AudioStreamManager');
// RtAudioFormat 是 const enum，isolatedModules 下无法直接导入，使用数值常量
const RTAUDIO_SINT16 = 0x2;
const RTAUDIO_FLOAT32 = 0x10;
const RTAUDIO_STREAM_FLAGS_NONE = 0 as unknown as Parameters<RtAudioInstance['openStream']>[8];
const RTAUDIO_ERROR_WARNING = 0;
const RTAUDIO_ERROR_DEBUG_WARNING = 1;
export const DEFAULT_INPUT_PROCESSING_SAMPLE_RATE = 12_000;
export const CW_INPUT_PROCESSING_SAMPLE_RATE = 9_600;
const INPUT_RING_BUFFER_DURATION_MS = 60_000;
const ICOM_WLAN_TX_CHUNK_SIZE = 1200;
const ICOM_WLAN_TX_TARGET_BUFFER_LEAD_MS = 150;
const ICOM_WLAN_TX_MAX_WAIT_SLICE_MS = 20;
const RTAUDIO_TX_CONSUME_WATCHDOG_MS = 750;
const RTAUDIO_TX_DRAIN_TIMEOUT_FLOOR_MS = 1000;
const RTAUDIO_TX_WATCHDOG_MIN_SUBMITTED_CHUNKS = 3;
const RTAUDIO_OUTPUT_WARNING_LOG_WINDOW_MS = 5000;

export type NativeAudioInputSourceKind = 'audio-device' | 'icom-wlan' | 'openwebrx';

export interface NativeAudioInputFrame {
  samples: Float32Array;
  sampleRate: number;
  channels: number;
  timestamp: number;
  sequence: number;
  sourceKind: NativeAudioInputSourceKind;
}

export interface AudioStreamEvents {
  'audioData': (samples: Float32Array, sampleRate: number) => void;
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

interface OutputBackendSnapshot {
  api?: string;
  streamOpen?: boolean;
  streamRunning?: boolean;
  streamLatencyFrames?: number;
  streamSampleRate?: number;
  error?: string;
}

interface AudioStats {
  peak: number;
  rms: number;
}

interface AudioSegmentStats extends AudioStats {
  index: number;
  startMs: number;
  endMs: number;
}

interface RtAudioIssue {
  type: number;
  typeName: string;
  message: string;
  at: number;
  fatal: boolean;
}

interface RtAudioIssueLogState {
  lastLoggedAt: number;
  suppressedCount: number;
}

export interface PlayAudioOptions {
  /**
   * Mirrors the audio chunks written to the TX output into the monitor broadcast
   * side path. This is intentionally opt-in: normal RX monitor, spectrum, and
   * decoding must continue to use the physical input ring buffer only.
   */
  injectIntoMonitor?: boolean;
  playbackKind?: PlaybackKind;
  diagnosticContext?: Record<string, unknown>;
}

export type PlaybackKind = 'digital' | 'voice-keyer' | 'tune-tone';
type OutputSampleFormat = 'float32' | 'int16';
type OutputChannelMode = 'mono' | 'left' | 'right' | 'both';

interface EncodedOutputChunk {
  buffer: Buffer;
  monitorChunk: Float32Array | null;
  sourceSamples: number;
  peak: number;
  sumSquares: number;
}

export interface StopPlaybackOptions {
  kind?: PlaybackKind;
}

export interface AudioStreamManagerOptions {
  now?: AudioClock;
}

/**
 * 音频流管理器 - 负责从音频设备捕获实时音频数据
 * 支持传统声卡（Audify/RtAudio）和 ICOM WLAN 虚拟设备
 */
export class AudioStreamManager extends EventEmitter<AudioStreamEvents> {
  private rtAudioInput: RtAudioInstance | null = null;
  private rtAudioOutput: RtAudioInstance | null = null;
  private androidAudioInput: AndroidAudioInputSocket | null = null;
  private androidAudioOutput: AndroidAudioOutputSocket | null = null;
  private isStreaming = false;
  private isOutputting = false;
  private audioProvider: RingBufferAudioProvider;
  private deviceId: string | null = null;
  private outputDeviceId: string | null = null;
  private activeInputDeviceName: string | null = null;
  private activeOutputDeviceName: string | null = null;
  private inputSampleRate: number;
  private inputProcessingSampleRate = DEFAULT_INPUT_PROCESSING_SAMPLE_RATE;
  private outputSampleRate: number;
  private inputBufferSize: number;
  private outputBufferSize: number;
  private channels: number = 1;
  private outputSampleFormat: OutputSampleFormat = 'float32';
  private outputChannelMode: OutputChannelMode = 'mono';
  private outputChannels: number = 1;
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
  private openwebrxAudioDataHandler: ((samples: Float32Array) => void) | null = null;
  private openwebrxErrorHandler: ((error: Error) => void) | null = null;
  private usingAndroidInput = false;
  private usingAndroidOutput = false;

  // 播放状态跟踪（用于重新混音兜底方案）
  private playing: boolean = false;             // 是否正在播放
  private playbackStartTime: number = 0;        // 播放开始时间戳
  private currentPlaybackPromise: Promise<void> | null = null;  // 当前播放的Promise
  private currentPlaybackKind: PlaybackKind | null = null;
  private shouldStopPlayback: boolean = false;  // 停止播放标志
  private voiceOutputObserver: VoiceTxOutputObserver | null = null;
  private voiceTxOutputPipeline: VoiceTxOutputPipeline;
  private nativeAudioInputSequence = 0;
  private outputFramesConsumed = 0;
  private outputFirstFrameConsumedAt: number | null = null;
  private outputLastFrameConsumedAt: number | null = null;
  private outputRtAudioErrors: RtAudioIssue[] = [];
  private outputRtAudioIssueLogState = new Map<string, RtAudioIssueLogState>();
  private outputRuntimeLossEmitted = false;
  private outputWatchdogGeneration = 0;
  private playbackSequence = 0;
  private readonly now: AudioClock;

  constructor(options: AudioStreamManagerOptions = {}) {
    super();
    this.now = options.now ?? Date.now;

    // 从配置管理器获取音频设置
    const configManager = ConfigManager.getInstance();
    const audioConfig = configManager.getAudioConfig();

    this.inputSampleRate = audioConfig.inputSampleRate ?? audioConfig.sampleRate ?? 48000;
    this.outputSampleRate = audioConfig.outputSampleRate ?? audioConfig.sampleRate ?? 48000;
    this.inputBufferSize = audioConfig.inputBufferSize ?? audioConfig.bufferSize ?? 1024;
    this.outputBufferSize = audioConfig.outputBufferSize ?? audioConfig.bufferSize ?? 1024;
    this.outputSampleFormat = this.normalizeOutputSampleFormat(audioConfig.outputSampleFormat);
    this.outputChannelMode = this.normalizeOutputChannelMode(audioConfig.outputChannelMode);
    this.outputChannels = this.getOutputChannelCount(this.outputChannelMode);
    this.currentSampleRate = this.outputSampleRate;

    // 创建音频缓冲区提供者，使用统一的内部处理采样率，保留 60 秒 RX/input 历史。
    this.audioProvider = new RingBufferAudioProvider(this.inputProcessingSampleRate, INPUT_RING_BUFFER_DURATION_MS, this.now);
    this.voiceTxOutputPipeline = new VoiceTxOutputPipeline({
      getSinkState: () => this.getVoiceTxOutputSinkState(),
      getObserver: () => this.voiceOutputObserver,
      getVolumeGain: () => this.volumeGain,
      writeOutputChunk: (samples, sink) => this.writeVoiceTxOutputChunk(samples, sink),
    });
    logger.info('audio stream manager initialized', {
      inputSampleRate: this.inputSampleRate,
      outputSampleRate: this.outputSampleRate,
      inputBufferSize: this.inputBufferSize,
      outputBufferSize: this.outputBufferSize,
      outputSampleFormat: this.outputSampleFormat,
      outputChannelMode: this.outputChannelMode,
      outputChannels: this.outputChannels,
      internalSampleRate: this.inputProcessingSampleRate,
    });
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
    if (this.openwebrxAudioAdapter && this.openwebrxAudioAdapter !== adapter) {
      this.detachOpenWebRXInputHandlers(this.openwebrxAudioAdapter);
    }
    this.openwebrxAudioAdapter = adapter;
    logger.info(`OpenWebRX audio adapter ${adapter ? 'set' : 'cleared'}`);
  }

  /**
   * 获取采样率（供外部使用）
   */
  getSampleRate(): number {
    return this.inputSampleRate;
  }

  /**
   * 获取内部处理采样率，用于 RX ring buffer、频谱分析和解码链路。
   */
  getInternalSampleRate(): number {
    return this.inputProcessingSampleRate;
  }

  /**
   * 设置统一 RX/audioData 处理采样率。采样率变化时重建 ring buffer，
   * 避免同一缓冲区内混入不同采样率的样本。
   */
  setInputProcessingSampleRate(sampleRate: number, reason = 'manual'): boolean {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new Error(`invalid input processing sample rate: ${sampleRate}`);
    }
    const nextSampleRate = Math.floor(sampleRate);
    if (nextSampleRate === this.inputProcessingSampleRate) {
      return false;
    }

    const previousSampleRate = this.inputProcessingSampleRate;
    this.inputProcessingSampleRate = nextSampleRate;
    this.audioProvider.setSampleRate(nextSampleRate, INPUT_RING_BUFFER_DURATION_MS);
    clearResamplerCache();
    logger.info('audio input processing sample rate changed', {
      previousSampleRate,
      nextSampleRate,
      reason,
      streaming: this.isStreaming,
    });
    return true;
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
      const configuredInputDeviceName = audioConfig.inputDeviceName;
      
      // 检测是否为 ICOM WLAN 虚拟设备
      if (deviceId === 'icom-wlan-input' || audioConfig.inputDeviceName === 'ICOM WLAN') {
        logger.info('ICOM WLAN virtual input device detected');

        if (!this.icomWlanAudioAdapter) {
          // ICOM 适配器未设置时，输出警告并跳过音频流启动
          logger.warn('ICOM WLAN audio adapter not set, skipping audio stream start');

          this.deviceId = 'icom-wlan-input';
          this.activeInputDeviceName = 'ICOM WLAN';
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
          void this.ingestInputSamples(
            samples,
            this.icomWlanAudioAdapter?.getSampleRate() ?? DEFAULT_INPUT_PROCESSING_SAMPLE_RATE,
            'icom-wlan',
          );
        });

        this.icomWlanAudioAdapter.on('error', (error: Error) => {
          logger.error('ICOM WLAN audio error', error);
          this.emit('error', error);
        });

        this.deviceId = 'icom-wlan-input';
        this.activeInputDeviceName = 'ICOM WLAN';
        this.isStreaming = true;
        logger.info('ICOM WLAN audio input started', {
          sourceSampleRate: this.icomWlanAudioAdapter.getSampleRate(),
          processingSampleRate: this.inputProcessingSampleRate,
        });
        this.emit('started');
        return;
      }

      // 检测是否为 OpenWebRX SDR 虚拟设备
      if (deviceId?.startsWith('openwebrx-') || audioConfig.inputDeviceName?.startsWith('[SDR]')) {
        logger.info('OpenWebRX virtual input device detected');

        if (!this.openwebrxAudioAdapter) {
          logger.warn('OpenWebRX audio adapter not set, skipping audio stream start');
          this.deviceId = deviceId || 'openwebrx-unknown';
          this.activeInputDeviceName = audioConfig.inputDeviceName ?? null;
          this.usingOpenWebRXInput = false;
          this.isStreaming = true;
          this.emit('started');
          return;
        }

        // Use OpenWebRX audio adapter
        const openwebrxAdapter = this.openwebrxAudioAdapter;
        this.usingOpenWebRXInput = true;
        openwebrxAdapter.startReceiving();

        // Subscribe to audio data
        this.openwebrxAudioDataHandler = (samples: Float32Array) => {
          void this.ingestInputSamples(
            samples,
            openwebrxAdapter.getSampleRate(),
            'openwebrx',
          );
        };

        this.openwebrxErrorHandler = (error: Error) => {
          logger.error('OpenWebRX audio error', error);
          this.emit('error', error);
        };

        openwebrxAdapter.on('audioData', this.openwebrxAudioDataHandler);
        openwebrxAdapter.on('error', this.openwebrxErrorHandler);

        this.deviceId = deviceId || 'openwebrx-unknown';
        this.activeInputDeviceName = audioConfig.inputDeviceName ?? null;
        this.isStreaming = true;
        logger.info('OpenWebRX audio input started', {
          sourceSampleRate: openwebrxAdapter.getSampleRate(),
          processingSampleRate: this.inputProcessingSampleRate,
        });
        this.emit('started');
        return;
      }

      if (isAndroidAudioDeviceId(deviceId) || audioConfig.inputDeviceName?.startsWith('[Android]') || (isAndroidBridgeRuntime() && (!audioConfig.inputDeviceName || isLegacyAndroidAudioDeviceName('input', audioConfig.inputDeviceName)))) {
        const audioDeviceManager = AudioDeviceManager.getInstance();
        const androidDevice = audioDeviceManager.resolveAndroidDeviceForStream(
          'input',
          isLegacyAndroidAudioDeviceName('input', configuredInputDeviceName) ? undefined : configuredInputDeviceName,
          deviceId,
        );
        if (!androidDevice) {
          throw new Error(`Android audio input device is unavailable: ${configuredInputDeviceName ?? deviceId ?? 'default'}`);
        }
        const input = new AndroidAudioInputSocket(androidDevice);
        input.on('audioData', (samples, sampleRate) => {
          void this.ingestInputSamples(samples, sampleRate, 'audio-device');
        });
        input.on('error', (error) => {
          logger.error('Android audio input socket error', error);
          this.emit('error', error);
        });
        await input.start();
        this.androidAudioInput = input;
        this.usingAndroidInput = true;
        this.deviceId = androidDevice.id;
        this.activeInputDeviceName = androidDevice.name;
        this.inputSampleRate = androidDevice.sampleRate || this.inputSampleRate;
        this.isStreaming = true;
        audioDeviceManager.markDeviceActive('input', this.activeInputDeviceName, this.deviceId, this.inputSampleRate, 1);
        logger.info('Android audio input started', {
          device: androidDevice.name,
          socketPath: androidDevice.socketPath,
          sampleRate: this.inputSampleRate,
        });
        this.emit('started');
        return;
      }

      logger.info('audio input starting', {
        deviceId,
        channels: this.channels,
        sampleRate: this.inputSampleRate,
        frameSize: this.inputBufferSize,
        format: 'Float32',
      });

      // 创建和启动音频输入流（带超时保护）
      await this.createAndStartInputWithTimeout(deviceId, configuredInputDeviceName);
      
      this.isStreaming = true;
      logger.info('audio stream started', { sampleRate: this.inputSampleRate, bufferSize: this.inputBufferSize });
      this.emit('started');

    } catch (error) {
      logger.error('failed to start audio stream', error);
      // 清理失败的输入流
      if (this.rtAudioInput) {
        this.cleanupRtAudioStream('input', this.rtAudioInput, 'start-failed');
        this.rtAudioInput = null;
      }
      this.isStreaming = false;
      this.deviceId = null;
      AudioDeviceManager.getInstance().clearActiveDevice('input', this.activeInputDeviceName);
      this.activeInputDeviceName = null;
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
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

      // 停止 OpenWebRX 音频输入
      if (this.usingOpenWebRXInput && this.openwebrxAudioAdapter) {
        this.detachOpenWebRXInputHandlers(this.openwebrxAudioAdapter);
        this.openwebrxAudioAdapter.stopReceiving();
        this.usingOpenWebRXInput = false;
        logger.info('OpenWebRX audio input stopped');
      }

      if (this.usingAndroidInput) {
        this.androidAudioInput?.stop();
        this.androidAudioInput = null;
        this.usingAndroidInput = false;
        logger.info('Android audio input stopped');
      }

      // 停止传统声卡输入
      if (this.rtAudioInput) {
        this.cleanupRtAudioStream('input', this.rtAudioInput, 'stop-request');
        this.rtAudioInput = null;
      }

      // 清理重采样器缓存
      clearResamplerCache();

      AudioDeviceManager.getInstance().clearActiveDevice('input', this.activeInputDeviceName);
      this.isStreaming = false;
      this.deviceId = null;
      this.activeInputDeviceName = null;

      logger.info('audio stream stopped');
      this.emit('stopped');

    } catch (error) {
      logger.error('failed to stop audio stream', error);
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
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
    return this.outputSampleRate;
  }

  /**
   * 重新加载音频配置
   * 注意：需要重启音频流才能生效
   */
  reloadAudioConfig(): void {
    const configManager = ConfigManager.getInstance();
    const audioConfig = configManager.getAudioConfig();
    
    const oldInputSampleRate = this.inputSampleRate;
    const oldOutputSampleRate = this.outputSampleRate;
    const oldInputBufferSize = this.inputBufferSize;
    const oldOutputBufferSize = this.outputBufferSize;
    const oldOutputSampleFormat = this.outputSampleFormat;
    const oldOutputChannelMode = this.outputChannelMode;
    const oldOutputChannels = this.outputChannels;

    this.inputSampleRate = audioConfig.inputSampleRate ?? audioConfig.sampleRate ?? 48000;
    this.outputSampleRate = audioConfig.outputSampleRate ?? audioConfig.sampleRate ?? 48000;
    this.inputBufferSize = audioConfig.inputBufferSize ?? audioConfig.bufferSize ?? 1024;
    this.outputBufferSize = audioConfig.outputBufferSize ?? audioConfig.bufferSize ?? 1024;
    this.outputSampleFormat = this.normalizeOutputSampleFormat(audioConfig.outputSampleFormat);
    this.outputChannelMode = this.normalizeOutputChannelMode(audioConfig.outputChannelMode);
    this.outputChannels = this.getOutputChannelCount(this.outputChannelMode);
    this.currentSampleRate = this.outputSampleRate;

    logger.info('audio config reloaded (restart required)', {
      inputSampleRate: `${oldInputSampleRate}Hz -> ${this.inputSampleRate}Hz`,
      outputSampleRate: `${oldOutputSampleRate}Hz -> ${this.outputSampleRate}Hz`,
      inputBufferSize: `${oldInputBufferSize} -> ${this.inputBufferSize}`,
      outputBufferSize: `${oldOutputBufferSize} -> ${this.outputBufferSize}`,
      outputSampleFormat: `${oldOutputSampleFormat} -> ${this.outputSampleFormat}`,
      outputChannelMode: `${oldOutputChannelMode} -> ${this.outputChannelMode}`,
      outputChannels: `${oldOutputChannels} -> ${this.outputChannels}`,
    });
  }

  private normalizeOutputSampleFormat(value: unknown): OutputSampleFormat {
    return value === 'int16' ? 'int16' : 'float32';
  }

  private normalizeOutputChannelMode(value: unknown): OutputChannelMode {
    return value === 'left' || value === 'right' || value === 'both' ? value : 'mono';
  }

  private getOutputChannelCount(mode: OutputChannelMode): number {
    return mode === 'mono' ? 1 : 2;
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
      sampleRate: this.inputSampleRate,
      inputSampleRate: this.inputSampleRate,
      internalSampleRate: this.inputProcessingSampleRate,
      outputSampleRate: this.outputSampleRate,
      inputBufferSize: this.inputBufferSize,
      outputBufferSize: this.outputBufferSize,
      outputSampleFormat: this.outputSampleFormat,
      outputChannelMode: this.outputChannelMode,
      outputChannels: this.outputChannels,
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
      const configuredOutputDeviceName = audioConfig.outputDeviceName;
      
      // 检测是否为 ICOM WLAN 虚拟设备
      if (outputDeviceId === 'icom-wlan-output' || audioConfig.outputDeviceName === 'ICOM WLAN') {
        logger.info('ICOM WLAN virtual output device detected');

        if (!this.icomWlanAudioAdapter) {
          // ICOM 适配器未设置时，回退到默认声卡而不是抛出错误
          logger.warn('ICOM WLAN audio adapter not set, falling back to default audio device');
          // 继续执行传统声卡初始化逻辑，使用系统默认设备
          outputDeviceId = undefined;
          // 继续执行传统声卡初始化逻辑，不 return
        } else {
          // 标记使用 ICOM WLAN 输出
          this.usingIcomWlanOutput = true;
          this.outputDeviceId = 'icom-wlan-output';
          this.activeOutputDeviceName = 'ICOM WLAN';
          this.isOutputting = true;
          logger.info('ICOM WLAN audio output started (48kHz -> 12kHz)');
          return;
        }
      }

      if (isAndroidAudioDeviceId(outputDeviceId) || configuredOutputDeviceName?.startsWith('[Android]') || (isAndroidBridgeRuntime() && (!configuredOutputDeviceName || isLegacyAndroidAudioDeviceName('output', configuredOutputDeviceName)))) {
        const audioDeviceManager = AudioDeviceManager.getInstance();
        const androidDevice = audioDeviceManager.resolveAndroidDeviceForStream(
          'output',
          isLegacyAndroidAudioDeviceName('output', configuredOutputDeviceName) ? undefined : configuredOutputDeviceName,
          outputDeviceId,
        );
        if (!androidDevice) {
          throw new Error(`Android audio output device is unavailable: ${configuredOutputDeviceName ?? outputDeviceId ?? 'default'}`);
        }
        const output = new AndroidAudioOutputSocket(androidDevice);
        await output.start();
        this.androidAudioOutput = output;
        this.usingAndroidOutput = true;
        this.outputDeviceId = androidDevice.id;
        this.activeOutputDeviceName = androidDevice.name;
        this.outputSampleRate = androidDevice.sampleRate || this.outputSampleRate;
        this.outputChannels = 1;
        this.isOutputting = true;
        audioDeviceManager.markDeviceActive('output', this.activeOutputDeviceName, this.outputDeviceId, this.outputSampleRate, 1);
        logger.info('Android audio output started', {
          device: androidDevice.name,
          socketPath: androidDevice.socketPath,
          sampleRate: this.outputSampleRate,
        });
        return;
      }

      logger.info('audio output starting', {
        deviceId: outputDeviceId,
        channels: this.outputChannels,
        sampleRate: this.outputSampleRate,
        frameSize: this.outputBufferSize,
        format: this.outputSampleFormat,
        channelMode: this.outputChannelMode,
      });

      await this.createAndStartOutputWithTimeout(outputDeviceId, configuredOutputDeviceName);

      this.isOutputting = true;
      logger.info('audio output started', { sampleRate: this.outputSampleRate });

    } catch (error) {
      logger.error('failed to start audio output', error);
      // 清理失败的输出流
      if (this.rtAudioOutput) {
        this.cleanupRtAudioStream('output', this.rtAudioOutput, 'start-failed');
        this.rtAudioOutput = null;
      }
      this.isOutputting = false;
      this.outputDeviceId = null;
      AudioDeviceManager.getInstance().clearActiveDevice('output', this.activeOutputDeviceName);
      this.activeOutputDeviceName = null;
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }
  
  /**
   * 带超时保护的音频输入创建和启动
   */
  private async createAndStartInputWithTimeout(
    requestedDeviceId?: string,
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

            this.rtAudioInput = createRtAudioInstance({ logger, purpose: 'audio-input-stream' });
            const audioDeviceManager = AudioDeviceManager.getInstance();
            const resolvedDevice = await audioDeviceManager.resolveInputDeviceForStream(
              configuredDeviceName,
              this.rtAudioInput,
              requestedDeviceId,
            );

            this.openInputStream(resolvedDevice.actualDeviceId);

            logger.info('audio input stream created');
            this.deviceId = resolvedDevice.persistedDeviceId;
            this.activeInputDeviceName = configuredDeviceName ?? resolvedDevice.deviceName;

            logger.info('starting audio input stream');
            this.rtAudioInput.start();
            audioDeviceManager.markDeviceActive(
              'input',
              this.activeInputDeviceName,
              this.deviceId,
              this.inputSampleRate,
              this.channels,
            );

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
    requestedOutputDeviceId?: string,
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

            this.rtAudioOutput = createRtAudioInstance({ logger, purpose: 'audio-output-stream' });
            const audioDeviceManager = AudioDeviceManager.getInstance();
            const resolvedDevice = await audioDeviceManager.resolveOutputDeviceForStream(
              configuredDeviceName,
              this.rtAudioOutput,
              requestedOutputDeviceId,
            );

            this.openOutputStream(resolvedDevice.actualDeviceId);

            logger.info('audio output stream created');
            this.outputDeviceId = resolvedDevice.persistedDeviceId;
            this.activeOutputDeviceName = configuredDeviceName ?? resolvedDevice.deviceName;

            logger.info('starting audio output stream');
            this.rtAudioOutput.start();
            audioDeviceManager.markDeviceActive(
              'output',
              this.activeOutputDeviceName,
              this.outputDeviceId,
              this.outputSampleRate,
              this.outputChannels,
            );

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
    if (!this.isOutputting && !this.rtAudioOutput && !this.usingIcomWlanOutput) {
      logger.warn('audio output is not running');
      return;
    }

    try {
      logger.info('stopping audio output');
      await this.stopCurrentPlayback();
      this.clearVoicePlaybackQueue();

      // ICOM WLAN 输出只需要清除标志，不需要额外操作
      if (this.usingIcomWlanOutput) {
        this.usingIcomWlanOutput = false;
        logger.info('ICOM WLAN audio output stopped');
      }

      if (this.usingAndroidOutput) {
        this.androidAudioOutput?.stop();
        this.androidAudioOutput = null;
        this.usingAndroidOutput = false;
        logger.info('Android audio output stopped');
      }

      // 停止传统声卡输出
      if (this.rtAudioOutput) {
        this.cleanupRtAudioStream('output', this.rtAudioOutput, 'stop-request');
        this.rtAudioOutput = null;
      }

      AudioDeviceManager.getInstance().clearActiveDevice('output', this.activeOutputDeviceName);
      this.isOutputting = false;
      this.outputDeviceId = null;
      this.activeOutputDeviceName = null;
      this.outputRuntimeLossEmitted = false;
      this.outputRtAudioIssueLogState.clear();

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

  private openInputStream(inputDeviceId: number): void {
    if (!this.rtAudioInput) {
      throw new Error('audio input instance not initialized');
    }

    this.rtAudioInput.openStream(
      null,
      { deviceId: inputDeviceId, nChannels: this.channels, firstChannel: 0 },
      RTAUDIO_FLOAT32,
      this.inputSampleRate,
      this.inputBufferSize,
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
          void this.ingestInputSamples(samples, this.inputSampleRate, 'audio-device');
        } catch (error) {
          logger.error('audio data processing error', error);
          this.emit('error', error as Error);
        }
      },
      null
    );
  }

  private async ingestInputSamples(
    samples: Float32Array,
    sampleRate: number,
    sourceKind: NativeAudioInputSourceKind,
  ): Promise<void> {
    if (samples.length === 0) return;

    const sourceSampleRate = Number.isFinite(sampleRate) && sampleRate > 0
      ? Math.floor(sampleRate)
      : this.inputProcessingSampleRate;
    this.emitNativeAudioInputData(samples, sourceSampleRate, sourceKind);

    const targetSampleRate = this.inputProcessingSampleRate;
    if (sourceSampleRate === targetSampleRate) {
      this.writeProcessedInputAudio(samples, targetSampleRate);
      return;
    }

    try {
      const resampled = await resampleAudioProfessional(samples, sourceSampleRate, targetSampleRate, 1);
      if (this.inputProcessingSampleRate !== targetSampleRate) {
        logger.debug('dropping stale input resample result after processing rate change', {
          sourceSampleRate,
          staleTargetSampleRate: targetSampleRate,
          currentTargetSampleRate: this.inputProcessingSampleRate,
          sourceKind,
        });
        return;
      }
      this.writeProcessedInputAudio(resampled, targetSampleRate);
    } catch (error) {
      logger.error('audio input resample error', {
        sourceSampleRate,
        targetSampleRate,
        sourceKind,
        error: error instanceof Error ? error.message : String(error),
      });
      this.emit('error', error as Error);
    }
  }

  private writeProcessedInputAudio(samples: Float32Array, sampleRate: number): void {
    this.audioProvider.writeAudio(samples);
    this.emit('audioData', samples, sampleRate);
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

  private detachOpenWebRXInputHandlers(adapter: OpenWebRXAudioAdapter): void {
    if (this.openwebrxAudioDataHandler) {
      adapter.off('audioData', this.openwebrxAudioDataHandler);
      this.openwebrxAudioDataHandler = null;
    }

    if (this.openwebrxErrorHandler) {
      adapter.off('error', this.openwebrxErrorHandler);
      this.openwebrxErrorHandler = null;
    }
  }

  private openOutputStream(outputDeviceId: number): void {
    if (!this.rtAudioOutput) {
      throw new Error('audio output instance not initialized');
    }

    this.resetOutputConsumeDiagnostics();

    this.rtAudioOutput.openStream(
      { deviceId: outputDeviceId, nChannels: this.outputChannels, firstChannel: 0 },
      null,
      this.outputSampleFormat === 'int16' ? RTAUDIO_SINT16 : RTAUDIO_FLOAT32,
      this.outputSampleRate,
      this.outputBufferSize,
      'TX5DR-Output',
      null,
      () => this.recordOutputFrameConsumed(),
      RTAUDIO_STREAM_FLAGS_NONE,
      (type: number, message: string) => this.recordOutputRtAudioIssue(type, message)
    );
    logger.info('RtAudio output stream opened', {
      outputSampleFormat: this.outputSampleFormat,
      outputChannelMode: this.outputChannelMode,
      outputChannels: this.outputChannels,
      outputSampleRate: this.outputSampleRate,
      outputBufferSize: this.outputBufferSize,
    });
  }

  private resetOutputConsumeDiagnostics(): void {
    this.outputFramesConsumed = 0;
    this.outputFirstFrameConsumedAt = null;
    this.outputLastFrameConsumedAt = null;
    this.outputRtAudioErrors = [];
    this.outputRuntimeLossEmitted = false;
    this.outputRtAudioIssueLogState.clear();
    this.outputWatchdogGeneration++;
  }

  private getOutputBytesPerSample(): number {
    return this.outputSampleFormat === 'int16' ? 2 : 4;
  }

  private encodeRtAudioOutputChunk(
    chunk: Float32Array,
    targetFrames: number,
    gain: number,
    includeMonitor: boolean,
  ): EncodedOutputChunk {
    const channels = this.outputChannels;
    const bytesPerSample = this.getOutputBytesPerSample();
    const buffer = Buffer.allocUnsafe(targetFrames * channels * bytesPerSample);
    const monitorChunk = includeMonitor ? new Float32Array(chunk.length) : null;
    let peak = 0;
    let sumSquares = 0;

    for (let frame = 0; frame < targetFrames; frame++) {
      const source = frame < chunk.length ? (chunk[frame] ?? 0) : 0;
      const sample = this.clampAudioSample(source * gain);
      if (frame < chunk.length) {
        const abs = Math.abs(sample);
        if (abs > peak) {
          peak = abs;
        }
        sumSquares += sample * sample;
        if (monitorChunk) {
          monitorChunk[frame] = sample;
        }
      }

      for (let channel = 0; channel < channels; channel++) {
        const outputSample = this.getMappedOutputSample(sample, channel);
        const offset = (frame * channels + channel) * bytesPerSample;
        if (this.outputSampleFormat === 'int16') {
          buffer.writeInt16LE(this.floatToInt16(outputSample), offset);
        } else {
          buffer.writeFloatLE(outputSample, offset);
        }
      }
    }

    return {
      buffer,
      monitorChunk,
      sourceSamples: chunk.length,
      peak,
      sumSquares,
    };
  }

  private clampAudioSample(sample: number): number {
    if (!Number.isFinite(sample)) return 0;
    if (sample > 1) return 1;
    if (sample < -1) return -1;
    return sample;
  }

  private floatToInt16(sample: number): number {
    const clamped = this.clampAudioSample(sample);
    return clamped < 0
      ? Math.round(clamped * 32768)
      : Math.round(clamped * 32767);
  }

  private getMappedOutputSample(sample: number, channelIndex: number): number {
    switch (this.outputChannelMode) {
      case 'left':
        return channelIndex === 0 ? sample : 0;
      case 'right':
        return channelIndex === 1 ? sample : 0;
      case 'both':
        return sample;
      case 'mono':
      default:
        return sample;
    }
  }

  private recordOutputFrameConsumed(): void {
    const now = Date.now();
    this.outputFramesConsumed++;
    if (this.outputFirstFrameConsumedAt === null) {
      this.outputFirstFrameConsumedAt = now;
    }
    this.outputLastFrameConsumedAt = now;
  }

  private recordOutputRtAudioIssue(type: number, message: string): void {
    const runtimeLoss = this.isOutputRtAudioRuntimeLoss(type, message);
    const issue = {
      type,
      typeName: this.describeRtAudioErrorType(type),
      message,
      at: Date.now(),
      fatal: runtimeLoss || this.isFatalRtAudioErrorType(type),
    };
    this.outputRtAudioErrors.push(issue);
    if (this.outputRtAudioErrors.length > 10) {
      this.outputRtAudioErrors.shift();
    }

    if (!issue.fatal) {
      this.logOutputRtAudioIssueRateLimited('RtAudio output callback warning', issue);
      return;
    }

    if (runtimeLoss && this.outputRuntimeLossEmitted) {
      this.logOutputRtAudioIssueRateLimited('RtAudio output runtime error suppressed', issue, false);
      return;
    }

    if (runtimeLoss) {
      this.outputRuntimeLossEmitted = true;
    }

    logger.error('RtAudio output runtime error', issue);
    this.emit('error', new Error(`RtAudio output runtime error (${type}): ${message}`));
  }

  private logOutputRtAudioIssueRateLimited(message: string, issue: RtAudioIssue, logFirst = true): void {
    const key = `${message}:${issue.type}:${issue.message}`;
    const state = this.outputRtAudioIssueLogState.get(key);

    if (!state) {
      this.outputRtAudioIssueLogState.set(key, {
        lastLoggedAt: issue.at,
        suppressedCount: logFirst ? 0 : 1,
      });
      if (logFirst) {
        logger.warn(message, issue);
      }
      return;
    }

    const elapsedMs = issue.at - state.lastLoggedAt;
    if (elapsedMs < RTAUDIO_OUTPUT_WARNING_LOG_WINDOW_MS) {
      state.suppressedCount++;
      return;
    }

    const suppressedCount = state.suppressedCount;
    state.lastLoggedAt = issue.at;
    state.suppressedCount = 0;
    logger.warn(message, {
      ...issue,
      suppressedCount,
      suppressWindowMs: RTAUDIO_OUTPUT_WARNING_LOG_WINDOW_MS,
    });
  }

  private isOutputRtAudioRuntimeLoss(type: number, message: string): boolean {
    if (this.isFatalRtAudioErrorType(type)) {
      return false;
    }

    const normalized = message.toLowerCase();
    if (normalized.includes('no open stream to close')) {
      return false;
    }

    if (this.isAndroidBridgeAlsaOutputUnderrun(normalized)) {
      return false;
    }

    return normalized.includes('no such device')
      || normalized.includes('audio write error')
      || normalized.includes('device unavailable')
      || normalized.includes('invalid device');
  }

  private isAndroidBridgeAlsaOutputUnderrun(normalizedMessage: string): boolean {
    return process.env.TX5DR_RUNTIME_FLAVOR === 'android-bridge'
      && normalizedMessage.includes('rtapialsa::callbackevent')
      && normalizedMessage.includes('audio write error')
      && normalizedMessage.includes('underrun');
  }

  private isFatalRtAudioErrorType(type: number): boolean {
    return type !== RTAUDIO_ERROR_WARNING && type !== RTAUDIO_ERROR_DEBUG_WARNING;
  }

  private describeRtAudioErrorType(type: number): string {
    switch (type) {
      case 0:
        return 'WARNING';
      case 1:
        return 'DEBUG_WARNING';
      case 2:
        return 'UNSPECIFIED';
      case 3:
        return 'NO_DEVICES_FOUND';
      case 4:
        return 'INVALID_DEVICE';
      case 5:
        return 'MEMORY_ERROR';
      case 6:
        return 'INVALID_PARAMETER';
      case 7:
        return 'INVALID_USE';
      case 8:
        return 'DRIVER_ERROR';
      case 9:
        return 'SYSTEM_ERROR';
      case 10:
        return 'THREAD_ERROR';
      default:
        return `UNKNOWN_${type}`;
    }
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

  private computeAudioStats(samples: Float32Array): AudioStats {
    if (samples.length === 0) {
      return { peak: 0, rms: 0 };
    }

    let peak = 0;
    let sumSquares = 0;
    for (let i = 0; i < samples.length; i++) {
      const value = samples[i] || 0;
      const abs = Math.abs(value);
      if (abs > peak) {
        peak = abs;
      }
      sumSquares += value * value;
    }

    return {
      peak,
      rms: Math.sqrt(sumSquares / samples.length),
    };
  }

  private computeAudioSegmentStats(samples: Float32Array, sampleRate: number, segmentCount = 4): AudioSegmentStats[] {
    if (samples.length === 0 || sampleRate <= 0 || segmentCount <= 0) {
      return [];
    }

    const segmentLength = Math.max(1, Math.ceil(samples.length / segmentCount));
    const segments: AudioSegmentStats[] = [];
    for (let index = 0; index < segmentCount; index++) {
      const start = index * segmentLength;
      if (start >= samples.length) {
        break;
      }
      const end = Math.min(samples.length, start + segmentLength);
      const stats = this.computeAudioStats(samples.subarray(start, end));
      segments.push({
        index,
        startMs: Math.round((start / sampleRate) * 1000),
        endMs: Math.round((end / sampleRate) * 1000),
        peak: Number(stats.peak.toFixed(6)),
        rms: Number(stats.rms.toFixed(6)),
      });
    }

    return segments;
  }

  private fingerprintAudio(samples: Float32Array): string {
    let hash = 0x811c9dc5;
    if (samples.length === 0) {
      return hash.toString(16);
    }

    const stride = Math.max(1, Math.floor(samples.length / 4096));
    for (let i = 0; i < samples.length; i += stride) {
      const quantized = Math.max(-32768, Math.min(32767, Math.round((samples[i] || 0) * 32767)));
      hash ^= quantized & 0xff;
      hash = Math.imul(hash, 0x01000193);
      hash ^= (quantized >> 8) & 0xff;
      hash = Math.imul(hash, 0x01000193);
    }

    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  private getOutputBackendSnapshot(): OutputBackendSnapshot {
    return this.getRtAudioBackendSnapshot(this.rtAudioOutput);
  }

  private getRtAudioBackendSnapshot(stream: RtAudioInstance | null): OutputBackendSnapshot {
    if (!stream) {
      return { error: 'RtAudio stream unavailable' };
    }
    const snapshot: OutputBackendSnapshot = {};
    try {
      snapshot.api = stream.getApi();
    } catch (error) {
      snapshot.error = `getApi failed: ${this.describeError(error)}`;
    }

    try {
      snapshot.streamOpen = stream.isStreamOpen();
    } catch (error) {
      snapshot.error = this.appendSnapshotError(snapshot.error, `isStreamOpen failed: ${this.describeError(error)}`);
    }

    try {
      snapshot.streamRunning = stream.isStreamRunning();
    } catch (error) {
      snapshot.error = this.appendSnapshotError(snapshot.error, `isStreamRunning failed: ${this.describeError(error)}`);
    }

    try {
      snapshot.streamLatencyFrames = stream.getStreamLatency();
    } catch (error) {
      snapshot.error = this.appendSnapshotError(snapshot.error, `getStreamLatency failed: ${this.describeError(error)}`);
    }

    try {
      snapshot.streamSampleRate = stream.getStreamSampleRate();
    } catch (error) {
      snapshot.error = this.appendSnapshotError(snapshot.error, `getStreamSampleRate failed: ${this.describeError(error)}`);
    }

    return snapshot;
  }

  private cleanupRtAudioStream(kind: 'input' | 'output', stream: RtAudioInstance, reason: string): void {
    const before = this.getRtAudioBackendSnapshot(stream);
    logger.info(`audio ${kind} stream cleanup starting`, { reason, before });

    if (before.streamOpen !== false && before.streamRunning !== false) {
      try {
        stream.stop();
      } catch (error) {
        logger.error(`failed to stop audio ${kind} stream`, { reason, error: this.describeError(error), before });
      }
    } else {
      logger.debug(`skip stopping audio ${kind} stream`, { reason, before });
    }

    const afterStop = this.getRtAudioBackendSnapshot(stream);
    if (afterStop.streamOpen !== false) {
      try {
        stream.closeStream();
      } catch (error) {
        logger.error(`failed to close audio ${kind} stream`, { reason, error: this.describeError(error), afterStop });
      }
    } else {
      logger.debug(`skip closing audio ${kind} stream; already closed`, { reason, afterStop });
    }

    logger.info(`audio ${kind} stream cleanup finished`, {
      reason,
      before,
      afterStop,
      afterClose: this.getRtAudioBackendSnapshot(stream),
    });
  }

  private appendSnapshotError(existing: string | undefined, next: string): string {
    return existing ? `${existing}; ${next}` : next;
  }

  private describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private shouldRunRtAudioConsumeDiagnostics(): boolean {
    return process.env.TX5DR_RTAUDIO_CONSUME_DIAGNOSTICS === '1'
      || process.env.TX5DR_FORCE_WINDOWS_AUDIO_WATCHDOG === '1';
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
    const playbackId = ++this.playbackSequence;
    const diagnosticContext = options.diagnosticContext ?? {};

    // 检查是否使用 ICOM WLAN 输出（零重采样优化）
    if (this.usingIcomWlanOutput && this.icomWlanAudioAdapter) {
      const icomWlanAudioAdapter = this.icomWlanAudioAdapter;
      logger.info('playing audio via ICOM WLAN output (zero-resample)', {
        playbackId,
        ...diagnosticContext,
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

    if (this.usingAndroidOutput && this.androidAudioOutput) {
      if (!this.isOutputting) {
        throw new Error('Android audio output stream not started');
      }
      this.playing = true;
      this.playbackStartTime = playStartTime;
      this.currentPlaybackKind = playbackKind;
      this.shouldStopPlayback = false;
      const playbackPromise = (async () => {
        const playbackData = targetSampleRate === this.outputSampleRate
          ? audioData
          : await resampleAudioProfessional(audioData, targetSampleRate, this.outputSampleRate, 1);
        const chunkSize = Math.max(64, this.outputBufferSize || 1024);
        const hrStart = performance.now();
        let samplesWritten = 0;
        for (let offset = 0; offset < playbackData.length; offset += chunkSize) {
          if (this.shouldStopPlayback) throw new Error('playback interrupted');
          const chunk = playbackData.subarray(offset, Math.min(offset + chunkSize, playbackData.length));
          const wrote = await this.androidAudioOutput?.write(chunk, this.volumeGain);
          if (!wrote) {
            throw new Error('Android audio output write failed');
          }
          if (options.injectIntoMonitor) {
            this.emit('txMonitorAudioData', { samples: chunk, sampleRate: this.outputSampleRate });
          }
          samplesWritten += chunk.length;
          const targetElapsedMs = (samplesWritten / this.outputSampleRate) * 1000 - 80;
          const waitMs = targetElapsedMs - (performance.now() - hrStart);
          if (waitMs > 0) await new Promise<void>(res => setTimeout(res, Math.min(waitMs, 20)));
        }
      })();
      this.currentPlaybackPromise = playbackPromise;
      try {
        await playbackPromise;
      } finally {
        if (this.currentPlaybackPromise === playbackPromise) {
          this.playing = false;
          this.currentPlaybackPromise = null;
          this.currentPlaybackKind = null;
          this.currentAudioData = null;
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
      playbackId,
      ...diagnosticContext,
      startTime: new Date(playStartTime).toISOString(),
      samples: audioData.length,
      sourceSampleRate: targetSampleRate,
      duration: `${(audioData.length / targetSampleRate).toFixed(2)}s`,
      targetSampleRate: this.outputSampleRate,
      volumeGain: this.volumeGain.toFixed(2),
      outputSampleFormat: this.outputSampleFormat,
      outputChannelMode: this.outputChannelMode,
      outputChannels: this.outputChannels,
    });

    // 保存当前播放的Promise
    let playbackPromise: Promise<void> | null = null;
    playbackPromise = (async () => {
      try {
      let playbackData: Float32Array;

      // 检查是否需要重采样（12kHz → 设备采样率）
      if (targetSampleRate !== this.outputSampleRate) {
        logger.debug(`resampling for playback: ${targetSampleRate}Hz -> ${this.outputSampleRate}Hz`);
        playbackData = await resampleAudioProfessional(
          audioData,
          targetSampleRate,
          this.outputSampleRate,
          1 // 单声道
        );
        logger.debug(`resample complete: ${audioData.length} -> ${playbackData.length} samples`);
      } else {
        logger.debug('sample rate matches, no resample needed');
        playbackData = audioData;
      }

      // 保存当前播放的音频数据（仅用于调试/查询，不再原地修改）
      this.currentAudioData = playbackData;
      this.currentSampleRate = this.outputSampleRate;
      const sourceStats = this.computeAudioStats(playbackData);
      const sourceSegments = this.computeAudioSegmentStats(playbackData, this.outputSampleRate);
      const sourceFingerprint = this.fingerprintAudio(playbackData);
      logger.info('audio playback source analysis', {
        playbackId,
        ...diagnosticContext,
        samples: playbackData.length,
        sampleRate: this.outputSampleRate,
        fingerprint: sourceFingerprint,
        peak: Number(sourceStats.peak.toFixed(6)),
        rms: Number(sourceStats.rms.toFixed(6)),
        segments: sourceSegments,
      });
      
      // 分块播放，使用 setInterval 高频轮询 + 追赶写入
      // 相比链式 await setTimeout，setInterval 在事件循环延迟后能立即追赶
      const TICK_MS = 5;
      const framesPerBuffer = Math.max(64, this.outputBufferSize || 1024);
      const chunkSize = framesPerBuffer;
      const totalChunks = Math.ceil(playbackData.length / chunkSize);

      // 预缓冲目标（~85ms），控制延迟的同时避免 underrun
      const prebufferMs = Math.max(60, Math.min(200, Math.round((framesPerBuffer / this.outputSampleRate) * 1000 * 4)));
      const prebufferSamples = Math.ceil((prebufferMs / 1000) * this.outputSampleRate);

      const totalSamples = playbackData.length;
      const expectedDurationMs = Math.round((totalSamples / this.outputSampleRate) * 1000);
      logger.debug(`chunked playback: ${totalChunks} chunks, chunkSize=${chunkSize}, prebuffer~${prebufferMs}ms, tick=${TICK_MS}ms, totalSamples=${totalSamples}, expectedDuration=${expectedDurationMs}ms`);

      const chunkStartTime = Date.now();
      this.resetOutputConsumeDiagnostics();
      const watchdogGeneration = this.outputWatchdogGeneration;
      const consumeDiagnosticsEnabled = this.shouldRunRtAudioConsumeDiagnostics();
      let submittedChunks = 0;
      let submittedSamples = 0;
      let writeFailCount = 0;
      let postGainPeak = 0;
      let postGainSumSquares = 0;
      let postGainSampleCount = 0;
      let watchdogTriggered = false;
      let watchdogTimer: NodeJS.Timeout | null = null;
      const watchdogStartedAt = Date.now();

      const stopWatchdog = () => {
        if (watchdogTimer) {
          clearInterval(watchdogTimer);
          watchdogTimer = null;
        }
      };

      if (consumeDiagnosticsEnabled) {
        watchdogTimer = setInterval(() => {
          if (watchdogGeneration !== this.outputWatchdogGeneration) {
            stopWatchdog();
            return;
          }
          if (watchdogTriggered) {
            return;
          }

          const consumedChunks = this.outputFramesConsumed;
          const lastConsumeAt = this.outputLastFrameConsumedAt;
          const msSinceConsume = Date.now() - (lastConsumeAt ?? watchdogStartedAt);
          if (
            submittedChunks >= RTAUDIO_TX_WATCHDOG_MIN_SUBMITTED_CHUNKS &&
            submittedChunks > consumedChunks + 1 &&
            msSinceConsume >= RTAUDIO_TX_CONSUME_WATCHDOG_MS
          ) {
            watchdogTriggered = true;
            const error = new Error('Windows RtAudio output submitted audio but no frame consumption was observed');
            logger.error('Windows RtAudio output consume watchdog fired', {
              playbackId,
              ...diagnosticContext,
              submittedChunks,
              submittedSamples,
              consumedChunks,
              msSinceConsume,
              totalChunks,
              backend: this.getOutputBackendSnapshot(),
              recentRtAudioErrors: this.outputRtAudioErrors,
            });
            this.emit('error', error);
            stopWatchdog();
          }
        }, Math.max(50, Math.floor(RTAUDIO_TX_CONSUME_WATCHDOG_MS / 3)));
      }

      // setInterval-based playback loop wrapped in a Promise
      await new Promise<void>((resolve, reject) => {
        const hrStart = performance.now();
        let cursor = 0;
        let samplesWritten = 0;
        let lastProgressSec = -1;

        const writeChunk = (idx: number): boolean => {
          if (!this.rtAudioOutput) {
            return false;
          }
          try {
            const start = idx * chunkSize;
            const end = Math.min(start + chunkSize, playbackData.length);
            const chunk = playbackData.subarray(start, end);
            const encoded = this.encodeRtAudioOutputChunk(
              chunk,
              chunkSize,
              this.volumeGain,
              Boolean(options.injectIntoMonitor),
            );
            this.rtAudioOutput.write(encoded.buffer);
            if (encoded.monitorChunk && encoded.monitorChunk.length > 0) {
              this.emit('txMonitorAudioData', { samples: encoded.monitorChunk, sampleRate: this.outputSampleRate });
            }
            samplesWritten += encoded.sourceSamples;
            submittedChunks++;
            submittedSamples += encoded.sourceSamples;
            if (encoded.peak > postGainPeak) {
              postGainPeak = encoded.peak;
            }
            postGainSumSquares += encoded.sumSquares;
            postGainSampleCount += encoded.sourceSamples;
            return true;
          } catch (error) {
            writeFailCount++;
            if (writeFailCount <= 3 || writeFailCount % 100 === 0) {
              logger.warn('audio output write failed', {
                playbackId,
                ...diagnosticContext,
                chunk: idx,
                totalChunks,
                writtenSamples: samplesWritten,
                totalSamples,
                fails: writeFailCount,
                error: this.describeError(error),
              });
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

            if (!this.rtAudioOutput) {
              clearInterval(interval);
              reject(new Error('audio output stream unavailable during playback'));
              return;
            }

            // Check completion
            if (cursor >= totalChunks) {
              clearInterval(interval);
              const chunkDuration = Date.now() - chunkStartTime;
              const playDuration = Date.now() - playStartTime;
              logger.debug(`chunked write complete, duration: ${chunkDuration}ms`);
              logger.info('audio playback submit complete', {
                playbackId,
                ...diagnosticContext,
                durationMs: playDuration,
                expectedDurationMs,
                overheadMs: playDuration - expectedDurationMs,
                submittedChunks,
                submittedSamples,
                totalChunks,
                totalSamples,
                writeFails: writeFailCount,
                outputSampleFormat: this.outputSampleFormat,
                outputChannelMode: this.outputChannelMode,
                outputChannels: this.outputChannels,
              });
              resolve();
              return;
            }

            // Calculate target: how many samples should have been written by now + prebuffer
            const elapsedMs = performance.now() - hrStart;
            const targetSamples = Math.floor((elapsedMs / 1000) * this.outputSampleRate) + prebufferSamples;

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
              if (consumeDiagnosticsEnabled) {
                logger.info('audio playback live diagnostics', {
                  playbackId,
                  ...diagnosticContext,
                  elapsedMs: Math.round(elapsedMs),
                  submittedChunks,
                  consumedChunks: this.outputFramesConsumed,
                  pendingChunks: submittedChunks - this.outputFramesConsumed,
                  submittedSamples,
                  targetSamples,
                  postGainPeakSoFar: Number(postGainPeak.toFixed(6)),
                  postGainRmsSoFar: postGainSampleCount > 0
                    ? Number(Math.sqrt(postGainSumSquares / postGainSampleCount).toFixed(6))
                    : 0,
                  writeFails: writeFailCount,
                  backend: this.getOutputBackendSnapshot(),
                });
              }
            }
          } catch (err) {
            clearInterval(interval);
            reject(err);
          }
        }, TICK_MS);
      });

      if (consumeDiagnosticsEnabled) {
        const drainTimeoutMs = Math.max(RTAUDIO_TX_DRAIN_TIMEOUT_FLOOR_MS, prebufferMs + 500);
        const drainDeadline = Date.now() + drainTimeoutMs;
        while (
          !this.shouldStopPlayback &&
          this.outputFramesConsumed < submittedChunks &&
          Date.now() < drainDeadline
        ) {
          await new Promise<void>(res => setTimeout(res, 10));
        }
        stopWatchdog();

        const consumedChunks = this.outputFramesConsumed;
        const consumeComplete = consumedChunks >= submittedChunks;
        const postGainStats = {
          peak: postGainPeak,
          rms: postGainSampleCount > 0 ? Math.sqrt(postGainSumSquares / postGainSampleCount) : 0,
        };
        const consumeSummary = {
          playbackId,
          ...diagnosticContext,
          submittedChunks,
          submittedSamples,
          consumedChunks,
          consumeComplete,
          firstConsumedAt: this.outputFirstFrameConsumedAt
            ? new Date(this.outputFirstFrameConsumedAt).toISOString()
            : null,
          lastConsumedAt: this.outputLastFrameConsumedAt
            ? new Date(this.outputLastFrameConsumedAt).toISOString()
            : null,
          sourcePeak: Number(sourceStats.peak.toFixed(6)),
          sourceRms: Number(sourceStats.rms.toFixed(6)),
          sourceFingerprint,
          sourceSegments,
          postGainPeak: Number(postGainStats.peak.toFixed(6)),
          postGainRms: Number(postGainStats.rms.toFixed(6)),
          outputSampleFormat: this.outputSampleFormat,
          outputChannelMode: this.outputChannelMode,
          outputChannels: this.outputChannels,
          backend: this.getOutputBackendSnapshot(),
          recentRtAudioErrors: this.outputRtAudioErrors,
        };

        if (consumeComplete) {
          logger.info('audio playback consume complete', consumeSummary);
        } else {
          logger.warn('RtAudio output did not consume all submitted playback chunks before timeout', consumeSummary);
        }
      } else {
        stopWatchdog();
      }

      } catch (error) {
        if (error instanceof Error && error.message.includes('playback interrupted')) {
          logger.debug('audio playback interrupted');
        } else {
          logger.error('audio playback failed', error);
        }
        throw error;
      } finally {
        // Safe if the playback failed before the watchdog was created.
        this.outputWatchdogGeneration++;
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

    if (this.usingAndroidOutput && this.androidAudioOutput) {
      return {
        available: this.isOutputting,
        kind: 'android',
        outputSampleRate: this.outputSampleRate,
        outputBufferSize: Math.max(64, this.outputBufferSize || 1024),
      };
    }

    return {
      available: this.isOutputting && Boolean(this.rtAudioOutput),
      kind: 'rtaudio',
      outputSampleRate: this.outputSampleRate,
      outputBufferSize: Math.max(64, this.outputBufferSize || 1024),
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

    if (sink.kind === 'android') {
      return this.androidAudioOutput ? await this.androidAudioOutput.write(samples, 1) : false;
    }

    if (!this.rtAudioOutput) {
      return false;
    }

    try {
      const encoded = this.encodeRtAudioOutputChunk(
        samples,
        Math.max(1, sink.outputBufferSize || samples.length),
        1,
        false,
      );
      this.rtAudioOutput.write(encoded.buffer);
      return true;
    } catch (error) {
      logger.debug('Voice audio RtAudio write failed', error);
      return false;
    }
  }

}
