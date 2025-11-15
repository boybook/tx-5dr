/**
 * IRadioConnection - 统一电台连接接口
 *
 * 为不同的电台连接方式（ICOM WLAN, Hamlib, Serial）提供统一的抽象接口
 * 隔离底层实现差异，统一错误处理和状态管理
 */

import { EventEmitter } from 'eventemitter3';
import type { HamlibConfig, TunerCapabilities, TunerStatus } from '@tx5dr/contracts';

/**
 * 电台连接类型
 */
export enum RadioConnectionType {
  /**
   * ICOM WLAN 网络连接
   */
  ICOM_WLAN = 'icom-wlan',

  /**
   * Hamlib 连接（支持多种型号）
   */
  HAMLIB = 'hamlib',

  /**
   * 串口连接（未来扩展）
   */
  SERIAL = 'serial',
}

/**
 * 电台连接状态
 */
export enum RadioConnectionState {
  /**
   * 未连接
   */
  DISCONNECTED = 'disconnected',

  /**
   * 连接中
   */
  CONNECTING = 'connecting',

  /**
   * 已连接
   */
  CONNECTED = 'connected',

  /**
   * 错误状态
   */
  ERROR = 'error',
}

/**
 * 数值表数据接口（统一格式）
 */
export interface MeterData {
  swr: { raw: number; swr: number; alert: boolean } | null;
  alc: { raw: number; percent: number; alert: boolean } | null;
  level: { raw: number; percent: number } | null;
  power: { raw: number; percent: number } | null;
}

/**
 * 电台连接事件
 */
export interface IRadioConnectionEvents {
  /**
   * 连接状态变化
   */
  stateChanged: (state: RadioConnectionState) => void;

  /**
   * 连接成功
   */
  connected: () => void;

  /**
   * 连接断开
   */
  disconnected: (reason?: string) => void;

  /**
   * 重连中
   */
  reconnecting: (attempt: number) => void;

  /**
   * 重连失败
   */
  reconnectFailed: (error: Error, attempt: number) => void;

  /**
   * 错误
   */
  error: (error: Error) => void;

  /**
   * 频率变化
   */
  frequencyChanged: (frequency: number) => void;

  /**
   * 音频帧（仅 ICOM WLAN）
   */
  audioFrame: (pcm16: Buffer) => void;

  /**
   * 数值表数据
   */
  meterData: (data: MeterData) => void;
}

/**
 * 电台连接配置（扩展 HamlibConfig）
 */
export type RadioConnectionConfig = HamlibConfig;

/**
 * 电台连接接口
 *
 * 所有电台连接实现必须实现此接口
 */
export interface IRadioConnection extends EventEmitter<IRadioConnectionEvents> {
  /**
   * 获取连接类型
   */
  getType(): RadioConnectionType;

  /**
   * 获取当前连接状态
   */
  getState(): RadioConnectionState;

  /**
   * 检查连接是否健康
   */
  isHealthy(): boolean;

  /**
   * 连接到电台
   *
   * @param config - 连接配置
   * @throws {RadioError} 连接失败时抛出统一的 RadioError
   */
  connect(config: RadioConnectionConfig): Promise<void>;

  /**
   * 断开电台连接
   *
   * @param reason - 断开原因（可选）
   */
  disconnect(reason?: string): Promise<void>;

  /**
   * 设置电台频率
   *
   * @param frequency - 频率（Hz）
   * @throws {RadioError} 设置失败时抛出
   */
  setFrequency(frequency: number): Promise<void>;

  /**
   * 获取当前频率
   *
   * @returns 当前频率（Hz）
   * @throws {RadioError} 获取失败时抛出
   */
  getFrequency(): Promise<number>;

  /**
   * 控制 PTT（发射/接收切换）
   *
   * @param enabled - true: 发射模式, false: 接收模式
   * @throws {RadioError} 控制失败时抛出
   */
  setPTT(enabled: boolean): Promise<void>;

  /**
   * 设置电台工作模式
   *
   * @param mode - 模式名称 (USB, LSB, AM, CW, FM, etc.)
   * @param bandwidth - 带宽设置（可选）: 'narrow' | 'wide'
   * @throws {RadioError} 设置失败时抛出
   */
  setMode(mode: string, bandwidth?: 'narrow' | 'wide'): Promise<void>;

  /**
   * 获取当前工作模式
   *
   * @returns 模式和带宽信息
   * @throws {RadioError} 获取失败时抛出
   */
  getMode(): Promise<{ mode: string; bandwidth: string }>;

  /**
   * 获取连接信息（用于调试和日志）
   */
  getConnectionInfo(): {
    type: RadioConnectionType;
    state: RadioConnectionState;
    config: Partial<RadioConnectionConfig>;
  };

  // ===== 天线调谐器控制（可选功能） =====

  /**
   * 获取天线调谐器能力
   *
   * @returns 天调能力信息
   * @optional 不是所有电台都支持此功能
   */
  getTunerCapabilities?(): Promise<TunerCapabilities>;

  /**
   * 设置天线调谐器开关状态
   *
   * @param enabled - true: 启用天调, false: 禁用天调
   * @throws {RadioError} 设置失败时抛出
   * @optional 仅支持天调的电台需要实现
   */
  setTuner?(enabled: boolean): Promise<void>;

  /**
   * 获取天线调谐器状态
   *
   * @returns 天调状态信息
   * @throws {RadioError} 获取失败时抛出
   * @optional 仅支持天调的电台需要实现
   */
  getTunerStatus?(): Promise<TunerStatus>;

  /**
   * 启动手动调谐
   *
   * @returns true: 调谐启动成功, false: 调谐失败
   * @throws {RadioError} 启动失败时抛出
   * @optional 仅支持手动调谐的电台需要实现
   */
  startTuning?(): Promise<boolean>;
}
