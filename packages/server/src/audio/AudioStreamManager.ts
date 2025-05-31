import * as naudiodon from 'naudiodon2';
import { RingBufferAudioProvider } from './AudioBufferProvider';
import { EventEmitter } from 'eventemitter3';
import { clearResamplerCache } from '../utils/audioUtils';

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
  private isStreaming = false;
  private audioProvider: RingBufferAudioProvider;
  private deviceId: string | null = null;
  private sampleRate: number = 48000;
  private channels: number = 1;
  
  constructor() {
    super();
    // 创建音频缓冲区提供者，使用原始采样率（48kHz）
    this.audioProvider = new RingBufferAudioProvider(this.sampleRate, 240000); // 5秒缓冲（48000 * 5）
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
      
      // 处理设备 ID
      let actualDeviceId: number | undefined = undefined;
      if (deviceId) {
        if (deviceId.startsWith('input-')) {
          actualDeviceId = parseInt(deviceId.replace('input-', ''));
        } else {
          actualDeviceId = parseInt(deviceId);
        }
        console.log(`🎯 使用指定音频输入设备 ID: ${actualDeviceId}`);
      } else {
        console.log('🎯 使用默认音频输入设备');
      }
      
      // 配置音频输入参数 - 关键：设置适当的缓冲区大小
      const inputOptions: any = {
        channelCount: this.channels,
        sampleFormat: naudiodon.SampleFormatFloat32, // 使用 float32 格式
        sampleRate: this.sampleRate,
        deviceId: actualDeviceId,
        // 关键配置：设置缓冲区大小以避免爆音
        framesPerBuffer: 1024, // 每个缓冲区的帧数（较大的值可以减少爆音）
        // 可选：设置建议的延迟
        suggestedLatency: 0.05 // 50ms 延迟，平衡延迟和稳定性
      };
      
      console.log('音频输入配置:', inputOptions);
      
      // naudiodon2 需要 inOptions 参数
      this.audioInput = new (naudiodon as any).AudioIO({
        inOptions: inputOptions
      });
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
      
      this.audioInput.on('error', (error: Error) => {
        console.error('音频输入错误:', error);
        this.emit('error', error);
      });
      
      // 启动音频流
      this.audioInput.start();
      this.isStreaming = true;
      
      console.log(`✅ 音频流启动成功 (${this.sampleRate}Hz, 缓冲区: ${inputOptions.framesPerBuffer} 帧)`);
      this.emit('started');
      
    } catch (error) {
      console.error('启动音频流失败:', error);
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
   * 获取流状态
   */
  getStatus() {
    return {
      isStreaming: this.isStreaming,
      deviceId: this.deviceId,
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
} 