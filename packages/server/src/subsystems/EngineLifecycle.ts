import type { EventEmitter } from 'eventemitter3';
import type { DigitalRadioEngineEvents, ModeDescriptor } from '@tx5dr/contracts';
import type { SlotClock, SlotScheduler, ClockSourceSystem } from '@tx5dr/core';
import type { AudioStreamManager } from '../audio/AudioStreamManager.js';
import type { AudioMixer } from '../audio/AudioMixer.js';
import type { PhysicalRadioManager } from '../radio/PhysicalRadioManager.js';
import type { SpectrumScheduler } from '../audio/SpectrumScheduler.js';
import type { RadioOperatorManager } from '../operator/RadioOperatorManager.js';
import type { VoiceSessionManager } from '../voice/VoiceSessionManager.js';
import { ConfigManager } from '../config/config-manager.js';
import { ResourceManager, type SimplifiedResourceConfig } from '../utils/ResourceManager.js';
import { IcomWlanAudioAdapter } from '../audio/IcomWlanAudioAdapter.js';
import { OpenWebRXAudioAdapter } from '../openwebrx/OpenWebRXAudioAdapter.js';
import { AudioDeviceManager } from '../audio/audio-device-manager.js';
import { AudioMonitorService } from '../audio/AudioMonitorService.js';
import { createEngineActor, isEngineState, getEngineContext, type EngineActor } from '../state-machines/engineStateMachine.js';
import { EngineState, type EngineInput } from '../state-machines/types.js';
import type { TransmissionPipeline } from './TransmissionPipeline.js';
import type { ClockCoordinator } from './ClockCoordinator.js';
import { RadioError } from '../utils/errors/RadioError.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('EngineLifecycle');

export interface EngineLifecycleDeps {
  engineEmitter: EventEmitter<DigitalRadioEngineEvents>;
  resourceManager: ResourceManager;
  slotClock: SlotClock;
  slotScheduler: SlotScheduler;
  audioStreamManager: AudioStreamManager;
  radioManager: PhysicalRadioManager;
  spectrumScheduler: SpectrumScheduler;
  operatorManager: RadioOperatorManager;
  audioMixer: AudioMixer;
  clockSource: ClockSourceSystem;
  subsystems: {
    transmissionPipeline: TransmissionPipeline;
    clockCoordinator: ClockCoordinator;
  };
  getCurrentMode: () => ModeDescriptor;
  getVoiceSessionManager: () => VoiceSessionManager | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getStatus: () => any;
}

/**
 * 引擎生命周期管理子系统
 *
 * 负责：
 * - 维护资源蓝图与启动/停止顺序
 * - 驱动引擎状态机与资源回滚
 * - 暴露运行态查询
 *
 * 不负责：
 * - 电台连接后的 bootstrap 细节
 * - WebSocket/UI 事件投影
 * - 连接成功后的频率/能力初始化
 */
export class EngineLifecycle {
  private isRunning = false;
  private audioStarted = false;

  // ICOM WLAN 音频适配器
  private icomWlanAudioAdapter: IcomWlanAudioAdapter | null = null;

  // OpenWebRX 音频适配器
  private openwebrxAudioAdapter: OpenWebRXAudioAdapter | null = null;

  // 音频监听服务
  private audioMonitorService: AudioMonitorService | null = null;

  // 语音会话管理器
  private voiceSessionManager: VoiceSessionManager | null = null;

  // 引擎状态机 (XState v5)
  private engineStateMachineActor: EngineActor | null = null;

  constructor(private deps: EngineLifecycleDeps) {}

  setVoiceSessionManager(manager: VoiceSessionManager | null): void {
    this.voiceSessionManager = manager;
  }

  getIsRunning(): boolean {
    return this.isRunning;
  }

  getIsAudioStarted(): boolean {
    return this.audioStarted;
  }

