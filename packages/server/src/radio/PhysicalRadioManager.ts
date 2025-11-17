/**
 * PhysicalRadioManager - 物理电台管理器 (重构版)
 *
 * Day11 重构要点:
 * 1. 使用 IRadioConnection 统一接口管理连接
 * 2. 集成 radioStateMachine 管理连接状态
 * 3. 统一重连逻辑（首次连接失败也能重连）
 * 4. 解决 disconnect() 事件时序混乱问题
 * 5. 移除手写的重连逻辑，由状态机管理
 *
 * 职责变更: 从直接管理连接 → 编排器 + 事件转发
 */

import { EventEmitter } from 'eventemitter3';
import type { HamlibConfig, RadioInfo } from '@tx5dr/contracts';
import { ConsoleLogger } from '../utils/console-logger.js';
import { RadioConnectionFactory } from './connections/RadioConnectionFactory.js';
import type { IRadioConnection, MeterData } from './connections/IRadioConnection.js';
import { RadioConnectionState, RadioConnectionType } from './connections/IRadioConnection.js';
import {
  createRadioActor,
  isRadioState,
  getRadioContext,
  type RadioActor,
} from '../state-machines/radioStateMachine.js';
import { RadioState, type RadioInput } from '../state-machines/types.js';
import { ConfigManager } from '../config/config-manager.js';

/**
 * PhysicalRadioManager 事件接口
 */
interface PhysicalRadioManagerEvents {
  connected: () => void;
  disconnected: (reason?: string) => void;
  error: (error: Error) => void;
  radioFrequencyChanged: (frequency: number) => void;
  meterData: (data: MeterData) => void; // 数值表数据
  tunerStatusChanged: (status: import('@tx5dr/contracts').TunerStatus) => void; // 天调状态变化
}

/**
 * PhysicalRadioManager - 重构后的物理电台管理器
 */
export class PhysicalRadioManager extends EventEmitter<PhysicalRadioManagerEvents> {
  private logger = ConsoleLogger.getInstance();

  /**
   * 统一连接接口（替代原来的 hamlibRig 和 icomWlanManager）
   */
  private connection: IRadioConnection | null = null;

  /**
   * 电台状态机 Actor（管理连接状态和重连）
   */
  private radioActor: RadioActor | null = null;

  /**
   * 配置管理器（用于重连时读取最新配置）
   */
  private configManager: ConfigManager;

  /**
   * 当前配置
   */
  private currentConfig: HamlibConfig = { type: 'none' };

  /**
   * 频率监控
   */
  private frequencyPollingInterval: NodeJS.Timeout | null = null;
  private lastKnownFrequency: number | null = null;

  /**
   * 断开保护标志（防止重复断开导致 hamlib 线程冲突）
   */
  private isDisconnecting = false;

  /**
   * 连接事件清理器列表（用于断开时清理）
   */
  private connectionEventListeners: Map<string, (...args: any[]) => void> = new Map();

  constructor() {
    super();
    this.configManager = ConfigManager.getInstance();
  }

  // ==================== 公共接口 ====================

  /**
   * 获取当前配置
   */
  getConfig(): HamlibConfig {
    return { ...this.currentConfig };
  }

