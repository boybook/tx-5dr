import type { EventEmitter } from 'eventemitter3';
import type { CoreRadioCapabilities, DigitalRadioEngineEvents, EngineMode, PresetFrequency } from '@tx5dr/contracts';
import { RadioConnectionStatus } from '@tx5dr/contracts';
import { getBandFromFrequency } from '@tx5dr/core';
import { RadioError, RadioErrorCode } from '../utils/errors/RadioError.js';
import type { PhysicalRadioManager } from '../radio/PhysicalRadioManager.js';
import type { FrequencyManager } from '../radio/FrequencyManager.js';
import type { SlotPackManager } from '../slot/SlotPackManager.js';
import type { RadioOperatorManager } from '../operator/RadioOperatorManager.js';
import { ConfigManager } from '../config/config-manager.js';
import { ListenerManager } from './ListenerManager.js';
import type { TransmissionPipeline } from './TransmissionPipeline.js';
import type { EngineLifecycle } from './EngineLifecycle.js';
import { createLogger } from '../utils/logger.js';
import { buildRadioStatusPayload } from '../radio/buildRadioStatusPayload.js';

const logger = createLogger('RadioBridge');
const AUTO_RESTORE_RETRY_DELAYS_MS = [2000, 4000, 8000, 16000, 30000];

export interface RadioBridgeDeps {
  engineEmitter: EventEmitter<DigitalRadioEngineEvents>;
  radioManager: PhysicalRadioManager;
  frequencyManager: FrequencyManager;
  slotPackManager: SlotPackManager;
  operatorManager: RadioOperatorManager;
  getTransmissionPipeline: () => TransmissionPipeline;
  getEngineLifecycle: () => EngineLifecycle;
  getEngineMode: () => EngineMode;
}

/**
 * 电台事件桥接子系统
 *
 * 负责：
 * - 将 RadioManager 事件投影到 engineEmitter
 * - 在断线/重连时协调引擎恢复
 * - 维护与电台状态相关的轻量运行时桥接
 *
 * 不负责：
 * - 连接后的 bootstrap 与频率恢复
 * - 资源注册或启动顺序
 * - 直接下发底层 CAT 写命令
 *
 * 监听器是永久的（整个引擎生命周期），不随 start/stop 变化。
 */
export class RadioBridge {
  private lm = new ListenerManager();

  // 高频事件采样监控（用于健康检查）
  private spectrumEventCount: number = 0;
  private meterEventCount: number = 0;
  private lastHealthCheckTimestamp: number = Date.now();

  // 记录断开前是否在运行
  private _wasRunningBeforeDisconnect = false;
  private restoreRetryTimer: NodeJS.Timeout | null = null;
  private restoreRetryAttempt = 0;
  private restoreStartInProgress = false;

  constructor(private deps: RadioBridgeDeps) {}

  get wasRunningBeforeDisconnect(): boolean {
    return this._wasRunningBeforeDisconnect;
  }

  set wasRunningBeforeDisconnect(val: boolean) {
    this._wasRunningBeforeDisconnect = val;
  }

  /**
   * 记录频谱事件（供 ClockCoordinator 调用）
   */
  onSpectrumEvent(): void {
    this.spectrumEventCount++;
    if (this.spectrumEventCount % 100 === 0) {
      this.checkHighFrequencyEventsHealth();
    }
  }

  /**
   * 记录数值表事件（供内部使用）
   */
  private onMeterEvent(): void {
    this.meterEventCount++;
    if (this.meterEventCount % 100 === 0) {
      this.checkHighFrequencyEventsHealth();
    }
  }