  getIsPTTActive(): boolean {
    return this.deps.subsystems.transmissionPipeline.getIsPTTActive();
  }

  getAudioMonitorService(): AudioMonitorService | null {
    return this.audioMonitorService;
  }

  getOpenWebRXAudioAdapter(): OpenWebRXAudioAdapter | null {
    return this.openwebrxAudioAdapter;
  }

  getEngineState(): EngineState {
    return this.engineStateMachineActor
      ? (this.engineStateMachineActor.getSnapshot().value as EngineState)
      : EngineState.IDLE;
  }

  getEngineContext(): { error?: string; startedResources?: string[]; forcedStop?: boolean } | null {
    if (!this.engineStateMachineActor) return null;
    const ctx = getEngineContext(this.engineStateMachineActor);
    return {
      error: ctx.error?.message,
      startedResources: ctx.startedResources,
      forcedStop: ctx.forcedStop,
    };
  }

  /**
   * 注册所有资源到 ResourceManager
   */
  registerResources(): void {
    this.rebuildResourcePlan();
  }

  rebuildResourcePlan(): void {
    logger.info('Rebuilding engine resource plan...');

    const resources = this.buildResourcePlan();
    const { resourceManager } = this.deps;

    resourceManager.clear();
    for (const resource of resources) {
      resourceManager.register(resource);
    }

    logger.info(`Engine resource plan ready (${resources.length} resources)`);
  }

  private buildResourcePlan(): SimplifiedResourceConfig[] {
    const configManager = ConfigManager.getInstance();
    const mode = this.deps.getCurrentMode();
    const resources = [
      ...this.buildCoreResourcePlan(configManager),
      ...(mode.name === 'VOICE'
        ? this.buildVoiceModeResourcePlan()
        : this.buildDigitalModeResourcePlan()),
    ];

    logger.info(`Built ${mode.name === 'VOICE' ? 'voice' : 'digital'} resource plan`);
    return resources;
  }

