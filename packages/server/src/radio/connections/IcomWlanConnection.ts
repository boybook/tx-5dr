/* eslint-disable @typescript-eslint/no-explicit-any */
// IcomWlanConnection - 二进制协议处理需要使用any

/**
 * IcomWlanConnection - ICOM WLAN 连接实现
 *
 * 直接封装 icom-wlan-node 库，实现统一的 IRadioConnection 接口
 * 移除 IcomWlanManager 中间层，减少代码冗余
 */

import { EventEmitter } from 'eventemitter3';
import { IcomControl, AUDIO_RATE, type IcomScopeFrame } from 'icom-wlan-node';
import type { MeterCapabilities } from '@tx5dr/contracts';
import { TunerCapabilities, TunerStatus } from '@tx5dr/contracts';
import { RadioError, RadioErrorCode } from '../../utils/errors/RadioError.js';
import { globalEventBus } from '../../utils/EventBus.js';
import { createLogger } from '../../utils/logger.js';
import { isProcessShuttingDown } from '../../utils/process-shutdown.js';
import { RADIO_IO_SKIPPED, RadioIoQueue } from './RadioIoQueue.js';
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

/**
 * IcomWlanConnection 实现类
 */
export class IcomWlanConnection
  extends EventEmitter<IRadioConnectionEvents>
  implements IRadioConnection
{
  private readonly ioQueue = new RadioIoQueue();
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
    options?: { critical?: boolean },
  ): Promise<T> {
    const sessionId = this.ioSessionId;
    return this.ioQueue.run({ sessionId, critical: options?.critical }, async (activeSessionId) => {
      this.ensureSession(activeSessionId);
      const result = await task();
      this.ensureSession(activeSessionId);
      return result;
    });
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

  private async performModeWrite(mode: string, bandwidth?: RadioModeBandwidth): Promise<void> {
    this.checkConnected();

    try {
      if (typeof bandwidth === 'number') {
        throw new Error('ICOM WLAN setMode does not support numeric passband widths');
      }

      const dataMode = bandwidth === 'wide'
        ? true
        : bandwidth === 'narrow'
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
   */
  async connect(config: RadioConnectionConfig): Promise<void> {
    // 状态检查
    if (this.state === RadioConnectionState.CONNECTING) {
      throw RadioError.invalidState(
        'connect',
        this.state,
        RadioConnectionState.DISCONNECTED
      );
    }

    // 如果已连接，先断开
    if (this.state === RadioConnectionState.CONNECTED && this.rig) {
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
      this.setState(RadioConnectionState.CONNECTED);
      logger.info('ICOM radio connected successfully');

      // 触发连接成功事件
      this.emit('connected');

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
          return freq;
        }
        throw new Error('Get frequency returned null');
      } catch (error) {
        throw this.convertError(error, 'getFrequency');
      }
    });
  }

  /**
   * 控制 PTT
   */
  async setPTT(enabled: boolean): Promise<void> {
    await this.runSerializedTask('setPTT', async () => {
      await this.performPTTWrite(enabled);
    }, { critical: true });
  }

  /**
   * 设置电台工作模式
   */
  async setMode(mode: string, bandwidth?: RadioModeBandwidth, _options?: SetRadioModeOptions): Promise<void> {
    await this.runSerializedTask('setMode', async () => {
      await this.performModeWrite(mode, bandwidth);
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
          await this.performModeWrite(request.mode, request.bandwidth);
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
        throw new Error('Get mode returned null');
      } catch (error) {
        throw this.convertError(error, 'getMode');
      }
    });
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
    await this.runSerializedTask('enableScopeStream', async () => {
      this.checkConnected();
      if (this.scopeEnabled) {
        return;
      }

      await this.rig!.enableScope();
      this.scopeEnabled = true;
    });
  }

  async disableScopeStream(): Promise<void> {
    await this.runSerializedTask('disableScopeStream', async () => {
      if (!this.rig || !this.scopeEnabled) {
        return;
      }

      await this.rig.disableScope();
      this.scopeEnabled = false;
    });
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
    return this.runSerializedTask('getCurrentSpectrumSpan', async () => {
      this.checkConnected();
      try {
        const info = await this.rig!.readScopeSpan();
        return typeof info?.spanHz === 'number' && Number.isFinite(info.spanHz) && info.spanHz > 0 ? info.spanHz : null;
      } catch (error) {
        throw this.convertError(error, 'getCurrentSpectrumSpan');
      }
    });
  }

  async setSpectrumSpan(spanHz: number): Promise<void> {
    await this.runSerializedTask('setSpectrumSpan', async () => {
      this.checkConnected();
      try {
        await this.rig!.setScopeSpan(spanHz);
      } catch (error) {
        throw this.convertError(error, 'setSpectrumSpan');
      }
    });
  }

  async getSpectrumDisplayState(): Promise<RadioSpectrumDisplayState | null> {
    return this.runSerializedTask('getSpectrumDisplayState', async () => {
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
    });
  }

  async configureSpectrumDisplay(config: {
    mode?: 'center' | 'fixed' | 'scroll-center' | 'scroll-fixed';
    spanHz?: number;
    edgeSlot?: number;
    edgeLowHz?: number;
    edgeHighHz?: number;
  }): Promise<void> {
    await this.runSerializedTask('configureSpectrumDisplay', async () => {
      this.checkConnected();
      try {
        await this.rig!.configureSpectrumDisplay(config);
      } catch (error) {
        throw this.convertError(error, 'configureSpectrumDisplay');
      }
    });
  }

  // ===== 天线调谐器控制 =====

  /**
   * 获取天线调谐器能力
   * ICOM 电台通常都支持内置天调
   */
  async getTunerCapabilities(): Promise<TunerCapabilities> {
    return this.runSerializedTask('getTunerCapabilities', async () => ({
      supported: true,
      hasSwitch: true,
      hasManualTune: true,
    }));
  }

  /**
   * 获取电台数值表能力
   * ICOM WLAN 始终支持全部数值表
   */
  getMeterCapabilities(): MeterCapabilities {
    return {
      strength: true,
      swr: true,
      alc: true,
      power: true,
      powerWatts: false,
    };
  }

  setKnownFrequency(_frequencyHz: number): void {
    // icom-wlan-node handles frequency-aware S-meter calibration internally
  }

  /**
   * 获取天线调谐器状态（简化版：使用本地状态跟踪）
   */
  async getTunerStatus(): Promise<TunerStatus> {
    return this.runSerializedTask('getTunerStatus', async () => ({
      enabled: this.tunerEnabled,
      active: false,
      status: 'idle',
    }));
  }

  /**
   * 设置天线调谐器开关
   * 使用 CI-V 命令 1C 01 00/01 设置
   */
  async setTuner(enabled: boolean): Promise<void> {
    await this.runSerializedTask('setTuner', async () => {
      this.checkConnected();

      try {
        // CI-V: 1C 01 <00/01>
        const data = Buffer.from([0x1C, 0x01, enabled ? 0x01 : 0x00]);
        this.rig!.sendCiv(data);

        // 更新本地状态
        this.tunerEnabled = enabled;
        logger.debug(`Tuner ${enabled ? 'enabled' : 'disabled'}`);
      } catch (error) {
        logger.error('Failed to set tuner:', error);
        throw this.convertError(error, 'setTuner');
      }
    });
  }

  /**
   * 启动手动调谐
   * 使用 CI-V 命令 1C 01 02 启动
   */
  async startTuning(): Promise<boolean> {
    return this.runSerializedTask('startTuning', async () => {
      this.checkConnected();

      try {
        // CI-V: 1C 01 02
        const data = Buffer.from([0x1C, 0x01, 0x02]);
        this.rig!.sendCiv(data);
        logger.debug('Manual tuning started');
        return true;
      } catch (error) {
        logger.error('Failed to start tuning:', error);
        return false;
      }
    });
  }

  // ===== Level 类控制（AF 增益、静噪、发射功率、MIC 增益、噪声消隐、降噪） =====

  async getAFGain(): Promise<number> {
    return this.runSerializedTask('getAFGain', async () => {
      this.checkConnected();
      try {
        const reading = await this.rig!.getAFGain({ timeout: 3000 });
        const value = reading?.normalized ?? 0;
        logger.debug(`AF gain read: ${(value * 100).toFixed(0)}%`);
        return value;
      } catch (error) {
        throw this.convertError(error, 'getAFGain');
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
        throw this.convertError(error, 'setAFGain');
      }
    });
  }

  async getSQL(): Promise<number> {
    return this.runSerializedTask('getSQL', async () => {
      this.checkConnected();
      try {
        const reading = await this.rig!.getSQL({ timeout: 3000 });
        const value = reading?.normalized ?? 0;
        logger.debug(`SQL read: ${(value * 100).toFixed(0)}%`);
        return value;
      } catch (error) {
        throw this.convertError(error, 'getSQL');
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
        throw this.convertError(error, 'setSQL');
      }
    });
  }

  async getRFPower(): Promise<number> {
    return this.runSerializedTask('getRFPower', async () => {
      this.checkConnected();
      try {
        const reading = await this.rig!.getRFPower({ timeout: 3000 });
        const value = reading?.normalized ?? 0;
        logger.debug(`RF power read: ${(value * 100).toFixed(0)}%`);
        return value;
      } catch (error) {
        throw this.convertError(error, 'getRFPower');
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
        throw this.convertError(error, 'setRFPower');
      }
    });
  }

  async getMicGain(): Promise<number> {
    return this.runSerializedTask('getMicGain', async () => {
      this.checkConnected();
      try {
        const reading = await this.rig!.getMicGain({ timeout: 3000 });
        const value = reading?.normalized ?? 0;
        logger.debug(`MIC gain read: ${(value * 100).toFixed(0)}%`);
        return value;
      } catch (error) {
        throw this.convertError(error, 'getMicGain');
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
        throw this.convertError(error, 'setMicGain');
      }
    });
  }

  async getNBEnabled(): Promise<number> {
    return this.runSerializedTask('getNBEnabled', async () => {
      this.checkConnected();
      try {
        const reading = await this.rig!.getNBLevel({ timeout: 3000 });
        const value = reading?.normalized ?? 0;
        logger.debug(`NB level read: ${(value * 100).toFixed(0)}%`);
        return value;
      } catch (error) {
        throw this.convertError(error, 'getNBEnabled');
      }
    });
  }

  async setNBEnabled(value: number): Promise<void> {
    await this.runSerializedTask('setNBEnabled', async () => {
      this.checkConnected();
      try {
        this.rig!.setNBLevel(value);
        logger.debug(`NB level set: ${(value * 100).toFixed(0)}%`);
      } catch (error) {
        throw this.convertError(error, 'setNBEnabled');
      }
    });
  }

  async getNREnabled(): Promise<number> {
    return this.runSerializedTask('getNREnabled', async () => {
      this.checkConnected();
      try {
        const reading = await this.rig!.getNRLevel({ timeout: 3000 });
        const value = reading?.normalized ?? 0;
        logger.debug(`NR level read: ${(value * 100).toFixed(0)}%`);
        return value;
      } catch (error) {
        throw this.convertError(error, 'getNREnabled');
      }
    });
  }

  async setNREnabled(value: number): Promise<void> {
    await this.runSerializedTask('setNREnabled', async () => {
      this.checkConnected();
      try {
        this.rig!.setNRLevel(value);
        logger.debug(`NR level set: ${(value * 100).toFixed(0)}%`);
      } catch (error) {
        throw this.convertError(error, 'setNREnabled');
      }
    });
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
      logger.debug(`ICOM capabilities: CIV address=${c.civAddress}, audio name=${c.audioName}`);
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
      const result = await this.ioQueue.runLowPriority({ sessionId: this.ioSessionId }, async (activeSessionId) => {
        this.ensureSession(activeSessionId);
        if (!this.rig) {
          return;
        }

        const swr = await this.readMeterValue('SWR', () => this.rig!.readSWR({ timeout: 200 }));
        const alcRaw = await this.readMeterValue('ALC', () => this.rig!.readALC({ timeout: 200 }));
        const levelRaw = await this.readMeterValue('LEVEL', () => this.rig!.getLevelMeter({ timeout: 200 }));
        const power = await this.readMeterValue('POWER', () => this.rig!.readPowerLevel({ timeout: 200 }));
        const level = levelRaw ? { ...levelRaw, displayStyle: 's-meter-dbm' as const } : null;

        const alc = alcRaw ? { ...alcRaw, alert: alcRaw.percent >= 100 } : null;

        if (swr === null && alc === null && level === null && power === null) {
          return;
        }

        const meterData: MeterData = {
          swr,
          alc,
          level,
          power: power !== null ? { ...power, watts: null, maxWatts: null } : null,
        };

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

  /**
   * 检查是否已连接
   */
  private checkConnected(): void {
    if (!this.rig || this.state !== RadioConnectionState.CONNECTED) {
      throw new RadioError({
        code: RadioErrorCode.INVALID_STATE,
        message: `Radio not connected, current state: ${this.state}`,
        userMessage: 'Radio not connected',
        suggestions: ['Connect to radio first'],
      });
    }
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
