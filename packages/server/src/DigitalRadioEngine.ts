import {
  SlotClock,
  SlotScheduler,
  ClockSourceSystem,
  getBandFromFrequency,
} from '@tx5dr/core';
import {
  MODES,
  type LogbookAnalysis,
  type ModeDescriptor,
  type SlotInfo,
  type SlotPack,
  type DigitalRadioEngineEvents,
  type DecodeWorkerTelemetrySnapshot,
  type WorkerPoolTelemetrySnapshot,
  type CWDecoderConfig,
  type CWDecoderStatus,
  type EngineMode,
  type SquelchStatus,
  type RadioPowerResponse,
  type RadioPowerStateEvent,
  type RadioPowerTarget,
  type WriteCapabilityPayload,
  type TuneToneStartPayload,
  type TuneToneStatus,
  type CWKeyerStatus,
  type CWDecoderBackendDescriptor,
  type CWDecoderRuntimeBackend,
  type PresetFrequency,
  resolveWindowTiming,
} from '@tx5dr/contracts';
import { EventEmitter } from 'eventemitter3';
import {
  AudioStreamManager,
  CW_INPUT_PROCESSING_SAMPLE_RATE,
  DEFAULT_INPUT_PROCESSING_SAMPLE_RATE,
} from './audio/AudioStreamManager.js';
import { WSJTXDecodeWorkQueue } from './decode/WSJTXDecodeWorkQueue.js';
import type { DecodeWorkerPoolHealthSnapshot } from './decode/WSJTXDecodeProcessPool.js';
import { WSJTXEncodeWorkQueue } from './decode/WSJTXEncodeWorkQueue.js';
import { SlotPackManager } from './slot/SlotPackManager.js';
import { ConfigManager } from './config/config-manager.js';
import { SpectrumScheduler } from './audio/SpectrumScheduler.js';
import { AudioMixer } from './audio/AudioMixer.js';
import { RadioOperatorManager } from './operator/RadioOperatorManager.js';
import { printAppPaths } from './utils/debug-paths.js';
import {
  PhysicalRadioManager,
  type RepeaterDuplexApplyResult,
  type RepeaterDuplexConfig,
  type ToneSquelchApplyResult,
  type ToneSquelchConfig,
} from './radio/PhysicalRadioManager.js';
import { FrequencyManager } from './radio/FrequencyManager.js';
import { TransmissionTracker } from './transmission/TransmissionTracker.js';
import type { OpenWebRXAudioAdapter } from './openwebrx/OpenWebRXAudioAdapter.js';
import { MemoryLeakDetector } from './utils/MemoryLeakDetector.js';
import { ResourceManager } from './utils/ResourceManager.js';
import { initializePSKReporterService } from './services/PSKReporterService.js';
import { createLogger } from './utils/logger.js';
import { bootstrapCoordinator } from './services/BootstrapCoordinator.js';

const logger = createLogger('DigitalRadioEngine');

type DecodeWorkerEngineEmitter = EventEmitter<{
  decodeWorkerUnavailable: (status: DecodeWorkerPoolHealthSnapshot) => void;
  decodeWorkerRecovered: (status: DecodeWorkerPoolHealthSnapshot) => void;
}>;

// 子系统
import { AudioVolumeController } from './subsystems/AudioVolumeController.js';
import { AudioSidecarController } from './subsystems/AudioSidecarController.js';
import { RadioBridge } from './subsystems/RadioBridge.js';
import { TransmissionPipeline } from './subsystems/TransmissionPipeline.js';
import { ClockCoordinator } from './subsystems/ClockCoordinator.js';
import { EngineLifecycle } from './subsystems/EngineLifecycle.js';
import { VoiceSessionManager } from './voice/VoiceSessionManager.js';
import { VoiceKeyerManager } from './voice/VoiceKeyerManager.js';
import { CWKeyerManager } from './cw/CWKeyerManager.js';
import { CWDecoderManager, DEFAULT_CW_DECODER_CONFIG, type CWDecoderStatus as ServerCWDecoderStatus, type CWDecoderConfig as ServerCWDecoderConfig } from './cw-decoder/index.js';
import { EngineState } from './state-machines/types.js';
import { PluginManager } from './plugin/PluginManager.js';
import { tx5drPaths } from './utils/app-paths.js';
import { CallsignContextTracker } from './slot/CallsignContextTracker.js';
import { NtpCalibrationService } from './services/NtpCalibrationService.js';
import { RigctldBridge } from './rigctld/RigctldBridge.js';
import { SquelchStatusMonitor } from './radio/SquelchStatusMonitor.js';
import { PhysicalPttMonitor } from './radio/PhysicalPttMonitor.js';
import type { RigctldBridgeConfig, RigctldStatus } from '@tx5dr/contracts';
import { RadioPowerController } from './radio/RadioPowerController.js';
import { TuneToneController } from './radio/TuneToneController.js';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface DeepCWModelPathConfig {
  language?: string;
  modelSize?: 'tiny' | 'small';
}

export interface DeepCWModelPathOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  moduleDir?: string;
  exists?: (candidate: string) => boolean;
}

