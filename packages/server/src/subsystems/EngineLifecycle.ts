import type { EventEmitter } from 'eventemitter3';
import type { DigitalRadioEngineEvents, ModeDescriptor } from '@tx5dr/contracts';
import type { SlotClock, SlotScheduler, ClockSourceSystem } from '@tx5dr/core';
import type { AudioStreamManager } from '../audio/AudioStreamManager.js';
import type { AudioMixer } from '../audio/AudioMixer.js';
import type { PhysicalRadioManager } from '../radio/PhysicalRadioManager.js';
import type { SpectrumScheduler } from '../audio/SpectrumScheduler.js';
import type { RadioOperatorManager } from '../operator/RadioOperatorManager.js';
import { ConfigManager } from '../config/config-manager.js';
import { ResourceManager } from '../utils/ResourceManager.js';
import { IcomWlanAudioAdapter } from '../audio/IcomWlanAudioAdapter.js';
import { AudioDeviceManager } from '../audio/audio-device-manager.js';
import { AudioMonitorService } from '../audio/AudioMonitorService.js';
import { createEngineActor, isEngineState, getEngineContext, type EngineActor } from '../state-machines/engineStateMachine.js';
import { EngineState, type EngineInput } from '../state-machines/types.js';
import type { TransmissionPipeline } from './TransmissionPipeline.js';
import type { ClockCoordinator } from './ClockCoordinator.js';

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getStatus: () => any;
}

/**
 * 引擎生命周期管理子系统
 *
 * 职责：资源注册、XState 状态机、doStart/doStop、状态标志
 */
export class EngineLifecycle {
  private isRunning = false;
  private audioStarted = false;

  // ICOM WLAN 音频适配器
  private icomWlanAudioAdapter: IcomWlanAudioAdapter | null = null;

  // 音频监听服务
  private audioMonitorService: AudioMonitorService | null = null;

  // 引擎状态机 (XState v5)
  private engineStateMachineActor: EngineActor | null = null;

  constructor(private deps: EngineLifecycleDeps) {}

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
    console.log('📦 [EngineLifecycle] 注册引擎资源...');

    const { resourceManager, radioManager, audioStreamManager, slotClock, slotScheduler, spectrumScheduler, operatorManager } = this.deps;
    const configManager = ConfigManager.getInstance();

    // 1. 物理电台 (优先级最高)
    // NullConnection 会瞬间成功，非 none 类型如果连接失败则 applyConfig() 会抛异常
    // optional: false 确保连接失败时 ResourceManager 回滚并阻止引擎启动
    resourceManager.register({
      name: 'radio',
      start: async () => {
        const radioConfig = configManager.getRadioConfig();
        if (radioConfig.type === 'icom-wlan') {
          if (!radioConfig.icomWlan?.ip || !radioConfig.icomWlan?.port) {
            console.error('❌ [ResourceManager] ICOM WLAN 配置不完整:', radioConfig.icomWlan);
            throw new Error('ICOM WLAN IP 或端口缺失');
          }
          console.log(`📡 [ResourceManager] ICOM WLAN 配置验证通过: IP=${radioConfig.icomWlan.ip}, Port=${radioConfig.icomWlan.port}`);
        }
        console.log(`📡 [ResourceManager] 应用物理电台配置:`, radioConfig);
        await radioManager.applyConfig(radioConfig);
      },
      stop: async () => {
        if (radioManager.isConnected()) {
          await radioManager.disconnect('引擎停止');
        }
      },
      priority: 1,
      optional: false,
    });

    // 2. ICOM WLAN 音频适配器
    resourceManager.register({
      name: 'icomWlanAudioAdapter',
      start: async () => {
        const radioConfig = configManager.getRadioConfig();
        if (radioConfig.type !== 'icom-wlan') {
          console.log('ℹ️ [ResourceManager] 非 ICOM WLAN 模式，跳过适配器初始化');
          return;
        }
        console.log(`📡 [ResourceManager] 初始化 ICOM WLAN 音频适配器`);
        const icomWlanManager = radioManager.getIcomWlanManager();
        if (!icomWlanManager || !icomWlanManager.isConnected()) {
          console.warn(`⚠️ [ResourceManager] ICOM WLAN 电台未连接，将回退到普通声卡输入`);
          return;
        }
        this.icomWlanAudioAdapter = new IcomWlanAudioAdapter(icomWlanManager);
        audioStreamManager.setIcomWlanAudioAdapter(this.icomWlanAudioAdapter);
        const audioDeviceManager = AudioDeviceManager.getInstance();
        audioDeviceManager.setIcomWlanConnectedCallback(() => {
          return icomWlanManager.isConnected();
        });
        console.log(`✅ [ResourceManager] ICOM WLAN 音频适配器已初始化`);
      },
      stop: async () => {
        if (this.icomWlanAudioAdapter) {
          this.icomWlanAudioAdapter.stopReceiving();
          audioStreamManager.setIcomWlanAudioAdapter(null);
          this.icomWlanAudioAdapter = null;
          console.log(`🛑 [ResourceManager] ICOM WLAN 音频适配器已清理`);
        }
      },
      priority: 2,
      dependencies: [],
      optional: true,
    });

