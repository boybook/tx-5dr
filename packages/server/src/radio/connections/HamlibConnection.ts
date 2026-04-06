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
import type { PttType } from 'hamlib';
import { SpectrumController } from 'hamlib/spectrum';
import type { ManagedSpectrumConfig, SpectrumLine, SpectrumSupportSummary } from 'hamlib/spectrum';
import type { LevelMeterReading, MeterCapabilities, SerialConfig } from '@tx5dr/contracts';
import {
  type MeterDecodeStrategy,
  genericHamlibStrengthToLevelMeterReading,
  hamlibStrengthToLevelMeterReading,
  resolveHamlibMeterDecodeStrategy,
  yaesuRawstrToLevelMeterReading,
} from './meterUtils.js';
import { RadioError, RadioErrorCode, RadioErrorSeverity } from '../../utils/errors/RadioError.js';
import { globalEventBus } from '../../utils/EventBus.js';
import { createLogger } from '../../utils/logger.js';
import { isProcessShuttingDown } from '../../utils/process-shutdown.js';
import { isRecoverableOptionalRadioError } from '../optionalRadioError.js';
import { buildBackendConfig } from '../hamlibConfigUtils.js';
import { RADIO_IO_SKIPPED, RadioIoQueue } from './RadioIoQueue.js';
import {
  type ApplyOperatingStateRequest,
  type ApplyOperatingStateResult,
  RadioConnectionType,
  RadioConnectionState,
  type RadioSpectrumDisplayState,
  type RadioSpectrumRuntimeConfig,
  type IRadioConnection,
  type IRadioConnectionEvents,
  type RadioConnectionConfig,
  type MeterData,
  type RadioModeInfo,
  type RadioModeReadBandwidth,
  type RadioModeBandwidth,
  type SetRadioModeOptions,
} from './IRadioConnection.js';

const logger = createLogger('HamlibConnection');

type RigMetadata = {
  rigModel: number;
  mfgName: string;
  modelName: string;
};

let rigMetadataCachePromise: Promise<Map<number, RigMetadata>> | null = null;

interface SpectrumControllerLike {
  getSpectrumSupportSummary(): Promise<SpectrumSupportSummary>;
  configureSpectrum(config?: ManagedSpectrumConfig): Promise<unknown>;
  getSpectrumDisplayState(): Promise<{
    mode: RadioSpectrumDisplayState['mode'];
    spanHz: number | null;
    edgeSlot: number | null;
    edgeLowHz: number | null;
    edgeHighHz: number | null;
    supportedSpans: number[];
    supportsFixedEdges: boolean;
    supportsEdgeSlotSelection: boolean;
  }>;
  configureSpectrumDisplay(config?: ManagedSpectrumConfig): Promise<unknown>;
  startManagedSpectrum(config?: ManagedSpectrumConfig): Promise<boolean>;
  stopManagedSpectrum(): Promise<boolean>;
  on(event: 'spectrumLine', listener: (line: SpectrumLine) => void): unknown;
  off(event: 'spectrumLine', listener: (line: SpectrumLine) => void): unknown;
}

type SplitSupportState = 'unknown' | 'supported' | 'unsupported';
type TxFrequencyRange = ReturnType<HamLib['getFrequencyRanges']>['tx'][number];

const DATA_TO_BASE_MODE: Record<string, string> = {
  PKTUSB: 'USB',
  PKTLSB: 'LSB',
  PKTFM: 'FM',
  PKTAM: 'AM',
};

const BASE_TO_DATA_MODE: Record<string, string> = {
  USB: 'PKTUSB',
  LSB: 'PKTLSB',
  FM: 'PKTFM',
  AM: 'PKTAM',
};

