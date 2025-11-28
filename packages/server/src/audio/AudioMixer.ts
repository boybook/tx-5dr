import { EventEmitter } from 'eventemitter3';
import { resampleAudioProfessional } from '../utils/audioUtils.js';

export interface MixedAudio {
  audioData: Float32Array;
  sampleRate: number;
  duration: number;
  operatorIds: string[];
}

/**
 * 操作员时隙音频 - 保存每个操作员在当前时隙的原始编码音频
 */
export interface OperatorSlotAudio {
  operatorId: string;
  audioData: Float32Array;    // 原始编码音频
  sampleRate: number;
  duration: number;           // 音频总时长（秒）
  encodedAt: number;          // 编码完成时间戳
  slotStartMs: number;        // 所属时隙开始时间
  requestId?: string;         // 编码请求ID（用于去重）
}

/**
 * 音频混音器 - 用于将多个操作员的音频混合成一个音频流
 *
 * 新架构：保存每个操作员的原始编码音频，支持中途更新和重新混音
 */
export class AudioMixer extends EventEmitter {
  // 时隙音频缓存：按操作员ID存储原始编码音频
  private slotAudioCache: Map<string, OperatorSlotAudio> = new Map();

  // 当前时隙信息
  private currentSlotStartMs: number = 0;

  // 播放状态跟踪
  private playbackStartTimeMs: number = 0;
  private isPlaying: boolean = false;

  // 累计裁剪偏移量 - 用于中途更新时正确计算已播放时间
  private cumulativeOffsetMs: number = 0;

  // 混音窗口配置
  private mixingTimeout: NodeJS.Timeout | null = null;
  private readonly mixingWindowMs: number;

  constructor(mixingWindowMs: number = 100) {
    super();
    this.mixingWindowMs = mixingWindowMs;
  }

  /**
   * 添加/更新操作员的编码音频
   * 如果该操作员已有音频，则替换（支持中途更新）
   */
  addOperatorAudio(
    operatorId: string,
    audioData: Float32Array,
    sampleRate: number,
    slotStartMs: number,
    requestId?: string
  ): void {
    const existing = this.slotAudioCache.get(operatorId);
    const duration = audioData.length / sampleRate;

    // 检查是否是旧的编码结果（通过 requestId 判断）
    if (existing && requestId && existing.requestId === requestId) {
      console.log(`⚠️ [音频混音器] 忽略重复的编码结果: ${operatorId}, requestId=${requestId}`);
      return;
    }

    // 时隙切换检测：如果是新时隙，清空缓存
    if (slotStartMs !== this.currentSlotStartMs && this.currentSlotStartMs !== 0) {
      console.log(`🔄 [音频混音器] 检测到时隙切换: ${this.currentSlotStartMs} -> ${slotStartMs}`);
      this.clearSlotCache();
    }
    this.currentSlotStartMs = slotStartMs;

    // 存储/替换该操作员的音频
    const operatorAudio: OperatorSlotAudio = {
      operatorId,
      audioData,
      sampleRate,
      duration,
      encodedAt: Date.now(),
      slotStartMs,
      requestId
    };

    this.slotAudioCache.set(operatorId, operatorAudio);

    console.log(`🎵 [音频混音器] ${existing ? '更新' : '添加'}操作员音频: ${operatorId}, ` +
      `时长=${duration.toFixed(2)}s, 采样率=${sampleRate}Hz, ` +
      `requestId=${requestId || 'N/A'}, 当前缓存数=${this.slotAudioCache.size}`);
  }

  /**
   * 调度混音（设置混音窗口定时器）
   * @param targetPlaybackTime 目标播放时间（可选），用于智能调度
   */
  scheduleMixing(targetPlaybackTime?: number): void {
    // 清除之前的定时器
    if (this.mixingTimeout) {
      clearTimeout(this.mixingTimeout);
      this.mixingTimeout = null;
    }

    // 计算混音延迟
    let mixingDelay = this.mixingWindowMs;

    if (targetPlaybackTime) {
      const now = Date.now();
      const timeUntilTarget = targetPlaybackTime - now;

      if (timeUntilTarget > this.mixingWindowMs) {
        // 距离目标播放时间还很远，等待到接近目标时间再混音
        mixingDelay = Math.max(0, timeUntilTarget - 50); // 提前50ms混音
        console.log(`⏰ [音频混音器] 智能调度: 距离目标时间${timeUntilTarget}ms, 将在${mixingDelay}ms后混音`);
      } else if (timeUntilTarget > 0) {
        // 快到目标时间了
        mixingDelay = Math.max(0, timeUntilTarget);
        console.log(`⏰ [音频混音器] 智能调度: 目标时间即将到达(${timeUntilTarget}ms)`);
      } else {
        // 已经过了目标时间，立即混音
        mixingDelay = 0;
        console.warn(`⚠️ [音频混音器] 警告: 已过目标播放时间${Math.abs(timeUntilTarget)}ms, 立即混音`);
      }
    }

    // 设置混音定时器
    if (mixingDelay > 0) {
      this.mixingTimeout = setTimeout(async () => {
        this.mixingTimeout = null;
        await this.triggerMixing();
      }, mixingDelay);
      console.log(`⏰ [音频混音器] 设置混音定时器: ${mixingDelay}ms后执行`);
    } else {
      // 立即混音
      this.triggerMixing();
    }
  }

