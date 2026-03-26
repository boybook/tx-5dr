/* eslint-disable @typescript-eslint/no-explicit-any */
// TransmissionTracker - 状态跟踪需要使用any

import { EventEmitter } from 'eventemitter3';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('TransmissionTracker');

/**
 * 传输阶段枚举
 */
export enum TransmissionPhase {
  IDLE = 'idle',              // 空闲状态
  PREPARING = 'preparing',    // 准备中（编码阶段）
  MIXING = 'mixing',          // 混音中
  READY = 'ready',           // 音频就绪，等待发射
  TRANSMITTING = 'transmitting', // 正在发射
  COMPLETED = 'completed',    // 发射完成
  FAILED = 'failed'          // 发射失败
}

/**
 * 警告级别
 */
export enum WarningLevel {
  INFO = 'info',
  WARN = 'warn', 
  ERROR = 'error'
}

/**
 * 传输状态信息
 */
export interface TransmissionState {
  operatorId: string;
  slotId: string;
  phase: TransmissionPhase;
  
  // 时间戳
  prepareStartTime?: number;
  encodeStartTime?: number;
  encodeCompleteTime?: number;
  mixingStartTime?: number;
  mixingCompleteTime?: number;
  readyTime?: number;
  audioAddedToMixerTime?: number;
  mixedAudioReadyTime?: number;
  pttStartTime?: number;
  audioPlaybackStartTime?: number;
  transmitStartTime?: number;
  transmitCompleteTime?: number;
  
  // 音频数据
  audioData?: Float32Array;
  sampleRate?: number;
  duration?: number;
  
  // 警告信息
  warnings: Array<{
    level: WarningLevel;
    message: string;
    timestamp: number;
  }>;
  
  // 性能指标
  encodeTimeMs?: number;
  mixingTimeMs?: number;
  totalPrepareTimeMs?: number;
  audioMixerWaitTimeMs?: number;
  mixedAudioProcessTimeMs?: number;
  pttActivationTimeMs?: number;
  totalPipelineTimeMs?: number; // 从编码开始到实际播放的总时间
  actualDelayMs?: number; // 相对于目标发射时间的延迟
}

/**
 * 传输跟踪器事件
 */
export interface TransmissionTrackerEvents {
  'stateChanged': (state: TransmissionState) => void;
  'warningAdded': (operatorId: string, warning: { level: WarningLevel; message: string; timestamp: number }) => void;
  'transmissionReady': (operatorId: string, state: TransmissionState) => void;
  'transmissionDelayed': (operatorId: string, delayMs: number) => void;
}

/**
 * 传输状态跟踪器
 * 管理每个操作员在发射周期中的音频处理状态
 */
export class TransmissionTracker extends EventEmitter<TransmissionTrackerEvents> {
  private states = new Map<string, TransmissionState>();
  private readonly targetTransmitTime = new Map<string, number>(); // 每个时隙的目标发射时间
  
  /**
   * 开始新的传输会话
   */
  startTransmission(operatorId: string, slotId: string, targetTime: number): void {
    const now = Date.now();

    // 检查时间余量
    const timeUntilTarget = targetTime - now;

    // 清理旧状态
    this.states.delete(operatorId);
    this.targetTransmitTime.set(slotId, targetTime);

    const state: TransmissionState = {
      operatorId,
      slotId,
      phase: TransmissionPhase.PREPARING,
      prepareStartTime: now,
      warnings: []
    };

    this.states.set(operatorId, state);

    logger.debug(`Transmission tracking started: operator=${operatorId}, slot=${slotId}, target=${new Date(targetTime).toISOString()}, timeLeft=${timeUntilTarget}ms`);

    // 边界检测：检查是否有足够时间完成编码和混音
    if (timeUntilTarget < 200) {
      this.addWarning(operatorId, WarningLevel.ERROR, `Insufficient time remaining: only ${timeUntilTarget}ms left, encoding may not complete in time`);
    } else if (timeUntilTarget < 400) {
      this.addWarning(operatorId, WarningLevel.WARN, `Time is tight: only ${timeUntilTarget}ms remaining`);
    } else {
      this.addWarning(operatorId, WarningLevel.INFO, `Encoding started: ${timeUntilTarget}ms until target playback`);
    }

    this.emit('stateChanged', state);
  }
  