    // 3. 音频输入流
    resourceManager.register({
      name: 'audioInputStream',
      start: async () => {
        await audioStreamManager.startStream();
        console.log(`🎤 [ResourceManager] 音频输入流启动成功`);
      },
      stop: async () => {
        await audioStreamManager.stopStream();
        console.log(`🛑 [ResourceManager] 音频输入流已停止`);
      },
      priority: 3,
      dependencies: [],
      optional: false,
    });

    // 4. 音频输出流
    resourceManager.register({
      name: 'audioOutputStream',
      start: async () => {
        await audioStreamManager.startOutput();
        console.log(`🔊 [ResourceManager] 音频输出流启动成功`);
        const lastVolumeGain = configManager.getLastVolumeGain();
        if (lastVolumeGain) {
          console.log(`🔊 [ResourceManager] 恢复上次音量增益: ${lastVolumeGain.gainDb.toFixed(1)}dB`);
          audioStreamManager.setVolumeGainDb(lastVolumeGain.gainDb);
        } else {
          console.log(`🔊 [ResourceManager] 使用默认音量增益: 0.0dB`);
        }
      },
      stop: async () => {
        await audioStreamManager.stopOutput();
        console.log(`🛑 [ResourceManager] 音频输出流已停止`);
      },
      priority: 4,
      dependencies: ['audioInputStream'],
      optional: false,
    });

    // 5. 音频监听服务
    resourceManager.register({
      name: 'audioMonitorService',
      start: async () => {
        console.log('🎧 [ResourceManager] 初始化音频监听服务...');
        const audioProvider = audioStreamManager.getAudioProvider();
        this.audioMonitorService = new AudioMonitorService(audioProvider);
        console.log('✅ [ResourceManager] 音频监听服务已初始化');
      },
      stop: async () => {
        if (this.audioMonitorService) {
          this.audioMonitorService.destroy();
          this.audioMonitorService = null;
          console.log(`🛑 [ResourceManager] 音频监听服务已清理`);
        }
      },
      priority: 5,
      dependencies: ['audioInputStream'],
      optional: false,
    });

    // 6. 时钟
    resourceManager.register({
      name: 'clock',
      start: async () => {
        if (!slotClock) {
          throw new Error('时钟未初始化');
        }
        slotClock.start();
        console.log(`📡 [ResourceManager] 时钟已启动`);
      },
      stop: async () => {
        if (slotClock) {
          slotClock.stop();
          // 确保PTT被停止
          await this.deps.subsystems.transmissionPipeline.forceStopPTT();
          console.log(`🛑 [ResourceManager] 时钟已停止`);
        }
      },
      priority: 6,
      dependencies: ['audioOutputStream'],
      optional: false,
    });

    // 7. 解码调度器
    resourceManager.register({
      name: 'slotScheduler',
      start: async () => {
        if (slotScheduler) {
          slotScheduler.start();
          console.log(`📡 [ResourceManager] 解码调度器已启动`);
        }
      },
      stop: async () => {
        if (slotScheduler) {
          slotScheduler.stop();
          console.log(`🛑 [ResourceManager] 解码调度器已停止`);
        }
      },
      priority: 7,
      dependencies: ['clock'],
      optional: false,
    });

    // 8. 频谱调度器
    resourceManager.register({
      name: 'spectrumScheduler',
      start: async () => {
        if (spectrumScheduler) {
          spectrumScheduler.start();
          console.log(`📊 [ResourceManager] 频谱分析调度器已启动`);
        }
      },
      stop: async () => {
        if (spectrumScheduler) {
          spectrumScheduler.stop();
          console.log(`🛑 [ResourceManager] 频谱分析调度器已停止`);
        }
      },
      priority: 8,
      dependencies: ['clock'],
      optional: false,
    });

    // 9. 操作员管理器
    resourceManager.register({
      name: 'operatorManager',
      start: async () => {
        operatorManager.start();
        console.log(`📡 [ResourceManager] 操作员管理器已启动`);
      },
      stop: async () => {
        operatorManager.stop();
        console.log(`🛑 [ResourceManager] 操作员管理器已停止`);
      },
      priority: 9,
      dependencies: ['clock'],
      optional: false,
    });

