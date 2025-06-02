import { EventEmitter } from 'eventemitter3';
import type { SlotPack, DecodeResult, FT8Frame, ModeDescriptor } from '@tx5dr/contracts';
import { MODES } from '@tx5dr/contracts';

export interface SlotPackManagerEvents {
  'slotPackUpdated': (slotPack: SlotPack) => void;
}

/**
 * 时隙包管理器 - 管理同一时隙内的多次解码结果
 * 负责去重、优化选择和维护最优解码结果
 */
export class SlotPackManager extends EventEmitter<SlotPackManagerEvents> {
  private slotPacks = new Map<string, SlotPack>();
  private lastSlotPack: SlotPack | null = null;
  private currentMode: ModeDescriptor = MODES.FT8;
  
  constructor() {
    super();
  }
  
  /**
   * 设置当前模式
   */
  setMode(mode: ModeDescriptor): void {
    this.currentMode = mode;
    console.log(`🔄 [SlotPackManager] 切换到模式: ${mode.name}, 时隙长度: ${mode.slotMs}ms`);
  }
  
  /**
   * 处理解码结果，更新对应的 SlotPack
   */
  processDecodeResult(result: DecodeResult): SlotPack {
    const { slotId } = result;
    
    // 获取或创建 SlotPack
    let slotPack = this.slotPacks.get(slotId);
    if (!slotPack) {
      slotPack = this.createSlotPack(slotId, result.timestamp);
      this.slotPacks.set(slotId, slotPack);
      
      // 更新最新的 SlotPack
      if (!this.lastSlotPack || slotPack.startMs > this.lastSlotPack.startMs) {
        this.lastSlotPack = slotPack;
      }
    }
    
    // 更新解码统计
    slotPack.stats.totalDecodes++;
    if (result.frames.length > 0) {
      slotPack.stats.successfulDecodes++;
    }
    slotPack.stats.totalFramesBeforeDedup += result.frames.length;
    slotPack.stats.lastUpdated = Date.now();
    
    // 添加解码历史
    slotPack.decodeHistory.push({
      windowIdx: result.windowIdx,
      timestamp: result.timestamp,
      frameCount: result.frames.length,
      processingTimeMs: result.processingTimeMs
    });
    
    // 合并和去重帧数据
    // 首先校正新解码结果中的时间偏移，消除窗口偏移的影响
    const correctedFrames = result.frames.map(frame => {
      const originalDt = frame.dt;
      const windowOffsetSec = ((result as any).windowOffsetMs || 0) / 1000;
      const correctedDt = originalDt - windowOffsetSec;
      
      // 如果有窗口偏移，显示校正信息
      if ((result as any).windowOffsetMs && (result as any).windowOffsetMs !== 0) {
        console.log(`🔧 [时间校正] 窗口${result.windowIdx}: "${frame.message}" dt: ${originalDt.toFixed(3)}s -> ${correctedDt.toFixed(3)}s (窗口偏移: ${windowOffsetSec.toFixed(3)}s)`);
      }
      
      return {
        ...frame,
        dt: correctedDt
      };
    });
    
    const allFrames = [...slotPack.frames, ...correctedFrames];
    slotPack.frames = this.deduplicateAndOptimizeFrames(allFrames);
    slotPack.stats.totalFramesAfterDedup = slotPack.frames.length;
    
    // 确保 lastSlotPack 指向最新的 SlotPack
    if (slotPack.startMs > (this.lastSlotPack?.startMs || 0)) {
      this.lastSlotPack = slotPack;
    }
    
    /* console.log(`📦 [SlotPackManager] 更新时隙包: ${slotId}`);
    console.log(`   解码次数: ${slotPack.stats.totalDecodes}, 成功: ${slotPack.stats.successfulDecodes}`);
    console.log(`   帧数: ${slotPack.stats.totalFramesBeforeDedup} -> ${slotPack.stats.totalFramesAfterDedup} (去重后)`); */
    
    // 显示当前时隙包中的所有解码结果
    /* if (slotPack.frames.length > 0) {
      console.log(`📨 [当前时隙包解码结果]:`);
      slotPack.frames.forEach((frame, index) => {
        console.log(`   信号 ${index + 1}: "${frame.message}" (SNR: ${frame.snr}dB, 频率: ${frame.freq}Hz, 时间偏移: ${frame.dt.toFixed(2)}s, 置信度: ${frame.confidence.toFixed(2)})`);
      });
    } else {
      console.log(`   📭 当前时隙包暂无有效解码结果`);
    } */
    
    // 发出更新事件
    this.emit('slotPackUpdated', { ...slotPack });
    
    return { ...slotPack };
  }
  