  private buildCoreResourcePlan(configManager: ConfigManager): SimplifiedResourceConfig[] {
    const { radioManager, audioStreamManager } = this.deps;

    return [
      {
        name: 'radio',
        start: async () => {
          const radioConfig = configManager.getRadioConfig();
          if (radioConfig.type === 'icom-wlan') {
            if (!radioConfig.icomWlan?.ip || !radioConfig.icomWlan?.port) {
              logger.error('ICOM WLAN config incomplete:', radioConfig.icomWlan);
              throw new Error('ICOM WLAN IP or port missing');
            }
            logger.debug(`ICOM WLAN config validated: IP=${radioConfig.icomWlan.ip}, Port=${radioConfig.icomWlan.port}`);
          }
          logger.debug('Applying radio config:', radioConfig);
          await radioManager.applyConfig(radioConfig);
        },
        stop: async () => {
          if (radioManager.isConnected()) {
            await radioManager.disconnect('Engine stopped');
          }
        },
        priority: 1,
        optional: false,
      },
      {
        name: 'icomWlanAudioAdapter',
        start: async () => {
          const radioConfig = configManager.getRadioConfig();
          if (radioConfig.type !== 'icom-wlan') {
            logger.debug('Not ICOM WLAN mode, skipping adapter init');
            return;
          }
          logger.debug('Initializing ICOM WLAN audio adapter');
          const icomWlanManager = radioManager.getIcomWlanManager();
          if (!icomWlanManager || !icomWlanManager.isConnected()) {
            logger.warn('ICOM WLAN radio not connected, falling back to normal audio input');
            return;
          }
          this.icomWlanAudioAdapter = new IcomWlanAudioAdapter(icomWlanManager);
          audioStreamManager.setIcomWlanAudioAdapter(this.icomWlanAudioAdapter);
          const audioDeviceManager = AudioDeviceManager.getInstance();
          audioDeviceManager.setIcomWlanConnectedCallback(() => icomWlanManager.isConnected());
          logger.debug('ICOM WLAN audio adapter initialized');
        },
        stop: async () => {
          if (this.icomWlanAudioAdapter) {
            this.icomWlanAudioAdapter.stopReceiving();
            audioStreamManager.setIcomWlanAudioAdapter(null);
            this.icomWlanAudioAdapter = null;
            logger.debug('ICOM WLAN audio adapter cleaned up');
          }
        },
        priority: 2,
        dependencies: [],
        optional: true,
      },
      {
        name: 'openwebrxAudioAdapter',
        start: async () => {
          const audioConfig = configManager.getAudioConfig();
          if (!audioConfig.inputDeviceName?.startsWith('[SDR]')) {
            logger.debug('Not OpenWebRX input mode, skipping adapter init');
            return;
          }
          logger.debug('Initializing OpenWebRX audio adapter');
          const stationName = audioConfig.inputDeviceName.replace(/^\[SDR\]\s*/, '');
          const stations = configManager.getOpenWebRXStations();
          const station = stations.find(s => s.name === stationName);
          if (!station) {
            logger.warn('OpenWebRX station not found for device', { deviceName: audioConfig.inputDeviceName });
            return;
          }
          this.openwebrxAudioAdapter = new OpenWebRXAudioAdapter(station);
          try {
            await this.openwebrxAudioAdapter.connect();
            const lastFreq = configManager.getLastSelectedFrequency();
            if (lastFreq?.frequency) {
              await this.openwebrxAudioAdapter.setTargetFrequency(lastFreq.frequency);
            }
            audioStreamManager.setOpenWebRXAudioAdapter(this.openwebrxAudioAdapter);

            this.openwebrxAudioAdapter.on('profileSelectRequired', (data) => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              this.deps.engineEmitter.emit('openwebrxProfileSelectRequest' as any, data);
            });

            this.openwebrxAudioAdapter.on('connected', () => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              this.deps.engineEmitter.emit('openwebrxConnectionChanged' as any, { connected: true });
            });

            this.openwebrxAudioAdapter.on('disconnected', () => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              this.deps.engineEmitter.emit('openwebrxConnectionChanged' as any, { connected: false });
            });

            this.openwebrxAudioAdapter.on('profileChanged', (profileId: string) => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              this.deps.engineEmitter.emit('openwebrxProfileChanged' as any, { profileId });
            });

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            this.deps.engineEmitter.emit('openwebrxConnectionChanged' as any, { connected: true });

            this.openwebrxAudioAdapter.on('error', (err: Error) => {
              this.deps.engineEmitter.emit('radioError', {
                message: err.message,
                userMessage: err.message,
                code: 'OPENWEBRX_ERROR',
                severity: 'error' as const,
                suggestions: [] as string[],
                timestamp: new Date().toISOString(),
                profileId: null,
                profileName: null,
              });
            });

            this.openwebrxAudioAdapter.on('clientCountChanged', (count: number) => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              this.deps.engineEmitter.emit('openwebrxClientCount' as any, { count });
            });

