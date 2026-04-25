import type { EventEmitter } from 'eventemitter3';
import {
  AudioSidecarStatus,
  type AudioSidecarError,
  type AudioSidecarStatusPayload,
  type DigitalRadioEngineEvents,
} from '@tx5dr/contracts';
import { AudioStreamManager } from '../audio/AudioStreamManager.js';
import { AudioMonitorService } from '../audio/AudioMonitorService.js';
import type { AudioVolumeController } from './AudioVolumeController.js';
import { ConfigManager } from '../config/config-manager.js';
import { RadioError, RadioErrorCode } from '../utils/errors/RadioError.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('AudioSidecar');

const RETRY_DELAYS_MS = [2000, 4000, 8000, 16000, 30000];
const STEADY_RETRY_MS = 30000;
const LONG_RUNNING_THRESHOLD = 10;

export interface AudioSidecarDeps {
  engineEmitter: EventEmitter<DigitalRadioEngineEvents>;
  audioStreamManager: AudioStreamManager;
  audioVolumeController: AudioVolumeController;
}

/**
 * 本地音频旁路控制器。
 *
 * 负责：
 * - 在引擎 RUNNING 后 fire-and-forget 地启动本地音频流（input/output/monitor）。
 * - 启动失败按指数退避无限重试，不阻塞引擎主状态机。
 * - 运行时丢失（设备拔出/驱动错误）同样触发重试。
 * - 通过 `audioSidecarStatusChanged` 事件向前端广播当前状态。
 *
 * 不负责：
 * - 电台 CAT 连接与状态机。
 * - ICOM WLAN / OpenWebRX 音频适配器的启停（仍在 ResourceManager 中作为可选资源）。
 * - 发射链路的音频就绪前置检查（TransmissionPipeline 保持现状，未就绪时 playAudio 会自动空操作）。
 */
export class AudioSidecarController {
  private status: AudioSidecarStatus = AudioSidecarStatus.IDLE;
  private retryAttempt = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private lastError: AudioSidecarError | null = null;
  private deviceName: string | null = null;

  private audioMonitorService: AudioMonitorService | null = null;
  private pendingAttempt = 0;
  private audioStreamErrorHandler: ((error: Error) => void) | null = null;
  private txMonitorAudioHandler: ((data: { samples: Float32Array; sampleRate: number }) => void) | null = null;
  private isStopping = false;

  constructor(private deps: AudioSidecarDeps) {}

  // ─── Public API ───────────────────────────────────────────────────────

  /**
   * 启动 sidecar。引擎进入 RUNNING 后调用（fire-and-forget）。
   * 不抛出异常；任何失败都转为后台重试或 disabled 状态。
   */
  async start(): Promise<void> {
    if (this.status !== AudioSidecarStatus.IDLE) {
      logger.debug('sidecar already started, skipping', { status: this.status });
      return;
    }
    this.isStopping = false;
    this.retryAttempt = 0;
    this.lastError = null;
    this.setStatus(AudioSidecarStatus.CONNECTING);
    void this.attemptStart();
  }

  /**
   * 停止 sidecar。引擎进入 STOPPING 时调用（await）。
   * 取消所有 timer、关闭音频资源、停止 voice session，回到 IDLE。
   */
  async stop(reason = 'engine-stopped'): Promise<void> {
    if (this.status === AudioSidecarStatus.IDLE && !this.retryTimer && !this.audioMonitorService) {
      return;
    }
    this.isStopping = true;
    logger.info('stopping audio sidecar', { reason, previousStatus: this.status });
    this.clearRetryTimer();
    await this.teardownAudio({ destroyMonitor: true });
    this.retryAttempt = 0;
    this.lastError = null;
    this.deviceName = null;
    this.setStatus(AudioSidecarStatus.IDLE);
    this.isStopping = false;
  }

  /**
   * 立即触发一次重试（前端"立即重试"按钮）。
   */
  async retryNow(): Promise<void> {
    if (this.status === AudioSidecarStatus.CONNECTED) {
      logger.debug('retryNow ignored: already connected');
      return;
    }
    if (this.status === AudioSidecarStatus.CONNECTING) {
      logger.debug('retryNow ignored: connect attempt in progress');
      return;
    }
    logger.info('manual audio retry requested');
    this.clearRetryTimer();
    this.setStatus(AudioSidecarStatus.CONNECTING);
    void this.attemptStart();
  }

