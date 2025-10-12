import { EventEmitter } from 'eventemitter3';
import libsamplerate from '@alexanderolsen/libsamplerate-js';

export interface MixedAudio {
  audioData: Float32Array;
  sampleRate: number;
  duration: number;
  operatorIds: string[];
}

export interface PendingAudio {
  operatorId: string;
  audioData: Float32Array;
  sampleRate: number;
  duration: number;
  scheduledTime: number; // 计划播放的时间戳
}

/**
 * 音频混音器 - 用于将多个操作员的音频混合成一个音频流
 */
export class AudioMixer extends EventEmitter {
  private pendingAudios: Map<string, PendingAudio> = new Map(); // 按操作员ID存储待混音音频
  private mixingTimeout: NodeJS.Timeout | null = null;
  private readonly mixingWindowMs: number = 100; // 混音窗口时间，100ms内的音频会被混音

  constructor(mixingWindowMs: number = 100) {
    super();
    this.mixingWindowMs = mixingWindowMs;
  }

  /**
   * 添加待混音的音频
   * @param targetPlaybackTime 目标播放时间（可选），如果提供则智能调度
   */
  addAudio(operatorId: string, audioData: Float32Array, sampleRate: number, scheduledTime: number, targetPlaybackTime?: number): void {
    const addStartTime = Date.now();
    const duration = audioData.length / sampleRate;

    console.log(`🎵 [音频混音器] 添加音频: 操作员=${operatorId}, 时长=${duration.toFixed(2)}s, 计划时间=${new Date(scheduledTime).toISOString()}, 目标播放=${targetPlaybackTime ? new Date(targetPlaybackTime).toISOString() : '立即'}, 添加时间=${new Date(addStartTime).toISOString()}`);

    const pendingAudio: PendingAudio = {
      operatorId,
      audioData,
      sampleRate,
      duration,
      scheduledTime
    };

    // 存储待混音音频（按操作员ID存储，如果同一操作员有多个音频，只保留最新的）
    this.pendingAudios.set(operatorId, pendingAudio);

    // 清除之前的定时器
    if (this.mixingTimeout) {
      clearTimeout(this.mixingTimeout);
      console.log(`⏰ [音频混音器] 清除之前的混音定时器`);
    }

    // 计算智能混音窗口
    let mixingDelay = this.mixingWindowMs;

    if (targetPlaybackTime) {
      // 如果提供了目标播放时间，计算到目标时间的延迟
      const now = Date.now();
      const timeUntilTarget = targetPlaybackTime - now;

      if (timeUntilTarget > this.mixingWindowMs) {
        // 距离目标播放时间还很远，等待到接近目标时间再混音
        mixingDelay = Math.max(0, timeUntilTarget - 50); // 提前50ms混音
        console.log(`⏰ [音频混音器] 智能调度: 距离目标时间${timeUntilTarget}ms, 将在${mixingDelay}ms后混音`);
      } else if (timeUntilTarget > 0) {
        // 快到目标时间了，立即混音
        mixingDelay = Math.max(0, timeUntilTarget);
        console.log(`⏰ [音频混音器] 智能调度: 目标时间即将到达(${timeUntilTarget}ms), 立即混音`);
      } else {
        // 已经过了目标时间，立即混音
        mixingDelay = 0;
        console.warn(`⚠️ [音频混音器] 警告: 已过目标播放时间${Math.abs(timeUntilTarget)}ms, 立即混音`);
      }
    }

    // 设置新的混音定时器
    const timerStartTime = Date.now();
    if (mixingDelay > 0) {
      this.mixingTimeout = setTimeout(async () => {
        const timerTriggerTime = Date.now();
        const timerDelay = timerTriggerTime - timerStartTime;
        console.log(`⏰ [音频混音器] 定时器触发: 实际延迟=${timerDelay}ms, 触发时间=${new Date(timerTriggerTime).toISOString()}`);
        await this.processMixing();
      }, mixingDelay);

      console.log(`⏰ [音频混音器] 设置混音定时器，${mixingDelay}ms后执行混音, 设置时间=${new Date(timerStartTime).toISOString()}`);
    } else {
      // 立即混音
      console.log(`⏰ [音频混音器] 立即执行混音`);
      this.processMixing();
    }
  }

