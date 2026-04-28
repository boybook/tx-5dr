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
  type EngineMode,
  type SquelchStatus,
  resolveWindowTiming,
} from '@tx5dr/contracts';
import { EventEmitter } from 'eventemitter3';
import { AudioStreamManager } from './audio/AudioStreamManager.js';
import { WSJTXDecodeWorkQueue } from './decode/WSJTXDecodeWorkQueue.js';
import { WSJTXEncodeWorkQueue } from './decode/WSJTXEncodeWorkQueue.js';
import { SlotPackManager } from './slot/SlotPackManager.js';
import { ConfigManager } from './config/config-manager.js';
import { SpectrumScheduler } from './audio/SpectrumScheduler.js';
import { AudioMixer } from './audio/AudioMixer.js';
import { RadioOperatorManager } from './operator/RadioOperatorManager.js';
import { printAppPaths } from './utils/debug-paths.js';
import { PhysicalRadioManager } from './radio/PhysicalRadioManager.js';
import { FrequencyManager } from './radio/FrequencyManager.js';
import { TransmissionTracker } from './transmission/TransmissionTracker.js';
import type { OpenWebRXAudioAdapter } from './openwebrx/OpenWebRXAudioAdapter.js';
import { MemoryLeakDetector } from './utils/MemoryLeakDetector.js';
import { ResourceManager } from './utils/ResourceManager.js';
import { initializePSKReporterService } from './services/PSKReporterService.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger('DigitalRadioEngine');

