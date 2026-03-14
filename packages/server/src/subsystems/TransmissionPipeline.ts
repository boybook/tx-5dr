import type { EventEmitter } from 'eventemitter3';
import type { DigitalRadioEngineEvents, ModeDescriptor } from '@tx5dr/contracts';
import type { ClockSourceSystem } from '@tx5dr/core';
import type { AudioStreamManager } from '../audio/AudioStreamManager.js';
import type { AudioMixer, MixedAudio } from '../audio/AudioMixer.js';
import type { PhysicalRadioManager } from '../radio/PhysicalRadioManager.js';
import type { SpectrumScheduler } from '../audio/SpectrumScheduler.js';
import { TransmissionTracker, TransmissionPhase } from '../transmission/TransmissionTracker.js';
import type { WSJTXEncodeWorkQueue } from '../decode/WSJTXEncodeWorkQueue.js';
import type { RadioOperatorManager } from '../operator/RadioOperatorManager.js';
import { ListenerManager } from './ListenerManager.js';

export interface TransmissionPipelineDeps {
  engineEmitter: EventEmitter<DigitalRadioEngineEvents>;
  audioMixer: AudioMixer;
  audioStreamManager: AudioStreamManager;
  radioManager: PhysicalRadioManager;
  spectrumScheduler: SpectrumScheduler;
  transmissionTracker: TransmissionTracker;
  encodeQueue: WSJTXEncodeWorkQueue;
  operatorManager: RadioOperatorManager;
  clockSource: ClockSourceSystem;
  getCurrentMode: () => ModeDescriptor;
}

/**
 * 发射管线子系统
 *
 * 职责：encode→mix→PTT→play 全流程、编码跟踪
 */
export class TransmissionPipeline {
  private lm = new ListenerManager();

  // PTT状态管理
  private _isPTTActive = false;
  private pttTimeoutId: NodeJS.Timeout | null = null;

  // 编码状态跟踪
  private currentSlotExpectedEncodes: number = 0;
  private currentSlotCompletedEncodes: number = 0;
  private currentSlotId: string = '';

  constructor(private deps: TransmissionPipelineDeps) {}

  getIsPTTActive(): boolean {
    return this._isPTTActive;
  }

  /**
   * 注册编码/混音事件监听器（doStart 时调用）
   */
  setup(): void {
    const { encodeQueue, audioMixer } = this.deps;

    // 编码完成事件
    this.lm.listen(encodeQueue, 'encodeComplete', async (result: {
      operatorId: string;
      audioData: Float32Array;
      sampleRate: number;
      duration: number;
      request?: { timeSinceSlotStartMs?: number; requestId?: string };
    }) => {
      await this.handleEncodeComplete(result);
    });

    // 编码错误事件
    this.lm.listen(encodeQueue, 'encodeError', (error: Error, request: { operatorId: string }) => {
      console.error(`❌ [TransmissionPipeline] 编码失败: 操作员=${request.operatorId}:`, error.message);
      this.deps.engineEmitter.emit('transmissionComplete', {
        operatorId: request.operatorId,
        success: false,
        error: error.message
      });
    });

    // 混音完成事件
    this.lm.listen(audioMixer, 'mixedAudioReady', async (mixedAudio: MixedAudio) => {
      await this.handleMixedAudioReady(mixedAudio);
    });

    console.log(`✅ [TransmissionPipeline] 事件监听器已注册 (${this.lm.count} 个)`);
  }

  /**
   * 清理监听器和 PTT 定时器（doStop 时调用）
   */
  teardown(): void {
    // 清理 PTT 定时器（修复 D4）
    if (this.pttTimeoutId) {
      clearTimeout(this.pttTimeoutId);
      this.pttTimeoutId = null;
    }

    this.lm.disposeAll();
    console.log(`✅ [TransmissionPipeline] 事件监听器已清理`);
  }

  /**
   * 时隙开始时调用
   */
  onSlotStart(): void {
    this.deps.audioMixer.clearSlotCache();
  }