  /**
   * 应用配置并连接电台
   *
   * 重构改进：
   * - 使用内部断开方法避免事件时序混乱
   * - 通过状态机管理连接过程
   * - 首次连接失败会自动进入重连状态
   */
  async applyConfig(config: HamlibConfig): Promise<void> {
    const oldConfig = this.currentConfig;
    console.log(`📡 [PhysicalRadioManager] 应用配置: ${config.type}`);

    // 记录配置变化详情（用于调试配置更新问题）
    if (oldConfig.type !== config.type) {
      console.log(`🔄 [PhysicalRadioManager] 配置类型变化: ${oldConfig.type} → ${config.type}`);
    } else if (config.type === 'icom-wlan') {
      const oldIp = (oldConfig as any).ip;
      const newIp = (config as any).ip;
      if (oldIp !== newIp) {
        console.log(`🔄 [PhysicalRadioManager] ICOM WLAN IP变化: ${oldIp} → ${newIp}`);
      }
    }

    // 如果已有连接，先内部断开（不触发事件，避免时序混乱）
    if (this.connection || this.radioActor) {
      console.log('🔌 [PhysicalRadioManager] 断开现有连接...');
      await this.internalDisconnect('切换配置');

      // 等待状态稳定
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    this.currentConfig = config;

    if (config.type === 'none') {
      console.log('📡 [PhysicalRadioManager] 配置类型为 none，跳过连接');
      return;
    }

    // 创建状态机 Actor
    await this.initializeStateMachine(config);

    // 触发连接（状态机会管理整个连接过程和重连）
    console.log('🔌 [PhysicalRadioManager] 通过状态机发起连接...');
    this.radioActor!.send({ type: 'CONNECT', config });

    // 等待连接成功或失败（状态机会自动处理重连）
    try {
      await this.waitForConnected(30000); // 30秒超时
      console.log('✅ [PhysicalRadioManager] 连接成功');
    } catch (error) {
      // 如果超时，状态机可能已经进入重连状态，这是正常的
      console.warn('⚠️  [PhysicalRadioManager] 初始连接超时，状态机将继续重连');
      throw error;
    }
  }

  /**
   * 断开连接（外部接口，会触发事件）
   */
  async disconnect(reason?: string): Promise<void> {
    // 防重入保护：避免重复断开导致 hamlib 线程冲突
    if (this.isDisconnecting) {
      console.log('⚠️ [PhysicalRadioManager] 断开操作已在进行中，跳过');
      return;
    }

    this.isDisconnecting = true;

    try {
      console.log(`🔌 [PhysicalRadioManager] 断开连接: ${reason || '用户请求'}`);

      this.stopFrequencyMonitoring();

      if (this.radioActor) {
        this.radioActor.send({ type: 'DISCONNECT', reason });

        // 等待状态机转换到 disconnected
        await this.waitForState(RadioState.DISCONNECTED, 5000);
      }

      // ❌ 移除重复的 internalDisconnect 调用，让状态机回调处理
      // await this.internalDisconnect(reason);

      // 触发断开事件（外部接口才触发）
      this.emit('disconnected', reason);
    } finally {
      // 确保标志位被重置
      this.isDisconnecting = false;
    }
  }

  /**
   * 手动重连
   */
  async manualReconnect(): Promise<void> {
    console.log('🔄 [PhysicalRadioManager] 手动重连请求');

    if (!this.radioActor) {
      console.error('❌ [PhysicalRadioManager] 状态机未初始化');
      throw new Error('状态机未初始化');
    }

    // 重置状态机并重新连接
    this.radioActor.send({ type: 'RECONNECT' });

    // 等待连接成功
    await this.waitForConnected(30000);
  }


  /**
   * 检查是否已连接
   */
  isConnected(): boolean {
    return this.connection !== null && this.radioActor !== null &&
           isRadioState(this.radioActor, RadioState.CONNECTED);
  }

  /**
   * 获取重连信息（简化版，仅返回必要的连接状态）
   */
  getReconnectInfo() {
    if (!this.radioActor) {
      return {
        isReconnecting: false,
        connectionHealthy: false,
      };
    }

    const context = getRadioContext(this.radioActor);
    const isReconnecting = isRadioState(this.radioActor, RadioState.RECONNECTING);

    return {
      isReconnecting,
      connectionHealthy: context.isHealthy,
    };
  }

  /**
   * 获取电台信息
   * 统一方法，根据不同电台模式返回标准化的 RadioInfo
   */
  async getRadioInfo(): Promise<RadioInfo | null> {
    // 必须已连接才返回电台信息
    if (!this.isConnected() || !this.connection) {
      return null;
    }

    const config = this.currentConfig;

    // 根据配置类型构建电台信息
    switch (config.type) {
      case 'serial': {
        // 串口模式: 从 Hamlib 支持列表查找电台型号
        if (!config.serial?.rigModel) {
          return null;
        }

        const supportedRigs = await PhysicalRadioManager.listSupportedRigs();
        const rigInfo = supportedRigs.find(r => r.rigModel === config.serial!.rigModel);

        if (!rigInfo) {
          console.warn(`⚠️ [PhysicalRadioManager] 未找到 rigModel ${config.serial.rigModel} 的电台信息`);
          return null;
        }

        return {
          manufacturer: rigInfo.mfgName,
          model: rigInfo.modelName,
          rigModel: rigInfo.rigModel,
          connectionType: 'serial',
        };
      }

      case 'network': {
        // 网络模式: 返回基本信息
        // TODO: 未来可通过 Hamlib get_info 命令获取真实电台型号
        return {
          manufacturer: 'Network',
          model: 'RigCtrl',
          rigModel: 2, // Hamlib NET rigctl 型号
          connectionType: 'network',
        };
      }

      case 'icom-wlan': {
        // ICOM WLAN 模式: 返回基本信息
        // TODO: 未来可通过 icom-wlan-node 库或 CI-V 命令获取具体型号
        return {
          manufacturer: 'ICOM',
          model: 'WLAN',
          connectionType: 'icom-wlan',
        };
      }

      case 'none':
      default:
        return null;
    }
  }

  // ==================== 电台操作 ====================

  /**
   * 设置频率
   */
  async setFrequency(freq: number): Promise<boolean> {
    if (!this.connection) {
      console.error('❌ [PhysicalRadioManager] 电台未连接，无法设置频率');
      return false;
    }

    try {
      await this.connection.setFrequency(freq);
      console.log(
        `🔊 [PhysicalRadioManager] 频率设置成功: ${(freq / 1000000).toFixed(3)} MHz`
      );
      return true;
    } catch (error) {
      console.error(
        `❌ [PhysicalRadioManager] 设置频率失败: ${(error as Error).message}`
      );
      this.handleConnectionError(error as Error);
      return false;
    }
  }

  /**
   * 获取当前频率
   */
  async getFrequency(): Promise<number> {
    if (!this.connection) {
      console.error('❌ [PhysicalRadioManager] 电台未连接，无法获取频率');
      return 0;
    }

    try {
      const frequency = await this.connection.getFrequency();
      return frequency;
    } catch (error) {
      console.error(
        `❌ [PhysicalRadioManager] 获取频率失败: ${(error as Error).message}`
      );
      this.handleConnectionError(error as Error);
      return 0;
    }
  }

  /**
   * 设置 PTT
   */
  async setPTT(state: boolean): Promise<void> {
    if (!this.connection) {
      console.error('❌ [PhysicalRadioManager] 电台未连接，无法设置PTT');
      return;
    }

    try {
      console.log(
        `📡 [PhysicalRadioManager] 开始PTT操作: ${state ? '启动发射' : '停止发射'}`
      );

      await this.connection.setPTT(state);

      console.log(
        `📡 [PhysicalRadioManager] PTT设置成功: ${state ? '发射' : '接收'}`
      );
    } catch (error) {
      console.error(
        `📡 [PhysicalRadioManager] PTT设置失败: ${state ? '发射' : '接收'} - ${
          (error as Error).message
        }`
      );
      this.handleConnectionError(error as Error);
    }
  }

  /**
   * 测试连接
   */
  async testConnection(): Promise<void> {
    if (!this.connection) {
      throw new Error('电台未连接，无法测试连接');
    }

    try {
      const currentFreq = await this.connection.getFrequency();
      console.log(
        `✅ [PhysicalRadioManager] 连接测试成功，当前频率: ${(
          currentFreq / 1000000
        ).toFixed(3)} MHz`
      );
    } catch (error) {
      console.error(
        `❌ [PhysicalRadioManager] 连接测试失败: ${(error as Error).message}`
      );
      this.handleConnectionError(error as Error);
      throw error;
    }
  }

  /**
   * 设置模式
   */
  async setMode(mode: string, bandwidth?: 'narrow' | 'wide'): Promise<void> {
    if (!this.connection) {
      throw new Error('电台未连接');
    }

    try {
      await this.connection.setMode(mode, bandwidth);
      console.log(`📻 [PhysicalRadioManager] 模式设置成功: ${mode}${bandwidth ? ` (${bandwidth})` : ''}`);
    } catch (error) {
      this.handleConnectionError(error as Error);
      throw new Error(`设置模式失败: ${(error as Error).message}`);
    }
  }

  /**
   * 获取当前模式
   */
  async getMode(): Promise<{ mode: string; bandwidth: string }> {
    if (!this.connection) {
      throw new Error('电台未连接');
    }

    try {
      const modeInfo = await this.connection.getMode();
      console.log(`📻 [PhysicalRadioManager] 模式读取成功: ${modeInfo.mode}`);
      return modeInfo;
    } catch (error) {
      this.handleConnectionError(error as Error);
      throw new Error(`获取模式失败: ${(error as Error).message}`);
    }
  }

  // ==================== 天线调谐器控制 ====================

  /**
   * 获取天线调谐器能力
   */
  async getTunerCapabilities(): Promise<import('@tx5dr/contracts').TunerCapabilities> {
    if (!this.connection) {
      console.error('❌ [PhysicalRadioManager] 电台未连接，无法获取天调能力');
      // 返回默认值：不支持
      return {
        supported: false,
        hasSwitch: false,
        hasManualTune: false,
      };
    }

    // 检查连接是否实现了天调方法
    if (!this.connection.getTunerCapabilities) {
      console.log('ℹ️ [PhysicalRadioManager] 当前电台连接不支持天调功能');
      return {
        supported: false,
        hasSwitch: false,
        hasManualTune: false,
      };
    }

    try {
      const capabilities = await this.connection.getTunerCapabilities();
      console.log(`📻 [PhysicalRadioManager] 天调能力:`, capabilities);
      return capabilities;
    } catch (error) {
      console.error(
        `❌ [PhysicalRadioManager] 获取天调能力失败: ${(error as Error).message}`
      );
      this.handleConnectionError(error as Error);
      // 发生错误时返回不支持
      return {
        supported: false,
        hasSwitch: false,
        hasManualTune: false,
      };
    }
  }

  /**
   * 设置天线调谐器开关
   */
  async setTuner(enabled: boolean): Promise<void> {
    if (!this.connection) {
      throw new Error('电台未连接，无法控制天调');
    }

    if (!this.connection.setTuner) {
      throw new Error('当前电台不支持天调控制');
    }

    try {
      console.log(
        `📻 [PhysicalRadioManager] ${enabled ? '启用' : '禁用'}天调...`
      );

      await this.connection.setTuner(enabled);

      console.log(
        `✅ [PhysicalRadioManager] 天调${enabled ? '已启用' : '已禁用'}`
      );

      // 获取更新后的状态并广播事件
      const status = await this.getTunerStatus();
      this.emit('tunerStatusChanged', status);
    } catch (error) {
      console.error(
        `❌ [PhysicalRadioManager] 设置天调失败: ${(error as Error).message}`
      );
      this.handleConnectionError(error as Error);
      throw error;
    }
  }

  /**
   * 获取天线调谐器状态
   */
  async getTunerStatus(): Promise<import('@tx5dr/contracts').TunerStatus> {
    if (!this.connection) {
      console.error('❌ [PhysicalRadioManager] 电台未连接，无法获取天调状态');
      // 返回默认状态
      return {
        enabled: false,
        active: false,
        status: 'idle',
      };
    }

    if (!this.connection.getTunerStatus) {
      console.log('ℹ️ [PhysicalRadioManager] 当前电台连接不支持天调状态查询');
      return {
        enabled: false,
        active: false,
        status: 'idle',
      };
    }

    try {
      const status = await this.connection.getTunerStatus();
      return status;
    } catch (error) {
      console.error(
        `❌ [PhysicalRadioManager] 获取天调状态失败: ${(error as Error).message}`
      );
      this.handleConnectionError(error as Error);
      // 发生错误时返回默认状态
      return {
        enabled: false,
        active: false,
        status: 'idle',
      };
    }
  }

  /**
   * 启动手动调谐
   */
  async startTuning(): Promise<boolean> {
    if (!this.connection) {
      throw new Error('电台未连接，无法启动调谐');
    }

    if (!this.connection.startTuning) {
      throw new Error('当前电台不支持手动调谐');
    }

    try {
      console.log(`📻 [PhysicalRadioManager] 启动手动调谐...`);

      // 启动前先标记为调谐中（如果支持状态查询）
      if (this.connection.getTunerStatus) {
        const beforeStatus: import('@tx5dr/contracts').TunerStatus = {
          enabled: true,
          active: true,
          status: 'tuning',
        };
        this.emit('tunerStatusChanged', beforeStatus);
      }

      const result = await this.connection.startTuning();

      console.log(
        `${result ? '✅' : '❌'} [PhysicalRadioManager] 调谐${
          result ? '成功' : '失败'
        }`
      );

      // 调谐完成后获取最新状态
      if (this.connection.getTunerStatus) {
        const afterStatus = await this.getTunerStatus();
        // 根据结果更新状态
        afterStatus.status = result ? 'success' : 'failed';
        afterStatus.active = false;
        this.emit('tunerStatusChanged', afterStatus);
      }

      return result;
    } catch (error) {
      console.error(
        `❌ [PhysicalRadioManager] 启动调谐失败: ${(error as Error).message}`
      );

      // 调谐失败，广播失败状态
      if (this.connection.getTunerStatus) {
        const failedStatus: import('@tx5dr/contracts').TunerStatus = {
          enabled: true,
          active: false,
          status: 'failed',
        };
        this.emit('tunerStatusChanged', failedStatus);
      }

      this.handleConnectionError(error as Error);
      throw error;
    }
  }

  /**
   * 获取信号强度
   */
  async getSignalStrength(): Promise<number> {
    if (!this.connection) {
      throw new Error('电台未连接');
    }

    try {
      // IRadioConnection 接口目前没有 getSignalStrength，需要扩展
      throw new Error('getSignalStrength 功能待实现');
    } catch (error) {
      this.handleConnectionError(error as Error);
      throw new Error(`获取信号强度失败: ${(error as Error).message}`);
    }
  }

  /**
   * 获取电台状态
   */
  async getRadioStatus(): Promise<{
    frequency: number;
    mode: { mode: string; bandwidth: string };
    signalStrength?: number;
  }> {
    if (!this.connection) {
      throw new Error('电台未连接');
    }

    try {
      const frequency = await this.getFrequency();
      // mode 和 signalStrength 需要接口扩展
      return {
        frequency,
        mode: { mode: 'UNKNOWN', bandwidth: 'UNKNOWN' },
      };
    } catch (error) {
      throw new Error(`获取电台状态失败: ${(error as Error).message}`);
    }
  }

  /**
   * 获取 ICOM WLAN 连接（用于音频适配器）
   *
   * 重构后：直接返回 IcomWlanConnection 实例
   */
  getIcomWlanManager(): any | null {
    if (
      !this.connection ||
      this.connection.getType() !== RadioConnectionType.ICOM_WLAN
    ) {
      return null;
    }

    // 直接返回 IcomWlanConnection 实例（移除 IcomWlanManager 中间层）
    return this.connection;
  }

  // ==================== 静态方法 ====================

  /**
   * 列出支持的电台型号
   */
  static async listSupportedRigs(): Promise<Array<{ rigModel: number; mfgName: string; modelName: string }>> {
    // 这个方法依赖 HamLib，需要从 hamlib 包导入
    try {
      // 使用 ES 模块动态导入 HamLib
      const hamlibModule = await import('hamlib');
      const { HamLib } = hamlibModule;
      return HamLib.getSupportedRigs();
    } catch (error) {
      console.warn('⚠️  [PhysicalRadioManager] 无法获取 HamLib 支持列表:', (error as Error).message);
      return [];
    }
  }

  // ==================== 内部方法 ====================

  /**
   * 初始化状态机
   */
  private async initializeStateMachine(config: HamlibConfig): Promise<void> {
    console.log('🔧 [PhysicalRadioManager] 初始化状态机...');

    const radioInput: RadioInput = {
      healthCheckInterval: 3000, // 3秒

      // 连接回调 - 从 ConfigManager 读取最新配置
      onConnect: async (_cfg: HamlibConfig) => {
        console.log('🔌 [RadioStateMachine] 回调: onConnect - 从ConfigManager读取最新配置');
        const latestConfig = this.configManager.getRadioConfig();
        console.log(`🔧 [PhysicalRadioManager] 使用配置类型: ${latestConfig.type}`,
                    latestConfig.type === 'icom-wlan' ? { ip: (latestConfig as any).ip } : {});
        await this.doConnect(latestConfig);
      },

      // 断开回调
      onDisconnect: async (_reason?: string) => {
        console.log(`🔌 [RadioStateMachine] 回调: onDisconnect (${_reason || ''})`);
        await this.doDisconnect(_reason);
      },

      // 状态变化回调
      onStateChange: (state: RadioState, context: any) => {
        console.log(`🔄 [RadioStateMachine] 状态变化: ${state}`);
        this.handleStateChange(state, context);
      },

      // 错误回调
      onError: (error: Error) => {
        console.error(`❌ [RadioStateMachine] 错误: ${error.message}`);
        this.emit('error', error);
      },
    };

    this.radioActor = createRadioActor(radioInput, {
      id: 'physicalRadio',
      devTools: process.env.NODE_ENV === 'development',
    });
    this.radioActor.start();

    console.log('✅ [PhysicalRadioManager] 状态机已初始化');
  }

  /**
   * 执行连接（状态机回调）
   */
  private async doConnect(config: HamlibConfig): Promise<void> {
    console.log(`🔗 [PhysicalRadioManager] 执行连接: ${config.type}`);

    // 详细记录连接配置（用于验证重连时使用的是最新配置）
    if (config.type === 'icom-wlan') {
      console.log(`📍 [PhysicalRadioManager] ICOM WLAN 连接配置: IP=${(config as any).ip}, Port=${(config as any).port || 50001}`);
    } else if (config.type === 'serial') {
      console.log(`📍 [PhysicalRadioManager] 串口连接配置: ${(config as any).serialPort}`);
    } else if (config.type === 'network') {
      console.log(`📍 [PhysicalRadioManager] 网络连接配置: ${(config as any).networkAddress}:${(config as any).networkPort}`);
    }

    // 创建连接实例
    this.connection = RadioConnectionFactory.create(config);

    // 设置事件转发
    this.setupConnectionEventForwarding();

    // 执行连接
    await this.connection.connect(config);

    // 验证连接健康
    if (!this.connection.isHealthy()) {
      throw new Error('连接验证失败');
    }

    // 启动频率监控
    this.startFrequencyMonitoring();

    console.log('✅ [PhysicalRadioManager] 连接成功');
  }

  /**
   * 执行断开（状态机回调，内部不触发事件）
   */
  private async doDisconnect(reason?: string): Promise<void> {
    console.log(`🔌 [PhysicalRadioManager] 执行断开: ${reason || ''}`);

    this.stopFrequencyMonitoring();

    if (this.connection) {
      try {
        await this.connection.disconnect(reason);
      } catch (error) {
        console.warn(
          `⚠️  [PhysicalRadioManager] 断开连接时出错: ${(error as Error).message}`
        );
      }

      this.cleanupConnectionListeners();
      this.connection = null;
    }

    console.log('✅ [PhysicalRadioManager] 断开完成');
  }

  /**
   * 内部断开（不触发外部事件，用于 applyConfig）
   */
  private async internalDisconnect(reason?: string): Promise<void> {
    console.log(`🔌 [PhysicalRadioManager] 内部断开: ${reason || ''}`);

    this.stopFrequencyMonitoring();

    if (this.radioActor) {
      this.radioActor.stop();
      this.radioActor = null;
    }

    await this.doDisconnect(reason);
  }

  /**
   * 设置连接事件转发
   */
  private setupConnectionEventForwarding(): void {
    if (!this.connection) return;

    console.log('🔗 [PhysicalRadioManager] 设置事件转发');

    // 状态变化
    const onStateChanged = (state: RadioConnectionState) => {
      console.log(`🔄 [Connection] 状态变化: ${state}`);
      // 不再自动触发重连事件,由用户手动重连
    };
    this.connection.on('stateChanged', onStateChanged);
    this.connectionEventListeners.set('stateChanged', onStateChanged);

    // 频率变化（来自 IRadioConnection）
    const onFrequencyChanged = (frequency: number) => {
      console.log(
        `📡 [Connection] 频率变化: ${(frequency / 1000000).toFixed(3)} MHz`
      );
      this.emit('radioFrequencyChanged', frequency);
    };
    this.connection.on('frequencyChanged', onFrequencyChanged);
    this.connectionEventListeners.set('frequencyChanged', onFrequencyChanged);

    // 数值表数据
    const onMeterData = (data: MeterData) => {
      this.emit('meterData', data);
    };
    this.connection.on('meterData', onMeterData);
    this.connectionEventListeners.set('meterData', onMeterData);

    // 错误
    const onError = (error: Error) => {
      console.error(`❌ [Connection] 错误: ${error.message}`);
      this.emit('error', error);
    };
    this.connection.on('error', onError);
    this.connectionEventListeners.set('error', onError);
  }

  /**
   * 清理连接事件监听器
   */
  private cleanupConnectionListeners(): void {
    if (!this.connection) return;

    console.log('🧹 [PhysicalRadioManager] 清理事件监听器');

    for (const [event, listener] of this.connectionEventListeners.entries()) {
      this.connection.off(event as any, listener);
    }

    this.connectionEventListeners.clear();
  }

  /**
   * 处理状态机状态变化
   */
  private handleStateChange(state: RadioState, context: any): void {
    console.log(`🔄 [PhysicalRadioManager] 状态机状态: ${state}`);

    switch (state) {
      case RadioState.CONNECTED:
        this.emit('connected');
        break;

      case RadioState.DISCONNECTED:
        // 内部断开不触发事件（在外部方法中触发）
        break;

      case RadioState.RECONNECTING:
        // 重连状态仅记录,不发送事件
        break;

      case RadioState.ERROR:
        if (context.error) {
          this.emit('error', context.error);
        }
        break;
    }
  }

  /**
   * 处理连接错误
   */
  private handleConnectionError(error: Error): void {
    console.error(`❌ [PhysicalRadioManager] 连接错误: ${error.message}`);

    // 触发状态机健康检查失败
    if (this.radioActor) {
      this.radioActor.send({
        type: 'HEALTH_CHECK_FAILED',
        error,
      });
    }
  }

  /**
   * 等待状态机进入连接状态
   */
  private async waitForConnected(timeout: number = 30000): Promise<void> {
    if (!this.radioActor) {
      throw new Error('状态机未初始化');
    }

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        subscription?.unsubscribe();
        reject(new Error('等待连接超时'));
      }, timeout);

