import type { EventEmitter } from 'eventemitter3';
import {
  AudioSidecarStatus,
  type AudioSidecarError,
  type AudioSidecarStatusPayload,
  type DigitalRadioEngineEvents,
} from '@tx5dr/contracts';
import { AudioDeviceManager } from '../audio/audio-device-manager.js';
import { AudioStreamManager, getAudioRuntimeIssue, type RtAudioRuntimeIssue } from '../audio/AudioStreamManager.js';
import type { AudioVolumeController } from './AudioVolumeController.js';
import { ConfigManager } from '../config/config-manager.js';
import { ProfileManager } from '../config/ProfileManager.js';
import { RadioError, RadioErrorCode } from '../utils/errors/RadioError.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('AudioSidecar');

const RETRY_DELAYS_MS = [2000, 4000, 8000, 16000, 30000];
const STEADY_RETRY_MS = 30000;
const LONG_RUNNING_THRESHOLD = 10;
const EARLY_RUNTIME_LOSS_MS = 5000;
const STABLE_CONNECTION_MS = 10000;
const YAESU_FALLBACK_SAMPLE_RATE = 44100;
const DEFAULT_SAMPLE_RATE = 48000;

type AudioSidecarPhase = 'startStream' | 'startOutput' | 'runtime';
type AudioSidecarClassification =
  | 'startup-failure'
  | 'runtime-loss'
  | 'sample-rate-fallback'
  | 'sample-rate-fallback-failed'
  | 'device-unavailable'
  | 'disabled';

interface RuntimeFallbackState {
  active: boolean;
  fromSampleRate: number | null;
  toSampleRate: number | null;
  persisted?: boolean;
  reason?: string;
  profileId?: string | null;
  deviceName?: string | null;
}

export interface AudioSidecarDeps {
  engineEmitter: EventEmitter<DigitalRadioEngineEvents>;
  audioStreamManager: AudioStreamManager;
  audioVolumeController: AudioVolumeController;
}

