/**
 * IRadioConnection - 统一电台连接接口
 *
 * 为不同的电台连接方式（ICOM WLAN, Hamlib, Serial）提供统一的抽象接口
 * 隔离底层实现差异，统一错误处理和状态管理
 */

import { EventEmitter } from 'eventemitter3';
import type { HamlibConfig, LevelMeterReading, MeterCapabilities, TunerCapabilities, TunerStatus } from '@tx5dr/contracts';

/**
 * 电台连接类型
 */
export enum RadioConnectionType {
  /**
   * 无电台模式（NullConnection 空对象）
   */
  NONE = 'none',

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
  level: LevelMeterReading | null;
  power: { raw: number; percent: number; watts: number | null; maxWatts: number | null } | null;
}

export type SpectrumDisplayMode = 'center' | 'fixed' | 'scroll-center' | 'scroll-fixed';

export interface RadioSpectrumDisplayConfig {
  mode?: SpectrumDisplayMode;
  spanHz?: number;
  edgeSlot?: number;
  edgeLowHz?: number;
  edgeHighHz?: number;
}

export interface RadioSpectrumDisplayState {
  mode: SpectrumDisplayMode | null;
  spanHz: number | null;
  edgeSlot: number | null;
  edgeLowHz: number | null;
  edgeHighHz: number | null;
  supportedSpans: number[];
  supportsFixedEdges: boolean;
  supportsEdgeSlotSelection: boolean;
}

export interface RadioSpectrumRuntimeConfig {
  speed: number;
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

export type RadioModeIntent = 'voice' | 'digital';
export type RadioModeBandwidth = 'narrow' | 'wide' | 'normal' | 'nochange' | number;

export interface SetRadioModeOptions {
  intent?: RadioModeIntent;
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
   * 在连接后的保守初始化完成后启动后台轮询/监控。
   *
   * 旧机型对连接早期并发访问较敏感，因此由上层统一在 bootstrap
   * 完成后显式开启后台任务。
   */
  startBackgroundTasks?(): void;

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
   * @param bandwidth - 带宽设置（可选）: 'narrow' | 'wide' | 'normal' | 'nochange' | Hz
   * @param options - 模式设置上下文（语音/数字）
   * @throws {RadioError} 设置失败时抛出
   */
  setMode(mode: string, bandwidth?: RadioModeBandwidth, options?: SetRadioModeOptions): Promise<void>;

  /**
   * 获取当前工作模式
   *
   * @returns 模式和带宽信息
   * @throws {RadioError} 获取失败时抛出
   */
  getMode(): Promise<{ mode: string; bandwidth: string }>;

  /**
   * 获取电台声明支持的模式列表
   *
   * @optional 仅支持底层能力探测的连接实现
   */
  getSupportedModes?(): Promise<string[]>;

  /**
   * 获取当前 SDR 频谱支持的 span 列表（Hz）
   * @optional 仅支持 SDR 缩放的连接实现
   */
  getSpectrumSpans?(): Promise<number[]>;

  /**
   * 获取当前 SDR 频谱 span（Hz）
   * @optional 仅支持 SDR 缩放的连接实现
   */
  getCurrentSpectrumSpan?(): Promise<number | null>;

  /**
   * 设置当前 SDR 频谱 span（Hz）
   * @optional 仅支持 SDR 缩放的连接实现
   */
  setSpectrumSpan?(spanHz: number): Promise<void>;

  /**
   * 获取当前 SDR 显示状态（模式/span/fixed edges）
   * @optional 仅支持 SDR 显示控制的连接实现
   */
  getSpectrumDisplayState?(): Promise<RadioSpectrumDisplayState | null>;

  /**
   * 配置当前 SDR 显示状态（模式/span/fixed edges）
   * @optional 仅支持 SDR 显示控制的连接实现
   */
  configureSpectrumDisplay?(config: RadioSpectrumDisplayConfig): Promise<void>;

  /**
   * 运行中更新 SDR 频谱配置（不重启频谱流）
   * @optional 仅支持 Hamlib 官方频谱流的连接实现
   */
  applySpectrumRuntimeConfig?(config: RadioSpectrumRuntimeConfig): Promise<void>;

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

  /**
   * 获取电台数值表能力
   *
   * @returns 数值表能力信息（哪些 level 可读取）
   * @optional 不是所有连接类型都需要实现
   */
  getMeterCapabilities?(): MeterCapabilities;

  /**
   * 通知连接对象当前工作频率，用于选择正确的 S 表标准（HF vs VHF/UHF）。
   * 由 PhysicalRadioManager 在检测到频率变化时调用。
   *
   * @param frequencyHz - 当前频率（Hz）
   */
  setKnownFrequency(frequencyHz: number): void;

  // ===== Level 类控制（可选，由 RadioCapabilityManager 统一路由）=====

  /**
   * 获取发射功率（0.0–1.0，1.0 = 最大功率）
   * @optional Hamlib: getLevel('RFPOWER'), icom-wlan: CI-V 0x14 0x0A
   */
  getRFPower?(): Promise<number>;

  /**
   * 设置发射功率（0.0–1.0）
   * @optional Hamlib: setLevel('RFPOWER', value), icom-wlan: CI-V 0x14 0x0A
   */
  setRFPower?(value: number): Promise<void>;

  /**
   * 获取 AF 增益（音频输出音量，0.0–1.0）
   * @optional Hamlib: getLevel('AF'), icom-wlan: CI-V 0x14 0x01
   */
  getAFGain?(): Promise<number>;

