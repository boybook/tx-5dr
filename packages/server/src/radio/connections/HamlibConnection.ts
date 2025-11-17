/* eslint-disable @typescript-eslint/no-explicit-any */
// HamlibConnection - Native模块绑定需要使用any

/**
 * HamlibConnection - Hamlib 连接实现
 *
 * 封装 HamLib，实现统一的 IRadioConnection 接口
 * 支持串口和网络连接方式，提供错误转换和状态管理
 */

import { EventEmitter } from 'eventemitter3';
import { HamLib } from 'hamlib';
import type { HamlibConfig, SerialConfig } from '@tx5dr/contracts';
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
 * HamlibConnection 实现类
 * 支持串口和网络连接方式
 */
export class HamlibConnection
  extends EventEmitter<IRadioConnectionEvents>
  implements IRadioConnection
{
  /**
   * 底层 Hamlib 实例
   */
  private rig: HamLib | null = null;

  /**
   * 当前连接状态
   */
  private state: RadioConnectionState = RadioConnectionState.DISCONNECTED;

  /**
   * 当前配置
   */
  private currentConfig: RadioConnectionConfig | null = null;

  /**
   * 最后成功操作时间（用于健康检查）
   */
  private lastSuccessfulOperation: number = Date.now();

  /**
   * 清理保护标志（防止重复调用 rig.close() 导致 pthread 超时）
   */
  private isCleaningUp = false;

  /**
   * 数值表轮询定时器
   */
  private meterPollingInterval: NodeJS.Timeout | null = null;

  /**
   * 数值表轮询间隔（毫秒）
   */
  private readonly meterPollingIntervalMs = 300;

  constructor() {
    super();
  }

  /**
   * 获取连接类型
   */
  getType(): RadioConnectionType {
    return RadioConnectionType.HAMLIB;
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
    if (!this.rig || this.state !== RadioConnectionState.CONNECTED) {
      return false;
    }

    // 检查最后一次成功操作是否在5秒内
    const timeSinceLastSuccess = Date.now() - this.lastSuccessfulOperation;
    return timeSinceLastSuccess < 5000;
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
    if (config.type !== 'network' && config.type !== 'serial') {
      throw new RadioError({
        code: RadioErrorCode.INVALID_CONFIG,
        message: `配置类型错误: 期望 'network' 或 'serial'，实际 '${config.type}'`,
        userMessage: 'Hamlib 配置类型不正确',
        suggestions: ['请检查配置文件中的连接类型设置'],
      });
    }

    // 验证必需参数
    if (config.type === 'network' && (!config.network || !config.network.host || !config.network.port)) {
      throw new RadioError({
        code: RadioErrorCode.INVALID_CONFIG,
        message: 'Hamlib 网络配置缺少必需参数: network.host, network.port',
        userMessage: 'Hamlib 网络配置不完整',
        suggestions: ['请填写电台的主机地址', '请填写电台的端口号'],
      });
    }

    if (config.type === 'serial' && (!config.serial || !config.serial.path || !config.serial.rigModel)) {
      throw new RadioError({
        code: RadioErrorCode.INVALID_CONFIG,
        message: 'Hamlib 串口配置缺少必需参数: serial.path, serial.rigModel',
        userMessage: 'Hamlib 串口配置不完整',
        suggestions: ['请填写串口设备路径', '请选择电台型号'],
      });
    }

    // 保存配置
    this.currentConfig = config;

    // 更新状态
    this.setState(RadioConnectionState.CONNECTING);

    try {
      console.log(
        `📡 [HamlibConnection] 连接到 Hamlib 电台: ${config.type === 'network' ? `${config.network!.host}:${config.network!.port}` : config.serial!.path}`
      );

      // 确定连接参数
      const port =
        config.type === 'network'
          ? `${config.network!.host}:${config.network!.port}`
          : config.serial!.path;
      const model = config.type === 'network' ? 2 : config.serial!.rigModel;

      // 创建 HamLib 实例
      this.rig = new HamLib(model as any, port as any);

      // 应用串口配置（如果有）
      if (config.type === 'serial' && config.serial?.serialConfig) {
        await this.applySerialConfig(config.serial.serialConfig);
      }

      // 打开连接（带超时保护）
      const CONNECTION_TIMEOUT = 10000; // 10秒超时

      await Promise.race([
        this.openConnection(),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('连接超时')),
            CONNECTION_TIMEOUT
          )
        ),
      ]);

      // 连接成功
      this.setState(RadioConnectionState.CONNECTED);
      this.lastSuccessfulOperation = Date.now();
      console.log(`✅ [HamlibConnection] Hamlib 电台连接成功`);

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
    console.log(`🔌 [HamlibConnection] 断开连接: ${reason || '无原因'}`);

    // 停止数值表轮询
    this.stopMeterPolling();

    // 清理资源
    await this.cleanup();

    // 更新状态
    this.setState(RadioConnectionState.DISCONNECTED);

    // 触发断开事件
    this.emit('disconnected', reason);

    console.log(`✅ [HamlibConnection] 连接已断开`);
  }

  /**
   * 设置电台频率
   */
  async setFrequency(frequency: number): Promise<void> {
    this.checkConnected();

    try {
      await Promise.race([
        this.rig!.setFrequency(frequency),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('设置频率超时')), 5000)
        ),
      ]);

      this.lastSuccessfulOperation = Date.now();
      console.log(
        `🔊 [HamlibConnection] 频率设置成功: ${(frequency / 1000000).toFixed(3)} MHz`
      );
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
      const frequency = (await Promise.race([
        this.rig!.getFrequency(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('获取频率超时')), 5000)
        ),
      ])) as number;

      this.lastSuccessfulOperation = Date.now();
      return frequency;
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
      await Promise.race([
        this.rig!.setPtt(enabled),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('PTT操作超时')), 3000)
        ),
      ]);

      this.lastSuccessfulOperation = Date.now();
      console.log(
        `📡 [HamlibConnection] PTT设置成功: ${enabled ? '发射' : '接收'}`
      );
    } catch (error) {
      throw RadioError.pttActivationFailed(
        `PTT ${enabled ? '启动' : '停止'}失败`,
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  /**
   * 设置模式
   */
  async setMode(mode: string, bandwidth?: 'narrow' | 'wide'): Promise<void> {
    this.checkConnected();

    try {
      await Promise.race([
        this.rig!.setMode(mode, bandwidth),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('设置模式超时')), 5000)
        ),
      ]);

      this.lastSuccessfulOperation = Date.now();
      console.log(
        `📻 [HamlibConnection] 模式设置成功: ${mode}${bandwidth ? ` (${bandwidth})` : ''}`
      );
    } catch (error) {
      throw this.convertError(error, 'setMode');
    }
  }

  /**
   * 获取当前模式
   */
  async getMode(): Promise<{ mode: string; bandwidth: string }> {
    this.checkConnected();

    try {
      const modeInfo = (await Promise.race([
        this.rig!.getMode(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('获取模式超时')), 5000)
        ),
      ])) as { mode: string; bandwidth: string };

      this.lastSuccessfulOperation = Date.now();
      return modeInfo;
    } catch (error) {
      throw this.convertError(error, 'getMode');
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
        network: this.currentConfig?.type === 'network' ? this.currentConfig.network : undefined,
        serial: this.currentConfig?.type === 'serial' ? this.currentConfig.serial : undefined,
      },
    };
  }

  // ===== 天线调谐器控制 =====

  /**
   * 获取天线调谐器能力
   */
  async getTunerCapabilities(): Promise<import('@tx5dr/contracts').TunerCapabilities> {
    this.checkConnected();

    try {
      // 获取电台支持的功能列表
      const supportedFunctions = await Promise.race([
        this.rig!.getSupportedFunctions(),
        new Promise<string[]>((_, reject) =>
          setTimeout(() => reject(new Error('获取功能列表超时')), 5000)
        ),
      ]);

      // 检查是否支持 TUNER 功能
      const tunerSupported = supportedFunctions.includes('TUNER');

      // 假设支持 TUNER 功能的电台都支持开关控制和手动调谐
      // 实际支持情况可能因电台型号而异
      const capabilities: import('@tx5dr/contracts').TunerCapabilities = {
        supported: tunerSupported,
        hasSwitch: tunerSupported,
        hasManualTune: tunerSupported,
      };

      this.lastSuccessfulOperation = Date.now();
      console.log(`📻 [HamlibConnection] 天调能力查询成功:`, capabilities);

      return capabilities;
    } catch (error) {
      throw this.convertError(error, 'getTunerCapabilities');
    }
  }

  /**
   * 设置天线调谐器开关
   */
  async setTuner(enabled: boolean): Promise<void> {
    this.checkConnected();

    try {
      await Promise.race([
        this.rig!.setFunction('TUNER', enabled),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('设置天调超时')), 5000)
        ),
      ]);

      this.lastSuccessfulOperation = Date.now();
      console.log(
        `📻 [HamlibConnection] 天调设置成功: ${enabled ? '已启用' : '已禁用'}`
      );
    } catch (error) {
      throw this.convertError(error, 'setTuner');
    }
  }

  /**
   * 获取天线调谐器状态
   */
  async getTunerStatus(): Promise<import('@tx5dr/contracts').TunerStatus> {
    this.checkConnected();

    try {
      const enabled = await Promise.race([
        this.rig!.getFunction('TUNER'),
        new Promise<boolean>((_, reject) =>
          setTimeout(() => reject(new Error('获取天调状态超时')), 5000)
        ),
      ]);

      this.lastSuccessfulOperation = Date.now();

      // Hamlib 可能不提供调谐中状态和 SWR 值
      // 返回基本状态信息
      const status: import('@tx5dr/contracts').TunerStatus = {
        enabled,
        active: false,
        status: 'idle',
      };

      return status;
    } catch (error) {
      throw this.convertError(error, 'getTunerStatus');
    }
  }

  /**
   * 启动手动调谐
   */
  async startTuning(): Promise<boolean> {
    this.checkConnected();

    try {
      await Promise.race([
        this.rig!.vfoOperation('TUNE'),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('启动调谐超时')), 10000) // 调谐可能需要较长时间
        ),
      ]);

      this.lastSuccessfulOperation = Date.now();
      console.log(`📻 [HamlibConnection] 手动调谐已启动`);

      return true;
    } catch (error) {
      console.error(`❌ [HamlibConnection] 启动调谐失败:`, error);
      throw this.convertError(error, 'startTuning');
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
        `🔄 [HamlibConnection] 状态变化: ${oldState} -> ${newState}`
      );

      this.emit('stateChanged', newState);
    }
  }

  /**
   * 打开连接
   */
  private async openConnection(): Promise<void> {
    if (!this.rig) {
      throw new Error('电台实例未初始化');
    }

    // hamlib open() 返回 Promise，不接受回调参数
    await this.rig.open();
  }

  /**
   * 应用串口配置参数
   */
  private async applySerialConfig(serialConfig: SerialConfig): Promise<void> {
    if (!this.rig) {
      throw new Error('电台实例未初始化');
    }

    console.log('🔧 [HamlibConnection] 应用串口配置参数...');

    try {
      // 基础串口设置
      const configs = [
        { param: 'data_bits', value: serialConfig.data_bits },
        { param: 'stop_bits', value: serialConfig.stop_bits },
        { param: 'serial_parity', value: serialConfig.serial_parity },
        { param: 'serial_handshake', value: serialConfig.serial_handshake },
        { param: 'rts_state', value: serialConfig.rts_state },
        { param: 'dtr_state', value: serialConfig.dtr_state },
        // 通信设置
        { param: 'rate', value: serialConfig.rate?.toString() },
        { param: 'timeout', value: serialConfig.timeout?.toString() },
        { param: 'retry', value: serialConfig.retry?.toString() },
        // 时序控制
        { param: 'write_delay', value: serialConfig.write_delay?.toString() },
        {
          param: 'post_write_delay',
          value: serialConfig.post_write_delay?.toString(),
        },
      ];

      for (const config of configs) {
        if (config.value !== undefined && config.value !== null) {
          console.log(
            `🔧 [HamlibConnection] 设置 ${config.param}: ${config.value}`
          );
          await Promise.race([
            this.rig!.setSerialConfig(config.param as any, config.value),
            new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error(`设置${config.param}超时`)),
                3000
              )
            ),
          ]);
        }
      }

      console.log('✅ [HamlibConnection] 串口配置参数应用成功');
    } catch (error) {
      console.warn(
        '⚠️ [HamlibConnection] 串口配置应用失败:',
        (error as Error).message
      );
      throw new Error(`串口配置失败: ${(error as Error).message}`);
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
    // 防重入保护：避免重复调用 rig.close() 导致 pthread_join 超时
    if (this.isCleaningUp) {
      console.log('⚠️ [HamlibConnection] cleanup 已在进行中，跳过');
      return;
    }

    this.isCleaningUp = true;

    // 停止数值表轮询
    this.stopMeterPolling();

    try {
      if (this.rig) {
        try {
          // hamlib close() 返回 Promise，不接受回调参数
          // 增加超时时间到 5 秒，给 pthread 清理更多时间
          await Promise.race([
            this.rig.close(),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('关闭连接超时')), 5000)
            ),
          ]);
        } catch (error) {
          console.warn(`⚠️ [HamlibConnection] 清理时断开连接失败:`, error);
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
   * 启动数值表轮询
   */
  private startMeterPolling(): void {
    if (this.meterPollingInterval) {
      console.log('⚠️ [HamlibConnection] 数值表轮询已在运行');
      return;
    }

    console.log(`📊 [HamlibConnection] 启动数值表轮询，间隔 ${this.meterPollingIntervalMs}ms`);

    this.meterPollingInterval = setInterval(async () => {
      await this.pollMeters();
    }, this.meterPollingIntervalMs);
  }

  /**
   * 停止数值表轮询
   */
  private stopMeterPolling(): void {
    if (this.meterPollingInterval) {
      console.log('🛑 [HamlibConnection] 停止数值表轮询');
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
      const [strength, swr, alc, power] = await Promise.all([
        this.rig.getLevel('STRENGTH').catch(() => null),
        this.rig.getLevel('SWR').catch(() => null),
        this.rig.getLevel('ALC').catch(() => null),
        this.rig.getLevel('RFPOWER_METER').catch(() => null),
      ]);

      // 转换数据格式
      const meterData: MeterData = {
        level: strength !== null ? this.convertStrengthToLevel(strength) : null,
        swr: swr !== null ? this.convertSWR(swr) : null,
        alc: alc !== null ? this.convertALC(alc) : null,
        power: power !== null ? this.convertPower(power) : null,
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
   * 将 Hamlib STRENGTH 转换为 Level 数据
   * @param dbValue - Hamlib 返回的 dB 值（相对于 S9）
   */
  private convertStrengthToLevel(dbValue: number): { raw: number; percent: number } {
    // S9 = -73 dBm（标准参考点）
    // 每个 S 单位 = 6 dB
    // S0 = -127 dBm, S9 = -73 dBm, S9+60 = -13 dBm

    // 将 dB 值转换为绝对 dBm（假设 S9 = -73 dBm）
    const dBm = -73 + dbValue;

    // 映射到 0-100% 范围
    // 范围：-127 dBm (0%) 到 -13 dBm (100%)
    const minDbm = -127;
    const maxDbm = -13;
    const percent = Math.max(0, Math.min(100, ((dBm - minDbm) / (maxDbm - minDbm)) * 100));

    // 模拟原始值（0-255 范围）
    const raw = Math.round((percent / 100) * 255);

    return { raw, percent };
  }

  /**
   * 将 Hamlib SWR 转换为 SWR 数据
   * @param swrValue - Hamlib 返回的 SWR 值（1.0-10.0）
   */
  private convertSWR(swrValue: number): { raw: number; swr: number; alert: boolean } {
    // raw: 模拟 0-255 范围（SWR 10 对应 255）
    const raw = Math.round(Math.min(swrValue / 10, 1) * 255);

    // alert: SWR > 2.0 视为异常
    const alert = swrValue > 2.0;

    return { raw, swr: swrValue, alert };
  }

  /**
   * 将 Hamlib ALC 转换为 ALC 数据
   * @param alcValue - Hamlib 返回的 ALC 值（0.0-1.0）
   */
  private convertALC(alcValue: number): { raw: number; percent: number; alert: boolean } {
    // raw: 0.0-1.0 映射到 0-255
    const raw = Math.round(alcValue * 255);

    // percent: 0.0-1.0 映射到 0-100
    const percent = alcValue * 100;

    // alert: ALC > 80% 视为过载告警
    const alert = alcValue > 0.8;

    return { raw, percent, alert };
  }

  /**
   * 将 Hamlib RFPOWER_METER 转换为 Power 数据
   * @param powerValue - Hamlib 返回的功率值（0.0-1.0，最大功率的百分比）
   */
  private convertPower(powerValue: number): { raw: number; percent: number } {
    // raw: 0.0-1.0 映射到 0-255
    const raw = Math.round(powerValue * 255);

    // percent: 0.0-1.0 映射到 0-100
    const percent = powerValue * 100;

    return { raw, percent };
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
        message: `Hamlib 连接失败: ${errorMessage}`,
        userMessage: '无法连接到电台',
        suggestions: [
          '检查电台是否开机',
          '检查网络连接是否正常',
          '检查主机地址和端口是否正确',
          '检查串口设备路径是否正确',
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
        message: `Hamlib 连接超时: ${errorMessage}`,
        userMessage: '连接电台超时',
        suggestions: [
          '检查网络连接是否正常',
          '检查电台是否正常响应',
          '尝试增加超时时间',
        ],
        cause: error,
        context: { operation: context },
      });
    }

    // 设备错误
    if (
      errorMessageLower.includes('device not configured') ||
      errorMessageLower.includes('no such device')
    ) {
      return new RadioError({
        code: RadioErrorCode.DEVICE_ERROR,
        message: `Hamlib 设备错误: ${errorMessage}`,
        userMessage: '电台设备未找到或未配置',
        suggestions: [
          '检查串口设备是否正确连接',
          '检查设备驱动是否已安装',
          '检查设备路径是否正确',
          '尝试重新插拔设备',
        ],
        cause: error,
        context: { operation: context },
      });
    }

    // IO 错误
    if (
      errorMessageLower.includes('io error') ||
      errorMessageLower.includes('input/output error')
    ) {
      return new RadioError({
        code: RadioErrorCode.DEVICE_ERROR,
        message: `Hamlib IO 错误: ${errorMessage}`,
        userMessage: '电台通信错误',
        suggestions: [
          '检查电台连接是否稳定',
          '检查串口线缆是否正常',
          '尝试重启电台',
          '检查串口参数是否正确',
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
        suggestions: ['检查电台连接状态', '尝试重新执行操作'],
        cause: error,
        context: { operation: context },
      });
    }

    // 未知错误
    return new RadioError({
      code: RadioErrorCode.UNKNOWN_ERROR,
      message: `Hamlib 未知错误 (${context}): ${errorMessage}`,
      userMessage: '电台操作失败',
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
