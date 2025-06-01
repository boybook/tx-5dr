import { EventEmitter } from 'eventemitter3';

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
   */
  addAudio(operatorId: string, audioData: Float32Array, sampleRate: number, scheduledTime: number): void {
    const duration = audioData.length / sampleRate;
    
    console.log(`🎵 [音频混音器] 添加音频: 操作员=${operatorId}, 时长=${duration.toFixed(2)}s, 计划时间=${new Date(scheduledTime).toISOString()}`);
    
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
    }
    
    // 设置新的混音定时器
    this.mixingTimeout = setTimeout(() => {
      this.processMixing();
    }, this.mixingWindowMs);
    
    console.log(`⏰ [音频混音器] 设置混音定时器，${this.mixingWindowMs}ms后执行混音`);
  }

  /**
   * 处理音频混音
   */
  private processMixing(): void {
    if (this.pendingAudios.size === 0) {
      console.log(`⚠️ [音频混音器] 没有待混音的音频`);
      return;
    }

    const audioList = Array.from(this.pendingAudios.values());
    const operatorIds = audioList.map(audio => audio.operatorId);
    
    console.log(`🎛️ [音频混音器] 开始混音: ${audioList.length}个音频, 操作员=[${operatorIds.join(', ')}]`);

    if (audioList.length === 1) {
      // 只有一个音频，直接输出
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
      const mixedAudio = this.mixAudios(audioList);
      console.log(`🎵 [音频混音器] 混音完成: ${audioList.length}个音频 -> 1个混合音频, 时长=${mixedAudio.duration.toFixed(2)}s`);
      this.emit('mixedAudioReady', mixedAudio);
    }

    // 清空待混音队列
    this.pendingAudios.clear();
    this.mixingTimeout = null;
  }

  /**
   * 混合多个音频
   */
  private mixAudios(audioList: PendingAudio[]): MixedAudio {
    // 找到目标采样率（使用最高的采样率）
    const targetSampleRate = Math.max(...audioList.map(a => a.sampleRate));
    console.log(`🎛️ [音频混音器] 目标采样率: ${targetSampleRate}Hz`);

    // 重采样所有音频到目标采样率
    const resampledAudios = audioList.map(audio => {
      if (audio.sampleRate === targetSampleRate) {
        console.log(`✅ [音频混音器] 操作员 ${audio.operatorId}: 采样率匹配，无需重采样`);
        return {
          operatorId: audio.operatorId,
          samples: audio.audioData,
          duration: audio.duration
        };
      } else {
        console.log(`🔄 [音频混音器] 操作员 ${audio.operatorId}: 重采样 ${audio.sampleRate}Hz -> ${targetSampleRate}Hz`);
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
        console.log(`🔄 [音频混音器] 操作员 ${audio.operatorId}: 重采样完成 ${audio.audioData.length} -> ${newLength} 样本, 时长 ${audio.duration.toFixed(2)}s -> ${newDuration.toFixed(2)}s`);
        
        return {
          operatorId: audio.operatorId,
          samples: resampled,
          duration: newDuration
        };
      }
    });

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
  public forceMix(): void {
    if (this.mixingTimeout) {
      clearTimeout(this.mixingTimeout);
      this.mixingTimeout = null;
    }
    this.processMixing();
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