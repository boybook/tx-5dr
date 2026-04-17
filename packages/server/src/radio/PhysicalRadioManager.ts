/* eslint-disable @typescript-eslint/no-explicit-any */
// PhysicalRadioManager - 电台连接管理需要使用any类型以处理不同连接类型的事件

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
import type {
  HamlibConfig,
  MeterCapabilities,
  RadioInfo,
  ReconnectProgress,
  CapabilityDescriptor,
  CapabilityState,
  CoreRadioCapabilities,
  CoreCapabilityDiagnostic,
  CoreCapabilityDiagnostics,
  TunerCapabilities,
} from '@tx5dr/contracts';
import { RadioConnectionStatus } from '@tx5dr/contracts';
import { createLogger } from '../utils/logger.js';
import { isProcessShuttingDown } from '../utils/process-shutdown.js';
import { RadioConnectionFactory } from './connections/RadioConnectionFactory.js';
import type {
  ApplyOperatingStateRequest,
  ApplyOperatingStateResult,
  IRadioConnection,
  MeterData,
  RadioModeInfo,
  RadioModeBandwidth,
  SetRadioModeOptions,
} from './connections/IRadioConnection.js';
import { RadioConnectionType, RadioConnectionState } from './connections/IRadioConnection.js';
import { RadioError, RadioErrorCode } from '../utils/errors/RadioError.js';
import { RadioCapabilityManager } from './RadioCapabilityManager.js';
import { isRecoverableOptionalRadioError } from './optionalRadioError.js';
import {
  createRadioActor,
  isRadioState,
  getRadioContext,
  type RadioActor,
} from '../state-machines/radioStateMachine.js';
import { RadioState, type RadioInput } from '../state-machines/types.js';
import { ConfigManager } from '../config/config-manager.js';

const logger = createLogger('PhysicalRadioManager');

/**
 * PhysicalRadioManager 事件接口
 */
interface PhysicalRadioManagerEvents {
  connecting: () => void;
  connected: () => void;
  disconnected: (reason?: string) => void;
  reconnecting: (attempt: number, maxAttempts: number, delayMs?: number) => void;
  error: (error: Error) => void;
  radioFrequencyChanged: (frequency: number) => void;
  meterData: (data: MeterData) => void;
  tunerStatusChanged: (status: import('@tx5dr/contracts').TunerStatus) => void;
  coreCapabilitiesChanged: (capabilities: CoreRadioCapabilities) => void;
  /** 能力快照（连接/断开时触发） */
  capabilityList: (data: { descriptors: CapabilityDescriptor[]; capabilities: CapabilityState[] }) => void;
  /** 单个能力值变化 */
  capabilityChanged: (state: CapabilityState) => void;
}

type CoreCapabilityKey = keyof CoreRadioCapabilities;
type CoreCapabilityState = 'unknown' | 'supported' | 'unsupported';
type CoreCapabilityDiagnosticsMap = Partial<Record<CoreCapabilityKey, CoreCapabilityDiagnostic>>;

function createInitialCoreCapabilityStates(): Record<CoreCapabilityKey, CoreCapabilityState> {
  return {
    readFrequency: 'unknown',
    writeFrequency: 'unknown',
    readRadioMode: 'unknown',
    writeRadioMode: 'unknown',
  };
}

const CORE_CAPABILITY_LABELS: Record<CoreCapabilityKey, string> = {
  readFrequency: 'read frequency',
  writeFrequency: 'write frequency',
  readRadioMode: 'read radio mode',
  writeRadioMode: 'write radio mode',
};

function createUnsupportedTunerCapabilities(): TunerCapabilities {
  return {
    supported: false,
    hasSwitch: false,
    hasManualTune: false,
  };
}

function buildCapabilityDiagnosticMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function buildCapabilityDiagnosticStack(error: unknown, visited = new Set<object>()): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  if (visited.has(error)) {
    return error.stack ?? error.message;
  }
  visited.add(error);

  const primaryStack = error.stack ?? error.message;
  const cause = (error as Error & { cause?: unknown }).cause;

  if (!cause) {
    return primaryStack;
  }

  return `${primaryStack}\nCaused by: ${buildCapabilityDiagnosticStack(cause, visited)}`;
}

type HamlibPortCaps = {
  portType?: string;
  serialRateMin?: number;
  serialRateMax?: number;
  serialDataBits?: number;
  serialStopBits?: number;
  serialParity?: string;
  serialHandshake?: string;
  writeDelay?: number;
  postWriteDelay?: number;
  timeout?: number;
  retry?: number;
};

type RigEndpointKind = 'serial-port' | 'network-address' | 'device-path';

type RigConfigFieldSchema = {
  token: number;
  name: string;
  label: string;
  tooltip: string;
  defaultValue: string;
  effectiveDefaultValue?: string;
  effectiveDefaultSource?: 'hamlib-schema' | 'rig-caps';
  type: string;
  numeric?: { min: number; max: number; step: number };
  options?: string[];
};

function deriveRigEndpointKind(portType?: string): RigEndpointKind {
  switch (portType) {
    case 'serial':
      return 'serial-port';
    case 'network':
    case 'udp-network':
      return 'network-address';
    default:
      return 'device-path';
  }
}

function getRigCapsDefaultValue(fieldName: string, caps?: HamlibPortCaps): string | undefined {
  if (!caps) {
    return undefined;
  }

  switch (fieldName) {
    case 'serial_speed':
      return caps.serialRateMax ? String(caps.serialRateMax) : undefined;
    case 'serial_data_bits':
      return caps.serialDataBits ? String(caps.serialDataBits) : undefined;
    case 'serial_stop_bits':
      return caps.serialStopBits ? String(caps.serialStopBits) : undefined;
    case 'serial_parity':
      return caps.serialParity;
    case 'serial_handshake':
      return caps.serialHandshake;
    case 'write_delay':
      return caps.writeDelay !== undefined ? String(caps.writeDelay) : undefined;
    case 'post_write_delay':
      return caps.postWriteDelay !== undefined ? String(caps.postWriteDelay) : undefined;
    case 'timeout':
      return caps.timeout !== undefined ? String(caps.timeout) : undefined;
    case 'retry':
      return caps.retry !== undefined ? String(caps.retry) : undefined;
    default:
      return undefined;
  }
}

function enrichRigConfigFields(fields: unknown[], caps?: HamlibPortCaps): RigConfigFieldSchema[] {
  if (!Array.isArray(fields)) {
    return [];
  }

  return fields.flatMap((field): RigConfigFieldSchema[] => {
    if (!field || typeof field !== 'object') {
      return [];
    }

    const raw = field as Record<string, unknown>;
    const defaultValue = typeof raw.defaultValue === 'string' ? raw.defaultValue : '';
    const capsDefaultValue = getRigCapsDefaultValue(typeof raw.name === 'string' ? raw.name : '', caps);
    const effectiveDefaultValue = capsDefaultValue ?? defaultValue;
    const effectiveDefaultSource = capsDefaultValue ? 'rig-caps' : (defaultValue ? 'hamlib-schema' : undefined);

    return [{
      token: typeof raw.token === 'number' ? raw.token : 0,
      name: typeof raw.name === 'string' ? raw.name : '',
      label: typeof raw.label === 'string' ? raw.label : '',
      tooltip: typeof raw.tooltip === 'string' ? raw.tooltip : '',
      defaultValue,
      effectiveDefaultValue: effectiveDefaultValue || undefined,
      effectiveDefaultSource,
      type: typeof raw.type === 'string' ? raw.type : 'unknown',
      numeric: raw.numeric as RigConfigFieldSchema['numeric'] | undefined,
      options: Array.isArray(raw.options) ? raw.options.filter((option): option is string => typeof option === 'string') : undefined,
    }];
  });
}

