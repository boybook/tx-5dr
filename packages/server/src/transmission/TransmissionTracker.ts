import { EventEmitter } from 'eventemitter3';

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

    console.log(`🎯 [TransmissionTracker] 开始传输跟踪: 操作员=${operatorId}, 时隙=${slotId}, 目标时间=${new Date(targetTime).toISOString()}, 剩余时间=${timeUntilTarget}ms`);

    // 边界检测：检查是否有足够时间完成编码和混音
    if (timeUntilTarget < 200) {
      this.addWarning(operatorId, WarningLevel.ERROR, `剩余时间不足: 仅剩${timeUntilTarget}ms，可能无法及时完成编码`);
    } else if (timeUntilTarget < 400) {
      this.addWarning(operatorId, WarningLevel.WARN, `剩余时间紧张: 仅剩${timeUntilTarget}ms`);
    } else {
      this.addWarning(operatorId, WarningLevel.INFO, `开始编码: 距离目标播放还有${timeUntilTarget}ms`);
    }

    this.emit('stateChanged', state);
  }
  
  /**
   * 更新传输阶段
   */
  updatePhase(operatorId: string, phase: TransmissionPhase, metadata?: any): void {
    const state = this.states.get(operatorId);
    if (!state) {
      console.warn(`⚠️ [TransmissionTracker] 未找到操作员状态: ${operatorId}`);
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
        
      case TransmissionPhase.TRANSMITTING:
        state.transmitStartTime = now;
        
        // 计算实际延迟
        const targetTime = this.targetTransmitTime.get(state.slotId);
        if (targetTime) {
          state.actualDelayMs = now - targetTime;
          if (state.actualDelayMs > 50) { // 超过50ms认为是延迟
            this.addWarning(operatorId, WarningLevel.WARN, `发射延迟 ${state.actualDelayMs}ms`);
            this.emit('transmissionDelayed', operatorId, state.actualDelayMs);
          }
        }
        break;
        
      case TransmissionPhase.COMPLETED:
        state.transmitCompleteTime = now;
        break;
        
      case TransmissionPhase.FAILED:
        this.addWarning(operatorId, WarningLevel.ERROR, `传输失败: ${metadata?.error || '未知错误'}`);
        break;
    }
    
    console.log(`📊 [TransmissionTracker] 状态更新: 操作员=${operatorId}, ${previousPhase} -> ${phase}`);
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
    console.log(`${level === WarningLevel.ERROR ? '❌' : level === WarningLevel.WARN ? '⚠️' : 'ℹ️'} [TransmissionTracker] ${operatorId}: ${message}`);
    
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
      this.addWarning(operatorId, WarningLevel.ERROR, `${type}处理时间过长: ${timeMs}ms (阈值: ${errorThreshold}ms)`);
    } else if (timeMs > warningThreshold) {
      this.addWarning(operatorId, WarningLevel.WARN, `${type}处理时间较长: ${timeMs}ms (阈值: ${warningThreshold}ms)`);
    } else {
      this.addWarning(operatorId, WarningLevel.INFO, `${type}处理完成: ${timeMs}ms`);
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
    
    console.log(`⏱️ [TransmissionTracker] 音频已添加到混音器: ${operatorId}, 等待时间=${state.audioMixerWaitTimeMs || 0}ms`);
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
    
    console.log(`⏱️ [TransmissionTracker] 混音完成: ${operatorId}, 混音处理时间=${state.mixedAudioProcessTimeMs || 0}ms`);
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
    
    console.log(`⏱️ [TransmissionTracker] PTT启动: ${operatorId}, PTT激活时间=${state.pttActivationTimeMs || 0}ms`);
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
    
    console.log(`⏱️ [TransmissionTracker] 音频播放开始: ${operatorId}`);
    
    // 打印详细的时间花费统计
    this.printTimingStatistics(operatorId);
  }
  
  /**
   * 打印详细的时间花费统计
   */
  private printTimingStatistics(operatorId: string): void {
    const state = this.states.get(operatorId);
    if (!state) return;
    
    console.log(`📊 [TransmissionTracker] ===== 操作员 ${operatorId} 发射时间统计 =====`);
    
    // 打印所有时间戳（用于调试）
    console.log(`   📅 时间戳记录:`);
    if (state.encodeStartTime) console.log(`      编码开始: ${new Date(state.encodeStartTime).toISOString()}`);
    if (state.encodeCompleteTime) console.log(`      编码完成: ${new Date(state.encodeCompleteTime).toISOString()}`);
    if (state.readyTime) console.log(`      音频就绪: ${new Date(state.readyTime).toISOString()}`);
    if (state.audioAddedToMixerTime) console.log(`      添加到混音器: ${new Date(state.audioAddedToMixerTime).toISOString()}`);
    if (state.mixedAudioReadyTime) console.log(`      混音完成: ${new Date(state.mixedAudioReadyTime).toISOString()}`);
    if (state.pttStartTime) console.log(`      PTT启动: ${new Date(state.pttStartTime).toISOString()}`);
    if (state.audioPlaybackStartTime) console.log(`      播放开始: ${new Date(state.audioPlaybackStartTime).toISOString()}`);
    
    // 计算各阶段时间
    let accumulatedTime = 0;
    
    if (state.encodeTimeMs !== undefined) {
      console.log(`   🔄 编码时间: ${state.encodeTimeMs}ms`);
      accumulatedTime += state.encodeTimeMs;
    } else if (state.encodeStartTime && state.encodeCompleteTime) {
      const encodeTime = state.encodeCompleteTime - state.encodeStartTime;
      console.log(`   🔄 编码时间: ${encodeTime}ms (重新计算)`);
      accumulatedTime += encodeTime;
    }
    
    // 编码完成到音频就绪的时间
    if (state.encodeCompleteTime && state.readyTime) {
      const processingTime = state.readyTime - state.encodeCompleteTime;
      console.log(`   ⚙️ 编码后处理时间: ${processingTime}ms`);
      accumulatedTime += processingTime;
    }
    
    // 音频就绪到添加到混音器的时间
    if (state.readyTime && state.audioAddedToMixerTime) {
      const waitTime = state.audioAddedToMixerTime - state.readyTime;
      console.log(`   ⏳ 音频处理等待时间: ${waitTime}ms`);
      accumulatedTime += waitTime;
    }
    
    if (state.mixingTimeMs !== undefined) {
      console.log(`   🎵 混音时间: ${state.mixingTimeMs}ms`);
    }
    
    if (state.audioMixerWaitTimeMs !== undefined) {
      console.log(`   ⏳ 混音器等待时间: ${state.audioMixerWaitTimeMs}ms`);
      accumulatedTime += state.audioMixerWaitTimeMs;
    }
    
    if (state.mixedAudioProcessTimeMs !== undefined) {
      console.log(`   🎛️ 混音处理时间: ${state.mixedAudioProcessTimeMs}ms`);
      accumulatedTime += state.mixedAudioProcessTimeMs;
    }
    
    if (state.pttActivationTimeMs !== undefined) {
      console.log(`   📡 PTT激活时间: ${state.pttActivationTimeMs}ms`);
      accumulatedTime += state.pttActivationTimeMs;
    }
    
    if (state.totalPipelineTimeMs !== undefined) {
      console.log(`   ⏱️ 总管道时间: ${state.totalPipelineTimeMs}ms (编码开始 -> 播放开始)`);
      console.log(`   🔍 已统计时间: ${accumulatedTime}ms`);
      const unaccountedTime = state.totalPipelineTimeMs - accumulatedTime;
      if (unaccountedTime > 10) {
        console.log(`   ❓ 未统计时间: ${unaccountedTime}ms`);
      }
    }
    
    if (state.actualDelayMs !== undefined) {
      console.log(`   🎯 实际延迟: ${state.actualDelayMs}ms (相对于目标发射时间)`);
    }
    
    // 计算目标发射时间到实际播放开始的延迟
    const targetTime = this.targetTransmitTime.get(state.slotId);
    if (targetTime && state.audioPlaybackStartTime) {
      const totalDelay = state.audioPlaybackStartTime - targetTime;
      console.log(`   🚨 总延迟: ${totalDelay}ms (目标时间 -> 实际播放)`);
      
      if (totalDelay > 100) {
        this.addWarning(operatorId, WarningLevel.ERROR, `总延迟过大: ${totalDelay}ms`);
      } else if (totalDelay > 50) {
        this.addWarning(operatorId, WarningLevel.WARN, `总延迟较大: ${totalDelay}ms`);
      }
    }
    
    console.log(`📊 [TransmissionTracker] =======================================`);
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