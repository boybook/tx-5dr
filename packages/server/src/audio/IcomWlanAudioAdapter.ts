import { EventEmitter } from 'eventemitter3';
import { IcomWlanConnection } from '../radio/connections/IcomWlanConnection.js';
import type { AudioFrameMeta } from '../radio/connections/IRadioConnection.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('IcomWlanAudioAdapter');

export interface IcomWlanAudioAdapterEvents {
  'audioData': (samples: Float32Array, meta?: AudioFrameMeta) => void;
  'error': (error: Error) => void;
}

/**
 * ICOM WLAN 音频适配器
 * 负责音频数据的接收和发送（零重采样优化：ICOM 原生 12kHz）
 *
 * 注意：本适配器只负责协议转换（PCM16 ↔ Float32）并通过 'audioData' 事件转发，
 * RX 时间线的环形缓冲区统一由 AudioStreamManager 维护（见 ingestInputSamples）。
 */
export class IcomWlanAudioAdapter extends EventEmitter<IcomWlanAudioAdapterEvents> {
  private icomConnection: IcomWlanConnection;
  private icomSampleRate: number; // ICOM 采样率（12kHz）
  private isReceiving = false;

  constructor(icomConnection: IcomWlanConnection) {
    super();
    this.icomConnection = icomConnection;
    this.icomSampleRate = icomConnection.getAudioSampleRate(); // 12000

    logger.info(`Initialized with ICOM native sample rate ${this.icomSampleRate}Hz (zero-resample optimization)`);
  }

  /**
   * 开始接收音频
   */
  startReceiving(): void {
    if (this.isReceiving) {
      logger.warn('Already receiving audio');
      return;
    }

    logger.info('Starting audio reception');

    // 订阅 ICOM 音频事件
    this.icomConnection.on('audioFrame', this.handleAudioFrame.bind(this));

    this.isReceiving = true;
    logger.info('Audio reception started');
  }

  /**
   * 停止接收音频
   */
  stopReceiving(): void {
    if (!this.isReceiving) {
      logger.warn('Not currently receiving audio');
      return;
    }

    logger.info('Stopping audio reception');

    // 取消订阅
    this.icomConnection.off('audioFrame', this.handleAudioFrame.bind(this));

    this.isReceiving = false;
    logger.info('Audio reception stopped');
  }

  /**
   * 处理 ICOM 音频帧（零重采样优化）
   */
  private handleAudioFrame(pcm16: Buffer, meta?: AudioFrameMeta): void {
    try {
      // 将 PCM16 Buffer 转换为 Float32Array
      const samples12kHz = this.pcm16ToFloat32(pcm16);

      // 转发给 AudioStreamManager 统一写入 RX 时间线（ICOM 原生 12kHz，无需重采样）
      // 透传线级 seq/timestamp 供 RingBuffer 做精确丢包检测
      this.emit('audioData', samples12kHz, meta);

    } catch (error) {
      logger.error('Failed to process audio frame', error);
      this.emit('error', error as Error);
    }
  }

  /**
   * 发送音频数据（用于发射，零重采样优化）
   */
  async sendAudio(samples: Float32Array): Promise<void> {
    try {
      // console.debug(`🔊 [IcomWlanAudioAdapter] 发送音频: ${samples.length} 样本 @ ${this.icomSampleRate}Hz（零重采样优化）`);

      // 直接发送到 ICOM 电台（已经是 12kHz，无需重采样）
      await this.icomConnection.sendAudio(samples);

      // console.debug(`✅ [IcomWlanAudioAdapter] 音频发送成功`);

    } catch (error) {
      logger.error('Failed to send audio', error);
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
   * 获取接收状态
   */
  isReceivingAudio(): boolean {
    return this.isReceiving;
  }

  /**
   * 获取 ICOM 采样率（即系统统一采样率 12kHz）
   */
  getSampleRate(): number {
    return this.icomSampleRate;
  }
}
