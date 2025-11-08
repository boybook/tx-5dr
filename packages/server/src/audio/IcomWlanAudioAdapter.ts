import { EventEmitter } from 'eventemitter3';
import { IcomWlanConnection } from '../radio/connections/IcomWlanConnection.js';
import { RingBufferAudioProvider } from './AudioBufferProvider.js';

export interface IcomWlanAudioAdapterEvents {
  'audioData': (samples: Float32Array) => void;
  'error': (error: Error) => void;
}

/**
 * ICOM WLAN 音频适配器
 * 负责音频数据的接收和发送（零重采样优化：ICOM 原生 12kHz）
 */
export class IcomWlanAudioAdapter extends EventEmitter<IcomWlanAudioAdapterEvents> {
  private icomConnection: IcomWlanConnection;
  private audioProvider: RingBufferAudioProvider;
  private icomSampleRate: number; // ICOM 采样率（12kHz）
  private isReceiving = false;

  constructor(icomConnection: IcomWlanConnection) {
    super();
    this.icomConnection = icomConnection;
    this.icomSampleRate = icomConnection.getAudioSampleRate(); // 12000

    // 创建音频缓冲区提供者（使用 ICOM 原生采样率 12kHz）
    this.audioProvider = new RingBufferAudioProvider(this.icomSampleRate, this.icomSampleRate * 5);

    console.log(`🎵 [IcomWlanAudioAdapter] 初始化完成: 使用 ICOM 原生采样率 ${this.icomSampleRate}Hz（零重采样优化）`);
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
    this.icomConnection.on('audioFrame', this.handleAudioFrame.bind(this));

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
    this.icomConnection.off('audioFrame', this.handleAudioFrame.bind(this));

    this.isReceiving = false;
    console.log('✅ [IcomWlanAudioAdapter] 音频接收已停止');
  }

  /**
   * 处理 ICOM 音频帧（零重采样优化）
   */
  private handleAudioFrame(pcm16: Buffer): void {
    try {
      // 将 PCM16 Buffer 转换为 Float32Array
      const samples12kHz = this.pcm16ToFloat32(pcm16);

      // 直接存储到环形缓冲区（ICOM 原生 12kHz，无需重采样）
      this.audioProvider.writeAudio(samples12kHz);

      // 发出事件
      this.emit('audioData', samples12kHz);

    } catch (error) {
      console.error('❌ [IcomWlanAudioAdapter] 处理音频帧失败:', error);
      this.emit('error', error as Error);
    }
  }

  /**
   * 发送音频数据（用于发射，零重采样优化）
   */
  async sendAudio(samples: Float32Array): Promise<void> {
    try {
      console.log(`🔊 [IcomWlanAudioAdapter] 发送音频: ${samples.length} 样本 @ ${this.icomSampleRate}Hz（零重采样优化）`);

      // 直接发送到 ICOM 电台（已经是 12kHz，无需重采样）
      await this.icomConnection.sendAudio(samples);

      console.log(`✅ [IcomWlanAudioAdapter] 音频发送成功`);

    } catch (error) {
      console.error('❌ [IcomWlanAudioAdapter] 发送音频失败:', error);
      throw error;
    }
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
   * 获取 ICOM 采样率（即系统统一采样率 12kHz）
   */
  getSampleRate(): number {
    return this.icomSampleRate;
  }
}