function normalizeModeName(mode: string): string {
  return mode.trim().toUpperCase();
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function normalizePowerStateCode(code: number): string {
  switch (code) {
    case 0:
      return 'off';
    case 1:
      return 'on';
    case 2:
      return 'standby';
    case 4:
      return 'operate';
    default:
      return 'unknown';
  }
}

function normalizeRepeaterShiftValue(shift: string): string {
  const normalized = shift.trim().toLowerCase();
  if (normalized === '+' || normalized === 'plus') return 'plus';
  if (normalized === '-' || normalized === 'minus') return 'minus';
  return 'none';
}

async function getRigMetadata(rigModel: number): Promise<RigMetadata | null> {
  if (!rigMetadataCachePromise) {
    rigMetadataCachePromise = Promise.resolve()
      .then(() => {
        const rigs = HamLib.getSupportedRigs();
        return new Map(rigs.map((rig) => [rig.rigModel, {
          rigModel: rig.rigModel,
          mfgName: rig.mfgName,
          modelName: rig.modelName,
        }]));
      })
      .catch((error) => {
        logger.warn('Failed to build Hamlib rig metadata cache', error);
        return new Map<number, RigMetadata>();
      });
  }

  const metadataCache = await rigMetadataCachePromise;
  return metadataCache.get(rigModel) ?? null;
}

/**
 * HamlibConnection 实现类
 * 支持串口和网络连接方式
 */
export class HamlibConnection
  extends EventEmitter<IRadioConnectionEvents>
  implements IRadioConnection
{
  private readonly ioQueue = new RadioIoQueue();
  private ioSessionId = 0;
  private backgroundTasksStarted = false;
  private spectrumListener: ((line: SpectrumLine) => void) | null = null;
  private readonly onRigSpectrumLine = (line: SpectrumLine) => {
    this.lastSuccessfulOperation = Date.now();
    this.spectrumListener?.(line);
  };

  /**
   * 底层 Hamlib 实例
   */
  private rig: HamLib | null = null;

  /**
   * Hamlib 0.4.0 频谱控制器
   */
  private spectrumController: SpectrumControllerLike | null = null;

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
   * 当前 PTT 方法（cat/vox/dtr/rts）
   */
  private pttMethod: string = 'cat';

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

  /**
   * 电台支持的 level 集合（连接时检测）
   */
  private supportedLevels: Set<string> = new Set();

  /**
   * 当前连接匹配到的数值表解码策略。
   */
  private meterDecodeStrategy: MeterDecodeStrategy = resolveHamlibMeterDecodeStrategy({
    supportedLevels: [],
  });

  /**
   * 当前连接的 Hamlib rig 元数据（仅 serial 模式可用）。
   */
  private meterRigMetadata: RigMetadata | null = null;

  /**
   * 首次诊断样本日志只输出一次，避免持续双读电平表。
   */
  private hasLoggedMeterStrategySample = false;

  /**
   * 电台支持的模式集合（连接时检测）
   */
  private supportedModes: Set<string> = new Set();

  /**
   * 电台支持的 function 集合（连接时检测）
   */
  private supportedFunctions: Set<string> = new Set();

  /**
   * 电台支持的 parm 集合（连接时检测）
   */
  private supportedParms: Set<string> = new Set();

  /**
   * Hamlib rig caps 中声明的 TX 频率/功率范围。
   */
  private txFrequencyRanges: TxFrequencyRange[] = [];

  /**
   * 当前已知的电台工作模式（USB/PKTUSB/AM 等）。
   */
  private currentRadioMode: string | null = null;

  /**
   * 当前工作频率（Hz），由 PhysicalRadioManager 通过 setKnownFrequency 更新
   * 用于选择正确的 S 表标准（HF: S9=-73dBm vs VHF/UHF: S9=-93dBm）
   */
  private currentFrequencyHz: number = 0;

  /**
   * 当前连接会话的 split 能力探测状态。
   * 仅用于决定是否在写 RX 后补写同频 TX，不向上层暴露。
   */
  private splitSupportState: SplitSupportState = 'unknown';

  /**
   * 当前连接会话中探测到的 split 开关状态。
   */
  private splitEnabled = false;

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
      await this.disconnect('reconnecting');
    }

    // 验证配置
    if (config.type !== 'network' && config.type !== 'serial') {
      throw new RadioError({
        code: RadioErrorCode.INVALID_CONFIG,
        message: `Configuration type error: expected 'network' or 'serial', got '${config.type}'`,
        userMessage: 'Hamlib configuration type is incorrect',
        suggestions: ['Check the connection type setting in the configuration file'],
      });
    }

    // 验证必需参数
    if (config.type === 'network' && (!config.network || !config.network.host || !config.network.port)) {
      throw new RadioError({
        code: RadioErrorCode.INVALID_CONFIG,
        message: 'Hamlib network configuration missing required fields: network.host, network.port',
        userMessage: 'Hamlib network configuration is incomplete',
        suggestions: ['Enter the radio host address', 'Enter the radio port number'],
      });
    }

    if (config.type === 'serial' && (!config.serial || !config.serial.path || !config.serial.rigModel)) {
      throw new RadioError({
        code: RadioErrorCode.INVALID_CONFIG,
        message: 'Hamlib serial configuration missing required fields: serial.path, serial.rigModel',
        userMessage: 'Hamlib serial configuration is incomplete',
        suggestions: ['Enter the serial device path', 'Select the radio model'],
      });
    }

    // 保存配置
    this.currentConfig = config;
    this.ioSessionId += 1;
    this.backgroundTasksStarted = false;

    // 更新状态
    this.setState(RadioConnectionState.CONNECTING);

    try {
      logger.debug(
        `Connecting to Hamlib radio: ${config.type === 'network' ? `${config.network!.host}:${config.network!.port}` : config.serial!.path}`
      );

      // 确定连接参数
      const port =
        config.type === 'network'
          ? `${config.network!.host}:${config.network!.port}`
          : undefined;
      const model = config.type === 'network' ? 2 : config.serial!.rigModel;

      // 创建 HamLib 实例
      const rig = new HamLib(model as any, port as any) as HamLib;
      this.rig = rig;
      this.spectrumController = new SpectrumController(rig);

      // 配置 PTT 类型（必须在 open() 前调用）
      this.pttMethod = config.pttMethod || 'cat';
      const pttTypeMap: Record<string, PttType> = {
        'cat': 'RIG',
        'vox': 'NONE',
        'dtr': 'DTR',
        'rts': 'RTS',
      };
      const hamlibPttType = pttTypeMap[this.pttMethod] || 'RIG';
      logger.debug(`Configuring PTT type: ${this.pttMethod} -> ${hamlibPttType}`);
      await rig.setPttType(hamlibPttType);

      // 应用 Hamlib backend 配置（如果有）
      if (config.type === 'serial' && config.serial) {
        await this.applyBackendConfig(config.serial);
      }

      // 打开连接（带超时保护）
      const CONNECTION_TIMEOUT = 10000; // 10秒超时

      await Promise.race([
        this.openConnection(),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('Connection timeout')),
            CONNECTION_TIMEOUT
          )
        ),
      ]);

      // 等待电台初始化完成后再验证通信
      const POST_OPEN_DELAY = 100;
      logger.debug(`Waiting ${POST_OPEN_DELAY}ms for radio initialization...`);
      await new Promise((resolve) => setTimeout(resolve, POST_OPEN_DELAY));

      // 验证与电台的实际通信（状态仍为 CONNECTING）
      await this.verifyRadioCommunication();

      // 通信验证成功，才转为 CONNECTED
      this.setState(RadioConnectionState.CONNECTED);
      this.lastSuccessfulOperation = Date.now();
      logger.info('Hamlib radio connected successfully');

      // 检测数值表能力
      try {
        const levels = this.rig!.getSupportedLevels();
        this.supportedLevels = new Set(levels);
        logger.info('Supported meter levels detected', { levels: Array.from(this.supportedLevels) });
      } catch (error) {
        logger.warn('Failed to detect supported levels, assuming all supported', error);
        this.supportedLevels = new Set(['STRENGTH', 'SWR', 'ALC', 'RFPOWER_METER']);
      }

      await this.initializeMeterDecodeStrategy();

      await this.detectSupportedModes();
      this.detectSupportedFunctions();
      this.detectSupportedParms();
      this.detectTxFrequencyRanges();
      await this.initializeRigStateSnapshot();

      // 触发连接成功事件
      this.emit('connected');
    } catch (error) {
      // 连接失败，清理资源
      await this.cleanup();
      this.setState(RadioConnectionState.DISCONNECTED);

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

    // 停止数值表轮询
    this.stopMeterPolling();
    this.supportedLevels.clear();
    this.meterDecodeStrategy = resolveHamlibMeterDecodeStrategy({ supportedLevels: [] });
    this.meterRigMetadata = null;
    this.hasLoggedMeterStrategySample = false;
    this.supportedModes.clear();
    this.supportedFunctions.clear();
    this.supportedParms.clear();
    this.txFrequencyRanges = [];
    this.currentRadioMode = null;

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
   * 通知连接对象当前工作频率，用于选择正确的 S 表标准（HF vs VHF/UHF）
   */
  setKnownFrequency(frequencyHz: number): void {
    this.currentFrequencyHz = frequencyHz;
  }

  /**
   * 获取当前频率
   */
  async getFrequency(): Promise<number> {
    return this.runSerializedTask('getFrequency', async () => {
      this.checkConnected();

      try {
        const frequency = (await Promise.race([
          this.rig!.getFrequency(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Get frequency timeout')), 5000)
          ),
        ])) as number;

        this.lastSuccessfulOperation = Date.now();
        return frequency;
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
   * 设置模式
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
          const modeChanged = await this.performModeWrite(request.mode, request.bandwidth, request.options);
          modeApplied = true;

          if (request.frequency !== undefined && modeChanged) {
            await this.performFrequencyWrite(request.frequency);
          }
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
   * 获取当前模式
   */
  async getMode(): Promise<RadioModeInfo> {
    return this.runSerializedTask('getMode', async () => {
      return this.performModeRead();
    });
  }

  async getModeBandwidth(): Promise<RadioModeReadBandwidth> {
    return this.runSerializedTask('getModeBandwidth', async () => {
      const modeInfo = await this.performModeRead();
      return modeInfo.bandwidth;
    });
  }

  async setModeBandwidth(bandwidth: RadioModeBandwidth): Promise<void> {
    await this.runSerializedTask('setModeBandwidth', async () => {
      const modeInfo = await this.performModeRead();
      await this.performModeWrite(modeInfo.mode, bandwidth);
    }, { critical: true });
  }

  async getSupportedModeBandwidths(): Promise<RadioModeReadBandwidth[]> {
    return this.runSerializedTask('getSupportedModeBandwidths', async () => {
      this.checkConnected();

      const modeInfo = await this.performModeRead();
      const candidates = this.getRangeMatchModeCandidates(modeInfo.mode);

      try {
        const widths = this.rig!.getFilterList()
          .filter((item) => item.modes.some((mode) => candidates.includes(normalizeModeName(mode))))
          .map((item) => item.width)
          .filter((width) => Number.isFinite(width) && width > 0);

        if (widths.length > 0) {
          return Array.from(new Set(widths)).sort((a, b) => a - b);
        }
      } catch (error) {
        logger.debug('Failed to read Hamlib filter list for mode bandwidth options', error);
      }

      const fallbackWidths = [
        this.rig!.getPassbandNarrow(modeInfo.mode as any),
        this.rig!.getPassbandNormal(modeInfo.mode as any),
        this.rig!.getPassbandWide(modeInfo.mode as any),
      ].filter((width) => Number.isFinite(width) && width > 0);

      return Array.from(new Set(fallbackWidths)).sort((a, b) => a - b);
    });
  }

  async getSupportedModes(): Promise<string[]> {
    return Array.from(this.supportedModes).sort();
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

  private async detectSupportedModes(): Promise<void> {
    if (!this.rig || typeof (this.rig as any).getSupportedModes !== 'function') {
      this.supportedModes.clear();
      logger.warn('Hamlib mode detection is not available on this build');
      return;
    }

    try {
      const modes = ((this.rig as any).getSupportedModes() as unknown[])
        .filter((mode): mode is string => typeof mode === 'string')
        .map((mode) => normalizeModeName(mode))
        .filter((mode) => mode.length > 0);
      this.supportedModes = new Set(modes);
      logger.info('Supported radio modes detected', { modes: Array.from(this.supportedModes).sort() });
    } catch (error) {
      this.supportedModes.clear();
      logger.warn('Failed to detect supported radio modes, using standard mode fallback only', error);
    }
  }

  private detectSupportedFunctions(): void {
    if (!this.rig || typeof this.rig.getSupportedFunctions !== 'function') {
      this.supportedFunctions.clear();
      logger.warn('Hamlib function detection is not available on this build');
      return;
    }

    try {
      const functions = this.rig.getSupportedFunctions()
        .filter((func): func is string => typeof func === 'string')
        .map((func) => func.trim().toUpperCase())
        .filter((func) => func.length > 0);
      this.supportedFunctions = new Set(functions);
      logger.info('Supported radio functions detected', { functions: Array.from(this.supportedFunctions).sort() });
    } catch (error) {
      this.supportedFunctions.clear();
      logger.warn('Failed to detect supported radio functions', error);
    }
  }

  private detectSupportedParms(): void {
    if (!this.rig || typeof this.rig.getSupportedParms !== 'function') {
      this.supportedParms.clear();
      logger.warn('Hamlib parameter detection is not available on this build');
      return;
    }

    try {
      const parms = this.rig.getSupportedParms()
        .filter((parm): parm is string => typeof parm === 'string')
        .map((parm) => parm.trim().toUpperCase())
        .filter((parm) => parm.length > 0);
      this.supportedParms = new Set(parms);
      logger.info('Supported radio parameters detected', { parms: Array.from(this.supportedParms).sort() });
    } catch (error) {
      this.supportedParms.clear();
      logger.warn('Failed to detect supported radio parameters', error);
    }
  }

  private detectTxFrequencyRanges(): void {
    if (!this.rig || typeof this.rig.getFrequencyRanges !== 'function') {
      this.txFrequencyRanges = [];
      logger.warn('Hamlib TX frequency range detection is not available on this build');
      return;
    }

    try {
      const { tx } = this.rig.getFrequencyRanges();
      this.txFrequencyRanges = Array.isArray(tx) ? tx : [];
      logger.info('TX frequency ranges detected', { count: this.txFrequencyRanges.length });
    } catch (error) {
      this.txFrequencyRanges = [];
      logger.warn('Failed to detect TX frequency ranges', error);
    }
  }

  private async initializeRigStateSnapshot(): Promise<void> {
    if (!this.rig) {
      return;
    }

    try {
      const frequency = await this.rig.getFrequency().catch(() => null);
      const modeInfo = await this.rig.getMode().catch(() => null);

      if (typeof frequency === 'number' && frequency > 0) {
        this.currentFrequencyHz = frequency;
      }

      if (modeInfo && typeof modeInfo.mode === 'string' && modeInfo.mode.trim().length > 0) {
        this.currentRadioMode = normalizeModeName(modeInfo.mode);
      }
    } catch (error) {
      logger.warn('Failed to initialize radio state snapshot', error);
    }
  }

  private resolveModeForIntent(mode: string, options?: SetRadioModeOptions): string {
    const intent = options?.intent;
    const candidates = this.buildModeCandidates(mode, intent);

    if (this.supportedModes.size === 0) {
      return intent === 'digital' ? candidates[candidates.length - 1] : candidates[0];
    }

    for (const candidate of candidates) {
      if (this.supportedModes.has(candidate)) {
        return candidate;
      }
    }

    return intent === 'digital' ? candidates[candidates.length - 1] : candidates[0];
  }

  private buildModeCandidates(mode: string, intent?: SetRadioModeOptions['intent']): string[] {
    const normalizedMode = normalizeModeName(mode);
    const baseMode = DATA_TO_BASE_MODE[normalizedMode] ?? normalizedMode;
    const dataMode = BASE_TO_DATA_MODE[normalizedMode]
      ?? (normalizedMode in DATA_TO_BASE_MODE ? normalizedMode : undefined);

    if (intent === 'voice') {
      return [baseMode];
    }

    if (intent === 'digital' && dataMode && dataMode !== baseMode) {
      return Array.from(new Set([dataMode, baseMode]));
    }

    return [normalizedMode];
  }

  private getRangeMatchModeCandidates(mode: string | null): string[] {
    if (!mode) {
      return [];
    }

    const normalizedMode = normalizeModeName(mode);
    const baseMode = DATA_TO_BASE_MODE[normalizedMode] ?? normalizedMode;
    const dataMode = BASE_TO_DATA_MODE[normalizedMode]
      ?? (normalizedMode in DATA_TO_BASE_MODE ? normalizedMode : undefined);

    return Array.from(new Set(
      [normalizedMode, baseMode, dataMode].filter((candidate): candidate is string => Boolean(candidate))
    ));
  }

  private resolveCurrentTxPowerMaxWatts(): number | null {
    if (this.txFrequencyRanges.length === 0) {
      return null;
    }

    const fallbackHighPower = Math.max(...this.txFrequencyRanges.map((range) => range.highPower), 0);
    const fallbackMaxWatts = fallbackHighPower > 0 ? fallbackHighPower / 1000 : null;

    if (this.currentFrequencyHz <= 0 || !this.currentRadioMode) {
      return fallbackMaxWatts;
    }

    const normalizedCurrentMode = normalizeModeName(this.currentRadioMode);
    const modeCandidates = this.getRangeMatchModeCandidates(this.currentRadioMode);
    const matchingRange = this.txFrequencyRanges
      .filter((range) => this.currentFrequencyHz >= range.startFreq && this.currentFrequencyHz <= range.endFreq)
      .map((range) => {
        const normalizedModes = range.modes
          .filter((mode): mode is string => typeof mode === 'string' && mode.trim().length > 0)
          .map((mode) => normalizeModeName(mode));
        const rangeModes = new Set(normalizedModes);
        const matchedCandidate = modeCandidates.find((candidate) => rangeModes.has(candidate));

        if (!matchedCandidate) {
          return null;
        }

        return {
          range,
          exactModeMatch: rangeModes.has(normalizedCurrentMode),
          modeCount: rangeModes.size,
          spanWidth: range.endFreq - range.startFreq,
        };
      })
      .filter((entry): entry is { range: TxFrequencyRange; exactModeMatch: boolean; modeCount: number; spanWidth: number } => entry !== null)
      .sort((left, right) => {
        if (left.exactModeMatch !== right.exactModeMatch) {
          return left.exactModeMatch ? -1 : 1;
        }
        if (left.modeCount !== right.modeCount) {
          return left.modeCount - right.modeCount;
        }
        return left.spanWidth - right.spanWidth;
      })[0]?.range;

    if (!matchingRange) {
      return fallbackMaxWatts;
    }

    return matchingRange.highPower > 0 ? matchingRange.highPower / 1000 : fallbackMaxWatts;
  }

  async getSpectrumSupportSummary(): Promise<SpectrumSupportSummary> {
    return this.runSerializedTask('getSpectrumSupportSummary', async () => {
      this.checkConnected();
      try {
        return await this.getSpectrumController().getSpectrumSupportSummary();
      } catch (error) {
        throw this.convertError(error, 'getSpectrumSupportSummary');
      }
    });
  }

  async getSpectrumSpans(): Promise<number[]> {
    return this.runSerializedTask('getSpectrumSpans', async () => {
      this.checkConnected();
      try {
        const summary = await this.getSpectrumController().getSpectrumSupportSummary();
        return Array.from(new Set((summary.spans ?? []).filter((span): span is number => Number.isFinite(span) && span > 0)))
          .sort((left, right) => right - left);
      } catch (error) {
        throw this.convertError(error, 'getSpectrumSpans');
      }
    });
  }

  async getCurrentSpectrumSpan(): Promise<number | null> {
    return this.runSerializedTask('getCurrentSpectrumSpan', async () => {
      this.checkConnected();
      try {
        const currentSpan = await this.getSpectrumRig().getLevel('SPECTRUM_SPAN');
        return typeof currentSpan === 'number' && Number.isFinite(currentSpan) && currentSpan > 0 ? currentSpan : null;
      } catch (error) {
        throw this.convertError(error, 'getCurrentSpectrumSpan');
      }
    });
  }

  async setSpectrumSpan(spanHz: number): Promise<void> {
    await this.runSerializedTask('setSpectrumSpan', async () => {
      this.checkConnected();
      try {
        await this.getSpectrumRig().setLevel('SPECTRUM_SPAN', spanHz);
      } catch (error) {
        throw this.convertError(error, 'setSpectrumSpan');
      }
    });
  }

  async getSpectrumDisplayState(): Promise<RadioSpectrumDisplayState | null> {
    return this.runSerializedTask('getSpectrumDisplayState', async () => {
      this.checkConnected();
      try {
        const state = await this.getSpectrumController().getSpectrumDisplayState();
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
        await this.getSpectrumController().configureSpectrumDisplay(config);
      } catch (error) {
        throw this.convertError(error, 'configureSpectrumDisplay');
      }
    });
  }

  async applySpectrumRuntimeConfig(config: RadioSpectrumRuntimeConfig): Promise<void> {
    await this.runSerializedTask('applySpectrumRuntimeConfig', async () => {
      this.checkConnected();

      const controller = this.getSpectrumController();
      const summary = await controller.getSpectrumSupportSummary();
      if (!summary.configurableLevels.includes('SPECTRUM_SPEED')) {
        logger.debug('Ignoring Hamlib spectrum runtime speed update because backend does not support SPECTRUM_SPEED', {
          speed: config.speed,
        });
        return;
      }

      try {
        await controller.configureSpectrum({ speed: config.speed });
        logger.info('Applied Hamlib spectrum runtime speed', { speed: config.speed });
      } catch (error) {
        throw this.convertError(error, 'applySpectrumRuntimeConfig');
      }
    });
  }

  async startManagedSpectrum(
    listener: (line: SpectrumLine) => void,
    config?: ManagedSpectrumConfig
  ): Promise<void> {
    await this.runSerializedTask('startManagedSpectrum', async () => {
      this.checkConnected();

      const controller = this.getSpectrumController();
      this.spectrumListener = listener;
      controller.off('spectrumLine', this.onRigSpectrumLine);
      controller.on('spectrumLine', this.onRigSpectrumLine);

      try {
        await controller.startManagedSpectrum(config);
      } catch (error) {
        controller.off('spectrumLine', this.onRigSpectrumLine);
        this.spectrumListener = null;
        throw this.convertError(error, 'startManagedSpectrum');
      }
    });
  }

  async stopManagedSpectrum(): Promise<void> {
    await this.runSerializedTask('stopManagedSpectrum', async () => {
      const controller = this.spectrumController;
      if (!controller) {
        this.spectrumListener = null;
        return;
      }
      try {
        controller.off('spectrumLine', this.onRigSpectrumLine);
        await controller.stopManagedSpectrum();
      } catch (error) {
        throw this.convertError(error, 'stopManagedSpectrum');
      } finally {
        this.spectrumListener = null;
      }
    });
  }

  // ===== 天线调谐器控制 =====

  /**
   * 获取天线调谐器能力
   */
  async getTunerCapabilities(): Promise<import('@tx5dr/contracts').TunerCapabilities> {
    return this.runSerializedTask('getTunerCapabilities', async () => {
      this.checkConnected();

      try {
        // 通过实际读取 TUNER 函数状态来探测支持情况。
        // getSupportedFunctions() 只返回当前激活的功能，天调关闭时 TUNER 不在列表中，
        // 导致误判为不支持。直接调用 getFunction('TUNER') 才能准确区分「关闭」和「不存在」。
        await Promise.race([
          this.rig!.getFunction('TUNER'),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Tuner probe timeout')), 5000)
          ),
        ]);

        this.lastSuccessfulOperation = Date.now();
        logger.debug('Tuner capabilities: supported (probe succeeded)');

        return { supported: true, hasSwitch: true, hasManualTune: true };
      } catch {
        // getFunction('TUNER') 报错说明电台本身不支持该功能
        logger.debug('Tuner capabilities: not supported (probe failed)');
        return { supported: false, hasSwitch: false, hasManualTune: false };
      }
    });
  }

  /**
   * 获取电台数值表能力
   */
  getMeterCapabilities(): MeterCapabilities {
    return {
      strength: this.getSelectedLevelMeterSource() !== null,
      swr: this.supportedLevels.has('SWR'),
      alc: this.supportedLevels.has('ALC'),
      power: this.supportedLevels.has('RFPOWER_METER') || this.supportedLevels.has('RFPOWER_METER_WATTS'),
      powerWatts: this.supportedLevels.has('RFPOWER_METER_WATTS'),
    };
  }

  private getSelectedLevelMeterSource(): 'STRENGTH' | 'RAWSTR' | null {
    return this.meterDecodeStrategy.sourceLevel;
  }

  private async initializeMeterDecodeStrategy(): Promise<void> {
    const config = this.currentConfig;
    if (!config) {
      this.meterRigMetadata = null;
      this.meterDecodeStrategy = resolveHamlibMeterDecodeStrategy({ supportedLevels: this.supportedLevels });
      return;
    }

    if (config.type === 'serial' && config.serial?.rigModel) {
      this.meterRigMetadata = await getRigMetadata(config.serial.rigModel);
    } else {
      this.meterRigMetadata = null;
    }

    this.meterDecodeStrategy = resolveHamlibMeterDecodeStrategy({
      manufacturer: this.meterRigMetadata?.mfgName ?? null,
      supportedLevels: this.supportedLevels,
    });
    this.hasLoggedMeterStrategySample = false;

    logger.info('Meter decode strategy selected', {
      strategy: this.meterDecodeStrategy.label,
      sourceLevel: this.meterDecodeStrategy.sourceLevel,
      manufacturer: this.meterRigMetadata?.mfgName ?? null,
      modelName: this.meterRigMetadata?.modelName ?? null,
      rigModel: this.meterRigMetadata?.rigModel ?? null,
    });
  }

  /**
   * 设置天线调谐器开关
   */
  async setTuner(enabled: boolean): Promise<void> {
    await this.runSerializedTask('setTuner', async () => {
      this.checkConnected();

      try {
        await Promise.race([
          this.rig!.setFunction('TUNER', enabled),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Set tuner timeout')), 5000)
          ),
        ]);

        this.lastSuccessfulOperation = Date.now();
        logger.debug(`Tuner set: ${enabled ? 'enabled' : 'disabled'}`);
      } catch (error) {
        throw this.convertError(error, 'setTuner');
      }
    });
  }

  /**
   * 获取天线调谐器状态
   */
  async getTunerStatus(): Promise<import('@tx5dr/contracts').TunerStatus> {
    return this.runSerializedTask('getTunerStatus', async () => {
      this.checkConnected();

      try {
        const enabled = await Promise.race([
          this.rig!.getFunction('TUNER'),
          new Promise<boolean>((_, reject) =>
            setTimeout(() => reject(new Error('Get tuner status timeout')), 5000)
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
    });
  }

  /**
   * 启动手动调谐
   */
  async startTuning(): Promise<boolean> {
    return this.runSerializedTask('startTuning', async () => {
      this.checkConnected();

      try {
        await Promise.race([
          this.rig!.vfoOperation('TUNE'),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Start tuning timeout')), 10000) // tuning may require extra time
          ),
        ]);

        this.lastSuccessfulOperation = Date.now();
        logger.debug('Manual tuning started');

        return true;
      } catch (error) {
        logger.error('Failed to start tuning:', error);
        throw this.convertError(error, 'startTuning');
      }
    });
  }

  // ===== Level 类控制 =====

  /**
   * 检查某个 Hamlib level 是否被当前电台支持
   * 供 RadioCapabilityManager 探测时使用，无需额外 CAT 命令。
   */
  isSupportedLevel(level: string): boolean {
    return this.supportedLevels.has(level);
  }

  isSupportedFunction(functionName: string): boolean {
    return this.supportedFunctions.has(functionName.trim().toUpperCase());
  }

  isSupportedParm(parmName: string): boolean {
    return this.supportedParms.has(parmName.trim().toUpperCase());
  }

  /**
   * 获取发射功率（0.0–1.0）
   */
  async getRFPower(): Promise<number> {
    return this.runSerializedTask('getRFPower', async () => {
      this.checkConnected();
      if (!this.supportedLevels.has('RFPOWER')) {
        throw new Error('RFPOWER level not supported by this radio');
      }
      try {
        const value = (await Promise.race([
          this.rig!.getLevel('RFPOWER'),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Get RF power timeout')), 5000)
          ),
        ])) as number;
        this.lastSuccessfulOperation = Date.now();
        return value;
      } catch (error) {
        throw this.convertError(error, 'getRFPower');
      }
    });
  }

  /**
   * 设置发射功率（0.0–1.0）
   */
  async setRFPower(value: number): Promise<void> {
    await this.runSerializedTask('setRFPower', async () => {
      this.checkConnected();
      try {
        await Promise.race([
          this.rig!.setLevel('RFPOWER', value),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Set RF power timeout')), 5000)
          ),
        ]);
        this.lastSuccessfulOperation = Date.now();
        logger.debug(`RF power set: ${(value * 100).toFixed(0)}%`);
      } catch (error) {
        throw this.convertError(error, 'setRFPower');
      }
    });
  }

  /**
   * 获取 AF 增益（0.0–1.0）
   */
  async getAFGain(): Promise<number> {
    return this.runSerializedTask('getAFGain', async () => {
      this.checkConnected();
      if (!this.supportedLevels.has('AF')) {
        throw new Error('AF level not supported by this radio');
      }
      try {
        const value = (await Promise.race([
          this.rig!.getLevel('AF'),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Get AF gain timeout')), 5000)
          ),
        ])) as number;
        this.lastSuccessfulOperation = Date.now();
        return value;
      } catch (error) {
        throw this.convertError(error, 'getAFGain');
      }
    });
  }

  /**
   * 设置 AF 增益（0.0–1.0）
   */
  async setAFGain(value: number): Promise<void> {
    await this.runSerializedTask('setAFGain', async () => {
      this.checkConnected();
      try {
        await Promise.race([
          this.rig!.setLevel('AF', value),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Set AF gain timeout')), 5000)
          ),
        ]);
        this.lastSuccessfulOperation = Date.now();
        logger.debug(`AF gain set: ${(value * 100).toFixed(0)}%`);
      } catch (error) {
        throw this.convertError(error, 'setAFGain');
      }
    });
  }

  /**
   * 获取静噪电平（0.0–1.0）
   */
  async getSQL(): Promise<number> {
    return this.runSerializedTask('getSQL', async () => {
      this.checkConnected();
      if (!this.supportedLevels.has('SQL')) {
        throw new Error('SQL level not supported by this radio');
      }
      try {
        const value = (await Promise.race([
          this.rig!.getLevel('SQL'),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Get SQL timeout')), 5000)
          ),
        ])) as number;
        this.lastSuccessfulOperation = Date.now();
        return value;
      } catch (error) {
        throw this.convertError(error, 'getSQL');
      }
    });
  }

  /**
   * 设置静噪电平（0.0–1.0）
   */
  async setSQL(value: number): Promise<void> {
    await this.runSerializedTask('setSQL', async () => {
      this.checkConnected();
      try {
        await Promise.race([
          this.rig!.setLevel('SQL', value),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Set SQL timeout')), 5000)
          ),
        ]);
        this.lastSuccessfulOperation = Date.now();
        logger.debug(`SQL set: ${(value * 100).toFixed(0)}%`);
      } catch (error) {
        throw this.convertError(error, 'setSQL');
      }
    });
  }

  async getMicGain(): Promise<number> {
    return this.runSerializedTask('getMicGain', async () => {
      this.checkConnected();
      if (!this.supportedLevels.has('MICGAIN')) {
        throw new Error('MICGAIN level not supported by this radio');
      }
      try {
        const value = (await Promise.race([
          this.rig!.getLevel('MICGAIN'),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Get MIC gain timeout')), 5000)
          ),
        ])) as number;
        this.lastSuccessfulOperation = Date.now();
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
        await Promise.race([
          this.rig!.setLevel('MICGAIN', value),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Set MIC gain timeout')), 5000)
          ),
        ]);
        this.lastSuccessfulOperation = Date.now();
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
        const value = (await Promise.race([
          this.rig!.getFunction('NB'),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Get NB state timeout')), 5000)
          ),
        ])) as boolean;
        this.lastSuccessfulOperation = Date.now();
        logger.debug(`NB state read: ${value ? 'enabled' : 'disabled'}`);
        return value ? 1 : 0;
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'getNBEnabled');
      }
    });
  }

  async setNBEnabled(value: number): Promise<void> {
    await this.runSerializedTask('setNBEnabled', async () => {
      this.checkConnected();
      try {
        await Promise.race([
          this.rig!.setFunction('NB', value > 0),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Set NB state timeout')), 5000)
          ),
        ]);
        this.lastSuccessfulOperation = Date.now();
        logger.debug(`NB state set: ${value > 0 ? 'enabled' : 'disabled'}`);
      } catch (error) {
        throw this.convertError(error, 'setNBEnabled');
      }
    });
  }

  async getNREnabled(): Promise<number> {
    return this.runSerializedTask('getNREnabled', async () => {
      this.checkConnected();
      try {
        const value = (await Promise.race([
          this.rig!.getFunction('NR'),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Get NR state timeout')), 5000)
          ),
        ])) as boolean;
        this.lastSuccessfulOperation = Date.now();
        logger.debug(`NR state read: ${value ? 'enabled' : 'disabled'}`);
        return value ? 1 : 0;
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'getNREnabled');
      }
    });
  }

  async setNREnabled(value: number): Promise<void> {
    await this.runSerializedTask('setNREnabled', async () => {
      this.checkConnected();
      try {
        await Promise.race([
          this.rig!.setFunction('NR', value > 0),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Set NR state timeout')), 5000)
          ),
        ]);
        this.lastSuccessfulOperation = Date.now();
        logger.debug(`NR state set: ${value > 0 ? 'enabled' : 'disabled'}`);
      } catch (error) {
        throw this.convertError(error, 'setNREnabled');
      }
    });
  }

  async getLockMode(): Promise<boolean> {
    return this.runSerializedTask('getLockMode', async () => {
      this.checkConnected();
      try {
        const value = (await Promise.race([
          this.rig!.getLockMode(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Get lock mode timeout')), 5000)
          ),
        ])) as number;
        this.lastSuccessfulOperation = Date.now();
        return value > 0;
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'getLockMode');
      }
    });
  }

  async setLockMode(enabled: boolean): Promise<void> {
    await this.runSerializedTask('setLockMode', async () => {
      this.checkConnected();
      try {
        await Promise.race([
          this.rig!.setLockMode(enabled ? 1 : 0),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Set lock mode timeout')), 5000)
          ),
        ]);
        this.lastSuccessfulOperation = Date.now();
        logger.debug(`Lock mode set: ${enabled ? 'locked' : 'unlocked'}`);
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'setLockMode');
      }
    });
  }

  async getMuteEnabled(): Promise<boolean> {
    return this.runSerializedTask('getMuteEnabled', async () => {
      this.checkConnected();
      try {
        const value = (await Promise.race([
          this.rig!.getFunction('MUTE'),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Get mute state timeout')), 5000)
          ),
        ])) as boolean;
        this.lastSuccessfulOperation = Date.now();
        return value;
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'getMuteEnabled');
      }
    });
  }

  async setMuteEnabled(enabled: boolean): Promise<void> {
    await this.runSerializedTask('setMuteEnabled', async () => {
      this.checkConnected();
      try {
        await Promise.race([
          this.rig!.setFunction('MUTE', enabled),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Set mute state timeout')), 5000)
          ),
        ]);
        this.lastSuccessfulOperation = Date.now();
        logger.debug(`Mute state set: ${enabled ? 'enabled' : 'disabled'}`);
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'setMuteEnabled');
      }
    });
  }

  async getVOXEnabled(): Promise<boolean> {
    return this.runSerializedTask('getVOXEnabled', async () => {
      this.checkConnected();
      try {
        const value = (await Promise.race([
          this.rig!.getFunction('VOX'),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Get VOX state timeout')), 5000)
          ),
        ])) as boolean;
        this.lastSuccessfulOperation = Date.now();
        return value;
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'getVOXEnabled');
      }
    });
  }

  async setVOXEnabled(enabled: boolean): Promise<void> {
    await this.runSerializedTask('setVOXEnabled', async () => {
      this.checkConnected();
      try {
        await Promise.race([
          this.rig!.setFunction('VOX', enabled),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Set VOX state timeout')), 5000)
          ),
        ]);
        this.lastSuccessfulOperation = Date.now();
        logger.debug(`VOX state set: ${enabled ? 'enabled' : 'disabled'}`);
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'setVOXEnabled');
      }
    });
  }

  async getRitOffset(): Promise<number> {
    return this.runSerializedTask('getRitOffset', async () => {
      this.checkConnected();
      try {
        const value = (await Promise.race([
          this.rig!.getRit(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Get RIT timeout')), 5000)
          ),
        ])) as number;
        this.lastSuccessfulOperation = Date.now();
        return value;
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'getRitOffset');
      }
    });
  }

  async setRitOffset(offsetHz: number): Promise<void> {
    await this.runSerializedTask('setRitOffset', async () => {
      this.checkConnected();
      try {
        await Promise.race([
          this.rig!.setRit(offsetHz),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Set RIT timeout')), 5000)
          ),
        ]);
        this.lastSuccessfulOperation = Date.now();
        logger.debug('RIT offset set', { offsetHz });
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'setRitOffset');
      }
    });
  }

  async getXitOffset(): Promise<number> {
    return this.runSerializedTask('getXitOffset', async () => {
      this.checkConnected();
      try {
        const value = (await Promise.race([
          this.rig!.getXit(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Get XIT timeout')), 5000)
          ),
        ])) as number;
        this.lastSuccessfulOperation = Date.now();
        return value;
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'getXitOffset');
      }
    });
  }

  async setXitOffset(offsetHz: number): Promise<void> {
    await this.runSerializedTask('setXitOffset', async () => {
      this.checkConnected();
      try {
        await Promise.race([
          this.rig!.setXit(offsetHz),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Set XIT timeout')), 5000)
          ),
        ]);
        this.lastSuccessfulOperation = Date.now();
        logger.debug('XIT offset set', { offsetHz });
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'setXitOffset');
      }
    });
  }

  async getTuningStep(): Promise<number> {
    return this.runSerializedTask('getTuningStep', async () => {
      this.checkConnected();
      try {
        const value = (await Promise.race([
          this.rig!.getTuningStep(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Get tuning step timeout')), 5000)
          ),
        ])) as number;
        this.lastSuccessfulOperation = Date.now();
        return value;
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'getTuningStep');
      }
    });
  }

  async setTuningStep(stepHz: number): Promise<void> {
    await this.runSerializedTask('setTuningStep', async () => {
      this.checkConnected();
      try {
        await Promise.race([
          this.rig!.setTuningStep(stepHz),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Set tuning step timeout')), 5000)
          ),
        ]);
        this.lastSuccessfulOperation = Date.now();
        logger.debug('Tuning step set', { stepHz });
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'setTuningStep');
      }
    });
  }

  async getSupportedTuningSteps(): Promise<number[]> {
    return this.runSerializedTask('getSupportedTuningSteps', async () => {
      this.checkConnected();
      try {
        const steps = this.rig!.getTuningSteps()
          .map((item) => item.stepHz)
          .filter((step) => Number.isFinite(step) && step > 0);
        return Array.from(new Set(steps)).sort((a, b) => a - b);
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'getSupportedTuningSteps');
      }
    });
  }

  async getPowerState(): Promise<string> {
    return this.runSerializedTask('getPowerState', async () => {
      this.checkConnected();
      try {
        const value = (await Promise.race([
          this.rig!.getPowerstat(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Get power state timeout')), 5000)
          ),
        ])) as number;
        this.lastSuccessfulOperation = Date.now();
        return normalizePowerStateCode(value);
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'getPowerState');
      }
    });
  }

  async setPowerState(state: string): Promise<void> {
    await this.runSerializedTask('setPowerState', async () => {
      this.checkConnected();
      const normalized = state.trim().toLowerCase();
      const codeMap: Record<string, number> = {
        off: 0,
        on: 1,
        standby: 2,
        operate: 4,
        unknown: 8,
      };
      const code = codeMap[normalized];
      if (code === undefined) {
        throw new Error(`Unsupported power state: ${state}`);
      }

      try {
        await Promise.race([
          this.rig!.setPowerstat(code),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Set power state timeout')), 5000)
          ),
        ]);
        this.lastSuccessfulOperation = Date.now();
        logger.debug('Power state set', { state: normalized });
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'setPowerState');
      }
    });
  }

  async getRepeaterShift(): Promise<string> {
    return this.runSerializedTask('getRepeaterShift', async () => {
      this.checkConnected();
      try {
        const value = (await Promise.race([
          this.rig!.getRepeaterShift(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Get repeater shift timeout')), 5000)
          ),
        ])) as string;
        this.lastSuccessfulOperation = Date.now();
        return normalizeRepeaterShiftValue(value);
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'getRepeaterShift');
      }
    });
  }

  async setRepeaterShift(shift: string): Promise<void> {
    await this.runSerializedTask('setRepeaterShift', async () => {
      this.checkConnected();
      const normalized = normalizeRepeaterShiftValue(shift);
      const valueMap: Record<string, 'NONE' | 'MINUS' | 'PLUS'> = {
        none: 'NONE',
        minus: 'MINUS',
        plus: 'PLUS',
      };

      try {
        await Promise.race([
          this.rig!.setRepeaterShift(valueMap[normalized]),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Set repeater shift timeout')), 5000)
          ),
        ]);
        this.lastSuccessfulOperation = Date.now();
        logger.debug('Repeater shift set', { shift: normalized });
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'setRepeaterShift');
      }
    });
  }

  async getRepeaterOffset(): Promise<number> {
    return this.runSerializedTask('getRepeaterOffset', async () => {
      this.checkConnected();
      try {
        const value = (await Promise.race([
          this.rig!.getRepeaterOffset(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Get repeater offset timeout')), 5000)
          ),
        ])) as number;
        this.lastSuccessfulOperation = Date.now();
        return value;
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'getRepeaterOffset');
      }
    });
  }

  async setRepeaterOffset(offsetHz: number): Promise<void> {
    await this.runSerializedTask('setRepeaterOffset', async () => {
      this.checkConnected();
      try {
        await Promise.race([
          this.rig!.setRepeaterOffset(offsetHz),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Set repeater offset timeout')), 5000)
          ),
        ]);
        this.lastSuccessfulOperation = Date.now();
        logger.debug('Repeater offset set', { offsetHz });
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'setRepeaterOffset');
      }
    });
  }

  async getCtcssTone(): Promise<number> {
    return this.runSerializedTask('getCtcssTone', async () => {
      this.checkConnected();
      try {
        const value = (await Promise.race([
          this.rig!.getCtcssTone(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Get CTCSS tone timeout')), 5000)
          ),
        ])) as number;
        this.lastSuccessfulOperation = Date.now();
        return value;
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'getCtcssTone');
      }
    });
  }

  async setCtcssTone(tone: number): Promise<void> {
    await this.runSerializedTask('setCtcssTone', async () => {
      this.checkConnected();
      try {
        await Promise.race([
          this.rig!.setCtcssTone(tone),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Set CTCSS tone timeout')), 5000)
          ),
        ]);
        this.lastSuccessfulOperation = Date.now();
        logger.debug('CTCSS tone set', { tone });
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'setCtcssTone');
      }
    });
  }

  async getAvailableCtcssTones(): Promise<number[]> {
    return this.runSerializedTask('getAvailableCtcssTones', async () => {
      this.checkConnected();
      try {
        const tones = this.rig!.getAvailableCtcssTones()
          .filter((tone) => Number.isFinite(tone) && tone > 0);
        return Array.from(new Set(tones)).sort((a, b) => a - b);
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'getAvailableCtcssTones');
      }
    });
  }

  async getDcsCode(): Promise<number> {
    return this.runSerializedTask('getDcsCode', async () => {
      this.checkConnected();
      try {
        const value = (await Promise.race([
          this.rig!.getDcsCode(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Get DCS code timeout')), 5000)
          ),
        ])) as number;
        this.lastSuccessfulOperation = Date.now();
        return value;
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'getDcsCode');
      }
    });
  }

  async setDcsCode(code: number): Promise<void> {
    await this.runSerializedTask('setDcsCode', async () => {
      this.checkConnected();
      try {
        await Promise.race([
          this.rig!.setDcsCode(code),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Set DCS code timeout')), 5000)
          ),
        ]);
        this.lastSuccessfulOperation = Date.now();
        logger.debug('DCS code set', { code });
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'setDcsCode');
      }
    });
  }

  async getAvailableDcsCodes(): Promise<number[]> {
    return this.runSerializedTask('getAvailableDcsCodes', async () => {
      this.checkConnected();
      try {
        const codes = this.rig!.getAvailableDcsCodes()
          .filter((code) => Number.isFinite(code) && code > 0);
        return Array.from(new Set(codes)).sort((a, b) => a - b);
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'getAvailableDcsCodes');
      }
    });
  }

  async getMaxRit(): Promise<number> {
    return this.runSerializedTask('getMaxRit', async () => {
      this.checkConnected();
      try {
        return this.rig!.getMaxRit();
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'getMaxRit');
      }
    });
  }

  async getMaxXit(): Promise<number> {
    return this.runSerializedTask('getMaxXit', async () => {
      this.checkConnected();
      try {
        return this.rig!.getMaxXit();
      } catch (error) {
        throw this.convertOptionalOperationError(error, 'getMaxXit');
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
   * 打开连接
   */
  private async openConnection(): Promise<void> {
    if (!this.rig) {
      throw new Error('Radio instance not initialized');
    }

    await this.rig.open();
  }

  /**
   * 验证与电台的实际通信
   *
   * 在 rig.open() 成功后、设置 CONNECTED 状态前调用。
   * rig.open() 只是打开串口设备文件，不验证 CI-V 握手，
   * 因此需要尝试实际通信（读取频率）来确认电台在线。
   *
   * 此时状态仍为 CONNECTING，不能使用 this.getFrequency()（会 checkConnected 失败），
   * 直接调用 this.rig.getFrequency()，默认使用当前 VFO，与运行态读频保持一致。
   */
  private async verifyRadioCommunication(): Promise<void> {
    if (!this.rig) {
      throw new Error('Radio instance not initialized');
    }

    const VERIFY_TIMEOUT = 5000;

    try {
      logger.debug('Verifying radio communication...');

      await Promise.race([
        this.rig.getFrequency(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Communication verification timeout')), VERIFY_TIMEOUT)
        ),
      ]);

      logger.debug('Radio communication verified successfully');
    } catch (error) {
      throw new RadioError({
        code: RadioErrorCode.CONNECTION_FAILED,
        message: `Serial port opened but cannot communicate with radio: ${(error as Error).message}`,
        userMessage: 'Serial port opened but cannot establish radio communication',
        severity: RadioErrorSeverity.ERROR,
        suggestions: [
          'Check if radio is powered on',
          'Check if serial cable (CI-V/CAT) is properly connected',
          'Confirm correct radio model selection',
          'Verify baud rate and serial parameters match',
          'Some radios require enabling CI-V/CAT function',
        ],
        cause: error,
        context: {
          operation: 'verifyRadioCommunication',
          port: this.currentConfig?.serial?.path,
          rigModel: this.currentConfig?.serial?.rigModel,
        },
      });
    }
  }

  /**
   * 应用串口配置参数
   */
  private async applyBackendConfig(serial: { path?: string; serialConfig?: SerialConfig; backendConfig?: Record<string, string> }): Promise<void> {
    if (!this.rig) {
      throw new Error('Radio instance not initialized');
    }

    logger.debug('Applying Hamlib backend config parameters...');

    try {
      const backendConfig = buildBackendConfig(serial as any, {
        pttMethod: this.currentConfig?.pttMethod,
        pttPort: this.currentConfig?.pttPort,
      });
      const configs = Object.entries(backendConfig).map(([param, value]) => ({ param, value }));

      for (const config of configs) {
        if (config.value !== undefined && config.value !== null) {
          logger.debug(`Setting ${config.param}: ${config.value}`);
          await Promise.race([
            this.rig!.setConf(config.param, config.value),
            new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error(`Set ${config.param} timeout`)),
                3000
              )
            ),
          ]);
        }
      }

      logger.debug('Hamlib backend config parameters applied successfully');
    } catch (error) {
      logger.warn('Failed to apply Hamlib backend config:', (error as Error).message);
      throw new Error(`Hamlib backend configuration failed: ${(error as Error).message}`);
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
      await Promise.race([
        this.rig!.setFrequency(frequency),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Set frequency timeout')), 5000)
        ),
      ]);

      await this.syncSplitFrequencyIfNeeded(frequency);
      this.lastSuccessfulOperation = Date.now();
      this.currentFrequencyHz = frequency;
      logger.debug(`Frequency set: ${(frequency / 1000000).toFixed(3)} MHz`);
    } catch (error) {
      throw this.convertError(error, 'setFrequency');
    }
  }

  private async performModeWrite(
    mode: string,
    bandwidth?: RadioModeBandwidth,
    options?: SetRadioModeOptions,
  ): Promise<boolean> {
    this.checkConnected();

    try {
      const requestedMode = normalizeModeName(mode);
      const resolvedMode = this.resolveModeForIntent(requestedMode, options);
      const previousMode = this.currentRadioMode;

      await Promise.race([
        this.rig!.setMode(resolvedMode, bandwidth as any),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Set mode timeout')), 5000)
        ),
      ]);

      this.lastSuccessfulOperation = Date.now();
      this.currentRadioMode = normalizeModeName(resolvedMode);
      logger.debug(`Mode set: ${requestedMode} -> ${resolvedMode}${bandwidth !== undefined ? ` (${bandwidth})` : ''}`, {
        requestedMode,
        resolvedMode,
        intent: options?.intent ?? 'unspecified',
      });

      return previousMode !== this.currentRadioMode;
    } catch (error) {
      throw this.convertOptionalOperationError(error, 'setMode');
    }
  }

  private async performModeRead(): Promise<RadioModeInfo> {
    this.checkConnected();

    try {
      const modeInfo = (await Promise.race([
        this.rig!.getMode(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Get mode timeout')), 5000)
        ),
      ])) as RadioModeInfo;

      this.lastSuccessfulOperation = Date.now();
      this.currentRadioMode = normalizeModeName(modeInfo.mode);
      return modeInfo;
    } catch (error) {
      throw this.convertOptionalOperationError(error, 'getMode');
    }
  }

  private async performPTTWrite(enabled: boolean): Promise<void> {
    this.checkConnected();

    if (this.pttMethod === 'vox') {
      return;
    }

    try {
      await Promise.race([
        this.rig!.setPtt(enabled),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('PTT operation timeout')), 3000)
        ),
      ]);

      this.lastSuccessfulOperation = Date.now();
      logger.debug(`PTT set: ${enabled ? 'TX' : 'RX'}`);
    } catch (error) {
      throw RadioError.pttActivationFailed(
        `PTT ${enabled ? 'activation' : 'deactivation'} failed`,
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  private async syncSplitFrequencyIfNeeded(frequency: number): Promise<void> {
    const splitEnabled = await this.isSplitEnabled();

    if (!splitEnabled) {
      return;
    }

    try {
      await Promise.race([
        this.rig!.setSplitFreq(frequency),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Set split frequency timeout')), 5000)
        ),
      ]);

      this.lastSuccessfulOperation = Date.now();
      logger.debug(`Split TX frequency synchronized: ${(frequency / 1000000).toFixed(3)} MHz`);
    } catch (error) {
      logger.warn(`Split TX frequency sync failed: ${this.getErrorMessage(error)}`, {
        frequency,
      });
    }
  }

  private async isSplitEnabled(): Promise<boolean> {
    if (this.splitSupportState === 'supported') {
      return this.splitEnabled;
    }

    if (this.splitSupportState === 'unsupported') {
      return false;
    }

    return this.probeSplitStatus();
  }

  private async probeSplitStatus(): Promise<boolean> {
    if (!this.rig) {
      throw new Error('Radio instance not initialized');
    }

    try {
      const splitStatus = await Promise.race([
        this.rig.getSplit(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Get split status timeout')), 5000)
        ),
      ]);

      this.lastSuccessfulOperation = Date.now();
      this.splitSupportState = 'supported';
      this.splitEnabled = Boolean(splitStatus?.enabled);
      logger.debug(`Split status detected via getSplit: ${this.splitEnabled ? 'enabled' : 'disabled'}`);
      return this.splitEnabled;
    } catch (error) {
      if (isRecoverableOptionalRadioError(error)) {
        this.splitSupportState = 'unsupported';
        this.splitEnabled = false;
        logger.debug(`Split status probe unavailable: ${this.getErrorMessage(error)}`);
        return false;
      }

      logger.warn(`Failed to probe split status: ${this.getErrorMessage(error)}`);
      return false;
    }
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  /**
   * 清理资源
   */
  private async cleanup(): Promise<void> {
    // 防重入保护：避免重复调用 rig.close() 导致 pthread_join 超时
    if (this.isCleaningUp) {
      logger.debug('Cleanup already in progress, skipping');
      return;
    }

    this.isCleaningUp = true;

    // 停止数值表轮询
    this.stopMeterPolling();

    try {
      if (this.rig) {
        const isFastShutdown = isProcessShuttingDown();
        const spectrumStopTimeoutMs = isFastShutdown ? 250 : 1000;
        const closeTimeoutMs = isFastShutdown ? 750 : 5000;

        try {
          await Promise.race([
            this.stopManagedSpectrum(),
            new Promise((_, reject) => {
              setTimeout(() => reject(new Error('Stop managed spectrum timeout')), spectrumStopTimeoutMs);
            }),
          ]);
        } catch (error) {
          logger.warn('Failed to stop managed spectrum during cleanup', error);
        }

        try {
          await Promise.race([
            this.rig.close(),
            new Promise((_, reject) => {
              setTimeout(() => reject(new Error('Close connection timeout')), closeTimeoutMs);
            }),
          ]);
        } catch (error) {
          logger.warn('Failed to close connection during cleanup:', error);
        }

        this.rig = null;
        this.spectrumController = null;
      }

      this.currentConfig = null;
      this.pttMethod = 'cat';
      this.backgroundTasksStarted = false;
      this.supportedLevels.clear();
      this.meterDecodeStrategy = resolveHamlibMeterDecodeStrategy({ supportedLevels: [] });
      this.meterRigMetadata = null;
      this.hasLoggedMeterStrategySample = false;
      this.supportedModes.clear();
      this.supportedFunctions.clear();
      this.supportedParms.clear();
      this.txFrequencyRanges = [];
      this.currentRadioMode = null;
      this.splitSupportState = 'unknown';
      this.splitEnabled = false;
      this.removeAllListeners();
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

        // 如果没有任何支持的 level，使用当前 VFO 读频做健康检查
        const levelMeterSource = this.getSelectedLevelMeterSource();
        const hasAnyLevel = levelMeterSource !== null || this.supportedLevels.has('SWR')
          || this.supportedLevels.has('ALC')
          || this.supportedLevels.has('RFPOWER_METER')
          || this.supportedLevels.has('RFPOWER_METER_WATTS');

        if (!hasAnyLevel) {
          try {
            await this.rig.getFrequency();
            this.lastSuccessfulOperation = Date.now();
          } catch (error) {
            logger.debug(`Meter fallback frequency read failed: ${this.getErrorMessage(error)}`);
          }
          return;
        }

        const strength = levelMeterSource !== null
          ? await this.readMeterLevel(levelMeterSource)
          : null;
        const swr = this.supportedLevels.has('SWR')
          ? await this.readMeterLevel('SWR')
          : null;
        const alc = this.supportedLevels.has('ALC')
          ? await this.readMeterLevel('ALC')
          : null;
        const power = this.supportedLevels.has('RFPOWER_METER')
          ? await this.readMeterLevel('RFPOWER_METER')
          : null;
        const powerWatts = this.supportedLevels.has('RFPOWER_METER_WATTS')
          ? await this.readMeterLevel('RFPOWER_METER_WATTS')
          : null;

        if (strength === null && swr === null && alc === null && power === null && powerWatts === null) {
          return;
        }

        const level = strength !== null ? this.convertLevelReading(strength) : null;
        if (strength !== null && level !== null) {
          await this.maybeLogMeterStrategySample(strength, level);
        }

        const meterData: MeterData = {
          level,
          swr: swr !== null ? this.convertSWR(swr) : null,
          alc: alc !== null ? this.convertALC(alc) : null,
          power: (power !== null || powerWatts !== null) ? this.convertPower(power, powerWatts) : null,
        };

        this.lastSuccessfulOperation = Date.now();
        this.emit('meterData', meterData);
        globalEventBus.emit('bus:meterData', meterData);
      });

      if (result === RADIO_IO_SKIPPED) {
        logger.debug('Skipping meter polling because critical or queued CAT work is in progress');
      }
    } catch (error) {
      logger.debug(`Skipping meter polling result: ${this.getErrorMessage(error)}`);
    }
  }

  private async readMeterLevel(level: string): Promise<number | null> {
    try {
      return await this.rig!.getLevel(level as any);
    } catch (error) {
      logger.debug(`Meter level read failed for ${level}: ${this.getErrorMessage(error)}`);
      return null;
    }
  }

  private convertLevelReading(rawValue: number): LevelMeterReading {
    switch (this.meterDecodeStrategy.name) {
      case 'icom':
        return hamlibStrengthToLevelMeterReading(rawValue, this.currentFrequencyHz);
      case 'yaesu':
        return yaesuRawstrToLevelMeterReading(rawValue, this.currentFrequencyHz);
      case 'generic':
      default:
        return genericHamlibStrengthToLevelMeterReading(rawValue, this.currentFrequencyHz);
    }
  }

  private async maybeLogMeterStrategySample(primaryValue: number, level: LevelMeterReading): Promise<void> {
    if (this.hasLoggedMeterStrategySample || this.meterDecodeStrategy.name !== 'yaesu') {
      return;
    }

    this.hasLoggedMeterStrategySample = true;

    if (!this.supportedLevels.has('STRENGTH')) {
      return;
    }

    const fallbackStrength = await this.readMeterLevel('STRENGTH');
    if (fallbackStrength === null) {
      return;
    }

    logger.info('Yaesu meter sample captured', {
      strategy: this.meterDecodeStrategy.label,
      manufacturer: this.meterRigMetadata?.mfgName ?? null,
      modelName: this.meterRigMetadata?.modelName ?? null,
      rigModel: this.meterRigMetadata?.rigModel ?? null,
      rawstr: primaryValue,
      strength: fallbackStrength,
      formatted: level.formatted,
    });
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

    // alert: ALC at maximum (>= 100%) indicates true overload (clipped)
    const alert = alcValue >= 1.0;

    return { raw, percent, alert };
  }

  /**
   * 将 Hamlib RFPOWER_METER / RFPOWER_METER_WATTS 转换为 Power 数据
   * @param meterValue - RFPOWER_METER 返回值（标准 0.0-1.0 百分比，部分电台可能返回瓦数）
   * @param meterWattsValue - RFPOWER_METER_WATTS 返回值（绝对瓦数，仅部分电台支持）
   */
  private convertPower(
    meterValue: number | null,
    meterWattsValue: number | null
  ): { raw: number; percent: number; watts: number | null; maxWatts: number | null } {
    const maxWatts = this.resolveCurrentTxPowerMaxWatts();

    // 优先使用 RFPOWER_METER_WATTS（绝对瓦数，可信）
    if (meterWattsValue !== null) {
      const percent = maxWatts && maxWatts > 0
        ? clampPercent((meterWattsValue / maxWatts) * 100)
        : (meterValue !== null && meterValue <= 1.0 ? clampPercent(meterValue * 100) : 0);
      const raw = Math.round(percent * 2.55);
      return { raw, percent, watts: meterWattsValue, maxWatts };
    }

    // 仅有 RFPOWER_METER
    if (meterValue !== null) {
      if (meterValue > 1.0) {
        // 异常：RFPOWER_METER 返回了瓦数而非百分比（如 IC-705 Hamlib 后端）
        const percent = maxWatts && maxWatts > 0
          ? clampPercent((meterValue / maxWatts) * 100)
          : 0;
        const raw = Math.round(percent * 2.55);
        return { raw, percent, watts: meterValue, maxWatts };
      }
      const percent = clampPercent(meterValue * 100);
      const raw = Math.round(meterValue * 255);
      return { raw, percent, watts: null, maxWatts };
    }

    return { raw: 0, percent: 0, watts: null, maxWatts };
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
        message: `Hamlib connection failed: ${errorMessage}`,
        userMessage: 'Cannot connect to radio',
        suggestions: [
          'Check if radio is powered on',
          'Check if network is functioning',
          'Verify host address and port are correct',
          'Verify serial device path is correct',
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
        message: `Hamlib connection timeout: ${errorMessage}`,
        userMessage: 'Timeout connecting to radio',
        suggestions: [
          'Check if network is functioning',
          'Verify radio responds normally',
          'Try increasing timeout duration',
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
        message: `Hamlib device error: ${errorMessage}`,
        userMessage: 'Radio device not found or not configured',
        suggestions: [
          'Verify serial device is properly connected',
          'Check if device drivers are installed',
          'Verify device path is correct',
          'Try disconnecting and reconnecting the device',
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
        message: `Hamlib IO error: ${errorMessage}`,
        userMessage: 'Radio communication error',
        suggestions: [
          'Verify radio connection is stable',
          'Check if serial cable is functional',
          'Try restarting the radio',
          'Verify serial parameters are correct',
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
        suggestions: ['Check radio connection status', 'Try executing the operation again'],
        cause: error,
        context: { operation: context },
      });
    }

    // Windows serial port configuration failure (tcsetattr / Invalid configuration)
    if (
      errorMessage.includes('tcsetattr') ||
      (errorMessageLower.includes('invalid configuration') && errorMessage.includes('serial'))
    ) {
      return new RadioError({
        code: RadioErrorCode.INVALID_CONFIG,
        message: `Serial port configuration failed (${context}): ${errorMessage.split('\n')[0]}`,
        userMessage: 'Serial port configuration failed',
        suggestions: [
          'Try using the Network (rigctld) connection type',
          'Ensure no other application is using the COM port',
          'Check that the correct COM port number is selected',
          'Try reinstalling or updating the serial port driver',
        ],
        cause: error,
        context: { operation: context },
      });
    }

    // 未知错误
    return new RadioError({
      code: RadioErrorCode.UNKNOWN_ERROR,
      message: `Hamlib unknown error (${context}): ${errorMessage}`,
      userMessage: 'Radio operation failed',
      suggestions: [
        'Please check detailed error information',
        'Try reconnecting to the radio',
        'If problem persists, contact technical support',
      ],
      cause: error,
      context: { operation: context },
    });
  }

  private convertOptionalOperationError(error: unknown, context: string): RadioError {
    if (isRecoverableOptionalRadioError(error)) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      return new RadioError({
        code: RadioErrorCode.INVALID_OPERATION,
        message: `Optional radio operation unavailable (${context}): ${errorMessage}`,
        userMessage: 'Radio operation is not supported by this model',
        severity: RadioErrorSeverity.WARNING,
        suggestions: [
          'This control can be ignored on older radios',
          'Continue using the supported basic radio operations',
        ],
        cause: error,
        context: {
          operation: context,
          optional: true,
          recoverable: true,
        },
      });
    }

    return this.convertError(error, context);
  }

  private getSpectrumRig(): HamLib {
    const rig = this.rig;
    if (!rig) {
      throw new RadioError({
        code: RadioErrorCode.INVALID_STATE,
        message: 'Radio not connected',
        userMessage: 'Radio not connected',
      });
    }

    return rig;
  }

  private getSpectrumController(): SpectrumControllerLike {
    const controller = this.spectrumController;
    if (!controller) {
      throw new RadioError({
        code: RadioErrorCode.INVALID_OPERATION,
        severity: RadioErrorSeverity.ERROR,
        message: 'Hamlib spectrum controller is not initialized',
        userMessage: 'Hamlib spectrum support is not available',
        context: { operation: 'hamlibSpectrumApi' },
      });
    }

    return controller;
  }
}
