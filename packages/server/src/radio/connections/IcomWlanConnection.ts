/* eslint-disable @typescript-eslint/no-explicit-any */
// IcomWlanConnection - 二进制协议处理需要使用any

/**
 * IcomWlanConnection - ICOM WLAN 连接实现
 *
 * 直接封装 icom-wlan-node 库，实现统一的 IRadioConnection 接口
 * 移除 IcomWlanManager 中间层，减少代码冗余
 */

import { EventEmitter } from 'eventemitter3';
import { IcomControl, AUDIO_RATE } from 'icom-wlan-node';
import type { MeterCapabilities } from '@tx5dr/contracts';
import { TunerCapabilities, TunerStatus } from '@tx5dr/contracts';
import { RadioError, RadioErrorCode } from '../../utils/errors/RadioError.js';
import { globalEventBus } from '../../utils/EventBus.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('IcomWlanConnection');
import {
  RadioConnectionType,
  RadioConnectionState,
  type IRadioConnection,
  type IRadioConnectionEvents,
  type RadioConnectionConfig,
  type MeterData,
} from './IRadioConnection.js';

/**
 * IcomWlanConnection 实现类
 */
export class IcomWlanConnection
  extends EventEmitter<IRadioConnectionEvents>
  implements IRadioConnection
{
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
   * 数值表轮询连续失败计数（用于断线检测）
   */
  private meterPollFailCount = 0;
  private readonly METER_POLL_FAIL_THRESHOLD = 3;

  /**
   * 天调启用状态（本地跟踪，简化版实现）
   */
  private tunerEnabled = false;

  constructor() {
    super();
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

      await Promise.race([
        this.rig.connect(),
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

      // 启动数值表轮询
      this.startMeterPolling();

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
    this.checkConnected();

    try {
      await this.rig!.setFrequency(frequency);
      logger.debug(`Frequency set: ${(frequency / 1000000).toFixed(3)} MHz`);
    } catch (error) {
      throw this.convertError(error, 'setFrequency');
    }
  }

  /**
   * 获取当前频率
   */
  async getFrequency(): Promise<number> {
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
  }

  /**
   * 控制 PTT
   */
  async setPTT(enabled: boolean): Promise<void> {
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
   * 设置电台工作模式
   */
  async setMode(mode: string, bandwidth?: 'narrow' | 'wide'): Promise<void> {
    this.checkConnected();

    try {
      // 将 bandwidth 转换为 dataMode
      // 如果指定了 bandwidth，使用 bandwidth 映射
      // 否则使用配置的默认 dataMode
      const dataMode = bandwidth !== undefined
        ? bandwidth === 'wide'
        : this.defaultDataMode;

      // 将模式字符串映射到 ICOM 模式代码
      const modeCode = this.mapModeToIcom(mode);
      await this.rig!.setMode(modeCode, { dataMode });

      logger.debug(`Mode set: ${mode}${dataMode ? ' (Data)' : ''}`);
    } catch (error) {
      throw this.convertError(error, 'setMode');
    }
  }

  /**
   * 获取当前工作模式
   */
  async getMode(): Promise<{ mode: string; bandwidth: string }> {
    this.checkConnected();

    try {
      const result = await this.rig!.readOperatingMode({ timeout: 3000 });
      if (result) {
        return {
          mode: result.modeName || `Mode ${result.mode}`,
          bandwidth: result.filterName || 'Normal'
        };
      }
      throw new Error('Get mode returned null');
    } catch (error) {
      throw this.convertError(error, 'getMode');
    }
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

  // ===== 天线调谐器控制 =====

  /**
   * 获取天线调谐器能力
   * ICOM 电台通常都支持内置天调
   */
  async getTunerCapabilities(): Promise<TunerCapabilities> {
    return {
      supported: true,
      hasSwitch: true,
      hasManualTune: true,
    };
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
    return {
      enabled: this.tunerEnabled,
      active: false,
      status: 'idle',
    };
  }

  /**
   * 设置天线调谐器开关
   * 使用 CI-V 命令 1C 01 00/01 设置
   */
  async setTuner(enabled: boolean): Promise<void> {
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
  }

  /**
   * 启动手动调谐
   * 使用 CI-V 命令 1C 01 02 启动
   */
  async startTuning(): Promise<boolean> {
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

    this.meterPollingInterval = setInterval(async () => {
      await this.pollMeters();
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
    if (!this.rig) return;

    try {
      // 并行读取四个数值表
      const [swr, alcRaw, level, power] = await Promise.all([
        this.rig.readSWR({ timeout: 200 }).catch(() => null),
        this.rig.readALC({ timeout: 200 }).catch(() => null),
        this.rig.getLevelMeter({ timeout: 200 }).catch(() => null),
        this.rig.readPowerLevel({ timeout: 200 }).catch(() => null),
      ]);
      // Override alert: align with Hamlib semantics (true only at >= 100%)
      const alc = alcRaw ? { ...alcRaw, alert: alcRaw.percent >= 100 } : null;

      // 检查是否所有读取都失败
      const allFailed = swr === null && alc === null && level === null && power === null;

      if (allFailed) {
        this.meterPollFailCount++;
        if (this.meterPollFailCount >= this.METER_POLL_FAIL_THRESHOLD) {
          logger.warn(`Meter polling failed ${this.meterPollFailCount} times consecutively, connection lost`);
          this.stopMeterPolling();
          this.emit('error', new Error(`Radio communication failed ${this.meterPollFailCount} consecutive times`));
          return;
        }
      } else {
        // 有任一成功，重置计数
        this.meterPollFailCount = 0;
      }

      const meterData: MeterData = {
        swr,
        alc,
        level,
        power: power !== null ? { ...power, watts: null } : null,
      };

      // 📝 EventBus 优化：双路径策略
      // 原路径：用于 DigitalRadioEngine 健康检查
      this.emit('meterData', meterData);

      // EventBus 直达：用于 WebSocket 广播到前端
      globalEventBus.emit('bus:meterData', meterData);
    } catch (error) {
      // Promise.all 本身抛异常（不应发生，因为内部都有 catch）
      this.meterPollFailCount++;
      if (this.meterPollFailCount >= this.METER_POLL_FAIL_THRESHOLD) {
        logger.warn(`Meter polling exception failed ${this.meterPollFailCount} times, connection lost`);
        this.stopMeterPolling();
        this.emit('error', new Error(`Radio communication failed ${this.meterPollFailCount} consecutive times`));
      }
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

      // 清理 rig 实例
      if (this.rig) {
        try {
          if (this.rig.events) {
            // 先移除所有业务监听器，防止 disconnect 过程中触发真实操作
            this.rig.events.removeAllListeners();
            // 注册持久的 error 静默处理器，吞掉 disconnect 后异步 UDP 回调的错误
            // 关闭 UDP socket 后，已排队的 send 回调仍会在事件循环中触发
            // 如果 EventEmitter 上没有 'error' 监听器，Node.js 会抛出 uncaughtException
            // 不可再次调用 removeAllListeners，否则会移除此处理器
            this.rig.events.on('error', () => {});
          }

          await this.rig.disconnect();
          logger.debug('Event listeners cleared and connection closed');
        } catch (error: any) {
          logger.warn('Failed to disconnect during cleanup:', error);
        }

        this.rig = null;
      }

      this.currentConfig = null;
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

    // 登录错误
    if (errorMessageLower.includes('login') || errorMessageLower.includes('auth')) {
      return new RadioError({
        code: RadioErrorCode.INVALID_CONFIG,
        message: `ICOM WLAN login failed: ${errorMessage}`,
        userMessage: 'ICOM radio login failed',
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