  /**
   * 处理音频混音
   */
  private async processMixing(): Promise<void> {
    const processingStartTime = Date.now();
    console.log(`🎛️ [音频混音器] processMixing开始: ${new Date(processingStartTime).toISOString()}`);
    
    if (this.pendingAudios.size === 0) {
      console.log(`⚠️ [音频混音器] 没有待混音的音频`);
      return;
    }

    const audioList = Array.from(this.pendingAudios.values());
    const operatorIds = audioList.map(audio => audio.operatorId);
    
    console.log(`🎛️ [音频混音器] 开始混音: ${audioList.length}个音频, 操作员=[${operatorIds.join(', ')}]`);

    try {
      if (audioList.length === 1) {
        // 只有一个音频，直接输出（快速路径）
        const single = audioList[0];
        console.log(`🔊 [音频混音器] 单一音频直接输出`);
        
        const mixedAudio: MixedAudio = {
          audioData: single.audioData,
          sampleRate: single.sampleRate,
          duration: single.duration,
          operatorIds: [single.operatorId]
        };
        
        this.emit('mixedAudioReady', mixedAudio);
      } else {
        // 多个音频需要混音
        const mixedAudio = await this.mixAudios(audioList);
        console.log(`🎵 [音频混音器] 混音完成: ${audioList.length}个音频 -> 1个混合音频, 时长=${mixedAudio.duration.toFixed(2)}s`);
        this.emit('mixedAudioReady', mixedAudio);
      }
    } catch (error) {
      console.error(`❌ [音频混音器] 混音处理失败:`, error);
      // 发射错误事件，让上层处理
      this.emit('error', error);
    }

    // 清空待混音队列
    this.pendingAudios.clear();
    this.mixingTimeout = null;
    
    const processingEndTime = Date.now();
    const processingDuration = processingEndTime - processingStartTime;
    console.log(`🎛️ [音频混音器] processMixing完成: ${new Date(processingEndTime).toISOString()}, 总耗时=${processingDuration}ms`);
  }

