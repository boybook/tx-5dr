/* eslint-disable @typescript-eslint/no-explicit-any */
// IcomWlanConnection - 二进制协议处理需要使用any

/**
 * IcomWlanConnection - ICOM WLAN 连接实现
 *
 * 直接封装 icom-wlan-node 库，实现统一的 IRadioConnection 接口
 * 移除 IcomWlanManager 中间层，减少代码冗余
 */

import { EventEmitter } from 'eventemitter3';
import {
  IcomControl,
  AUDIO_RATE,
  type IcomAudioIfSource,
  type IcomFunctionName,
  type IcomLevelName,
  type IcomModelId,
  type IcomScopeFrame,
  type IcomSpectrumCenterType,
  type IcomSpectrumSpeed,
  type IcomVfoName,
} from 'icom-wlan-node';
import type { MeterCapabilities } from '@tx5dr/contracts';
import { TunerCapabilities, TunerStatus } from '@tx5dr/contracts';
import { RadioError, RadioErrorCode, RadioErrorSeverity } from '../../utils/errors/RadioError.js';
import { globalEventBus } from '../../utils/EventBus.js';
import { createLogger } from '../../utils/logger.js';
import { isProcessShuttingDown } from '../../utils/process-shutdown.js';
import { isRecoverableOptionalRadioError } from '../optionalRadioError.js';
import { ICOM_WLAN_RADIO_IO_QUEUE_OPTIONS, RADIO_IO_SKIPPED, RadioIoQueue } from './RadioIoQueue.js';
import {
  type ApplyOperatingStateRequest,
  type ApplyOperatingStateResult,
  RadioConnectionType,
  RadioConnectionState,
  type RadioSpectrumDisplayState,
  type IRadioConnection,
  type IRadioConnectionEvents,
  type RadioConnectionConfig,
  type MeterData,
  type RadioModeInfo,
  type RadioModeBandwidth,
  type SetRadioModeOptions,
} from './IRadioConnection.js';

const logger = createLogger('IcomWlanConnection');
const SPECTRUM_CAT_TIMEOUT_MS = 1000;
const TX_METER_SETTLE_MS = 200;
const METER_SAMPLE_LOG_INTERVAL_MS = 5000;
const ICOM_WLAN_POWER_METER_SUPPORTED = true;
const FREQUENCY_NULL_FAILURE_LIMIT = 3;
const FREQUENCY_NULL_FAILURE_WINDOW_MS = 8000;
const ICOM_AGC_CODE_TO_MODE: Record<number, string> = {
  0: 'off',
  1: 'superfast',
  2: 'fast',
  3: 'slow',
  4: 'user',
  5: 'medium',
  6: 'auto',
  7: 'long',
  8: 'on',
};
const ICOM_AGC_MODE_TO_CODE: Record<string, number> = Object.fromEntries(
  Object.entries(ICOM_AGC_CODE_TO_MODE).map(([code, mode]) => [mode, Number(code)]),
) as Record<string, number>;
const ICOM_CTCSS_TONES_TENTHS_HZ = [
  670, 693, 719, 744, 770, 797, 825, 854, 885, 915,
  948, 974, 1000, 1035, 1072, 1109, 1148, 1188, 1230, 1273,
  1318, 1365, 1413, 1462, 1514, 1567, 1598, 1622, 1655, 1679,
  1713, 1738, 1773, 1799, 1835, 1862, 1899, 1928, 1966, 1995,
  2035, 2065, 2107, 2181, 2257, 2291, 2336, 2418, 2503, 2541,
];
const ICOM_AUDIO_IF_SOURCES: IcomAudioIfSource[] = ['default', 'wlan', 'lan', 'acc'];
const ICOM_SPECTRUM_SPEEDS: IcomSpectrumSpeed[] = ['slow', 'mid', 'fast'];
const ICOM_SPECTRUM_CENTER_TYPES: IcomSpectrumCenterType[] = [
  'filter-center',
  'carrier-point-center',
  'carrier-point-center-abs',
];

/**
 * IcomWlanConnection 实现类
 */