const DEFAULT_DEEPCW_MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export function resolveDeepCWModelPath(
  config: DeepCWModelPathConfig,
  options: DeepCWModelPathOptions = {},
): string | null {
  const env = options.env ?? process.env;
  const configured = env.TX5DR_DEEPCW_MODEL_PATH;
  if (configured) return configured;

  const language = config.language === 'en' ? 'en' : 'en';
  const modelSize = config.modelSize === 'small' ? 'small' : 'tiny';
  const fileName = `${language}_${modelSize}.onnx`;
  const cwd = options.cwd ?? process.cwd();
  const moduleDir = options.moduleDir ?? DEFAULT_DEEPCW_MODULE_DIR;
  const appRootFromModule = path.resolve(moduleDir, '..', '..', '..');
  const exists = options.exists ?? existsSync;
  const candidates = [
    env.APP_RESOURCES ? path.join(env.APP_RESOURCES, 'models', 'deepcw', fileName) : null,
    path.resolve(appRootFromModule, 'resources', 'models', 'deepcw', fileName),
    path.resolve(cwd, 'resources', 'models', 'deepcw', fileName),
    path.resolve(cwd, '..', '..', 'resources', 'models', 'deepcw', fileName),
    path.resolve(cwd, '..', '..', '..', 'resources', 'models', 'deepcw', fileName),
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.find((candidate) => exists(candidate)) ?? candidates[0] ?? null;
}

export interface DeepCWRuntimeBackendOptions {
  platform?: NodeJS.Platform | string;
  arch?: NodeJS.Architecture | string;
}

export function resolveDeepCWRuntimeBackends(options: DeepCWRuntimeBackendOptions = {}): CWDecoderRuntimeBackend[] {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const backends: CWDecoderRuntimeBackend[] = ['cpu'];

  if (platform === 'darwin') {
    backends.push('coreml');
  } else if (platform === 'linux' && arch === 'x64') {
    backends.push('cuda', 'webgpu');
  }

  return backends;
}

export interface DeepCWBackendDescriptorOptions {
  available: boolean;
  error?: string | null;
  runtimeBackend?: CWDecoderRuntimeBackend;
}

export function makeDeepCWBackendDescriptor(options: DeepCWBackendDescriptorOptions): CWDecoderBackendDescriptor {
  const runtimeBackends = resolveDeepCWRuntimeBackends();
  return {
    id: 'deepcw-onnx' as const,
    name: 'DeepCW ONNX',
    label: 'DeepCW ONNX',
    available: options.available,
    error: options.error ?? null,
    reason: options.error ?? undefined,
    runtimeBackends,
    modelSizes: ['tiny', 'small'],
    languages: ['en'],
    modes: ['streaming'],
    model: 'en_tiny/en_small',
    runtime: options.runtimeBackend ?? 'cpu',
    attributionName: 'DeepCW / web-deep-cw-decoder',
    sourceUrl: 'https://github.com/e04/web-deep-cw-decoder',
    license: 'GPL-3.0',
  };
}

/**
 * DigitalRadioEngine — 数字电台引擎 Facade
 *
 * 负责：
 * - 装配底层组件与子系统
 * - 维护对外 Facade API
 * - 协调初始化阶段与模式切换
 *
 * 不负责：
 * - 资源启动顺序细节（由 EngineLifecycle 负责）
 * - 电台连接 bootstrap（由 PhysicalRadioManager 负责）
 * - 电台事件投影（由 RadioBridge 负责）
 */
export class DigitalRadioEngine extends EventEmitter<DigitalRadioEngineEvents> {
  private static instance: DigitalRadioEngine | null = null;

  // 底层组件
  private slotClock: SlotClock | null = null;
  private slotScheduler: SlotScheduler | null = null;
  private clockSource: ClockSourceSystem;
  private currentMode: ModeDescriptor = MODES.FT8;
  private audioStreamManager: AudioStreamManager;
  private realDecodeQueue: WSJTXDecodeWorkQueue;
  private realEncodeQueue: WSJTXEncodeWorkQueue;
  private slotPackManager: SlotPackManager;
  private spectrumScheduler: SpectrumScheduler;
  private audioMixer: AudioMixer;
  private radioManager: PhysicalRadioManager;
  private frequencyManager: FrequencyManager;
  private _operatorManager: RadioOperatorManager;
  private transmissionTracker: TransmissionTracker;
  private resourceManager: ResourceManager;

  // 语音模式
  private engineMode: EngineMode = 'digital';
  private voiceSessionManager: VoiceSessionManager | null = null;
  private voiceKeyerManager: VoiceKeyerManager | null = null;

  // CW 模式
  private cwKeyerManager: CWKeyerManager | null = null;
  private cwDecoderManager: CWDecoderManager | null = null;
  private cwDecoderStartedEngine = false;
  private modeSwitchTail: Promise<void> = Promise.resolve();

  // 子系统
  private audioVolumeController: AudioVolumeController;
  private audioSidecar: AudioSidecarController;
  private radioBridge: RadioBridge;
  private rigctldBridge: RigctldBridge;
  private squelchStatusMonitor: SquelchStatusMonitor;
  private physicalPttMonitor: PhysicalPttMonitor;
  private transmissionPipeline: TransmissionPipeline;
  private clockCoordinator!: ClockCoordinator;  // 在 initialize() 中初始化
  private engineLifecycle!: EngineLifecycle;     // 在构造函数末尾初始化
  private _pluginManager!: PluginManager;        // 在构造函数末尾初始化
  private _callsignTracker: CallsignContextTracker;
  private ntpCalibrationService: NtpCalibrationService;
  private voiceManualPttActive = false;
  private voiceKeyerPttActive = false;
  private physicalPttActive = false;
  private unifiedVoicePttActive = false;
  private releaseCwPttPolling: (() => void) | null = null;
  private radioPowerController: RadioPowerController | null = null;
  private tuneToneController: TuneToneController;
  private readonly latestRadioPowerStates = new Map<string, RadioPowerStateEvent>();

  // 频谱分析配置常量
  private static readonly SPECTRUM_CONFIG = {
    ANALYSIS_INTERVAL_MS: 150,
    FFT_SIZE: 8192,
    WINDOW_FUNCTION: 'hann' as const,
    ENABLED: true,
    TARGET_SAMPLE_RATE: 6000
  };

  private constructor() {
    super();
    this.clockSource = new ClockSourceSystem();
    this.ntpCalibrationService = new NtpCalibrationService(
      this.clockSource,
      ConfigManager.getInstance().getNtpServers(),
      {
        autoApplyOffset: ConfigManager.getInstance().getNtpAutoApplyOffset(),
        getCurrentMode: () => this.currentMode,
        isDigitalClockRunning: () => this.slotClock?.isRunning ?? false,
      },
    );
    this.audioStreamManager = new AudioStreamManager({ now: () => this.clockSource.now() });
    this.realDecodeQueue = new WSJTXDecodeWorkQueue();
    const decodeWorkerEvents = this as unknown as DecodeWorkerEngineEmitter;
    this.realDecodeQueue.on('decodeWorkerUnavailable', (status) => {
      decodeWorkerEvents.emit('decodeWorkerUnavailable', status);
    });
    this.realDecodeQueue.on('decodeWorkerRecovered', (status) => {
      decodeWorkerEvents.emit('decodeWorkerRecovered', status);
    });
    this.realEncodeQueue = new WSJTXEncodeWorkQueue(1);
    this.slotPackManager = new SlotPackManager();
    const initialFrequency = ConfigManager.getInstance().getLastSelectedFrequency();
    this.slotPackManager.setFrequencyContext(initialFrequency);
    this.on('frequencyChanged', (data) => {
      this.slotPackManager.setFrequencyContext(data);
    });
    this.audioMixer = new AudioMixer(100);
    this.radioManager = new PhysicalRadioManager();
    this.frequencyManager = new FrequencyManager(ConfigManager.getInstance().getCustomFrequencyPresets());
    this.transmissionTracker = new TransmissionTracker();
    this.resourceManager = new ResourceManager();
    this._callsignTracker = new CallsignContextTracker();

    // 注册内存泄漏检测
    MemoryLeakDetector.getInstance().register('DigitalRadioEngine', this);

    // 初始化操作员管理器
    this._operatorManager = new RadioOperatorManager({
      eventEmitter: this,
      encodeQueue: this.realEncodeQueue,
      clockSource: this.clockSource,
      getCurrentMode: () => this.currentMode,
      slotPackManager: this.slotPackManager,
      setRadioFrequency: (freq: number) => {
        if (this.radioManager) {
          try { this.radioManager.setFrequency(freq); } catch (e) { logger.error('Failed to set radio frequency', e); }
        }
      },
      getRadioFrequency: async () => {
        try {
          const freq = await this.radioManager.getFrequency();
          return typeof freq === 'number' ? freq : null;
        } catch {
          return null;
        }
      },
      getKnownRadioFrequency: () => this.radioManager.getKnownFrequency(),
      transmissionTracker: this.transmissionTracker,
      callsignTracker: this._callsignTracker,
    });

    // 初始化插件管理器（在操作员管理器之后）
    // dataDir 异步获取，先用占位符，initialize() 中完成
    this._pluginManager = new PluginManager({
      eventEmitter: this,
      getOperators: () => this._operatorManager.getAllOperators(),
      getOperatorById: (id) => this._operatorManager.getOperatorById(id),
      getCurrentMode: () => this.currentMode,
      getOperatorAutomationSnapshot: (id) => this._pluginManager.getOperatorAutomationSnapshot(id),
      requestOperatorCall: (operatorId, callsign, lastMessage) => {
        this._pluginManager.requestCall(operatorId, callsign, lastMessage);
      },
      getRadioFrequency: async () => {
        try {
          const freq = await this.radioManager.getFrequency();
          return typeof freq === 'number' ? freq : null;
        } catch { return null; }
      },
      getKnownRadioFrequency: () => this.radioManager.getKnownFrequency(),
      getEngineMode: () => this.engineMode,
      getCurrentRadioMode: () => this.getCurrentRadioMode(),
      setRadioFrequency: (freq) => {
        try { this.radioManager.setFrequency(freq); } catch (e) { logger.error('Failed to set radio frequency', e); }
      },
      getRadioBand: () => ConfigManager.getInstance().getLastSelectedFrequency()?.band ?? '',
      getRadioConnected: () => this.radioManager.isConnected(),
      getRadioCapabilitySnapshot: () => this.radioManager.getCapabilitySnapshot(),
      refreshRadioCapabilities: async () => {
        await this.radioManager.refreshCapabilities();
        return this.radioManager.getCapabilitySnapshot();
      },
      writeRadioCapability: async (payload: WriteCapabilityPayload) => {
        await this.radioManager.writeCapability(payload.id, payload.value, payload.action);
      },
      getRadioPowerSupport: (profileId) => this.getRadioPowerController().getSupportInfo(
        this.resolvePluginRadioProfileId(profileId),
      ),
      getRadioPowerState: (profileId) => this.getLatestRadioPowerState(profileId),
      setRadioPower: (state, options) => this.setPluginRadioPower(state, options),
      getLatestSlotPack: () => this.slotPackManager.getLatestSlotPack(),
      findBestTransmitFrequency: (slotId, minFreq, maxFreq, guardBandwidth, additionalOccupiedFrequenciesHz) => (
        this.slotPackManager.findBestTransmitFrequency(
          slotId,
          minFreq,
          maxFreq,
          guardBandwidth,
          additionalOccupiedFrequenciesHz,
        )
      ),
      setOperatorAudioFrequency: async (operatorId, frequency) => {
        await this._operatorManager.updateOperatorContext(operatorId, { frequency });
      },
      interruptOperatorTransmission: async (operatorId) => {
        await this.removeOperatorFromTransmission(operatorId);
      },
      hasWorkedCallsign: async (operatorId, callsign, options) => {
        return this._operatorManager.hasWorkedCallsign(operatorId, callsign, options);
      },
      hasWorkedDXCC: async (operatorId, dxccEntity) => {
        try {
          const logBook = await this._operatorManager.getLogManager().getOperatorLogBook(operatorId);
          if (!logBook) {
            return false;
          }

          const normalized = dxccEntity.trim().toUpperCase();
          if (!normalized) {
            return false;
          }

          const records = await logBook.provider.queryQSOs({ operatorId });
          return records.some((record) => (record.dxccEntity || '').trim().toUpperCase() === normalized);
        } catch {
          return false;
        }
      },
      hasWorkedGrid: async (operatorId, grid) => {
        try {
          const logBook = await this._operatorManager.getLogManager().getOperatorLogBook(operatorId);
          if (!logBook) {
            return false;
          }

          const normalized = grid.trim().toUpperCase();
          if (!normalized) {
            return false;
          }

          const records = await logBook.provider.queryQSOs({
            operatorId,
            grid: normalized,
            limit: 1,
          });
          return records.length > 0;
        } catch {
          return false;
        }
      },
      analyzeCallsignForOperator: async (operatorId, callsign, grid) => {
        try {
          const logBook = await this._operatorManager.getLogManager().getOperatorLogBook(operatorId);
          if (!logBook) {
            return null;
          }

          const operatorFrequency = this._operatorManager.getOperatorById(operatorId)?.config.frequency;
          const band = operatorFrequency && operatorFrequency > 1_000_000
            ? getBandFromFrequency(operatorFrequency)
            : (ConfigManager.getInstance().getLastSelectedFrequency()?.band ?? 'Unknown');
          const analysis = await logBook.provider.analyzeCallsign(callsign, grid, { band });

          const mapped: LogbookAnalysis = {
            isNewCallsign: analysis.isNewCallsign,
            isNewDxccEntity: analysis.isNewDxccEntity,
            isNewBandDxccEntity: analysis.isNewBandDxccEntity,
            isConfirmedDxcc: analysis.isConfirmedDxcc,
            isNewGrid: analysis.isNewGrid,
            callsign,
            grid,
            prefix: analysis.prefix,
            state: analysis.state,
            stateConfidence: analysis.stateConfidence,
            dxccId: analysis.dxccId,
            dxccEntity: analysis.dxccEntity,
            dxccStatus: analysis.dxccStatus,
          };
          return mapped;
        } catch {
          return null;
        }
      },
      resolveGrid: (callsign: string) => this._callsignTracker.getGrid(callsign),
      resetOperatorRuntime: (operatorId, reason) => {
        this._operatorManager.resetPluginRuntime(operatorId, reason);
      },
      triggerReEncode: (operatorId) => {
        this._operatorManager.triggerPostDecisionReEncode(operatorId);
      },
      dataDir: '', // 将在 initialize() 中更新
    });

    // 初始化频谱调度器
    this.spectrumScheduler = new SpectrumScheduler({
      analysisInterval: DigitalRadioEngine.SPECTRUM_CONFIG.ANALYSIS_INTERVAL_MS,
      fftSize: DigitalRadioEngine.SPECTRUM_CONFIG.FFT_SIZE,
      windowFunction: DigitalRadioEngine.SPECTRUM_CONFIG.WINDOW_FUNCTION,
      enabled: DigitalRadioEngine.SPECTRUM_CONFIG.ENABLED,
      targetSampleRate: DigitalRadioEngine.SPECTRUM_CONFIG.TARGET_SAMPLE_RATE
    }, () => ConfigManager.getInstance().getFT8Config().spectrumWhileTransmitting ?? true);

    // ─── 初始化子系统 ────────────────────────────────

    this.audioVolumeController = new AudioVolumeController(
      this,
      this.audioStreamManager,
      () => this.engineMode,
    );
    this.audioVolumeController.setupEventListeners();

    this.audioSidecar = new AudioSidecarController({
      engineEmitter: this,
      audioStreamManager: this.audioStreamManager,
      audioVolumeController: this.audioVolumeController,
    });

    this.transmissionPipeline = new TransmissionPipeline({
      engineEmitter: this,
      audioMixer: this.audioMixer,
      audioStreamManager: this.audioStreamManager,
      radioManager: this.radioManager,
      spectrumScheduler: this.spectrumScheduler,
      transmissionTracker: this.transmissionTracker,
      encodeQueue: this.realEncodeQueue,
      operatorManager: this._operatorManager,
      clockSource: this.clockSource,
      getCurrentMode: () => this.currentMode,
      getCompensationMs: () => this.slotClock?.getCompensation() ?? 0,
      onBeforeStartPTT: () => this.stopTuneTone('another transmission started'),
    });

    this.radioBridge = new RadioBridge({
      engineEmitter: this,
      radioManager: this.radioManager,
      frequencyManager: this.frequencyManager,
      slotPackManager: this.slotPackManager,
      operatorManager: this._operatorManager,
      getTransmissionPipeline: () => this.transmissionPipeline,
      getEngineLifecycle: () => this.engineLifecycle,
      getEngineMode: () => this.engineMode,
      getCurrentModeName: () => this.currentMode.name,
    });
    this.radioBridge.setupListeners();

    this.squelchStatusMonitor = new SquelchStatusMonitor({
      radioManager: this.radioManager,
      getEngineMode: () => this.engineMode,
      emitStatus: (status) => this.emit('squelchStatusChanged', status),
    });
    this.physicalPttMonitor = new PhysicalPttMonitor({
      radioManager: this.radioManager,
      getEngineMode: () => this.engineMode,
      // CAT PTT reads report the radio's TX/RX state, not who caused TX.
      // Keep polling paused while tx5dr or the keyer is holding PTT so our own
      // keyer transmission is not misclassified as a physical manual override.
      isSoftwarePttActive: () => this.voiceManualPttActive || this.voiceKeyerPttActive,
      emitStatus: (active) => this.handlePhysicalPttChanged(active),
    });
    this.tuneToneController = new TuneToneController({
      radioManager: this.radioManager,
      audioStreamManager: this.audioStreamManager,
      isTransmitBusy: () => this.isTransmitBusyForTuneTone(),
      getOperatorToneHz: (operatorId) => this.resolveTuneToneFrequency(operatorId),
      setSoftwarePttActive: (active) => this.setTuneTonePttActive(active),
      emitStatus: (status) => this.emit('tuneToneStatusChanged', status),
    });
    this.on('radioStatusChanged', () => {
      this.squelchStatusMonitor.reevaluate();
      this.physicalPttMonitor.reevaluate();
      this.cwKeyerManager?.refreshRuntimeState();
    });
    this.on('radioStatusChanged', (data) => {
      if (!data.connected) {
        void this.stopTuneTone('radio disconnected').catch((error) => {
          logger.warn('Failed to stop tune tone after radio disconnect', error);
        });
      }
    });

    this.rigctldBridge = new RigctldBridge(this.radioManager);
    this.rigctldBridge.on('statusChanged', (status) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.emit('rigctldStatus' as any, status);
    });

    // 注意：clockCoordinator 和 engineLifecycle 需要在 initialize() 之后才能完全初始化
    // 因为 slotClock 在 initialize() 中创建
  }

  static getInstance(): DigitalRadioEngine {
    if (!DigitalRadioEngine.instance) {
      DigitalRadioEngine.instance = new DigitalRadioEngine();
    }
    return DigitalRadioEngine.instance;
  }

  // ─── 公开访问器 ──────────────────────────────────

  public get operatorManager(): RadioOperatorManager {
    return this._operatorManager;
  }

  public get pluginManager(): PluginManager {
    return this._pluginManager;
  }

  public get callsignTracker(): CallsignContextTracker {
    return this._callsignTracker;
  }

  public getSlotPackManager(): SlotPackManager {
    return this.slotPackManager;
  }

  public getRadioManager(): PhysicalRadioManager {
    return this.radioManager;
  }

  public getRadioPowerController(): RadioPowerController {
    if (!this.radioPowerController) {
      const controller = RadioPowerController.create({
        radioManager: this.radioManager,
        getEngineLifecycle: () => this.engineLifecycle,
      });
      controller.on('powerState', (event) => {
        if (event.profileId) {
          this.latestRadioPowerStates.set(event.profileId, event);
        }
        this.emit('radioPowerState', event);
      });
      this.radioPowerController = controller;
    }
    return this.radioPowerController;
  }

  private resolvePluginRadioProfileId(profileId?: string): string {
    const resolved = profileId ?? ConfigManager.getInstance().getActiveProfileId();
    if (!resolved) {
      throw new Error('No active radio profile is selected');
    }
    return resolved;
  }

  private getLatestRadioPowerState(profileId?: string): RadioPowerStateEvent | null {
    const resolved = profileId ?? ConfigManager.getInstance().getActiveProfileId();
    return resolved ? this.latestRadioPowerStates.get(resolved) ?? null : null;
  }

  private async setPluginRadioPower(
    state: RadioPowerTarget,
    options?: { profileId?: string; autoEngine?: boolean },
  ): Promise<RadioPowerResponse> {
    const profileId = this.resolvePluginRadioProfileId(options?.profileId);
    const finalState = await this.getRadioPowerController().handleRequest({
      profileId,
      state,
      autoEngine: options?.autoEngine ?? true,
    });
    return { success: true, target: state, state: finalState };
  }

  public getEngineLifecycle(): EngineLifecycle {
    return this.engineLifecycle;
  }

  public getAudioStreamManager(): AudioStreamManager {
    return this.audioStreamManager;
  }

  public getDecodeWorkerTelemetrySnapshot(): DecodeWorkerTelemetrySnapshot | undefined {
    return this.realDecodeQueue.getDecodeWorkerTelemetrySnapshot();
  }

  public getWorkerPoolTelemetrySnapshots(): WorkerPoolTelemetrySnapshot[] {
    const pools: WorkerPoolTelemetrySnapshot[] = [];
    const ft8 = this.realDecodeQueue.getDecodeWorkerTelemetrySnapshot();
    if (ft8) {
      pools.push({
        id: 'wsjtx-decode',
        name: 'FT8/FT4 Decode Workers',
        kind: 'decode',
        summary: ft8.summary,
        workers: ft8.workers,
      });
    }

    const cwTelemetry = this.cwDecoderManager?.getWorkerPoolTelemetrySnapshot();
    if (cwTelemetry) {
      const workers = cwTelemetry.workers ?? [];
      const readyCount = workers.filter((worker) => worker.ready).length;
      const busyCount = workers.filter((worker) => worker.busy).length;
      const status = cwTelemetry.status === 'running'
        ? 'ready'
        : cwTelemetry.status === 'error'
          ? 'unavailable'
          : cwTelemetry.status;
      pools.push({
        id: 'cw-decode',
        name: 'CW Decode Workers',
        kind: 'cw-decode',
        summary: {
          status,
          workerCount: workers.length,
          desiredWorkers: cwTelemetry.workerCount,
          readyCount,
          busyCount,
          totalRss: workers.reduce((sum, worker) => sum + worker.memory.rss, 0),
          totalCpu: workers.reduce((sum, worker) => sum + worker.cpu.total, 0),
          nativeThreadsPerWorker: 1,
          pendingJobs: cwTelemetry.pendingJobs ?? 0,
          activeJobs: cwTelemetry.inFlight,
          lastError: cwTelemetry.lastError ?? undefined,
        },
        workers,
      });
    }

    return pools;
  }

  public getAudioSidecar(): AudioSidecarController {
    return this.audioSidecar;
  }

  public async retryAudioSidecar(): Promise<void> {
    await this.audioSidecar.retryNow();
  }

  public getSpectrumScheduler(): SpectrumScheduler {
    return this.spectrumScheduler;
  }

  public getOpenWebRXAudioAdapter(): OpenWebRXAudioAdapter | null {
    return this.engineLifecycle.getOpenWebRXAudioAdapter();
  }

  public getEngineMode(): EngineMode {
    return this.engineMode;
  }

  public getCurrentRadioMode(): string | null {
    const configManager = ConfigManager.getInstance();
    if (this.engineMode === 'voice') {
      return configManager.getLastVoiceFrequency()?.radioMode ?? null;
    }
    if (this.engineMode === 'cw') {
      return configManager.getLastCWFrequency()?.radioMode ?? 'CW';
    }
    return configManager.getLastSelectedFrequency()?.radioMode ?? null;
  }

  public getVoiceSessionManager(): VoiceSessionManager | null {
    return this.voiceSessionManager;
  }

  public getVoiceKeyerManager(): VoiceKeyerManager | null {
    return this.voiceKeyerManager;
  }

  public getCWKeyerManager(): CWKeyerManager {
    if (!this.cwKeyerManager) {
      this.cwKeyerManager = new CWKeyerManager(() => this.radioManager);
      this.cwKeyerManager.on('cwKeyerStatusChanged', (status) => {
        this.handleCWKeyerStatusChanged(status);
        this.emit('cwKeyerStatusChanged', status);
      });
      this.cwKeyerManager.on('cwConfigChanged', (config) => {
        this.emit('cwConfigChanged', config);
      });
    }
    return this.cwKeyerManager;
  }

  public getCWDecoderManager(): CWDecoderManager {
    if (!this.cwDecoderManager) {
      this.cwDecoderManager = new CWDecoderManager({
        initialConfig: this.toServerCWDecoderConfig(ConfigManager.getInstance().getCWDecoderConfig()),
      });
      this.cwDecoderManager.attachAudioStream(this.audioStreamManager as unknown as import('./cw-decoder/index.js').CWDecoderAudioStream);
      this.cwDecoderManager.on('cwDecoderStatusChanged', (status) => {
        this.emit('cwDecoderStatusChanged', this.toContractCWDecoderStatus(status, this.getEffectiveCWDecoderStatusConfig()));
      });
      this.cwDecoderManager.on('cwDecoderTranscriptReset', (event) => {
        this.emit('cwDecoderEvent', {
          kind: 'transcript_reset',
          sessionId: event.sessionId,
          timestamp: event.timestamp,
        });
      });
      this.cwDecoderManager.on('cwDecoderPending', (event) => {
        this.emit('cwDecoderEvent', {
          kind: 'pending',
          text: event.text,
          confidence: event.confidence,
          timestamp: event.timestamp,
        });
        if (event.sessionId && event.version != null) {
          this.emit('cwDecoderEvent', {
            kind: 'transcript_pending',
            pending: event.text ? {
              sessionId: event.sessionId,
              version: event.version,
              text: event.text,
              plainText: event.plainText,
              finalized: false,
              confidence: event.confidence,
              targetFreqHz: event.targetFreqHz,
              filterWidthHz: event.filterWidthHz,
              characterSpans: event.characterSpans,
              wordSpaceSpans: event.wordSpaceSpans,
              updatedAt: event.timestamp,
            } : null,
            timestamp: event.timestamp,
          });
        }
      });
      this.cwDecoderManager.on('cwDecoderCommit', (event) => {
        const segment = {
          id: event.id,
          sessionId: event.sessionId ?? 'legacy',
          sequence: event.sequence ?? 0,
          text: event.text,
          plainText: event.plainText,
          confidence: event.confidence,
          targetFreqHz: event.targetFreqHz,
          filterWidthHz: event.filterWidthHz,
          startedAt: event.startedAt ?? event.timestamp,
          updatedAt: event.updatedAt ?? event.timestamp,
          endedAt: event.endedAt ?? event.timestamp,
          finalized: true as const,
          prependSpace: event.prependSpace ?? true,
          characterSpans: event.characterSpans,
          wordSpaceSpans: event.wordSpaceSpans,
        };
        this.emit('cwDecoderEvent', {
          kind: 'commit',
          segment,
          text: event.text,
          confidence: event.confidence,
          timestamp: event.timestamp,
        });
        this.emit('cwDecoderEvent', {
          kind: 'transcript_commit',
          segment,
          timestamp: event.timestamp,
        });
      });
      this.cwDecoderManager.on('cwDecoderError', (event) => {
        this.emit('cwDecoderEvent', {
          kind: 'error',
          message: event.error,
          recoverable: event.recoverable,
          timestamp: event.timestamp,
        });
      });
    }
    return this.cwDecoderManager;
  }

  public getCWDecoderConfig(): CWDecoderConfig {
    return ConfigManager.getInstance().getCWDecoderConfig();
  }

  public getCWDecoderBackends() {
    const config = ConfigManager.getInstance().getCWDecoderConfig();
    return this.getCWDecoderManager().getBackends().map((backend) => makeDeepCWBackendDescriptor({
      available: backend.available,
      error: backend.error,
      runtimeBackend: config.runtimeBackend,
    }));
  }

  public getCWDecoderStatus() {
    return this.toContractCWDecoderStatus(this.getCWDecoderManager().getStatus(), this.getEffectiveCWDecoderStatusConfig());
  }

  public async updateCWDecoderConfig(update: Partial<CWDecoderConfig>) {
    const saved = await ConfigManager.getInstance().updateCWDecoderConfig(update);
    const runtimeEnabled = this.cwDecoderManager?.getStatus().enabled ?? false;
    await this.getCWDecoderManager().updateConfig(this.toServerCWDecoderConfig({ ...saved, enabled: runtimeEnabled }));
    return saved;
  }

  public async updateCWDecoderTuning(update: Pick<Partial<CWDecoderConfig>, 'targetFreqHz' | 'filterWidthHz'>) {
    await this.getCWDecoderManager().updateRuntimeTuning(update);
    const status = this.toContractCWDecoderStatus(
      this.getCWDecoderManager().getStatus(),
      this.getEffectiveCWDecoderStatusConfig(),
    );
    this.emit('cwDecoderStatusChanged', status);
    return status;
  }

  public async startCWDecoder(update: Partial<CWDecoderConfig> = {}) {
    const { enabled: _runtimeOnly, ...persistentUpdate } = update;
    const saved = await this.updateCWDecoderConfig(persistentUpdate);
    return this.startCWDecoderRuntime({ ...saved, enabled: true }, 'cw-decoder-start');
  }

  public async stopCWDecoder() {
    const saved = await ConfigManager.getInstance().updateCWDecoderConfig({ enabled: false });
    const shouldStopEngine = this.cwDecoderStartedEngine && this.engineMode === 'cw';
    await this.stopCWDecoderRuntime('user-disabled', saved);
    if (shouldStopEngine) {
      this.cwDecoderStartedEngine = false;
      await this.engineLifecycle.stop();
    } else {
      this.cwDecoderStartedEngine = false;
    }
    this.emitStatusSnapshot();
    return this.toContractCWDecoderStatus(this.getCWDecoderManager().getStatus(), saved);
  }

  public clearCWDecoderTranscript() {
    const status = this.getCWDecoderManager().clearTranscript();
    const contractStatus = this.toContractCWDecoderStatus(status, this.getEffectiveCWDecoderStatusConfig());
    this.emit('cwDecoderStatusChanged', contractStatus);
    return contractStatus;
  }

  public getNtpCalibrationService(): NtpCalibrationService {
    return this.ntpCalibrationService;
  }

  // ─── 初始化 ──────────────────────────────────────

  async initialize(): Promise<void> {
    logger.info('Initializing...');

    await this.initializeRuntimePhase();
    const pskreporterService = await this.initializeDomainServicesPhase();
    await this.initializeSubsystemAssemblyPhase(pskreporterService);
    this.restorePersistedModePhase();
    await this.finalizeLifecyclePhase();

    // rigctld bridge: lifetime-independent of the engine. Start early so
    // external clients can poll while the radio spins up.
    this.rigctldBridge.applyConfig().catch((error) => {
      logger.warn('rigctld bridge initial apply failed', { error: (error as Error).message });
    });

    logger.info(`Initialization complete, current mode: ${this.currentMode.name}, engine mode: ${this.engineMode}`);
  }

  /** Current rigctld bridge status snapshot (for /api/rigctld/status). */
  getRigctldStatus(): RigctldStatus {
    return this.rigctldBridge.getStatus();
  }

  /**
   * Update and persist the rigctld bridge configuration, then reconcile the
   * live listener against it. Returns the effective new config.
   */
  async updateRigctldConfig(patch: Partial<RigctldBridgeConfig>): Promise<RigctldStatus> {
    await ConfigManager.getInstance().updateRigctldConfig(patch);
    await this.rigctldBridge.applyConfig();
    return this.rigctldBridge.getStatus();
  }

  private async initializeRuntimePhase(): Promise<void> {
    logger.info('Initialization phase: runtime');

    await printAppPaths();

    // Start NTP calibration (non-blocking, does not delay engine startup)
    bootstrapCoordinator.startPhase('ntp-initial-check', 'Starting clock calibration');
    await this.ntpCalibrationService.start();
    bootstrapCoordinator.completePhase('ntp-initial-check');

    // 更新插件管理器的数据目录（在 initialize 阶段异步获取）
    const dataDir = await tx5drPaths.getDataDir();
    this._pluginManager.setDataDir(dataDir);

    // 加载插件配置
    const pluginsConfig = ConfigManager.getInstance().getPluginsConfig();
    this._pluginManager.loadConfig(pluginsConfig);

    // 将 pluginManager 注入到 operatorManager，统一由插件系统接管自动化运行时
    this._operatorManager.setPluginManager(this._pluginManager);

    const radioConfig = ConfigManager.getInstance().getRadioConfig();
    const compensationMs = radioConfig.transmitCompensationMs || 0;
    logger.info(`Transmit compensation config: ${compensationMs}ms`);

    this.applyDecodeWindowOverrides();

    this.slotClock = new SlotClock(this.clockSource, this.currentMode, compensationMs);
    this.slotScheduler = new SlotScheduler(
      this.slotClock,
      this.realDecodeQueue,
      this.audioStreamManager.getAudioProvider(),
      this._operatorManager,
      () => ConfigManager.getInstance().getFT8Config().decodeWhileTransmitting ?? false,
      (slotInfo, windowIdx) => this._operatorManager.getDecodeApContext(slotInfo, windowIdx)
    );

    await this.spectrumScheduler.initialize(
      this.audioStreamManager.getAudioProvider(),
      this.audioStreamManager.getInternalSampleRate()
    );
    this.spectrumScheduler.setPTTActive(false);
  }

  private async initializeDomainServicesPhase(): Promise<Awaited<ReturnType<typeof initializePSKReporterService>> | null> {
    logger.info('Initialization phase: domain-services');

    await this.operatorManager.initialize();
    bootstrapCoordinator.startPhase('plugin-bootstrap', 'Loading plugins');
    try {
      await this._pluginManager.start();
      bootstrapCoordinator.completePhase('plugin-bootstrap');
    } catch (error) {
      bootstrapCoordinator.failPhase('plugin-bootstrap', 'Plugin loading failed; retry later');
      logger.error('Plugin manager startup failed; continuing without plugins', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      const pskreporterService = await initializePSKReporterService();
      pskreporterService.setMode(this.currentMode.name);
      logger.info('PSKReporter service initialized');
      return pskreporterService;
    } catch (error) {
      logger.warn('PSKReporter service initialization failed:', error);
      return null;
    }
  }

  private async initializeSubsystemAssemblyPhase(
    pskreporterService: Awaited<ReturnType<typeof initializePSKReporterService>> | null,
  ): Promise<void> {
    logger.info('Initialization phase: subsystem-assembly');

    this.clockCoordinator = new ClockCoordinator({
      engineEmitter: this,
      slotClock: this.slotClock!,
      decodeQueue: this.realDecodeQueue,
      slotPackManager: this.slotPackManager,
      spectrumScheduler: this.spectrumScheduler,
      operatorManager: this._operatorManager,
      callsignTracker: this._callsignTracker,
      getTransmissionPipeline: () => this.transmissionPipeline,
      getRadioBridge: () => this.radioBridge,
      getCurrentMode: () => this.currentMode,
    });
    this.clockCoordinator.setPSKReporterService(pskreporterService);

    this.voiceSessionManager = new VoiceSessionManager({
      radioManager: this.radioManager,
      audioStreamManager: this.audioStreamManager,
      onBeforeStartPTT: () => this.stopTuneTone('voice transmission started'),
    });
    this.voiceKeyerManager = new VoiceKeyerManager({
      voiceSessionManager: this.voiceSessionManager,
      audioStreamManager: this.audioStreamManager,
    });

    await this.initializeVoiceSessionManager();

    this.engineLifecycle = new EngineLifecycle({
      engineEmitter: this,
      resourceManager: this.resourceManager,
      slotClock: this.slotClock!,
      slotScheduler: this.slotScheduler!,
      audioStreamManager: this.audioStreamManager,
      radioManager: this.radioManager,
      spectrumScheduler: this.spectrumScheduler,
      decodeQueue: this.realDecodeQueue,
      operatorManager: this._operatorManager,
      audioMixer: this.audioMixer,
      clockSource: this.clockSource,
      subsystems: {
        transmissionPipeline: this.transmissionPipeline,
        clockCoordinator: this.clockCoordinator,
      },
      getCurrentMode: () => this.currentMode,
      getVoiceSessionManager: () => this.voiceSessionManager,
      getCWKeyerManager: () => this.getCWKeyerManager(),
      getCWDecoderManager: () => this.getCWDecoderManager(),
      getAudioVolumeController: () => this.audioVolumeController,
      getAudioSidecar: () => this.audioSidecar,
      getStatus: () => this.getStatus(),
    });
    this.engineLifecycle.setVoiceSessionManager(this.voiceSessionManager);
  }

  private async initializeVoiceSessionManager(): Promise<void> {
    if (!this.voiceSessionManager) {
      return;
    }

    await this.voiceSessionManager.initialize();

    this.voiceSessionManager.on('voicePttLockChanged', (lock) => {
      this.emit('voicePttLockChanged', lock);
    });
    this.voiceSessionManager.on('pttStatusChanged', (data) => {
      this.handleVoiceSoftwarePttChanged(data);
    });
    this.voiceSessionManager.on('voiceRadioModeChanged', (data) => {
      this.emit('voiceRadioModeChanged', data);
    });

    this.voiceKeyerManager?.on('voiceKeyerStatusChanged', (data) => {
      this.emit('voiceKeyerStatusChanged', data);
    });
  }

  private restorePersistedModePhase(): void {
    logger.info('Initialization phase: restore-mode');

    const configManager = ConfigManager.getInstance();
    const lastEngineMode = configManager.getLastEngineMode();
    const lastDigitalModeName = configManager.getLastDigitalModeName();

    if (lastEngineMode === 'digital' && lastDigitalModeName && lastDigitalModeName !== this.currentMode.name) {
      const targetMode = Object.values(MODES).find(m => m.name === lastDigitalModeName);
      if (targetMode && targetMode.name !== 'VOICE' && targetMode.name !== 'CW') {
        this.currentMode = targetMode;
        this.applyDecodeWindowOverrides();
        this.syncCurrentModeToRuntimeComponents('restore-digital-mode');
        logger.info(`Restored last digital mode: ${this.currentMode.name}`);
      }
    }

    if (lastEngineMode === 'voice') {
      this.engineMode = 'voice';
      this.currentMode = MODES.VOICE;
      this.syncCurrentModeToRuntimeComponents('restore-voice-mode');
      logger.info('Restored last engine mode: voice');
    } else if (lastEngineMode === 'cw') {
      this.engineMode = 'cw';
      this.currentMode = MODES.CW;
      this.syncCurrentModeToRuntimeComponents('restore-cw-mode');
      logger.info('Restored last engine mode: cw');
    }

    this.configureAudioProcessingForCurrentMode('restore-mode');
  }

  private configureAudioProcessingForCurrentMode(reason: string): void {
    const audioStreamManager = this.audioStreamManager as AudioStreamManager | undefined;
    if (!audioStreamManager?.setInputProcessingSampleRate) {
      return;
    }

    const targetSampleRate = this.currentMode.name === 'CW'
      ? CW_INPUT_PROCESSING_SAMPLE_RATE
      : DEFAULT_INPUT_PROCESSING_SAMPLE_RATE;

    const changed = audioStreamManager.setInputProcessingSampleRate(targetSampleRate, reason);
    this.spectrumScheduler?.setAudioSource?.(
      audioStreamManager.getAudioProvider(),
      audioStreamManager.getInternalSampleRate(),
    );

    if (changed) {
      logger.info('audio processing sample rate aligned to engine mode', {
        mode: this.currentMode.name,
        engineMode: this.engineMode,
        targetSampleRate,
        reason,
      });
    }
  }

  private async finalizeLifecyclePhase(): Promise<void> {
    logger.info('Initialization phase: lifecycle');

    await this.engineLifecycle.rebuildResourcePlan();
    this.engineLifecycle.initializeStateMachine();
  }

  // ─── 委托方法 ────────────────────────────────────

  async start(): Promise<void> {
    this.configureAudioProcessingForCurrentMode('engine-start');
    return this.engineLifecycle.start();
  }

  async stop(): Promise<void> {
    await this.stopTuneTone('engine stopped');
    return this.engineLifecycle.stop();
  }

  async destroy(): Promise<void> {
    logger.info('Destroying...');
    try {
      await this.stopTuneTone('engine destroyed');
      await this.audioSidecar.stop('engine-destroy');
    } catch (err) {
      logger.warn('audio sidecar stop during destroy failed', err);
    }
    await this.stop();
    this.squelchStatusMonitor.stop();
    this.releaseCwPttPolling?.();
    this.releaseCwPttPolling = null;
    this.physicalPttMonitor.stop();

    // rigctld bridge: tear down outside the engine resource pipeline so we
    // stop accepting external connections before the radio is torn down.
    await this.rigctldBridge.stop().catch((error) => {
      logger.warn('rigctld bridge stop failed during shutdown', { error: (error as Error).message });
    });

    // Stop NTP calibration
    this.ntpCalibrationService.stop();

    // 清理 RadioBridge 监听器
    this.radioBridge.teardownListeners();

    // 销毁解码/编码队列
    await this.realDecodeQueue.destroy();
    await this.realEncodeQueue.destroy();

    // 清理 SlotPackManager
    await this.slotPackManager.cleanup();

    // 清理音频混音器
    if (this.audioMixer) {
      this.audioMixer.clear();
      this.audioMixer.removeAllListeners();
      logger.info('Audio mixer cleaned up');
    }

    // 销毁频谱调度器
    if (this.spectrumScheduler) {
      await this.spectrumScheduler.destroy();
      logger.info('Spectrum scheduler destroyed');
    }

    if (this.slotClock) {
      this.slotClock.removeAllListeners();
      this.slotClock = null;
    }

    this.slotScheduler = null;
    this.removeAllListeners();

    // 清理语音会话管理器
    if (this.voiceSessionManager) {
      this.voiceSessionManager.destroy();
      this.voiceSessionManager = null;
      logger.info('Voice session manager destroyed');
    }

    // 清理 CW 键控器
    if (this.cwKeyerManager) {
      await this.cwKeyerManager.stop();
      this.cwKeyerManager.removeAllListeners();
      this.cwKeyerManager = null;
      logger.info('CW keyer manager destroyed');
    }
    if (this.cwDecoderManager) {
      this.cwDecoderManager.detachAudioStream();
      await this.cwDecoderManager.stop('engine-destroy');
      this.cwDecoderManager.removeAllListeners();
      this.cwDecoderManager = null;
      logger.info('CW decoder manager destroyed');
    }

    // 清理操作员管理器
    this.operatorManager.cleanup();

    // 清理传输跟踪器
    if (this.transmissionTracker) {
      this.transmissionTracker.cleanup();
      logger.info('Transmission tracker cleaned up');
    }

    // 停止状态机
    this.engineLifecycle.destroyStateMachine();

    // 取消注册内存泄漏检测
    MemoryLeakDetector.getInstance().unregister('DigitalRadioEngine');

    logger.info('Destroy complete');
  }

  setVolumeGain(gain: number): void {
    this.audioVolumeController.setVolumeGain(gain);
  }

  setVolumeGainDb(gainDb: number): void {
    this.audioVolumeController.setVolumeGainDb(gainDb);
  }

  getVolumeGain(): number {
    return this.audioVolumeController.getVolumeGain();
  }

  getVolumeGainDb(): number {
    return this.audioVolumeController.getVolumeGainDb();
  }

  public async forceStopTransmission(): Promise<void> {
    await this.stopTuneTone('force stop transmission');
    return this.transmissionPipeline.forceStopTransmission();
  }

  public async removeOperatorFromTransmission(operatorId: string): Promise<void> {
    return this.transmissionPipeline.removeOperatorFromTransmission(operatorId);
  }

  public async startTuneTone(payload: TuneToneStartPayload = {}): Promise<void> {
    await this.tuneToneController.start(payload);
  }

  public async stopTuneTone(reason = 'manual'): Promise<void> {
    await this.tuneToneController.stop(reason);
  }

  public getTuneToneStatus(): TuneToneStatus {
    return this.tuneToneController.getStatus();
  }

  public updateTransmitCompensation(compensationMs: number): void {
    if (this.slotClock) {
      this.slotClock.setCompensation(compensationMs);
      logger.info(`Transmit compensation updated to ${compensationMs}ms`);
    } else {
      logger.warn('SlotClock not initialized, cannot update compensation');
    }
  }

  async setMode(mode: ModeDescriptor | string): Promise<void> {
    const runSwitch = async () => {
      await this.stopTuneTone('mode changed');
      // Handle CW mode
      if (typeof mode === 'object' && mode.name === 'CW') {
        if (this.engineMode === 'cw') {
          logger.info('Already in CW mode');
          this.emitStatusSnapshot();
          return;
        }
        await this.switchEngineMode('cw', MODES.CW);
        return;
      }

      // Handle voice mode (string 'VOICE')
      if (mode === 'VOICE' || (typeof mode === 'object' && mode.name === 'VOICE')) {
        if (this.engineMode === 'voice') {
          logger.info('Already in voice mode');
          this.emitStatusSnapshot();
          return;
        }
        await this.switchEngineMode('voice', MODES.VOICE);
        return;
      }

      const digitalMode = mode as ModeDescriptor;

      // If switching from voice to digital
      if (this.engineMode === 'voice') {
        await this.switchEngineMode('digital', digitalMode);
        return;
      }

      // If switching from CW to digital
      if (this.engineMode === 'cw') {
        await this.switchEngineMode('digital', digitalMode);
        return;
      }

      // Normal digital mode switch (FT8 <-> FT4)
      if (this.currentMode.name === digitalMode.name) {
        logger.info(`Already in mode: ${digitalMode.name}`);
        this.syncCurrentModeToRuntimeComponents('already-in-mode');
        this.emitStatusSnapshot();
        return;
      }

      logger.info(`Switching mode: ${this.currentMode.name} -> ${digitalMode.name}`);
      await this.applyNearestPresetForDigitalMode(digitalMode);

      this.currentMode = digitalMode;
      this.applyDecodeWindowOverrides();
      this.syncCurrentModeToRuntimeComponents('digital-mode-switch');

      await ConfigManager.getInstance().setLastDigitalModeName(digitalMode.name);
      this.emitModeAndStatusSnapshot();
    };

    const queuedSwitch = this.modeSwitchTail.then(runSwitch, runSwitch);
    this.modeSwitchTail = queuedSwitch.catch(() => undefined);
    await queuedSwitch;
  }

  private async applyNearestPresetForDigitalMode(targetMode: ModeDescriptor): Promise<void> {
    const configManager = ConfigManager.getInstance();
    const currentFrequency = this.resolveCurrentDigitalFrequency(configManager);
    if (!currentFrequency) {
      logger.warn(`Skipping ${targetMode.name} preset frequency switch: current frequency is unknown`);
      return;
    }

    const nearestPreset = this.findNearestPresetForMode(targetMode.name, currentFrequency, configManager);
    if (!nearestPreset) {
      logger.warn(`Skipping ${targetMode.name} preset frequency switch: no presets found for target mode`);
      return;
    }

    await this.applyDigitalPresetFrequency(nearestPreset);
  }

  private resolveCurrentDigitalFrequency(configManager: ConfigManager): number | null {
    const knownFrequency = this.radioManager.getKnownFrequency();
    if (this.isValidFrequency(knownFrequency)) {
      return Math.round(knownFrequency);
    }

    const lastFrequency = configManager.getLastSelectedFrequency()?.frequency;
    if (this.isValidFrequency(lastFrequency)) {
      return Math.round(lastFrequency);
    }

    return null;
  }

  private findNearestPresetForMode(
    modeName: string,
    currentFrequency: number,
    configManager: ConfigManager,
  ): PresetFrequency | null {
    const frequencyManager = new FrequencyManager(configManager.getCustomFrequencyPresets());
    const presets = frequencyManager.getPresetsByMode(modeName)
      .filter((preset) => this.isValidFrequency(preset.frequency));

    let nearestPreset: PresetFrequency | null = null;
    let smallestDiff = Infinity;

    for (const preset of presets) {
      const diff = Math.abs(preset.frequency - currentFrequency);
      const isTieBreaker = diff === smallestDiff
        && nearestPreset !== null
        && preset.frequency < nearestPreset.frequency;

      if (diff < smallestDiff || isTieBreaker) {
        nearestPreset = preset;
        smallestDiff = diff;
      }
    }

    return nearestPreset;
  }

  private async applyDigitalPresetFrequency(preset: PresetFrequency): Promise<void> {
    const configManager = ConfigManager.getInstance();
    const description = preset.description
      || `${(preset.frequency / 1000000).toFixed(3)} MHz${preset.band ? ` ${preset.band}` : ''}`;
    const radioConnected = this.radioManager.isConnected();

    if (radioConnected) {
      const applyResult = await this.radioManager.applyOperatingState({
        frequency: preset.frequency,
        mode: preset.radioMode,
        bandwidth: preset.radioMode ? 'nochange' : undefined,
        options: preset.radioMode ? { intent: 'digital' } : undefined,
        tolerateModeFailure: true,
      });

      if (!applyResult.frequencyApplied) {
        throw new Error(`Failed to switch radio frequency to ${description}`);
      }

      if (applyResult.modeError) {
        logger.warn(`Switched digital frequency but failed to set radio mode: ${applyResult.modeError.message}`);
      }

      await this.applyRepeaterDuplexConfigWithWarning(
        { repeaterShift: 'none' },
        preset.frequency,
        false,
      );
      await this.applyToneSquelchConfigWithWarning(
        { toneMode: 'none' },
        preset.frequency,
        false,
      );
    } else {
      logger.debug(`Radio not connected, recording nearest digital preset: ${description}`);
    }

    await configManager.updateLastSelectedFrequency({
      frequency: preset.frequency,
      mode: preset.mode,
      radioMode: preset.radioMode,
      band: preset.band,
      description,
    });

    this.slotPackManager.clearInMemory();
    this.emit('frequencyChanged', {
      frequency: preset.frequency,
      mode: preset.mode,
      band: preset.band,
      radioMode: preset.radioMode,
      description,
      radioConnected,
      source: 'program',
    });
  }

  private async restoreLastDigitalOperatingState(configManager: ConfigManager, targetMode: ModeDescriptor): Promise<void> {
    const lastDigital = configManager.getLastSelectedFrequency();
    if (!lastDigital?.frequency) {
      return;
    }

    let targetFrequency: PresetFrequency = {
      frequency: lastDigital.frequency,
      mode: targetMode.name,
      radioMode: lastDigital.radioMode,
      band: lastDigital.band || this.resolveBandLabel(lastDigital.frequency),
      description: lastDigital.description,
    };

    if (lastDigital.mode && lastDigital.mode !== targetMode.name) {
      const nearestPreset = this.findNearestPresetForMode(targetMode.name, lastDigital.frequency, configManager);
      if (nearestPreset) {
        targetFrequency = nearestPreset;
      } else {
        logger.warn(`No ${targetMode.name} preset found while restoring digital mode; using saved digital frequency`);
      }
    } else if (lastDigital.mode === targetMode.name) {
      targetFrequency.mode = lastDigital.mode;
    }

    try {
      await this.applyDigitalPresetFrequency(targetFrequency);
      logger.info(`Restored digital operating state: ${(targetFrequency.frequency / 1000000).toFixed(3)} MHz (${targetFrequency.mode})`);
    } catch (error) {
      logger.warn(`Failed to restore digital operating state: ${(error as Error).message}`);
    }
  }

  private async applyRepeaterDuplexConfigWithWarning(
    config: RepeaterDuplexConfig,
    frequency: number,
    warnOnFailure: boolean,
  ): Promise<RepeaterDuplexApplyResult | null> {
    if (!this.radioManager.isConnected()) {
      return null;
    }

    const result = await this.radioManager.applyRepeaterDuplexConfig(config);
    if (warnOnFailure && result.warning) {
      this.emit('textMessage', {
        title: 'Repeater DUP not applied',
        text: result.message || 'Radio does not support repeater DUP control',
        color: 'warning',
        timeout: 5000,
        key: 'repeaterDuplexUnsupported',
        params: {
          frequency: (frequency / 1_000_000).toFixed(3),
          reason: result.message || '',
        },
      });
    }

    return result;
  }

  private async applyToneSquelchConfigWithWarning(
    config: ToneSquelchConfig,
    frequency: number,
    warnOnFailure: boolean,
  ): Promise<ToneSquelchApplyResult | null> {
    if (!this.radioManager.isConnected()) {
      return null;
    }

    const result = await this.radioManager.applyToneSquelchConfig(config);
    if (warnOnFailure && result.warning) {
      this.emit('textMessage', {
        title: 'Tone squelch not applied',
        text: result.message || 'Radio does not support tone squelch control',
        color: 'warning',
        timeout: 5000,
        key: 'toneSquelchUnsupported',
        params: {
          frequency: (frequency / 1_000_000).toFixed(3),
          reason: result.message || '',
        },
      });
    }

    return result;
  }

  private isValidFrequency(frequency: number | null | undefined): frequency is number {
    return typeof frequency === 'number' && Number.isFinite(frequency) && frequency > 0;
  }

  private async startCWDecoderRuntime(config: Partial<CWDecoderConfig>, reason: string): Promise<CWDecoderStatus> {
    const wasRunning = this.engineLifecycle?.getIsRunning() ?? false;
    if (this.engineMode !== 'cw') {
      await this.setMode(MODES.CW);
    }

    this.configureAudioProcessingForCurrentMode(reason);
    if (!this.engineLifecycle?.getIsRunning()) {
      this.cwDecoderStartedEngine = true;
      await this.engineLifecycle.startAndWaitForRunning();
    } else {
      this.cwDecoderStartedEngine = !wasRunning;
    }

    await this.getCWDecoderManager().start(this.toServerCWDecoderConfig({ ...config, enabled: true }));
    this.emitStatusSnapshot();
    return this.getCWDecoderStatus();
  }

  private async stopCWDecoderRuntime(reason: string, config: Partial<CWDecoderConfig> = ConfigManager.getInstance().getCWDecoderConfig()): Promise<void> {
    const manager = this.cwDecoderManager;
    if (!manager) {
      return;
    }

    await manager.updateConfig(this.toServerCWDecoderConfig({ ...config, enabled: false }));
    await manager.stop(reason);
  }

  private async switchEngineMode(targetEngineMode: EngineMode, targetMode: ModeDescriptor): Promise<void> {
    let engineState = this.engineLifecycle?.getEngineState() ?? EngineState.IDLE;
    let shouldResumeAfterSwitch = engineState === EngineState.RUNNING || engineState === EngineState.STARTING;
    // CW keying can lazy-init its own manager, but RX monitor/decoder still
    // need the engine audio chain. Preserve the user's running/idle intent.
    const comingFromCW = this.engineMode === 'cw';
    const goingToCW = targetEngineMode === 'cw';
    logger.info(`Switching engine mode: ${this.engineMode}/${this.currentMode.name} -> ${targetEngineMode}/${targetMode.name}`);

    if (this.engineMode === 'voice' && targetEngineMode !== 'voice') {
      await this.voiceKeyerManager?.stopActive('leaving voice mode');
    }

    if (comingFromCW) {
      await this.cwKeyerManager?.stopActive('leaving cw mode');
      if (targetEngineMode !== 'cw') {
        await this.stopCWDecoderRuntime('leaving-cw-mode');
        this.cwDecoderStartedEngine = false;
      }
    }

    if (engineState === EngineState.STARTING) {
      logger.info('Mode switch requested while engine is starting, waiting for startup to settle first');
      engineState = await this.engineLifecycle.waitForStartupToSettle();
      shouldResumeAfterSwitch = engineState === EngineState.RUNNING;
      logger.info(`Startup settled before mode switch: ${engineState}`);
    }

    if (engineState === EngineState.STOPPING) {
      logger.info('Mode switch requested while engine is stopping, waiting for stop completion');
      await this.engineLifecycle.stop();
      engineState = this.engineLifecycle.getEngineState();
      shouldResumeAfterSwitch = false;
    }

    if (engineState === EngineState.RUNNING) {
      this.radioBridge.wasRunningBeforeDisconnect = false;
      if (goingToCW && this.engineLifecycle) {
        // Digital→CW: stop engine but keep radio connected (CW has its own serial port).
        this.engineLifecycle.preserveRadioConnection = true;
      }
      try {
        await this.stop();
      } finally {
        if (this.engineLifecycle) {
          this.engineLifecycle.preserveRadioConnection = false;
        }
      }
    }

    this.engineMode = targetEngineMode;
    this.currentMode = targetMode;
    this.configureAudioProcessingForCurrentMode?.('mode-switch');

    if (targetEngineMode === 'digital') {
      this.applyDecodeWindowOverrides();
    }

    this.syncCurrentModeToRuntimeComponents('engine-mode-switch');
    await this.engineLifecycle.rebuildResourcePlan();

    const configManager = ConfigManager.getInstance();
    await configManager.setLastEngineMode(targetEngineMode);
    if (targetEngineMode === 'digital') {
      await configManager.setLastDigitalModeName(targetMode.name);
    }

    if (targetEngineMode === 'voice') {
      await this.restoreLastVoiceOperatingState(configManager);
    } else if (goingToCW) {
      await this.restoreLastCWOperatingState(configManager);
    } else if (targetEngineMode === 'digital') {
      await this.restoreLastDigitalOperatingState(configManager, targetMode);
    }
    this.emitModeAndStatusSnapshot();

    // Refresh split capability after mode switch (some radios support split only in certain modes)
    void this.radioManager?.refreshSplitCapability?.();

    this.resetVoicePttState();
    this.squelchStatusMonitor.reevaluate();
    this.physicalPttMonitor.reevaluate();

    // Keep the engine running across mode switches only if it was running before.
    if (shouldResumeAfterSwitch) {
      await this.engineLifecycle.startAndWaitForRunning();
      this.emitStatusSnapshot();
    }

    logger.info(`Engine mode switched to ${targetEngineMode}/${targetMode.name}`);
  }

  private async restoreLastVoiceOperatingState(configManager: ConfigManager): Promise<void> {
    const lastVoice = configManager.getLastVoiceFrequency();
    if (!lastVoice?.frequency || !this.radioManager.isConnected()) {
      return;
    }

    try {
      const applyResult = await this.radioManager.applyOperatingState({
        frequency: lastVoice.frequency,
        mode: lastVoice.radioMode,
        bandwidth: lastVoice.radioMode ? 'nochange' : undefined,
        options: lastVoice.radioMode ? { intent: 'voice' } : undefined,
        tolerateModeFailure: true,
      });

      if (!applyResult.frequencyApplied) {
        logger.warn(`Failed to restore last voice frequency: ${(lastVoice.frequency / 1000000).toFixed(3)} MHz`);
        return;
      }

      if (applyResult.modeError) {
        logger.warn(`Restored last voice frequency but failed to set radio mode: ${applyResult.modeError.message}`);
      }

      const supportsFmOptions = lastVoice.radioMode?.toUpperCase() === 'FM';
      await this.applyRepeaterDuplexConfigWithWarning({
        repeaterShift: supportsFmOptions ? (lastVoice.repeaterShift ?? 'none') : 'none',
        repeaterOffsetHz: supportsFmOptions ? lastVoice.repeaterOffsetHz : undefined,
      }, lastVoice.frequency, supportsFmOptions && (lastVoice.repeaterShift === 'minus' || lastVoice.repeaterShift === 'plus'));
      await this.applyToneSquelchConfigWithWarning({
        toneMode: supportsFmOptions ? (lastVoice.toneMode ?? 'none') : 'none',
        ctcssToneTenthsHz: supportsFmOptions ? lastVoice.ctcssToneTenthsHz : undefined,
        dcsCode: supportsFmOptions ? lastVoice.dcsCode : undefined,
      }, lastVoice.frequency, supportsFmOptions && (lastVoice.toneMode === 'ctcss' || lastVoice.toneMode === 'dcs'));

      const band = lastVoice.band || this.resolveBandLabel(lastVoice.frequency);
      const description = lastVoice.description || `${(lastVoice.frequency / 1000000).toFixed(3)} MHz${band !== 'Unknown' ? ` ${band}` : ''}`;
      this.emit('frequencyChanged', {
        frequency: lastVoice.frequency,
        mode: 'VOICE',
        band,
        description,
        radioMode: lastVoice.radioMode,
        radioConnected: true,
        source: 'program',
      });
      logger.info(`Restored last voice operating state: ${description}${lastVoice.radioMode ? ` (${lastVoice.radioMode})` : ''}`);
    } catch (error) {
      logger.warn(`Failed to restore last voice operating state: ${(error as Error).message}`);
    }
  }

  private async restoreLastCWOperatingState(configManager: ConfigManager): Promise<void> {
    if (!this.radioManager.isConnected()) {
      return;
    }

    const lastCW = configManager.getLastCWFrequency();
    let targetFrequency: number;
    let targetRadioMode: string | undefined;

    if (lastCW?.frequency) {
      targetFrequency = lastCW.frequency;
      targetRadioMode = lastCW.radioMode || 'CW';
    } else {
      // First time switching to CW: use current radio frequency and force CW mode
      const currentFreq = await this.radioManager.getFrequency();
      if (!currentFreq || currentFreq <= 0) {
        logger.warn('Cannot restore CW operating state: no saved frequency and failed to read current frequency');
        return;
      }
      targetFrequency = currentFreq;
      targetRadioMode = 'CW';
      logger.info(`No saved CW frequency, switching radio to CW mode on current frequency: ${(currentFreq / 1000000).toFixed(3)} MHz`);
    }

    try {
      const applyResult = await this.radioManager.applyOperatingState({
        frequency: targetFrequency,
        mode: targetRadioMode,
        bandwidth: targetRadioMode ? 'nochange' : undefined,
        options: targetRadioMode ? { intent: 'cw' } : undefined,
        tolerateModeFailure: true,
      });

      if (!applyResult.frequencyApplied) {
        logger.warn(`Failed to restore CW frequency: ${(targetFrequency / 1000000).toFixed(3)} MHz`);
        return;
      }

      if (applyResult.modeError) {
        logger.warn(`Restored CW frequency but failed to set radio mode: ${applyResult.modeError.message}`);
      }

      const band = this.resolveBandLabel(targetFrequency);
      const description = `${(targetFrequency / 1000000).toFixed(3)} MHz${band !== 'Unknown' ? ` ${band}` : ''}`;
      this.emit('frequencyChanged', {
        frequency: targetFrequency,
        mode: 'CW',
        band,
        description,
        radioMode: targetRadioMode,
        radioConnected: true,
        source: 'program',
      });
      logger.info(`Restored CW operating state: ${description}${targetRadioMode ? ` (${targetRadioMode})` : ''}`);
    } catch (error) {
      logger.warn(`Failed to restore CW operating state: ${(error as Error).message}`);
    }
  }

  private resolveBandLabel(frequency: number): string {
    try {
      return getBandFromFrequency(frequency);
    } catch {
      return 'Unknown';
    }
  }

  private resolveTuneToneFrequency(operatorId?: string | null): number | null {
    const operators = operatorId
      ? [this._operatorManager.getOperatorById(operatorId)]
      : this._operatorManager.getAllOperators();
    const operator = operators.find((candidate) => Boolean(candidate));
    const frequency = operator?.config.frequency;
    return typeof frequency === 'number' && Number.isFinite(frequency) && frequency > 0
      ? frequency
      : null;
  }

  private isTransmitBusyForTuneTone(): boolean {
    return this.transmissionPipeline.getIsPTTActive()
      || this.unifiedVoicePttActive
      || this.physicalPttActive;
  }

  private setTuneTonePttActive(active: boolean): void {
    this.radioManager.setPTTActive(active);
    this.spectrumScheduler.setPTTActive(active);
    this.squelchStatusMonitor.setPTTActive(active);
    this.physicalPttMonitor.setSoftwarePttActive(active || this.voiceManualPttActive || this.voiceKeyerPttActive);
    this.emit('pttStatusChanged', {
      isTransmitting: active,
      operatorIds: [],
    });
  }

  private handleVoiceSoftwarePttChanged(data: { isTransmitting: boolean; operatorIds: string[]; source?: 'manual' | 'voice-keyer' }): void {
    if (data.source === 'voice-keyer') {
      this.voiceKeyerPttActive = data.isTransmitting;
    } else {
      this.voiceManualPttActive = data.isTransmitting;
    }

    this.physicalPttMonitor.setSoftwarePttActive(this.voiceManualPttActive || this.voiceKeyerPttActive);
    this.applyUnifiedVoicePttState(data.operatorIds ?? []);
  }

  private handlePhysicalPttChanged(active: boolean): void {
    this.physicalPttActive = active;
    this.voiceKeyerManager?.setManualPttActive(this.voiceManualPttActive || this.physicalPttActive);
    this.applyUnifiedVoicePttState([]);
  }

  private handleCWKeyerStatusChanged(status: CWKeyerStatus): void {
    const shouldPollPhysicalPtt = status.active && (status.mode === 'playing' || status.mode === 'keying');
    if (this.cwDecoderManager || ConfigManager.getInstance().getCWDecoderConfig().enabled) {
      this.getCWDecoderManager().setTransmitMuted?.(shouldPollPhysicalPtt);
    }
    if (shouldPollPhysicalPtt && !this.releaseCwPttPolling) {
      this.releaseCwPttPolling = this.physicalPttMonitor.requestPolling('cw-keyer');
      return;
    }

    if (!shouldPollPhysicalPtt && this.releaseCwPttPolling) {
      this.releaseCwPttPolling();
      this.releaseCwPttPolling = null;
    }
  }

  private toServerCWDecoderConfig(config: Partial<CWDecoderConfig>): ServerCWDecoderConfig {
    const merged = {
      ...DEFAULT_CW_DECODER_CONFIG,
      ...config,
      backend: 'deepcw-onnx' as const,
      inputSampleRate: this.audioStreamManager?.getInternalSampleRate?.() ?? DEFAULT_CW_DECODER_CONFIG.decodeSampleRate,
      decodeSampleRate: DEFAULT_CW_DECODER_CONFIG.decodeSampleRate,
    };
    return {
      ...merged,
      modelPath: this.resolveDeepCWModelPath(merged),
    };
  }

  private getEffectiveCWDecoderStatusConfig(): Partial<CWDecoderConfig> {
    const runtimeConfig = this.cwDecoderManager?.getConfig();
    if (!runtimeConfig) {
      return ConfigManager.getInstance().getCWDecoderConfig();
    }
    const { modelPath: _modelPath, ...contractConfig } = runtimeConfig;
    return contractConfig as unknown as Partial<CWDecoderConfig>;
  }

  private toContractCWDecoderStatus(status: ServerCWDecoderStatus, config: Partial<CWDecoderConfig> = ConfigManager.getInstance().getCWDecoderConfig()): CWDecoderStatus {
    const configuredEnabled = typeof config.enabled === 'boolean' ? config.enabled : status.enabled;
    const enabled = configuredEnabled || status.state === 'running' || status.state === 'starting';
    const contractConfig = {
      ...ConfigManager.getInstance().getCWDecoderConfig(),
      ...config,
      enabled,
    } as CWDecoderConfig;
    const state = status.muted
      ? 'muted'
      : status.state === 'running'
      ? 'listening'
      : status.state === 'stopped'
        ? (enabled ? 'starting' : 'disabled')
        : status.state === 'stopping'
          ? 'starting'
        : status.state === 'unavailable'
          ? 'error'
          : status.state;
    return {
      enabled,
      state,
      config: contractConfig,
      active: status.state === 'running' && !status.muted,
      muted: status.muted,
      backend: makeDeepCWBackendDescriptor({
        available: status.backendAvailable,
        error: status.backendError,
        runtimeBackend: contractConfig.runtimeBackend,
      }),
      lastDecodeAt: status.lastDecodeAt ?? undefined,
      lastError: enabled ? status.backendError : null,
      updatedAt: Date.now(),
      running: status.state === 'running',
      backendId: status.backend,
      pendingText: status.lastPendingText,
      committedText: status.lastCommittedText,
      queuedSamples: status.queuedSamples,
    };
  }

  private resolveDeepCWModelPath(config: Pick<ServerCWDecoderConfig, 'language' | 'modelSize'>): string | null {
    return resolveDeepCWModelPath(config);
  }

  private resetVoicePttState(): void {
    this.voiceManualPttActive = false;
    this.voiceKeyerPttActive = false;
    this.physicalPttActive = false;
    this.voiceKeyerManager?.setManualPttActive(false);
    this.physicalPttMonitor.setSoftwarePttActive(false);
    this.applyUnifiedVoicePttState([]);
  }

  private applyUnifiedVoicePttState(operatorIds: string[]): void {
    const manualPttActive = this.voiceManualPttActive || this.physicalPttActive;
    this.voiceKeyerManager?.setManualPttActive(manualPttActive);

    const unifiedActive = manualPttActive || this.voiceKeyerPttActive;
    const changed = unifiedActive !== this.unifiedVoicePttActive;
    this.unifiedVoicePttActive = unifiedActive;

    this.radioManager.setPTTActive(unifiedActive);
    this.spectrumScheduler.setPTTActive(unifiedActive);
    this.squelchStatusMonitor.setPTTActive(unifiedActive);

    if (changed) {
      this.emit('pttStatusChanged', {
        isTransmitting: unifiedActive,
        operatorIds: unifiedActive ? operatorIds : [],
      });
    }
  }

  private emitModeAndStatusSnapshot(): void {
    this.emit('modeChanged', this.currentMode);
    this.emitStatusSnapshot();
  }

  private emitStatusSnapshot(): void {
    this.emit('systemStatus', this.getStatus());
  }

  private syncCurrentModeToRuntimeComponents(reason: string): void {
    if (this.slotClock) {
      this.slotClock.setMode(this.currentMode);
    }

    this.slotPackManager.setMode(this.currentMode);
    this.clockCoordinator?.onModeChanged(this.currentMode);

    for (const op of this._operatorManager?.getAllOperators() ?? []) {
      op.setMode(this.currentMode);
    }

    logger.debug('Current mode synchronized to runtime components', {
      mode: this.currentMode.name,
      reason,
    });
  }

  /**
   * Apply decode window settings from config to currentMode
   */
  private applyDecodeWindowOverrides(): void {
    const settings = ConfigManager.getInstance().getDecodeWindowSettings();
    const resolved = resolveWindowTiming(this.currentMode.name, settings);
    if (resolved) {
      this.currentMode = { ...this.currentMode, windowTiming: resolved };
      logger.info(`Decode window overrides applied for ${this.currentMode.name}: [${resolved.join(', ')}]`);
    }
  }

  /**
   * Update decode windows at runtime (called after settings change)
   */
  public updateDecodeWindows(): void {
    this.applyDecodeWindowOverrides();
    this.syncCurrentModeToRuntimeComponents('decode-window-update');
    this.emit('modeChanged', this.currentMode);
    logger.info(`Decode windows updated: ${this.currentMode.windowTiming.length} windows`);
  }

  // ─── 查询方法 ────────────────────────────────────

  getActiveSlotPacks(): SlotPack[] {
    return this.slotPackManager.getActiveSlotPacks();
  }

  getSlotPack(slotId: string): SlotPack | null {
    return this.slotPackManager.getSlotPack(slotId);
  }

  getAvailableModes(): ModeDescriptor[] {
    return Object.values(MODES);
  }

  public getSquelchStatus(): SquelchStatus {
    return this.squelchStatusMonitor.getSnapshot();
  }

  public getCurrentSlotInfo(): SlotInfo | null {
    return this.slotClock?.getCurrentSlotInfo() ?? null;
  }

  public getStatus() {
    const isRunning = this.engineLifecycle?.getIsRunning() ?? false;
    // Voice and CW modes have no decode slot loop, so mirror engine running state.
    const isActuallyDecoding = this.engineMode === 'voice' || this.engineMode === 'cw'
      ? isRunning
      : isRunning && (this.slotClock?.isRunning ?? false);

    const engineState = this.engineLifecycle?.getEngineState() ?? 'idle';
    const engineContext = this.engineLifecycle?.getEngineContext() ?? null;

    return {
      isRunning,
      isDecoding: isActuallyDecoding,
      currentMode: this.currentMode,
      engineMode: this.engineMode,
      currentRadioMode: this.getCurrentRadioMode() ?? undefined,
      currentTime: this.clockSource.now(),
      nextSlotIn: this.slotClock?.getNextSlotIn() ?? 0,
      audioStarted: this.engineLifecycle?.getIsAudioStarted() ?? false,
      volumeGain: this.audioStreamManager.getVolumeGain(),
      volumeGainDb: this.audioStreamManager.getVolumeGainDb(),
      isPTTActive: this.transmissionPipeline?.getIsPTTActive() ?? false,
      radioConnected: this.radioManager.isConnected(),
      radioConnectionHealth: this.radioManager.getConnectionHealth(),
      engineState,
      engineContext,
    };
  }
}