  /**
   * 混合多个音频
   */
  private async mixAudios(audioList: PendingAudio[]): Promise<MixedAudio> {
    const mixStartTime = Date.now();
    
    // 找到目标采样率（使用最高的采样率）
    const targetSampleRate = Math.max(...audioList.map(a => a.sampleRate));
    console.log(`🎛️ [音频混音器] 目标采样率: ${targetSampleRate}Hz`);

    // 重采样所有音频到目标采样率
    const resampledAudios = await Promise.all(audioList.map(async audio => {
      if (audio.sampleRate === targetSampleRate) {
        console.log(`✅ [音频混音器] 操作员 ${audio.operatorId}: 采样率匹配，无需重采样`);
        return {
          operatorId: audio.operatorId,
          samples: audio.audioData,
          duration: audio.duration
        };
      } else {
        console.log(`🔄 [音频混音器] 操作员 ${audio.operatorId}: 重采样 ${audio.sampleRate}Hz -> ${targetSampleRate}Hz`);
        const resampleStartTime = Date.now();
        
        try {
          // 使用libsamplerate-js进行高质量重采样
          const resampler = await libsamplerate.create(
            1, // 单声道
            audio.sampleRate,
            targetSampleRate,
            {
              converterType: libsamplerate.ConverterType.SRC_SINC_FASTEST // 最快但仍高质量的算法
            }
          );
          
          const resampled = await resampler.simple(audio.audioData);
          const newDuration = resampled.length / targetSampleRate;
          
          const resampleEndTime = Date.now();
          const resampleDuration = resampleEndTime - resampleStartTime;
          
          console.log(`🚀 [音频混音器] 操作员 ${audio.operatorId}: 原生重采样完成 ${audio.audioData.length} -> ${resampled.length} 样本, 时长 ${audio.duration.toFixed(2)}s -> ${newDuration.toFixed(2)}s, 耗时: ${resampleDuration}ms`);
          
          return {
            operatorId: audio.operatorId,
            samples: resampled,
            duration: newDuration
          };
        } catch (error) {
          console.error(`❌ [音频混音器] 操作员 ${audio.operatorId}: 原生重采样失败，使用备用方案:`, error);
          
          // 备用方案：使用原来的线性插值
          const ratio = targetSampleRate / audio.sampleRate;
          const newLength = Math.floor(audio.audioData.length * ratio);
          const resampled = new Float32Array(newLength);
          
          for (let i = 0; i < newLength; i++) {
            const sourceIndex = i / ratio;
            const index = Math.floor(sourceIndex);
            const fraction = sourceIndex - index;
            
            if (index + 1 < audio.audioData.length) {
              resampled[i] = audio.audioData[index] * (1 - fraction) + audio.audioData[index + 1] * fraction;
            } else {
              resampled[i] = audio.audioData[index] || 0;
            }
          }
          
          const newDuration = newLength / targetSampleRate;
          const resampleEndTime = Date.now();
          const resampleDuration = resampleEndTime - resampleStartTime;
          
          console.log(`🔄 [音频混音器] 操作员 ${audio.operatorId}: 备用重采样完成 ${audio.audioData.length} -> ${newLength} 样本, 时长 ${audio.duration.toFixed(2)}s -> ${newDuration.toFixed(2)}s, 耗时: ${resampleDuration}ms`);
          
          return {
            operatorId: audio.operatorId,
            samples: resampled,
            duration: newDuration
          };
        }
      }
    }));

    // 找到最长的音频长度
    const maxLength = Math.max(...resampledAudios.map(a => a.samples.length));
    console.log(`🎛️ [音频混音器] 最大音频长度: ${maxLength} 样本`);

    // 创建混合音频缓冲区
    const mixedSamples = new Float32Array(maxLength);

    // 混合所有音频
    for (const audio of resampledAudios) {
      console.log(`🎵 [音频混音器] 混合操作员 ${audio.operatorId} 的音频: ${audio.samples.length} 样本`);
      for (let i = 0; i < audio.samples.length; i++) {
        mixedSamples[i] += audio.samples[i];
      }
    }

    // 应用简单的音频归一化，防止削峰
    const peakLevel = this.findPeakLevel(mixedSamples);
    if (peakLevel > 1.0) {
      const normalizeRatio = 0.95 / peakLevel; // 归一化到95%防止硬限制
      console.log(`🔧 [音频混音器] 应用归一化: 峰值=${peakLevel.toFixed(3)}, 比率=${normalizeRatio.toFixed(3)}`);
      for (let i = 0; i < mixedSamples.length; i++) {
        mixedSamples[i] *= normalizeRatio;
      }
    } else {
      console.log(`✅ [音频混音器] 无需归一化，峰值在安全范围: ${peakLevel.toFixed(3)}`);
    }

    const finalDuration = maxLength / targetSampleRate;
    const operatorIds = audioList.map(a => a.operatorId);

    const mixEndTime = Date.now();
    const totalMixDuration = mixEndTime - mixStartTime;
    console.log(`⏱️ [音频混音器] 混音处理总耗时: ${totalMixDuration}ms`);

    return {
      audioData: mixedSamples,
      sampleRate: targetSampleRate,
      duration: finalDuration,
      operatorIds
    };
  }

  /**
   * 查找音频的峰值
   */
  private findPeakLevel(samples: Float32Array): number {
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      const abs = Math.abs(samples[i]);
      if (abs > peak) {
        peak = abs;
      }
    }
    return peak;
  }

  /**
   * 强制处理当前待混音的音频（用于立即播放）
   */
  public async forceMix(): Promise<void> {
    if (this.mixingTimeout) {
      clearTimeout(this.mixingTimeout);
      this.mixingTimeout = null;
    }
    await this.processMixing();
  }

  /**
   * 清除特定操作员的待混音音频
   */
  public clearOperatorAudio(operatorId: string): boolean {
    if (this.pendingAudios.has(operatorId)) {
      this.pendingAudios.delete(operatorId);
      console.log(`🧹 [音频混音器] 清除操作员 ${operatorId} 的待混音音频`);
      
      // 如果没有其他待混音音频，取消混音定时器
      if (this.pendingAudios.size === 0 && this.mixingTimeout) {
        clearTimeout(this.mixingTimeout);
        this.mixingTimeout = null;
      }
      
      return true;
    }
    return false;
  }

  /**
   * 清空所有待混音的音频
   */
  public clear(): void {
    if (this.mixingTimeout) {
      clearTimeout(this.mixingTimeout);
      this.mixingTimeout = null;
    }
    this.pendingAudios.clear();
    console.log(`🧹 [音频混音器] 清空所有待混音音频`);
  }

  /**
   * 获取当前待混音音频的状态
   */
  public getStatus() {
    return {
      pendingCount: this.pendingAudios.size,
      operatorIds: Array.from(this.pendingAudios.keys()),
      hasPendingMix: this.mixingTimeout !== null,
      mixingWindowMs: this.mixingWindowMs
    };
  }
} 