    console.log('✅ [EngineLifecycle] 所有资源已注册');
  }

  /**
   * 初始化引擎状态机
   */
  initializeStateMachine(): void {
    console.log('🎛️ [EngineStateMachine] 初始化引擎状态机...');

    const engineInput: EngineInput = {
      onStart: async () => {
        console.log('🚀 [EngineStateMachine] 执行启动操作');
        await this.doStart();
      },
      onStop: async () => {
        console.log('🛑 [EngineStateMachine] 执行停止操作');
        await this.doStop();
      },
      onError: (error) => {
        console.error('❌ [EngineStateMachine] 状态机错误:', error);
      },
      onStateChange: (_state, context) => {
        console.log(`🔄 [EngineStateMachine] 状态变化: ${_state}`, {
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

    console.log('✅ [EngineStateMachine] 引擎状态机已初始化');
  }

  /**
   * 启动引擎（外部 API，委托给状态机）
   */
  async start(): Promise<void> {
    if (!this.engineStateMachineActor) {
      throw new Error('引擎状态机未初始化');
    }

    if (isEngineState(this.engineStateMachineActor, EngineState.RUNNING)) {
      console.log('⚠️  [EngineLifecycle] 引擎已经在运行中，发送状态同步');
      const status = this.deps.getStatus();
      this.deps.engineEmitter.emit('systemStatus', status);
      return;
    }

    if (isEngineState(this.engineStateMachineActor, EngineState.STARTING)) {
      console.log('⚠️  [EngineLifecycle] 引擎正在启动中，忽略重复的启动请求');
      return;
    }

    console.log('🎛️ [EngineStateMachine] 委托给状态机: START');
    this.engineStateMachineActor.send({ type: 'START' });
  }

  /**
   * 停止引擎（外部 API，委托给状态机）
   */
  async stop(): Promise<void> {
    if (!this.engineStateMachineActor) {
      throw new Error('引擎状态机未初始化');
    }

    if (isEngineState(this.engineStateMachineActor, EngineState.IDLE)) {
      console.log('⚠️  [EngineLifecycle] 引擎已经停止，发送状态同步');
      const status = this.deps.getStatus();
      this.deps.engineEmitter.emit('systemStatus', status);
      return;
    }

    if (isEngineState(this.engineStateMachineActor, EngineState.STOPPING)) {
      console.log('⚠️  [EngineLifecycle] 引擎正在停止中，等待停止完成...');
      try {
        const { waitForEngineState } = await import('../state-machines/engineStateMachine.js');
        await waitForEngineState(this.engineStateMachineActor, EngineState.IDLE, 10000);
        console.log('✅ [EngineLifecycle] 停止完成');
      } catch (error) {
        console.error('❌ [EngineLifecycle] 等待停止超时:', error);
        throw error;
      }
      return;
    }

    console.log('🎛️ [EngineStateMachine] 委托给状态机: STOP');
    this.engineStateMachineActor.send({ type: 'STOP' });
  }

  /**
   * 发送 RADIO_DISCONNECTED 事件到状态机
   */
  sendRadioDisconnected(reason: string): void {
    if (this.engineStateMachineActor && isEngineState(this.engineStateMachineActor, EngineState.RUNNING)) {
      console.log('🎛️ [EngineStateMachine] 发送 RADIO_DISCONNECTED 事件');
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
      console.log('🗑️  [EngineLifecycle] 停止引擎状态机...');
      this.engineStateMachineActor.stop();
      this.engineStateMachineActor = null;
      console.log('✅ [EngineLifecycle] 引擎状态机已停止');
    }
  }

  // ─── 内部方法 ────────────────────────────────────

  private async doStart(): Promise<void> {
    if (!this.deps.slotClock) {
      throw new Error('时钟管理器未初始化');
    }

    const mode = this.deps.getCurrentMode();
    console.log(`🚀 [EngineLifecycle] 启动引擎，模式: ${mode.name}`);

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

      console.log(`✅ [EngineLifecycle] 引擎启动完成`);
    } catch (error) {
      console.error(`❌ [EngineLifecycle] 引擎启动失败:`, error);
      throw error;
    }
  }

  private async doStop(): Promise<void> {
    console.log('🛑 [EngineLifecycle] 停止引擎');

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

      console.log(`✅ [EngineLifecycle] 引擎停止完成`);
    } catch (error) {
      console.error(`❌ [EngineLifecycle] 引擎停止失败:`, error);
      this.isRunning = false;
      this.audioStarted = false;
      throw error;
    }
  }
}