  /**
   * 设置 AF 增益（0.0–1.0）
   * @optional Hamlib: setLevel('AF', value), icom-wlan: CI-V 0x14 0x01
   */
  setAFGain?(value: number): Promise<void>;

  /**
   * 获取静噪电平（SQL，0.0–1.0，0 = 完全开放）
   * @optional Hamlib: getLevel('SQL'), icom-wlan: CI-V 0x14 0x03
   */
  getSQL?(): Promise<number>;

  /**
   * 设置静噪电平（0.0–1.0）
   * @optional Hamlib: setLevel('SQL', value), icom-wlan: CI-V 0x14 0x03
   */
  setSQL?(value: number): Promise<void>;

  /**
   * 获取 MIC 增益（0.0–1.0）
   * @optional Hamlib: getLevel('MICGAIN'), icom-wlan: CI-V 0x14 0x0F
   */
  getMicGain?(): Promise<number>;

  /**
   * 设置 MIC 增益（0.0–1.0）
   * @optional Hamlib: setLevel('MICGAIN', value), icom-wlan: CI-V 0x14 0x0F
   */
  setMicGain?(value: number): Promise<void>;

  /**
   * 获取噪声消隐电平（0.0–1.0，0 = 关闭）
   * @optional Hamlib: getLevel('NB'), icom-wlan: CI-V 0x14 0x12
   */
  getNBEnabled?(): Promise<number>;

  /**
   * 设置噪声消隐电平（0.0–1.0，0 = 关闭）
   * @optional Hamlib: setLevel('NB', value), icom-wlan: CI-V 0x14 0x12
   */
  setNBEnabled?(value: number): Promise<void>;

  /**
   * 获取数字降噪电平（0.0–1.0，0 = 关闭）
   * @optional Hamlib: getLevel('NR'), icom-wlan: CI-V 0x14 0x13
   */
  getNREnabled?(): Promise<number>;

  /**
   * 设置数字降噪电平（0.0–1.0，0 = 关闭）
   * @optional Hamlib: setLevel('NR', value), icom-wlan: CI-V 0x14 0x13
   */
  setNREnabled?(value: number): Promise<void>;

  // ===== Rich capability controls（主要由 Hamlib 提供）=====

  /**
   * 获取面板锁定状态。
   */
  getLockMode?(): Promise<boolean>;

  /**
   * 设置面板锁定状态。
   */
  setLockMode?(enabled: boolean): Promise<void>;

  /**
   * 获取静音状态。
   */
  getMuteEnabled?(): Promise<boolean>;

  /**
   * 设置静音状态。
   */
  setMuteEnabled?(enabled: boolean): Promise<void>;

  /**
   * 获取 VOX 开关状态。
   */
  getVOXEnabled?(): Promise<boolean>;

  /**
   * 设置 VOX 开关状态。
   */
  setVOXEnabled?(enabled: boolean): Promise<void>;

  /**
   * 获取 RIT 偏移（Hz）。
   */
  getRitOffset?(): Promise<number>;

  /**
   * 设置 RIT 偏移（Hz）。
   */
  setRitOffset?(offsetHz: number): Promise<void>;

  /**
   * 获取 XIT 偏移（Hz）。
   */
  getXitOffset?(): Promise<number>;

  /**
   * 设置 XIT 偏移（Hz）。
   */
  setXitOffset?(offsetHz: number): Promise<void>;

  /**
   * 获取当前调谐步进（Hz）。
   */
  getTuningStep?(): Promise<number>;

  /**
   * 设置当前调谐步进（Hz）。
   */
  setTuningStep?(stepHz: number): Promise<void>;

  /**
   * 获取当前连接支持的调谐步进列表（Hz）。
   */
  getSupportedTuningSteps?(): Promise<number[]>;

  /**
   * 获取当前电源状态。
   * 推荐值：off/on/standby/operate/unknown
   */
  getPowerState?(): Promise<string>;

  /**
   * 设置当前电源状态。
   * 推荐值：off/on/standby/operate/unknown
   */
  setPowerState?(state: string): Promise<void>;

  /**
   * 获取中继差频方向。
   * 推荐值：none/minus/plus
   */
  getRepeaterShift?(): Promise<string>;

  /**
   * 设置中继差频方向。
   * 推荐值：none/minus/plus
   */
  setRepeaterShift?(shift: string): Promise<void>;

  /**
   * 获取中继偏移（Hz）。
   */
  getRepeaterOffset?(): Promise<number>;

  /**
   * 设置中继偏移（Hz）。
   */
  setRepeaterOffset?(offsetHz: number): Promise<void>;

  /**
   * 获取当前 CTCSS 发射音调（单位：0.1Hz）。
   */
  getCtcssTone?(): Promise<number>;

  /**
   * 设置 CTCSS 发射音调（单位：0.1Hz）。
   */
  setCtcssTone?(tone: number): Promise<void>;

  /**
   * 获取当前连接支持的 CTCSS 音调列表（单位：0.1Hz）。
   */
  getAvailableCtcssTones?(): Promise<number[]>;

  /**
   * 获取当前 DCS 码。
   */
  getDcsCode?(): Promise<number>;

  /**
   * 设置当前 DCS 码。
   */
  setDcsCode?(code: number): Promise<void>;

  /**
   * 获取当前连接支持的 DCS 码列表。
   */
  getAvailableDcsCodes?(): Promise<number[]>;

  /**
   * 获取支持的最大 RIT 偏移（Hz）。
   */
  getMaxRit?(): Promise<number>;

  /**
   * 获取支持的最大 XIT 偏移（Hz）。
   */
  getMaxXit?(): Promise<number>;
}
