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
import { TunerCapabilities, TunerStatus } from '@tx5dr/contracts';
import { RadioError, RadioErrorCode } from '../../utils/errors/RadioError.js';
import { globalEventBus } from '../../utils/EventBus.js';
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
      await this.disconnect('重新连接');
    }

    // 验证配置
    if (config.type !== 'icom-wlan') {
      throw new RadioError({
        code: RadioErrorCode.INVALID_CONFIG,
        message: `配置类型错误: 期望 'icom-wlan'，实际 '${config.type}'`,
        userMessage: '电台配置类型不正确',
        suggestions: ['请检查配置文件中的连接类型设置'],
      });
    }

    if (!config.icomWlan || !config.icomWlan.ip || !config.icomWlan.port) {
      throw new RadioError({
        code: RadioErrorCode.INVALID_CONFIG,
        message: 'ICOM WLAN 配置缺少必需参数: icomWlan.ip, icomWlan.port',
        userMessage: 'ICOM WLAN 配置不完整',
        suggestions: [
          '请填写电台的 IP 地址',
          '请填写电台的 WLAN 端口号（默认50001）',
        ],
      });
    }

    // 保存配置
    this.currentConfig = config;
    this.defaultDataMode = config.icomWlan.dataMode ?? true;

    // 更新状态
    this.setState(RadioConnectionState.CONNECTING);

    try {
      console.log(`📡 [IcomWlanConnection] 连接到 ICOM 电台: ${config.icomWlan.ip}:${config.icomWlan.port}`);
      console.log(`📡 [IcomWlanConnection] 数据模式默认值: ${this.defaultDataMode}`);

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
            () => reject(new Error('连接超时')),
            CONNECTION_TIMEOUT
          )
        ),
      ]);

      // 连接成功
      this.setState(RadioConnectionState.CONNECTED);
      console.log(`✅ [IcomWlanConnection] ICOM 电台连接成功`);

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
    console.log(`🔌 [IcomWlanConnection] 断开连接: ${reason || '无原因'}`);

    // 清理资源
    await this.cleanup();

    // 更新状态
    this.setState(RadioConnectionState.DISCONNECTED);

    // 触发断开事件
    this.emit('disconnected', reason);

    console.log(`✅ [IcomWlanConnection] 连接已断开`);
  }

  /**
   * 设置电台频率
   */
  async setFrequency(frequency: number): Promise<void> {
    this.checkConnected();

    try {
      await this.rig!.setFrequency(frequency);
      console.log(`🔊 [IcomWlanConnection] 频率设置成功: ${(frequency / 1000000).toFixed(3)} MHz`);
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
      throw new Error('获取频率返回 null');
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
      console.log(`📡 [IcomWlanConnection] PTT ${enabled ? '启动发射' : '停止发射'}`);
      await this.rig!.setPtt(enabled);
      console.log(`✅ [IcomWlanConnection] PTT ${enabled ? '已启动' : '已停止'}`);
    } catch (error) {
      throw RadioError.pttActivationFailed(
        `PTT ${enabled ? '启动' : '停止'}失败`,
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

      console.log(`📻 [IcomWlanConnection] 模式设置成功: ${mode}${dataMode ? ' (Data)' : ''}`);
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
      throw new Error('获取模式返回 null');
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
      console.error('❌ [IcomWlanConnection] 发送音频失败:', error);
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
        console.log(`✅ [IcomWlanConnection] 连接测试成功，当前频率: ${(freq / 1000000).toFixed(3)} MHz`);
      } else {
        throw new Error('测试连接失败：无法获取频率');
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
      console.log(`✅ [IcomWlanConnection] 天调已${enabled ? '启用' : '禁用'}`);
    } catch (error) {
      console.error('❌ [IcomWlanConnection] 设置天调失败:', error);
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
      console.log('✅ [IcomWlanConnection] 手动调谐已启动');
      return true;
    } catch (error) {
      console.error('❌ [IcomWlanConnection] 启动调谐失败:', error);
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

      console.log(
        `🔄 [IcomWlanConnection] 状态变化: ${oldState} -> ${newState}`
      );

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
        console.log('✅ [IcomWlanConnection] ICOM 登录成功');
      } else {
        console.error('❌ [IcomWlanConnection] ICOM 登录失败:', res.errorCode);
        const error = new Error(`ICOM 登录失败: ${res.errorCode}`);
        this.emit('error', this.convertError(error, 'login'));
      }
    });

    // 状态信息
    this.rig.events.on('status', (s) => {
      console.log(`📊 [IcomWlanConnection] ICOM 状态: CIV端口=${s.civPort}, 音频端口=${s.audioPort}`);
    });

    // 能力信息
    this.rig.events.on('capabilities', (c) => {
      console.log(`📋 [IcomWlanConnection] ICOM 能力: CIV地址=${c.civAddress}, 音频名称=${c.audioName}`);
    });

    // 音频数据
    this.rig.events.on('audio', (frame) => {
      // 转发音频帧给上层
      this.emit('audioFrame', frame.pcm16);
    });

    // 连接丢失（库的自动重连会处理）
    this.rig.events.on('connectionLost', (info) => {
      console.warn(`🔌 [IcomWlanConnection] 连接丢失: ${info.sessionType}, 空闲 ${info.timeSinceLastData}ms`);
      this.setState(RadioConnectionState.DISCONNECTED);
      this.emit('disconnected', `连接丢失: ${info.sessionType}`);
    });


    // 错误处理
    this.rig.events.on('error', (err) => {
      console.error('❌ [IcomWlanConnection] ICOM UDP 错误:', err);
      const radioError = this.convertError(err, 'udp');
      this.emit('error', radioError);
    });
  }

  /**
   * 启动数值表轮询
   */
  private startMeterPolling(): void {
    if (this.meterPollingInterval) {
      console.log('⚠️ [IcomWlanConnection] 数值表轮询已在运行');
      return;
    }

    console.log(`📊 [IcomWlanConnection] 启动数值表轮询，间隔 ${this.meterPollingIntervalMs}ms`);

    this.meterPollingInterval = setInterval(async () => {
      await this.pollMeters();
    }, this.meterPollingIntervalMs);
  }

  /**
   * 停止数值表轮询
   */
  private stopMeterPolling(): void {
    if (this.meterPollingInterval) {
      console.log('🛑 [IcomWlanConnection] 停止数值表轮询');
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
      const [swr, alc, level, power] = await Promise.all([
        this.rig.readSWR({ timeout: 200 }).catch(() => null),
        this.rig.readALC({ timeout: 200 }).catch(() => null),
        this.rig.getLevelMeter({ timeout: 200 }).catch(() => null),
        this.rig.readPowerLevel({ timeout: 200 }).catch(() => null),
      ]);

      const meterData: MeterData = {
        swr,
        alc,
        level,
        power,
      };

      // 📝 EventBus 优化：双路径策略
      // 原路径：用于 DigitalRadioEngine 健康检查
      this.emit('meterData', meterData);

      // EventBus 直达：用于 WebSocket 广播到前端
      globalEventBus.emit('bus:meterData', meterData);
    } catch (error) {
      // 静默失败，避免日志过多
    }
  }

  /**
   * 检查是否已连接
   */
  private checkConnected(): void {
    if (!this.rig || this.state !== RadioConnectionState.CONNECTED) {
      throw new RadioError({
        code: RadioErrorCode.INVALID_STATE,
        message: `电台未连接，当前状态: ${this.state}`,
        userMessage: '电台未连接',
        suggestions: ['请先连接电台'],
      });
    }
  }

  /**
   * 清理资源
   */
  private async cleanup(): Promise<void> {
    // 防重入保护：避免重复清理导致资源泄漏或冲突
    if (this.isCleaningUp) {
      console.log('⚠️ [IcomWlanConnection] cleanup 已在进行中，跳过');
      return;
    }

    this.isCleaningUp = true;

    try {
      // 停止数值表轮询
      this.stopMeterPolling();

      // 清理 rig 实例
      if (this.rig) {
        try {
          // 移除所有事件监听器，防止异步事件触发错误
          if (this.rig.events) {
            this.rig.events.removeAllListeners();
            console.log('🔕 [IcomWlanConnection] 已移除所有事件监听器');
          }

          await this.rig.disconnect();
        } catch (error: any) {
          console.warn('⚠️ [IcomWlanConnection] 清理时断开连接失败:', error);
        }

        this.rig = null;
      }

      this.currentConfig = null;
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
        message: `ICOM WLAN 连接失败: ${errorMessage}`,
        userMessage: '无法连接到 ICOM 电台',
        suggestions: [
          '检查电台是否开机',
          '检查电台的 WiFi 是否已启用',
          '检查 IP 地址和端口是否正确',
          '尝试重启电台',
        ],
        cause: error,
        context: { operation: context },
      });
    }

    if (
      errorMessageLower.includes('timeout') ||
      errorMessageLower.includes('etimedout') ||
      errorMessageLower.includes('连接超时')
    ) {
      return new RadioError({
        code: RadioErrorCode.CONNECTION_TIMEOUT,
        message: `ICOM WLAN 连接超时: ${errorMessage}`,
        userMessage: '连接 ICOM 电台超时',
        suggestions: [
          '检查网络连接是否正常',
          '检查电台和电脑是否在同一网络',
          '检查防火墙设置',
          '尝试增加超时时间',
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
        message: `ICOM WLAN 连接断开: ${errorMessage}`,
        userMessage: 'ICOM 电台连接已断开',
        suggestions: [
          '检查网络连接',
          '检查电台是否正常运行',
          '系统将自动尝试重连',
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
        message: `ICOM WLAN 网络错误: ${errorMessage}`,
        userMessage: '网络连接错误',
        suggestions: [
          '检查网络设置',
          '检查电台和电脑是否在同一网络',
          '尝试重启路由器',
        ],
        cause: error,
        context: { operation: context },
      });
    }

    // 登录错误
    if (errorMessageLower.includes('login') || errorMessageLower.includes('auth')) {
      return new RadioError({
        code: RadioErrorCode.INVALID_CONFIG,
        message: `ICOM WLAN 登录失败: ${errorMessage}`,
        userMessage: 'ICOM 电台登录失败',
        suggestions: [
          '检查用户名和密码是否正确',
          '检查电台的用户管理设置',
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
        message: `操作超时: ${errorMessage}`,
        userMessage: '电台操作超时',
        suggestions: [
          '检查电台连接状态',
          '尝试重新执行操作',
        ],
        cause: error,
        context: { operation: context },
      });
    }

    // 未知错误
    return new RadioError({
      code: RadioErrorCode.UNKNOWN_ERROR,
      message: `ICOM WLAN 未知错误 (${context}): ${errorMessage}`,
      userMessage: 'ICOM 电台操作失败',
      suggestions: [
        '请查看详细错误信息',
        '尝试重新连接电台',
        '如问题持续，请联系技术支持',
      ],
      cause: error,
      context: { operation: context },
    });
  }
}