  /**
   * 更新传输阶段
   */
  updatePhase(operatorId: string, phase: TransmissionPhase, metadata?: any): void {
    const state = this.states.get(operatorId);
    if (!state) {
      logger.warn(`Operator state not found: ${operatorId}`);
      return;
    }
    
    const now = Date.now();
    const previousPhase = state.phase;
    state.phase = phase;
    
    // 记录时间戳并计算性能指标
    switch (phase) {
      case TransmissionPhase.PREPARING:
        state.encodeStartTime = now;
        break;
        
      case TransmissionPhase.MIXING:
        state.encodeCompleteTime = now;
        state.mixingStartTime = now;
        
        if (state.encodeStartTime) {
          state.encodeTimeMs = now - state.encodeStartTime;
          this.checkPerformance(operatorId, 'encode', state.encodeTimeMs);
        }
        break;
        
      case TransmissionPhase.READY:
        state.readyTime = now;
        
        if (state.mixingStartTime) {
          state.mixingTimeMs = now - state.mixingStartTime;
          this.checkPerformance(operatorId, 'mixing', state.mixingTimeMs);
        }
        
        if (state.prepareStartTime) {
          state.totalPrepareTimeMs = now - state.prepareStartTime;
          this.checkPerformance(operatorId, 'total', state.totalPrepareTimeMs);
        }
        
        // 存储音频数据
        if (metadata?.audioData) {
          state.audioData = metadata.audioData;
          state.sampleRate = metadata.sampleRate;
          state.duration = metadata.duration;
        }
        
        this.emit('transmissionReady', operatorId, state);
        break;
        
      case TransmissionPhase.TRANSMITTING: {
        state.transmitStartTime = now;

        const targetTime = this.targetTransmitTime.get(state.slotId);
        if (targetTime) {
          state.actualDelayMs = now - targetTime;
          if (state.actualDelayMs > 50) {
            this.addWarning(operatorId, WarningLevel.WARN, `Transmission delayed ${state.actualDelayMs}ms`);
            this.emit('transmissionDelayed', operatorId, state.actualDelayMs);
          }
        }
        break;
      }
        
      case TransmissionPhase.COMPLETED:
        state.transmitCompleteTime = now;
        break;
        
      case TransmissionPhase.FAILED:
        this.addWarning(operatorId, WarningLevel.ERROR, `Transmission failed: ${metadata?.error || 'unknown error'}`);
        break;
    }
    
    logger.debug(`State updated: operator=${operatorId}, ${previousPhase} -> ${phase}`);
    this.emit('stateChanged', state);
  }
  
  /**
   * 检查传输是否就绪
   */
  isTransmissionReady(operatorId: string): boolean {
    const state = this.states.get(operatorId);
    return state?.phase === TransmissionPhase.READY;
  }
  
  /**
   * 获取音频数据
   */
  getAudioData(operatorId: string): { audioData: Float32Array; sampleRate: number; duration: number } | null {
    const state = this.states.get(operatorId);
    if (state?.audioData && state.sampleRate && state.duration) {
      return {
        audioData: state.audioData,
        sampleRate: state.sampleRate,
        duration: state.duration
      };
    }
    return null;
  }
  
  /**
   * 获取传输状态
   */
  getState(operatorId: string): TransmissionState | undefined {
    return this.states.get(operatorId);
  }
  
  /**
   * 获取所有活跃的传输状态
   */
  getAllActiveStates(): TransmissionState[] {
    return Array.from(this.states.values()).filter(state => 
      state.phase !== TransmissionPhase.COMPLETED && 
      state.phase !== TransmissionPhase.FAILED
    );
  }
  
  /**
   * 添加警告
   */
  private addWarning(operatorId: string, level: WarningLevel, message: string): void {
    const state = this.states.get(operatorId);
    if (!state) return;
    
    const warning = {
      level,
      message,
      timestamp: Date.now()
    };
    
    state.warnings.push(warning);
    if (level === WarningLevel.ERROR) {
      logger.debug(`[${operatorId}] ERROR: ${message}`);
    } else if (level === WarningLevel.WARN) {
      logger.debug(`[${operatorId}] WARN: ${message}`);
    } else {
      logger.debug(`[${operatorId}] ${message}`);
    }
    
    this.emit('warningAdded', operatorId, warning);
  }
  
