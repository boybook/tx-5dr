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
import { createLogger } from '../utils/logger.js';

const logger = createLogger('TransmissionPipeline');

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
      logger.error(`encode failed: operatorId=${request.operatorId}: ${error.message}`);
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

    logger.info(`event listeners registered (${this.lm.count})`);
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
    logger.info('event listeners cleaned up');
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
      logger.debug(`slot ${slotInfo.id}: expected ${this.currentSlotExpectedEncodes} encode tasks`);
    }
  }

  /**
   * transmitStart 事件中调用（检查编码超时）
   */
  onTransmitStart(_slotInfo: { id: string }): void {
    if (this.currentSlotExpectedEncodes > 0 &&
        this.currentSlotCompletedEncodes < this.currentSlotExpectedEncodes) {
      const missingCount = this.currentSlotExpectedEncodes - this.currentSlotCompletedEncodes;
      logger.warn(`encode timeout: expected ${this.currentSlotExpectedEncodes}, completed ${this.currentSlotCompletedEncodes}, missing ${missingCount}`);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.deps.engineEmitter.emit('timingWarning' as any, {
        title: '⚠️ 编码超时警告',
        text: `发射时刻已到达，但仍有 ${missingCount} 个编码任务未完成。这可能导致发射延迟或失败。建议检查发射补偿设置或减少同时发射的操作员数量。`
      });
    } else if (this.currentSlotExpectedEncodes > 0) {
      logger.debug(`all encode tasks completed on time (${this.currentSlotCompletedEncodes}/${this.currentSlotExpectedEncodes})`);
    }
  }

  /**
   * 强制停止PTT
   */
  async forceStopPTT(): Promise<void> {
    if (this._isPTTActive) {
      await this.stopPTT();
    }
  }

  /**
   * 强制停止当前发射（公开方法）
   */
  async forceStopTransmission(): Promise<void> {
    try {
      const stoppedBytes = await this.deps.audioStreamManager.stopCurrentPlayback();
      await this.forceStopPTT();
      this.deps.audioMixer.clear();
      logger.info('force stop transmission', { stoppedBytes });
    } catch (error) {
      logger.error(`force stop transmission failed: ${error}`);
      throw error;
    }
  }

  // ─── 内部方法 ────────────────────────────────────

  private async startPTT(operatorIds: string[]): Promise<void> {
    if (this._isPTTActive) {
      logger.debug('PTT already active, skipping');
      return;
    }

    if (this.pttTimeoutId) {
      clearTimeout(this.pttTimeoutId);
      this.pttTimeoutId = null;
    }

    if (this.deps.radioManager.isConnected()) {
      try {
        const pttStartTime = Date.now();
        await this.deps.radioManager.setPTT(true);
        const durationMs = Date.now() - pttStartTime;

        this._isPTTActive = true;

        this.deps.spectrumScheduler.setPTTActive(true);

        this.deps.engineEmitter.emit('pttStatusChanged', {
          isTransmitting: true,
          operatorIds
        });

        logger.debug('PTT started', { durationMs });
      } catch (error) {
        logger.error(`PTT start failed: ${error}`);
        throw error;
      }
    } else {
      logger.debug('radio not connected, skipping PTT start');
    }
  }

  private async stopPTT(): Promise<void> {
    if (!this._isPTTActive) {
      logger.debug('PTT already stopped, skipping');
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

        logger.debug('PTT stopped');
      } catch (error) {
        logger.error(`PTT stop failed: ${error}`);
        this._isPTTActive = false;
        this.deps.spectrumScheduler.setPTTActive(false);
      }
    } else {
      this._isPTTActive = false;
      this.deps.spectrumScheduler.setPTTActive(false);
      logger.debug('radio not connected, PTT state set to stopped');
    }
  }

  private schedulePTTStop(delayMs: number): void {
    if (this.pttTimeoutId) {
      clearTimeout(this.pttTimeoutId);
    }

    logger.debug(`PTT stop scheduled in ${delayMs}ms`);

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

      logger.debug('encode complete', {
        operatorId: result.operatorId,
        duration: result.duration,
        requestId: requestId || 'N/A'
      });

      this.currentSlotCompletedEncodes++;
      logger.debug(`slot ${this.currentSlotId}: completed ${this.currentSlotCompletedEncodes}/${this.currentSlotExpectedEncodes}`);

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
        logger.debug('playback in progress, triggering remix');
        try {
          const elapsedTimeMs = await this.deps.audioStreamManager.stopCurrentPlayback();
          this.deps.audioMixer.markPlaybackStop();

          const remixedAudio = await this.deps.audioMixer.remixAfterUpdate(elapsedTimeMs);
          if (remixedAudio) {
            logger.debug('remix complete', {
              operators: remixedAudio.operatorIds,
              duration: remixedAudio.duration
            });
            // 重混音后操作者列表可能变化，更新前端
            this.deps.engineEmitter.emit('pttStatusChanged', {
              isTransmitting: true,
              operatorIds: remixedAudio.operatorIds
            });
            this.deps.audioMixer.markPlaybackStart();
            await this.deps.audioStreamManager.playAudio(remixedAudio.audioData, remixedAudio.sampleRate);
            this.schedulePTTStop(remixedAudio.duration * 1000 + 200);
          }
        } catch (remixError) {
          logger.error(`remix failed: ${remixError}`);
        }
      } else if (isMidSlotSwitch && currentTimeSinceSlotStartMs >= transmitStartFromSlotMs) {
        logger.debug('mid-slot switch, mixing immediately');
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
      logger.error(`encode result handling failed: ${error}`);
      this.deps.engineEmitter.emit('transmissionComplete', {
        operatorId: result.operatorId,
        success: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async handleMixedAudioReady(mixedAudio: MixedAudio): Promise<void> {
    try {
      logger.debug('mixed audio ready', {
        operators: mixedAudio.operatorIds,
        duration: mixedAudio.duration,
        sampleRate: mixedAudio.sampleRate
      });

      for (const operatorId of mixedAudio.operatorIds) {
        this.deps.transmissionTracker.recordMixedAudioReady(operatorId);
      }

      logger.debug('starting PTT and audio playback in parallel');

      for (const operatorId of mixedAudio.operatorIds) {
        this.deps.transmissionTracker.recordAudioPlaybackStart(operatorId);
      }

      const pttPromise = this.startPTT(mixedAudio.operatorIds).then(() => {
        for (const operatorId of mixedAudio.operatorIds) {
          this.deps.transmissionTracker.recordPTTStart(operatorId);
        }
      });

      this.deps.audioMixer.markPlaybackStart();
      const audioPromise = this.deps.audioStreamManager.playAudio(mixedAudio.audioData, mixedAudio.sampleRate);
      const actualPlaybackTimeMs = mixedAudio.duration * 1000;
      const pttHoldTimeMs = 200;
      const totalPTTTimeMs = actualPlaybackTimeMs + pttHoldTimeMs;

      logger.debug('PTT timing', {
        audioMs: Math.round(actualPlaybackTimeMs),
        holdMs: pttHoldTimeMs,
        totalMs: Math.round(totalPTTTimeMs)
      });

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
    } catch (error) {
      logger.error(`mixed audio playback failed: ${error}`);
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