// 子系统
import { AudioVolumeController } from './subsystems/AudioVolumeController.js';
import { AudioSidecarController } from './subsystems/AudioSidecarController.js';
import { RadioBridge } from './subsystems/RadioBridge.js';
import { TransmissionPipeline } from './subsystems/TransmissionPipeline.js';
import { ClockCoordinator } from './subsystems/ClockCoordinator.js';
import { EngineLifecycle } from './subsystems/EngineLifecycle.js';
import { VoiceSessionManager } from './voice/VoiceSessionManager.js';
import { VoiceKeyerManager } from './voice/VoiceKeyerManager.js';
import { EngineState } from './state-machines/types.js';
import { PluginManager } from './plugin/PluginManager.js';
import { tx5drPaths } from './utils/app-paths.js';
import { CallsignContextTracker } from './slot/CallsignContextTracker.js';
import { NtpCalibrationService } from './services/NtpCalibrationService.js';
import { RigctldBridge } from './rigctld/RigctldBridge.js';
import { SquelchStatusMonitor } from './radio/SquelchStatusMonitor.js';
import { PhysicalPttMonitor } from './radio/PhysicalPttMonitor.js';
import type { RigctldBridgeConfig, RigctldStatus } from '@tx5dr/contracts';

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
    this.ntpCalibrationService = new NtpCalibrationService(this.clockSource, ConfigManager.getInstance().getNtpServers());
    this.audioStreamManager = new AudioStreamManager();
    this.realDecodeQueue = new WSJTXDecodeWorkQueue(1);
    this.realEncodeQueue = new WSJTXEncodeWorkQueue(1);
    this.slotPackManager = new SlotPackManager();
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
      setRadioFrequency: (freq) => {
        try { this.radioManager.setFrequency(freq); } catch (e) { logger.error('Failed to set radio frequency', e); }
      },
      getRadioBand: () => ConfigManager.getInstance().getLastSelectedFrequency()?.band ?? '',
      getRadioConnected: () => this.radioManager.isConnected(),
      getLatestSlotPack: () => this.slotPackManager.getLatestSlotPack(),
      findBestTransmitFrequency: (slotId, minFreq, maxFreq, guardBandwidth) => (
        this.slotPackManager.findBestTransmitFrequency(slotId, minFreq, maxFreq, guardBandwidth)
      ),
      setOperatorAudioFrequency: async (operatorId, frequency) => {
        await this._operatorManager.updateOperatorContext(operatorId, { frequency });
      },
      interruptOperatorTransmission: async (operatorId) => {
        await this.removeOperatorFromTransmission(operatorId);
      },
      hasWorkedCallsign: async (operatorId, callsign) => {
        return this._operatorManager.hasWorkedCallsign(operatorId, callsign);
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
    this.on('radioStatusChanged', () => {
      this.squelchStatusMonitor.reevaluate();
      this.physicalPttMonitor.reevaluate();
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

  public getEngineLifecycle(): EngineLifecycle {
    return this.engineLifecycle;
  }

  public getAudioStreamManager(): AudioStreamManager {
    return this.audioStreamManager;
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

  public getVoiceSessionManager(): VoiceSessionManager | null {
    return this.voiceSessionManager;
  }

  public getVoiceKeyerManager(): VoiceKeyerManager | null {
    return this.voiceKeyerManager;
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
    this.finalizeLifecyclePhase();

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
    await this.ntpCalibrationService.start();

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
      () => ConfigManager.getInstance().getFT8Config().decodeWhileTransmitting ?? false
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
    await this._pluginManager.start();

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
      operatorManager: this._operatorManager,
      audioMixer: this.audioMixer,
      clockSource: this.clockSource,
      subsystems: {
        transmissionPipeline: this.transmissionPipeline,
        clockCoordinator: this.clockCoordinator,
      },
      getCurrentMode: () => this.currentMode,
      getVoiceSessionManager: () => this.voiceSessionManager,
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

    if (lastDigitalModeName && lastDigitalModeName !== this.currentMode.name) {
      const targetMode = Object.values(MODES).find(m => m.name === lastDigitalModeName);
      if (targetMode && targetMode.name !== 'VOICE') {
        this.currentMode = targetMode;
        this.applyDecodeWindowOverrides();
        this.slotClock?.setMode(this.currentMode);
        this.slotPackManager.setMode(this.currentMode);
        logger.info(`Restored last digital mode: ${this.currentMode.name}`);
      }
    }

    if (lastEngineMode === 'voice') {
      this.engineMode = 'voice';
      this.currentMode = MODES.VOICE;
      logger.info('Restored last engine mode: voice');
    }
  }

  private finalizeLifecyclePhase(): void {
    logger.info('Initialization phase: lifecycle');

    this.engineLifecycle.rebuildResourcePlan();
    this.engineLifecycle.initializeStateMachine();
  }

  // ─── 委托方法 ────────────────────────────────────

  async start(): Promise<void> {
    return this.engineLifecycle.start();
  }

  async stop(): Promise<void> {
    return this.engineLifecycle.stop();
  }

  async destroy(): Promise<void> {
    logger.info('Destroying...');
    try {
      await this.audioSidecar.stop('engine-destroy');
    } catch (err) {
      logger.warn('audio sidecar stop during destroy failed', err);
    }
    await this.stop();
    this.squelchStatusMonitor.stop();
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
    return this.transmissionPipeline.forceStopTransmission();
  }

  public async removeOperatorFromTransmission(operatorId: string): Promise<void> {
    return this.transmissionPipeline.removeOperatorFromTransmission(operatorId);
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

      // Normal digital mode switch (FT8 <-> FT4)
      if (this.currentMode.name === digitalMode.name) {
        logger.info(`Already in mode: ${digitalMode.name}`);
        this.emitStatusSnapshot();
        return;
      }

      logger.info(`Switching mode: ${this.currentMode.name} -> ${digitalMode.name}`);
      this.currentMode = digitalMode;
      this.applyDecodeWindowOverrides();

      if (this.slotClock) {
        this.slotClock.setMode(this.currentMode);
      }

      this.slotPackManager.setMode(this.currentMode);
      this.clockCoordinator?.onModeChanged(this.currentMode);
      // 同步 operator.config.mode，避免下游读到陈旧 slotMs（例如 standard-qso 的 retryWindowMs、
      // PluginContextFactory 暴露给插件的 ctx.operator.mode）
      for (const op of this._operatorManager?.getAllOperators() ?? []) {
        op.setMode(this.currentMode);
      }

      await ConfigManager.getInstance().setLastDigitalModeName(digitalMode.name);
      this.emitModeAndStatusSnapshot();
    };

    const queuedSwitch = this.modeSwitchTail.then(runSwitch, runSwitch);
    this.modeSwitchTail = queuedSwitch.catch(() => undefined);
    await queuedSwitch;
  }

  private async switchEngineMode(targetEngineMode: EngineMode, targetMode: ModeDescriptor): Promise<void> {
    let engineState = this.engineLifecycle?.getEngineState() ?? EngineState.IDLE;
    let shouldResumeAfterSwitch = engineState === EngineState.RUNNING || engineState === EngineState.STARTING;
    logger.info(`Switching engine mode: ${this.engineMode}/${this.currentMode.name} -> ${targetEngineMode}/${targetMode.name}`);

    if (this.engineMode === 'voice' && targetEngineMode !== 'voice') {
      await this.voiceKeyerManager?.stopActive('leaving voice mode');
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
      // Prevent RadioBridge from auto-restarting engine after reconnect
      this.radioBridge.wasRunningBeforeDisconnect = false;
      await this.stop();
    }

    this.engineMode = targetEngineMode;
    this.currentMode = targetMode;
    if (targetEngineMode === 'digital') {
      this.applyDecodeWindowOverrides();
    }

    if (this.slotClock) {
      this.slotClock.setMode(this.currentMode);
    }

    this.slotPackManager.setMode(this.currentMode);
    this.clockCoordinator?.onModeChanged(this.currentMode);
    // 同步 operator.config.mode —— 与数字模式内 setMode 同款的理由
    for (const op of this._operatorManager?.getAllOperators() ?? []) {
      op.setMode(this.currentMode);
    }
    this.engineLifecycle.rebuildResourcePlan();

    const configManager = ConfigManager.getInstance();
    await configManager.setLastEngineMode(targetEngineMode);
    if (targetEngineMode === 'digital') {
      await configManager.setLastDigitalModeName(targetMode.name);
    }

    this.emitModeAndStatusSnapshot();

    this.resetVoicePttState();
    this.squelchStatusMonitor.reevaluate();
    this.physicalPttMonitor.reevaluate();

    if (shouldResumeAfterSwitch) {
      await this.engineLifecycle.startAndWaitForRunning();
      this.emitStatusSnapshot();
    }

    logger.info(`Engine mode switched to ${targetEngineMode}/${targetMode.name}`);
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
    if (this.slotClock) {
      this.slotClock.setMode(this.currentMode);
    }
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
    // Voice mode has no slotClock, so isDecoding = isRunning
    const isActuallyDecoding = this.engineMode === 'voice'
      ? isRunning
      : isRunning && (this.slotClock?.isRunning ?? false);

    const engineState = this.engineLifecycle?.getEngineState() ?? 'idle';
    const engineContext = this.engineLifecycle?.getEngineContext() ?? null;

    return {
      isRunning,
      isDecoding: isActuallyDecoding,
      currentMode: this.currentMode,
      engineMode: this.engineMode,
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