  /**
   * 检查性能指标并生成警告
   */
  private checkPerformance(operatorId: string, type: 'encode' | 'mixing' | 'total', timeMs: number): void {
    let warningThreshold: number;
    let errorThreshold: number;
    
    switch (type) {
      case 'encode':
        warningThreshold = 500; // 编码超过500ms警告
        errorThreshold = 1000;  // 编码超过1000ms错误
        break;
      case 'mixing':
        warningThreshold = 150; // 混音超过150ms警告  
        errorThreshold = 300;   // 混音超过300ms错误
        break;
      case 'total':
        warningThreshold = 700; // 总准备时间超过700ms警告
        errorThreshold = 1200;  // 总准备时间超过1200ms错误
        break;
    }
    
    if (timeMs > errorThreshold) {
      this.addWarning(operatorId, WarningLevel.ERROR, `${type} processing time too long: ${timeMs}ms (threshold: ${errorThreshold}ms)`);
    } else if (timeMs > warningThreshold) {
      this.addWarning(operatorId, WarningLevel.WARN, `${type} processing time elevated: ${timeMs}ms (threshold: ${warningThreshold}ms)`);
    } else {
      this.addWarning(operatorId, WarningLevel.INFO, `${type} processing complete: ${timeMs}ms`);
    }
  }
  
  /**
   * 清理完成的传输状态
   */
  cleanup(): void {
    const now = Date.now();
    const maxAge = 60000; // 保留1分钟的历史状态
    
    for (const [operatorId, state] of this.states.entries()) {
      if (state.transmitCompleteTime && (now - state.transmitCompleteTime) > maxAge) {
        this.states.delete(operatorId);
      }
    }
  }
  
  /**
   * 记录音频添加到混音器的时间
   */
  recordAudioAddedToMixer(operatorId: string): void {
    const state = this.states.get(operatorId);
    if (!state) return;
    
    const now = Date.now();
    state.audioAddedToMixerTime = now;
    
    if (state.readyTime) {
      state.audioMixerWaitTimeMs = now - state.readyTime;
    }
    
    logger.debug(`Audio added to mixer: ${operatorId}, wait=${state.audioMixerWaitTimeMs || 0}ms`);
  }
  
  /**
   * 记录混音完成的时间
   */
  recordMixedAudioReady(operatorId: string): void {
    const state = this.states.get(operatorId);
    if (!state) return;
    
    const now = Date.now();
    state.mixedAudioReadyTime = now;
    
    if (state.audioAddedToMixerTime) {
      state.mixedAudioProcessTimeMs = now - state.audioAddedToMixerTime;
    }
    
    logger.debug(`Mix complete: ${operatorId}, mix process time=${state.mixedAudioProcessTimeMs || 0}ms`);
  }
  
  /**
   * 记录PTT启动时间
   */
  recordPTTStart(operatorId: string): void {
    const state = this.states.get(operatorId);
    if (!state) return;
    
    const now = Date.now();
    state.pttStartTime = now;
    
    if (state.mixedAudioReadyTime) {
      state.pttActivationTimeMs = now - state.mixedAudioReadyTime;
    }
    
    logger.debug(`PTT start: ${operatorId}, PTT activation time=${state.pttActivationTimeMs || 0}ms`);
  }
  
  /**
   * 记录音频播放开始时间并计算总时间花费
   */
  recordAudioPlaybackStart(operatorId: string): void {
    const state = this.states.get(operatorId);
    if (!state) return;
    
    const now = Date.now();
    state.audioPlaybackStartTime = now;
    
    if (state.encodeStartTime) {
      state.totalPipelineTimeMs = now - state.encodeStartTime;
    }
    
    logger.debug(`Audio playback started: ${operatorId}`);
    
    // 打印详细的时间花费统计
    this.printTimingStatistics(operatorId);
  }
  