  /**
   * 注册所有 RadioManager 事件监听器
   */
  setupListeners(): void {
    const { engineEmitter, radioManager, frequencyManager, slotPackManager } = this.deps;

    // 监听电台连接中
    this.lm.listen(radioManager, 'connecting', () => {
      this.handleRadioConnecting();
    });

    // 监听电台连接成功
    this.lm.listen(radioManager, 'connected', () => {
      void this.handleRadioConnected().catch((error) => {
        logger.error('Failed to handle radio connected event:', error);
      });
    });

    // 监听电台自动重连中
    this.lm.listen(radioManager, 'reconnecting', (...args: unknown[]) => {
      const attempt = args[0] as number;
      const maxAttempts = args[1] as number;
      const delayMs = args[2] as number | undefined;
      void this.handleRadioReconnecting(attempt, maxAttempts, delayMs).catch((error) => {
        logger.error('Failed to handle radio reconnecting event:', error);
      });
    });

    // 监听电台断开连接
    this.lm.listen(radioManager, 'disconnected', (...args: unknown[]) => {
      const reason = args[0] as string | undefined;
      void this.handleRadioDisconnected(reason).catch((error) => {
        logger.error('Failed to handle radio disconnected event:', error);
      });
    });

    // 监听电台错误（提取完整 RadioError 属性 + Profile 关联）
    this.lm.listen(radioManager, 'error', (...args: unknown[]) => {
      const error = args[0] as Error;
      this.handleRadioError(error);
    });

    // 监听电台数值表数据
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.lm.listen(radioManager, 'meterData', (_data: any) => {
      this.onMeterEvent();
    });

    // 监听统一能力系统事件，转发到引擎事件总线
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.lm.listen(radioManager, 'capabilityList', (data: any) => {
      engineEmitter.emit('radioCapabilityList', data);
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.lm.listen(radioManager, 'capabilityChanged', (state: any) => {
      engineEmitter.emit('radioCapabilityChanged', state);
    });

    this.lm.listen(radioManager, 'coreCapabilitiesChanged', (coreCapabilities) => {
      void this.handleCoreCapabilitiesChanged(coreCapabilities).catch((error) => {
        logger.error('Failed to handle core capability change:', error);
      });
    });

    // 监听电台频率变化（自动同步）
    this.lm.listen(radioManager, 'radioFrequencyChanged', async (...args: unknown[]) => {
      const frequency = args[0] as number;
      logger.debug(`Radio frequency changed: ${(frequency / 1000000).toFixed(3)} MHz`);

      try {
        const frequencyInfo = this.resolveFrequencyInfo(frequency, frequencyManager);
        await this.persistFrequencyInfo(frequencyInfo);

        slotPackManager.clearInMemory();
        logger.debug('Cleared historical decode data');

        engineEmitter.emit('frequencyChanged', {
          frequency: frequencyInfo.frequency,
          mode: frequencyInfo.mode,
          band: frequencyInfo.band,
          radioMode: frequencyInfo.radioMode,
          description: frequencyInfo.description,
          radioConnected: true,
          source: 'radio',
        });

        logger.debug(`Frequency auto-sync complete: ${frequencyInfo.description}`);
      } catch (error) {
        logger.error('Failed to handle frequency change:', error);
      }
    });

    logger.info(`Registered ${this.lm.count} RadioManager event listeners`);
  }

  private handleRadioConnecting(): void {
    logger.info('Radio connecting...');

    this.deps.engineEmitter.emit('radioStatusChanged', buildRadioStatusPayload({
      connected: false,
      status: RadioConnectionStatus.CONNECTING,
      radioInfo: null,
      radioManager: this.deps.radioManager,
    }));
  }

  private async handleRadioConnected(): Promise<void> {
    logger.info('Radio connected');

    const { engineEmitter, radioManager } = this.deps;
    const radioInfo = await radioManager.getRadioInfo();
    const radioConfig = radioManager.getConfig();
    const tunerCapabilities = await radioManager.getTunerCapabilities();

    engineEmitter.emit('radioStatusChanged', buildRadioStatusPayload({
      connected: true,
      status: RadioConnectionStatus.CONNECTED,
      radioInfo,
      radioConfig,
      tunerCapabilities,
      radioManager,
    }));

    await this.restoreRunningStateIfNeeded();
  }

  private resolveFrequencyInfo(
    frequency: number,
    frequencyManager: FrequencyManager,
  ): {
    frequency: number;
    mode: string;
    band: string;
    radioMode?: string;
    description: string;
  } {
    const engineMode = this.deps.getEngineMode();
    const preset = this.findPresetForEngineMode(frequencyManager.getPresets(), frequency, engineMode);

    if (preset) {
      logger.debug(`Matched ${engineMode} preset frequency: ${preset.description}`);
      return {
        frequency: preset.frequency,
        mode: preset.mode,
        band: preset.band,
        radioMode: preset.radioMode,
        description: preset.description || `${(preset.frequency / 1000000).toFixed(3)} MHz`,
      };
    }

    logger.debug(`No ${engineMode} preset matched, using custom frequency`);
    const band = this.resolveBandLabel(frequency);
    const isVoiceMode = engineMode === 'voice';
    const lastVoiceFrequency = isVoiceMode ? ConfigManager.getInstance().getLastVoiceFrequency() : null;

    return {
      frequency,
      mode: isVoiceMode ? 'VOICE' : 'FT8',
      band,
      radioMode: isVoiceMode ? lastVoiceFrequency?.radioMode : undefined,
      description: `${(frequency / 1000000).toFixed(3)} MHz${band !== 'Unknown' ? ` ${band}` : ''}`,
    };
  }

  private findPresetForEngineMode(
    presets: PresetFrequency[],
    frequency: number,
    engineMode: EngineMode,
    tolerance: number = 500,
  ): PresetFrequency | null {
    const targetMode = engineMode === 'voice' ? 'VOICE' : null;
    let closestPreset: PresetFrequency | null = null;
    let smallestDiff = Infinity;

    for (const preset of presets) {
      if (targetMode ? preset.mode !== targetMode : preset.mode === 'VOICE') {
        continue;
      }

      const diff = Math.abs(preset.frequency - frequency);
      if (diff <= tolerance && diff < smallestDiff) {
        closestPreset = preset;
        smallestDiff = diff;
      }
    }

    return closestPreset;
  }

  private resolveBandLabel(frequency: number): string {
    try {
      return getBandFromFrequency(frequency);
    } catch {
      return 'Unknown';
    }
  }

  private async persistFrequencyInfo(frequencyInfo: {
    frequency: number;
    mode: string;
    band: string;
    radioMode?: string;
    description: string;
  }): Promise<void> {
    const configManager = ConfigManager.getInstance();
    if (frequencyInfo.mode === 'VOICE') {
      await configManager.updateLastVoiceFrequency({
        frequency: frequencyInfo.frequency,
        radioMode: frequencyInfo.radioMode,
        band: frequencyInfo.band,
        description: frequencyInfo.description,
      });
      return;
    }

    await configManager.updateLastSelectedFrequency({
      frequency: frequencyInfo.frequency,
      mode: frequencyInfo.mode,
      radioMode: frequencyInfo.radioMode,
      band: frequencyInfo.band,
      description: frequencyInfo.description,
    });
  }

  private async restoreRunningStateIfNeeded(): Promise<void> {
    if (!this._wasRunningBeforeDisconnect) {
      return;
    }

    const lifecycle = this.deps.getEngineLifecycle();
    const engineState = lifecycle.getEngineState();
    if (!lifecycle.getIsRunning() && engineState !== 'starting') {
      logger.info('Radio connected, restoring previous running state');
      try {
        this.restoreStartInProgress = true;
        await lifecycle.start();
        this.clearRestoreRetryState();
        this._wasRunningBeforeDisconnect = false;
      } catch (err) {
        if (this.shouldRetryAutoRestore(err)) {
          this.scheduleRestoreRetry(err);
        } else {
          logger.error('Auto-start failed:', err);
          this.clearRestoreRetryState();
          this._wasRunningBeforeDisconnect = false;
        }
      } finally {
        this.restoreStartInProgress = false;
      }
      return;
    }

    this.clearRestoreRetryState();
    this._wasRunningBeforeDisconnect = false;
  }

  private async handleRadioReconnecting(
    attempt: number,
    maxAttempts: number,
    delayMs?: number,
  ): Promise<void> {
    logger.info(`Radio reconnecting ${attempt}/${maxAttempts}`);
    this.clearRestoreRetryState();

    const { engineEmitter, operatorManager, radioManager } = this.deps;
    const lifecycle = this.deps.getEngineLifecycle();

    if (attempt === 1) {
      if (lifecycle.getIsRunning()) {
        this._wasRunningBeforeDisconnect = true;
      }
      operatorManager.stopAllOperators();
      const pipeline = this.deps.getTransmissionPipeline();
      if (pipeline.getIsPTTActive()) {
        await pipeline.forceStopPTT();
      }
      if (lifecycle.getIsRunning()) {
        lifecycle.sendRadioDisconnected('Radio disconnected, auto-reconnecting');
      }
    }

    engineEmitter.emit('radioStatusChanged', buildRadioStatusPayload({
      connected: false,
      status: RadioConnectionStatus.RECONNECTING,
      radioInfo: null,
      message: `Reconnecting to radio... (${attempt}/${maxAttempts})`,
      reconnectProgress: { attempt, maxAttempts, nextRetryMs: delayMs },
      radioManager,
    }));
  }

  private async handleRadioDisconnected(reason?: string): Promise<void> {
    logger.info(`Radio disconnected: ${reason || 'unknown reason'}`);
    if (!this.restoreStartInProgress) {
      this.clearRestoreRetryState();
    }

    const { engineEmitter, operatorManager, radioManager } = this.deps;
    const lifecycle = this.deps.getEngineLifecycle();

    // 用户主动进入 standby/off 导致的断线：跳过自动重连/恢复，走 forced stop 路径
    const intentional = radioManager.consumeIntentionalDisconnect();
    if (intentional.active) {
      logger.info(`Intentional disconnect (${intentional.reason || 'no reason'}), skipping reconnect`);
      operatorManager.stopAllOperators();
      const pipeline = this.deps.getTransmissionPipeline();
      if (pipeline.getIsPTTActive()) {
        await pipeline.forceStopPTT();
      }
      if (lifecycle.getIsRunning()) {
        lifecycle.sendRadioDisconnected(intentional.reason || 'power state change');
      }
      this._wasRunningBeforeDisconnect = false;
      engineEmitter.emit('radioStatusChanged', buildRadioStatusPayload({
        connected: false,
        status: RadioConnectionStatus.DISCONNECTED,
        radioInfo: null,
        reason: intentional.reason,
        message: 'Radio entered standby / powered off by user',
        recommendation: '',
        radioManager,
      }));
      return;
    }

    if (lifecycle.getIsRunning() && !this._wasRunningBeforeDisconnect) {
      this._wasRunningBeforeDisconnect = true;
      logger.info('Recording running state before disconnect');
    }

    operatorManager.stopAllOperators();

    const pipeline = this.deps.getTransmissionPipeline();
    if (pipeline.getIsPTTActive()) {
      logger.warn('Radio disconnected during transmission, stopping PTT immediately');
      await pipeline.forceStopPTT();
      lifecycle.sendRadioDisconnected(reason || 'Radio disconnected during transmission');

      engineEmitter.emit('radioDisconnectedDuringTransmission', {
        reason: reason || 'Radio disconnected during transmission',
        message: 'Radio disconnected during transmission, possibly due to high TX power causing USB interference. Transmission and monitoring have been stopped automatically.',
        recommendation: 'Check radio settings, reduce TX power or improve connection environment, then reconnect the radio.'
      });
    } else if (lifecycle.getIsRunning()) {
      logger.warn('Radio disconnected, stopping engine automatically');
      lifecycle.sendRadioDisconnected(reason || 'Radio disconnected');
    }

    const wasReconnecting = this._wasRunningBeforeDisconnect;
    engineEmitter.emit('radioStatusChanged', buildRadioStatusPayload({
      connected: false,
      status: wasReconnecting
        ? RadioConnectionStatus.CONNECTION_LOST
        : RadioConnectionStatus.DISCONNECTED,
      radioInfo: null,
      reason,
      message: wasReconnecting ? 'Radio connection lost' : 'Radio disconnected',
      recommendation: this.getDisconnectRecommendation(reason),
      radioManager,
    }));

    if (!this.restoreStartInProgress) {
      this._wasRunningBeforeDisconnect = false;
    }
  }

  private handleRadioError(error: Error): void {
    logger.error(`Radio error: ${error.message}`);

    const configManager = ConfigManager.getInstance();
    const activeProfile = configManager.getActiveProfile();
    const isRadioError = error instanceof RadioError;

    this.deps.engineEmitter.emit('radioError', {
      message: error.message,
      userMessage: isRadioError ? error.userMessage : error.message,
      userMessageKey: isRadioError ? error.userMessageKey : undefined,
      userMessageParams: isRadioError ? error.userMessageParams : undefined,
      suggestions: isRadioError ? error.suggestions : [],
      code: isRadioError ? error.code : undefined,
      severity: isRadioError ? error.severity : 'error',
      timestamp: new Date().toISOString(),
      context: isRadioError ? error.context : undefined,
      stack: process.env.NODE_ENV !== 'production' ? error.stack : undefined,
      connectionHealth: this.deps.radioManager.getConnectionHealth(),
      profileId: activeProfile?.id ?? null,
      profileName: activeProfile?.name ?? null,
    });
  }

  private shouldRetryAutoRestore(error: unknown): boolean {
    if (!(error instanceof RadioError)) {
      return false;
    }

    return (
      error.code === RadioErrorCode.DEVICE_NOT_FOUND &&
      error.context?.temporaryUnavailable === true &&
      error.context?.recoverable === true
    );
  }

  private scheduleRestoreRetry(error: unknown): void {
    if (this.restoreRetryAttempt >= AUTO_RESTORE_RETRY_DELAYS_MS.length) {
      logger.error('Auto-start retry limit reached after temporary audio device loss', error);
      this.clearRestoreRetryState();
      this._wasRunningBeforeDisconnect = false;
      return;
    }

    const attempt = this.restoreRetryAttempt + 1;
    const delayMs = AUTO_RESTORE_RETRY_DELAYS_MS[this.restoreRetryAttempt];
    this.restoreRetryAttempt = attempt;

    if (this.restoreRetryTimer) {
      clearTimeout(this.restoreRetryTimer);
      this.restoreRetryTimer = null;
    }

    logger.warn('Auto-start failed because the configured audio device is temporarily unavailable; scheduling retry', {
      attempt,
      maxAttempts: AUTO_RESTORE_RETRY_DELAYS_MS.length,
      delayMs,
    });

    this.restoreRetryTimer = setTimeout(() => {
      this.restoreRetryTimer = null;
      void this.retryRestoreRunningState(attempt).catch((retryError) => {
        logger.error('Auto-start retry failed unexpectedly:', retryError);
        this.clearRestoreRetryState();
        this._wasRunningBeforeDisconnect = false;
      });
    }, delayMs);
  }

  private async retryRestoreRunningState(attempt: number): Promise<void> {
    if (!this._wasRunningBeforeDisconnect) {
      return;
    }

    const lifecycle = this.deps.getEngineLifecycle();
    if (lifecycle.getIsRunning() || lifecycle.getEngineState() === 'starting') {
      return;
    }

    logger.info(`Retrying engine restore after temporary audio device loss (${attempt}/${AUTO_RESTORE_RETRY_DELAYS_MS.length})`);

    try {
      this.restoreStartInProgress = true;
      await lifecycle.start();
      this.clearRestoreRetryState();
      this._wasRunningBeforeDisconnect = false;
    } catch (error) {
      if (this.shouldRetryAutoRestore(error)) {
        this.scheduleRestoreRetry(error);
        return;
      }

      logger.error('Auto-start retry failed:', error);
      this.clearRestoreRetryState();
      this._wasRunningBeforeDisconnect = false;
    } finally {
      this.restoreStartInProgress = false;
    }
  }

  private clearRestoreRetryState(): void {
    if (this.restoreRetryTimer) {
      clearTimeout(this.restoreRetryTimer);
      this.restoreRetryTimer = null;
    }
    this.restoreRetryAttempt = 0;
  }

  private async handleCoreCapabilitiesChanged(coreCapabilities: CoreRadioCapabilities): Promise<void> {
    const radioManager = this.deps.radioManager;
    const radioInfo = radioManager.isConnected()
      ? await radioManager.getRadioInfo()
      : null;

    this.deps.engineEmitter.emit('radioStatusChanged', buildRadioStatusPayload({
      connected: radioManager.isConnected(),
      status: radioManager.getConnectionStatus(),
      radioInfo,
      coreCapabilities,
      radioManager,
    }));
  }

  /**
   * 清理所有监听器
   */
  teardownListeners(): void {
    logger.info(`Removing ${this.lm.count} RadioManager event listeners`);
    this.lm.disposeAll();
  }

  /**
   * 检查高频事件健康状态（采样监控）
   */
  checkHighFrequencyEventsHealth(): void {
    const now = Date.now();
    const timeSinceLastCheck = now - this.lastHealthCheckTimestamp;

    const lifecycle = this.deps.getEngineLifecycle();
    if (!lifecycle.getIsRunning()) {
      return;
    }

    if (timeSinceLastCheck < 10000) {
      return;
    }

    const radioConnected = this.deps.radioManager.isConnected();
    const radioConfig = ConfigManager.getInstance().getRadioConfig();
    // type=none 时电台未连接是正常的，不发出警告
    if (!radioConnected && lifecycle.getIsRunning() && radioConfig.type !== 'none') {
      logger.warn('Radio not connected but engine is running');
    }

    const spectrumRate = timeSinceLastCheck > 0 ? (this.spectrumEventCount / timeSinceLastCheck) * 1000 : 0;
    const meterRate = timeSinceLastCheck > 0 ? (this.meterEventCount / timeSinceLastCheck) * 1000 : 0;

    if (spectrumRate < 1 && lifecycle.getIsRunning()) {
      logger.warn(`Spectrum event rate abnormally low: ${spectrumRate.toFixed(2)} Hz`);
    }

    if (meterRate < 0.5 && lifecycle.getIsRunning() && radioConnected && radioConfig.type !== 'none') {
      logger.warn(`Meter event rate abnormally low: ${meterRate.toFixed(2)} Hz`);
    }

    logger.debug(`High-frequency event sample stats (${(timeSinceLastCheck / 1000).toFixed(1)}s): spectrum=${this.spectrumEventCount} (${spectrumRate.toFixed(1)} Hz), meter=${this.meterEventCount} (${meterRate.toFixed(1)} Hz)`);

    this.spectrumEventCount = 0;
    this.meterEventCount = 0;
    this.lastHealthCheckTimestamp = now;
  }

  /**
   * 根据断开原因生成用户友好的解决建议
   */
  private getDisconnectRecommendation(reason?: string): string {
    if (!reason) {
      return 'Check that the radio is powered on and the network connection is normal, then try reconnecting.';
    }

    const reasonLower = reason.toLowerCase();

    if (reasonLower.includes('usb') || reasonLower.includes('communication') || reasonLower.includes('serial')) {
      return 'USB communication may be unstable. Check USB cable connection, try a different USB port or use a shorter cable.';
    }

    if (reasonLower.includes('network') || reasonLower.includes('timeout') || reasonLower.includes('timed out')) {
      return 'Possible network connection issue. Check WiFi, confirm radio and computer are on the same network, check firewall settings.';
    }

    if (reasonLower.includes('disconnect()') || reasonLower.includes('manual') || reasonLower.includes('requested')) {
      return 'Connection disconnected as requested. To reconnect, click the "Connect Radio" button.';
    }

    if (reasonLower.includes('timed out') || reasonLower.includes('connection timeout')) {
      return 'Connection timed out. Check that the radio is powered on and network or serial connection is normal, then retry.';
    }

    if (reasonLower.includes('io error') || reasonLower.includes('i/o') || reasonLower.includes('device')) {
      return 'Device IO error. Check radio connection (USB/network), confirm radio is powered on and working, then reconnect.';
    }

    if (reasonLower.includes('power') || reasonLower.includes('interference')) {
      return 'High TX power may be causing interference. Reduce TX power (50W or below recommended), improve connection environment, then reconnect.';
    }

    return `Connection disconnected (${reason}). Check radio connection and settings, then try reconnecting.`;
  }
}