export class IcomWlanConnection
  extends EventEmitter<IRadioConnectionEvents>
  implements IRadioConnection
{
  private readonly ioQueue = new RadioIoQueue({
    label: 'ICOM WLAN UDP',
    ...ICOM_WLAN_RADIO_IO_QUEUE_OPTIONS,
  });
  private ioSessionId = 0;
  private backgroundTasksStarted = false;
  /**
   * icom-wlan-node 库的 IcomControl 实例
   */
  private rig: IcomControl | null = null;

  /**
   * 当前连接状态
   */
  private state: RadioConnectionState = RadioConnectionState.DISCONNECTED;

  /**
   * 当前配置
   */
  private currentConfig: RadioConnectionConfig | null = null;

  /**
   * 数值表轮询定时器
   */
  private meterPollingInterval: NodeJS.Timeout | null = null;
  private readonly meterPollingIntervalMs = 300; // 300ms 轮询间隔

  /**
   * 数据模式默认值（从配置中读取，默认 true）
   */
  private defaultDataMode = true;

  /**
   * 清理保护标志（防止重复清理导致资源泄漏或冲突）
   */
  private isCleaningUp = false;

  /**
   * 天调启用状态（本地跟踪，简化版实现）
   */
  private tunerEnabled = false;
  private scopeEnabled = false;
  private readonly isolatedSpectrumTasks = new Set<string>();
  private softwarePttActive = false;
  private pttActivatedAt: number | null = null;
  private lastMeterSampleLoggedAt = 0;
  private detectedModelId: IcomModelId | null = null;
  private detectedProfileName: string | null = null;
  private lastKnownFrequency: number | null = null;
  private frequencyNullFailureCount = 0;
  private firstFrequencyNullFailureAt: number | null = null;

  constructor() {
    super();
  }

  startBackgroundTasks(): void {
    if (this.backgroundTasksStarted) {
      return;
    }

    this.backgroundTasksStarted = true;
    this.startMeterPolling();
  }

  isCriticalOperationActive(): boolean {
    return this.ioQueue.isCriticalActive();
  }

  getRadioIoQueueSnapshot() {
    return this.ioQueue.getSnapshot();
  }

  getDetectedRadioInfo(): { modelId: string | null; profileName: string | null } {
    return {
      modelId: this.detectedModelId,
      profileName: this.detectedProfileName,
    };
  }

  /**
   * 获取连接类型
   */
  getType(): RadioConnectionType {
    return RadioConnectionType.ICOM_WLAN;
  }

  /**
   * 获取当前连接状态
   */
  getState(): RadioConnectionState {
    return this.state;
  }

  /**
   * 检查连接是否健康
   */
  isHealthy(): boolean {
    if (!this.rig) return false;
    const phase = this.rig.getConnectionPhase();
    return phase === 'CONNECTED';
  }

  /**
   * 检查是否已连接（向后兼容）
   */
  isConnected(): boolean {
    return this.isHealthy();
  }

  private ensureSession(sessionId: number): void {
    if (sessionId !== this.ioSessionId) {
      throw new Error('radio session changed');
    }
  }

  private async runSerializedTask<T>(
    taskName: string,
    task: () => Promise<T>,
    options?: { critical?: boolean; id?: string },
  ): Promise<T> {
    const sessionId = this.ioSessionId;
    const id = options?.id ?? (!options?.critical && taskName.startsWith('get') ? taskName : undefined);
    return this.ioQueue.run({ sessionId, name: taskName, critical: options?.critical, id }, async (activeSessionId) => {
      this.ensureSession(activeSessionId);
      const result = await task();
      this.ensureSession(activeSessionId);
      return result;
    });
  }

  private optionalOperationUnavailable(context: string, message: string, cause?: unknown): RadioError {
    return new RadioError({
      code: RadioErrorCode.INVALID_OPERATION,
      message: `Optional radio operation unavailable (${context}): ${message}`,
      userMessage: 'Radio operation is not supported by this model',
      severity: RadioErrorSeverity.WARNING,
      suggestions: [
        'This control can be ignored on radios that do not expose it over ICOM WLAN',
        'Continue using the supported basic radio operations',
      ],
      cause,
      context: {
        operation: context,
        optional: true,
        recoverable: true,
      },
    });
  }

  private requireOptionalValue<T>(context: string, value: T | null | undefined): T {
    if (value === null || value === undefined) {
      throw this.optionalOperationUnavailable(context, 'radio returned null');
    }
    return value;
  }

  private convertOptionalOperationError(error: unknown, context: string): RadioError {
    if (isRecoverableOptionalRadioError(error)) {
      const message = error instanceof Error ? error.message : String(error);
      return this.optionalOperationUnavailable(context, message, error);
    }

    return this.convertError(error, context);
  }

  private getActiveProfile(): any | null {
    return (this.rig as any)?.profile ?? null;
  }

  private profileList<T>(key: string): T[] {
    const profile = this.getActiveProfile();
    const values = profile?.[key];
    return Array.isArray(values) ? values as T[] : [];
  }

  private hasProfileFunction(name: string): boolean {
    const functions = this.profileList<string>('functions');
    return functions.length === 0 || functions.includes(name);
  }

  private hasProfileLevel(name: string): boolean {
    const levels = this.profileList<string>('levels');
    return levels.length === 0 || levels.includes(name);
  }

  private hasProfileParameter(name: string): boolean {
    return this.profileList<string>('parameters').includes(name);
  }

  private hasAdvancedSpectrumControl(name: string): boolean {
    return this.profileList<string>('spectrumAdvanced').includes(name);
  }

  private async readFunctionCapability(taskName: string, functionName: IcomFunctionName): Promise<boolean> {
    return this.runSerializedTask(taskName, async () => {
      this.checkConnected();
      try {
        return this.requireOptionalValue(taskName, await this.rig!.getFunction(functionName, { timeout: 3000 }));
      } catch (error) {
        throw this.convertOptionalOperationError(error, taskName);
      }
    });
  }

  private async writeFunctionCapability(
    taskName: string,
    functionName: IcomFunctionName,
    enabled: boolean,
  ): Promise<void> {
    await this.runSerializedTask(taskName, async () => {
      this.checkConnected();
      try {
        this.rig!.setFunction(functionName, enabled);
      } catch (error) {
        throw this.convertOptionalOperationError(error, taskName);
      }
    });
  }

  private async readLevelCapability(taskName: string, levelName: IcomLevelName): Promise<number> {
    return this.runSerializedTask(taskName, async () => {
      this.checkConnected();
      try {
        return this.requireOptionalValue(taskName, await this.rig!.getLevel(levelName, { timeout: 3000 }));
      } catch (error) {
        throw this.convertOptionalOperationError(error, taskName);
      }
    });
  }

  private async writeLevelCapability(
    taskName: string,
    levelName: IcomLevelName,
    value: number,
  ): Promise<void> {
    await this.runSerializedTask(taskName, async () => {
      this.checkConnected();
      try {
        this.rig!.setLevel(levelName, value);
      } catch (error) {
        throw this.convertOptionalOperationError(error, taskName);
      }
    });
  }

  private async runIsolatedSpectrumTask<T>(
    taskName: string,
    task: () => Promise<T>,
    options?: { timeoutMs?: number; skipIfBusy?: boolean; skippedValue?: T },
  ): Promise<T> {
    if (options?.skipIfBusy && this.isolatedSpectrumTasks.size > 0) {
      logger.debug(`Skipping isolated spectrum CAT task because previous call is still active: ${taskName}`);
      return options.skippedValue as T;
    }

    this.isolatedSpectrumTasks.add(taskName);
    const operation = Promise.resolve()
      .then(task)
      .finally(() => {
        this.isolatedSpectrumTasks.delete(taskName);
      });

    if (!options?.timeoutMs) {
      return operation;
    }

    let timeout: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        operation,
        new Promise<T>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`${taskName} timed out after ${options.timeoutMs}ms`)),
            options.timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private async performFrequencyWrite(frequency: number): Promise<void> {
    this.checkConnected();

    try {
      await this.rig!.setFrequency(frequency);
      logger.debug(`Frequency set: ${(frequency / 1000000).toFixed(3)} MHz`);
    } catch (error) {
      throw this.convertError(error, 'setFrequency');
    }
  }

  private async performModeWrite(
    mode: string,
    bandwidth?: RadioModeBandwidth,
    options?: SetRadioModeOptions,
  ): Promise<void> {
    this.checkConnected();

    try {
      if (typeof bandwidth === 'number') {
        throw new Error('ICOM WLAN setMode does not support numeric passband widths');
      }

      const dataMode = bandwidth === 'wide'
        ? true
        : bandwidth === 'narrow'
          ? false
          : options?.intent === 'digital'
            ? true
            : options?.intent === 'voice' || options?.intent === 'cw'
              ? false
              : this.defaultDataMode;

      const modeCode = this.mapModeToIcom(mode);
      await this.rig!.setMode(modeCode, { dataMode });

      logger.debug(`Mode set: ${mode}${dataMode ? ' (Data)' : ''}`);
    } catch (error) {
      throw this.convertError(error, 'setMode');
    }
  }

  private async performPTTWrite(enabled: boolean): Promise<void> {
    this.checkConnected();

    try {
      logger.debug(`PTT ${enabled ? 'TX start' : 'RX start'}`);
      await this.rig!.setPtt(enabled);
      this.softwarePttActive = enabled;
      this.pttActivatedAt = enabled ? Date.now() : null;
      logger.debug(`PTT ${enabled ? 'TX active' : 'RX active'}`);
    } catch (error) {
      throw RadioError.pttActivationFailed(
        `PTT ${enabled ? 'activation' : 'deactivation'} failed`,
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  /**
   * 连接到电台
   *
   * Note: ICOM WLAN 的 control link 是独立于 audio 的，IcomControl 只建立
   * CI-V/UDP 控制通道。因此 `mode: 'control-only'` 与 `'full'` 的差异仅体现在：
   *   - control-only 态不触发 'connected' 事件，避免上层误判；
   *   - control-only 态仅允许电源类操作（由 checkConnected 放行策略决定）。
   */
  async connect(
    config: RadioConnectionConfig,
    options?: { mode?: 'full' | 'control-only' }
  ): Promise<void> {
    const mode = options?.mode ?? 'full';
    // 状态检查
    if (this.state === RadioConnectionState.CONNECTING) {
      throw RadioError.invalidState(
        'connect',
        this.state,
        RadioConnectionState.DISCONNECTED
      );
    }

    // 如果已连接或在控制链路态，先断开
    if (
      (this.state === RadioConnectionState.CONNECTED ||
        this.state === RadioConnectionState.CONTROL_ONLY) &&
      this.rig
    ) {
      await this.disconnect('reconnecting');
    }

    // 验证配置
    if (config.type !== 'icom-wlan') {
      throw new RadioError({
        code: RadioErrorCode.INVALID_CONFIG,
        message: `Configuration type error: expected 'icom-wlan', got '${config.type}'`,
        userMessage: 'Radio configuration type is incorrect',
        suggestions: ['Check the connection type setting in the configuration file'],
      });
    }

    if (!config.icomWlan || !config.icomWlan.ip || !config.icomWlan.port) {
      throw new RadioError({
        code: RadioErrorCode.INVALID_CONFIG,
        message: 'ICOM WLAN configuration missing required fields: icomWlan.ip, icomWlan.port',
        userMessage: 'ICOM WLAN configuration is incomplete',
        suggestions: [
          'Enter the radio IP address',
          'Enter the radio WLAN port number (default 50001)',
        ],
      });
    }

    // 保存配置
    this.currentConfig = config;
    this.defaultDataMode = config.icomWlan.dataMode ?? true;
    this.ioSessionId += 1;
    this.backgroundTasksStarted = false;
    this.lastKnownFrequency = null;
    this.resetFrequencyNullFailures();

    // 更新状态
    this.setState(RadioConnectionState.CONNECTING);

    try {
      logger.debug(`Connecting to ICOM radio: ${config.icomWlan.ip}:${config.icomWlan.port}`);
      logger.debug(`Default data mode: ${this.defaultDataMode}`);

      // 直接创建 IcomControl 实例
      this.rig = new IcomControl({
        control: {
          ip: config.icomWlan.ip,
          port: config.icomWlan.port
        },
        userName: config.icomWlan.userName || 'ICOM',
        password: config.icomWlan.password || '',
        model: 'auto',
      });

      // 设置事件监听器
      this.setupEventListeners();

      // 配置连接监控(禁用自动重连)
      this.rig.configureMonitoring({
        timeout: 8000,              // 会话超时 8 秒
        checkInterval: 1000,        // 每秒检查
        autoReconnect: false,       // 禁用自动重连
      });

      // 执行连接（带超时保护）
      const CONNECTION_TIMEOUT = 10000; // 10秒超时

      // 认证失败立即 reject，避免等待超时（密码错误时 icom-wlan-node 不会 reject connect()）
      const loginErrorPromise = new Promise<never>((_, reject) => {
        this.rig!.events.once('login', (res) => {
          if (!res.ok) {
            reject(new Error(`Login failed: ${res.errorCode}`));
          }
        });
      });

      await Promise.race([
        this.rig.connect(),
        loginErrorPromise,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('Connection timeout')),
            CONNECTION_TIMEOUT
          )
        ),
      ]);

      // 连接成功
      if (mode === 'control-only') {
        this.setState(RadioConnectionState.CONTROL_ONLY);
        logger.info('ICOM control-only link established');
      } else {
        this.setState(RadioConnectionState.CONNECTED);
        logger.info('ICOM radio connected successfully');
        this.emit('connected');
      }

    } catch (error) {
      // 连接失败，清理资源
      await this.cleanup();
      this.setState(RadioConnectionState.ERROR);

      // 转换错误
      throw this.convertError(error, 'connect');
    }
  }

  /**
   * 断开电台连接
   */
  async disconnect(reason?: string): Promise<void> {
    logger.info(`Disconnecting: ${reason || 'no reason'}`);
    this.ioSessionId += 1;
    this.backgroundTasksStarted = false;
    this.lastKnownFrequency = null;
    this.resetFrequencyNullFailures();

    // 清理资源
    await this.cleanup();

    // 更新状态
    this.setState(RadioConnectionState.DISCONNECTED);

    // 触发断开事件
    this.emit('disconnected', reason);

    logger.info('Connection disconnected');
  }

  /**
   * 设置电台频率
   */
  async setFrequency(frequency: number): Promise<void> {
    await this.runSerializedTask('setFrequency', async () => {
      await this.performFrequencyWrite(frequency);
    }, { critical: true });
  }

  /**
   * 获取当前频率
   */
  async getFrequency(): Promise<number> {
    return this.runSerializedTask('getFrequency', async () => {
      this.checkConnected();

      try {
        const freq = await this.rig!.readOperatingFrequency({ timeout: 3000 });
        if (freq !== null) {
          this.noteFrequencyReadSuccess(freq);
          return freq;
        }
        return this.handleFrequencyReadNull();
      } catch (error) {
        throw this.convertError(error, 'getFrequency');
      }
    }, { id: 'getFrequency' });
  }

  private noteFrequencyReadSuccess(frequency: number): void {
    if (Number.isFinite(frequency) && frequency > 0) {
      this.lastKnownFrequency = frequency;
    }
    this.resetFrequencyNullFailures();
  }

  private handleFrequencyReadNull(): number {
    const now = Date.now();
    if (this.firstFrequencyNullFailureAt === null) {
      this.firstFrequencyNullFailureAt = now;
    }
    this.frequencyNullFailureCount += 1;

    const failureWindowMs = now - this.firstFrequencyNullFailureAt;
    const shouldEscalate = this.frequencyNullFailureCount >= FREQUENCY_NULL_FAILURE_LIMIT
      || failureWindowMs >= FREQUENCY_NULL_FAILURE_WINDOW_MS;
    if (shouldEscalate) {
      throw new Error(
        `Get frequency returned null after ${this.frequencyNullFailureCount} attempts over ${failureWindowMs}ms`
      );
    }

    const fallbackFrequency = this.lastKnownFrequency ?? 0;
    logger.debug('ICOM WLAN frequency read returned null; using transient fallback', {
      failureCount: this.frequencyNullFailureCount,
      failureWindowMs,
      fallbackFrequency,
    });
    return fallbackFrequency;
  }

  private resetFrequencyNullFailures(): void {
    this.frequencyNullFailureCount = 0;
    this.firstFrequencyNullFailureAt = null;
  }

  /**
   * 控制 PTT
   */
  async setPTT(enabled: boolean): Promise<void> {
    await this.runSerializedTask('setPTT', async () => {
      await this.performPTTWrite(enabled);
    }, { critical: true });
  }

  supportsCWMessageKeyer(): boolean {
    const rig = this.rig as (IcomControl & {
      sendMorse?: (message: string, options?: { timeout?: number; checkMode?: boolean }) => Promise<void>;
      stopMorse?: (options?: { timeout?: number }) => Promise<void>;
    }) | null;
    const profile = this.getActiveProfile();
    return Boolean(
      rig
      && typeof rig.sendMorse === 'function'
      && typeof rig.stopMorse === 'function'
      && profile?.cw?.sendMorse === true,
    );
  }

  async sendCWMessage(message: string, wpm: number): Promise<void> {
    await this.runSerializedTask('sendCWMessage', async () => {
      this.checkConnected();
      const rig = this.rig as (IcomControl & {
        sendMorse?: (message: string, options?: { timeout?: number; checkMode?: boolean }) => Promise<void>;
        setKeySpeed?: (wpm: number) => void | Promise<void>;
      }) | null;
      if (!this.supportsCWMessageKeyer() || !rig || typeof rig.sendMorse !== 'function') {
        throw this.optionalOperationUnavailable(
          'sendCWMessage',
          'ICOM WLAN active profile does not support CW text sending',
        );
      }

      try {
        if (this.hasProfileLevel('KEYSPD') && typeof rig.setKeySpeed === 'function') {
          try {
            await rig.setKeySpeed(wpm);
          } catch (error) {
            logger.warn('Failed to set ICOM WLAN CW key speed before CAT CW send', {
              error: error instanceof Error ? error.message : String(error),
              wpm,
            });
          }
        }

        await rig.sendMorse(message, { timeout: 3000, checkMode: true });
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'sendCWMessage');
      }
    }, { critical: true });
  }

  async stopCWMessage(): Promise<void> {
    await this.runSerializedTask('stopCWMessage', async () => {
      this.checkConnected();
      const rig = this.rig as (IcomControl & {
        stopMorse?: (options?: { timeout?: number }) => Promise<void>;
      }) | null;
      if (!this.supportsCWMessageKeyer() || !rig || typeof rig.stopMorse !== 'function') {
        return;
      }

      try {
        await rig.stopMorse({ timeout: 3000 });
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'stopCWMessage');
      }
    }, { critical: true });
  }

  async getPTT(): Promise<boolean> {
    this.checkConnected();
    const result = await this.ioQueue.runLowPriority({ sessionId: this.ioSessionId, name: 'getPTT', id: 'getPTT' }, async (activeSessionId) => {
      this.ensureSession(activeSessionId);
      try {
        const state = await this.rig!.readTransceiverState({ timeout: 1000 });
        if (state === 'TX') return true;
        if (state === 'RX') return false;
        throw new Error(`ICOM PTT state unavailable: ${state ?? 'null'}`);
      } catch (error) {
        throw this.convertError(error, 'getPTT');
      }
    });

    if (result === RADIO_IO_SKIPPED) {
      throw new Error('PTT poll skipped because radio I/O is busy');
    }

    return result;
  }

  /**
   * 设置电台工作模式
   */
  async setMode(mode: string, bandwidth?: RadioModeBandwidth, options?: SetRadioModeOptions): Promise<void> {
    await this.runSerializedTask('setMode', async () => {
      await this.performModeWrite(mode, bandwidth, options);
    }, { critical: true });
  }

  async applyOperatingState(request: ApplyOperatingStateRequest): Promise<ApplyOperatingStateResult> {
    return this.runSerializedTask('applyOperatingState', async () => {
      this.checkConnected();

      let frequencyApplied = false;
      let modeApplied = false;
      let modeError: Error | undefined;

      if (request.frequency !== undefined) {
        await this.performFrequencyWrite(request.frequency);
        frequencyApplied = true;
      }

      if (request.mode) {
        try {
          await this.performModeWrite(request.mode, request.bandwidth, request.options);
          modeApplied = true;
        } catch (error) {
          if (!request.tolerateModeFailure) {
            throw error;
          }

          modeError = error instanceof Error ? error : new Error(String(error));
        }
      }

      return { frequencyApplied, modeApplied, modeError };
    }, { critical: true });
  }

  /**
   * 获取当前工作模式
   */
  async getMode(): Promise<RadioModeInfo> {
    return this.runSerializedTask('getMode', async () => {
      this.checkConnected();

      try {
        const result = await this.rig!.readOperatingMode({ timeout: 3000 });
        if (result) {
          return {
            mode: result.modeName || `Mode ${result.mode}`,
            bandwidth: result.filterName || 'Normal',
          };
        }
        throw new RadioError({
          code: RadioErrorCode.INVALID_OPERATION,
          message: 'Optional radio operation unavailable (getMode): Get mode returned null',
          userMessage: 'Radio mode read is currently unavailable',
          severity: RadioErrorSeverity.WARNING,
          suggestions: [
            'Continue using explicit frequency/mode writes',
            'Avoid relying on ICOM WLAN mode readback',
          ],
          context: {
            operation: 'getMode',
            optional: true,
            recoverable: true,
          },
        });
      } catch (error) {
        throw this.convertError(error, 'getMode');
      }
    }, { id: 'getMode' });
  }

  /**
   * 发送音频数据
   */
  async sendAudio(samples: Float32Array): Promise<void> {
    this.checkConnected();

    try {
      this.rig!.sendAudioFloat32(samples);
    } catch (error) {
      logger.error('Failed to send audio:', error);
      throw this.convertError(error, 'sendAudio');
    }
  }

  /**
   * 测试连接
   */
  async testConnection(): Promise<void> {
    await this.runSerializedTask('testConnection', async () => {
      this.checkConnected();

      try {
        const freq = await this.rig!.readOperatingFrequency({ timeout: 5000 });
        if (freq !== null) {
          logger.debug(`Connection test passed, current frequency: ${(freq / 1000000).toFixed(3)} MHz`);
        } else {
          throw new Error('Test connection failed: unable to get frequency');
        }
      } catch (error) {
        throw this.convertError(error, 'testConnection');
      }
    });
  }

  /**
   * 获取连接信息
   */
  getConnectionInfo() {
    return {
      type: this.getType(),
      state: this.getState(),
      config: {
        type: this.currentConfig?.type,
        icomWlan: this.currentConfig?.icomWlan,
      },
    };
  }

  /**
   * 获取音频采样率（ICOM WLAN 固定为 12kHz）
   */
  getAudioSampleRate(): number {
    return AUDIO_RATE; // 12000
  }

  async enableScopeStream(): Promise<void> {
    await this.runIsolatedSpectrumTask('enableScopeStream', async () => {
      this.checkConnected();
      if (this.scopeEnabled) {
        return;
      }

      await this.rig!.enableScope();
      this.scopeEnabled = true;
    }, { timeoutMs: SPECTRUM_CAT_TIMEOUT_MS });
  }

  async disableScopeStream(): Promise<void> {
    await this.runIsolatedSpectrumTask('disableScopeStream', async () => {
      if (!this.rig || !this.scopeEnabled) {
        return;
      }

      await this.rig.disableScope();
      this.scopeEnabled = false;
    }, { timeoutMs: SPECTRUM_CAT_TIMEOUT_MS });
  }

  addScopeFrameListener(listener: (frame: IcomScopeFrame) => void): void {
    super.on('scopeFrame' as any, listener as any);
  }

  removeScopeFrameListener(listener: (frame: IcomScopeFrame) => void): void {
    super.off('scopeFrame' as any, listener as any);
  }

  async getSpectrumSpans(): Promise<number[]> {
    return [
      25_000_000,
      10_000_000,
      5_000_000,
      2_500_000,
      1_000_000,
      500_000,
      250_000,
      100_000,
      50_000,
      25_000,
      10_000,
      5_000,
      2_500,
    ];
  }

  async getCurrentSpectrumSpan(): Promise<number | null> {
    return this.runIsolatedSpectrumTask('getCurrentSpectrumSpan', async () => {
      this.checkConnected();
      try {
        const info = await this.rig!.readScopeSpan();
        return typeof info?.spanHz === 'number' && Number.isFinite(info.spanHz) && info.spanHz > 0 ? info.spanHz : null;
      } catch (error) {
        throw this.convertError(error, 'getCurrentSpectrumSpan');
      }
    }, { timeoutMs: SPECTRUM_CAT_TIMEOUT_MS, skipIfBusy: true, skippedValue: null });
  }

  async setSpectrumSpan(spanHz: number): Promise<void> {
    await this.runIsolatedSpectrumTask('setSpectrumSpan', async () => {
      this.checkConnected();
      try {
        await this.rig!.setScopeSpan(spanHz);
      } catch (error) {
        throw this.convertError(error, 'setSpectrumSpan');
      }
    }, { timeoutMs: SPECTRUM_CAT_TIMEOUT_MS });
  }

  async getSpectrumDisplayState(): Promise<RadioSpectrumDisplayState | null> {
    return this.runIsolatedSpectrumTask('getSpectrumDisplayState', async () => {
      this.checkConnected();
      try {
        const state = await this.rig!.getSpectrumDisplayState();
        return {
          mode: state?.mode ?? null,
          spanHz: typeof state?.spanHz === 'number' && Number.isFinite(state.spanHz) && state.spanHz > 0 ? state.spanHz : null,
          edgeSlot: typeof state?.edgeSlot === 'number' && Number.isFinite(state.edgeSlot) ? state.edgeSlot : null,
          edgeLowHz: typeof state?.edgeLowHz === 'number' && Number.isFinite(state.edgeLowHz) ? state.edgeLowHz : null,
          edgeHighHz: typeof state?.edgeHighHz === 'number' && Number.isFinite(state.edgeHighHz) ? state.edgeHighHz : null,
          supportedSpans: Array.isArray(state?.supportedSpans)
            ? state.supportedSpans.filter((span: unknown): span is number => typeof span === 'number' && Number.isFinite(span) && span > 0)
            : [],
          supportsFixedEdges: Boolean(state?.supportsFixedEdges),
          supportsEdgeSlotSelection: Boolean(state?.supportsEdgeSlotSelection),
        };
      } catch (error) {
        throw this.convertError(error, 'getSpectrumDisplayState');
      }
    }, { timeoutMs: SPECTRUM_CAT_TIMEOUT_MS, skipIfBusy: true, skippedValue: null });
  }

  async configureSpectrumDisplay(config: {
    mode?: 'center' | 'fixed' | 'scroll-center' | 'scroll-fixed';
    spanHz?: number;
    edgeSlot?: number;
    edgeLowHz?: number;
    edgeHighHz?: number;
  }): Promise<void> {
    await this.runIsolatedSpectrumTask('configureSpectrumDisplay', async () => {
      this.checkConnected();
      try {
        await this.rig!.configureSpectrumDisplay(config);
      } catch (error) {
        throw this.convertError(error, 'configureSpectrumDisplay');
      }
    }, { timeoutMs: SPECTRUM_CAT_TIMEOUT_MS });
  }

  // ===== 天线调谐器控制 =====

  /**
   * 获取天线调谐器能力
   * ICOM 电台通常都支持内置天调
   */
  async getTunerCapabilities(): Promise<TunerCapabilities> {
    return this.runSerializedTask('getTunerCapabilities', async () => {
      const supported = this.hasProfileFunction('TUNER');
      return {
        supported,
        hasSwitch: supported,
        hasManualTune: supported,
      };
    });
  }

  /**
   * 获取电台数值表能力。
   *
   * icom-wlan-node 0.6.0 uses model-specific Hamlib-aligned calibration,
   * so ICOM WLAN can expose both percentage and estimated watts.
   */
  getMeterCapabilities(): MeterCapabilities {
    return {
      strength: true,
      swr: true,
      alc: true,
      power: ICOM_WLAN_POWER_METER_SUPPORTED,
      powerWatts: ICOM_WLAN_POWER_METER_SUPPORTED,
    };
  }

  setKnownFrequency(frequencyHz: number): void {
    if (Number.isFinite(frequencyHz) && frequencyHz > 0) {
      this.lastKnownFrequency = frequencyHz;
    }
  }

  /**
   * 获取天线调谐器状态（简化版：使用本地状态跟踪）
   */
  async getTunerStatus(): Promise<TunerStatus> {
    return this.runSerializedTask('getTunerStatus', async () => {
      this.checkConnected();
      try {
        const status = this.requireOptionalValue(
          'getTunerStatus',
          await this.rig!.readTunerStatus({ timeout: 3000 }),
        );
        this.tunerEnabled = status.state === 'ON' || status.state === 'TUNING';
        return {
          enabled: this.tunerEnabled,
          active: status.state === 'TUNING',
          status: status.state === 'TUNING' ? 'tuning' : 'idle',
        };
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'getTunerStatus');
      }
    }, { id: 'getTunerStatus' });
  }

  /**
   * 设置天线调谐器开关
   * 使用 CI-V 命令 1C 01 00/01 设置
   */
  async setTuner(enabled: boolean): Promise<void> {
    await this.runSerializedTask('setTuner', async () => {
      this.checkConnected();

      try {
        this.rig!.setTunerEnabled(enabled);
        this.tunerEnabled = enabled;
        logger.debug(`Tuner ${enabled ? 'enabled' : 'disabled'}`);
      } catch (error) {
        logger.error('Failed to set tuner:', error);
        throw this.convertOptionalOperationError(error, 'setTuner');
      }
    }, { critical: true });
  }

  /**
   * 启动手动调谐
   * 使用 CI-V 命令 1C 01 02 启动
   */
  async startTuning(): Promise<boolean> {
    return this.runSerializedTask('startTuning', async () => {
      this.checkConnected();

      try {
        this.rig!.startManualTune();
        logger.debug('Manual tuning started');
        return true;
      } catch (error) {
        logger.error('Failed to start tuning:', error);
        throw this.convertOptionalOperationError(error, 'startTuning');
      }
    }, { critical: true });
  }

  // ===== Level 类控制（AF 增益、静噪、发射功率、MIC 增益、噪声消隐、降噪） =====

  async getAFGain(): Promise<number> {
    return this.runSerializedTask('getAFGain', async () => {
      this.checkConnected();
      try {
        const reading = this.requireOptionalValue('getAFGain', await this.rig!.getAFGain({ timeout: 3000 }));
        const value = reading.normalized;
        logger.debug(`AF gain read: ${(value * 100).toFixed(0)}%`);
        return value;
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'getAFGain');
      }
    });
  }

  async setAFGain(value: number): Promise<void> {
    await this.runSerializedTask('setAFGain', async () => {
      this.checkConnected();
      try {
        this.rig!.setAFGain(value);
        logger.debug(`AF gain set: ${(value * 100).toFixed(0)}%`);
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'setAFGain');
      }
    });
  }

  async getSQL(): Promise<number> {
    return this.runSerializedTask('getSQL', async () => {
      this.checkConnected();
      try {
        const reading = this.requireOptionalValue('getSQL', await this.rig!.getSQL({ timeout: 3000 }));
        const value = reading.normalized;
        logger.debug(`SQL read: ${(value * 100).toFixed(0)}%`);
        return value;
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'getSQL');
      }
    });
  }

  async setSQL(value: number): Promise<void> {
    await this.runSerializedTask('setSQL', async () => {
      this.checkConnected();
      try {
        this.rig!.setSQL(value);
        logger.debug(`SQL set: ${(value * 100).toFixed(0)}%`);
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'setSQL');
      }
    });
  }

  async getRFPower(): Promise<number> {
    return this.runSerializedTask('getRFPower', async () => {
      this.checkConnected();
      try {
        const reading = this.requireOptionalValue('getRFPower', await this.rig!.getRFPower({ timeout: 3000 }));
        const value = reading.normalized;
        logger.debug(`RF power read: ${(value * 100).toFixed(0)}%`);
        return value;
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'getRFPower');
      }
    });
  }

  async setRFPower(value: number): Promise<void> {
    await this.runSerializedTask('setRFPower', async () => {
      this.checkConnected();
      try {
        this.rig!.setRFPower(value);
        logger.debug(`RF power set: ${(value * 100).toFixed(0)}%`);
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'setRFPower');
      }
    });
  }

  async getMicGain(): Promise<number> {
    return this.runSerializedTask('getMicGain', async () => {
      this.checkConnected();
      try {
        const reading = this.requireOptionalValue('getMicGain', await this.rig!.getMicGain({ timeout: 3000 }));
        const value = reading.normalized;
        logger.debug(`MIC gain read: ${(value * 100).toFixed(0)}%`);
        return value;
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'getMicGain');
      }
    });
  }

  async setMicGain(value: number): Promise<void> {
    await this.runSerializedTask('setMicGain', async () => {
      this.checkConnected();
      try {
        this.rig!.setMicGain(value);
        logger.debug(`MIC gain set: ${(value * 100).toFixed(0)}%`);
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'setMicGain');
      }
    });
  }

  async getNBEnabled(): Promise<boolean> {
    return this.readFunctionCapability('getNBEnabled', 'NB');
  }

  async setNBEnabled(enabled: boolean): Promise<void> {
    await this.writeFunctionCapability('setNBEnabled', 'NB', enabled);
  }

  async getNBLevel(): Promise<number> {
    return this.readLevelCapability('getNBLevel', 'NB');
  }

  async setNBLevel(value: number): Promise<void> {
    await this.writeLevelCapability('setNBLevel', 'NB', value);
  }

  async getNREnabled(): Promise<boolean> {
    return this.readFunctionCapability('getNREnabled', 'NR');
  }

  async setNREnabled(enabled: boolean): Promise<void> {
    await this.writeFunctionCapability('setNREnabled', 'NR', enabled);
  }

  async getNRLevel(): Promise<number> {
    return this.readLevelCapability('getNRLevel', 'NR');
  }

  async setNRLevel(value: number): Promise<void> {
    await this.writeLevelCapability('setNRLevel', 'NR', value);
  }

  async getCompressorEnabled(): Promise<boolean> {
    return this.readFunctionCapability('getCompressorEnabled', 'COMP');
  }

  async setCompressorEnabled(enabled: boolean): Promise<void> {
    await this.writeFunctionCapability('setCompressorEnabled', 'COMP', enabled);
  }

  async getCompressorLevel(): Promise<number> {
    return this.readLevelCapability('getCompressorLevel', 'COMP');
  }

  async setCompressorLevel(value: number): Promise<void> {
    await this.writeLevelCapability('setCompressorLevel', 'COMP', value);
  }

  async getMonitorGain(): Promise<number> {
    return this.readLevelCapability('getMonitorGain', 'MONITOR_GAIN');
  }

  async setMonitorGain(value: number): Promise<void> {
    await this.writeLevelCapability('setMonitorGain', 'MONITOR_GAIN', value);
  }

  async getMonitorEnabled(): Promise<boolean> {
    return this.readFunctionCapability('getMonitorEnabled', 'MON');
  }

  async setMonitorEnabled(enabled: boolean): Promise<void> {
    await this.writeFunctionCapability('setMonitorEnabled', 'MON', enabled);
  }

  async getApfEnabled(): Promise<boolean> {
    return this.readFunctionCapability('getApfEnabled', 'APF');
  }

  async setApfEnabled(enabled: boolean): Promise<void> {
    await this.writeFunctionCapability('setApfEnabled', 'APF', enabled);
  }

  async getApfLevel(): Promise<number> {
    return this.readLevelCapability('getApfLevel', 'APF');
  }

  async setApfLevel(value: number): Promise<void> {
    await this.writeLevelCapability('setApfLevel', 'APF', value);
  }

  async getVOXEnabled(): Promise<boolean> {
    return this.readFunctionCapability('getVOXEnabled', 'VOX');
  }

  async setVOXEnabled(enabled: boolean): Promise<void> {
    await this.writeFunctionCapability('setVOXEnabled', 'VOX', enabled);
  }

  async getLockMode(): Promise<boolean> {
    return this.readFunctionCapability('getLockMode', 'LOCK');
  }

  async setLockMode(enabled: boolean): Promise<void> {
    await this.writeFunctionCapability('setLockMode', 'LOCK', enabled);
  }

  async getAutoNotchEnabled(): Promise<boolean> {
    return this.readFunctionCapability('getAutoNotchEnabled', 'ANF');
  }

  async setAutoNotchEnabled(enabled: boolean): Promise<void> {
    await this.writeFunctionCapability('setAutoNotchEnabled', 'ANF', enabled);
  }

  async getManualNotchEnabled(): Promise<boolean> {
    return this.readFunctionCapability('getManualNotchEnabled', 'MN');
  }

  async setManualNotchEnabled(enabled: boolean): Promise<void> {
    await this.writeFunctionCapability('setManualNotchEnabled', 'MN', enabled);
  }

  async getRitEnabled(): Promise<boolean> {
    return this.readFunctionCapability('getRitEnabled', 'RIT');
  }

  async setRitEnabled(enabled: boolean): Promise<void> {
    await this.writeFunctionCapability('setRitEnabled', 'RIT', enabled);
  }

  async getXitEnabled(): Promise<boolean> {
    return this.readFunctionCapability('getXitEnabled', 'XIT');
  }

  async setXitEnabled(enabled: boolean): Promise<void> {
    await this.writeFunctionCapability('setXitEnabled', 'XIT', enabled);
  }

  async getToneEnabled(): Promise<boolean> {
    return this.readFunctionCapability('getToneEnabled', 'TONE');
  }

  async setToneEnabled(enabled: boolean): Promise<void> {
    await this.writeFunctionCapability('setToneEnabled', 'TONE', enabled);
  }

  async getToneSquelchEnabled(): Promise<boolean> {
    return this.readFunctionCapability('getToneSquelchEnabled', 'TSQL');
  }

  async setToneSquelchEnabled(enabled: boolean): Promise<void> {
    await this.writeFunctionCapability('setToneSquelchEnabled', 'TSQL', enabled);
  }

  async getBeepEnabled(): Promise<boolean> {
    return this.runSerializedTask('getBeepEnabled', async () => {
      this.checkConnected();
      try {
        const value = this.requireOptionalValue('getBeepEnabled', await this.rig!.getBeepEnabled({ timeout: 3000 }));
        return Boolean(value);
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'getBeepEnabled');
      }
    });
  }

  async setBeepEnabled(enabled: boolean): Promise<void> {
    await this.runSerializedTask('setBeepEnabled', async () => {
      this.checkConnected();
      try {
        this.rig!.setBeepEnabled(enabled);
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'setBeepEnabled');
      }
    });
  }

  async getRFGain(): Promise<number> { return this.readLevelCapability('getRFGain', 'RF'); }
  async setRFGain(value: number): Promise<void> { await this.writeLevelCapability('setRFGain', 'RF', value); }
  async getIFShift(): Promise<number> { return this.readLevelCapability('getIFShift', 'IF'); }
  async setIFShift(value: number): Promise<void> { await this.writeLevelCapability('setIFShift', 'IF', value); }
  async getPbtIn(): Promise<number> { return this.readLevelCapability('getPbtIn', 'PBT_IN'); }
  async setPbtIn(value: number): Promise<void> { await this.writeLevelCapability('setPbtIn', 'PBT_IN', value); }
  async getPbtOut(): Promise<number> { return this.readLevelCapability('getPbtOut', 'PBT_OUT'); }
  async setPbtOut(value: number): Promise<void> { await this.writeLevelCapability('setPbtOut', 'PBT_OUT', value); }
  async getCwPitch(): Promise<number> { return this.readLevelCapability('getCwPitch', 'CWPITCH'); }
  async setCwPitch(hz: number): Promise<void> { await this.writeLevelCapability('setCwPitch', 'CWPITCH', hz); }
  async getKeySpeed(): Promise<number> { return this.readLevelCapability('getKeySpeed', 'KEYSPD'); }
  async setKeySpeed(wpm: number): Promise<void> { await this.writeLevelCapability('setKeySpeed', 'KEYSPD', wpm); }
  async getNotchRaw(): Promise<number> { return this.readLevelCapability('getNotchRaw', 'NOTCHF_RAW'); }
  async setNotchRaw(value: number): Promise<void> { await this.writeLevelCapability('setNotchRaw', 'NOTCHF_RAW', value); }
  async getVoxGain(): Promise<number> { return this.readLevelCapability('getVoxGain', 'VOXGAIN'); }
  async setVoxGain(value: number): Promise<void> { await this.writeLevelCapability('setVoxGain', 'VOXGAIN', value); }
  async getAntiVox(): Promise<number> { return this.readLevelCapability('getAntiVox', 'ANTIVOX'); }
  async setAntiVox(value: number): Promise<void> { await this.writeLevelCapability('setAntiVox', 'ANTIVOX', value); }
  async getVoxDelay(): Promise<number> { return this.readLevelCapability('getVoxDelay', 'VOXDELAY'); }
  async setVoxDelay(value: number): Promise<void> { await this.writeLevelCapability('setVoxDelay', 'VOXDELAY', value); }

  async getBreakInDelay(): Promise<number> {
    return this.runSerializedTask('getBreakInDelay', async () => {
      this.checkConnected();
      try {
        const reading = this.requireOptionalValue('getBreakInDelay', await this.rig!.getBreakInDelay({ timeout: 3000 }));
        return reading.normalized;
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'getBreakInDelay');
      }
    });
  }

  async setBreakInDelay(value: number): Promise<void> {
    await this.runSerializedTask('setBreakInDelay', async () => {
      this.checkConnected();
      try {
        this.rig!.setBreakInDelay(value);
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'setBreakInDelay');
      }
    });
  }

  async getDriveGain(): Promise<number> { return this.readLevelCapability('getDriveGain', 'DRIVE_GAIN'); }
  async setDriveGain(value: number): Promise<void> { await this.writeLevelCapability('setDriveGain', 'DRIVE_GAIN', value); }
  async getAgcTime(): Promise<number> { return this.readLevelCapability('getAgcTime', 'AGC_TIME'); }
  async setAgcTime(value: number): Promise<void> { await this.writeLevelCapability('setAgcTime', 'AGC_TIME', value); }
  async getBalance(): Promise<number> { return this.readLevelCapability('getBalance', 'BALANCE'); }
  async setBalance(value: number): Promise<void> { await this.writeLevelCapability('setBalance', 'BALANCE', value); }
  async getDigiSelEnabled(): Promise<boolean> { return this.readFunctionCapability('getDigiSelEnabled', 'DIGI_SEL'); }
  async setDigiSelEnabled(enabled: boolean): Promise<void> { await this.writeFunctionCapability('setDigiSelEnabled', 'DIGI_SEL', enabled); }
  async getDigiSelLevel(): Promise<number> { return this.readLevelCapability('getDigiSelLevel', 'DIGI_SEL_LEVEL'); }
  async setDigiSelLevel(value: number): Promise<void> { await this.writeLevelCapability('setDigiSelLevel', 'DIGI_SEL_LEVEL', value); }

  async getAgcMode(): Promise<string> {
    const value = await this.readLevelCapability('getAgcMode', 'AGC');
    return ICOM_AGC_CODE_TO_MODE[Math.round(value)] ?? 'off';
  }

  async setAgcMode(mode: string): Promise<void> {
    const normalized = mode.trim().toLowerCase();
    const code = ICOM_AGC_MODE_TO_CODE[normalized];
    if (code === undefined) {
      throw this.optionalOperationUnavailable('setAgcMode', `Unsupported AGC mode: ${mode}`);
    }
    await this.writeLevelCapability('setAgcMode', 'AGC', code);
  }

  async getSupportedAgcModes(): Promise<string[]> {
    return this.hasProfileLevel('AGC') ? Object.values(ICOM_AGC_CODE_TO_MODE) : [];
  }

  async getRitOffset(): Promise<number> {
    return this.runSerializedTask('getRitOffset', async () => {
      this.checkConnected();
      try {
        return this.requireOptionalValue('getRitOffset', await this.rig!.getRitOffset({ timeout: 3000 }));
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'getRitOffset');
      }
    });
  }

  async setRitOffset(offsetHz: number): Promise<void> {
    await this.runSerializedTask('setRitOffset', async () => {
      this.checkConnected();
      try {
        this.rig!.setRitOffset(offsetHz);
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'setRitOffset');
      }
    });
  }

  async getXitOffset(): Promise<number> {
    return this.runSerializedTask('getXitOffset', async () => {
      this.checkConnected();
      try {
        return this.requireOptionalValue('getXitOffset', await this.rig!.getXitOffset({ timeout: 3000 }));
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'getXitOffset');
      }
    });
  }

  async setXitOffset(offsetHz: number): Promise<void> {
    await this.runSerializedTask('setXitOffset', async () => {
      this.checkConnected();
      try {
        this.rig!.setXitOffset(offsetHz);
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'setXitOffset');
      }
    });
  }

  async getMaxRit(): Promise<number> { return 9999; }
  async getMaxXit(): Promise<number> { return 9999; }

  async getBreakInMode(): Promise<string> {
    return this.runSerializedTask('getBreakInMode', async () => {
      this.checkConnected();
      try {
        return this.requireOptionalValue('getBreakInMode', await this.rig!.getBreakInMode({ timeout: 3000 }));
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'getBreakInMode');
      }
    });
  }

  async setBreakInMode(mode: string): Promise<void> {
    await this.runSerializedTask('setBreakInMode', async () => {
      this.checkConnected();
      const normalized = mode === 'semi' || mode === 'full' ? mode : 'off';
      try {
        this.rig!.setBreakInMode(normalized);
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'setBreakInMode');
      }
    });
  }

  async getVfo(): Promise<string> {
    return this.runSerializedTask('getVfo', async () => {
      this.checkConnected();
      try {
        return this.requireOptionalValue('getVfo', await this.rig!.getVfo({ timeout: 3000 }));
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'getVfo');
      }
    });
  }

  async setVfo(vfo: string): Promise<void> {
    await this.runSerializedTask('setVfo', async () => {
      this.checkConnected();
      try {
        this.rig!.setVfo(vfo as IcomVfoName);
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'setVfo');
      }
    }, { critical: true });
  }

  async getSupportedVfos(): Promise<string[]> {
    return this.profileList<string>('vfos');
  }

  async getSplitEnabled(): Promise<boolean> {
    return this.runSerializedTask('getSplitEnabled', async () => {
      this.checkConnected();
      try {
        return this.requireOptionalValue('getSplitEnabled', await this.rig!.getSplitEnabled({ timeout: 3000 }));
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'getSplitEnabled');
      }
    });
  }

  async setSplitEnabled(enabled: boolean): Promise<void> {
    await this.runSerializedTask('setSplitEnabled', async () => {
      this.checkConnected();
      try {
        this.rig!.setSplitEnabled(enabled);
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'setSplitEnabled');
      }
    }, { critical: true });
  }

  async getTuningStep(): Promise<number> {
    return this.runSerializedTask('getTuningStep', async () => {
      this.checkConnected();
      try {
        return this.requireOptionalValue('getTuningStep', await this.rig!.getTuningStep({ timeout: 3000 }));
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'getTuningStep');
      }
    });
  }

  async setTuningStep(stepHz: number): Promise<void> {
    await this.runSerializedTask('setTuningStep', async () => {
      this.checkConnected();
      try {
        this.rig!.setTuningStep(stepHz);
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'setTuningStep');
      }
    });
  }

  async getSupportedTuningSteps(): Promise<number[]> {
    return this.profileList<{ hz: number }>('tuningSteps')
      .map((step) => step.hz)
      .filter((step) => Number.isFinite(step) && step > 0)
      .sort((left, right) => left - right);
  }

  async getRepeaterShift(): Promise<string> {
    return this.runSerializedTask('getRepeaterShift', async () => {
      this.checkConnected();
      try {
        return this.requireOptionalValue('getRepeaterShift', await this.rig!.getRepeaterShift({ timeout: 3000 }));
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'getRepeaterShift');
      }
    });
  }

  async setRepeaterShift(shift: string): Promise<void> {
    await this.runSerializedTask('setRepeaterShift', async () => {
      this.checkConnected();
      const normalized = shift === 'minus' || shift === 'plus' ? shift : 'none';
      try {
        this.rig!.setRepeaterShift(normalized);
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'setRepeaterShift');
      }
    });
  }

  async getRepeaterOffset(): Promise<number> {
    return this.runSerializedTask('getRepeaterOffset', async () => {
      this.checkConnected();
      try {
        return this.requireOptionalValue('getRepeaterOffset', await this.rig!.getRepeaterOffset({ timeout: 3000 }));
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'getRepeaterOffset');
      }
    });
  }

  async setRepeaterOffset(offsetHz: number): Promise<void> {
    await this.runSerializedTask('setRepeaterOffset', async () => {
      this.checkConnected();
      try {
        this.rig!.setRepeaterOffset(offsetHz);
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'setRepeaterOffset');
      }
    });
  }

  async getCtcssTone(): Promise<number> {
    return this.runSerializedTask('getCtcssTone', async () => {
      this.checkConnected();
      try {
        const hz = this.requireOptionalValue('getCtcssTone', await this.rig!.getToneFrequency({ timeout: 3000 }));
        return Math.round(hz * 10);
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'getCtcssTone');
      }
    });
  }

  async setCtcssTone(tone: number): Promise<void> {
    await this.runSerializedTask('setCtcssTone', async () => {
      this.checkConnected();
      try {
        this.rig!.setToneFrequency(tone / 10);
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'setCtcssTone');
      }
    });
  }

  async getAvailableCtcssTones(): Promise<number[]> {
    return this.getActiveProfile()?.tone === false ? [] : ICOM_CTCSS_TONES_TENTHS_HZ;
  }

  async getAudioIfMode(): Promise<string> {
    return this.runSerializedTask('getAudioIfMode', async () => {
      this.checkConnected();
      try {
        return this.requireOptionalValue('getAudioIfMode', await this.rig!.getAudioIfMode({ timeout: 3000 }));
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'getAudioIfMode');
      }
    });
  }

  async setAudioIfMode(source: string): Promise<void> {
    await this.runSerializedTask('setAudioIfMode', async () => {
      this.checkConnected();
      try {
        this.rig!.setAudioIfMode(source as IcomAudioIfSource);
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'setAudioIfMode');
      }
    });
  }

  async getSupportedAudioIfModes(): Promise<string[]> {
    return this.profileList<string>('audioIfSources')
      .filter((source) => ICOM_AUDIO_IF_SOURCES.includes(source as IcomAudioIfSource));
  }

  async getSpectrumDataOutput(): Promise<boolean> {
    return this.runSerializedTask('getSpectrumDataOutput', async () => {
      this.checkConnected();
      try {
        return this.requireOptionalValue('getSpectrumDataOutput', await this.rig!.getSpectrumDataOutput({ timeout: 3000 }));
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'getSpectrumDataOutput');
      }
    });
  }

  async setSpectrumDataOutput(enabled: boolean): Promise<void> {
    await this.runSerializedTask('setSpectrumDataOutput', async () => {
      this.checkConnected();
      try {
        this.rig!.setSpectrumDataOutput(enabled);
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'setSpectrumDataOutput');
      }
    });
  }

  async getSpectrumHold(): Promise<boolean> {
    return this.runSerializedTask('getSpectrumHold', async () => {
      this.checkConnected();
      try {
        return this.requireOptionalValue('getSpectrumHold', await this.rig!.getSpectrumHold({ timeout: 3000 }));
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'getSpectrumHold');
      }
    });
  }

  async setSpectrumHold(enabled: boolean): Promise<void> {
    await this.runSerializedTask('setSpectrumHold', async () => {
      this.checkConnected();
      try {
        this.rig!.setSpectrumHold(enabled);
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'setSpectrumHold');
      }
    });
  }

  async getSpectrumSpeed(): Promise<string> {
    return this.runSerializedTask('getSpectrumSpeed', async () => {
      this.checkConnected();
      try {
        return this.requireOptionalValue('getSpectrumSpeed', await this.rig!.getSpectrumSpeed({ timeout: 3000 }));
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'getSpectrumSpeed');
      }
    });
  }

  async setSpectrumSpeed(speed: string): Promise<void> {
    await this.runSerializedTask('setSpectrumSpeed', async () => {
      this.checkConnected();
      try {
        this.rig!.setSpectrumSpeed(speed as IcomSpectrumSpeed);
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'setSpectrumSpeed');
      }
    });
  }

  async getSupportedSpectrumSpeeds(): Promise<string[]> {
    return this.hasAdvancedSpectrumControl('speed') ? ICOM_SPECTRUM_SPEEDS : [];
  }

  async getSpectrumRef(): Promise<number> {
    return this.runSerializedTask('getSpectrumRef', async () => {
      this.checkConnected();
      try {
        return this.requireOptionalValue('getSpectrumRef', await this.rig!.getSpectrumRef({ timeout: 3000 }));
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'getSpectrumRef');
      }
    });
  }

  async setSpectrumRef(db: number): Promise<void> {
    await this.runSerializedTask('setSpectrumRef', async () => {
      this.checkConnected();
      try {
        this.rig!.setSpectrumRef(db);
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'setSpectrumRef');
      }
    });
  }

  async getSpectrumAverage(): Promise<number> { return this.readLevelCapability('getSpectrumAverage', 'SPECTRUM_AVG'); }
  async setSpectrumAverage(value: number): Promise<void> { await this.writeLevelCapability('setSpectrumAverage', 'SPECTRUM_AVG', value); }

  async getSpectrumVbw(): Promise<number> {
    return this.runSerializedTask('getSpectrumVbw', async () => {
      this.checkConnected();
      try {
        return this.requireOptionalValue('getSpectrumVbw', await this.rig!.getSpectrumVbw({ timeout: 3000 }));
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'getSpectrumVbw');
      }
    });
  }

  async setSpectrumVbw(value: number): Promise<void> {
    await this.runSerializedTask('setSpectrumVbw', async () => {
      this.checkConnected();
      try {
        this.rig!.setSpectrumVbw(value);
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'setSpectrumVbw');
      }
    });
  }

  async getSpectrumRbw(): Promise<number> {
    return this.runSerializedTask('getSpectrumRbw', async () => {
      this.checkConnected();
      try {
        return this.requireOptionalValue('getSpectrumRbw', await this.rig!.getSpectrumRbw({ timeout: 3000 }));
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'getSpectrumRbw');
      }
    });
  }

  async setSpectrumRbw(value: number): Promise<void> {
    await this.runSerializedTask('setSpectrumRbw', async () => {
      this.checkConnected();
      try {
        this.rig!.setSpectrumRbw(value);
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'setSpectrumRbw');
      }
    });
  }

  async getSpectrumDuringTx(): Promise<boolean> {
    return this.runSerializedTask('getSpectrumDuringTx', async () => {
      this.checkConnected();
      try {
        return this.requireOptionalValue('getSpectrumDuringTx', await this.rig!.getSpectrumDuringTx({ timeout: 3000 }));
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'getSpectrumDuringTx');
      }
    });
  }

  async setSpectrumDuringTx(enabled: boolean): Promise<void> {
    await this.runSerializedTask('setSpectrumDuringTx', async () => {
      this.checkConnected();
      try {
        this.rig!.setSpectrumDuringTx(enabled);
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'setSpectrumDuringTx');
      }
    });
  }

  async getSpectrumCenterType(): Promise<string> {
    return this.runSerializedTask('getSpectrumCenterType', async () => {
      this.checkConnected();
      try {
        return this.requireOptionalValue('getSpectrumCenterType', await this.rig!.getSpectrumCenterType({ timeout: 3000 }));
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'getSpectrumCenterType');
      }
    });
  }

  async setSpectrumCenterType(type: string): Promise<void> {
    await this.runSerializedTask('setSpectrumCenterType', async () => {
      this.checkConnected();
      try {
        this.rig!.setSpectrumCenterType(type as IcomSpectrumCenterType);
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'setSpectrumCenterType');
      }
    });
  }

  async getSupportedSpectrumCenterTypes(): Promise<string[]> {
    return this.hasAdvancedSpectrumControl('centerType') ? ICOM_SPECTRUM_CENTER_TYPES : [];
  }

  /**
   * 设置状态并触发事件
   */
  private setState(newState: RadioConnectionState): void {
    if (this.state !== newState) {
      const oldState = this.state;
      this.state = newState;

      logger.debug(`State changed: ${oldState} -> ${newState}`);

      this.emit('stateChanged', newState);
    }
  }

  /**
   * 设置事件监听器（直接监听 icom-wlan-node 事件）
   */
  private setupEventListeners(): void {
    if (!this.rig) return;

    // 登录结果
    this.rig.events.on('login', (res) => {
      if (res.ok) {
        logger.info('ICOM login successful');
      } else {
        logger.error('ICOM login failed:', res.errorCode);
        const error = new Error(`Login failed: ${res.errorCode}`);
        this.emit('error', this.convertError(error, 'login'));
      }
    });

    // 状态信息
    this.rig.events.on('status', (s) => {
      logger.debug(`ICOM status: CIV port=${s.civPort}, audio port=${s.audioPort}`);
    });

    // 能力信息
    this.rig.events.on('capabilities', (c) => {
      this.detectedModelId = c.modelId ?? null;
      this.detectedProfileName = c.profileName ?? null;
      logger.debug(
        `ICOM capabilities: CIV address=${c.civAddress}, audio name=${c.audioName}, profile=${c.profileName ?? c.modelId ?? 'unknown'}`,
      );
    });

    // 音频数据
    this.rig.events.on('audio', (frame) => {
      // 转发音频帧给上层
      this.emit('audioFrame', frame.pcm16);
    });

    this.rig.events.on('scopeFrame', (frame) => {
      this.emit('scopeFrame' as any, frame);
    });

    // 连接丢失 → 只 emit disconnected，不直接改状态（让上层状态机管理）
    this.rig.events.on('connectionLost', (info) => {
      logger.warn(`Connection lost: ${info.sessionType}, idle ${info.timeSinceLastData}ms`);
      this.stopMeterPolling();
      this.emit('disconnected', `Connection lost: ${info.sessionType}`);
    });


    // 错误处理
    this.rig.events.on('error', (err) => {
      logger.error('ICOM UDP error:', err);
      const radioError = this.convertError(err, 'udp');
      this.emit('error', radioError);
    });
  }

  /**
   * 启动数值表轮询
   */
  private startMeterPolling(): void {
    if (this.meterPollingInterval) {
      logger.debug('Meter polling already running');
      return;
    }

    logger.debug(`Starting meter polling, interval ${this.meterPollingIntervalMs}ms`);

    this.meterPollingInterval = setInterval(() => {
      void this.pollMeters();
    }, this.meterPollingIntervalMs);
  }

  /**
   * 停止数值表轮询
   */
  private stopMeterPolling(): void {
    if (this.meterPollingInterval) {
      logger.debug('Stopping meter polling');
      clearInterval(this.meterPollingInterval);
      this.meterPollingInterval = null;
    }
  }

  /**
   * 轮询数值表数据
   */
  private async pollMeters(): Promise<void> {
    try {
      const result = await this.ioQueue.runLowPriority({ sessionId: this.ioSessionId, name: 'pollMeters', id: 'pollMeters' }, async (activeSessionId) => {
        this.ensureSession(activeSessionId);
        if (!this.rig) {
          return;
        }

        const txMetersReady = this.areTxMetersReady();
        const levelRaw = txMetersReady
          ? null
          : await this.readMeterValue('LEVEL', () => this.rig!.getLevelMeter({ timeout: 200 }));
        const swrRaw = txMetersReady
          ? await this.readMeterValue('SWR', () => this.rig!.readSWR({ timeout: 200 }))
          : null;
        const alcRaw = txMetersReady
          ? await this.readMeterValue('ALC', () => this.rig!.readALC({ timeout: 200 }))
          : null;
        const powerRaw = txMetersReady && ICOM_WLAN_POWER_METER_SUPPORTED
          ? await this.readMeterValue('POWER', () => this.rig!.readPowerLevel({ timeout: 200 }))
          : null;

        const level = levelRaw ? { ...levelRaw, displayStyle: 's-meter-dbm' as const } : null;
        const swr = swrRaw ? { ...swrRaw, swr: Math.max(1, swrRaw.swr) } : null;
        const alc = alcRaw ? { ...alcRaw, alert: alcRaw.percent >= 100 } : null;
        const power = powerRaw !== null ? {
          raw: powerRaw.raw,
          percent: powerRaw.percent,
          watts: typeof powerRaw.watts === 'number' ? powerRaw.watts : null,
          maxWatts: null,
        } : null;

        if (swr === null && alc === null && level === null && power === null) {
          return;
        }

        const meterData: MeterData = {
          swr,
          alc,
          level,
          power,
        };

        this.logMeterSample(meterData, { txMetersReady });
        this.emit('meterData', meterData);
        globalEventBus.emit('bus:meterData', meterData);
      });

      if (result === RADIO_IO_SKIPPED) {
        logger.debug('Skipping meter polling because critical or queued CAT work is in progress');
      }
    } catch (error) {
      logger.debug(`Skipping meter polling result: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async readMeterValue<T>(name: string, reader: () => Promise<T | null>): Promise<T | null> {
    try {
      return await reader();
    } catch (error) {
      logger.debug(`Meter read failed for ${name}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private areTxMetersReady(): boolean {
    return this.softwarePttActive
      && this.pttActivatedAt !== null
      && Date.now() - this.pttActivatedAt >= TX_METER_SETTLE_MS;
  }

  private logMeterSample(meterData: MeterData, context: { txMetersReady: boolean }): void {
    const now = Date.now();
    if (now - this.lastMeterSampleLoggedAt < METER_SAMPLE_LOG_INTERVAL_MS) {
      return;
    }

    this.lastMeterSampleLoggedAt = now;
    logger.debug('ICOM WLAN meter sample', {
      pttActive: this.softwarePttActive,
      txMetersReady: context.txMetersReady,
      swr: meterData.swr ? { raw: meterData.swr.raw, swr: meterData.swr.swr } : null,
      alc: meterData.alc ? { raw: meterData.alc.raw, percent: meterData.alc.percent } : null,
      power: meterData.power ? { raw: meterData.power.raw, percent: meterData.power.percent } : null,
      level: meterData.level ? { raw: meterData.level.raw, percent: meterData.level.percent, formatted: meterData.level.formatted } : null,
    });
  }

  /**
   * 检查是否已连接
   */
  private checkConnected(allow: 'connected' | 'power' = 'connected'): void {
    if (!this.rig) {
      throw new RadioError({
        code: RadioErrorCode.INVALID_STATE,
        message: `Radio not connected, current state: ${this.state}`,
        userMessage: 'Radio not connected',
        suggestions: ['Connect to radio first'],
      });
    }
    if (this.state === RadioConnectionState.CONNECTED) return;
    if (allow === 'power' && this.state === RadioConnectionState.CONTROL_ONLY) return;
    throw new RadioError({
      code: RadioErrorCode.INVALID_STATE,
      message: `Radio not connected, current state: ${this.state}`,
      userMessage: 'Radio not connected',
      suggestions: ['Connect to radio first'],
    });
  }

  /**
   * 将 control-only 链路升级为完整连接。
   * ICOM WLAN 的 control link 本身即是所需通道；升级只需更新状态 + emit 事件。
   */
  async promoteToFull(): Promise<void> {
    if (this.state !== RadioConnectionState.CONTROL_ONLY || !this.rig) {
      throw new RadioError({
        code: RadioErrorCode.INVALID_STATE,
        message: `promoteToFull called in invalid state: ${this.state}`,
        userMessage: 'Radio control link not established',
        suggestions: ['Open a control-only connection first'],
      });
    }
    // 允许电台充分启动
    await new Promise((resolve) => setTimeout(resolve, 300));
    this.setState(RadioConnectionState.CONNECTED);
    logger.info('ICOM WLAN connection promoted to full');
    this.emit('connected');
  }

  /**
   * Readiness 探针：检查 IcomControl 是否已完成 login 握手
   */
  async probeResponding(_timeoutMs = 3000): Promise<boolean> {
    if (
      !this.rig ||
      (this.state !== RadioConnectionState.CONTROL_ONLY &&
        this.state !== RadioConnectionState.CONNECTED)
    ) {
      return false;
    }
    try {
      const phase = this.rig.getConnectionPhase();
      return String(phase).toUpperCase() === 'CONNECTED';
    } catch {
      return false;
    }
  }

  /**
   * 发送电源状态（CI-V 0x18）
   * - off: 0x18 0x00
   * - on:  0x18 0x01
   */
  async setPowerState(state: string): Promise<void> {
    await this.runSerializedTask('setPowerState', async () => {
      this.checkConnected('power');
      const normalized = state.trim().toLowerCase();
      const subcodeMap: Record<string, number> = {
        off: 0x00,
        on: 0x01,
        standby: 0x00, // ICOM WLAN has no dedicated standby; treat as off
        operate: 0x01,
      };
      const subcode = subcodeMap[normalized];
      if (subcode === undefined) {
        throw new Error(`Unsupported power state: ${state}`);
      }
      try {
        const data = Buffer.from([0x18, subcode]);
        this.rig!.sendCiv(data);
        logger.debug(`ICOM WLAN power state sent: ${normalized}`);
      } catch (error) {
        throw this.convertError(error, 'setPowerState');
      }
    }, { critical: true });
  }

  /**
   * Read power state is not natively surfaced by icom-wlan-node. Return 'unknown'.
   */
  async getPowerState(): Promise<string> {
    this.checkConnected('power');
    return 'unknown';
  }

  /**
   * 清理资源
   */
  private async cleanup(): Promise<void> {
    // 防重入保护：避免重复清理导致资源泄漏或冲突
    if (this.isCleaningUp) {
      logger.debug('Cleanup already in progress, skipping');
      return;
    }

    this.isCleaningUp = true;

    try {
      // 停止数值表轮询
      this.stopMeterPolling();
      this.scopeEnabled = false;
      this.backgroundTasksStarted = false;

      // 清理 rig 实例
      if (this.rig) {
        try {
          const disconnectTimeoutMs = isProcessShuttingDown() ? 1000 : 5000;
          if (this.rig.events) {
            // 先移除所有业务监听器，防止 disconnect 过程中触发真实操作
            this.rig.events.removeAllListeners();
            // 注册持久的 error 静默处理器，吞掉 disconnect 后异步 UDP 回调的错误
            // 关闭 UDP socket 后，已排队的 send 回调仍会在事件循环中触发
            // 如果 EventEmitter 上没有 'error' 监听器，Node.js 会抛出 uncaughtException
            // 不可再次调用 removeAllListeners，否则会移除此处理器
            this.rig.events.on('error', () => {});
          }

          await Promise.race([
            this.rig.disconnect(),
            new Promise((_, reject) => {
              setTimeout(() => reject(new Error('Disconnect timeout')), disconnectTimeoutMs);
            }),
          ]);
          logger.debug('Event listeners cleared and connection closed');
        } catch (error: any) {
          logger.warn('Failed to disconnect during cleanup:', error);
        }

        this.rig = null;
      }

      this.currentConfig = null;
      this.tunerEnabled = false;
      this.detectedModelId = null;
      this.detectedProfileName = null;
      this.removeAllListeners();
    } finally {
      // 确保标志位被重置
      this.isCleaningUp = false;
    }
  }

  /**
   * 映射模式字符串到 ICOM 模式代码
   */
  private mapModeToIcom(mode: string): number {
    const modeMap: { [key: string]: number } = {
      'LSB': 0x00,
      'USB': 0x01,
      'AM': 0x02,
      'CW': 0x03,
      'RTTY': 0x04,
      'FM': 0x05,
      'WFM': 0x06,
      'CW-R': 0x07,
      'RTTY-R': 0x08,
      'DV': 0x17,
    };

    const upperMode = mode.toUpperCase();
    return modeMap[upperMode] ?? 0x01; // 默认 USB
  }

  /**
   * 将底层错误转换为 RadioError
   */
  private convertError(error: unknown, context: string): RadioError {
    // 如果已经是 RadioError，直接返回
    if (error instanceof RadioError) {
      return error;
    }

    const errorMessage =
      error instanceof Error ? error.message : String(error);
    const errorMessageLower = errorMessage.toLowerCase();

    // 连接相关错误
    if (
      errorMessageLower.includes('connection refused') ||
      errorMessageLower.includes('econnrefused')
    ) {
      return new RadioError({
        code: RadioErrorCode.CONNECTION_FAILED,
        message: `ICOM WLAN connection failed: ${errorMessage}`,
        userMessage: 'Cannot connect to ICOM radio',
        suggestions: [
          'Check if radio is powered on',
          'Verify radio WiFi is enabled',
          'Verify IP address and port are correct',
          'Try restarting the radio',
        ],
        cause: error,
        context: { operation: context },
      });
    }

    if (
      errorMessageLower.includes('timeout') ||
      errorMessageLower.includes('etimedout') ||
      errorMessageLower.includes('connection timeout')
    ) {
      return new RadioError({
        code: RadioErrorCode.CONNECTION_TIMEOUT,
        message: `ICOM WLAN connection timeout: ${errorMessage}`,
        userMessage: 'Timeout connecting to ICOM radio',
        suggestions: [
          'Check if network is functioning',
          'Verify radio and computer are on the same network',
          'Check firewall settings',
          'Try increasing timeout duration',
        ],
        cause: error,
        context: { operation: context },
      });
    }

    if (
      errorMessageLower.includes('disconnect') ||
      errorMessageLower.includes('connection lost')
    ) {
      return new RadioError({
        code: RadioErrorCode.CONNECTION_LOST,
        message: `ICOM WLAN connection disconnected: ${errorMessage}`,
        userMessage: 'ICOM radio connection disconnected',
        suggestions: [
          'Check network connection',
          'Verify radio is operating normally',
          'System will attempt automatic reconnection',
        ],
        cause: error,
        context: { operation: context },
      });
    }

    // 网络相关错误
    if (
      errorMessageLower.includes('network') ||
      errorMessageLower.includes('ehostunreach') ||
      errorMessageLower.includes('enetunreach')
    ) {
      return new RadioError({
        code: RadioErrorCode.NETWORK_ERROR,
        message: `ICOM WLAN network error: ${errorMessage}`,
        userMessage: 'Network connection error',
        suggestions: [
          'Check network settings',
          'Verify radio and computer are on the same network',
          'Try restarting the router',
        ],
        cause: error,
        context: { operation: context },
      });
    }

    // 登录/认证错误
    if (errorMessageLower.includes('login') || errorMessageLower.includes('auth')) {
      return new RadioError({
        code: RadioErrorCode.AUTH_FAILED,
        message: `ICOM WLAN authentication failed: ${errorMessage}`,
        userMessage: 'ICOM radio authentication failed, please check username and password',
        suggestions: [
          'Verify username and password are correct',
          'Check radio user management settings',
        ],
        cause: error,
        context: { operation: context },
      });
    }

    // 操作超时
    if (
      errorMessageLower.includes('operation') &&
      errorMessageLower.includes('timeout')
    ) {
      return new RadioError({
        code: RadioErrorCode.OPERATION_TIMEOUT,
        message: `Operation timeout: ${errorMessage}`,
        userMessage: 'Radio operation timed out',
        suggestions: [
          'Check radio connection status',
          'Try executing the operation again',
        ],
        cause: error,
        context: { operation: context },
      });
    }

    // 未知错误
    return new RadioError({
      code: RadioErrorCode.UNKNOWN_ERROR,
      message: `ICOM WLAN unknown error (${context}): ${errorMessage}`,
      userMessage: 'ICOM radio operation failed',
      suggestions: [
        'Please check detailed error information',
        'Try reconnecting to the radio',
        'If problem persists, contact technical support',
      ],
      cause: error,
      context: { operation: context },
    });
  }
}
