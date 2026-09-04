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
  type SlotPackFrequencyContext,
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
  type SpectrumPreset,
  type SpectrumCustomSettings,
  resolveWindowTiming,
} from '@tx5dr/contracts';
import { EventEmitter } from 'eventemitter3';
import {
  AudioStreamManager,
  CW_INPUT_PROCESSING_SAMPLE_RATE,
  DEFAULT_INPUT_PROCESSING_SAMPLE_RATE,
  type AudioPlaybackReadiness,
  type PlaybackKind,
  type PlayAudioOptions,
  type StopPlaybackOptions,
} from './audio/AudioStreamManager.js';
import { WSJTXDecodeWorkQueue } from './decode/WSJTXDecodeWorkQueue.js';
import type { DecodeWorkerPoolHealthSnapshot } from './decode/WSJTXDecodeProcessPool.js';
import { WSJTXEncodeWorkQueue } from './decode/WSJTXEncodeWorkQueue.js';
import { DigitalMessagePreflightService } from './decode/DigitalMessagePreflightService.js';
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
import {
  buildFrequencyOperatingStateRequest,
  resolveFrequencyRadioMode,
} from './radio/frequencyRadioMode.js';
import { TransmissionTracker } from './transmission/TransmissionTracker.js';
import { DigitalFrameCoordinator } from './transmission/DigitalFrameCoordinator.js';
import { PhysicalTxCoordinator } from './transmission/PhysicalTxCoordinator.js';
import { OperatorIntentCoordinator } from './transmission/OperatorIntentCoordinator.js';
import type { PhysicalTxSnapshot } from './transmission/TransmissionIntent.js';
import type { OpenWebRXAudioAdapter } from './openwebrx/OpenWebRXAudioAdapter.js';
import { MemoryLeakDetector } from './utils/MemoryLeakDetector.js';
import { ResourceManager } from './utils/ResourceManager.js';
import { initializePSKReporterService } from './services/PSKReporterService.js';
import { createLogger } from './utils/logger.js';
import { bootstrapCoordinator } from './services/BootstrapCoordinator.js';
import { formatFrequencyMHz } from './utils/frequencyMHz.js';

const logger = createLogger('DigitalRadioEngine');

const isFakeFrequencySupportedMode = (engineMode: EngineMode, mode: ModeDescriptor): boolean => (
  engineMode === 'digital' && (mode.name === 'FT8' || mode.name === 'FT4')
);

type DecodeWorkerEngineEmitter = EventEmitter<{
  decodeWorkerUnavailable: (status: DecodeWorkerPoolHealthSnapshot) => void;
  decodeWorkerRecovered: (status: DecodeWorkerPoolHealthSnapshot) => void;
}>;

type OperatingStateSyncStatus = 'applied' | 'skipped-offline' | 'partially-applied' | 'failed';

interface OperatingStateSyncResult {
  status: OperatingStateSyncStatus;
  detail?: string;
}

interface PhysicalTxAudioBackend {
  playAudio(audioData: Float32Array, sampleRate: number, options?: PlayAudioOptions): Promise<void>;
  stopCurrentPlayback(options?: StopPlaybackOptions): Promise<number>;
  prepareAudioPlayback(kind: PlaybackKind): Promise<AudioPlaybackReadiness>;
  getAudioPlaybackReadiness(kind: PlaybackKind): AudioPlaybackReadiness;
  isPlaying(kind?: PlaybackKind): boolean;
}