  isConnected(): boolean {
    return this.status === AudioSidecarStatus.CONNECTED;
  }

  getStatus(): AudioSidecarStatus {
    return this.status;
  }

  getAudioMonitorService(): AudioMonitorService | null {
    return this.audioMonitorService;
  }

  buildStatusPayload(): AudioSidecarStatusPayload {
    return {
      status: this.status,
      isConnected: this.status === AudioSidecarStatus.CONNECTED,
      retryAttempt: this.retryAttempt,
      nextRetryMs: this.status === AudioSidecarStatus.RETRYING ? this.peekNextDelay(this.retryAttempt) : null,
      longRunning: this.retryAttempt >= LONG_RUNNING_THRESHOLD,
      lastError: this.lastError,
      deviceName: this.deviceName,
    };
  }

  // ─── Internals ────────────────────────────────────────────────────────

  private async attemptStart(): Promise<void> {
    const attemptId = ++this.pendingAttempt;
    this.deviceName = ConfigManager.getInstance().getAudioConfig().inputDeviceName || null;

    try {
      await this.deps.audioStreamManager.startStream();
    } catch (error) {
      if (attemptId !== this.pendingAttempt || this.isStopping) return;
      this.handleFailure(error, 'startStream');
      return;
    }

    try {
      await this.deps.audioStreamManager.startOutput();
    } catch (error) {
      if (attemptId !== this.pendingAttempt || this.isStopping) return;
      await this.safeStopInput();
      this.handleFailure(error, 'startOutput');
      return;
    }

    if (attemptId !== this.pendingAttempt || this.isStopping) {
      await this.teardownAudio({ destroyMonitor: false });
      return;
    }

    // Reuse the existing AudioMonitorService across retries so downstream
    // consumers (LiveKit bridge, WS/PCM clients) keep their event
    // subscriptions alive. The monitor only references audioProvider (created
    // once in AudioStreamManager's constructor) and idles while audio is
    // paused, so it is safe to keep attached.
    if (!this.audioMonitorService) {
      this.audioMonitorService = new AudioMonitorService(this.deps.audioStreamManager.getAudioProvider());
    }
    this.attachTxMonitorInjection();
    this.attachAudioStreamErrorListener();
    this.deps.audioVolumeController.restoreGainForCurrentSlot();

    this.retryAttempt = 0;
    this.lastError = null;
    this.setStatus(AudioSidecarStatus.CONNECTED);
    logger.info('audio sidecar connected', { deviceName: this.deviceName });
  }

  private handleFailure(error: unknown, phase: 'startStream' | 'startOutput'): void {
    const summary = this.summarizeError(error);
    this.lastError = summary;

    if (this.isUnrecoverable(error)) {
      logger.error(`audio ${phase} failed with unrecoverable error`, { error: summary });
      this.setStatus(AudioSidecarStatus.DISABLED);
      return;
    }

    const attempt = this.retryAttempt + 1;
    this.retryAttempt = attempt;
    const delayMs = this.peekNextDelay(attempt - 1);
    logger.warn(`audio ${phase} failed, scheduling retry`, { attempt, delayMs, error: summary.message });

    this.setStatus(AudioSidecarStatus.RETRYING);
    this.scheduleRetry(delayMs);
  }