  /**
   * 创建新的 SlotPack
   */
  private createSlotPack(slotId: string, timestamp: number): SlotPack {
    // 从 slotId 中提取时隙开始时间
    const parts = slotId.split('-');
    let startMs = timestamp;
    
    // 尝试从 slotId 中提取时间戳
    const timePart = parts[parts.length - 1];
    if (timePart && !isNaN(parseInt(timePart))) {
      startMs = parseInt(timePart);
    }
    
    // 使用当前模式的时隙长度
    const slotDurationMs = this.currentMode.slotMs;
    
    const slotPack: SlotPack = {
      slotId,
      startMs,
      endMs: startMs + slotDurationMs,
      frames: [],
      stats: {
        totalDecodes: 0,
        successfulDecodes: 0,
        totalFramesBeforeDedup: 0,
        totalFramesAfterDedup: 0,
        lastUpdated: timestamp
      },
      decodeHistory: []
    };
    
    return slotPack;
  }
  
  /**
   * 去重和优化帧数据
   * 基于消息内容、频率和 SNR 进行去重，保留最优的帧
   * 按照添加顺序排列，而不是按信号强度排序
   */
  private deduplicateAndOptimizeFrames(frames: FT8Frame[]): FT8Frame[] {
    if (frames.length === 0) return [];
    
    // 按消息内容分组，同时记录每个消息第一次出现的位置
    const messageGroups = new Map<string, { frames: FT8Frame[], firstIndex: number }>();
    
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      if (!frame) continue; // 跳过 undefined 帧
      
      const message = frame.message.trim();
      
      if (!messageGroups.has(message)) {
        messageGroups.set(message, { frames: [], firstIndex: i });
      }
      messageGroups.get(message)!.frames.push(frame);
    }
    
    const optimizedFrames: { frame: FT8Frame, firstIndex: number }[] = [];
    
    // 对每个消息组选择最优帧，并记录其首次出现位置
    for (const [message, groupData] of messageGroups) {
      const bestFrame = this.selectBestFrame(groupData.frames);
      if (bestFrame) {
        optimizedFrames.push({ frame: bestFrame, firstIndex: groupData.firstIndex });
      }
    }
    
    // 按照首次出现的顺序排序（保持添加顺序）
    optimizedFrames.sort((a, b) => a.firstIndex - b.firstIndex);
    
    // console.log(`🔍 [SlotPackManager] 去重优化: ${frames.length} -> ${optimizedFrames.length} 帧 (保持添加顺序)`);
    