// 子系统
import { AudioVolumeController } from './subsystems/AudioVolumeController.js';
import { AudioSidecarController } from './subsystems/AudioSidecarController.js';
import { RadioBridge } from './subsystems/RadioBridge.js';
import { TransmissionPipeline } from './subsystems/TransmissionPipeline.js';
import { ClockCoordinator } from './subsystems/ClockCoordinator.js';
import { EngineLifecycle } from './subsystems/EngineLifecycle.js';
import { VoiceSessionManager } from './voice/VoiceSessionManager.js';
import { VoiceKeyerManager } from './voice/VoiceKeyerManager.js';
import { AndroidOperatorAudioService } from './voice/AndroidOperatorAudioService.js';
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
import { buildRadioStatusPayload } from './radio/buildRadioStatusPayload.js';
import type { RealtimeRxAudioRouter } from './realtime/RealtimeRxAudioRouter.js';
import type { PluginRadioCommand, PluginRadioTunerCommand } from '@tx5dr/plugin-api';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ImageArtifactStore, ImageComposerBackgroundStore, ImageHistoryStore, ImagePaperSpool, ImageRadioService, ImageTemplateStore, SstvTxPreferenceStore } from './image-radio/index.js';
import { RadioConnectionFactory } from './radio/connections/RadioConnectionFactory.js';
import { VirtualRadioConnection } from './virtual-radio/VirtualRadioConnection.js';
import { VirtualRadioSession } from './virtual-radio/VirtualRadioSession.js';
import { validateVirtualRadioSafety } from './virtual-radio/virtualRadioSafety.js';
import { VIRTUAL_AUDIO_INGRESS_TOKEN } from './virtual-radio/virtualAudioIngress.js';

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

  // deepcw-engine publishes one AGPL-3.0-only model plus its metadata.
  // Keep the legacy modelSize/language fields for wire compatibility, but
  // resolve only the pinned model artifact.
  const fileName = 'model.onnx';
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
    modelSizes: ['tiny'],
    languages: ['en'],
    modes: ['streaming'],
    model: 'deepcw-engine model.onnx',
    runtime: options.runtimeBackend ?? 'cpu',
    attributionName: 'DeepCW / deepcw-engine',
    sourceUrl: 'https://github.com/e04/deepcw-engine',
    license: 'AGPL-3.0-only',
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
  private physicalTxAudioBackend: PhysicalTxAudioBackend;
  private realDecodeQueue: WSJTXDecodeWorkQueue;
  private realEncodeQueue: WSJTXEncodeWorkQueue;
  private slotPackManager: SlotPackManager;
  private spectrumScheduler: SpectrumScheduler;
  private audioMixer: AudioMixer;
  private radioManager: PhysicalRadioManager;
  private frequencyManager: FrequencyManager;
  private _operatorManager: RadioOperatorManager;
  private transmissionTracker: TransmissionTracker;
  private digitalFrameCoordinator: DigitalFrameCoordinator;
  private physicalTxCoordinator: PhysicalTxCoordinator;
  private operatorIntentCoordinator: OperatorIntentCoordinator;
  private resourceManager: ResourceManager;
  private imageRadioService: ImageRadioService | null = null;
  private imageArtifactStore: ImageArtifactStore | null = null;
  private imageComposerBackgroundStore: ImageComposerBackgroundStore | null = null;
  private imageHistoryStore: ImageHistoryStore | null = null;
  private imageTemplateStore: ImageTemplateStore | null = null;
  private sstvTxPreferenceStore: SstvTxPreferenceStore | null = null;

  // 语音模式
  private engineMode: EngineMode = 'digital';
  private voiceSessionManager: VoiceSessionManager | null = null;
  private voiceKeyerManager: VoiceKeyerManager | null = null;
  private androidOperatorAudioService: AndroidOperatorAudioService | null = null;

  // CW 模式
  private cwKeyerManager: CWKeyerManager | null = null;
  private cwDecoderManager: CWDecoderManager | null = null;
  private cwDecoderStartedEngine = false;
  private modeSwitchTail: Promise<void> = Promise.resolve();
  private operatingStateWarningActive = false;

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
  private virtualRadioSession: VirtualRadioSession | null = null;
  private virtualRadioSessionStopPromise: Promise<void> | null = null;
  private dataDir = '';
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
    WINDOW_FUNCTION: 'blackmanHarris' as const,
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
    this.physicalTxAudioBackend = this.audioStreamManager;
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
    this.radioManager = new PhysicalRadioManager({
      connectionFactory: (config) => {
        const virtual = ConfigManager.getInstance().getActiveVirtualRadioProfile();
        return virtual
          ? new VirtualRadioConnection(virtual.radio.virtual.dialFrequencyHz)
          : RadioConnectionFactory.create(config);
      },
    });
    this.digitalFrameCoordinator = new DigitalFrameCoordinator({ now: () => this.clockSource.now() });
    this.operatorIntentCoordinator = new OperatorIntentCoordinator();
    this.physicalTxCoordinator = new PhysicalTxCoordinator({
      isRadioConnected: () => this.radioManager.isConnected(),
      setPTT: (active) => this.radioManager.setPTT(active),
      playAudio: (audioData, sampleRate, options) => (
        this.physicalTxAudioBackend.playAudio(audioData, sampleRate, options)
      ),
      stopCurrentPlayback: (options) => this.physicalTxAudioBackend.stopCurrentPlayback(options),
      prepareAudioPlayback: (kind) => this.physicalTxAudioBackend.prepareAudioPlayback(kind),
      getAudioPlaybackReadiness: (kind) => this.physicalTxAudioBackend.getAudioPlaybackReadiness(kind),
      isAudioPlaying: (kind) => this.physicalTxAudioBackend.isPlaying(kind),
      setTxDialOffset: (shiftHz) => this.radioManager.setTxDialOffset(shiftHz),
      clearTxDialOffset: () => this.radioManager.clearTxDialOffset(),
      now: () => this.clockSource.now(),
    });
    this.physicalTxCoordinator.on('phaseChanged', (snapshot) => {
      this.handleCoordinatedPhysicalTxChanged(snapshot);
    });
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
      // 虚拟频差：仅 FT8/FT4 生效，并与 rig split 互斥（split 开启时本功能让步，避免双重 dial 操作）
      // 多op同时发射时禁用，避免所有op在同一频率发射重叠
      getFakeFrequencyEnabled: () => {
        try {
          if (!isFakeFrequencySupportedMode(this.engineMode, this.currentMode)) {
            return false;
          }
          const enabled = !!this.radioManager?.getConfig()?.fakeFrequency?.enabled;
          if (!enabled || this.radioManager?.isSplitEnabled?.()) {
            return false;
          }
          // 多op发射时禁用虚拟频差
          const transmittingCount = this._operatorManager.getTransmittingOperatorCount();
          if (transmittingCount > 1) {
            return false;
          }
          return true;
        } catch {
          return false;
        }
      },
      transmissionTracker: this.transmissionTracker,
      callsignTracker: this._callsignTracker,
      digitalFrameCoordinator: this.digitalFrameCoordinator,
      getTransmitCompensationMs: () => this.slotClock?.getCompensation() ?? 0,
      intentCoordinator: this.operatorIntentCoordinator,
    });

    // 初始化插件管理器（在操作员管理器之后）
    // dataDir 异步获取，先用占位符，initialize() 中完成
    const digitalMessagePreflight = new DigitalMessagePreflightService();
    this._pluginManager = new PluginManager({
      eventEmitter: this,
      getOperators: () => this._operatorManager.getAllOperators(),
      getOperatorById: (id) => this._operatorManager.getOperatorById(id),
      notifyOperatorStatusChanged: (id) => this._operatorManager.emitOperatorStatusUpdate(id),
      getCurrentMode: () => this.currentMode,
      preflightDigitalMessage: (request) => digitalMessagePreflight.check(request),
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
      runWhenPhysicalTxIdle: (operation) => this.physicalTxCoordinator.runWhenIdle(
        'plugin logbook status update',
        operation,
      ),
      setRadioFrequency: async (freq) => {
        try {
          return await this.radioManager.setFrequency(freq);
        } catch (e) {
          logger.error('Failed to set radio frequency', e);
          return false;
        }
      },
      submitRadioMaintenanceCommand: (command) => this.submitPluginRadioMaintenanceCommand(command),
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
      setOperatorAudioFrequency: async (operatorId, frequency, commandToken) => {
        await this._operatorManager.updateOperatorContext(operatorId, { frequency }, {
          commandEpoch: commandToken?.epoch,
          source: commandToken?.source === 'assisted-queue' ? 'slot-auto' : commandToken?.source,
          reason: 'auto-call execution plan changed audio frequency',
        });
      },
      interruptOperatorTransmission: async (operatorId) => {
        this._operatorManager.getOperatorById(operatorId)?.stop();
        await this.physicalTxCoordinator.forceInterrupt(`manual plugin halt: ${operatorId}`);
      },
      requestOperatorStrategyStop: (operatorId, reason) => {
        this._operatorManager.requestStrategyStop(operatorId, reason);
      },
      prepareOperatorStrategyStart: (operatorId) => {
        return this._operatorManager.prepareOperatorStrategyStart(operatorId);
      },
      cancelPreparedOperatorStrategyStart: (operatorId, reason) => {
        this._operatorManager.cancelPreparedOperatorStrategyStart(operatorId, reason);
      },
      transitionTargetReservation: (operatorId, epoch, targetCallsign) => (
        this._operatorManager.transitionTargetReservation(operatorId, epoch, targetCallsign)
      ),
      transitionTargetReservations: (operatorId, epoch, targets) => (
        this._operatorManager.transitionTargetReservations(operatorId, epoch, targets)
      ),
      releaseTargetReservation: (operatorId, epoch) => {
        this._operatorManager.releaseTargetReservation(operatorId, epoch);
      },
      removeOperatorContribution: (operatorId, options) => this.transmissionPipeline.removeOperatorFromTransmission(
        operatorId,
        {
          commandAlreadyAllocated: true,
          signal: options.signal,
          commandToken: options.commandToken,
        },
      ),
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
      triggerReEncode: (operatorId, options) => {
        this._operatorManager.triggerPostDecisionReEncode(operatorId, options);
      },
      intentCoordinator: this.operatorIntentCoordinator,
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
    const spectrumSettings = ConfigManager.getInstance().getSpectrumSettings();
    this.spectrumScheduler.applyPreset(spectrumSettings.preset, 0, spectrumSettings.customSettings);
    // IF-mode audio waterfall uses Blackman-Harris + baseline flatten (decode path unchanged).
    this.audioStreamManager.on('inputSignalTypeChanged', (inputSignalType) => {
      this.spectrumScheduler.setInputSignalType(inputSignalType);
    });
    this.spectrumScheduler.setInputSignalType(this.audioStreamManager.getInputSignalType());

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
      onOutputIssue: (error) => this.physicalTxCoordinator.handleAudioOutputIssue(error),
    });

    this.transmissionPipeline = new TransmissionPipeline({
      engineEmitter: this,
      audioMixer: this.audioMixer,
      audioStreamManager: this.audioStreamManager,
      spectrumScheduler: this.spectrumScheduler,
      transmissionTracker: this.transmissionTracker,
      encodeQueue: this.realEncodeQueue,
      operatorManager: this._operatorManager,
      digitalFrameCoordinator: this.digitalFrameCoordinator,
      physicalTxCoordinator: this.physicalTxCoordinator,
      intentCoordinator: this.operatorIntentCoordinator,
      clockSource: this.clockSource,
      getCurrentMode: () => this.currentMode,
      getCompensationMs: () => this.slotClock?.getCompensation() ?? 0,
      onBeforeStartPTT: () => this.stopTuneTone('another transmission started'),
      validateDigitalFrameStart: (operatorIds, tracks) => {
        this._operatorManager.assertStandardFrequencyStreamLimit(
          tracks ?? operatorIds.map((operatorId) => ({ operatorId, streamId: 'default' })),
        );
      },
    });

    this.radioBridge = new RadioBridge({
      engineEmitter: this,
      radioManager: this.radioManager,
      frequencyManager: this.frequencyManager,
      slotPackManager: this.slotPackManager,
      operatorManager: this._operatorManager,
      physicalTxCoordinator: this.physicalTxCoordinator,
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
      isSoftwarePttActive: () => this.physicalTxCoordinator.getSnapshot().phase !== 'idle'
        || this.voiceManualPttActive
        || this.voiceKeyerPttActive,
      emitStatus: (active) => this.handlePhysicalPttChanged(active),
    });
    this.tuneToneController = new TuneToneController({
      radioManager: this.radioManager,
      physicalTxCoordinator: this.physicalTxCoordinator,
      isTransmitBusy: () => this.isTransmitBusyForTuneTone(),
      getOperatorToneHz: (operatorId) => this.resolveTuneToneFrequency(operatorId),
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

    this.rigctldBridge = new RigctldBridge(this.radioManager, this.physicalTxCoordinator);
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

  /**
   * 虚拟频差开关：热更新 + 持久化到激活 Profile + 广播状态。
   * 无需重启引擎——仅 FT8/FT4 发射会读取该配置并应用编码/平移行为。
   */
  public async setFakeFrequencyEnabled(enabled: boolean): Promise<void> {
    // 1. 热更新 radioManager 当前配置（编码时读取）
    this.radioManager?.setFakeFrequencyEnabled(enabled);

    // 2. 持久化到当前激活 Profile（合并 radio 配置，避免覆盖其他字段）
    try {
      const cfg = ConfigManager.getInstance();
      const active = cfg.getActiveProfile();
      if (active) {
        await cfg.updateProfile(active.id, {
          radio: { ...active.radio, fakeFrequency: { enabled } },
        });
      }
    } catch (error) {
      logger.error('Failed to persist fake frequency setting', error);
    }

    // 3. 广播最新电台状态，前端据 radioConfig.fakeFrequency 同步开关
    try {
      const radioManager = this.radioManager;
      const radioInfo = await radioManager.getRadioInfo();
      const payload = buildRadioStatusPayload({
        connected: radioManager.isConnected(),
        status: radioManager.getConnectionStatus(),
        radioInfo,
        radioConfig: radioManager.getConfig(),
        reason: 'Fake frequency setting updated',
        radioManager,
      });
      // 添加虚拟频差实际生效状态
      (payload as any).fakeFrequencyEffective = this._operatorManager.isFakeFrequencyEffective();
      this.emit('radioStatusChanged', payload);
    } catch (error) {
      logger.error('Failed to broadcast radio status after fake frequency update', error);
    }
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

  public getCurrentMode(): ModeDescriptor {
    return this.currentMode;
  }

  public getImageRadioService(): ImageRadioService | null {
    return this.imageRadioService;
  }

  public getImageArtifactStore(): ImageArtifactStore | null {
    return this.imageArtifactStore;
  }

  public getImageComposerBackgroundStore(): ImageComposerBackgroundStore | null {
    return this.imageComposerBackgroundStore;
  }

  public getImageHistoryStore(): ImageHistoryStore | null {
    return this.imageHistoryStore;
  }

  public getImageTemplateStore(): ImageTemplateStore | null {
    return this.imageTemplateStore;
  }

  public getSstvTxPreferenceStore(): SstvTxPreferenceStore | null {
    return this.sstvTxPreferenceStore;
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
    if (ConfigManager.getInstance().getActiveVirtualRadioProfile()) {
      throw new Error('physical audio is disabled while a virtual radio Profile is active');
    }
    await this.audioSidecar.retryNow();
  }

  public getSpectrumScheduler(): SpectrumScheduler {
    return this.spectrumScheduler;
  }

  public async updateSpectrumPreset(preset: SpectrumPreset): Promise<ReturnType<SpectrumScheduler['getRenderConfig']>> {
    return this.updateSpectrumSettings(preset);
  }

  public async updateSpectrumSettings(
    preset: SpectrumPreset,
    customSettings?: SpectrumCustomSettings,
  ): Promise<ReturnType<SpectrumScheduler['getRenderConfig']>> {
    const configManager = ConfigManager.getInstance();
    const previousSettings = configManager.getSpectrumSettings();
    const previousRevision = this.spectrumScheduler.getRenderConfig().revision;
    const nextRevision = previousRevision + 1;
    if (
      previousSettings.preset === preset
      && JSON.stringify(previousSettings.customSettings ?? null) === JSON.stringify(customSettings ?? null)
    ) {
      return this.spectrumScheduler.getRenderConfig();
    }

    this.spectrumScheduler.applyPreset(preset, nextRevision, customSettings);
    try {
      await configManager.updateSpectrumSettings(preset, customSettings);
    } catch (error) {
      this.spectrumScheduler.applyPreset(
        previousSettings.preset,
        previousRevision,
        previousSettings.customSettings,
      );
      throw error;
    }

    this.spectrumScheduler.emitConfigChanged();
    return this.spectrumScheduler.getRenderConfig();
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
    if (this.engineMode === 'image') {
      return configManager.getLastImageFrequency()?.radioMode ?? null;
    }
    return configManager.getLastSelectedFrequency()?.radioMode ?? null;
  }

  public getVoiceSessionManager(): VoiceSessionManager | null {
    return this.voiceSessionManager;
  }

  public getVoiceKeyerManager(): VoiceKeyerManager | null {
    return this.voiceKeyerManager;
  }

  public initializeAndroidOperatorAudioService(rxAudioRouter: RealtimeRxAudioRouter): AndroidOperatorAudioService | null {
    if (!this.voiceSessionManager) {
      return null;
    }
    if (!this.androidOperatorAudioService) {
      this.androidOperatorAudioService = new AndroidOperatorAudioService({
        voiceSessionManager: this.voiceSessionManager,
        rxAudioRouter,
      });
      this.androidOperatorAudioService.on('statusChanged', (status) => {
        this.emit('androidOperatorAudioStatusChanged', status);
      });
    }
    return this.androidOperatorAudioService;
  }

  public getAndroidOperatorAudioService(): AndroidOperatorAudioService | null {
    return this.androidOperatorAudioService;
  }

  public getCWKeyerManager(): CWKeyerManager {
    if (!this.cwKeyerManager) {
      this.cwKeyerManager = new CWKeyerManager(
        () => this.radioManager,
        this.physicalTxCoordinator,
      );
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

  public getExistingCWKeyerManager(): CWKeyerManager | null {
    return this.cwKeyerManager;
  }

  public async releaseCWKeyerForShutdown(reason: string): Promise<void> {
    if (!this.cwKeyerManager) {
      return;
    }

    await this.cwKeyerManager.stop();
    this.cwKeyerManager.removeAllListeners();
    this.cwKeyerManager = null;
    logger.info('CW keyer manager released for shutdown', { reason });
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
    this.dataDir = dataDir;
    const cacheDir = await tx5drPaths.getCacheDir();
    this._pluginManager.setDataDir(dataDir);
    this.imageArtifactStore = new ImageArtifactStore(path.join(dataDir, 'image-radio'));
    await this.imageArtifactStore.initialize();
    this.imageComposerBackgroundStore = new ImageComposerBackgroundStore(path.join(dataDir, 'image-radio'));
    await this.imageComposerBackgroundStore.initialize();
    this.imageHistoryStore = new ImageHistoryStore(path.join(dataDir, 'image-radio'));
    await this.imageHistoryStore.initialize();
    await this.imageHistoryStore.reconcileReceivedArtifacts(this.imageArtifactStore.listAll());
    this.imageArtifactStore.setRemovalListener((artifactId) => this.imageHistoryStore!.removeByArtifact(artifactId));
    this.imageTemplateStore = new ImageTemplateStore(path.join(dataDir, 'image-radio'));
    await this.imageTemplateStore.initialize();
    this.sstvTxPreferenceStore = new SstvTxPreferenceStore(path.join(dataDir, 'image-radio'));
    await this.sstvTxPreferenceStore.initialize();
    this.imageRadioService = new ImageRadioService(
      this.audioStreamManager,
      this.imageArtifactStore,
      this.imageHistoryStore,
      this.physicalTxCoordinator,
      () => this.radioManager.getKnownFrequency() ?? ConfigManager.getInstance().getLastImageFrequency()?.frequency ?? 0,
      () => this.getCurrentRadioMode() ?? undefined,
      (operatorId) => this._operatorManager.getOperatorById(operatorId)?.config.myCallsign,
      undefined,
      new ImagePaperSpool(path.join(cacheDir, 'image-radio-paper')),
    );
    this.imageRadioService.on('status', (status) => this.emit('imageRadioStatus', status));
    this.imageRadioService.on('rxEvent', (event) => this.emit('imageRxEvent', event));
    this.imageRadioService.on('txStatus', (status) => this.emit('sstvTxStatus', status));

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

    const spectrumSettings = ConfigManager.getInstance().getSpectrumSettings();
    this.spectrumScheduler.applyPreset(spectrumSettings.preset, 0, spectrumSettings.customSettings);
    await this.spectrumScheduler.initialize(
      this.audioStreamManager.getAudioProvider(),
      this.audioStreamManager.getInternalSampleRate()
    );
    this.spectrumScheduler.setInputSignalType(this.audioStreamManager.getInputSignalType());
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
      getFrequencyContext: () => this.getCurrentSlotPackFrequencyContext(),
    });
    this.clockCoordinator.setPSKReporterService(pskreporterService);

    this.voiceSessionManager = new VoiceSessionManager({
      radioManager: this.radioManager,
      audioStreamManager: this.audioStreamManager,
      physicalTxCoordinator: this.physicalTxCoordinator,
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
      physicalTxCoordinator: this.physicalTxCoordinator,
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
      isVirtualRadioActive: () => this.virtualRadioSession !== null,
      getImageRadioService: () => this.imageRadioService,
      getStatus: () => this.getStatus(),
    });
    this.engineLifecycle.setVoiceSessionManager(this.voiceSessionManager);

    // 监听操作员状态变化，广播虚拟频差实际生效状态
    this.on('operatorStatusUpdate' as any, () => {
      try {
        const radioManager = this.radioManager;
        if (!radioManager) return;
        const payload = buildRadioStatusPayload({
          connected: radioManager.isConnected(),
          status: radioManager.getConnectionStatus(),
          radioInfo: null,
          radioConfig: radioManager.getConfig(),
          reason: 'Operator status changed',
          radioManager,
        });
        // 添加虚拟频差实际生效状态
        (payload as any).fakeFrequencyEffective = this._operatorManager.isFakeFrequencyEffective();
        this.emit('radioStatusChanged', payload);
      } catch (error) {
        logger.warn('Failed to broadcast fake frequency status on operator status change', error);
      }
    });
  }

  private async initializeVoiceSessionManager(): Promise<void> {
    if (!this.voiceSessionManager) {
      return;
    }

    await this.voiceSessionManager.initialize();

    this.voiceSessionManager.on('voicePttLockChanged', (lock) => {
      this.emit('voicePttLockChanged', lock);
    });
    // Physical PTT state is projected exclusively from PhysicalTxCoordinator.
    // Voice session events remain session-local and are not a second RF truth.
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
    } else if (lastEngineMode === 'image') {
      this.engineMode = 'image';
      this.currentMode = configManager.getLastImageFrequency()?.mode === 'FAX' ? MODES.FAX : MODES.SSTV;
      this.syncCurrentModeToRuntimeComponents('restore-image-mode');
      logger.info('Restored last engine mode: image');
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
    await this.prepareVirtualRadioSession();
    try {
      return await this.engineLifecycle.start();
    } catch (error) {
      await this.stopVirtualRadioSession('engine start failed');
      throw error;
    }
  }

  async stop(): Promise<void> {
    // Profile/power/shutdown stops are full session boundaries. Let an
    // already-serialized mode transaction settle before disconnecting CAT.
    await this.modeSwitchTail.catch(() => undefined);
    await this.stopTuneTone('engine stopped');
    try {
      return await this.engineLifecycle.stop();
    } finally {
      await this.stopVirtualRadioSession('engine stopped');
    }
  }

  private async prepareVirtualRadioSession(): Promise<void> {
    await this.virtualRadioSessionStopPromise;
    const profile = ConfigManager.getInstance().getActiveVirtualRadioProfile();
    if (!profile) {
      await this.stopVirtualRadioSession('physical profile active');
      return;
    }
    if (this.engineMode !== 'digital' || (this.currentMode.name !== 'FT8' && this.currentMode.name !== 'FT4')) {
      throw new Error('virtual radio supports only FT8 and FT4 digital engine modes');
    }
    if (this.virtualRadioSession) {
      this.physicalTxAudioBackend = this.virtualRadioSession;
      return;
    }
    const scenarios = validateVirtualRadioSafety(
      profile,
      ConfigManager.getInstance(),
      this._pluginManager,
      this.currentMode.name,
    );
    const session = new VirtualRadioSession({
      profile,
      scenarios,
      mode: this.currentMode,
      dataDir: this.dataDir,
      now: () => this.clockSource.now(),
      getOutputGain: () => this.audioStreamManager.getVolumeGain(),
      ingestInput: (samples, sampleRate) => this.audioStreamManager.ingestVirtualInput(
        VIRTUAL_AUDIO_INGRESS_TOKEN,
        samples,
        sampleRate,
      ),
    });
    try {
      await session.start();
      this.virtualRadioSession = session;
      this.physicalTxAudioBackend = session;
    } catch (error) {
      await session.stop('virtual session start failed');
      throw error;
    }
  }

  private async stopVirtualRadioSession(reason: string): Promise<void> {
    if (this.virtualRadioSessionStopPromise) {
      return this.virtualRadioSessionStopPromise;
    }
    const session = this.virtualRadioSession;
    if (!session) return;
    this.virtualRadioSession = null;
    const stopPromise = (async () => {
      try {
        await session.stop(reason);
      } finally {
        if (this.physicalTxAudioBackend === session) {
          this.physicalTxAudioBackend = this.audioStreamManager;
        }
      }
    })();
    this.virtualRadioSessionStopPromise = stopPromise;
    try {
      await stopPromise;
    } finally {
      if (this.virtualRadioSessionStopPromise === stopPromise) {
        this.virtualRadioSessionStopPromise = null;
      }
    }
  }

  async destroy(): Promise<void> {
    logger.info('Destroying...');
    try {
      await this.stopTuneTone('engine destroyed');
      await this.audioSidecar.stop('engine-destroy');
      await this.androidOperatorAudioService?.destroy();
      this.androidOperatorAudioService = null;
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
      this.audioMixer.clearSlotCache();
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
    await this.releaseCWKeyerForShutdown('engine destroyed');
    if (this.cwDecoderManager) {
      this.cwDecoderManager.detachAudioStream();
      await this.cwDecoderManager.stop('engine-destroy');
      this.cwDecoderManager.removeAllListeners();
      this.cwDecoderManager = null;
      logger.info('CW decoder manager destroyed');
    }

    // 清理操作员管理器
    await this.operatorManager.cleanup();

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

  public async testPhysicalPTT(durationMs = 500): Promise<void> {
    const leaseId = await this.physicalTxCoordinator.acquireLease({
      source: 'test',
      reason: 'authenticated PTT test',
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, durationMs));
    } finally {
      await this.physicalTxCoordinator.releaseLease(leaseId, 'PTT test complete');
    }
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
      const virtualProfile = ConfigManager.getInstance().getActiveVirtualRadioProfile();
      const requestedModeName = typeof mode === 'string' ? mode : mode.name;
      if (virtualProfile && requestedModeName !== 'FT8' && requestedModeName !== 'FT4') {
        throw new Error('virtual radio supports only FT8 and FT4 digital engine modes');
      }
      // Handle CW mode
      if (typeof mode === 'object' && mode.name === 'CW') {
        if (this.engineMode === 'cw') {
          await this.runWithModeChangeGate(async () => {
            if (this.radioManager.isConnected()) await this.radioManager.getFrequency?.();
            logger.info('Already in CW mode');
            this.emitStatusSnapshot();
          });
          return;
        }
        await this.runWithModeChangeGate(() => this.switchEngineMode('cw', MODES.CW));
        return;
      }

      // Handle voice mode (string 'VOICE')
      if (mode === 'VOICE' || (typeof mode === 'object' && mode.name === 'VOICE')) {
        if (this.engineMode === 'voice') {
          await this.runWithModeChangeGate(async () => {
            if (this.radioManager.isConnected()) await this.radioManager.getFrequency?.();
            logger.info('Already in voice mode');
            this.emitStatusSnapshot();
          });
          return;
        }
        await this.runWithModeChangeGate(() => this.switchEngineMode('voice', MODES.VOICE));
        return;
      }

      if (typeof mode === 'object' && (mode.name === 'SSTV' || mode.name === 'FAX')) {
        if (this.engineMode === 'image' && this.currentMode.name === mode.name) {
          await this.runWithModeChangeGate(async () => {
            if (this.radioManager.isConnected()) await this.radioManager.getFrequency?.();
            this.emitStatusSnapshot();
          });
          return;
        }
        const target = mode.name === 'SSTV' ? MODES.SSTV : MODES.FAX;
        await this.runWithModeChangeGate(() => this.switchEngineMode('image', target));
        return;
      }

      const digitalMode = mode as ModeDescriptor;

      // If switching from voice to digital
      if (this.engineMode === 'voice') {
        await this.runWithModeChangeGate(() => this.switchEngineMode('digital', digitalMode));
        return;
      }

      // If switching from CW to digital
      if (this.engineMode === 'cw') {
        await this.runWithModeChangeGate(() => this.switchEngineMode('digital', digitalMode));
        return;
      }


      if (this.engineMode === 'image') {
        await this.runWithModeChangeGate(() => this.switchEngineMode('digital', digitalMode));
        return;
      }

      // Normal digital mode switch (FT8 <-> FT4)
      if (this.currentMode.name === digitalMode.name) {
        await this.runWithModeChangeGate(async () => {
          if (this.radioManager.isConnected()) {
            await this.radioManager.getFrequency?.();
          }
          logger.info(`Already in mode: ${digitalMode.name}`);
          this.syncCurrentModeToRuntimeComponents('already-in-mode');
          this.emitStatusSnapshot();
        });
        return;
      }

      await this.runWithModeChangeGate(async () => {
        logger.info(`Switching mode: ${this.currentMode.name} -> ${digitalMode.name}`);
        await this.applyNearestPresetForDigitalMode(digitalMode);

        const rebuildVirtualSession = this.virtualRadioSession !== null;
        if (rebuildVirtualSession) {
          await this.stopVirtualRadioSession('digital mode changed');
        }
        this.currentMode = digitalMode;
        this.applyDecodeWindowOverrides();
        this.syncCurrentModeToRuntimeComponents('digital-mode-switch');
        if (rebuildVirtualSession) {
          await this.prepareVirtualRadioSession();
        }

        await ConfigManager.getInstance().setLastDigitalModeName(digitalMode.name);
        this.emitModeAndStatusSnapshot();
      });
    };

    const queuedSwitch = this.modeSwitchTail.then(runSwitch, runSwitch);
    this.modeSwitchTail = queuedSwitch.catch(() => undefined);
    await queuedSwitch;
  }

  private async runWithModeChangeGate(operation: () => Promise<void>): Promise<void> {
    this._operatorManager.enterTransmissionMaintenance('mode change');
    try {
      await this.stopTuneTone('mode changed');
      const snapshot = this.physicalTxCoordinator.getSnapshot();
      if (snapshot.phase === 'unknown') {
        await this.physicalTxCoordinator.retryUnknownStop('mode change PTT recovery');
      } else if (snapshot.phase !== 'idle') {
        await this.physicalTxCoordinator.forceInterrupt('mode change');
      }

      const stopped = this.physicalTxCoordinator.getSnapshot();
      if (stopped.phase !== 'idle') {
        throw new Error(`Cannot switch mode while physical PTT is ${stopped.phase}`);
      }
      await operation();
    } finally {
      this._operatorManager.exitTransmissionMaintenance();
    }
  }

  /**
   * Serializes plugin-originated CAT/tuner mutations with every physical TX
   * source. This is deliberately narrower than mode switching: background
   * plugins reject a busy radio and never interrupt an existing lease.
   */
  private async submitPluginRadioMaintenanceCommand(
    command: PluginRadioCommand | PluginRadioTunerCommand,
  ): Promise<void> {
    const reason = command.type === 'switch-band'
      ? 'plugin scheduled band switch'
      : command.type === 'set-frequency'
        ? 'plugin frequency change'
        : 'plugin tuner command';

    await this.physicalTxCoordinator.runIdleMaintenance({ reason, busyPolicy: 'reject' }, async () => {
      this._operatorManager.enterTransmissionMaintenance(reason);
      try {
        if (!this.radioManager.isConnected()) {
          throw new Error('Radio is not connected');
        }

        if (command.type === 'set-frequency' || command.type === 'switch-band') {
          if (!Number.isFinite(command.frequency) || command.frequency <= 0) {
            throw new Error('Radio frequency must be a positive finite number');
          }
          let tunerSwitchEnabled = false;
          if (command.type === 'switch-band' && command.autoTune === true) {
            this.assertWritableRadioCapability('tuner_switch');
            this.assertWritableRadioCapability('tuner_tune');
            tunerSwitchEnabled = this.radioManager.getCapabilitySnapshot().capabilities
              .find((capability) => capability.id === 'tuner_switch')?.value === true;
          }

          const success = await this.radioManager.setFrequency(command.frequency);
          if (!success) throw new Error('Failed to set radio frequency');
          if (command.type === 'set-frequency' || command.autoTune !== true) return;

          if (!tunerSwitchEnabled) {
            await this.radioManager.writeCapability('tuner_switch', true, undefined);
          }
          await this.radioManager.writeCapability('tuner_tune', undefined, true);
          return;
        }

        if (command.type === 'set-enabled') {
          this.assertWritableRadioCapability('tuner_switch');
          await this.radioManager.writeCapability('tuner_switch', command.enabled, undefined);
          return;
        }

        this.assertWritableRadioCapability('tuner_tune');
        await this.radioManager.writeCapability('tuner_tune', undefined, true);
      } finally {
        this._operatorManager.exitTransmissionMaintenance();
      }
    });
  }

  private assertWritableRadioCapability(capabilityId: 'tuner_switch' | 'tuner_tune'): void {
    const snapshot = this.radioManager.getCapabilitySnapshot();
    const descriptor = snapshot.descriptors.find((item) => item.id === capabilityId);
    const state = snapshot.capabilities.find((item) => item.id === capabilityId);
    if (descriptor?.writable !== true
        || state?.supported !== true
        || state.availability === 'unavailable') {
      throw new Error(`Radio capability ${capabilityId} is unavailable`);
    }
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

    const virtualFrequency = configManager.getActiveVirtualRadioProfile()?.radio.virtual.dialFrequencyHz;
    if (this.isValidFrequency(virtualFrequency)) {
      return Math.round(virtualFrequency);
    }

    return null;
  }

  private getCurrentSlotPackFrequencyContext(): SlotPackFrequencyContext | undefined {
    const configManager = ConfigManager.getInstance();
    const frequency = this.resolveCurrentDigitalFrequency(configManager);
    if (!frequency) return undefined;
    const saved = configManager.getLastSelectedFrequency();
    const radioMode = this.getCurrentRadioMode();
    return {
      frequency,
      mode: this.currentMode.name,
      band: getBandFromFrequency(frequency),
      ...(radioMode ? { radioMode } : {}),
      ...(saved?.frequency === frequency && saved.description ? { description: saved.description } : {}),
    };
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

  private async applyDigitalPresetFrequency(
    preset: PresetFrequency,
    expectedConnectionGeneration?: number,
  ): Promise<OperatingStateSyncResult> {
    const configManager = ConfigManager.getInstance();
    const description = preset.description
      || `${formatFrequencyMHz(preset.frequency)} MHz${preset.band ? ` ${preset.band}` : ''}`;
    const radioConnected = this.radioManager.isConnected();
    const activeRadioConfig = configManager.getRadioConfig();
    const radioModeResolution = resolveFrequencyRadioMode({
      effectiveMode: preset.mode,
      requestedRadioMode: preset.radioMode,
      engineMode: 'digital',
      digitalModeRadioMode: activeRadioConfig.digitalModeRadioMode,
    });
    const effectiveRadioMode = radioModeResolution.displayRadioMode;

    let syncResult: OperatingStateSyncResult = { status: 'skipped-offline' };
    let frequencyConfirmed = !radioConnected;
    let appliedOperatingState: Awaited<ReturnType<PhysicalRadioManager['applyOperatingState']>> | null = null;
    if (radioConnected) {
      const request = buildFrequencyOperatingStateRequest({
        frequency: preset.frequency,
        radioMode: preset.radioMode,
        effectiveMode: preset.mode,
        engineMode: 'digital',
        digitalModeRadioMode: activeRadioConfig.digitalModeRadioMode,
      });
      const applyResult = await this.applyModeOperatingState(request, expectedConnectionGeneration);
      appliedOperatingState = applyResult;

      if (!applyResult.frequencyApplied) {
        throw new Error(`Failed to switch radio frequency to ${description}`);
      }

      if (applyResult.frequencyConfirmed === false) {
        syncResult = {
          status: 'partially-applied',
          detail: applyResult.observedFrequency === undefined
            ? 'radio frequency write was not confirmed by readback'
            : `radio readback remained at ${applyResult.observedFrequency} Hz`,
        };
      }
      frequencyConfirmed = applyResult.frequencyConfirmed !== false;

      if (request.mode && (!applyResult.modeApplied || applyResult.modeError)) {
        logger.warn(
          `Switched digital frequency but failed to set radio mode: ${applyResult.modeError?.message || 'not confirmed'}`,
        );
        syncResult = {
          status: 'partially-applied',
          detail: applyResult.modeError?.message || 'radio mode write was not confirmed',
        };
      } else if (syncResult.status !== 'partially-applied') {
        syncResult = { status: 'applied' };
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

    const nextFrequency: {
      frequency: number;
      mode: string;
      band: string;
      description?: string;
      radioMode?: string;
    } = {
      frequency: preset.frequency,
      mode: preset.mode,
      band: preset.band,
      description,
      radioMode: effectiveRadioMode,
    };
    if (!effectiveRadioMode) {
      delete nextFrequency.radioMode;
    }
    if (!radioConnected || frequencyConfirmed) {
      await configManager.updateLastSelectedFrequency(nextFrequency);
    }

    this.slotPackManager.clearInMemory();
    this.emitProgramFrequencyState({
      frequency: preset.frequency,
      mode: preset.mode,
      band: preset.band,
      radioMode: effectiveRadioMode,
      description,
      radioConnected,
      confirmation: radioConnected
        ? (frequencyConfirmed ? 'confirmed' : 'mismatch')
        : 'offline',
      ...(appliedOperatingState?.observedFrequency !== undefined
        ? { observedFrequency: appliedOperatingState.observedFrequency }
        : {}),
      requestedFrequency: preset.frequency,
      ...(appliedOperatingState?.operationId ? { operationId: appliedOperatingState.operationId } : {}),
      modeConfirmation: radioConnected
        ? this.resolveModeConfirmation(appliedOperatingState ?? undefined, effectiveRadioMode)
        : 'unknown',
    });
    return syncResult;
  }

  private async restoreLastDigitalOperatingState(
    configManager: ConfigManager,
    targetMode: ModeDescriptor,
    expectedConnectionGeneration?: number,
  ): Promise<OperatingStateSyncResult | null> {
    const lastDigital = configManager.getLastSelectedFrequency();
    if (!lastDigital?.frequency) {
      if (!this.radioManager.isConnected()) {
        return null;
      }
      const currentFrequency = this.radioManager.getLastConfirmedFrequency?.()
        ?? await this.radioManager.getFrequency();
      if (!currentFrequency || currentFrequency <= 0) {
        return { status: 'failed', detail: 'current radio frequency is unavailable' };
      }
      try {
        const request = buildFrequencyOperatingStateRequest({
          frequency: currentFrequency,
          effectiveMode: targetMode.name,
          engineMode: 'digital',
          digitalModeRadioMode: configManager.getRadioConfig().digitalModeRadioMode,
        });
        // There is no saved digital frequency to restore. The current
        // confirmed dial is already the source of truth; only reconcile the
        // profile's optional CAT mode instead of writing the same frequency.
        delete request.frequency;
        const result = await this.applyModeOperatingState(request, expectedConnectionGeneration);
        const band = this.resolveBandLabel(currentFrequency);
        this.emitProgramFrequencyState({
          frequency: currentFrequency,
          mode: targetMode.name,
          band,
          description: `${formatFrequencyMHz(currentFrequency)} MHz`,
          radioConnected: true,
          confirmation: result.frequencyConfirmed === false ? 'mismatch' : 'confirmed',
          ...(result.observedFrequency !== undefined ? { observedFrequency: result.observedFrequency } : {}),
          requestedFrequency: currentFrequency,
          ...(result.operationId ? { operationId: result.operationId } : {}),
          modeConfirmation: this.resolveModeConfirmation(result, request.mode),
        });
        if (result.frequencyConfirmed !== false) {
          await configManager.updateLastSelectedFrequency({
            frequency: currentFrequency,
            mode: targetMode.name,
            band,
            description: `${formatFrequencyMHz(currentFrequency)} MHz`,
          });
        }
        return result.frequencyConfirmed === false || result.modeError
          ? { status: 'partially-applied', detail: result.modeError?.message ?? 'radio frequency write was not confirmed by readback' }
          : { status: 'applied' };
      } catch (error) {
        return { status: 'failed', detail: error instanceof Error ? error.message : String(error) };
      }
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
      const result = await this.applyDigitalPresetFrequency(targetFrequency, expectedConnectionGeneration);
      logger.info(`Digital operating state ${result.status}`, {
        frequencyHz: targetFrequency.frequency,
        mode: targetFrequency.mode,
        detail: result.detail,
      });
      return result;
    } catch (error) {
      logger.warn(`Failed to restore digital operating state: ${(error as Error).message}`);
      return { status: 'failed', detail: (error as Error).message };
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
          frequency: formatFrequencyMHz(frequency),
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
          frequency: formatFrequencyMHz(frequency),
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
    const previousEngineMode = this.engineMode;
    const previousMode = this.currentMode;
    const configManager = ConfigManager.getInstance();
    const expectedProfileId = configManager.getActiveProfileId?.();
    const radioWasConnected = this.radioManager.isConnected();
    const expectedConnectionGeneration = this.radioManager.getConnectionGeneration?.();
    const previousCWDecoderRuntime = previousEngineMode === 'cw'
      && this.cwDecoderManager?.getStatus().state === 'running'
      ? {
          config: configManager.getCWDecoderConfig(),
          startedEngine: this.cwDecoderStartedEngine,
        }
      : null;
    let engineState = this.engineLifecycle?.getEngineState() ?? EngineState.IDLE;
    let shouldResumeAfterSwitch = engineState === EngineState.RUNNING || engineState === EngineState.STARTING || targetEngineMode === 'image';
    // CW keying can lazy-init its own manager, but RX monitor/decoder still
    // need the engine audio chain. Preserve the user's running/idle intent.
    const comingFromCW = this.engineMode === 'cw';
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
      await this.stopTuneTone('mode runtime stopped');
      await this.engineLifecycle.stopModeRuntime();
    }

    let targetModeStaged = false;
    try {
      this.assertModeSwitchProfile(configManager, expectedProfileId);
      this.engineMode = targetEngineMode;
      this.currentMode = targetMode;
      targetModeStaged = true;
      this.configureAudioProcessingForCurrentMode?.('mode-switch');

      if (targetEngineMode === 'digital') {
        this.applyDecodeWindowOverrides();
      }

      this.syncCurrentModeToRuntimeComponents('engine-mode-switch');
      await this.engineLifecycle.rebuildResourcePlan();
      const operatingStateResult = await this.restoreOperatingStateForEngineMode(
        configManager,
        targetEngineMode,
        targetMode,
        radioWasConnected ? expectedConnectionGeneration : undefined,
      );
      this.reportOperatingStateSync(targetEngineMode, targetMode, operatingStateResult);
      this.assertModeSwitchProfile(configManager, expectedProfileId);
      this.assertModeSwitchRadioSession(
        targetEngineMode,
        radioWasConnected,
        expectedConnectionGeneration,
      );

      if (shouldResumeAfterSwitch) {
        await this.engineLifecycle.startAndWaitForRunning();
      }

      this.assertModeSwitchProfile(configManager, expectedProfileId);
      this.assertModeSwitchRadioSession(
        targetEngineMode,
        radioWasConnected,
        expectedConnectionGeneration,
      );

      await configManager.setLastEngineMode(targetEngineMode);
      if (targetEngineMode === 'digital') {
        await configManager.setLastDigitalModeName(targetMode.name);
      }

      this.emitModeAndStatusSnapshot();
      if (shouldResumeAfterSwitch) {
        this.emitStatusSnapshot();
      }

      // Refresh split capability after mode switch (some radios support split only in certain modes)
      void this.radioManager?.refreshSplitCapability?.();

      this.resetVoicePttState();
      this.squelchStatusMonitor.reevaluate();
      this.physicalPttMonitor.reevaluate();
      logger.info(`Engine mode switched to ${targetEngineMode}/${targetMode.name}`);
    } catch (error) {
      const profileChanged = expectedProfileId !== undefined
        && configManager.getActiveProfileId() !== expectedProfileId;
      if (targetModeStaged && !profileChanged) {
        await this.rollbackEngineModeSwitch(
          previousEngineMode,
          previousMode,
          shouldResumeAfterSwitch,
          configManager,
          error,
          previousCWDecoderRuntime,
        );
      }
      throw error;
    }
  }

  private assertModeSwitchProfile(
    configManager: ConfigManager,
    expectedProfileId: string | null | undefined,
  ): void {
    if (
      expectedProfileId !== undefined
      && configManager.getActiveProfileId() !== expectedProfileId
    ) {
      throw new Error('Active radio profile changed during mode switch');
    }
  }

  private assertModeSwitchRadioSession(
    targetEngineMode: EngineMode,
    radioWasConnected: boolean,
    expectedConnectionGeneration: number | undefined,
  ): void {
    if (!radioWasConnected || expectedConnectionGeneration === undefined) {
      return;
    }

    const sessionUnchanged = this.radioManager.isConnected()
      && this.radioManager.getConnectionGeneration() === expectedConnectionGeneration;
    if (sessionUnchanged) {
      return;
    }

    if (targetEngineMode === 'cw') {
      this.reportOperatingStateSync(targetEngineMode, MODES.CW, {
        status: 'skipped-offline',
        detail: 'CAT session changed during mode switch',
      });
      return;
    }

    throw new Error('Physical radio connection changed during mode switch');
  }

  private reportOperatingStateSync(
    engineMode: EngineMode,
    mode: ModeDescriptor,
    result: OperatingStateSyncResult | null,
  ): void {
    if (!result) {
      return;
    }

    if (result.status === 'applied') {
      if (this.operatingStateWarningActive) {
        logger.info('Radio operating-state warning cleared after confirmed synchronization');
      }
      this.operatingStateWarningActive = false;
      return;
    }

    this.operatingStateWarningActive = true;
    const detail = result.detail || (
      result.status === 'skipped-offline'
        ? 'The physical radio is offline.'
        : 'The radio did not confirm every requested CAT setting.'
    );
    this.emit('textMessage', {
      title: 'Radio mode not confirmed',
      text: `${mode.name} is active in TX-5DR, but the physical radio operating state was ${result.status}. ${detail} Please verify the radio manually.`,
      color: 'warning',
      timeout: null,
      key: 'radioOperatingStateNotConfirmed',
      params: {
        engineMode,
        mode: mode.name,
        status: result.status,
        reason: detail,
      },
    });
  }

  private async restoreOperatingStateForEngineMode(
    configManager: ConfigManager,
    engineMode: EngineMode,
    mode: ModeDescriptor,
    expectedConnectionGeneration?: number,
  ): Promise<OperatingStateSyncResult | null> {
    if (engineMode === 'voice') {
      return this.restoreLastVoiceOperatingState(configManager, expectedConnectionGeneration);
    } else if (engineMode === 'cw') {
      return this.restoreLastCWOperatingState(configManager, expectedConnectionGeneration);
    } else if (engineMode === 'image') {
      const saved = configManager.getLastImageFrequency();
      if (!this.radioManager.isConnected()) {
        return saved ? { status: 'skipped-offline' } : null;
      }
      const targetFrequency = saved?.frequency
        ?? this.radioManager.getLastConfirmedFrequency?.()
        ?? await this.radioManager.getFrequency();
      if (!targetFrequency || targetFrequency <= 0) {
        return { status: 'failed', detail: 'current radio frequency is unavailable' };
      }
      const applyResult = await this.applyModeOperatingState({
        ...(saved ? { frequency: targetFrequency } : {}),
        mode: saved?.radioMode,
        bandwidth: saved?.radioMode ? 'nochange' : undefined,
        options: saved?.radioMode ? { intent: 'voice' } : undefined,
        tolerateModeFailure: true,
      }, expectedConnectionGeneration);
      const band = saved?.band || this.resolveBandLabel(targetFrequency);
      const description = saved?.description || `${formatFrequencyMHz(targetFrequency)} MHz${band !== 'Unknown' ? ` ${band}` : ''}`;
      this.emitProgramFrequencyState({
        frequency: targetFrequency,
        mode: mode.name,
        band,
        description,
        ...(saved?.radioMode ? { radioMode: saved.radioMode } : {}),
        radioConnected: true,
        confirmation: applyResult.frequencyConfirmed === false ? 'mismatch' : 'confirmed',
        ...(applyResult.observedFrequency !== undefined ? { observedFrequency: applyResult.observedFrequency } : {}),
        requestedFrequency: targetFrequency,
        ...(applyResult.operationId ? { operationId: applyResult.operationId } : {}),
        modeConfirmation: this.resolveModeConfirmation(applyResult, saved?.radioMode),
      });
      if (!saved && applyResult.frequencyConfirmed !== false) {
        await configManager.updateLastImageFrequency({
          frequency: targetFrequency,
          mode: mode.name,
          band,
          description,
        });
      }
      return {
        status: (saved ? applyResult.frequencyApplied : true) && applyResult.frequencyConfirmed !== false && (!saved?.radioMode || applyResult.modeApplied) ? 'applied' : (saved ? applyResult.frequencyApplied : true) ? 'partially-applied' : 'failed',
        detail: applyResult.modeError?.message ?? (applyResult.frequencyConfirmed === false ? 'radio frequency write was not confirmed by readback' : undefined),
      };
    }
    return this.restoreLastDigitalOperatingState(configManager, mode, expectedConnectionGeneration);
  }

  private applyModeOperatingState(
    request: Parameters<PhysicalRadioManager['applyOperatingState']>[0],
    expectedConnectionGeneration?: number,
  ): ReturnType<PhysicalRadioManager['applyOperatingState']> {
    return expectedConnectionGeneration === undefined
      ? this.radioManager.applyOperatingState(request)
      : this.radioManager.applyOperatingState(request, { expectedConnectionGeneration });
  }

  private async rollbackEngineModeSwitch(
    previousEngineMode: EngineMode,
    previousMode: ModeDescriptor,
    shouldResume: boolean,
    configManager: ConfigManager,
    cause: unknown,
    previousCWDecoderRuntime: { config: CWDecoderConfig; startedEngine: boolean } | null,
  ): Promise<void> {
    logger.error('Mode runtime switch failed; restoring previous runtime', {
      previousEngineMode,
      previousMode: previousMode.name,
      error: cause instanceof Error ? cause.message : String(cause),
    });

    try {
      if (this.engineLifecycle.getEngineState() !== EngineState.IDLE) {
        await this.engineLifecycle.stopModeRuntime();
      }
      this.engineMode = previousEngineMode;
      this.currentMode = previousMode;
      this.configureAudioProcessingForCurrentMode?.('mode-switch-rollback');
      if (previousEngineMode === 'digital') {
        this.applyDecodeWindowOverrides();
      }
      this.syncCurrentModeToRuntimeComponents('engine-mode-switch-rollback');
      await this.engineLifecycle.rebuildResourcePlan();
      await this.restoreOperatingStateForEngineMode(configManager, previousEngineMode, previousMode);
      if (shouldResume) {
        await this.engineLifecycle.startAndWaitForRunning();
      }
      if (previousEngineMode === 'cw' && previousCWDecoderRuntime) {
        await this.getCWDecoderManager().start(this.toServerCWDecoderConfig({
          ...previousCWDecoderRuntime.config,
          enabled: true,
        }));
        this.cwDecoderStartedEngine = previousCWDecoderRuntime.startedEngine;
      }
      this.emitModeAndStatusSnapshot();
    } catch (rollbackError) {
      logger.error('Failed to restore previous mode runtime', rollbackError);
    }
  }

  private async restoreLastVoiceOperatingState(
    configManager: ConfigManager,
    expectedConnectionGeneration?: number,
  ): Promise<OperatingStateSyncResult | null> {
    const lastVoice = configManager.getLastVoiceFrequency();
    if (!this.radioManager.isConnected()) {
      return lastVoice?.frequency ? { status: 'skipped-offline' } : null;
    }

    const targetFrequency = lastVoice?.frequency
      ?? this.radioManager.getLastConfirmedFrequency?.()
      ?? await this.radioManager.getFrequency();
    if (!targetFrequency || targetFrequency <= 0) {
      return { status: 'failed', detail: 'current radio frequency is unavailable' };
    }

    try {
      const applyResult = await this.applyModeOperatingState({
        ...(lastVoice ? { frequency: targetFrequency } : {}),
        mode: lastVoice?.radioMode,
        bandwidth: lastVoice?.radioMode ? 'nochange' : undefined,
        options: lastVoice?.radioMode ? { intent: 'voice' } : undefined,
        tolerateModeFailure: true,
      }, expectedConnectionGeneration);

      if (lastVoice && !applyResult.frequencyApplied) {
        logger.warn(`Failed to restore last voice frequency: ${formatFrequencyMHz(lastVoice.frequency)} MHz`);
        return { status: 'failed', detail: 'frequency write was not confirmed' };
      }

      if (applyResult.modeError) {
        logger.warn(`Restored last voice frequency but failed to set radio mode: ${applyResult.modeError.message}`);
      }

      const supportsFmOptions = lastVoice?.radioMode?.toUpperCase() === 'FM';
      await this.applyRepeaterDuplexConfigWithWarning({
        repeaterShift: supportsFmOptions ? (lastVoice?.repeaterShift ?? 'none') : 'none',
        repeaterOffsetHz: supportsFmOptions ? lastVoice?.repeaterOffsetHz : undefined,
      }, targetFrequency, supportsFmOptions && (lastVoice?.repeaterShift === 'minus' || lastVoice?.repeaterShift === 'plus'));
      await this.applyToneSquelchConfigWithWarning({
        toneMode: supportsFmOptions ? (lastVoice?.toneMode ?? 'none') : 'none',
        ctcssToneTenthsHz: supportsFmOptions ? lastVoice?.ctcssToneTenthsHz : undefined,
        dcsCode: supportsFmOptions ? lastVoice?.dcsCode : undefined,
      }, targetFrequency, supportsFmOptions && (lastVoice?.toneMode === 'ctcss' || lastVoice?.toneMode === 'dcs'));

      const band = lastVoice?.band || this.resolveBandLabel(targetFrequency);
      const description = lastVoice?.description || `${formatFrequencyMHz(targetFrequency)} MHz${band !== 'Unknown' ? ` ${band}` : ''}`;
      this.emitProgramFrequencyState({
        frequency: targetFrequency,
        mode: 'VOICE',
        band,
        description,
        ...(lastVoice?.radioMode ? { radioMode: lastVoice.radioMode } : {}),
        radioConnected: true,
        confirmation: applyResult.frequencyConfirmed === false ? 'mismatch' : 'confirmed',
        ...(applyResult.observedFrequency !== undefined ? { observedFrequency: applyResult.observedFrequency } : {}),
        requestedFrequency: targetFrequency,
        ...(applyResult.operationId ? { operationId: applyResult.operationId } : {}),
        modeConfirmation: this.resolveModeConfirmation(applyResult, lastVoice?.radioMode),
      });
      if (!lastVoice && applyResult.frequencyConfirmed !== false) {
        await configManager.updateLastVoiceFrequency({
          frequency: targetFrequency,
          band,
          description,
        });
      }
      logger.info(`Restored last voice operating state: ${description}${lastVoice?.radioMode ? ` (${lastVoice.radioMode})` : ''}`);
      if (applyResult.frequencyConfirmed === false) {
        return { status: 'partially-applied', detail: 'radio frequency write was not confirmed by readback' };
      }
      return applyResult.modeError
        ? { status: 'partially-applied', detail: applyResult.modeError.message }
        : { status: 'applied' };
    } catch (error) {
      logger.warn(`Failed to restore last voice operating state: ${(error as Error).message}`);
      return { status: 'failed', detail: (error as Error).message };
    }
  }

  private async restoreLastCWOperatingState(
    configManager: ConfigManager,
    expectedConnectionGeneration?: number,
  ): Promise<OperatingStateSyncResult | null> {
    if (!this.radioManager.isConnected()) {
      logger.info('CW operating state skipped-offline');
      return { status: 'skipped-offline' };
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
        return { status: 'failed', detail: 'current radio frequency is unavailable' };
      }
      targetFrequency = currentFreq;
      targetRadioMode = 'CW';
      logger.info(`No saved CW frequency, switching radio to CW mode on current frequency: ${formatFrequencyMHz(currentFreq)} MHz`);
    }

    try {
      const applyResult = await this.applyModeOperatingState({
        ...(lastCW?.frequency ? { frequency: targetFrequency } : {}),
        mode: targetRadioMode,
        bandwidth: targetRadioMode ? 'nochange' : undefined,
        options: targetRadioMode ? { intent: 'cw' } : undefined,
        tolerateModeFailure: true,
      }, expectedConnectionGeneration);

      if (lastCW?.frequency && !applyResult.frequencyApplied) {
        logger.warn(`Failed to restore CW frequency: ${formatFrequencyMHz(targetFrequency)} MHz`);
        return { status: 'failed', detail: 'frequency write was not confirmed' };
      }

      if (applyResult.modeError) {
        logger.warn(`Restored CW frequency but failed to set radio mode: ${applyResult.modeError.message}`);
      }

      const band = this.resolveBandLabel(targetFrequency);
      const description = `${formatFrequencyMHz(targetFrequency)} MHz${band !== 'Unknown' ? ` ${band}` : ''}`;
      this.emitProgramFrequencyState({
        frequency: targetFrequency,
        mode: 'CW',
        band,
        description,
        radioMode: targetRadioMode,
        radioConnected: true,
        confirmation: applyResult.frequencyConfirmed === false ? 'mismatch' : 'confirmed',
        ...(applyResult.observedFrequency !== undefined ? { observedFrequency: applyResult.observedFrequency } : {}),
        requestedFrequency: targetFrequency,
        ...(applyResult.operationId ? { operationId: applyResult.operationId } : {}),
        modeConfirmation: this.resolveModeConfirmation(applyResult, targetRadioMode),
      });
      if (!lastCW && applyResult.modeApplied) {
        await configManager.updateLastCWFrequency({
          frequency: targetFrequency,
          radioMode: targetRadioMode,
          band,
          description,
        });
      }
      logger.info(`Restored CW operating state: ${description}${targetRadioMode ? ` (${targetRadioMode})` : ''}`);
      if (applyResult.frequencyConfirmed === false) {
        return { status: 'partially-applied', detail: 'radio frequency write was not confirmed by readback' };
      }
      return applyResult.modeError
        ? { status: 'partially-applied', detail: applyResult.modeError.message }
        : { status: 'applied' };
    } catch (error) {
      logger.warn(`Failed to restore CW operating state: ${(error as Error).message}`);
      return { status: 'failed', detail: (error as Error).message };
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

  private handlePhysicalPttChanged(active: boolean): void {
    this.physicalPttActive = active;
    this.voiceKeyerManager?.setManualPttActive(this.voiceManualPttActive || this.physicalPttActive);
    this.applyUnifiedVoicePttState([]);
  }

  private handleCoordinatedPhysicalTxChanged(snapshot: PhysicalTxSnapshot): void {
    const uncertain = snapshot.phase === 'unknown';
    const pttConfirmed = snapshot.pttConfirmed || uncertain;
    const operatorIds = pttConfirmed && snapshot.source === 'digital'
      ? snapshot.operatorIds
      : [];

    this.radioManager.setPTTActive(pttConfirmed);
    this.spectrumScheduler.setPTTActive(pttConfirmed);
    this.squelchStatusMonitor?.setPTTActive(pttConfirmed);
    this.physicalPttMonitor?.setSoftwarePttActive(snapshot.phase !== 'idle');

    if (snapshot.source === 'voice') {
      this.voiceManualPttActive = snapshot.phase !== 'idle';
    } else if (snapshot.source === 'voice-keyer') {
      this.voiceKeyerPttActive = snapshot.phase !== 'idle';
    } else if (snapshot.phase === 'idle') {
      this.voiceManualPttActive = false;
      this.voiceKeyerPttActive = false;
    }
    this.voiceKeyerManager?.setManualPttActive(
      this.voiceManualPttActive || this.physicalPttActive,
    );
    this.unifiedVoicePttActive = this.voiceManualPttActive
      || this.voiceKeyerPttActive
      || this.physicalPttActive;

    this._operatorManager.updateActiveTransmissionOperators(operatorIds);
    this.emit('pttStatusChanged', {
      isTransmitting: pttConfirmed,
      operatorIds,
      phase: snapshot.phase === 'active' ? 'on_air' : snapshot.phase,
      frameId: snapshot.frameId,
      source: snapshot.source,
    });
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

  private resolveModeConfirmation(
    result: { modeApplied: boolean; modeError?: Error } | null | undefined,
    requestedMode?: string,
  ): 'confirmed' | 'unconfirmed' | 'unknown' {
    if (!requestedMode) return 'unknown';
    return result?.modeApplied && !result.modeError ? 'confirmed' : 'unconfirmed';
  }

  private emitProgramFrequencyState(payload: {
    frequency: number;
    mode: string;
    band: string;
    description: string;
    radioMode?: string;
    radioConnected: boolean;
    confirmation: 'confirmed' | 'pending' | 'mismatch' | 'offline';
    observedFrequency?: number;
    requestedFrequency?: number;
    operationId?: string;
    modeConfirmation?: 'confirmed' | 'unconfirmed' | 'unknown';
  }): void {
    const {
      frequency,
      mode,
      band,
      description,
      radioMode,
      radioConnected: _radioConnected,
      ...metadata
    } = payload;
    const publish = this.radioManager.publishOperatingStateSnapshot;
    if (typeof publish === 'function') {
      publish.call(this.radioManager, frequency, {
        ...metadata,
        source: 'program',
        logicalState: {
          mode,
          band,
          description,
          ...(radioMode ? { radioMode } : {}),
        },
      });
      return;
    }

    // Compatibility for lightweight test doubles and older embedders. The
    // concrete manager always owns publication, so this branch is not part of
    // the production event topology.
    const revision = this.radioManager.nextFrequencyStateRevision?.();
    this.emit('frequencyChanged', {
      ...payload,
      source: 'program',
      ...(revision !== undefined ? { revision } : {}),
      connectionGeneration: this.radioManager.getConnectionGeneration?.(),
    });
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
    const isActuallyDecoding = this.engineMode === 'voice' || this.engineMode === 'cw' || this.engineMode === 'image'
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
