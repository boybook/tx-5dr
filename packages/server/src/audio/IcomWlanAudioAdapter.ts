import { EventEmitter } from 'eventemitter3';
import libsamplerate from '@alexanderolsen/libsamplerate-js';
import { IcomWlanManager } from '../radio/IcomWlanManager.js';
import { RingBufferAudioProvider } from './AudioBufferProvider.js';

export interface IcomWlanAudioAdapterEvents {
  'audioData': (samples: Float32Array) => void;
  'error': (error: Error) => void;
}

/**
 * ICOM WLAN 音频适配器
 * 负责音频数据的接收、发送和采样率转换
 */
export class IcomWlanAudioAdapter extends EventEmitter<IcomWlanAudioAdapterEvents> {
  private icomManager: IcomWlanManager;
  private audioProvider: RingBufferAudioProvider;
  private targetSampleRate: number; // 系统采样率（48kHz）
  private icomSampleRate: number; // ICOM 采样率（12kHz）
  private isReceiving = false;

  constructor(icomManager: IcomWlanManager, targetSampleRate: number = 48000) {
    super();
    this.icomManager = icomManager;
    this.targetSampleRate = targetSampleRate;
    this.icomSampleRate = icomManager.getAudioSampleRate(); // 12000

    // 创建音频缓冲区提供者
    this.audioProvider = new RingBufferAudioProvider(this.targetSampleRate, this.targetSampleRate * 5);

    console.log(`🎵 [IcomWlanAudioAdapter] 初始化完成: ${this.icomSampleRate}Hz → ${this.targetSampleRate}Hz`);
  }

  /**
   * 开始接收音频
   */
  startReceiving(): void {
    if (this.isReceiving) {
      console.log('⚠️ [IcomWlanAudioAdapter] 已经在接收音频');
      return;
    }

    console.log('🎤 [IcomWlanAudioAdapter] 开始接收音频...');

    // 订阅 ICOM 音频事件
    this.icomManager.on('audioFrame', this.handleAudioFrame.bind(this));

    this.isReceiving = true;
    console.log('✅ [IcomWlanAudioAdapter] 音频接收已启动');
  }

  /**
   * 停止接收音频
   */
  stopReceiving(): void {
    if (!this.isReceiving) {
      console.log('⚠️ [IcomWlanAudioAdapter] 未在接收音频');
      return;
    }

    console.log('🛑 [IcomWlanAudioAdapter] 停止接收音频...');

    // 取消订阅
    this.icomManager.off('audioFrame', this.handleAudioFrame.bind(this));

    this.isReceiving = false;
    console.log('✅ [IcomWlanAudioAdapter] 音频接收已停止');
  }

  /**
   * 处理 ICOM 音频帧
   */
  private async handleAudioFrame(pcm16: Buffer): Promise<void> {
    try {
      // 将 PCM16 Buffer 转换为 Float32Array
      const samples12kHz = this.pcm16ToFloat32(pcm16);

      // 重采样：12kHz → 48kHz
      const samples48kHz = await this.resample(samples12kHz, this.icomSampleRate, this.targetSampleRate);

      // 存储到环形缓冲区
      this.audioProvider.writeAudio(samples48kHz);

      // 发出事件
      this.emit('audioData', samples48kHz);

    } catch (error) {
      console.error('❌ [IcomWlanAudioAdapter] 处理音频帧失败:', error);
      this.emit('error', error as Error);
    }
  }

  /**
   * 发送音频数据（用于发射）
   */
  async sendAudio(samples: Float32Array): Promise<void> {
    try {
      console.log(`🔊 [IcomWlanAudioAdapter] 发送音频: ${samples.length} 样本 @ ${this.targetSampleRate}Hz`);

      // 重采样：48kHz → 12kHz
      const samples12kHz = await this.resample(samples, this.targetSampleRate, this.icomSampleRate);

      console.log(`🔄 [IcomWlanAudioAdapter] 重采样完成: ${samples.length} → ${samples12kHz.length} 样本`);

      // 发送到 ICOM 电台
      await this.icomManager.sendAudio(samples12kHz);

      console.log(`✅ [IcomWlanAudioAdapter] 音频发送成功`);

    } catch (error) {
      console.error('❌ [IcomWlanAudioAdapter] 发送音频失败:', error);
      throw error;
    }
  }

  /**
   * 重采样音频
   */
  private async resample(samples: Float32Array, fromRate: number, toRate: number): Promise<Float32Array> {
    if (fromRate === toRate) {
      return samples;
    }

    try {
      const resampler = await libsamplerate.create(
        1, // 单声道
        fromRate,
        toRate,
        {
          converterType: libsamplerate.ConverterType.SRC_SINC_FASTEST
        }
      );

      const resampled = await resampler.simple(samples);
      return resampled;

    } catch (error) {
      console.error(`❌ [IcomWlanAudioAdapter] 重采样失败 (${fromRate}Hz → ${toRate}Hz):`, error);

      // 备用方案：线性插值
      console.log('🔄 [IcomWlanAudioAdapter] 使用备用重采样方案');
      return this.linearResample(samples, fromRate, toRate);
    }
  }

  /**
   * 线性插值重采样（备用方案）
   */
  private linearResample(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
    const ratio = toRate / fromRate;
    const newLength = Math.floor(samples.length * ratio);
    const resampled = new Float32Array(newLength);

    for (let i = 0; i < newLength; i++) {
      const sourceIndex = i / ratio;
      const index = Math.floor(sourceIndex);
      const fraction = sourceIndex - index;

      if (index + 1 < samples.length) {
        resampled[i] = samples[index] * (1 - fraction) + samples[index + 1] * fraction;
      } else {
        resampled[i] = samples[index] || 0;
      }
    }

    return resampled;
  }

  /**
   * PCM16 Buffer 转换为 Float32Array
   */
  private pcm16ToFloat32(buffer: Buffer): Float32Array {
    const samples = new Float32Array(buffer.length / 2);

    for (let i = 0; i < samples.length; i++) {
      // 读取 16 位有符号整数（小端）
      const int16 = buffer.readInt16LE(i * 2);
      // 转换为 [-1.0, 1.0] 范围的浮点数
      samples[i] = int16 / 32768.0;
    }

    return samples;
  }

  /**
   * 获取音频缓冲区提供者
   */
  getAudioProvider(): RingBufferAudioProvider {
    return this.audioProvider;
  }

  /**
   * 获取接收状态
   */
  isReceivingAudio(): boolean {
    return this.isReceiving;
  }

  /**
   * 清空音频缓冲区
   */
  clearBuffer(): void {
    this.audioProvider.clear();
  }

  /**
   * 获取目标采样率
   */
  getTargetSampleRate(): number {
    return this.targetSampleRate;
  }

  /**
   * 获取 ICOM 采样率
   */
  getIcomSampleRate(): number {
    return this.icomSampleRate;
  }
}
