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
  onBeforeStartPTT?: () => Promise<void>;
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
  private txSequence = 0;

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
    if (this.isDigitalPlaybackInProgress()) {
      await this.deps.audioStreamManager.stopCurrentPlayback();
      logger.debug('stopped residual audio playback from previous slot');
    } else if (this.deps.audioStreamManager.isPlaying()) {
      logger.debug('preserved non-digital playback across slot start', {
        kind: this.deps.audioStreamManager.getCurrentPlaybackKind(),
      });
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
          const txId = this.nextTxId('digital-remix-remove');
          this.deps.engineEmitter.emit('pttStatusChanged', {
            isTransmitting: true,
            operatorIds: remixedAudio.operatorIds,
          });
          this.deps.operatorManager.updateActiveTransmissionOperators(remixedAudio.operatorIds);
          audioMixer.markPlaybackStart();
          await audioStreamManager.playAudio(remixedAudio.audioData, remixedAudio.sampleRate, {
            playbackKind: 'digital',
            diagnosticContext: { txId, operatorIds: remixedAudio.operatorIds, reason: 'operator-removed-remix' },
          });
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

  private nextTxId(reason: string): string {
    this.txSequence += 1;
    return `${reason}-${Date.now()}-${this.txSequence}`;
  }

  private async startPTT(operatorIds: string[], txId?: string): Promise<void> {
    if (this._isPTTActive) {
      logger.info('PTT already active, skipping start request', { txId, operatorIds });
      return;
    }

    if (this.deps.radioManager.isConnected()) {
      try {
        const pttStartTime = Date.now();
        logger.info('PTT start requested', {
          txId,
          operatorIds,
          requestedAt: new Date(pttStartTime).toISOString(),
        });
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

        logger.info('PTT started', { txId, operatorIds, durationMs });
      } catch (error) {
        logger.error(`PTT start failed: ${error}`, { txId, operatorIds });
        throw error;
      }
    } else {
      logger.warn('radio not connected, skipping PTT start', { txId, operatorIds });
    }
  }

  private async stopPTT(): Promise<void> {
    if (!this._isPTTActive) {
      logger.debug('PTT already stopped, skipping');
      // 兜底清除可能残留的虚拟频率平移（如 startPTT 失败导致 PTT 未真正激活的场景）
      await this.deps.radioManager.clearTxDialOffset();
      return;
    }

    try {
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
    } finally {
      // 虚拟频率：PTT 关闭后恢复接收 dial（在 PTT 真正关闭之后执行，避免发射期间提前回频）
      await this.deps.radioManager.clearTxDialOffset();
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

  private shouldReleasePTTImmediatelyAfterAudio(): boolean {
    return this.deps.radioManager.getConfig().type === 'icom-wlan';
  }

  private async handleEncodeComplete(result: {
    operatorId: string;
    audioData: Float32Array;
    sampleRate: number;
    duration: number;
    request?: { timeSinceSlotStartMs?: number; requestId?: string; txDialShiftHz?: number };
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
        requestId,
        result.request?.txDialShiftHz ?? 0
      );

      this.deps.transmissionTracker.recordAudioAddedToMixer(result.operatorId);

      const isMidSlotSwitch = timeSinceSlotStartMs > 0 &&
                              Math.abs(timeSinceSlotStartMs - compensatedTransmitStart) > 100;

      const isCurrentlyPlaying = this.isDigitalPlaybackInProgress();

      if (isCurrentlyPlaying) {
        logger.debug('playback in progress, triggering remix');
        this._isRemixing = true;
        try {
          const elapsedTimeMs = await this.deps.audioStreamManager.stopCurrentPlayback();
          this.deps.audioMixer.markPlaybackStop();

          const remixedAudio = await this.deps.audioMixer.remixAfterUpdate(elapsedTimeMs);
          if (remixedAudio) {
            const txId = this.nextTxId('digital-remix-update');
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
            await this.deps.audioStreamManager.playAudio(remixedAudio.audioData, remixedAudio.sampleRate, {
              playbackKind: 'digital',
              diagnosticContext: { txId, operatorIds: remixedAudio.operatorIds, reason: 'encode-update-remix' },
            });
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
      const txId = this.nextTxId('digital-tx');
      logger.debug('mixed audio ready', {
        txId,
        operators: mixedAudio.operatorIds,
        duration: mixedAudio.duration,
        sampleRate: mixedAudio.sampleRate
      });

      for (const operatorId of mixedAudio.operatorIds) {
        this.deps.transmissionTracker.recordMixedAudioReady(operatorId);
      }

      await this.deps.onBeforeStartPTT?.();

      // 虚拟频率：在 PTT 之前临时把电台 dial 反向平移到本次发射的 shift。
      // shift 与音频同源（随 mixedAudio 负载流转），保证施加到 dial 的平移量恒等于编码所用 shift。
      // 音频已按 (origFreq - shift) 编码，dial +shift 后打到空中的绝对 RF 不变。
      // clearTxDialOffset() 在 stopPTT 的 finally 中兜底恢复。
      const txDialShiftHz = mixedAudio.txDialShiftHz ?? 0;
      if (txDialShiftHz !== 0) {
        await this.deps.radioManager.setTxDialOffset(txDialShiftHz);
      }

      const startSequenceAt = Date.now();
      logger.info('starting PTT and audio playback in parallel', {
        txId,
        operatorIds: mixedAudio.operatorIds,
        mixedSamples: mixedAudio.audioData.length,
        sampleRate: mixedAudio.sampleRate,
        durationMs: Math.round(mixedAudio.duration * 1000),
        startSequenceAt: new Date(startSequenceAt).toISOString(),
      });

      for (const operatorId of mixedAudio.operatorIds) {
        this.deps.transmissionTracker.recordAudioPlaybackStart(operatorId);
      }

      const pttPromise = this.startPTT(mixedAudio.operatorIds, txId).then(() => {
        for (const operatorId of mixedAudio.operatorIds) {
          this.deps.transmissionTracker.recordPTTStart(operatorId);
        }
      });

      this.deps.audioMixer.markPlaybackStart();
      logger.info('audio playback request issued', {
        txId,
        operatorIds: mixedAudio.operatorIds,
        msAfterStartSequence: Date.now() - startSequenceAt,
      });
      const audioPromise = this.deps.audioStreamManager.playAudio(mixedAudio.audioData, mixedAudio.sampleRate, {
        playbackKind: 'digital',
        diagnosticContext: { txId, operatorIds: mixedAudio.operatorIds },
      });

      logger.debug('PTT timing', {
        txId,
        audioMs: Math.round(mixedAudio.duration * 1000),
        pollIntervalMs: TransmissionPipeline.PTT_POLL_INTERVAL_MS,
        holdMs: TransmissionPipeline.PTT_HOLD_AFTER_AUDIO_MS
      });

      this.startPTTPoll();
      await Promise.all([pttPromise, audioPromise]);

      this.deps.audioMixer.markPlaybackStop();
      logger.info('audio playback and PTT start promises completed', {
        txId,
        operatorIds: mixedAudio.operatorIds,
        elapsedMs: Date.now() - startSequenceAt,
        pttActive: this._isPTTActive,
      });

      if (this.shouldReleasePTTImmediatelyAfterAudio()) {
        logger.debug('ICOM WLAN audio complete, stopping PTT without post-audio hold');
        this.stopPTTPoll();
        await this.stopPTT();
      }

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

  private isDigitalPlaybackInProgress(): boolean {
    if (!this.deps.audioStreamManager.isPlaying()) {
      return false;
    }

    const kind = this.deps.audioStreamManager.getCurrentPlaybackKind();
    return kind === null || kind === 'digital';
  }
}