  /**
   * 触发混音并发射事件
   */
  private async triggerMixing(): Promise<void> {
    const mixedAudio = await this.mixAllOperatorAudios(0);
    if (mixedAudio) {
      this.emit('mixedAudioReady', mixedAudio);
    }
  }

  /**
   * 混合所有操作员的音频
   * @param elapsedTimeMs 已播放时间（用于裁剪，0表示从头开始）
   */
  async mixAllOperatorAudios(elapsedTimeMs: number = 0): Promise<MixedAudio | null> {
    const mixStartTime = Date.now();

    if (this.slotAudioCache.size === 0) {
      console.log(`⚠️ [音频混音器] 没有待混音的音频`);
      return null;
    }

    const audioList = Array.from(this.slotAudioCache.values());
    const operatorIds = audioList.map(a => a.operatorId);

    console.log(`🎛️ [音频混音器] 开始混音: ${audioList.length}个音频, 操作员=[${operatorIds.join(', ')}], 跳过=${elapsedTimeMs}ms`);

    try {
      // 1. 确定目标采样率（使用最高的采样率）
      const targetSampleRate = Math.max(...audioList.map(a => a.sampleRate));

      // 2. 计算需要跳过的采样点数
      const skipSamples = Math.floor((elapsedTimeMs / 1000) * targetSampleRate);

      // 3. 处理每个操作员的音频：重采样 + 裁剪
      const processedAudios = await Promise.all(audioList.map(async (audio) => {
        let samples = audio.audioData;

        // 重采样（如需要）
        if (audio.sampleRate !== targetSampleRate) {
          console.log(`🔄 [音频混音器] 操作员 ${audio.operatorId}: 重采样 ${audio.sampleRate}Hz -> ${targetSampleRate}Hz`);
          try {
            samples = await resampleAudioProfessional(
              samples,
              audio.sampleRate,
              targetSampleRate,
              1 // 单声道
            );
          } catch (error) {
            console.error(`❌ [音频混音器] 操作员 ${audio.operatorId}: 重采样失败，使用备用方案:`, error);
            samples = this.linearResample(samples, audio.sampleRate, targetSampleRate);
          }
        }

        // 裁剪已播放部分
        if (skipSamples > 0) {
          if (skipSamples < samples.length) {
            const originalLength = samples.length;
            samples = samples.slice(skipSamples);
            console.log(`✂️ [音频混音器] 操作员 ${audio.operatorId}: 裁剪 ${originalLength} -> ${samples.length} 样本 (跳过 ${skipSamples})`);
          } else {
            // 该操作员的音频已播放完毕
            console.log(`⏭️ [音频混音器] 操作员 ${audio.operatorId}: 音频已播放完毕，跳过`);
            samples = new Float32Array(0);
          }
        }

        return { operatorId: audio.operatorId, samples };
      }));

      // 4. 过滤掉空音频
      const validAudios = processedAudios.filter(a => a.samples.length > 0);
      if (validAudios.length === 0) {
        console.warn(`⚠️ [音频混音器] 所有音频都已播放完毕，无需混音`);
        return null;
      }

      // 5. 单一音频快速路径
      if (validAudios.length === 1) {
        const single = validAudios[0];
        console.log(`🔊 [音频混音器] 单一音频直接输出: ${single.operatorId}`);
        return {
          audioData: single.samples,
          sampleRate: targetSampleRate,
          duration: single.samples.length / targetSampleRate,
          operatorIds: [single.operatorId]
        };
      }

      // 6. 混合多个音频
      const maxLength = Math.max(...validAudios.map(a => a.samples.length));
      const mixedSamples = new Float32Array(maxLength);

      for (const audio of validAudios) {
        console.log(`🎵 [音频混音器] 混合操作员 ${audio.operatorId}: ${audio.samples.length} 样本`);
        for (let i = 0; i < audio.samples.length; i++) {
          mixedSamples[i] += audio.samples[i];
        }
      }

      // 7. 归一化
      const peakLevel = this.findPeakLevel(mixedSamples);
      if (peakLevel > 1.0) {
        const normalizeRatio = 0.95 / peakLevel;
        console.log(`🔧 [音频混音器] 应用归一化: 峰值=${peakLevel.toFixed(3)}, 比率=${normalizeRatio.toFixed(3)}`);
        for (let i = 0; i < mixedSamples.length; i++) {
          mixedSamples[i] *= normalizeRatio;
        }
      }

      const finalDuration = maxLength / targetSampleRate;
      const mixEndTime = Date.now();

      console.log(`✅ [音频混音器] 混音完成: ${validAudios.length}个音频 -> 时长=${finalDuration.toFixed(2)}s, 耗时=${mixEndTime - mixStartTime}ms`);

      return {
        audioData: mixedSamples,
        sampleRate: targetSampleRate,
        duration: finalDuration,
        operatorIds: validAudios.map(a => a.operatorId)
      };

    } catch (error) {
      console.error(`❌ [音频混音器] 混音失败:`, error);
      throw error;
    }
  }

