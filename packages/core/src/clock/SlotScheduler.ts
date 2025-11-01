import type { SlotInfo, DecodeRequest } from '@tx5dr/contracts';
import type { SlotClock } from './SlotClock.js';

/**
 * 解码队列接口 - 由 server 包实现
 */
export interface IDecodeQueue {
  /**
   * 推送解码请求到队列
   * @param request 解码请求
   */
  push(request: DecodeRequest): Promise<void> | void;
  
  /**
   * 获取队列长度
   */
  size(): number;
}

/**
 * 发射状态检查器接口 - 由 server 包实现
 */
export interface ITransmissionChecker {
  /**
   * 检查指定时隙是否有操作员准备发射
   * @param slotInfo 时隙信息，用于确定周期
   * @returns true 如果有操作员在该时隙的周期准备发射
   */
  hasActiveTransmissionsInCurrentCycle(slotInfo: SlotInfo): boolean;
}

/**
 * 时隙调度器 - 监听时隙事件并生成解码请求
 * 统一使用子窗口处理，支持单窗口和多窗口模式
 */
export class SlotScheduler {
  private slotClock: SlotClock;
  private decodeQueue: IDecodeQueue;
  private audioBufferProvider: AudioBufferProvider;
  private transmissionChecker?: ITransmissionChecker;
  private shouldDecodeWhileTransmitting?: () => boolean;
  private isActive = false;

  constructor(
    slotClock: SlotClock,
    decodeQueue: IDecodeQueue,
    audioBufferProvider: AudioBufferProvider,
    transmissionChecker?: ITransmissionChecker,
    shouldDecodeWhileTransmitting?: () => boolean
  ) {
    this.slotClock = slotClock;
    this.decodeQueue = decodeQueue;
    this.audioBufferProvider = audioBufferProvider;
    this.transmissionChecker = transmissionChecker;
    this.shouldDecodeWhileTransmitting = shouldDecodeWhileTransmitting;
  }
  
  /**
   * 启动调度器
   */
  start(): void {
    if (this.isActive) return;
    
    this.isActive = true;
    // 只监听子窗口事件
    this.slotClock.on('subWindow', this.handleSubWindow.bind(this));
  }
  
  /**
   * 停止调度器
   */
  stop(): void {
    if (!this.isActive) return;
    
    this.isActive = false;
    this.slotClock.off('subWindow', this.handleSubWindow.bind(this));
  }
  
  /**
   * 获取队列状态
   */
  getQueueSize(): number {
    return this.decodeQueue.size();
  }

  private async handleSubWindow(slotInfo: SlotInfo, windowIdx: number): Promise<void> {
    if (!this.isActive) return;

    // 读取配置：是否允许发射时解码（默认true保证向后兼容）
    const allowDecodeWhileTransmitting = this.shouldDecodeWhileTransmitting?.() ?? true;

    // 只有在配置禁用发射时解码的情况下，才检查发射状态
    if (!allowDecodeWhileTransmitting) {
      // 检查slotInfo对应的时隙是否有操作员准备发射
      // 传递slotInfo以确保周期判断与解码数据的时隙一致
      if (this.transmissionChecker?.hasActiveTransmissionsInCurrentCycle(slotInfo)) {
        console.log(`🚫 [SlotScheduler] 时隙${slotInfo.id}是发射周期且配置禁用解码，跳过窗口${windowIdx}`);
        return;
      }
    }

    try {
      const mode = this.slotClock.getMode();
      
      // 固定解码窗口长度（FT8: 15秒，FT4: 7.5秒）
      const decodeWindowMs = mode.slotMs;
      
      // 计算窗口的时间偏移（基于时隙结束时间）
      const windowOffsetMs = mode.windowTiming[windowIdx] || 0;
      console.log(`📡 [SlotScheduler] 使用窗口偏移: 窗口${windowIdx} = ${windowOffsetMs >= 0 ? '+' : ''}${windowOffsetMs}ms (基于时隙结束时间)`);
      
      // 计算解码窗口的起始时间（基于时隙结束时间 + 偏移）
      // 允许负偏移，可以获取时隙结束前或其他周期的音频数据
      const windowStartMs = slotInfo.startMs + windowOffsetMs;
      
      // 从音频缓冲区提供者获取固定长度的解码窗口数据
      // 支持负偏移，可以获取前一个周期的音频数据
      const pcmBuffer = await this.audioBufferProvider.getBuffer(
        windowStartMs,
        decodeWindowMs
      );
      
      // 获取音频缓冲区提供者的实际采样率
      const actualSampleRate = this.audioBufferProvider.getSampleRate ? 
        this.audioBufferProvider.getSampleRate() : 48000; // 默认 48kHz
      
      const decodeRequest: DecodeRequest = {
        slotId: slotInfo.id,
        windowIdx,
        pcm: pcmBuffer,
        sampleRate: actualSampleRate, // 使用实际采样率
        timestamp: Date.now(),
        windowOffsetMs
      };
      
      const offsetSign = windowOffsetMs >= 0 ? '+' : '';
      console.log(`📡 [SlotScheduler] 生成解码请求: 时隙=${slotInfo.id}, 窗口=${windowIdx}, 偏移=${offsetSign}${windowOffsetMs}ms, 解码长度=${decodeWindowMs}ms, PCM大小=${(pcmBuffer.byteLength/1024).toFixed(1)}KB, 采样率=${actualSampleRate}Hz`);
      
      // 推送到解码队列
      await this.decodeQueue.push(decodeRequest);
      
    } catch (error) {
      console.error(`SlotScheduler: 处理子窗口失败`, {
        slotId: slotInfo.id,
        windowIdx,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

/**
 * 音频缓冲区提供者接口
 * 由具体的音频系统实现（如 PortAudio）
 */
export interface AudioBufferProvider {
  /**
   * 获取指定时间范围的音频数据
   * @param startMs 开始时间戳（毫秒）
   * @param durationMs 持续时间（毫秒）
   * @returns PCM 音频数据
   */
  getBuffer(startMs: number, durationMs: number): Promise<ArrayBuffer>;
  
  /**
   * 获取当前采样率（可选）
   * @returns 采样率（Hz）
   */
  getSampleRate?(): number;
} 