  /**
   * 打印详细的时间花费统计
   */
  private printTimingStatistics(operatorId: string): void {
    const state = this.states.get(operatorId);
    if (!state) return;

    logger.debug(`===== Operator ${operatorId} transmission timing stats =====`);

    // Timestamps (debug)
    if (state.encodeStartTime) logger.debug(`  encode start: ${new Date(state.encodeStartTime).toISOString()}`);
    if (state.encodeCompleteTime) logger.debug(`  encode complete: ${new Date(state.encodeCompleteTime).toISOString()}`);
    if (state.readyTime) logger.debug(`  audio ready: ${new Date(state.readyTime).toISOString()}`);
    if (state.audioAddedToMixerTime) logger.debug(`  added to mixer: ${new Date(state.audioAddedToMixerTime).toISOString()}`);
    if (state.mixedAudioReadyTime) logger.debug(`  mix complete: ${new Date(state.mixedAudioReadyTime).toISOString()}`);
    if (state.pttStartTime) logger.debug(`  PTT start: ${new Date(state.pttStartTime).toISOString()}`);
    if (state.audioPlaybackStartTime) logger.debug(`  playback start: ${new Date(state.audioPlaybackStartTime).toISOString()}`);

    let accumulatedTime = 0;

    if (state.encodeTimeMs !== undefined) {
      logger.debug(`  encode time: ${state.encodeTimeMs}ms`);
      accumulatedTime += state.encodeTimeMs;
    } else if (state.encodeStartTime && state.encodeCompleteTime) {
      const encodeTime = state.encodeCompleteTime - state.encodeStartTime;
      logger.debug(`  encode time: ${encodeTime}ms (recalculated)`);
      accumulatedTime += encodeTime;
    }

    if (state.encodeCompleteTime && state.readyTime) {
      const processingTime = state.readyTime - state.encodeCompleteTime;
      logger.debug(`  post-encode processing: ${processingTime}ms`);
      accumulatedTime += processingTime;
    }

    if (state.readyTime && state.audioAddedToMixerTime) {
      const waitTime = state.audioAddedToMixerTime - state.readyTime;
      logger.debug(`  audio processing wait: ${waitTime}ms`);
      accumulatedTime += waitTime;
    }

    if (state.mixingTimeMs !== undefined) {
      logger.debug(`  mixing time: ${state.mixingTimeMs}ms`);
    }

    if (state.audioMixerWaitTimeMs !== undefined) {
      logger.debug(`  mixer wait time: ${state.audioMixerWaitTimeMs}ms`);
      accumulatedTime += state.audioMixerWaitTimeMs;
    }

    if (state.mixedAudioProcessTimeMs !== undefined) {
      logger.debug(`  mix process time: ${state.mixedAudioProcessTimeMs}ms`);
      accumulatedTime += state.mixedAudioProcessTimeMs;
    }

    if (state.pttActivationTimeMs !== undefined) {
      logger.debug(`  PTT activation time: ${state.pttActivationTimeMs}ms`);
      accumulatedTime += state.pttActivationTimeMs;
    }

    if (state.totalPipelineTimeMs !== undefined) {
      logger.debug(`  total pipeline time: ${state.totalPipelineTimeMs}ms (encode start -> playback start)`);
      logger.debug(`  accounted time: ${accumulatedTime}ms`);
      const unaccountedTime = state.totalPipelineTimeMs - accumulatedTime;
      if (unaccountedTime > 10) {
        logger.debug(`  unaccounted time: ${unaccountedTime}ms`);
      }
    }

    if (state.actualDelayMs !== undefined) {
      logger.debug(`  actual delay: ${state.actualDelayMs}ms (relative to target transmit time)`);
    }

    const targetTime = this.targetTransmitTime.get(state.slotId);
    if (targetTime && state.audioPlaybackStartTime) {
      const totalDelay = state.audioPlaybackStartTime - targetTime;
      logger.debug(`  total delay: ${totalDelay}ms (target time -> actual playback)`);

      if (totalDelay > 100) {
        this.addWarning(operatorId, WarningLevel.ERROR, `Total delay too large: ${totalDelay}ms`);
      } else if (totalDelay > 50) {
        this.addWarning(operatorId, WarningLevel.WARN, `Total delay elevated: ${totalDelay}ms`);
      }
    }

    logger.debug(`=======================================`);
  }

  /**
   * 获取性能统计
   */
  getPerformanceStats(): {
    averageEncodeTime: number;
    averageMixingTime: number;
    averageTotalTime: number;
    delayedTransmissions: number;
    totalTransmissions: number;
  } {
    const completedStates = Array.from(this.states.values()).filter(state => 
      state.phase === TransmissionPhase.COMPLETED || state.phase === TransmissionPhase.FAILED
    );
    
    if (completedStates.length === 0) {
      return {
        averageEncodeTime: 0,
        averageMixingTime: 0,
        averageTotalTime: 0,
        delayedTransmissions: 0,
        totalTransmissions: 0
      };
    }
    
    const encodeTimes = completedStates.filter(s => s.encodeTimeMs).map(s => s.encodeTimeMs!);
    const mixingTimes = completedStates.filter(s => s.mixingTimeMs).map(s => s.mixingTimeMs!);
    const totalTimes = completedStates.filter(s => s.totalPrepareTimeMs).map(s => s.totalPrepareTimeMs!);
    const delayedCount = completedStates.filter(s => s.actualDelayMs && s.actualDelayMs > 50).length;
    
    return {
      averageEncodeTime: encodeTimes.length > 0 ? encodeTimes.reduce((a, b) => a + b, 0) / encodeTimes.length : 0,
      averageMixingTime: mixingTimes.length > 0 ? mixingTimes.reduce((a, b) => a + b, 0) / mixingTimes.length : 0,
      averageTotalTime: totalTimes.length > 0 ? totalTimes.reduce((a, b) => a + b, 0) / totalTimes.length : 0,
      delayedTransmissions: delayedCount,
      totalTransmissions: completedStates.length
    };
  }
}