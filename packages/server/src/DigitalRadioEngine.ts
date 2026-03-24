import {
  SlotClock,
  SlotScheduler,
  ClockSourceSystem
} from '@tx5dr/core';
import { MODES, type ModeDescriptor, type SlotPack, type DigitalRadioEngineEvents, type EngineMode, resolveWindowTiming } from '@tx5dr/contracts';
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
import { AudioMonitorService } from './audio/AudioMonitorService.js';
import { MemoryLeakDetector } from './utils/MemoryLeakDetector.js';
import { ResourceManager } from './utils/ResourceManager.js';
import { initializePSKReporterService } from './services/PSKReporterService.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger('DigitalRadioEngine');

// 子系统
import { AudioVolumeController } from './subsystems/AudioVolumeController.js';
import { RadioBridge } from './subsystems/RadioBridge.js';
import { TransmissionPipeline } from './subsystems/TransmissionPipeline.js';
import { ClockCoordinator } from './subsystems/ClockCoordinator.js';
import { EngineLifecycle } from './subsystems/EngineLifecycle.js';
import { VoiceSessionManager } from './voice/VoiceSessionManager.js';

/**
 * DigitalRadioEngine — 数字电台引擎 Facade
 *
 * 所有领域逻辑已拆分到子系统：
 * - TransmissionPipeline: 发射管线 (encode→mix→PTT→play)
 * - RadioBridge: 电台事件桥接
 * - ClockCoordinator: 时钟/解码/频谱事件协调
 * - AudioVolumeController: 音量控制
 * - EngineLifecycle: 资源注册 + XState 状态机 + start/stop
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

  // 子系统
  private audioVolumeController: AudioVolumeController;
  private radioBridge: RadioBridge;
  private transmissionPipeline: TransmissionPipeline;
  private clockCoordinator!: ClockCoordinator;  // 在 initialize() 中初始化
  private engineLifecycle!: EngineLifecycle;     // 在构造函数末尾初始化

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
    this.audioStreamManager = new AudioStreamManager();
    this.realDecodeQueue = new WSJTXDecodeWorkQueue(1);
    this.realEncodeQueue = new WSJTXEncodeWorkQueue(1);
    this.slotPackManager = new SlotPackManager();
    this.audioMixer = new AudioMixer(100);
    this.radioManager = new PhysicalRadioManager();
    this.frequencyManager = new FrequencyManager(ConfigManager.getInstance().getCustomFrequencyPresets());
    this.transmissionTracker = new TransmissionTracker();
    this.resourceManager = new ResourceManager();

    // 注册内存泄漏检测
    MemoryLeakDetector.getInstance().register('DigitalRadioEngine', this);

    // 初始化操作员管理器
    this._operatorManager = new RadioOperatorManager({
      eventEmitter: this,
      encodeQueue: this.realEncodeQueue,
      clockSource: this.clockSource,
      getCurrentMode: () => this.currentMode,
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
      transmissionTracker: this.transmissionTracker
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

    this.audioVolumeController = new AudioVolumeController(this, this.audioStreamManager);

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
    });

    this.radioBridge = new RadioBridge({
      engineEmitter: this,
      radioManager: this.radioManager,
      frequencyManager: this.frequencyManager,
      slotPackManager: this.slotPackManager,
      operatorManager: this._operatorManager,
      getTransmissionPipeline: () => this.transmissionPipeline,
      getEngineLifecycle: () => this.engineLifecycle,
    });
    this.radioBridge.setupListeners();

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

  public getSlotPackManager(): SlotPackManager {
    return this.slotPackManager;
  }

  public getRadioManager(): PhysicalRadioManager {
    return this.radioManager;
  }

  public getAudioMonitorService(): AudioMonitorService | null {
    return this.engineLifecycle.getAudioMonitorService();
  }

  public getEngineMode(): EngineMode {
    return this.engineMode;
  }

  public getVoiceSessionManager(): VoiceSessionManager | null {
    return this.voiceSessionManager;
  }

  // ─── 初始化 ──────────────────────────────────────

  async initialize(): Promise<void> {
    logger.info('Initializing...');

    await printAppPaths();

    // 从配置读取发射补偿值
    const radioConfig = ConfigManager.getInstance().getRadioConfig();
    const compensationMs = radioConfig.transmitCompensationMs || 0;
    logger.info(`Transmit compensation config: ${compensationMs}ms`);

    // 应用解码窗口覆盖配置
    this.applyDecodeWindowOverrides();

    // 创建 SlotClock
    this.slotClock = new SlotClock(this.clockSource, this.currentMode, compensationMs);

    // 创建 SlotScheduler
    this.slotScheduler = new SlotScheduler(
      this.slotClock,
      this.realDecodeQueue,
      this.audioStreamManager.getAudioProvider(),
      this._operatorManager,
      () => ConfigManager.getInstance().getFT8Config().decodeWhileTransmitting ?? false
    );

    // 初始化频谱调度器
    await this.spectrumScheduler.initialize(
      this.audioStreamManager.getAudioProvider(),
      this.audioStreamManager.getInternalSampleRate()
    );
    this.spectrumScheduler.setPTTActive(false);

    // 初始化操作员管理器
    await this.operatorManager.initialize();

    // 初始化 PSKReporter 服务
    let pskreporterService = null;
    try {
      pskreporterService = await initializePSKReporterService();
      pskreporterService.setMode(this.currentMode.name);
      logger.info('PSKReporter service initialized');
    } catch (error) {
      logger.warn('PSKReporter service initialization failed:', error);
    }

    // 初始化 ClockCoordinator（需要 slotClock）
    this.clockCoordinator = new ClockCoordinator({
      engineEmitter: this,
      slotClock: this.slotClock,
      decodeQueue: this.realDecodeQueue,
      slotPackManager: this.slotPackManager,
      spectrumScheduler: this.spectrumScheduler,
      operatorManager: this._operatorManager,
      getTransmissionPipeline: () => this.transmissionPipeline,
      getRadioBridge: () => this.radioBridge,
      getCurrentMode: () => this.currentMode,
    });
    this.clockCoordinator.setPSKReporterService(pskreporterService);

    // 初始化 VoiceSessionManager
    this.voiceSessionManager = new VoiceSessionManager({
      radioManager: this.radioManager,
      audioStreamManager: this.audioStreamManager,
    });
    await this.voiceSessionManager.initialize();

    // Forward voice events through engine emitter
    this.voiceSessionManager.on('voicePttLockChanged', (lock) => {
      this.emit('voicePttLockChanged', lock);
    });
    this.voiceSessionManager.on('pttStatusChanged', (data) => {
      this.emit('pttStatusChanged', data);
    });
    this.voiceSessionManager.on('voiceRadioModeChanged', (data) => {
      this.emit('voiceRadioModeChanged', data);
    });

    // 初始化 EngineLifecycle（需要 slotClock 和子系统）
    this.engineLifecycle = new EngineLifecycle({
      engineEmitter: this,
      resourceManager: this.resourceManager,
      slotClock: this.slotClock,
      slotScheduler: this.slotScheduler,
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
      getStatus: () => this.getStatus(),
    });

    // Pass voice session manager to engine lifecycle
    this.engineLifecycle.setVoiceSessionManager(this.voiceSessionManager);

    // Restore last engine mode and digital sub-mode from config
    const configManager = ConfigManager.getInstance();
    const lastEngineMode = configManager.getLastEngineMode();
    const lastDigitalModeName = configManager.getLastDigitalModeName();

    // Restore digital sub-mode (FT8/FT4) before registering resources
    if (lastDigitalModeName && lastDigitalModeName !== this.currentMode.name) {
      const targetMode = Object.values(MODES).find(m => m.name === lastDigitalModeName);
      if (targetMode && targetMode.name !== 'VOICE') {
        this.currentMode = targetMode;
        this.applyDecodeWindowOverrides();
        if (this.slotClock) {
          this.slotClock.setMode(this.currentMode);
        }
        this.slotPackManager.setMode(this.currentMode);
        logger.info(`Restored last digital mode: ${this.currentMode.name}`);
      }
    }

    // If last mode was voice, switch engine mode (resources will be registered for voice)
    if (lastEngineMode === 'voice') {
      this.engineMode = 'voice';
      this.currentMode = MODES.VOICE;
      logger.info('Restored last engine mode: voice');
    }

    // 注册资源和状态机（based on restored mode）
    this.engineLifecycle.registerResources();
    this.engineLifecycle.initializeStateMachine();

    logger.info(`Initialization complete, current mode: ${this.currentMode.name}, engine mode: ${this.engineMode}`);
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
    await this.stop();

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
    // Handle voice mode (string 'VOICE')
    if (mode === 'VOICE' || (typeof mode === 'object' && mode.name === 'VOICE')) {
      if (this.engineMode === 'voice') {
        logger.info('Already in voice mode');
        return;
      }
      await this.switchToVoiceMode();
      return;
    }

    // Handle digital mode (ModeDescriptor)
    const digitalMode = mode as ModeDescriptor;

    // If switching from voice to digital
    if (this.engineMode === 'voice') {
      await this.switchToDigitalMode(digitalMode);
      return;
    }

    // Normal digital mode switch (FT8 <-> FT4)
    if (this.currentMode.name === digitalMode.name) {
      logger.info(`Already in mode: ${digitalMode.name}`);
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

    // Persist digital sub-mode
    ConfigManager.getInstance().setLastDigitalModeName(digitalMode.name);

    this.emit('modeChanged', this.currentMode);
  }

  private async switchToVoiceMode(): Promise<void> {
    logger.info('Switching to voice mode');

    // Stop engine if running
    const wasRunning = this.engineLifecycle?.getIsRunning() ?? false;
    if (wasRunning) {
      // Prevent RadioBridge from auto-restarting engine after reconnect
      this.radioBridge.wasRunningBeforeDisconnect = false;
      await this.stop();
    }

    // Clear and re-register resources for voice mode
    this.resourceManager.clear();
    this.engineMode = 'voice';
    this.currentMode = MODES.VOICE;
    this.engineLifecycle.registerResources();

    // Persist engine mode
    ConfigManager.getInstance().setLastEngineMode('voice');

    this.emit('modeChanged', this.currentMode);
    logger.info('Switched to voice mode');

    // Restart engine if it was running
    if (wasRunning) {
      await this.start();
    }
  }

  private async switchToDigitalMode(mode?: ModeDescriptor): Promise<void> {
    const targetMode = mode ?? MODES.FT8;
    logger.info(`Switching to digital mode: ${targetMode.name}`);

    // Stop engine if running
    const wasRunning = this.engineLifecycle?.getIsRunning() ?? false;
    if (wasRunning) {
      // Prevent RadioBridge from auto-restarting engine after reconnect
      this.radioBridge.wasRunningBeforeDisconnect = false;
      await this.stop();
    }

    // Clear and re-register resources for digital mode
    this.resourceManager.clear();
    this.engineMode = 'digital';
    this.currentMode = targetMode;
    this.applyDecodeWindowOverrides();
    this.engineLifecycle.registerResources();

    if (this.slotClock) {
      this.slotClock.setMode(this.currentMode);
    }

    this.slotPackManager.setMode(this.currentMode);
    this.clockCoordinator?.onModeChanged(this.currentMode);

    // Persist engine mode and digital sub-mode
    const cfgMgr = ConfigManager.getInstance();
    cfgMgr.setLastEngineMode('digital');
    cfgMgr.setLastDigitalModeName(targetMode.name);

    this.emit('modeChanged', this.currentMode);
    logger.info(`Switched to digital mode: ${targetMode.name}`);

    // Restart engine if it was running
    if (wasRunning) {
      await this.start();
    }
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