  /**
   * 重新混音（某操作员更新后调用）
   * @param newElapsedTimeMs 自上次播放开始到现在经过的时间
   */
  async remixAfterUpdate(newElapsedTimeMs: number): Promise<MixedAudio | null> {
    // 累加新的偏移量到总偏移
    this.cumulativeOffsetMs += newElapsedTimeMs;

    console.log(`🔄 [音频混音器] 重新混音: 本次偏移=${newElapsedTimeMs}ms, 累计偏移=${this.cumulativeOffsetMs}ms, 操作员数=${this.slotAudioCache.size}`);

    // 使用累计偏移量进行裁剪
    return this.mixAllOperatorAudios(this.cumulativeOffsetMs);
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
   * 清空当前时隙的音频缓存（时隙切换时调用）
   */
  clearSlotCache(): void {
    const count = this.slotAudioCache.size;
    this.slotAudioCache.clear();
    this.isPlaying = false;
    this.playbackStartTimeMs = 0;
    this.cumulativeOffsetMs = 0;  // 重置累计偏移量

    if (this.mixingTimeout) {
      clearTimeout(this.mixingTimeout);
      this.mixingTimeout = null;
    }

    console.log(`🧹 [音频混音器] 清空时隙音频缓存: 清除了 ${count} 个操作员的音频`);
  }

  /**
   * 记录播放开始
   */
  markPlaybackStart(): void {
    this.playbackStartTimeMs = Date.now();
    this.isPlaying = true;
    console.log(`▶️ [音频混音器] 标记播放开始: ${new Date(this.playbackStartTimeMs).toISOString()}`);
  }

  /**
   * 记录播放停止
   */
  markPlaybackStop(): void {
    this.isPlaying = false;
    console.log(`⏹️ [音频混音器] 标记播放停止`);
  }

  /**
   * 获取已播放时间
   */
  getElapsedPlaybackTime(): number {
    if (!this.isPlaying || this.playbackStartTimeMs === 0) {
      return 0;
    }
    return Date.now() - this.playbackStartTimeMs;
  }

  /**
   * 检查是否正在播放
   */
  getIsPlaying(): boolean {
    return this.isPlaying;
  }

  /**
   * 强制立即混音
   */
  async forceMix(): Promise<MixedAudio | null> {
    if (this.mixingTimeout) {
      clearTimeout(this.mixingTimeout);
      this.mixingTimeout = null;
    }
    return this.mixAllOperatorAudios(0);
  }

  /**
   * 清除特定操作员的音频
   */
  clearOperatorAudio(operatorId: string): boolean {
    if (this.slotAudioCache.has(operatorId)) {
      this.slotAudioCache.delete(operatorId);
      console.log(`🧹 [音频混音器] 清除操作员 ${operatorId} 的音频`);
      return true;
    }
    return false;
  }

  /**
   * 获取当前状态
   */
  getStatus() {
    return {
      cacheCount: this.slotAudioCache.size,
      operatorIds: Array.from(this.slotAudioCache.keys()),
      currentSlotStartMs: this.currentSlotStartMs,
      isPlaying: this.isPlaying,
      hasPendingMix: this.mixingTimeout !== null,
      mixingWindowMs: this.mixingWindowMs
    };
  }

  /**
   * 获取缓存中的操作员音频
   */
  getOperatorAudio(operatorId: string): OperatorSlotAudio | undefined {
    return this.slotAudioCache.get(operatorId);
  }

  /**
   * 获取所有缓存的操作员音频
   */
  getAllOperatorAudios(): OperatorSlotAudio[] {
    return Array.from(this.slotAudioCache.values());
  }

  // ===== 兼容旧接口（将逐步废弃） =====

  /**
   * @deprecated 使用 addOperatorAudio + scheduleMixing 替代
   */
  addAudio(operatorId: string, audioData: Float32Array, sampleRate: number, scheduledTime: number, targetPlaybackTime?: number): void {
    // 从 scheduledTime 推断 slotStartMs
    const slotStartMs = scheduledTime;
    this.addOperatorAudio(operatorId, audioData, sampleRate, slotStartMs);
    this.scheduleMixing(targetPlaybackTime);
  }

  /**
   * @deprecated 使用 clearSlotCache 替代
   */
  clear(): void {
    this.clearSlotCache();
  }

  /**
   * @deprecated 使用 remixAfterUpdate 替代
   */
  async remixWithNewAudio(elapsedTimeMs: number): Promise<MixedAudio | null> {
    return this.remixAfterUpdate(elapsedTimeMs);
  }

  /**
   * @deprecated 使用 getStatus().cacheCount 替代
   */
  getCurrentMixedAudio(): MixedAudio | null {
    // 这个方法在新架构中不再有意义，返回 null
    return null;
  }
}
