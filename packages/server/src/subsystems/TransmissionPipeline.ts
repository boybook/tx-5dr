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
  getCompensationMs: () => number;
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
  private _isRemixing = false;

  // PTT 轮询（替代 setTimeout，在高负载 CPU 上更精确）
  private pttPollInterval: NodeJS.Timeout | null = null;
  private pttAudioStoppedAt: number | null = null;
  private static readonly PTT_POLL_INTERVAL_MS = 50;
  private static readonly PTT_HOLD_AFTER_AUDIO_MS = 500;

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
   * 清理监听器和 PTT 轮询（doStop 时调用）
   */
  teardown(): void {
    this.stopPTTPoll();

    this.lm.disposeAll();
    logger.info('event listeners cleaned up');
  }

  /**
   * 时隙开始时调用：停止残留音频播放 + 清空混音缓存
   */
  async onSlotStart(): Promise<void> {
    // 停止上一时隙的残留音频播放，防止 isPlaying 状态泄漏到新时隙
    if (this.deps.audioStreamManager.isPlaying()) {
      await this.deps.audioStreamManager.stopCurrentPlayback();
      logger.debug('stopped residual audio playback from previous slot');
    }
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
   * transmitStart 事件中调用
   */
  onTransmitStart(_slotInfo: { id: string }): void {
    if (this.currentSlotExpectedEncodes > 0 &&
        this.currentSlotCompletedEncodes < this.currentSlotExpectedEncodes) {
      const missingCount = this.currentSlotExpectedEncodes - this.currentSlotCompletedEncodes;
      logger.warn(`encode timeout: expected ${this.currentSlotExpectedEncodes}, completed ${this.currentSlotCompletedEncodes}, missing ${missingCount}`);
    } else if (this.currentSlotExpectedEncodes > 0) {
      logger.debug(`all encode tasks completed on time (${this.currentSlotCompletedEncodes}/${this.currentSlotExpectedEncodes})`);
    }
  }

  /**
   * 强制停止PTT
   */
  async forceStopPTT(): Promise<void> {
    this.stopPTTPoll();
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

  /**
   * 从当前发射中移除单个操作员的音频并重混音
   * 如果移除后还有其他操作员，继续播放重混音后的音频
   * 如果移除后没有操作员了，停止播放和PTT
   */
  async removeOperatorFromTransmission(operatorId: string): Promise<void> {
    const { audioMixer, audioStreamManager } = this.deps;

    const removed = audioMixer.clearOperatorAudio(operatorId);
    if (!removed) {
      logger.debug(`operator ${operatorId} not in mixer cache, skipping`);
      return;
    }

    const remainingCount = audioMixer.getStatus().cacheCount;

    if (remainingCount === 0) {
      logger.info(`last operator ${operatorId} removed, stopping transmission`);
      const stoppedBytes = await audioStreamManager.stopCurrentPlayback();
      await this.forceStopPTT();
      audioMixer.clear();
      logger.info('transmission fully stopped after last operator removed', { stoppedBytes });
      return;
    }

    if (audioStreamManager.isPlaying()) {
      if (this._isRemixing) {
        logger.debug(`operator ${operatorId} removed from cache, remix already in progress`);
        return;
      }

      logger.info(`operator ${operatorId} removed, remixing with ${remainingCount} remaining`);
      this._isRemixing = true;
      try {
        const elapsedTimeMs = await audioStreamManager.stopCurrentPlayback();
        audioMixer.markPlaybackStop();

        const remixedAudio = await audioMixer.remixAfterUpdate(elapsedTimeMs);
        if (remixedAudio) {
          this.deps.engineEmitter.emit('pttStatusChanged', {
            isTransmitting: true,
            operatorIds: remixedAudio.operatorIds,
          });
          this.deps.operatorManager.updateActiveTransmissionOperators(remixedAudio.operatorIds);
          audioMixer.markPlaybackStart();
          await audioStreamManager.playAudio(remixedAudio.audioData, remixedAudio.sampleRate);
          this.startPTTPoll();
        } else {
          logger.info('remix returned null after operator removal, stopping PTT');
          await this.forceStopPTT();
        }
      } catch (error) {
        logger.error(`remix after operator removal failed: ${error}`);
      } finally {
        this._isRemixing = false;
      }
    } else {
      logger.debug(`operator ${operatorId} removed from cache, not currently playing`);
    }
  }

  // ─── 内部方法 ────────────────────────────────────

  private async startPTT(operatorIds: string[]): Promise<void> {
    if (this._isPTTActive) {
      logger.debug('PTT already active, skipping');
      return;
    }

    if (this.deps.radioManager.isConnected()) {
      try {
        const pttStartTime = Date.now();
        await this.deps.radioManager.setPTT(true);
        const durationMs = Date.now() - pttStartTime;

        this._isPTTActive = true;

        this.deps.spectrumScheduler.setPTTActive(true);
        this.deps.radioManager.setPTTActive(true);

        this.deps.engineEmitter.emit('pttStatusChanged', {
          isTransmitting: true,
          operatorIds
        });

        this.deps.operatorManager.updateActiveTransmissionOperators(operatorIds);

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

    if (this.deps.radioManager.isConnected()) {
      try {
        await this.deps.radioManager.setPTT(false);
        this._isPTTActive = false;

        this.deps.spectrumScheduler.setPTTActive(false);
        this.deps.radioManager.setPTTActive(false);

        this.deps.engineEmitter.emit('pttStatusChanged', {
          isTransmitting: false,
          operatorIds: []
        });

        this.deps.operatorManager.updateActiveTransmissionOperators([]);

        logger.debug('PTT stopped');
      } catch (error) {
        logger.error(`PTT stop failed: ${error}`);
        this._isPTTActive = false;
        this.deps.spectrumScheduler.setPTTActive(false);
        this.deps.radioManager.setPTTActive(false);
        this.deps.operatorManager.updateActiveTransmissionOperators([]);
      }
    } else {
      this._isPTTActive = false;
      this.deps.spectrumScheduler.setPTTActive(false);
      this.deps.radioManager.setPTTActive(false);
      this.deps.operatorManager.updateActiveTransmissionOperators([]);
      logger.debug('radio not connected, PTT state set to stopped');
    }
  }

  /**
   * 启动 PTT 状态轮询（替代 setTimeout 预测计时）。
   * 轮询检测音频是否仍在播放/remix，停止后等待 hold 时间再关闭 PTT。
   */
  private startPTTPoll(): void {
    if (this.pttPollInterval) return;
    this.pttAudioStoppedAt = null;
    this.pttPollInterval = setInterval(() => this.pollPTTState(), TransmissionPipeline.PTT_POLL_INTERVAL_MS);
  }

  private stopPTTPoll(): void {
    if (this.pttPollInterval) {
      clearInterval(this.pttPollInterval);
      this.pttPollInterval = null;
    }
    this.pttAudioStoppedAt = null;
  }

  private pollPTTState(): void {
    if (!this._isPTTActive) {
      this.stopPTTPoll();
      return;
    }

    const isPlaying = this.deps.audioStreamManager.isPlaying();
    const isRemixing = this._isRemixing;

    if (isPlaying || isRemixing) {
      this.pttAudioStoppedAt = null;
    } else if (!this.pttAudioStoppedAt) {
      this.pttAudioStoppedAt = Date.now();
      logger.debug('PTT poll: audio stopped, starting hold countdown');
    } else {
      const holdElapsed = Date.now() - this.pttAudioStoppedAt;
      if (holdElapsed >= TransmissionPipeline.PTT_HOLD_AFTER_AUDIO_MS) {
        logger.debug(`PTT poll: hold expired (${holdElapsed}ms), stopping PTT`);
        this.stopPTT();
        this.stopPTTPoll();
      }
    }
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

      // 检查是否为该操作员的最新编码请求（丢弃过期编码，防止双重编码竞态）
      const latestRequestId = this.deps.operatorManager.getLatestEncodeRequestId(result.operatorId);
      if (requestId && latestRequestId && requestId !== latestRequestId) {
        logger.debug(`Skipping stale encode result: operatorId=${result.operatorId}, requestId=${requestId}, latest=${latestRequestId}`);
        return;
      }

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
      const compensationMs = this.deps.getCompensationMs();
      const compensatedTransmitStart = Math.max(0, transmitStartFromSlotMs - compensationMs);

      if (compensationMs !== 0) {
        logger.debug(`transmit compensation applied: ${compensationMs}ms, target=${compensatedTransmitStart}ms (original=${transmitStartFromSlotMs}ms)`);
      }

      this.deps.audioMixer.addOperatorAudio(
        result.operatorId,
        result.audioData,
        result.sampleRate,
        currentSlotStartMs,
        requestId
      );

      this.deps.transmissionTracker.recordAudioAddedToMixer(result.operatorId);

      const isMidSlotSwitch = timeSinceSlotStartMs > 0 &&
                              Math.abs(timeSinceSlotStartMs - compensatedTransmitStart) > 100;

      const isCurrentlyPlaying = this.deps.audioStreamManager.isPlaying();

      if (isCurrentlyPlaying) {
        logger.debug('playback in progress, triggering remix');
        this._isRemixing = true;
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
            this.deps.operatorManager.updateActiveTransmissionOperators(remixedAudio.operatorIds);
            this.deps.audioMixer.markPlaybackStart();
            await this.deps.audioStreamManager.playAudio(remixedAudio.audioData, remixedAudio.sampleRate);
            this.startPTTPoll();
          }
        } catch (remixError) {
          logger.error(`remix failed: ${remixError}`);
        } finally {
          this._isRemixing = false;
        }
      } else if (isMidSlotSwitch && currentTimeSinceSlotStartMs >= compensatedTransmitStart) {
        logger.debug('mid-slot switch, mixing immediately');
        const elapsedFromTransmitStart = currentTimeSinceSlotStartMs - compensatedTransmitStart;
        const mixedAudio = await this.deps.audioMixer.mixAllOperatorAudios(elapsedFromTransmitStart);
        if (mixedAudio) {
          this.deps.audioMixer.emit('mixedAudioReady', mixedAudio);
        }
      } else {
        const targetPlaybackTime = currentSlotStartMs + compensatedTransmitStart;
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

      logger.debug('PTT timing', {
        audioMs: Math.round(mixedAudio.duration * 1000),
        pollIntervalMs: TransmissionPipeline.PTT_POLL_INTERVAL_MS,
        holdMs: TransmissionPipeline.PTT_HOLD_AFTER_AUDIO_MS
      });

      this.startPTTPoll();
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
      const isInterrupted = error instanceof Error && error.message === 'playback interrupted';
      if (isInterrupted) {
        // 播放被 stopCurrentPlayback 正常中断（中途内容切换），不关闭 PTT
        // 停止旧轮询，后续 remix 路径会启动新轮询
        logger.debug('audio playback interrupted by content switch (expected)');
        this.stopPTTPoll();
        this.deps.audioMixer.markPlaybackStop();
      } else {
        // 真正的播放错误，需要清理 PTT
        logger.error(`mixed audio playback failed: ${error}`);
        this.stopPTTPoll();
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
}