  private scheduleRetry(delayMs: number): void {
    this.clearRetryTimer();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.isStopping) return;
      this.setStatus(AudioSidecarStatus.CONNECTING);
      void this.attemptStart();
    }, delayMs);
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private peekNextDelay(attemptsSoFar: number): number {
    const idx = Math.min(attemptsSoFar, RETRY_DELAYS_MS.length - 1);
    if (attemptsSoFar >= RETRY_DELAYS_MS.length) {
      return STEADY_RETRY_MS;
    }
    return RETRY_DELAYS_MS[idx] ?? STEADY_RETRY_MS;
  }

  private async teardownAudio({ destroyMonitor }: { destroyMonitor: boolean }): Promise<void> {
    this.detachAudioStreamErrorListener();

    // Only destroy the monitor when the sidecar is being fully stopped
    // (engine shutdown / destroy). During a runtime loss + retry the monitor
    // stays alive so downstream consumers keep their subscriptions.
    if (destroyMonitor && this.audioMonitorService) {
      this.detachTxMonitorInjection();
      try {
        this.audioMonitorService.destroy();
      } catch (err) {
        logger.warn('failed to destroy AudioMonitorService', err);
      }
      this.audioMonitorService = null;
    }

    try {
      await this.deps.audioStreamManager.stopOutput();
    } catch (err) {
      logger.warn('failed to stop audio output', err);
    }
    try {
      await this.deps.audioStreamManager.stopStream();
    } catch (err) {
      logger.warn('failed to stop audio input', err);
    }
  }

  private async safeStopInput(): Promise<void> {
    try {
      await this.deps.audioStreamManager.stopStream();
    } catch (err) {
      logger.debug('safeStopInput: stopStream failed', err);
    }
  }

  private attachAudioStreamErrorListener(): void {
    if (this.audioStreamErrorHandler) return;
    const handler = (error: Error) => {
      if (this.status !== AudioSidecarStatus.CONNECTED) return;
      logger.warn('audio stream error while connected, triggering re-retry', { message: error.message });
      this.lastError = this.summarizeError(error);
      void this.handleRuntimeLoss();
    };
    this.audioStreamErrorHandler = handler;
    this.deps.audioStreamManager.on('error', handler);
  }

  private attachTxMonitorInjection(): void {
    if (this.txMonitorAudioHandler || !this.audioMonitorService) return;

    // Keep TX monitor injection as an explicit side path:
    // AudioStreamManager emits only chunks that were submitted to TX output,
    // and AudioMonitorService broadcasts them without writing RX ring buffers.
    const monitor = this.audioMonitorService;
    const handler = (data: { samples: Float32Array; sampleRate: number }) => {
      monitor.injectTxMonitorAudio(data.samples, data.sampleRate);
    };
    this.deps.audioStreamManager.on('txMonitorAudioData', handler);
    this.txMonitorAudioHandler = handler;
  }

  private detachTxMonitorInjection(): void {
    if (!this.txMonitorAudioHandler) return;
    this.deps.audioStreamManager.off('txMonitorAudioData', this.txMonitorAudioHandler);
    this.txMonitorAudioHandler = null;
  }

  private detachAudioStreamErrorListener(): void {
    if (!this.audioStreamErrorHandler) return;
    this.deps.audioStreamManager.off('error', this.audioStreamErrorHandler);
    this.audioStreamErrorHandler = null;
  }

  private async handleRuntimeLoss(): Promise<void> {
    if (this.isStopping) return;
    // Keep the AudioMonitorService alive so LiveKit / WS-PCM consumers don't
    // lose their event subscriptions while we reopen the local audio stream.
    await this.teardownAudio({ destroyMonitor: false });
    if (this.isStopping) return;
    this.retryAttempt = 1;
    this.setStatus(AudioSidecarStatus.RETRYING);
    this.scheduleRetry(this.peekNextDelay(0));
  }

  private isUnrecoverable(error: unknown): boolean {
    if (error instanceof RadioError) {
      if (error.code === RadioErrorCode.UNSUPPORTED_MODE) return true;
      if (error.code === RadioErrorCode.INVALID_CONFIG) return true;
      if (error.code === RadioErrorCode.MISSING_CONFIG) return true;
    }
    return false;
  }

  private summarizeError(error: unknown): AudioSidecarError {
    if (error instanceof RadioError) {
      return {
        code: error.code,
        message: error.message,
        userMessage: error.userMessage,
        userMessageKey: error.userMessageKey,
        userMessageParams: error.userMessageParams,
      };
    }
    if (error instanceof Error) {
      return { message: error.message };
    }
    return { message: String(error) };
  }

  private setStatus(next: AudioSidecarStatus): void {
    if (this.status === next && next !== AudioSidecarStatus.RETRYING) {
      return;
    }
    this.status = next;
    const payload = this.buildStatusPayload();
    this.deps.engineEmitter.emit('audioSidecarStatusChanged', payload);
  }
}