/**
 * PhysicalRadioManager - 重构后的物理电台管理器
 *
 * 负责：
 * - 创建与销毁电台连接会话
 * - 维护连接状态机与保守 bootstrap
 * - 对外暴露统一电台控制接口
 *
 * 不负责：
 * - 引擎资源启动顺序
 * - WebSocket/UI 状态投影
 * - 连接成功后的业务恢复策略
 */
export class PhysicalRadioManager extends EventEmitter<PhysicalRadioManagerEvents> {
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
  private cachedTunerCapabilities: TunerCapabilities | null = null;
  private readonly postConnectSettleMs = 250;

  /**
   * 统一电台控制能力管理器
   */
  private capabilityManager: RadioCapabilityManager = new RadioCapabilityManager();

  /** PTT state: pause frequency monitoring and capability polling during TX */
  private _isPTTActive = false;

  /**
   * 当前连接会话的核心能力状态缓存。
   * 一旦明确判定为 unsupported，当前会话内不再重复访问底层连接。
   */
  private coreCapabilityStates: Record<CoreCapabilityKey, CoreCapabilityState> = createInitialCoreCapabilityStates();

  /**
   * 当前连接会话的核心能力诊断信息。
   * 仅保留第一次将能力降级为 unsupported 的原始错误详情。
   */
  private coreCapabilityDiagnostics: CoreCapabilityDiagnosticsMap = {};

  /**
   * 断开保护标志（防止重复断开导致 hamlib 线程冲突）
   */
  private isDisconnecting = false;

  /**
   * 主动断线意图标志（PowerController 进入 standby/off 前设置）
   * RadioBridge 遇到此标志触发的断线时跳过自动重连
   */
  private intentionalDisconnectFlag: { active: boolean; reason?: string } = { active: false };

  /**
   * 连接事件清理器列表（用于断开时清理）
   */
  private connectionEventListeners: Map<string, (...args: any[]) => void> = new Map();

  /**
   * 待处理的连接错误（在状态机 clearError 清除前捕获）
   * XState v5 的 DISCONNECTED entry action 会清除 context.error，
   * 所以在 onError 回调中先保存错误，供 waitForConnected 使用
   */
  private pendingConnectionError: Error | undefined;

  constructor() {
    super();
    this.configManager = ConfigManager.getInstance();
    this.setupCapabilityManagerForwarding();
  }

  /**
   * 转发 RadioCapabilityManager 的事件到 PhysicalRadioManager
   */
  private setupCapabilityManagerForwarding(): void {
    this.capabilityManager.on('capabilityList', (data) => {
      this.emit('capabilityList', data);
    });
    this.capabilityManager.on('capabilityChanged', (state) => {
      this.emit('capabilityChanged', state);
    });
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
    logger.info(`Applying config: ${config.type}`);

    // 防止重复连接：如果配置未改变且已连接，跳过
    if (this.isConfigIdentical(oldConfig, config) && this.isConnected()) {
      logger.debug('Config unchanged and already connected, skipping');
      return;
    }

    // 记录配置变化详情（用于调试配置更新问题）
    if (oldConfig.type !== config.type) {
      logger.info(`Config type changed: ${oldConfig.type} -> ${config.type}`);
    } else if (config.type === 'icom-wlan') {
      const oldIp = oldConfig.icomWlan?.ip;
      const newIp = config.icomWlan?.ip;
      if (oldIp !== newIp) {
        logger.info(`ICOM WLAN IP changed: ${oldIp} -> ${newIp}`);
      }
    }

    // 如果已有连接，先内部断开（不触发事件，避免时序混乱）
    if (this.connection || this.radioActor) {
      logger.info('Disconnecting existing connection before applying new config');
      await this.internalDisconnect('config switch');
      // doConnect() 会在开头清理旧连接，不需要额外等待
    }

    this.currentConfig = config;

    // 创建状态机 Actor（包括 none 类型，NullConnection 会瞬间成功）
    await this.initializeStateMachine(config);

    // 触发连接（状态机会管理整个连接过程和重连）
    logger.info('Initiating connection via state machine');
    this.radioActor!.send({ type: 'CONNECT', config });

    // 等待连接成功或失败（状态机会自动处理重连）
    try {
      await this.waitForConnected(30000); // 30秒超时
      logger.info('Connection established');
    } catch (error) {
      // 首次连接失败，不自动重连，由用户手动重试
      logger.warn('Initial connection failed or timed out');
      throw error;
    }
  }

  /**
   * 唤醒电台（从关机状态）并建立完整连接。
   *
   * 流程：
   *   1. 创建 connection，control-only 模式 open（跳过通信验证）
   *   2. 发送 setPowerstat('on')
   *   3. Readiness 探针（getFrequency）轮询直到响应或超时
   *   4. connection.promoteToFull() 原地升级（通信验证 + 能力探测）
   *   5. bootstrapConnectedSession（频率恢复、capability manager init）
   *   6. 启动 radioActor；onConnect 检测已连接会短路
   *
   * 设计约束：全程使用同一个 rig 实例，避免 ICOM 串口短时间反复 open/close 的稳定性问题
   */
  async wakeAndConnect(config: HamlibConfig): Promise<void> {
    logger.info(`Wake flow starting: ${config.type}`);

    if (this.connection || this.radioActor) {
      await this.internalDisconnect('preparing wake flow');
    }

    this.currentConfig = config;
    this.resetConnectionSessionState();

    const connection = RadioConnectionFactory.create(config);
    this.connection = connection;
    this.setupConnectionEventForwarding();

    try {
      // 1. Control-only 连接
      logger.info('Wake flow: opening control-only link');
      await connection.connect(config, { mode: 'control-only' });

      if (!connection.setPowerState) {
        throw new RadioError({
          code: RadioErrorCode.INVALID_CONFIG,
          message: 'Active connection does not implement setPowerState',
          userMessage: 'Power control is not supported by this connection type',
          suggestions: [],
        });
      }

      // 2. 发送开机指令
      // 注意：setPowerState 内部 race 一个超时，但 Hamlib 底层 rig_set_powerstat
      // 在 ICOM 电台上可能阻塞很久（发送 175 字节 0xFE 前导 + 等电台 CI-V ACK）。
      // 即使这里抛 timeout，前导也已经送达电台；readiness probe 才是判断电台是否
      // 真的响应的权威入口。因此 catch 超时错误并继续。
      logger.info('Wake flow: sending powerstat(on)');
      try {
        await connection.setPowerState('on');
      } catch (error) {
        logger.warn('setPowerState("on") returned before ACK (continuing to readiness probe):', error);
      }

      // 3. 等待电台响应
      const totalTimeout = config.type === 'icom-wlan' ? 30_000 : 20_000;
      logger.info(`Wake flow: waiting for radio readiness (timeout ${totalTimeout}ms)`);
      await this.pollRadioReadiness(connection, totalTimeout);

      // 4. 升级为完整连接
      logger.info('Wake flow: promoting control link to full connection');
      if (!connection.promoteToFull) {
        throw new RadioError({
          code: RadioErrorCode.INVALID_CONFIG,
          message: 'Active connection does not implement promoteToFull',
          userMessage: 'Power control is not supported by this connection type',
          suggestions: [],
        });
      }
      await connection.promoteToFull();

      // 5. Bootstrap（恢复频率、初始化 capability 管理器等）
      logger.info('Wake flow: bootstrap');
      await this.bootstrapConnectedSession(connection);
      this.activateConnectedSession(connection);

      // 6. 初始化状态机并让其进入 CONNECTED 态
      await this.initializeStateMachine(config);
      this.radioActor!.send({ type: 'CONNECT', config });
      await this.waitForConnected(10_000);

      logger.info('Wake flow completed successfully');
    } catch (error) {
      logger.error('Wake flow failed:', error);
      // 清理失败的连接
      this.cleanupConnectionListeners();
      try { await connection.disconnect('wake flow failed'); } catch {}
      this.connection = null;
      throw error;
    }
  }