    return optimizedFrames.map(item => item.frame);
  }
  
  /**
   * 从同一消息的多个帧中选择最优的一个
   */
  private selectBestFrame(frames: FT8Frame[]): FT8Frame | null {
    if (frames.length === 0) return null;
    if (frames.length === 1) return frames[0] || null;
    
    // 选择策略（按优先级排序）：
    // 1. 优先选择 SNR 最高的
    // 2. 如果 SNR 相近（差异 < 3dB），选择置信度最高的
    // 3. 如果置信度也相近，选择 dt 绝对值最小的（时间偏移更准确）
    // 4. 如果 dt 也相近，选择频率偏移最小的
    
    let bestFrame = frames[0];
    if (!bestFrame) return null;
    
    for (let i = 1; i < frames.length; i++) {
      const current = frames[i];
      
      if (!current || !bestFrame) continue;
      
      // SNR 差异超过 3dB，选择 SNR 更高的
      if (current.snr - bestFrame.snr > 3) {
        bestFrame = current;
        continue;
      }
      
      // SNR 相近，比较置信度
      if (Math.abs(current.snr - bestFrame.snr) <= 3) {
        if (current.confidence - bestFrame.confidence > 0.1) {
          bestFrame = current;
          continue;
        }
        
        // 置信度也相近，比较 dt 绝对值（选择时间偏移更准确的）
        if (Math.abs(current.confidence - bestFrame.confidence) <= 0.1) {
          const currentDtAbs = Math.abs(current.dt);
          const bestDtAbs = Math.abs(bestFrame.dt);
          
          if (currentDtAbs < bestDtAbs - 0.05) { // dt 差异超过 0.05 秒
            // console.log(`🎯 [帧选择] 选择更准确的时间偏移: "${current.message}" dt=${current.dt.toFixed(3)}s (|${currentDtAbs.toFixed(3)}|) 替代 dt=${bestFrame.dt.toFixed(3)}s (|${bestDtAbs.toFixed(3)}|)`);
            bestFrame = current;
            continue;
          }
          
          // dt 也相近，比较频率偏移（选择更接近中心频率的）
          if (Math.abs(currentDtAbs - bestDtAbs) <= 0.05) {
            const currentFreqOffset = Math.abs(current.freq - 1500); // 假设中心频率 1500Hz
            const bestFreqOffset = Math.abs(bestFrame.freq - 1500);
            
            if (currentFreqOffset < bestFreqOffset) {
              bestFrame = current;
            }
          }
        }
      }
    }
    
    return bestFrame || null;
  }
  
  /**
   * 获取当前所有活跃的时隙包
   */
  getActiveSlotPacks(): SlotPack[] {
    return Array.from(this.slotPacks.values()).map(pack => ({ ...pack }));
  }
  
  /**
   * 获取指定时隙包
   */
  getSlotPack(slotId: string): SlotPack | null {
    const pack = this.slotPacks.get(slotId);
    return pack ? { ...pack } : null;
  }

  /**
   * 获取最新的时隙包
   * 优化版本：直接返回缓存的 lastSlotPack
   */
  getLatestSlotPack(): SlotPack | null {
    // 如果有缓存的最新 SlotPack，直接返回副本
    if (this.lastSlotPack) {
      return { ...this.lastSlotPack };
    }
    return null;
  }
  
  /**
   * 清理指定时隙包
   */
  removeSlotPack(slotId: string): boolean {
    const slotPack = this.slotPacks.get(slotId);
    const removed = this.slotPacks.delete(slotId);
    
    if (removed) {
      console.log(`🗑️ [SlotPackManager] 清理时隙包: ${slotId}`);
      
      // 如果删除的是最新的 SlotPack，需要重新计算 lastSlotPack
      if (slotPack && this.lastSlotPack && slotPack.slotId === this.lastSlotPack.slotId) {
        this.updateLastSlotPack();
      }
    }
    
    return removed;
  }
  
  /**
   * 重新计算并更新 lastSlotPack
   */
  private updateLastSlotPack(): void {
    this.lastSlotPack = null;
    
    if (this.slotPacks.size === 0) {
      return;
    }
    
    let latestStartMs = 0;
    for (const slotPack of this.slotPacks.values()) {
      if (slotPack.startMs > latestStartMs) {
        latestStartMs = slotPack.startMs;
        this.lastSlotPack = slotPack;
      }
    }
    
    if (this.lastSlotPack) {
      console.log(`🔄 [SlotPackManager] 更新最新时隙包缓存: ${this.lastSlotPack.slotId}`);
    }
  }
  
  /**
   * 清理过期的时隙包（超过指定时间的）
   */
  cleanupExpiredSlotPacks(maxAgeMs: number = 60000): number {
    const now = Date.now();
    let cleanedCount = 0;
    let lastSlotPackRemoved = false;
    
    for (const [slotId, slotPack] of this.slotPacks.entries()) {
      if (now - slotPack.stats.lastUpdated > maxAgeMs) {
        // 检查是否要删除最新的 SlotPack
        if (this.lastSlotPack && slotPack.slotId === this.lastSlotPack.slotId) {
          lastSlotPackRemoved = true;
        }
        
        this.slotPacks.delete(slotId);
        cleanedCount++;
        console.log(`🗑️ [SlotPackManager] 清理过期时隙包: ${slotId} (${Math.round((now - slotPack.stats.lastUpdated) / 1000)}秒前)`);
      }
    }
    
    // 如果删除了最新的 SlotPack，重新计算
    if (lastSlotPackRemoved) {
      this.updateLastSlotPack();
    }
    
    if (cleanedCount > 0) {
      console.log(`🧹 [SlotPackManager] 清理了 ${cleanedCount} 个过期时隙包`);
    }
    
    return cleanedCount;
  }
  
  /**
   * 获取 SlotPackManager 的状态信息
   */
  getStatus() {
    return {
      totalSlotPacks: this.slotPacks.size,
      lastSlotPack: this.lastSlotPack ? {
        slotId: this.lastSlotPack.slotId,
        startMs: this.lastSlotPack.startMs,
        frameCount: this.lastSlotPack.frames.length,
        totalDecodes: this.lastSlotPack.stats.totalDecodes,
        lastUpdated: this.lastSlotPack.stats.lastUpdated
      } : null,
      currentMode: this.currentMode.name,
      slotDurationMs: this.currentMode.slotMs
    };
  }

  /**
   * 清理所有时隙包
   */
  cleanup(): void {
    this.slotPacks.clear();
    this.lastSlotPack = null; // 重置最新时隙包缓存
    this.removeAllListeners();
    
    console.log('🧹 [SlotPackManager] 清理完成');
  }
} 