            this.openwebrxAudioAdapter.on('cooldownWait', (data) => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              this.deps.engineEmitter.emit('openwebrxCooldownNotice' as any, data);
            });

            this.deps.engineEmitter.on('frequencyChanged', (data: { frequency: number }) => {
              if (this.openwebrxAudioAdapter?.isConnected()) {
                this.openwebrxAudioAdapter.setTargetFrequency(data.frequency).catch(err => {
                  if (err?.name === 'ProfileSwitchCancelledError') {
                    logger.debug('OpenWebRX profile switch cancelled by newer request');
                  } else {
                    logger.error('Failed to sync OpenWebRX frequency', err);
                  }
                });
              }
            });

            logger.debug('OpenWebRX audio adapter initialized');
          } catch (error) {
            logger.error('Failed to connect OpenWebRX adapter', error);
            this.openwebrxAudioAdapter = null;
            throw error;
          }
        },
        stop: async () => {
          if (this.openwebrxAudioAdapter) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            this.deps.engineEmitter.emit('openwebrxConnectionChanged' as any, { connected: false });
            this.openwebrxAudioAdapter.stopReceiving();
            this.openwebrxAudioAdapter.disconnect();
            audioStreamManager.setOpenWebRXAudioAdapter(null);
            this.openwebrxAudioAdapter = null;
            logger.debug('OpenWebRX audio adapter cleaned up');
          }
        },
        priority: 2,
        dependencies: [],
        optional: true,
      },
      {
        name: 'audioInputStream',
        start: async () => {
          await audioStreamManager.startStream();
          logger.debug('Audio input stream started');
        },
        stop: async () => {
          await audioStreamManager.stopStream();
          logger.debug('Audio input stream stopped');
        },
        priority: 3,
        dependencies: [],
        optional: false,
      },
      {
        name: 'audioOutputStream',
        start: async () => {
          await audioStreamManager.startOutput();
          logger.debug('Audio output stream started');
          const lastVolumeGain = configManager.getLastVolumeGain();
          if (lastVolumeGain) {
            logger.debug(`Restoring last volume gain: ${lastVolumeGain.gainDb.toFixed(1)}dB`);
            audioStreamManager.setVolumeGainDb(lastVolumeGain.gainDb);
          } else {
            logger.debug('Using default volume gain: 0.0dB');
          }
        },
        stop: async () => {
          await audioStreamManager.stopOutput();
          logger.debug('Audio output stream stopped');
        },
        priority: 4,
        dependencies: ['audioInputStream'],
        optional: false,
      },
      {
        name: 'audioMonitorService',
        start: async () => {
          logger.debug('Initializing audio monitor service...');
          const audioProvider = audioStreamManager.getAudioProvider();
          this.audioMonitorService = new AudioMonitorService(audioProvider);
          logger.debug('Audio monitor service initialized');
        },
        stop: async () => {
          if (this.audioMonitorService) {
            this.audioMonitorService.destroy();
            this.audioMonitorService = null;
            logger.debug('Audio monitor service cleaned up');
          }
        },
        priority: 5,
        dependencies: ['audioInputStream'],
        optional: false,
      },
    ];
  }

  private buildVoiceModeResourcePlan(): SimplifiedResourceConfig[] {
    const { spectrumScheduler } = this.deps;
    const resources: SimplifiedResourceConfig[] = [
      {
        name: 'spectrumScheduler',
        start: async () => {
          if (spectrumScheduler) {
            spectrumScheduler.start();
            logger.debug('Spectrum scheduler started (voice mode)');
          }
        },
        stop: async () => {
          if (spectrumScheduler) {
            spectrumScheduler.stop();
            logger.debug('Spectrum scheduler stopped (voice mode)');
          }
        },
        priority: 6,
        dependencies: ['audioInputStream'],
        optional: false,
      },
    ];

    const voiceSessionManager = this.deps.getVoiceSessionManager();
    if (voiceSessionManager) {
      resources.push({
        name: 'voiceSessionManager',
        start: async () => {
          await voiceSessionManager.start();
          logger.debug('Voice session manager started');
        },
        stop: async () => {
          await voiceSessionManager.stop();
          logger.debug('Voice session manager stopped');
        },
        priority: 7,
        dependencies: ['audioOutputStream', 'audioMonitorService'],
        optional: false,
      });
    }

    return resources;
  }

  private buildDigitalModeResourcePlan(): SimplifiedResourceConfig[] {
    const { slotClock, slotScheduler, spectrumScheduler, operatorManager } = this.deps;

    return [
      {
        name: 'clock',
        start: async () => {
          if (!slotClock) {
            throw new Error('Clock not initialized');
          }
          slotClock.start();
          logger.debug('Clock started');
        },
        stop: async () => {
          if (slotClock) {
            slotClock.stop();
            await this.deps.subsystems.transmissionPipeline.forceStopPTT();
            logger.debug('Clock stopped');
          }
        },
        priority: 6,
        dependencies: ['audioOutputStream'],
        optional: false,
      },
      {
        name: 'slotScheduler',
        start: async () => {
          if (slotScheduler) {
            slotScheduler.start();
            logger.debug('Slot scheduler started');
          }
        },
        stop: async () => {
          if (slotScheduler) {
            slotScheduler.stop();
            logger.debug('Slot scheduler stopped');
          }
        },
        priority: 7,
        dependencies: ['clock'],
        optional: false,
      },
      {
        name: 'spectrumScheduler',
        start: async () => {
          if (spectrumScheduler) {
            spectrumScheduler.start();
            logger.debug('Spectrum scheduler started');
          }
        },
        stop: async () => {
          if (spectrumScheduler) {
            spectrumScheduler.stop();
            logger.debug('Spectrum scheduler stopped');
          }
        },
        priority: 8,
        dependencies: ['clock'],
        optional: false,
      },
      {
        name: 'operatorManager',
        start: async () => {
          operatorManager.start();
          logger.debug('Operator manager started');
        },
        stop: async () => {
          operatorManager.stop();
          logger.debug('Operator manager stopped');
        },
        priority: 9,
        dependencies: ['clock'],
        optional: false,
      },
    ];
  }

  /**
   * 初始化引擎状态机
   */
  initializeStateMachine(): void {
    logger.info('Initializing engine state machine...');

    const engineInput: EngineInput = {
      onStart: async () => {
        logger.info('Executing start operation');
        await this.doStart();
      },
      onStop: async () => {
        logger.info('Executing stop operation');
        await this.doStop();
      },
      onError: (error) => {
        logger.error('State machine error:', error);
        // Broadcast engine error to frontend via radioError channel
        try {
          const radioError = error instanceof RadioError ? error : RadioError.from(error);
          const activeProfile = ConfigManager.getInstance().getActiveProfile();
          this.deps.engineEmitter.emit('radioError', {
            message: radioError.message,
            userMessage: radioError.userMessage,
            code: radioError.code,
            severity: radioError.severity,
            suggestions: radioError.suggestions,
            timestamp: new Date().toISOString(),
            profileId: activeProfile?.id ?? null,
            profileName: activeProfile?.name ?? null,
          });
        } catch (emitError) {
          logger.error('Failed to emit radioError event:', emitError);
        }
      },
      onStateChange: (_state, context) => {
        logger.info(`State changed: ${_state}`, {
          error: context.error?.message,
          forcedStop: context.forcedStop,
          startedResources: context.startedResources,
        });
        const status = this.deps.getStatus();
        this.deps.engineEmitter.emit('systemStatus', status);
      },
    };

    this.engineStateMachineActor = createEngineActor(engineInput, {
      devTools: process.env.NODE_ENV === 'development',
    });
    this.engineStateMachineActor.start();

    logger.info('Engine state machine initialized');
  }

  /**
   * 启动引擎（外部 API，委托给状态机）
   */
  async start(): Promise<void> {
    if (!this.engineStateMachineActor) {
      throw new Error('Engine state machine not initialized');
    }

    if (isEngineState(this.engineStateMachineActor, EngineState.RUNNING)) {
      logger.info('Engine already running, sending status sync');
      const status = this.deps.getStatus();
      this.deps.engineEmitter.emit('systemStatus', status);
      return;
    }

    if (isEngineState(this.engineStateMachineActor, EngineState.STARTING)) {
      logger.info('Engine already starting, ignoring duplicate start request');
      return;
    }

    logger.info('Delegating to state machine: START');
    this.engineStateMachineActor.send({ type: 'START' });
  }

  /**
   * 停止引擎（外部 API，委托给状态机）
   */
  async stop(): Promise<void> {
    if (!this.engineStateMachineActor) {
      throw new Error('Engine state machine not initialized');
    }

    if (isEngineState(this.engineStateMachineActor, EngineState.IDLE)) {
      logger.info('Engine already stopped, sending status sync');
      const status = this.deps.getStatus();
      this.deps.engineEmitter.emit('systemStatus', status);
      return;
    }

    if (isEngineState(this.engineStateMachineActor, EngineState.STOPPING)) {
      logger.info('Engine already stopping, waiting for completion...');
      try {
        const { waitForEngineState } = await import('../state-machines/engineStateMachine.js');
        await waitForEngineState(this.engineStateMachineActor, EngineState.IDLE, 10000);
        logger.info('Stop completed');
      } catch (error) {
        logger.error('Waiting for stop timed out:', error);
        throw error;
      }
      return;
    }

    logger.info('Delegating to state machine: STOP');
    this.engineStateMachineActor.send({ type: 'STOP' });

    // Wait for engine to reach IDLE state after sending STOP
    try {
      const { waitForEngineState } = await import('../state-machines/engineStateMachine.js');
      await waitForEngineState(this.engineStateMachineActor, EngineState.IDLE, 15000);
      logger.info('Stop completed');
    } catch (error) {
      logger.error('Waiting for stop timed out:', error);
      throw error;
    }
  }

  /**
   * 发送 RADIO_DISCONNECTED 事件到状态机
   */
  sendRadioDisconnected(reason: string): void {
    if (this.engineStateMachineActor && isEngineState(this.engineStateMachineActor, EngineState.RUNNING)) {
      logger.info('Sending RADIO_DISCONNECTED event');
      this.engineStateMachineActor.send({
        type: 'RADIO_DISCONNECTED',
        reason
      });
    }
  }

  /**
   * 停止并清理状态机
   */
  destroyStateMachine(): void {
    if (this.engineStateMachineActor) {
      logger.info('Stopping engine state machine...');
      this.engineStateMachineActor.stop();
      this.engineStateMachineActor = null;
      logger.info('Engine state machine stopped');
    }
  }

  // ─── 内部方法 ────────────────────────────────────

  private async doStart(): Promise<void> {
    if (!this.deps.slotClock) {
      throw new Error('Clock manager not initialized');
    }

    const mode = this.deps.getCurrentMode();
    logger.info(`Starting engine, mode: ${mode.name}`);

    try {
      // 1. 注册时钟/解码/频谱事件
      this.deps.subsystems.clockCoordinator.setup();

      // 2. 注册编码/混音事件
      this.deps.subsystems.transmissionPipeline.setup();

      // 3. 按优先级启动资源
      await this.deps.resourceManager.startAll();

      // 4. 设置状态标志
      this.isRunning = true;
      this.audioStarted = true;

      logger.info('Engine started successfully');
    } catch (error) {
      logger.error('Engine start failed:', error);
      // Clean up event listeners registered by setup() that won't be cleaned by rollback
      this.deps.subsystems.transmissionPipeline.teardown();
      this.deps.subsystems.clockCoordinator.teardown();
      throw error;
    }
  }

  private async doStop(): Promise<void> {
    logger.info('Stopping engine');

    try {
      // 1. 清除编码/混音监听器 + PTT 定时器
      this.deps.subsystems.transmissionPipeline.teardown();

      // 2. 清除时钟/解码/频谱监听器
      this.deps.subsystems.clockCoordinator.teardown();

      // 3. 按逆序停止资源
      await this.deps.resourceManager.stopAll();

      // 4. 清除状态标志
      this.isRunning = false;
      this.audioStarted = false;

      logger.info('Engine stopped successfully');
    } catch (error) {
      logger.error('Engine stop failed:', error);
      this.isRunning = false;
      this.audioStarted = false;
      throw error;
    }
  }
}