      const subscription = this.radioActor!.subscribe((snapshot) => {
        if (snapshot.value === RadioState.CONNECTED) {
          clearTimeout(timeoutId);
          subscription?.unsubscribe();
          resolve();
        } else if (snapshot.value === RadioState.ERROR) {
          clearTimeout(timeoutId);
          subscription?.unsubscribe();
          reject(snapshot.context.error || new Error('连接失败'));
        }
      });

      // 立即检查当前状态
      if (this.radioActor!.getSnapshot().value === RadioState.CONNECTED) {
        clearTimeout(timeoutId);
        subscription?.unsubscribe();
        resolve();
      }
    });
  }

  /**
   * 等待状态机进入指定状态
   */
  private async waitForState(
    targetState: RadioState,
    timeout: number = 5000
  ): Promise<void> {
    if (!this.radioActor) {
      throw new Error('状态机未初始化');
    }

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        subscription?.unsubscribe();
        reject(new Error(`等待状态 ${targetState} 超时`));
      }, timeout);

      const subscription = this.radioActor!.subscribe((snapshot) => {
        if (snapshot.value === targetState) {
          clearTimeout(timeoutId);
          subscription?.unsubscribe();
          resolve();
        }
      });

      // 立即检查当前状态
      if (this.radioActor!.getSnapshot().value === targetState) {
        clearTimeout(timeoutId);
        subscription?.unsubscribe();
        resolve();
      }
    });
  }

  // ==================== 频率监控 ====================

  /**
   * 启动频率监控（每5秒检查一次）
   */
  private startFrequencyMonitoring(): void {
    if (this.frequencyPollingInterval) {
      this.stopFrequencyMonitoring();
    }

    if (!this.connection) {
      return;
    }

    console.log('📡 [PhysicalRadioManager] 启动频率监控（每5秒检查）');

    // 立即获取一次初始频率
    this.checkFrequencyChange();

    // 启动定时器
    this.frequencyPollingInterval = setInterval(() => {
      this.checkFrequencyChange();
    }, 5000);
  }

  /**
   * 停止频率监控
   */
  private stopFrequencyMonitoring(): void {
    if (this.frequencyPollingInterval) {
      clearInterval(this.frequencyPollingInterval);
      this.frequencyPollingInterval = null;
      console.log('📡 [PhysicalRadioManager] 已停止频率监控');
    }
    this.lastKnownFrequency = null;
  }

  /**
   * 检查频率变化
   */
  private async checkFrequencyChange(): Promise<void> {
    if (!this.connection || !this.isConnected()) {
      return;
    }

    try {
      const currentFrequency = await this.getFrequency();

      // 🔧 容忍连接初始化期间的 0 返回（CIV 通道可能尚未完全就绪）
      if (currentFrequency === 0) {
        if (this.lastKnownFrequency === null) {
          console.debug(
            '📡 [PhysicalRadioManager] 频率获取返回0（可能处于初始化状态），等待下次轮询'
          );
        }
        return; // 静默跳过，等待下次轮询（5秒后）
      }

      // 频率有效且与上次不同
      if (
        currentFrequency > 0 &&
        currentFrequency !== this.lastKnownFrequency
      ) {
        console.log(
          `📡 [PhysicalRadioManager] 检测到频率变化: ${
            this.lastKnownFrequency
              ? (this.lastKnownFrequency / 1000000).toFixed(3)
              : 'N/A'
          } MHz → ${(currentFrequency / 1000000).toFixed(3)} MHz`
        );

        this.lastKnownFrequency = currentFrequency;

        // 发射频率变化事件
        this.emit('radioFrequencyChanged', currentFrequency);
      } else if (this.lastKnownFrequency === null && currentFrequency > 0) {
        // 首次获取频率
        console.log(
          `📡 [PhysicalRadioManager] 初始频率: ${(
            currentFrequency / 1000000
          ).toFixed(3)} MHz`
        );
        this.lastKnownFrequency = currentFrequency;
      }
    } catch (error) {
      // 静默处理错误（getFrequency 已经有错误处理）
    }
  }
}