/**
 * 本地音频旁路控制器。
 *
 * 负责：
 * - 在引擎 RUNNING 后 fire-and-forget 地启动本地音频流（input/output）。
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
  private phase: AudioSidecarPhase | undefined;
  private classification: AudioSidecarClassification | undefined;
  private affectedDeviceName: string | null = null;
  private sampleRate: number | null = null;
  private retryReason: string | undefined;
  private runtimeFallback: RuntimeFallbackState | null = null;
  private attemptedFallbackKeys = new Set<string>();
  private connectedAt: number | null = null;
  private stableConnectionTimer: NodeJS.Timeout | null = null;
  private nextRetryDelayMs: number | null = null;

  private pendingAttempt = 0;
  private audioStreamErrorHandler: ((error: Error) => void) | null = null;
  private isStopping = false;
  private isHandlingRuntimeLoss = false;

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
    this.phase = undefined;
    this.classification = undefined;
    this.affectedDeviceName = null;
    this.sampleRate = null;
    this.retryReason = undefined;
    this.runtimeFallback = null;
    this.connectedAt = null;
    this.clearStableConnectionTimer();
    this.setStatus(AudioSidecarStatus.CONNECTING);
    void this.attemptStart();
  }

  /**
   * 停止 sidecar。引擎进入 STOPPING 时调用（await）。
   * 取消所有 timer、关闭音频资源、停止 voice session，回到 IDLE。
   */
  async stop(reason = 'engine-stopped'): Promise<void> {
    if (this.status === AudioSidecarStatus.IDLE && !this.retryTimer) {
      return;
    }
    this.isStopping = true;
    logger.info('stopping audio sidecar', { reason, previousStatus: this.status });
    this.clearRetryTimer();
    await this.teardownAudio();
    this.retryAttempt = 0;
    this.lastError = null;
    this.deviceName = null;
    this.phase = undefined;
    this.classification = undefined;
    this.affectedDeviceName = null;
    this.sampleRate = null;
    this.retryReason = undefined;
    this.runtimeFallback = null;
    this.connectedAt = null;
    this.nextRetryDelayMs = null;
    this.clearStableConnectionTimer();
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
    this.nextRetryDelayMs = null;
    this.setStatus(AudioSidecarStatus.CONNECTING);
    void this.attemptStart();
  }

  isConnected(): boolean {
    return this.status === AudioSidecarStatus.CONNECTED;
  }

  getStatus(): AudioSidecarStatus {
    return this.status;
  }

  buildStatusPayload(): AudioSidecarStatusPayload {
    return {
      status: this.status,
      isConnected: this.status === AudioSidecarStatus.CONNECTED,
      retryAttempt: this.retryAttempt,
      nextRetryMs: this.status === AudioSidecarStatus.RETRYING ? this.nextRetryDelayMs ?? this.peekNextDelay(this.retryAttempt) : null,
      longRunning: this.retryAttempt >= LONG_RUNNING_THRESHOLD,
      lastError: this.lastError,
      deviceName: this.deviceName,
      phase: this.phase,
      classification: this.classification,
      affectedDeviceName: this.affectedDeviceName,
      sampleRate: this.sampleRate,
      fallback: this.runtimeFallback
        ? {
            active: this.runtimeFallback.active,
            fromSampleRate: this.runtimeFallback.fromSampleRate,
            toSampleRate: this.runtimeFallback.toSampleRate,
            persisted: this.runtimeFallback.persisted,
            reason: this.runtimeFallback.reason,
          }
        : undefined,
      retryReason: this.retryReason,
    };
  }

  // ─── Internals ────────────────────────────────────────────────────────

  private async attemptStart(): Promise<void> {
    const attemptId = ++this.pendingAttempt;
    const audioConfig = ConfigManager.getInstance().getAudioConfig();
    this.deviceName = audioConfig.inputDeviceName || audioConfig.outputDeviceName || null;
    this.phase = 'startStream';

    try {
      await this.deps.audioStreamManager.startStream();
    } catch (error) {
      if (attemptId !== this.pendingAttempt || this.isStopping) return;
      await this.handleFailure(error, 'startStream');
      return;
    }

    this.phase = 'startOutput';
    try {
      await this.deps.audioStreamManager.startOutput();
    } catch (error) {
      if (attemptId !== this.pendingAttempt || this.isStopping) return;
      await this.safeStopInput();
      await this.handleFailure(error, 'startOutput');
      return;
    }

    if (attemptId !== this.pendingAttempt || this.isStopping) {
      await this.teardownAudio();
      return;
    }

    this.attachAudioStreamErrorListener();
    this.deps.audioVolumeController.restoreGainForCurrentSlot();

    this.lastError = null;
    this.connectedAt = Date.now();
    this.retryReason = undefined;
    this.phase = undefined;
    this.setStatus(AudioSidecarStatus.CONNECTED);
    this.scheduleStableConnectionCheckpoint();
    logger.info('audio sidecar connected', { deviceName: this.deviceName });
  }

  private async handleFailure(error: unknown, phase: 'startStream' | 'startOutput' | 'runtime'): Promise<void> {
    const summary = this.summarizeError(error);
    this.lastError = summary;
    const runtimeIssue = getAudioRuntimeIssue(error);
    this.phase = phase === 'runtime' ? 'runtime' : phase;
    this.affectedDeviceName = this.resolveAffectedDeviceName(phase, runtimeIssue);
    this.sampleRate = runtimeIssue?.sampleRate ?? this.resolveConfiguredSampleRate(phase);
    this.retryReason = summary.userMessage ?? summary.message;

    if (this.isUnrecoverable(error)) {
      this.classification = 'disabled';
      logger.error(`audio ${phase} failed with unrecoverable error`, { error: summary });
      this.setStatus(AudioSidecarStatus.DISABLED);
      return;
    }

    await this.maybeApplySampleRateFallback(error, phase, runtimeIssue);
    const attempt = this.recordRecoverableFailure();
    const delayMs = this.withJitter(this.peekNextDelay(attempt - 1));
    this.nextRetryDelayMs = delayMs;
    logger.warn(`audio ${phase} failed, scheduling retry`, {
      attempt,
      delayMs,
      error: summary.message,
      classification: this.classification,
      affectedDeviceName: this.affectedDeviceName,
      sampleRate: this.sampleRate,
      fallback: this.runtimeFallback,
    });

    this.setStatus(AudioSidecarStatus.RETRYING);
    this.scheduleRetry(delayMs);
  }

  private scheduleRetry(delayMs: number): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.nextRetryDelayMs = null;
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
    this.nextRetryDelayMs = null;
  }

  private peekNextDelay(attemptsSoFar: number): number {
    const idx = Math.min(attemptsSoFar, RETRY_DELAYS_MS.length - 1);
    if (attemptsSoFar >= RETRY_DELAYS_MS.length) {
      return STEADY_RETRY_MS;
    }
    return RETRY_DELAYS_MS[idx] ?? STEADY_RETRY_MS;
  }

  private withJitter(delayMs: number): number {
    const jitter = Math.round(delayMs * 0.2 * Math.random());
    return delayMs + jitter;
  }

  private async teardownAudio(): Promise<void> {
    this.detachAudioStreamErrorListener();

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
      if (this.isHandlingRuntimeLoss) {
        logger.debug('runtime audio loss already being handled, ignoring duplicate error', { message: error.message });
        return;
      }
      logger.warn('audio stream error while connected, triggering re-retry', { message: error.message });
      this.lastError = this.summarizeError(error);
      void this.handleRuntimeLoss(error);
    };
    this.audioStreamErrorHandler = handler;
    this.deps.audioStreamManager.on('error', handler);
  }

  private detachAudioStreamErrorListener(): void {
    if (!this.audioStreamErrorHandler) return;
    this.deps.audioStreamManager.off('error', this.audioStreamErrorHandler);
    this.audioStreamErrorHandler = null;
  }

  private async handleRuntimeLoss(error: Error): Promise<void> {
    if (this.isStopping) return;
    this.isHandlingRuntimeLoss = true;
    try {
      if (this.connectedAt && Date.now() - this.connectedAt >= STABLE_CONNECTION_MS) {
        this.resetRetryState();
      }
      this.clearStableConnectionTimer();
      await this.teardownAudio();
      if (this.isStopping) return;
      await this.handleFailure(error, 'runtime');
    } finally {
      this.isHandlingRuntimeLoss = false;
    }
  }

  private resolveAffectedDeviceName(phase: 'startStream' | 'startOutput' | 'runtime', issue: RtAudioRuntimeIssue | null): string | null {
    if (issue?.deviceName) return issue.deviceName;
    const audioConfig = ConfigManager.getInstance().getAudioConfig();
    if (phase === 'startOutput' || issue?.direction === 'output') {
      return audioConfig.outputDeviceName ?? null;
    }
    if (phase === 'startStream' || issue?.direction === 'input') {
      return audioConfig.inputDeviceName ?? null;
    }
    return audioConfig.outputDeviceName ?? audioConfig.inputDeviceName ?? null;
  }

  private resolveConfiguredSampleRate(phase: 'startStream' | 'startOutput' | 'runtime'): number | null {
    const audioConfig = ConfigManager.getInstance().getAudioConfig();
    if (phase === 'startStream') {
      return audioConfig.inputSampleRate ?? audioConfig.sampleRate ?? DEFAULT_SAMPLE_RATE;
    }
    return audioConfig.outputSampleRate ?? audioConfig.sampleRate ?? DEFAULT_SAMPLE_RATE;
  }

  private recordRecoverableFailure(): number {
    this.retryAttempt += 1;
    return this.retryAttempt;
  }

  private resetRetryState(): void {
    this.retryAttempt = 0;
  }

  private async maybeApplySampleRateFallback(
    error: unknown,
    phase: 'startStream' | 'startOutput' | 'runtime',
    issue: RtAudioRuntimeIssue | null,
  ): Promise<void> {
    if (!this.shouldConsiderSampleRateFallback(error, phase, issue)) {
      this.classification = this.classifyFailure(error, phase, issue);
      return;
    }

    const audioConfig = ConfigManager.getInstance().getAudioConfig();
    const profileId = ConfigManager.getInstance().getActiveProfileId?.() ?? null;
    const deviceName = this.affectedDeviceName ?? audioConfig.outputDeviceName ?? audioConfig.inputDeviceName ?? null;
    const signature = this.getFallbackKey(profileId, deviceName, issue);
    const currentOutputRate = issue?.sampleRate ?? audioConfig.outputSampleRate ?? audioConfig.sampleRate ?? DEFAULT_SAMPLE_RATE;

    if (currentOutputRate === YAESU_FALLBACK_SAMPLE_RATE || this.attemptedFallbackKeys.has(signature)) {
      this.classification = 'sample-rate-fallback-failed';
      this.runtimeFallback = {
        active: false,
        fromSampleRate: DEFAULT_SAMPLE_RATE,
        toSampleRate: YAESU_FALLBACK_SAMPLE_RATE,
        persisted: false,
        reason: 'fallback-already-attempted',
        profileId,
        deviceName,
      };
      return;
    }

    const deviceAvailable = await this.isAffectedOutputDeviceAvailable(deviceName);
    if (!deviceAvailable) {
      this.classification = 'device-unavailable';
      return;
    }

    this.attemptedFallbackKeys.add(signature);
    const inputDeviceName = audioConfig.inputDeviceName;
    const outputDeviceName = audioConfig.outputDeviceName;
    const shouldFallbackInput = this.shouldFallbackInputWithOutput(inputDeviceName, outputDeviceName, deviceName);
    this.deps.audioStreamManager.applyRuntimeAudioSampleRateOverride({
      inputSampleRate: shouldFallbackInput ? YAESU_FALLBACK_SAMPLE_RATE : undefined,
      outputSampleRate: YAESU_FALLBACK_SAMPLE_RATE,
      reason: 'early-rtaudio-runtime-loss',
    });
    this.runtimeFallback = {
      active: true,
      fromSampleRate: currentOutputRate,
      toSampleRate: YAESU_FALLBACK_SAMPLE_RATE,
      persisted: false,
      reason: 'early-rtaudio-runtime-loss',
      profileId,
      deviceName,
    };
    this.sampleRate = YAESU_FALLBACK_SAMPLE_RATE;
    this.classification = 'sample-rate-fallback';
    this.retryReason = 'Detected early RtAudio/CoreAudio runtime loss at 48 kHz; retrying at 44.1 kHz.';
  }

  private shouldConsiderSampleRateFallback(
    error: unknown,
    phase: 'startStream' | 'startOutput' | 'runtime',
    issue: RtAudioRuntimeIssue | null,
  ): boolean {
    if (phase !== 'runtime' || !issue?.runtimeLoss || issue.direction !== 'output') return false;
    if (this.connectedAt !== null && Date.now() - this.connectedAt >= STABLE_CONNECTION_MS) return false;
    if (issue.sampleRate !== DEFAULT_SAMPLE_RATE) return false;
    if (issue.elapsedSinceOpenMs !== null && issue.elapsedSinceOpenMs > EARLY_RUNTIME_LOSS_MS) return false;
    if (!this.isYaesuLikeCurrentProfileOrDevice(issue.deviceName ?? this.affectedDeviceName)) return false;
    const message = error instanceof Error ? error.message : issue.message;
    const normalized = message.toLowerCase();
    return normalized.includes('core')
      || normalized.includes('stream device')
      || normalized.includes('disconnected')
      || normalized.includes('closed');
  }

  private classifyFailure(
    error: unknown,
    phase: 'startStream' | 'startOutput' | 'runtime',
    issue: RtAudioRuntimeIssue | null,
  ): AudioSidecarClassification {
    if (this.runtimeFallback?.active && issue?.runtimeLoss) return 'sample-rate-fallback-failed';
    if (issue?.runtimeLoss || phase === 'runtime') return 'runtime-loss';
    if (error instanceof RadioError && error.code === RadioErrorCode.DEVICE_NOT_FOUND) return 'device-unavailable';
    return 'startup-failure';
  }

  private getFallbackKey(profileId: string | null, deviceName: string | null, issue: RtAudioRuntimeIssue | null): string {
    const message = (issue?.message ?? '').toLowerCase().replace(/\s+/g, ' ').slice(0, 120);
    return [profileId ?? 'no-profile', deviceName ?? 'default-device', issue?.sampleRate ?? DEFAULT_SAMPLE_RATE, message].join('|');
  }

  private async isAffectedOutputDeviceAvailable(deviceName: string | null): Promise<boolean> {
    if (!deviceName) return true;
    const device = await AudioDeviceManager.getInstance().getOutputDeviceByName(deviceName);
    return Boolean(device && device.availability !== 'cached');
  }

  private shouldFallbackInputWithOutput(
    inputDeviceName: string | undefined,
    outputDeviceName: string | undefined,
    affectedDeviceName: string | null,
  ): boolean {
    if (!inputDeviceName) return false;
    if (inputDeviceName === outputDeviceName || inputDeviceName === affectedDeviceName) return true;
    return this.isUsbCodecLikeDevice(inputDeviceName) && this.isUsbCodecLikeDevice(outputDeviceName ?? affectedDeviceName ?? '');
  }

  private isYaesuLikeCurrentProfileOrDevice(deviceName: string | null | undefined): boolean {
    const radioConfig = ConfigManager.getInstance().getRadioConfig?.();
    const rigModel = Number(radioConfig?.serial?.rigModel);
    if (rigModel === 1049) return true;
    return this.isUsbCodecLikeDevice(deviceName ?? '');
  }

  private isUsbCodecLikeDevice(deviceName: string): boolean {
    const normalized = deviceName.toLowerCase().replace(/[-_:.()]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!normalized) return false;
    return normalized.includes('usb audio codec')
      || normalized.includes('pcm2902')
      || normalized.includes('pcm2904')
      || normalized.includes('burrbrown')
      || normalized.includes('burr brown')
      || normalized.includes('c media') && normalized.includes('usb audio device');
  }

  private scheduleStableConnectionCheckpoint(): void {
    this.clearStableConnectionTimer();
    this.stableConnectionTimer = setTimeout(() => {
      this.stableConnectionTimer = null;
      if (this.status !== AudioSidecarStatus.CONNECTED || this.isStopping) return;
      this.resetRetryState();
      void this.persistStableRuntimeFallback();
    }, STABLE_CONNECTION_MS);
  }

  private clearStableConnectionTimer(): void {
    if (this.stableConnectionTimer) {
      clearTimeout(this.stableConnectionTimer);
      this.stableConnectionTimer = null;
    }
  }

  private async persistStableRuntimeFallback(): Promise<void> {
    const fallback = this.runtimeFallback;
    if (!fallback?.active || fallback.persisted || fallback.toSampleRate !== YAESU_FALLBACK_SAMPLE_RATE) {
      return;
    }
    try {
      const audioConfig = ConfigManager.getInstance().getAudioConfig();
      const outputPatch = { outputSampleRate: fallback.toSampleRate };
      const inputPatch = this.shouldFallbackInputWithOutput(
        audioConfig.inputDeviceName,
        audioConfig.outputDeviceName,
        fallback.deviceName ?? null,
      )
        ? { inputSampleRate: fallback.toSampleRate }
        : {};
      await ProfileManager.getInstance().updateActiveProfileAudioConfig({
        ...inputPatch,
        ...outputPatch,
      });
      fallback.persisted = true;
      this.emitStatus();
      logger.warn('stable runtime audio sample rate fallback persisted', {
        profileId: fallback.profileId,
        deviceName: fallback.deviceName,
        fromSampleRate: fallback.fromSampleRate,
        toSampleRate: fallback.toSampleRate,
      });
    } catch (error) {
      logger.warn('failed to persist runtime audio sample rate fallback', error);
    }
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
    this.emitStatus();
  }

  private emitStatus(): void {
    const payload = this.buildStatusPayload();
    this.deps.engineEmitter.emit('audioSidecarStatusChanged', payload);
  }
}