  /**
   * Readiness 探针：轮询 probeResponding 直到电台响应或超时
   *
   * 使用 probeResponding 而不是 getFrequency，因为后者的 checkConnected 默认
   * 不允许 CONTROL_ONLY 状态（会立即抛 INVALID_STATE）。probe 绕过了守卫直达
   * 底层 rig handle。
   */
  private async pollRadioReadiness(connection: IRadioConnection, totalTimeoutMs: number): Promise<void> {
    if (!connection.probeResponding) {
      throw new RadioError({
        code: RadioErrorCode.INVALID_CONFIG,
        message: 'Active connection does not implement probeResponding',
        userMessage: 'Power readiness probe not supported by this connection type',
        suggestions: [],
      });
    }
    const start = Date.now();
    const delays = [500, 1000, 2000, 3000, 5000];
    let attempt = 0;
    while (Date.now() - start < totalTimeoutMs) {
      const ok = await connection.probeResponding(3000);
      if (ok) {
        logger.info(`Radio readiness confirmed after ${Date.now() - start}ms (attempt ${attempt + 1})`);
        return;
      }
      attempt += 1;
      const delay = delays[Math.min(attempt - 1, delays.length - 1)];
      const remaining = totalTimeoutMs - (Date.now() - start);
      if (remaining <= delay) break;
      logger.debug(`Radio not yet ready (attempt ${attempt}), retrying in ${delay}ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    throw new RadioError({
      code: RadioErrorCode.OPERATION_TIMEOUT,
      message: `Radio did not respond within ${totalTimeoutMs}ms after power-on`,
      userMessage: 'Radio did not respond after power-on',
      suggestions: ['Verify the radio actually powered on', 'Check CAT cable / network connectivity'],
    });
  }

  /**
   * 标记即将发生的断线为"有意"（不触发自动重连）
   * PowerController 在 powerOff/powerStandby 前调用
   */
  markIntentionalDisconnect(reason?: string): void {
    this.intentionalDisconnectFlag = { active: true, reason };
    logger.info(`Marked intentional disconnect: ${reason || 'no reason'}`);
  }

  /**
   * 查询 intentional disconnect 标志（不清除）
   */
  isIntentionalDisconnect(): boolean {
    return this.intentionalDisconnectFlag.active;
  }

  /**
   * 读取并清除 intentional disconnect 标志
   */
  consumeIntentionalDisconnect(): { active: boolean; reason?: string } {
    const snapshot = this.intentionalDisconnectFlag;
    this.intentionalDisconnectFlag = { active: false };
    return snapshot;
  }

  /**
   * 断开连接（外部接口，会触发事件）
   */
  async disconnect(reason?: string): Promise<void> {
    // 防重入保护：避免重复断开导致 hamlib 线程冲突
    if (this.isDisconnecting) {
      logger.warn('Disconnect already in progress, skipping');
      return;
    }

    this.isDisconnecting = true;

    try {
      const fastShutdown = isProcessShuttingDown();
      logger.info(`Disconnecting: ${reason || 'user request'}`);

      this.stopFrequencyMonitoring();
      this.stopTunerMonitoring();

      // 先主动清理连接资源
      if (this.connection) {
        try { await this.connection.disconnect(reason); } catch {}
        this.cleanupConnectionListeners();
        this.connection = null;
      }

      // 然后通知状态机
      if (this.radioActor) {
        this.radioActor.send({ type: 'DISCONNECT', reason });
        if (!fastShutdown) {
          try { await this.waitForState(RadioState.DISCONNECTED, 5000); } catch {}
        } else {
          logger.info('Skipping radio state wait during process shutdown');
        }
      }
    } finally {
      this.isDisconnecting = false;
    }

    // isDisconnecting 已恢复 false，手动发出事件（单一事件出口）
    this.emit('disconnected', reason);
  }

  /**
   * 停止自动重连
   */
  stopReconnect(): void {
    this.radioActor?.send({ type: 'STOP_RECONNECT' });
  }

  /**
   * 获取重连进度
   */
  getReconnectProgress(): ReconnectProgress | undefined {
    if (!this.radioActor) return undefined;
    const ctx = getRadioContext(this.radioActor);
    if (ctx.reconnectAttempt === 0) return undefined;
    return {
      attempt: ctx.reconnectAttempt,
      maxAttempts: ctx.maxReconnectAttempts,
      nextRetryMs: ctx.reconnectDelayMs,
    };
  }

  /**
   * 重新连接（统一的连接方法）
   * 使用当前配置重新连接电台
   */
  async reconnect(): Promise<void> {
    logger.info('Reconnect requested');

    if (!this.radioActor) {
      logger.error('State machine not initialized');
      throw new Error('state machine not initialized');
    }

    if (!this.currentConfig) {
      throw new Error('no valid configuration for reconnection');
    }

    if (this.currentConfig.type === 'none') {
      logger.info('No radio configured, reconnect skipped');
      return;
    }

    // 使用 CONNECT 事件重新连接
    this.radioActor.send({ type: 'CONNECT', config: this.currentConfig });

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
   * 获取精细化连接状态
   */
  getConnectionStatus(): RadioConnectionStatus {
    if (this.currentConfig.type === 'none') {
      return RadioConnectionStatus.NOT_CONFIGURED;
    }
    if (!this.radioActor) {
      return RadioConnectionStatus.DISCONNECTED;
    }

    const snapshot = this.radioActor.getSnapshot();
    switch (snapshot.value) {
      case RadioState.DISCONNECTED:
        return RadioConnectionStatus.DISCONNECTED;
      case RadioState.CONNECTING:
        return RadioConnectionStatus.CONNECTING;
      case RadioState.CONNECTED:
        return RadioConnectionStatus.CONNECTED;
      case RadioState.RECONNECTING:
        return RadioConnectionStatus.RECONNECTING;
      default:
        return RadioConnectionStatus.DISCONNECTED;
    }
  }

  /**
   * 获取连接健康状态（简化版）
   */
  getConnectionHealth(): { connectionHealthy: boolean } {
    if (!this.radioActor) {
      return { connectionHealthy: false };
    }

    const context = getRadioContext(this.radioActor);
    return { connectionHealthy: context.isHealthy };
  }

  getKnownFrequency(): number | null {
    return this.lastKnownFrequency;
  }

  /**
   * 获取当前连接会话的核心能力摘要。
   * 仅在明确判定 unsupported 时返回 false；unknown 与 supported 都返回 true。
   */
  getCoreCapabilities(): CoreRadioCapabilities {
    return {
      readFrequency: this.coreCapabilityStates.readFrequency !== 'unsupported',
      writeFrequency: this.coreCapabilityStates.writeFrequency !== 'unsupported',
      readRadioMode: this.coreCapabilityStates.readRadioMode !== 'unsupported',
      writeRadioMode: this.coreCapabilityStates.writeRadioMode !== 'unsupported',
    };
  }

  getCoreCapabilityDiagnostics(): CoreCapabilityDiagnostics {
    return { ...this.coreCapabilityDiagnostics };
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

    // NullConnection 无电台信息
    if (config.type === 'none') {
      return null;
    }

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
          logger.warn(`Rig model ${config.serial.rigModel} not found in supported list`);
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
      logger.error('Radio not connected, cannot set frequency');
      return false;
    }

    if (this.isCoreCapabilityUnsupported('writeFrequency')) {
      logger.debug('Skipping setFrequency because write frequency is marked unsupported');
      return false;
    }

    try {
      await this.connection.setFrequency(freq);
      this.markCoreCapabilitySupported('writeFrequency');
      this.updateKnownFrequency(freq);
      logger.debug(`Frequency set: ${(freq / 1000000).toFixed(3)} MHz`);
      return true;
    } catch (error) {
      if (isRecoverableOptionalRadioError(error)) {
        this.markCoreCapabilityUnsupported('writeFrequency', error);
        logger.warn(`Frequency write is unavailable for this radio: ${(error as Error).message}`);
        return false;
      }
      logger.error(`Failed to set frequency: ${(error as Error).message}`);
      this.handleConnectionError(error as Error);
      return false;
    }
  }

  async applyOperatingState(request: ApplyOperatingStateRequest): Promise<ApplyOperatingStateResult> {
    if (!this.connection) {
      throw new Error('radio not connected');
    }

    if (request.frequency !== undefined && this.isCoreCapabilityUnsupported('writeFrequency')) {
      return {
        frequencyApplied: false,
        modeApplied: false,
        modeError: request.mode ? new Error('set mode skipped because frequency control is not available') : undefined,
      };
    }

    if (request.mode && request.frequency === undefined && this.isCoreCapabilityUnsupported('writeRadioMode')) {
      throw new Error('set mode failed: radio mode control not supported');
    }

    try {
      const result = await this.connection.applyOperatingState(request);

      if (request.frequency !== undefined && result.frequencyApplied) {
        this.markCoreCapabilitySupported('writeFrequency');
        this.updateKnownFrequency(request.frequency);
      }

      if (request.mode && result.modeApplied) {
        this.markCoreCapabilitySupported('writeRadioMode');
      }

      if (result.modeError) {
        if (isRecoverableOptionalRadioError(result.modeError)) {
          this.markCoreCapabilityUnsupported('writeRadioMode', result.modeError);
        } else if (!request.tolerateModeFailure) {
          this.handleConnectionError(result.modeError);
        } else {
          logger.warn('Radio mode write failed during tolerated operating-state update', result.modeError);
        }
      }

      return result;
    } catch (error) {
      if (request.mode && request.frequency === undefined && isRecoverableOptionalRadioError(error)) {
        this.markCoreCapabilityUnsupported('writeRadioMode', error);
        throw new Error(`set mode failed: ${(error as Error).message}`);
      }

      if (request.frequency !== undefined && isRecoverableOptionalRadioError(error)) {
        this.markCoreCapabilityUnsupported('writeFrequency', error);
        return { frequencyApplied: false, modeApplied: false };
      }

      this.handleConnectionError(error as Error);
      throw error;
    }
  }

  /**
   * 获取当前频率
   */
  async getFrequency(): Promise<number> {
    if (!this.connection) {
      logger.error('Radio not connected, cannot get frequency');
      return 0;
    }

    if (this.isCoreCapabilityUnsupported('readFrequency')) {
      logger.debug('Skipping getFrequency because read frequency is marked unsupported');
      return 0;
    }

    try {
      const frequency = await this.connection.getFrequency();
      this.markCoreCapabilitySupported('readFrequency');
      if (frequency > 0) {
        this.updateKnownFrequency(frequency);
      }
      return frequency;
    } catch (error) {
      if (isRecoverableOptionalRadioError(error)) {
        this.markCoreCapabilityUnsupported('readFrequency', error);
        logger.warn(`Frequency read is unavailable for this radio: ${(error as Error).message}`);
        return 0;
      }
      logger.error(`Failed to get frequency: ${(error as Error).message}`);
      this.handleConnectionError(error as Error);
      return 0;
    }
  }

  /**
   * 设置 PTT
   */
  async setPTT(state: boolean): Promise<void> {
    if (!this.connection) {
      logger.error('Radio not connected, cannot set PTT');
      return;
    }

    try {
      logger.debug(`PTT ${state ? 'TX' : 'RX'} start`);

      await this.connection.setPTT(state);

      logger.debug(`PTT set: ${state ? 'TX' : 'RX'}`);
    } catch (error) {
      logger.error(
        `PTT ${state ? 'TX' : 'RX'} failed: ${(error as Error).message}`
      );
      this.handleConnectionError(error as Error);
    }
  }

  /**
   * Notify subsystems about PTT state for I/O scheduling.
   * Pauses capability polling and frequency monitoring during TX.
   */
  setPTTActive(active: boolean): void {
    this._isPTTActive = active;
    this.capabilityManager.setPTTActive(active);
    logger.debug('PTT state updated for I/O scheduling', { active });
  }

  /**
   * 测试连接
   */
  async testConnection(): Promise<void> {
    if (!this.connection) {
      throw new Error('radio not connected, cannot test connection');
    }

    try {
      const currentFreq = await this.connection.getFrequency();
      logger.info(`Connection test passed, current frequency: ${(currentFreq / 1000000).toFixed(3)} MHz`);
    } catch (error) {
      logger.error(`Connection test failed: ${(error as Error).message}`);
      this.handleConnectionError(error as Error);
      throw error;
    }
  }

  /**
   * 设置模式
   */
  async setMode(mode: string, bandwidth?: RadioModeBandwidth, options?: SetRadioModeOptions): Promise<void> {
    if (!this.connection) {
      throw new Error('radio not connected');
    }

    if (this.isCoreCapabilityUnsupported('writeRadioMode')) {
      throw new Error('set mode failed: radio mode control not supported');
    }

    try {
      await this.connection.setMode(mode, bandwidth, options);
      this.markCoreCapabilitySupported('writeRadioMode');
      logger.info(`Mode set: ${mode}${bandwidth ? ` (${bandwidth})` : ''}`, {
        intent: options?.intent ?? 'unspecified',
      });
    } catch (error) {
      if (isRecoverableOptionalRadioError(error)) {
        this.markCoreCapabilityUnsupported('writeRadioMode', error);
        throw new Error(`set mode failed: ${(error as Error).message}`);
      }
      this.handleConnectionError(error as Error);
      throw new Error(`set mode failed: ${(error as Error).message}`);
    }
  }

  /**
   * 获取当前模式
   */
  async getMode(): Promise<RadioModeInfo> {
    if (!this.connection) {
      throw new Error('radio not connected');
    }

    if (this.isCoreCapabilityUnsupported('readRadioMode')) {
      throw new Error('get mode failed: radio mode read not supported');
    }

    try {
      const modeInfo = await this.connection.getMode();
      this.markCoreCapabilitySupported('readRadioMode');
      // logger.debug(`Mode read: ${modeInfo.mode}`);
      return modeInfo;
    } catch (error) {
      if (isRecoverableOptionalRadioError(error)) {
        this.markCoreCapabilityUnsupported('readRadioMode', error);
        logger.warn(`Mode read failed but connection remains healthy: ${(error as Error).message}`);
        throw new Error(`get mode failed: ${(error as Error).message}`);
      }

      this.handleConnectionError(error as Error);
      throw new Error(`get mode failed: ${(error as Error).message}`);
    }
  }

  // ==================== 天线调谐器控制 ====================

  /**
   * 获取天线调谐器能力
   */
  async getTunerCapabilities(): Promise<import('@tx5dr/contracts').TunerCapabilities> {
    if (this.cachedTunerCapabilities) {
      return this.cachedTunerCapabilities;
    }

    if (!this.connection) {
      logger.error('Radio not connected, cannot get tuner capabilities');
      return createUnsupportedTunerCapabilities();
    }

    // 检查连接是否实现了天调方法
    if (!this.connection.getTunerCapabilities) {
      logger.debug('Current connection does not support tuner capabilities');
      const capabilities = createUnsupportedTunerCapabilities();
      this.cachedTunerCapabilities = capabilities;
      return capabilities;
    }

    try {
      const capabilities = await this.connection.getTunerCapabilities();
      this.cachedTunerCapabilities = capabilities;
      logger.debug('Tuner capabilities', capabilities);
      return capabilities;
    } catch (error) {
      // 天调能力查询失败不影响主连接状态（某些电台不支持 TUNER 功能查询）
      logger.warn(`Failed to get tuner capabilities (does not affect main connection): ${(error as Error).message}`);
      const capabilities = createUnsupportedTunerCapabilities();
      this.cachedTunerCapabilities = capabilities;
      return capabilities;
    }
  }

  /**
   * 获取电台数值表能力
   */
  getMeterCapabilities(): MeterCapabilities | undefined {
    if (!this.connection?.getMeterCapabilities) {
      return undefined;
    }
    return this.connection.getMeterCapabilities();
  }

  // ===== 统一能力系统公共接口 =====

  /**
   * 获取当前所有能力的状态快照（用于 REST 接口和客户端首次连接）
   */
  getCapabilitySnapshot(): { descriptors: CapabilityDescriptor[]; capabilities: CapabilityState[] } {
    return this.capabilityManager.getCapabilitySnapshot();
  }

  /**
   * Refresh all capability values on demand (triggered by frontend button).
   */
  async refreshCapabilities(): Promise<void> {
    await this.capabilityManager.refreshAll();
  }

  /**
   * 写入能力值（由 WSServer 命令处理器和 REST 接口调用）
   */
  async writeCapability(
    id: string,
    value?: boolean | number,
    action?: boolean,
  ): Promise<void> {
    if (id === 'tuner_switch') {
      if (typeof value !== 'boolean') {
        throw new Error('tuner_switch expects a boolean value');
      }

      await this.setTuner(value);
      return;
    }

    if (id === 'tuner_tune' && action) {
      const result = await this.startTuning();
      if (!result) {
        throw new Error('manual tuning failed');
      }
      return;
    }

    return this.capabilityManager.writeCapability(id, value, action);
  }

  /**
   * 设置天线调谐器开关
   */
  async setTuner(enabled: boolean): Promise<void> {
    if (!this.connection) {
      throw new Error('radio not connected, cannot control tuner');
    }

    if (!this.connection.setTuner) {
      throw new Error('radio does not support tuner control');
    }

    try {
      logger.info(`${enabled ? 'Enabling' : 'Disabling'} tuner`);

      await this.connection.setTuner(enabled);

      logger.info(`Tuner ${enabled ? 'enabled' : 'disabled'}`);

      // 获取更新后的状态并广播事件
      const status = await this.getTunerStatus();
      this.capabilityManager.syncTunerStatus(status);
      this.emit('tunerStatusChanged', status);
    } catch (error) {
      // 天调设置失败不影响主连接状态
      logger.error(`Failed to set tuner: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * 获取天线调谐器状态
   */
  async getTunerStatus(): Promise<import('@tx5dr/contracts').TunerStatus> {
    if (!this.connection) {
      logger.error('Radio not connected, cannot get tuner status');
      // 返回默认状态
      return {
        enabled: false,
        active: false,
        status: 'idle',
      };
    }

    if (!this.connection.getTunerStatus) {
      logger.debug('Current connection does not support tuner status query');
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
      // 天调状态查询失败不影响主连接状态（某些电台不支持 TUNER 功能查询）
      logger.warn(`Failed to get tuner status (does not affect main connection): ${(error as Error).message}`);
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
      throw new Error('radio not connected, cannot start tuning');
    }

    if (!this.connection.startTuning) {
      throw new Error('radio does not support manual tuning');
    }

    try {
      logger.info('Starting manual tuning');

      // 启动前先标记为调谐中（如果支持状态查询）
      if (this.connection.getTunerStatus) {
        const beforeStatus: import('@tx5dr/contracts').TunerStatus = {
          enabled: true,
          active: true,
          status: 'tuning',
        };
        this.capabilityManager.syncTunerStatus(beforeStatus);
        this.emit('tunerStatusChanged', beforeStatus);
      }

      const result = await this.connection.startTuning();

      logger.info(`Tuning ${result ? 'succeeded' : 'failed'}`);

      // 调谐完成后获取最新状态
      if (this.connection.getTunerStatus) {
        const afterStatus = await this.getTunerStatus();
        // 根据结果更新状态
        afterStatus.status = result ? 'success' : 'failed';
        afterStatus.active = false;
        this.capabilityManager.syncTunerStatus(afterStatus);
        this.emit('tunerStatusChanged', afterStatus);
      }

      return result;
    } catch (error) {
      // 调谐失败不影响主连接状态
      logger.error(`Failed to start tuning: ${(error as Error).message}`);

      // 调谐失败，广播失败状态
      if (this.connection.getTunerStatus) {
        const failedStatus: import('@tx5dr/contracts').TunerStatus = {
          enabled: true,
          active: false,
          status: 'failed',
        };
        this.capabilityManager.syncTunerStatus(failedStatus);
        this.emit('tunerStatusChanged', failedStatus);
      }

      throw error;
    }
  }

  /**
   * 获取信号强度
   */
  async getSignalStrength(): Promise<number> {
    if (!this.connection) {
      throw new Error('radio not connected');
    }

    try {
      // IRadioConnection 接口目前没有 getSignalStrength，需要扩展
      throw new Error('getSignalStrength not implemented');
    } catch (error) {
      this.handleConnectionError(error as Error);
      throw new Error(`get signal strength failed: ${(error as Error).message}`);
    }
  }

  /**
   * 获取电台状态
   */
  async getRadioStatus(): Promise<{
    frequency: number;
    mode: RadioModeInfo;
    signalStrength?: number;
  }> {
    if (!this.connection) {
      throw new Error('radio not connected');
    }

    try {
      const frequency = await this.getFrequency();
      // mode 和 signalStrength 需要接口扩展
      return {
        frequency,
        mode: { mode: 'UNKNOWN', bandwidth: 'UNKNOWN' },
      };
    } catch (error) {
      throw new Error(`get radio status failed: ${(error as Error).message}`);
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

  /**
   * 获取当前活动连接
   */
  getActiveConnection(): IRadioConnection | null {
    return this.connection;
  }

  private isCoreCapabilityUnsupported(key: CoreCapabilityKey): boolean {
    return this.coreCapabilityStates[key] === 'unsupported';
  }

  private markCoreCapabilitySupported(key: CoreCapabilityKey): void {
    delete this.coreCapabilityDiagnostics[key];
    this.updateCoreCapabilityState(key, 'supported');
  }

  private markCoreCapabilityUnsupported(key: CoreCapabilityKey, error: unknown): void {
    if (!this.coreCapabilityDiagnostics[key]) {
      this.coreCapabilityDiagnostics[key] = {
        capability: key,
        message: buildCapabilityDiagnosticMessage(error),
        stack: buildCapabilityDiagnosticStack(error),
        recordedAt: Date.now(),
      };
    }
    const message = buildCapabilityDiagnosticMessage(error);
    this.updateCoreCapabilityState(key, 'unsupported', message);
  }

  private resetCoreCapabilities(): void {
    const previous = JSON.stringify(this.getCoreCapabilities());
    this.coreCapabilityStates = createInitialCoreCapabilityStates();
    this.coreCapabilityDiagnostics = {};
    if (JSON.stringify(this.getCoreCapabilities()) !== previous) {
      this.emit('coreCapabilitiesChanged', this.getCoreCapabilities());
    }
  }

  private updateCoreCapabilityState(
    key: CoreCapabilityKey,
    nextState: CoreCapabilityState,
    reason?: string,
  ): void {
    const previousState = this.coreCapabilityStates[key];
    if (previousState === nextState) {
      return;
    }

    const previousCapabilities = JSON.stringify(this.getCoreCapabilities());
    this.coreCapabilityStates[key] = nextState;

    if (nextState === 'unsupported') {
      logger.info(`Core radio capability marked unsupported: ${CORE_CAPABILITY_LABELS[key]}`, {
        key,
        reason,
      });
    } else if (previousState === 'unsupported' && nextState === 'unknown') {
      logger.debug(`Core radio capability reset: ${CORE_CAPABILITY_LABELS[key]}`);
    } else if (previousState === 'unknown' && nextState === 'supported') {
      logger.debug(`Core radio capability confirmed: ${CORE_CAPABILITY_LABELS[key]}`);
    }

    if (JSON.stringify(this.getCoreCapabilities()) !== previousCapabilities) {
      this.emit('coreCapabilitiesChanged', this.getCoreCapabilities());
    }
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
      logger.warn('Failed to get HamLib supported rig list:', (error as Error).message);
      return [];
    }
  }

  static async getRigConfigSchema(rigModel: number): Promise<{
    rigModel: number;
    portType: string;
    endpointKind: RigEndpointKind;
    fields: RigConfigFieldSchema[];
  }> {
    try {
      const hamlibModule = await import('hamlib');
      const { HamLib } = hamlibModule;
      const rig = new HamLib(rigModel) as any;
      const fields = typeof rig.getConfigSchema === 'function' ? rig.getConfigSchema() : [];
      const portCaps = typeof rig.getPortCaps === 'function' ? rig.getPortCaps() as HamlibPortCaps : undefined;
      await rig.destroy().catch(() => {});

      const portType = typeof portCaps?.portType === 'string' ? portCaps.portType : 'other';
      return {
        rigModel,
        portType,
        endpointKind: deriveRigEndpointKind(portType),
        fields: enrichRigConfigFields(fields, portCaps),
      };
    } catch (error) {
      logger.warn('Failed to get HamLib rig config schema', { rigModel, error });
      return {
        rigModel,
        portType: 'other',
        endpointKind: 'device-path',
        fields: [],
      };
    }
  }

  // ==================== 内部方法 ====================

  /**
   * 初始化状态机
   */
  private async initializeStateMachine(_config: HamlibConfig): Promise<void> {
    logger.info('Initializing state machine');

    const radioInput: RadioInput = {
      healthCheckInterval: 3000, // 3秒

      // 连接回调 - 使用传入的配置参数
      onConnect: async (cfg: HamlibConfig) => {
        logger.debug('State machine callback: onConnect');
        // 如果连接已经由 wake flow 建立（control-only → promoted → bootstrapped），
        // 则跳过重新连接，让状态机直接进入 CONNECTED
        if (this.connection && this.connection.getState() === RadioConnectionState.CONNECTED) {
          logger.info('Connection already established (wake flow), onConnect short-circuited');
          return;
        }
        // 如果未传入配置，回退到从 ConfigManager 读取
        if (!cfg) {
          logger.error('onConnect callback received no config, falling back to ConfigManager');
          cfg = this.configManager.getRadioConfig();
        }
        logger.debug(`Using config type: ${cfg.type}`,
                    cfg.type === 'icom-wlan' ? { ip: cfg.icomWlan?.ip, port: cfg.icomWlan?.port } : {});
        await this.doConnect(cfg);
      },

      // 断开回调
      onDisconnect: async (_reason?: string) => {
        logger.debug(`State machine callback: onDisconnect (${_reason || ''})`);
        await this.doDisconnect(_reason);
      },

      // 错误回调（在 DISCONNECTED entry 的 clearError 清除 context.error 之前触发）
      onError: (error: Error) => {
        logger.error(`State machine error: ${error.message}`);
        // 保存错误供 waitForConnected 使用（context.error 在 DISCONNECTED entry action 中会被清除）
        this.pendingConnectionError = error;
        this.emit('error', error);
      },
    };

    this.radioActor = createRadioActor(radioInput, {
      id: 'physicalRadio',
      devTools: process.env.NODE_ENV === 'development',
    });

    // 通过 subscribe 监听状态变化（替代 notifyStateChange action）
    // XState v5 中 subscribe 回调在状态完全稳定后触发，snapshot.value 保证正确
    // 注意：RECONNECTING 自转（retry 2→3→4→5）时 snapshot.value 不变，
    // 需要额外检测 reconnectAttempt 变化来识别重入
    let prevState: string | undefined;
    let prevReconnectAttempt: number = 0;
    // 状态机刚 start 时会立即触发一次 subscribe 回调，推送初始状态（DISCONNECTED）。
    // 这是"默认值"而非真实的状态转换事件；在 wake flow 下此时 connection 已处于
    // CONNECTED 态，若误触发 handleStateChange 会调用 cleanupAfterDisconnect
    // 把 connection 清成 null，进而导致后续 CONNECT 事件无法短路、重新走一遍
    // 完整连接流程。此处跳过初始发射。
    let isInitialEmit = true;
    this.radioActor.subscribe((snapshot) => {
      const state = snapshot.value as RadioState;
      const reconnectAttempt = snapshot.context.reconnectAttempt ?? 0;

      if (isInitialEmit) {
        isInitialEmit = false;
        prevState = state;
        prevReconnectAttempt = reconnectAttempt;
        logger.debug(`State machine initial state (skipping handler): ${state}`);
        return;
      }

      if (state !== prevState ||
          (state === RadioState.RECONNECTING && reconnectAttempt !== prevReconnectAttempt)) {
        prevState = state;
        prevReconnectAttempt = reconnectAttempt;
        logger.info(`State transition: ${state}`);
        this.handleStateChange(state, snapshot.context);
      }
    });

    this.radioActor.start();

    logger.info('State machine initialized');
  }

  /**
   * 执行连接（状态机回调）
   */
  private async doConnect(config: HamlibConfig): Promise<void> {
    logger.info(`Executing connection: ${config.type}`);
    this.resetConnectionSessionState();
    await this.prepareConnectionSession(config);

    const connection = this.createConnectionSession(config);
    await this.openConnectionSession(connection, config);
    await this.bootstrapConnectedSession(connection);
    this.activateConnectedSession(connection);

    logger.info('Connection established');
  }

  private resetConnectionSessionState(): void {
    this.resetCoreCapabilities();
    this.cachedTunerCapabilities = null;
  }

  private async prepareConnectionSession(config: HamlibConfig): Promise<void> {
    if (!this.connection) {
      return;
    }

    logger.debug('Cleaning up old connection');
    this.cleanupConnectionListeners();
    try { await this.connection.disconnect('preparing new connection'); } catch {}
    this.connection = null;

    if (config.type === 'icom-wlan') {
      logger.debug('Waiting for ICOM radio to release old connection');
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }

  private createConnectionSession(config: HamlibConfig): IRadioConnection {
    const connection = RadioConnectionFactory.create(config);
    this.connection = connection;
    this.setupConnectionEventForwarding();
    return connection;
  }

  private async openConnectionSession(connection: IRadioConnection, config: HamlibConfig): Promise<void> {
    await connection.connect(config);

    if (!connection.isHealthy()) {
      throw new Error('connection health check failed');
    }
  }

  private activateConnectedSession(connection: IRadioConnection): void {
    connection.startBackgroundTasks?.();
    this.startFrequencyMonitoring();
    void this.startTunerMonitoring();
  }

  private async bootstrapConnectedSession(connection: IRadioConnection): Promise<void> {
    logger.debug('Bootstrap phase: settle');
    await this.waitForConnectionSettle();

    logger.debug('Bootstrap phase: tuner capabilities');
    this.cachedTunerCapabilities = await this.readTunerCapabilities(connection);

    logger.debug('Bootstrap phase: restore frequency');
    const restoredFrequency = await this.restoreSavedFrequencyIfAvailable();

    logger.debug('Bootstrap phase: capability manager');
    await this.capabilityManager.onConnected(connection);

    if (restoredFrequency !== null) {
      this.updateKnownFrequency(restoredFrequency);
      this.emit('radioFrequencyChanged', restoredFrequency);
      return;
    }

    logger.debug('Bootstrap phase: capture initial frequency');
    await this.captureInitialFrequency();
  }

  /**
   * 执行断开（状态机回调，内部不触发事件）
   */
  private async doDisconnect(reason?: string): Promise<void> {
    logger.info(`Executing disconnect: ${reason || ''}`);

    this.stopFrequencyMonitoring();
    this.stopTunerMonitoring();
    this.capabilityManager.onDisconnected();
    this.cachedTunerCapabilities = null;
    this.resetCoreCapabilities();

    if (this.connection) {
      try {
        await this.connection.disconnect(reason);
      } catch (error) {
        logger.warn(`Error during disconnect: ${(error as Error).message}`);
      }

      this.cleanupConnectionListeners();
      this.connection = null;
    }

    logger.info('Disconnected');
  }

  /**
   * 内部断开（不触发外部事件，用于 applyConfig）
   */
  private async internalDisconnect(reason?: string): Promise<void> {
    logger.info(`Internal disconnect: ${reason || ''}`);

    this.stopFrequencyMonitoring();
    this.stopTunerMonitoring();

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

    logger.debug('Setting up connection event forwarding');

    // 监听 connection 的 disconnected 事件 → 通知状态机
    const onDisconnected = (...args: any[]) => {
      const reason = args[0] as string | undefined;
      logger.warn(`Connection lost: ${reason || 'unknown'}`);
      // 用户主动切换电源（off/standby/operate）时已设置 intentional 标志，
      // 不要让状态机触发重连（flag 由 RadioBridge.handleRadioDisconnected 消费）
      if (this.intentionalDisconnectFlag.active) {
        logger.info('Intentional disconnect flag active; suppressing CONNECTION_LOST');
        return;
      }
      if (this.radioActor && !this.isDisconnecting) {
        this.radioActor.send({ type: 'CONNECTION_LOST', reason });
      }
    };
    this.connection.on('disconnected', onDisconnected);
    this.connectionEventListeners.set('disconnected', onDisconnected);

    // 错误 → 转发给上层（RadioBridge）+ 通知状态机
    const onError = (error: Error) => {
      logger.error(`Connection error: ${error.message}`);
      // 向上层转发错误（RadioBridge 监听此事件推送到前端）
      this.emit('error', error);
      // 用户主动切换电源期间，底层 CAT 经常出现 "Command rejected" 类错误，
      // 不要让它们触发 HEALTH_CHECK_FAILED → 重连循环
      if (this.intentionalDisconnectFlag.active) {
        logger.info('Intentional disconnect flag active; suppressing HEALTH_CHECK_FAILED');
        return;
      }
      // 同时通知状态机触发重连逻辑
      if (this.radioActor && !this.isDisconnecting) {
        this.radioActor.send({ type: 'HEALTH_CHECK_FAILED', error });
      }
    };
    this.connection.on('error', onError);
    this.connectionEventListeners.set('error', onError);

    // 频率变化（来自 IRadioConnection）
    const onFrequencyChanged = (frequency: number) => {
      logger.debug(`Frequency changed: ${(frequency / 1000000).toFixed(3)} MHz`);
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
  }

  /**
   * 清理连接事件监听器
   */
  private cleanupConnectionListeners(): void {
    if (!this.connection) return;

    logger.debug('Cleaning up connection event listeners');

    for (const [event, listener] of this.connectionEventListeners.entries()) {
      this.connection.off(event as any, listener);
    }

    this.connectionEventListeners.clear();
  }

  /**
   * 处理状态机状态变化
   */
  private handleStateChange(state: RadioState, context: any): void {
    logger.info(`State machine state: ${state}`);

    switch (state) {
      case RadioState.CONNECTING:
        this.emit('connecting');
        break;

      case RadioState.CONNECTED:
        this.emit('connected');
        break;

      case RadioState.DISCONNECTED:
        // 被动断线时（非用户主动 disconnect），清理资源并发出事件
        if (!this.isDisconnecting) {
          this.cleanupAfterDisconnect();
          this.emit('disconnected', context.disconnectReason);
        }
        // 用户主动 disconnect() 时，isDisconnecting=true，事件由 disconnect() 方法发出
        break;

      case RadioState.RECONNECTING:
        logger.debug(`Reconnecting attempt ${context.reconnectAttempt}/${context.maxReconnectAttempts}, next retry in ${context.reconnectDelayMs}ms`);
        this.emit('reconnecting', context.reconnectAttempt, context.maxReconnectAttempts, context.reconnectDelayMs);
        break;

    }
  }

  /**
   * 被动断线后清理连接资源
   */
  private cleanupAfterDisconnect(): void {
    this.stopFrequencyMonitoring();
    this.stopTunerMonitoring();
    this.capabilityManager.onDisconnected();
    this.cachedTunerCapabilities = null;
    this.resetCoreCapabilities();
    if (this.connection) {
      this.cleanupConnectionListeners();
      // 不调用 connection.disconnect()，因为连接已断（被动断线）
      this.connection = null;
    }
  }

  private async waitForConnectionSettle(): Promise<void> {
    if (this.postConnectSettleMs > 0) {
      logger.debug(`Waiting ${this.postConnectSettleMs}ms before post-connect bootstrap`);
      await new Promise((resolve) => setTimeout(resolve, this.postConnectSettleMs));
    }
  }

  private async readTunerCapabilities(connection: IRadioConnection): Promise<TunerCapabilities> {
    if (!connection.getTunerCapabilities) {
      logger.debug('Current connection does not support tuner capabilities');
      return createUnsupportedTunerCapabilities();
    }

    try {
      const capabilities = await connection.getTunerCapabilities();
      logger.debug('Cached tuner capabilities after connect', capabilities);
      return capabilities;
    } catch (error) {
      logger.warn(`Failed to read tuner capabilities during bootstrap: ${(error as Error).message}`);
      return createUnsupportedTunerCapabilities();
    }
  }

  private async restoreSavedFrequencyIfAvailable(): Promise<number | null> {
    const targetFrequency = this.getSavedStartupFrequency();
    if (!targetFrequency) {
      logger.info('No saved frequency config, skipping bootstrap restore');
      return null;
    }

    const success = await this.setFrequency(targetFrequency);
    if (!success) {
      logger.warn(`Bootstrap frequency restore failed: ${(targetFrequency / 1000000).toFixed(3)} MHz`);
      return null;
    }

    logger.info(`Bootstrap frequency restored: ${(targetFrequency / 1000000).toFixed(3)} MHz`);
    return targetFrequency;
  }

  private getSavedStartupFrequency(): number | null {
    const engineMode = this.configManager.getLastEngineMode();

    if (engineMode === 'voice') {
      const lastVoice = this.configManager.getLastVoiceFrequency();
      if (lastVoice?.frequency) {
        logger.info(`Restoring voice frequency during bootstrap: ${(lastVoice.frequency / 1000000).toFixed(3)} MHz (${lastVoice.description || lastVoice.radioMode || 'voice'})`);
        return lastVoice.frequency;
      }
      return null;
    }

    const lastDigital = this.configManager.getLastSelectedFrequency();
    if (lastDigital?.frequency) {
      logger.info(`Restoring digital frequency during bootstrap: ${(lastDigital.frequency / 1000000).toFixed(3)} MHz (${lastDigital.description || lastDigital.mode})`);
      return lastDigital.frequency;
    }

    return null;
  }

  private async captureInitialFrequency(): Promise<void> {
    if (!this.connection || this.isCoreCapabilityUnsupported('readFrequency')) {
      return;
    }

    try {
      const currentFrequency = await this.getFrequency();
      if (currentFrequency > 0) {
        logger.debug(`Captured initial frequency during bootstrap: ${(currentFrequency / 1000000).toFixed(3)} MHz`);
        this.updateKnownFrequency(currentFrequency);
      }
    } catch (error) {
      logger.debug(`Initial frequency capture skipped: ${(error as Error).message}`);
    }
  }

  private updateKnownFrequency(frequency: number): void {
    if (!this.connection || frequency <= 0) {
      return;
    }

    this.lastKnownFrequency = frequency;
    this.connection.setKnownFrequency(frequency);
  }

  /**
   * 处理连接错误
   */
  private handleConnectionError(error: Error): void {
    logger.error(`Connection error: ${error.message}`);

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
      throw new Error('state machine not initialized');
    }

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        subscription?.unsubscribe();
        reject(new Error('waiting for connection timed out'));
      }, timeout);

      // 注意：此方法在 CONNECT 事件发送之后调用，此时状态已经是 CONNECTING 或更后面。
      // XState v5 的 subscribe 不会对当前状态触发回调，只对后续状态变化触发。
      // 因此任何 DISCONNECTED 状态都意味着连接失败（不需要 hasSeenConnecting 守卫）。
      const subscription = this.radioActor!.subscribe((snapshot) => {
        if (snapshot.value === RadioState.CONNECTED) {
          clearTimeout(timeoutId);
          subscription?.unsubscribe();
          this.pendingConnectionError = undefined;
          resolve();
        } else if (snapshot.value === RadioState.DISCONNECTED) {
          // 连接失败回到 DISCONNECTED，立即 reject（不等 30 秒超时）
          // 注意：DISCONNECTED entry action 会清除 context.error，
          // 所以使用 pendingConnectionError（由 onError 回调在清除前保存）
          clearTimeout(timeoutId);
          subscription?.unsubscribe();
          const err = this.pendingConnectionError || new Error('connection failed');
          this.pendingConnectionError = undefined;
          reject(err);
        }
      });

      // 立即检查当前状态（处理极快连接成功或已失败的情况）
      const currentState = this.radioActor!.getSnapshot().value;
      if (currentState === RadioState.CONNECTED) {
        clearTimeout(timeoutId);
        subscription?.unsubscribe();
        this.pendingConnectionError = undefined;
        resolve();
      } else if (currentState === RadioState.DISCONNECTED) {
        // 连接已经失败（比 subscribe 创建还快）
        clearTimeout(timeoutId);
        subscription?.unsubscribe();
        const err = this.pendingConnectionError || new Error('connection failed');
        this.pendingConnectionError = undefined;
        reject(err);
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
      throw new Error('state machine not initialized');
    }

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        subscription?.unsubscribe();
        reject(new Error(`waiting for state ${targetState} timed out`));
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

    logger.debug('Starting frequency monitoring (every 5s)');

    // 启动定时器
    this.frequencyPollingInterval = setInterval(() => {
      void this.checkFrequencyChange();
    }, 5000);
  }

  /**
   * 停止频率监控
   */
  private stopFrequencyMonitoring(): void {
    if (this.frequencyPollingInterval) {
      clearInterval(this.frequencyPollingInterval);
      this.frequencyPollingInterval = null;
      logger.debug('Frequency monitoring stopped');
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

    if (this._isPTTActive) {
      return;
    }

    if (this.connection.isCriticalOperationActive?.()) {
      logger.debug('Skipping frequency monitoring because a critical radio operation is in progress');
      return;
    }

    if (this.isCoreCapabilityUnsupported('readFrequency')) {
      return;
    }

    try {
      const previousKnownFrequency = this.lastKnownFrequency;
      const currentFrequency = await this.getFrequency();

      // 容忍连接初始化期间的 0 返回（CIV 通道可能尚未完全就绪）
      if (currentFrequency === 0) {
        if (previousKnownFrequency === null) {
          logger.debug('Frequency returned 0 (possibly initializing), waiting for next poll');
        }
        return; // 静默跳过，等待下次轮询（5秒后）
      }

      // 频率有效且与上次不同
      if (
        currentFrequency > 0 &&
        currentFrequency !== previousKnownFrequency
      ) {
        logger.debug(
          `Frequency changed: ${
            previousKnownFrequency
              ? (previousKnownFrequency / 1000000).toFixed(3)
              : 'N/A'
          } MHz -> ${(currentFrequency / 1000000).toFixed(3)} MHz`
        );

        this.updateKnownFrequency(currentFrequency);

        // 发射频率变化事件
        this.emit('radioFrequencyChanged', currentFrequency);
      } else if (previousKnownFrequency === null && currentFrequency > 0) {
        // 首次获取频率
        logger.debug(`Initial frequency: ${(currentFrequency / 1000000).toFixed(3)} MHz`);
        this.updateKnownFrequency(currentFrequency);
      }
    } catch (error) {
      // 静默处理错误（getFrequency 已经有错误处理）
    }
  }

  // ==================== 天调状态监控（已迁移至 RadioCapabilityManager，此处已清理）====================

  /** @deprecated Tuner polling moved to RadioCapabilityManager. No-op stubs for safe refactor. */
  private startTunerMonitoring(): void { /* no-op: replaced by RadioCapabilityManager */ }
  /** @deprecated */
  private stopTunerMonitoring(): void { /* no-op: replaced by RadioCapabilityManager */ }

  /**
   * 比较两个配置是否相同
   * 用于防止重复连接相同的配置
   */
  private isConfigIdentical(a: HamlibConfig, b: HamlibConfig): boolean {
    if (a.type !== b.type) {
      return false;
    }

    // 比较 ICOM WLAN 配置
    if (a.type === 'icom-wlan' && b.type === 'icom-wlan') {
      return (
        a.icomWlan?.ip === b.icomWlan?.ip &&
        a.icomWlan?.port === b.icomWlan?.port
      );
    }

    // 比较网络配置
    if (a.type === 'network' && b.type === 'network') {
      return (
        a.network?.host === b.network?.host &&
        a.network?.port === b.network?.port
      );
    }

    // 比较串口配置
    if (a.type === 'serial' && b.type === 'serial') {
      return (
        a.serial?.path === b.serial?.path &&
        a.serial?.rigModel === b.serial?.rigModel
      );
    }

    // none 类型总是相同
    if (a.type === 'none' && b.type === 'none') {
      return true;
    }

    return false;
  }
}
