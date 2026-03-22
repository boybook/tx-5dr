/* eslint-disable @typescript-eslint/no-explicit-any */
// SlotPackManager - 事件处理需要使用any

import { EventEmitter } from 'eventemitter3';
import type { SlotPack, DecodeResult, FrameMessage, ModeDescriptor, SlotInfo } from '@tx5dr/contracts';
import { MODES } from '@tx5dr/contracts';
import { CycleUtils } from '@tx5dr/core';
import { SlotPackPersistence } from './SlotPackPersistence.js';
import { FT8MessageParser } from '@tx5dr/core';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('SlotPackManager');

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
  private persistence: SlotPackPersistence;
  private persistenceEnabled: boolean = true;
  
  constructor() {
    super();
    this.persistence = new SlotPackPersistence();
  }

  /**
   * 清空内存中的所有时隙包但保留事件监听器
   * 用于诸如切换频率等需要快速“换盘”的场景，避免打断外部对本管理器的订阅
   */
  clearInMemory(): void {
    logger.info('Cleared in-memory slot cache (listeners retained)');
    this.slotPacks.clear();
    this.lastSlotPack = null;
  }

  /**
   * 添加发射帧到指定时隙包
   * 将发射的消息作为特殊的帧添加到SlotPack中
   */
  addTransmissionFrame(slotId: string, operatorId: string, message: string, frequency: number, timestamp: number): void {
    try {
      // 获取或创建时隙包
      let slotPack = this.slotPacks.get(slotId);
      if (!slotPack) {
        slotPack = this.createSlotPack(slotId, timestamp);
        this.slotPacks.set(slotId, slotPack);
        
        // 更新最新的 SlotPack
        if (!this.lastSlotPack || slotPack.startMs > this.lastSlotPack.startMs) {
          this.lastSlotPack = slotPack;
        }
      }

      // 创建发射帧，使用特殊值标识为发射
      const transmissionFrame: FrameMessage = {
        message: message,
        snr: -999, // 使用特殊SNR值标识发射(-999表示TX)
        dt: 0.0, // 发射消息时间偏移设为0
        freq: frequency, // 使用操作员配置的频率
        confidence: 1.0, // 发射消息置信度为1.0
        // 不设置logbookAnalysis，发射消息不需要分析
      };

      // 检查是否已经存在相同的发射帧（避免重复添加）
      const existingTransmissionFrame = slotPack.frames.find(frame => 
        frame.snr === -999 && 
        frame.message === message && 
        Math.abs(frame.freq - frequency) < 1 // 频率允许1Hz误差
      );

      if (existingTransmissionFrame) {
        logger.debug(`Transmission frame already exists, skipping duplicate: ${message}`);
        return;
      }

      // 添加发射帧到frames数组的开头（让发射消息显示在接收消息之前）
      slotPack.frames.unshift(transmissionFrame);
      
      // 更新统计信息
      slotPack.stats.lastUpdated = timestamp;
      slotPack.stats.totalFramesAfterDedup = slotPack.frames.length;

      logger.debug(`Added transmission frame: slotId=${slotId}, operator=${operatorId}, message="${message}"`);

      // 异步存储到本地（不阻塞主流程）
      if (this.persistenceEnabled) {
        this.persistence.store(slotPack, 'updated', this.currentMode.name).catch(error => {
          logger.error('store transmission frame failed', error);
        });
      }

      // 发出更新事件
      this.emit('slotPackUpdated', { ...slotPack });

    } catch (error) {
      logger.error('add transmission frame failed', error);
    }
  }
  
  /**
   * 设置当前模式
   */
  setMode(mode: ModeDescriptor): void {
    this.currentMode = mode;
    logger.info(`Mode switched to: ${mode.name}, slotMs=${mode.slotMs}ms`);
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

      // 异步存储新创建的SlotPack（不阻塞主流程）
      if (this.persistenceEnabled) {
        this.persistence.store(slotPack, 'created', this.currentMode.name).catch(error => {
          logger.error('store SlotPack failed', error);
        });
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
        logger.debug(`Time correction window${result.windowIdx}: "${frame.message}" dt: ${originalDt.toFixed(3)}s -> ${correctedDt.toFixed(3)}s (offset: ${windowOffsetSec.toFixed(3)}s)`);
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
    
    // 异步存储到本地（不阻塞主流程）
    if (this.persistenceEnabled) {
      this.persistence.store(slotPack, 'updated', this.currentMode.name).catch(error => {
        logger.error('store SlotPack update failed', error);
      });
    }

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
   * 发射帧（SNR=-999）和接收帧分别处理，发射帧不参与去重
   * 按照添加顺序排列，而不是按信号强度排序
   */
  private deduplicateAndOptimizeFrames(frames: FrameMessage[]): FrameMessage[] {
    if (frames.length === 0) return [];
    
    // 分离发射帧和接收帧
    const transmissionFrames: FrameMessage[] = [];
    const receivedFrames: FrameMessage[] = [];
    
    for (const frame of frames) {
      if (!frame) continue; // 跳过 undefined 帧
      
      if (frame.snr === -999) {
        // 发射帧
        transmissionFrames.push(frame);
      } else {
        // 接收帧
        receivedFrames.push(frame);
      }
    }
    
    // 对接收帧进行去重处理
    const optimizedReceivedFrames = this.deduplicateReceivedFrames(receivedFrames);
    
    // 合并发射帧和去重后的接收帧，发射帧在前
    const result = [...transmissionFrames, ...optimizedReceivedFrames];
    
    return result;
  }

  /**
   * 对接收帧进行去重和优化
   */
  private deduplicateReceivedFrames(frames: FrameMessage[]): FrameMessage[] {
    if (frames.length === 0) return [];
    
    // 按消息内容分组，同时记录每个消息第一次出现的位置
    const messageGroups = new Map<string, { frames: FrameMessage[], firstIndex: number }>();
    
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      if (!frame) continue; // 跳过 undefined 帧

      const message = frame.message.trim();

      if (!messageGroups.has(message)) {
        messageGroups.set(message, { frames: [], firstIndex: i });
      }
      messageGroups.get(message)!.frames.push(frame);
    }
    
    const optimizedFrames: { frame: FrameMessage, firstIndex: number }[] = [];
    
    // 对每个消息组选择最优帧，并记录其首次出现位置
    for (const [message, groupData] of messageGroups) {
      const bestFrame = this.selectBestFrame(groupData.frames);
      if (bestFrame) {
        optimizedFrames.push({ frame: bestFrame, firstIndex: groupData.firstIndex });
      }
    }
    
    // 按照首次出现的顺序排序（保持添加顺序）
    optimizedFrames.sort((a, b) => a.firstIndex - b.firstIndex);
    
    return optimizedFrames.map(item => item.frame);
  }
  
  /**
   * 从同一消息的多个帧中选择最优的一个
   */
  private selectBestFrame(frames: FrameMessage[]): FrameMessage | null {
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
      logger.debug(`Removed slot pack: ${slotId}`);
      
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
      logger.debug(`Updated lastSlotPack cache: ${this.lastSlotPack.slotId}`);
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
        logger.debug(`Cleaned expired slot pack: ${slotId} (${Math.round((now - slotPack.stats.lastUpdated) / 1000)}s ago)`);
      }
    }
    
    // 如果删除了最新的 SlotPack，重新计算
    if (lastSlotPackRemoved) {
      this.updateLastSlotPack();
    }
    
    if (cleanedCount > 0) {
      logger.debug(`Cleaned ${cleanedCount} expired slot packs`);
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
   * 启用或禁用持久化存储
   */
  setPersistenceEnabled(enabled: boolean): void {
    this.persistenceEnabled = enabled;
    logger.info(`Persistence storage ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * 获取持久化存储状态
   */
  isPersistenceEnabled(): boolean {
    return this.persistenceEnabled;
  }

  /**
   * 获取持久化存储统计信息
   */
  async getPersistenceStats() {
    return this.persistence.getStorageStats();
  }

  /**
   * 强制刷新持久化缓冲区
   */
  async flushPersistence(): Promise<void> {
    await this.persistence.flush();
  }

  /**
   * 读取指定日期的存储记录
   */
  async readStoredRecords(dateStr: string) {
    return this.persistence.readRecords(dateStr);
  }

  /**
   * 获取可用的存储日期列表
   */
  async getAvailableStorageDates(): Promise<string[]> {
    return this.persistence.getAvailableDates();
  }

  /**
   * 获取指定呼号最后发送的消息
   * @param callsign 目标呼号
   * @returns 包含消息和时隙信息的对象，如果没有找到则返回undefined
   */
  getLastMessageFromCallsign(callsign: string): { message: FrameMessage, slotInfo: SlotInfo } | undefined {
    // 获取所有slotPacks并按时间排序（最新的在前）
    const sortedSlotPacks = Array.from(this.slotPacks.values())
      .sort((a, b) => b.startMs - a.startMs);

    const upperCallsign = callsign.toUpperCase().trim();

    for (const slotPack of sortedSlotPacks) {
      // 从后往前遍历frames（最新的在后）
      for (let i = slotPack.frames.length - 1; i >= 0; i--) {
        const frame = slotPack.frames[i];
        
        // 跳过发射帧（SNR=-999），只查找接收到的消息
        if (frame.snr === -999) {
          continue;
        }

        try {
          // 使用FT8MessageParser解析消息
          const parsedMessage = FT8MessageParser.parseMessage(frame.message);
          
          // 检查是否有senderCallsign字段且匹配目标呼号
          if ((parsedMessage as any).senderCallsign && 
              (parsedMessage as any).senderCallsign.toUpperCase() === upperCallsign) {
            
            // 构造SlotInfo，使用统一的周期计算方法
            const utcSeconds = Math.floor(slotPack.startMs / 1000);
            const cycleNumber = CycleUtils.calculateCycleNumber(utcSeconds, this.currentMode.slotMs);
            
            const slotInfo: SlotInfo = {
              id: slotPack.slotId,
              startMs: slotPack.startMs,
              phaseMs: 0, // 默认值，SlotPack中没有这个信息
              driftMs: 0, // 默认值
              cycleNumber,
              utcSeconds,
              mode: this.currentMode.name
            };

            logger.debug(`Found last message from callsign ${callsign}: "${frame.message}" in slot ${slotPack.slotId}`);
            return { message: frame, slotInfo };
          }
        } catch (error) {
          // 解析失败，跳过这个消息
          logger.warn(`Failed to parse message: "${frame.message}"`);
          continue;
        }
      }
    }

    logger.debug(`No messages found from callsign ${callsign}`);
    return undefined;
  }

  /**
   * 从指定时隙包中查找最空隙的可用发射频率
   * @param slotId 时隙ID
   * @param minFreq 最小频率 (Hz)，默认300
   * @param maxFreq 最大频率 (Hz)，默认3500  
   * @param guardBandwidth 保护带宽 (Hz)，默认100Hz（信号两侧各50Hz）
   * @returns 推荐的发射频率，如果没有找到合适频率则返回undefined
   */
  findBestTransmitFrequency(
    slotId: string, 
    minFreq: number = 300, 
    maxFreq: number = 3500, 
    guardBandwidth: number = 100
  ): number | undefined {
    const slotPack = this.slotPacks.get(slotId);
    if (!slotPack) {
      logger.warn(`Slot pack not found: ${slotId}`);
      return undefined;
    }

    // 收集所有接收帧的频率（跳过发射帧 SNR=-999）
    const usedFrequencies: number[] = slotPack.frames
      .filter(frame => frame.snr !== -999) // 排除发射帧
      .map(frame => frame.freq)
      .sort((a, b) => a - b); // 按频率排序

    logger.debug(`Occupied frequencies in slot ${slotId}: [${usedFrequencies.join(', ')}]Hz`);

    // 如果没有任何占用频率，返回中间频率
    if (usedFrequencies.length === 0) {
      const centerFreq = Math.round((minFreq + maxFreq) / 2);
      logger.debug(`No occupied frequencies, returning center: ${centerFreq}Hz`);
      return centerFreq;
    }

    // 构建可用频率段列表
    interface FrequencyGap {
      start: number;
      end: number;
      width: number;
      center: number;
    }

    const gaps: FrequencyGap[] = [];
    
    // 检查最低频率之前的空隙
    if (usedFrequencies[0] > minFreq + guardBandwidth) {
      const start = minFreq;
      const end = usedFrequencies[0] - guardBandwidth / 2;
      gaps.push({
        start,
        end,
        width: end - start,
        center: Math.round((start + end) / 2)
      });
    }

    // 检查频率之间的空隙
    for (let i = 0; i < usedFrequencies.length - 1; i++) {
      const currentFreq = usedFrequencies[i];
      const nextFreq = usedFrequencies[i + 1];
      const gapWidth = nextFreq - currentFreq;
      
      // 只有当空隙宽度大于保护带宽时才考虑
      if (gapWidth > guardBandwidth) {
        const start = currentFreq + guardBandwidth / 2;
        const end = nextFreq - guardBandwidth / 2;
        gaps.push({
          start,
          end,
          width: end - start,
          center: Math.round((start + end) / 2)
        });
      }
    }

    // 检查最高频率之后的空隙
    const lastFreq = usedFrequencies[usedFrequencies.length - 1];
    if (lastFreq < maxFreq - guardBandwidth) {
      const start = lastFreq + guardBandwidth / 2;
      const end = maxFreq;
      gaps.push({
        start,
        end,
        width: end - start,
        center: Math.round((start + end) / 2)
      });
    }

    // 过滤掉太小的空隙（宽度小于最小保护带宽）
    const validGaps = gaps.filter(gap => gap.width >= guardBandwidth / 2);

    if (validGaps.length === 0) {
      logger.warn(`No suitable frequency gap found in slot ${slotId}`);
      return undefined;
    }

    // 选择最大的空隙，如果有多个相同大小的空隙，选择中心频率最接近整体中心的
    const overallCenter = (minFreq + maxFreq) / 2;
    const bestGap = validGaps.reduce((best, current) => {
      // 优先选择更宽的空隙
      if (current.width > best.width) {
        return current;
      }
      // 如果宽度相同，选择更接近中心的
      if (current.width === best.width) {
        const currentDistance = Math.abs(current.center - overallCenter);
        const bestDistance = Math.abs(best.center - overallCenter);
        return currentDistance < bestDistance ? current : best;
      }
      return best;
    });

    // 确保推荐频率在合理范围内
    const recommendedFreq = Math.max(minFreq, Math.min(maxFreq, bestGap.center));

    logger.debug(`Best transmit frequency: ${recommendedFreq}Hz, gap=${bestGap.start.toFixed(1)}-${bestGap.end.toFixed(1)}Hz (width=${bestGap.width.toFixed(1)}Hz), occupied=[${usedFrequencies.join(', ')}]Hz`);

    return recommendedFreq;
  }

  /**
   * 获取指定时隙包的频率占用分析
   * @param slotId 时隙ID
   * @returns 频率占用分析结果
   */
  getFrequencyAnalysis(slotId: string): {
    slotId: string;
    usedFrequencies: number[];
    frequencyRange: { min: number; max: number };
    averageFrequency: number;
    frequencySpread: number;
    signalCount: number;
  } | undefined {
    const slotPack = this.slotPacks.get(slotId);
    if (!slotPack) {
      return undefined;
    }

    // 收集所有接收帧的频率（跳过发射帧）
    const usedFrequencies = slotPack.frames
      .filter(frame => frame.snr !== -999) // 排除发射帧
      .map(frame => frame.freq)
      .sort((a, b) => a - b);

    if (usedFrequencies.length === 0) {
      return {
        slotId,
        usedFrequencies: [],
        frequencyRange: { min: 0, max: 0 },
        averageFrequency: 0,
        frequencySpread: 0,
        signalCount: 0
      };
    }

    const minFreq = usedFrequencies[0];
    const maxFreq = usedFrequencies[usedFrequencies.length - 1];
    const averageFrequency = usedFrequencies.reduce((sum, freq) => sum + freq, 0) / usedFrequencies.length;
    const frequencySpread = maxFreq - minFreq;

    return {
      slotId,
      usedFrequencies,
      frequencyRange: { min: minFreq, max: maxFreq },
      averageFrequency: Math.round(averageFrequency),
      frequencySpread,
      signalCount: usedFrequencies.length
    };
  }

  /**
   * 清理所有时隙包
   */
  async cleanup(): Promise<void> {
    logger.info('Cleaning up');
    
    // 刷新持久化缓冲区
    try {
      await this.persistence.flush();
      logger.info('Persistence buffer flushed');
    } catch (error) {
      logger.error('flush persistence buffer failed', error);
    }

    // 清理持久化资源
    try {
      await this.persistence.cleanup();
      logger.info('Persistence resources cleaned up');
    } catch (error) {
      logger.error('clean up persistence resources failed', error);
    }
    
    this.slotPacks.clear();
    this.lastSlotPack = null; // 重置最新时隙包缓存
    this.removeAllListeners();
    
    logger.info('Cleanup complete');
  }
} 