  /**
   * encodeStart 事件中调用
   */
  onEncodeStart(slotInfo: { id: string }): void {
    this.currentSlotId = slotInfo.id;
    this.currentSlotExpectedEncodes = 0;
    this.currentSlotCompletedEncodes = 0;

    const pendingCount = this.deps.operatorManager.getPendingTransmissionsCount();
    this.deps.operatorManager.processPendingTransmissions(slotInfo);
    this.currentSlotExpectedEncodes = pendingCount;

    if (this.currentSlotExpectedEncodes > 0) {
      console.log(`📊 [编码跟踪] 时隙 ${slotInfo.id}: 期望 ${this.currentSlotExpectedEncodes} 个编码任务`);
    }
  }

  /**
   * transmitStart 事件中调用（检查编码超时）
   */
  onTransmitStart(_slotInfo: { id: string }): void {
    if (this.currentSlotExpectedEncodes > 0 &&
        this.currentSlotCompletedEncodes < this.currentSlotExpectedEncodes) {
      const missingCount = this.currentSlotExpectedEncodes - this.currentSlotCompletedEncodes;
      console.warn(`⚠️ [编码超时] 发射时刻到达但编码未完成！期望 ${this.currentSlotExpectedEncodes} 个，已完成 ${this.currentSlotCompletedEncodes} 个，缺少 ${missingCount} 个`);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.deps.engineEmitter.emit('timingWarning' as any, {
        title: '⚠️ 编码超时警告',
        text: `发射时刻已到达，但仍有 ${missingCount} 个编码任务未完成。这可能导致发射延迟或失败。建议检查发射补偿设置或减少同时发射的操作员数量。`
      });
    } else if (this.currentSlotExpectedEncodes > 0) {
      console.log(`✅ [编码跟踪] 所有编码任务已按时完成 (${this.currentSlotCompletedEncodes}/${this.currentSlotExpectedEncodes})`);
    }
  }

  /**
   * 强制停止PTT
   */
  async forceStopPTT(): Promise<void> {
    if (this._isPTTActive) {
      console.log('📡 [PTT] 强制停止PTT');
      await this.stopPTT();
    }
  }

  /**
   * 强制停止当前发射（公开方法）
   */
  async forceStopTransmission(): Promise<void> {
    console.log('🛑 [TransmissionPipeline] 强制停止发射');

    try {
      const stoppedBytes = await this.deps.audioStreamManager.stopCurrentPlayback();
      console.log(`🛑 [TransmissionPipeline] 已停止音频播放，丢弃 ${stoppedBytes} 字节`);

      await this.forceStopPTT();

      this.deps.audioMixer.clear();
      console.log('🛑 [TransmissionPipeline] 已清空音频混音器队列');

      console.log('✅ [TransmissionPipeline] 强制停止发射完成');
    } catch (error) {
      console.error('❌ [TransmissionPipeline] 强制停止发射失败:', error);
      throw error;
    }
  }

  // ─── 内部方法 ────────────────────────────────────

  private async startPTT(): Promise<void> {
    const pttStartTime = Date.now();
    console.log(`📡 [PTT] 开始启动PTT (${new Date(pttStartTime).toISOString()})`);

    if (this._isPTTActive) {
      console.log('📡 [PTT] PTT已经激活，跳过启动');
      return;
    }

    if (this.pttTimeoutId) {
      clearTimeout(this.pttTimeoutId);
      this.pttTimeoutId = null;
    }

    if (this.deps.radioManager.isConnected()) {
      try {
        console.log(`📡 [PTT] 调用radioManager.setPTT(true)...`);
        const radioCallStartTime = Date.now();

        await this.deps.radioManager.setPTT(true);

        const radioCallDuration = Date.now() - radioCallStartTime;
        console.log(`📡 [PTT] radioManager.setPTT(true)完成，耗时: ${radioCallDuration}ms`);

        this._isPTTActive = true;

        this.deps.spectrumScheduler.setPTTActive(true);

        const currentAudio = this.deps.audioMixer.getCurrentMixedAudio();
        const operatorIds = currentAudio ? currentAudio.operatorIds : [];
        this.deps.engineEmitter.emit('pttStatusChanged', {
          isTransmitting: true,
          operatorIds
        });
        console.log(`📡 [PTT] PTT状态广播: 开始发射, 操作员=[${operatorIds.join(', ')}]`);

        const pttTotalDuration = Date.now() - pttStartTime;
        console.log(`📡 [PTT] PTT启动成功，频谱分析已暂停，总耗时: ${pttTotalDuration}ms`);
      } catch (error) {
        console.error('📡 [PTT] PTT启动失败:', error);
        throw error;
      }
    } else {
      console.log('📡 [PTT] 电台未连接，跳过PTT启动');
    }
  }

