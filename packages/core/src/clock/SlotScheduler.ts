import type { SlotInfo, DecodeRequest } from '@tx5dr/contracts';
import type { SlotClock } from './SlotClock.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('SlotScheduler');

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
  private readonly boundHandleSubWindow: (slotInfo: SlotInfo, windowIdx: number) => void;

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
    this.boundHandleSubWindow = this.handleSubWindow.bind(this);
  }
  
  /**
   * 启动调度器
   */
  start(): void {
    if (this.isActive) return;
    
    this.isActive = true;
    // 只监听子窗口事件
    this.slotClock.on('subWindow', this.boundHandleSubWindow);
  }
  
  /**
   * 停止调度器
   */
  stop(): void {
    if (!this.isActive) return;
    
    this.isActive = false;
    this.slotClock.off('subWindow', this.boundHandleSubWindow);
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
        logger.debug(`Transmit cycle detected and decode-while-transmitting disabled, skipping slot=${slotInfo.id} window=${windowIdx}`);
        return;
      }
    }

    try {
      const mode = this.slotClock.getMode();
      
      // 计算窗口的时间偏移（基于时隙结束时间）
      const windowOffsetMs = mode.windowTiming[windowIdx] || 0;

      // 音频始终从时隙起点截取（与 WSJT-X 一致）
      // 截取长度 = slotMs + offset，每轮解码随触发时间推移获得更多音频数据
      // 例：FT8 offset=-3200 → 截取 11.8s，offset=-1500 → 截取 13.5s，offset=0 → 截取 15.0s
      const windowStartMs = slotInfo.startMs;
      const windowDurationMs = mode.slotMs + windowOffsetMs;
      logger.debug(`Window capture: window=${windowIdx}, start=slotStart, duration=${windowDurationMs}ms (offset=${windowOffsetMs >= 0 ? '+' : ''}${windowOffsetMs}ms)`);

      // 从音频缓冲区提供者获取解码窗口数据
      const pcmBuffer = await this.audioBufferProvider.getBuffer(
        windowStartMs,
        windowDurationMs
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
      logger.debug(`Decode request: slot=${slotInfo.id}, window=${windowIdx}, offset=${offsetSign}${windowOffsetMs}ms, duration=${windowDurationMs}ms, pcm=${(pcmBuffer.byteLength/1024).toFixed(1)}KB, sampleRate=${actualSampleRate}Hz`);
      
      // 推送到解码队列
      await this.decodeQueue.push(decodeRequest);
      
    } catch (error) {
      logger.error(`Failed to handle sub-window: slot=${slotInfo.id}, window=${windowIdx}, error=${error instanceof Error ? error.message : String(error)}`);
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