  private async stopPTT(): Promise<void> {
    if (!this._isPTTActive) {
      console.log('📡 [PTT] PTT已经停止，跳过操作');
      return;
    }

    if (this.pttTimeoutId) {
      clearTimeout(this.pttTimeoutId);
      this.pttTimeoutId = null;
    }

    if (this.deps.radioManager.isConnected()) {
      try {
        await this.deps.radioManager.setPTT(false);
        this._isPTTActive = false;

        this.deps.spectrumScheduler.setPTTActive(false);

        this.deps.engineEmitter.emit('pttStatusChanged', {
          isTransmitting: false,
          operatorIds: []
        });
        console.log(`📡 [PTT] PTT状态广播: 停止发射`);

        console.log('📡 [PTT] PTT停止成功，频谱分析已恢复');
      } catch (error) {
        console.error('📡 [PTT] PTT停止失败:', error);
        this._isPTTActive = false;
        this.deps.spectrumScheduler.setPTTActive(false);
      }
    } else {
      this._isPTTActive = false;
      this.deps.spectrumScheduler.setPTTActive(false);
      console.log('📡 [PTT] 电台未连接，更新PTT状态为停止，频谱分析已恢复');
    }
  }

  private schedulePTTStop(delayMs: number): void {
    if (this.pttTimeoutId) {
      clearTimeout(this.pttTimeoutId);
    }

    console.log(`📡 [PTT] 安排 ${delayMs}ms 后停止PTT`);

    this.pttTimeoutId = setTimeout(async () => {
      this.pttTimeoutId = null;
      await this.stopPTT();
    }, delayMs);
  }

  private async handleEncodeComplete(result: {
    operatorId: string;
    audioData: Float32Array;
    sampleRate: number;
    duration: number;
    request?: { timeSinceSlotStartMs?: number; requestId?: string };
  }): Promise<void> {
    try {
      const request = result.request;
      const requestId = request?.requestId;
      const timeSinceSlotStartMs = request?.timeSinceSlotStartMs || 0;
      const mode = this.deps.getCurrentMode();

      console.log(`🎵 [TransmissionPipeline] 编码完成，提交到混音器`, {
        operatorId: result.operatorId,
        duration: result.duration,
        requestId: requestId || 'N/A'
      });

      this.currentSlotCompletedEncodes++;
      console.log(`📊 [编码跟踪] 时隙 ${this.currentSlotId}: 已完成 ${this.currentSlotCompletedEncodes}/${this.currentSlotExpectedEncodes}`);

      this.deps.transmissionTracker.updatePhase(result.operatorId, TransmissionPhase.MIXING, {});
      this.deps.transmissionTracker.updatePhase(result.operatorId, TransmissionPhase.READY, {
        audioData: result.audioData,
        sampleRate: result.sampleRate,
        duration: result.duration
      });

      const now = this.deps.clockSource.now();
      const currentSlotStartMs = Math.floor(now / mode.slotMs) * mode.slotMs;
      const currentTimeSinceSlotStartMs = now - currentSlotStartMs;
      const transmitStartFromSlotMs = mode.transmitTiming || 0;

      console.log(`⏰ [TransmissionPipeline] 编码完成时序: 操作员=${result.operatorId}, 音频时长=${result.duration.toFixed(2)}s`);

      this.deps.audioMixer.addOperatorAudio(
        result.operatorId,
        result.audioData,
        result.sampleRate,
        currentSlotStartMs,
        requestId
      );

      this.deps.transmissionTracker.recordAudioAddedToMixer(result.operatorId);

      const isMidSlotSwitch = timeSinceSlotStartMs > 0 &&
                              Math.abs(timeSinceSlotStartMs - transmitStartFromSlotMs) > 100;

      const isCurrentlyPlaying = this.deps.audioStreamManager.isPlaying();

      if (isCurrentlyPlaying) {
        console.log(`🔄 [TransmissionPipeline] 检测到正在播放，触发重新混音`);
        try {
          const elapsedTimeMs = await this.deps.audioStreamManager.stopCurrentPlayback();
          this.deps.audioMixer.markPlaybackStop();

          const remixedAudio = await this.deps.audioMixer.remixAfterUpdate(elapsedTimeMs);
          if (remixedAudio) {
            console.log(`🎵 [TransmissionPipeline] 重新混音完成: 操作员=[${remixedAudio.operatorIds.join(', ')}], 时长=${remixedAudio.duration.toFixed(2)}s`);
            this.deps.audioMixer.markPlaybackStart();
            await this.deps.audioStreamManager.playAudio(remixedAudio.audioData, remixedAudio.sampleRate);
            this.schedulePTTStop(remixedAudio.duration * 1000 + 200);
          }
        } catch (remixError) {
          console.error(`❌ [TransmissionPipeline] 重新混音失败:`, remixError);
        }
      } else if (isMidSlotSwitch && currentTimeSinceSlotStartMs >= transmitStartFromSlotMs) {
        console.log(`🔄 [TransmissionPipeline] 时隙中间切换，立即混音播放`);
        const elapsedFromTransmitStart = currentTimeSinceSlotStartMs - transmitStartFromSlotMs;
        const mixedAudio = await this.deps.audioMixer.mixAllOperatorAudios(elapsedFromTransmitStart);
        if (mixedAudio) {
          this.deps.audioMixer.emit('mixedAudioReady', mixedAudio);
        }
      } else {
        const targetPlaybackTime = currentSlotStartMs + transmitStartFromSlotMs;
        this.deps.audioMixer.scheduleMixing(targetPlaybackTime);
      }
    } catch (error) {
      console.error(`❌ [TransmissionPipeline] 编码结果处理失败:`, error);
      this.deps.engineEmitter.emit('transmissionComplete', {
        operatorId: result.operatorId,
        success: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async handleMixedAudioReady(mixedAudio: MixedAudio): Promise<void> {
    try {
      console.log(`🎵 [TransmissionPipeline] 混音完成，开始播放:`);
      console.log(`   操作员: [${mixedAudio.operatorIds.join(', ')}]`);
      console.log(`   混音时长: ${mixedAudio.duration.toFixed(2)}s`);
      console.log(`   采样率: ${mixedAudio.sampleRate}Hz`);

      for (const operatorId of mixedAudio.operatorIds) {
        this.deps.transmissionTracker.recordMixedAudioReady(operatorId);
      }

      console.log(`📡 [TransmissionPipeline] 并行启动PTT和音频播放`);

      for (const operatorId of mixedAudio.operatorIds) {
        this.deps.transmissionTracker.recordAudioPlaybackStart(operatorId);
      }

      const pttPromise = this.startPTT().then(() => {
        for (const operatorId of mixedAudio.operatorIds) {
          this.deps.transmissionTracker.recordPTTStart(operatorId);
        }
      });

      this.deps.audioMixer.markPlaybackStart();
      const audioPromise = this.deps.audioStreamManager.playAudio(mixedAudio.audioData, mixedAudio.sampleRate);
      const actualPlaybackTimeMs = mixedAudio.duration * 1000;
      const pttHoldTimeMs = 200;
      const totalPTTTimeMs = actualPlaybackTimeMs + pttHoldTimeMs;

      console.log(`📡 [TransmissionPipeline] PTT时序: 音频=${actualPlaybackTimeMs.toFixed(0)}ms, PTT延迟=${pttHoldTimeMs}ms, 总计=${totalPTTTimeMs.toFixed(0)}ms`);

      this.schedulePTTStop(totalPTTTimeMs);
      await Promise.all([pttPromise, audioPromise]);

      this.deps.audioMixer.markPlaybackStop();

      for (const operatorId of mixedAudio.operatorIds) {
        this.deps.engineEmitter.emit('transmissionComplete', {
          operatorId,
          success: true,
          duration: mixedAudio.duration,
          mixedWith: mixedAudio.operatorIds.filter(id => id !== operatorId)
        });
      }

      console.log(`✅ [TransmissionPipeline] 混音播放完成，通知 ${mixedAudio.operatorIds.length} 个操作员`);
    } catch (error) {
      console.error(`❌ [TransmissionPipeline] 混音播放失败:`, error);
      this.deps.audioMixer.markPlaybackStop();
      await this.stopPTT();
      for (const operatorId of mixedAudio.operatorIds) {
        this.deps.engineEmitter.emit('transmissionComplete', {
          operatorId,
          success: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }
}
