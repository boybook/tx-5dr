import {
  SlotClock,
  SlotScheduler,
  ClockSourceSystem
} from '@tx5dr/core';
import { MODES, type ModeDescriptor, type SlotPack, type DigitalRadioEngineEvents, type RadioOperatorConfig, type TransmissionCompleteInfo } from '@tx5dr/contracts';
import { EventEmitter } from 'eventemitter3';
import { AudioStreamManager } from './audio/AudioStreamManager.js';
import { WSJTXDecodeWorkQueue } from './decode/WSJTXDecodeWorkQueue.js';
import { WSJTXEncodeWorkQueue } from './decode/WSJTXEncodeWorkQueue.js';
import { SlotPackManager } from './slot/SlotPackManager.js';
import { ConfigManager } from './config/config-manager.js';
import { SpectrumScheduler } from './audio/SpectrumScheduler.js';
import { AudioMixer, type MixedAudio } from './audio/AudioMixer.js';
import { RadioOperatorManager } from './operator/RadioOperatorManager.js';
import { printAppPaths } from './utils/debug-paths.js';
import { PhysicalRadioManager } from './radio/PhysicalRadioManager.js';
import { FrequencyManager } from './radio/FrequencyManager.js';
import { TransmissionTracker } from './transmission/TransmissionTracker.js';
import { IcomWlanAudioAdapter } from './audio/IcomWlanAudioAdapter.js';
import { AudioDeviceManager } from './audio/audio-device-manager.js';
import { AudioMonitorService } from './audio/AudioMonitorService.js';
import { MemoryLeakDetector } from './utils/MemoryLeakDetector.js';
import { createEngineActor, isEngineState, getEngineContext, type EngineActor } from './state-machines/engineStateMachine.js';
import { EngineState, type EngineInput } from './state-machines/types.js';
import { ResourceManager } from './utils/ResourceManager.js';

/**
 * 时钟管理器 - 管理 TX-5DR 的时钟系统
 */
export class DigitalRadioEngine extends EventEmitter<DigitalRadioEngineEvents> {
  private static instance: DigitalRadioEngine | null = null;
  
  private slotClock: SlotClock | null = null;
  private slotScheduler: SlotScheduler | null = null;
  private clockSource: ClockSourceSystem;
  private currentMode: ModeDescriptor = MODES.FT8;
  private isRunning = false;
  private audioStarted = false;
  
  // PTT状态管理
  private isPTTActive = false;
  private pttTimeoutId: NodeJS.Timeout | null = null;
  
  // 真实的音频和解码系统
  private audioStreamManager: AudioStreamManager;
  private realDecodeQueue: WSJTXDecodeWorkQueue;
  private realEncodeQueue: WSJTXEncodeWorkQueue;
  private slotPackManager: SlotPackManager;
  private spectrumScheduler: SpectrumScheduler;
  
  // 音频混音器
  private audioMixer: AudioMixer;

  // 物理电台管理器
  private radioManager: PhysicalRadioManager;

  // 频率管理器
  private frequencyManager: FrequencyManager;

  // 电台操作员管理器
  private _operatorManager: RadioOperatorManager;

  // 传输跟踪器
  private transmissionTracker: TransmissionTracker;

  // ICOM WLAN 音频适配器
  private icomWlanAudioAdapter: IcomWlanAudioAdapter | null = null;

  // 音频监听服务
  private audioMonitorService: AudioMonitorService | null = null;

  // 编码状态跟踪（用于检测编码超时）
  private currentSlotExpectedEncodes: number = 0; // 当前时隙期望的编码数量
  private currentSlotCompletedEncodes: number = 0; // 当前时隙已完成的编码数量
  private currentSlotId: string = ''; // 当前时隙ID

  // 高频事件采样监控（用于健康检查）
  private spectrumEventCount: number = 0; // 频谱事件计数
  private meterEventCount: number = 0; // 数值表事件计数
  private lastHealthCheckTimestamp: number = Date.now(); // 上次健康检查时间

  // 记录 radioManager 事件监听器，用于清理 (修复内存泄漏)
  private radioManagerEventListeners: Map<string, (...args: any[]) => void> = new Map();

  // 引擎状态机 (XState v5)
  private engineStateMachineActor: EngineActor | null = null;

  // 资源管理器 (Day6)
  private resourceManager: ResourceManager;

  public get operatorManager(): RadioOperatorManager {
    return this._operatorManager;
  }

  /**
   * 获取时隙包管理器（用于API访问）
   */
  public getSlotPackManager(): SlotPackManager {
    return this.slotPackManager;
  }

  /** 获取物理电台管理器 */
  public getRadioManager(): PhysicalRadioManager {
    return this.radioManager;
  }

  /** 获取音频监听服务 */
  public getAudioMonitorService(): AudioMonitorService | null {
    return this.audioMonitorService;
  }

  /**
   * 更新发射时序补偿值
   * @param compensationMs 补偿值（毫秒），正值表示提前发射，负值表示延后发射
   */
  public updateTransmitCompensation(compensationMs: number): void {
    if (this.slotClock) {
      this.slotClock.setCompensation(compensationMs);
      console.log(`⏱️ [DigitalRadioEngine] 发射补偿已更新为 ${compensationMs}ms`);
    } else {
      console.warn(`⚠️ [DigitalRadioEngine] SlotClock 未初始化，无法更新补偿值`);
    }
  }

  // 频谱分析配置常量
  private static readonly SPECTRUM_CONFIG = {
    ANALYSIS_INTERVAL_MS: 150,    // 频谱分析间隔
    FFT_SIZE: 8192,              // FFT大小 (分辨率: 6000/8192 ≈ 0.73 Hz/bin)
    WINDOW_FUNCTION: 'hann' as const,
    WORKER_POOL_SIZE: 1,
    ENABLED: true,
    TARGET_SAMPLE_RATE: 6000     // 目标采样率6kHz
  };
  
  private constructor() {
    super();
    this.clockSource = new ClockSourceSystem();
    this.audioStreamManager = new AudioStreamManager();
    this.realDecodeQueue = new WSJTXDecodeWorkQueue(1);
    this.realEncodeQueue = new WSJTXEncodeWorkQueue(1);
    this.slotPackManager = new SlotPackManager();
    
    // 初始化音频混音器，设置100ms的混音窗口
    this.audioMixer = new AudioMixer(100);

    // 初始化物理电台管理器
    this.radioManager = new PhysicalRadioManager();

    // 初始化频率管理器
    this.frequencyManager = new FrequencyManager();

    // 初始化传输跟踪器
    this.transmissionTracker = new TransmissionTracker();

    // 注册内存泄漏检测 (仅在开发环境启用)
    const leakDetector = MemoryLeakDetector.getInstance();
    leakDetector.register('DigitalRadioEngine', this);

    // 初始化资源管理器 (Day6)
    this.resourceManager = new ResourceManager();

    // 注册所有资源到资源管理器 (Day6)
    this.registerResources();

    // 初始化引擎状态机
    this.initializeEngineStateMachine();

    // 监听物理电台管理器事件
    this.setupRadioManagerEventListeners();
    
    // 初始化操作员管理器
    this._operatorManager = new RadioOperatorManager({
      eventEmitter: this,
      encodeQueue: this.realEncodeQueue,
      clockSource: this.clockSource,
      getCurrentMode: () => this.currentMode,
      setRadioFrequency: (freq: number) => {
        if (this.radioManager) {
          try { this.radioManager.setFrequency(freq); } catch (e) { console.error('设置电台频率失败', e); }
        }
      },
      getRadioFrequency: async () => {
        try {
          // 若未连接，将抛错；由上层处理回退
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
      workerPoolSize: DigitalRadioEngine.SPECTRUM_CONFIG.WORKER_POOL_SIZE,
      enabled: DigitalRadioEngine.SPECTRUM_CONFIG.ENABLED,
      targetSampleRate: DigitalRadioEngine.SPECTRUM_CONFIG.TARGET_SAMPLE_RATE
    }, () => ConfigManager.getInstance().getFT8Config().spectrumWhileTransmitting ?? true);
    
    // 监听编码完成事件 - 修改为使用音频混音器
    this.realEncodeQueue.on('encodeComplete', async (result) => {
      try {
        console.log(`🎵 [时钟管理器] 编码完成，提交到混音器`, {
          operatorId: result.operatorId,
          duration: result.duration
        });

        // 更新编码完成计数
        this.currentSlotCompletedEncodes++;
        console.log(`📊 [编码跟踪] 时隙 ${this.currentSlotId}: 已完成 ${this.currentSlotCompletedEncodes}/${this.currentSlotExpectedEncodes}`);

        // 先记录编码完成，进入混音阶段
        this.transmissionTracker.updatePhase(result.operatorId, 'mixing' as any);
        
        // 然后记录音频准备就绪时间
        this.transmissionTracker.updatePhase(result.operatorId, 'ready' as any, {
          audioData: result.audioData,
          sampleRate: result.sampleRate,
          duration: result.duration
        });
        
        // 计算当前模式的时序参数
        const slotDurationSec = this.currentMode.slotMs / 1000; // 周期时长（秒）
        let audioDurationSec = result.duration; // 音频时长（秒）
        let audioData = result.audioData;
        
        // 获取编码请求中的时间信息
        const request = (result as any).request;
        const timeSinceSlotStartMs = request?.timeSinceSlotStartMs || 0;
        
        // 获取当前时隙信息
        const now = this.clockSource.now();
        const currentSlotStartMs = Math.floor(now / this.currentMode.slotMs) * this.currentMode.slotMs;
        const currentTimeSinceSlotStartMs = now - currentSlotStartMs;
        const currentTimeSinceSlotStartSec = currentTimeSinceSlotStartMs / 1000;
        
        console.log(`⏰ [时钟管理器] 播放时序计算:`);
        console.log(`   周期时长: ${slotDurationSec}s`);
        console.log(`   原始音频时长: ${result.duration.toFixed(2)}s`);
        console.log(`   当前音频时长: ${audioDurationSec.toFixed(2)}s`);
        console.log(`   发射延迟设置: ${(this.currentMode.transmitTiming || 0)}ms`);
        console.log(`   当前时隙开始: ${new Date(currentSlotStartMs).toISOString()}`);
        console.log(`   时隙已过时间: ${currentTimeSinceSlotStartSec.toFixed(2)}s`);
        if (timeSinceSlotStartMs > 0) {
          console.log(`   中途发射标记: 是 (${(timeSinceSlotStartMs/1000).toFixed(2)}s)`);
        }
        
        // 清除该操作员之前的待播放音频（如果有）
        this.audioMixer.clearOperatorAudio(result.operatorId);
        
        // 计算应该开始播放的时间点和需要裁剪的音频
        let playbackStartMs: number;
        let audioSkipMs: number = 0; // 需要跳过的音频毫秒数
        const transmitStartFromSlotMs = this.currentMode.transmitTiming || 0;
        
        // 判断是否是时隙中间切换（而不是正常的 transmitStart 触发）
        // 正常的 transmitStart 触发时，timeSinceSlotStartMs 应该接近 transmitTiming
        const isMidSlotSwitch = timeSinceSlotStartMs > 0 && 
                                Math.abs(timeSinceSlotStartMs - transmitStartFromSlotMs) > 100; // 允许100ms误差
        
        if (isMidSlotSwitch) {
          // 时隙中间切换发射内容
          console.log(`🔄 [时钟管理器] 检测到时隙中间切换`);
          
          if (currentTimeSinceSlotStartMs >= transmitStartFromSlotMs) {
            // 已经过了正常的发射开始时间，立即播放并裁剪音频
            playbackStartMs = now;
            // 计算从发射开始到现在已经过了多少时间
            audioSkipMs = currentTimeSinceSlotStartMs - transmitStartFromSlotMs;
            console.log(`🎯 [时钟管理器] 时隙中间切换，已过发射时间点 ${audioSkipMs}ms，立即播放并裁剪音频`);
          } else {
            // 还没到发射时间，等到发射时间点再播放
            playbackStartMs = currentSlotStartMs + transmitStartFromSlotMs;
            audioSkipMs = 0;
            console.log(`🎯 [时钟管理器] 时隙中间切换，等待到发射时间点: ${new Date(playbackStartMs).toISOString()}`);
          }
        } else {
          // 正常的 transmitStart 触发，立即播放
          playbackStartMs = now;
          audioSkipMs = 0;
          console.log(`🎯 [时钟管理器] 正常发射触发，立即播放`);
        }
        
        // 如果需要裁剪音频
        if (audioSkipMs > 0 && audioSkipMs < audioDurationSec * 1000) {
          const skipSamples = Math.floor((audioSkipMs / 1000) * result.sampleRate);
          
          if (skipSamples < audioData.length) {
            audioData = audioData.slice(skipSamples);
            audioDurationSec = audioData.length / result.sampleRate;
            console.log(`✂️ [时钟管理器] 裁剪音频:`);
            console.log(`   跳过时间: ${audioSkipMs.toFixed(0)}ms`);
            console.log(`   跳过样本: ${skipSamples}`);
            console.log(`   剩余样本: ${audioData.length}`);
            console.log(`   剩余时长: ${audioDurationSec.toFixed(2)}s`);
          } else {
            console.warn(`❌ [时钟管理器] 需要跳过的时间超过音频长度，取消播放`);
            this.emit('transmissionComplete', {
              operatorId: result.operatorId,
              success: false,
              error: '错过播放窗口'
            });
            return;
          }
        }
        
        // 计算目标播放时间（基于 transmitTiming）
        const targetPlaybackTime = currentSlotStartMs + (this.currentMode.transmitTiming || 0);

        // 计算从现在到播放开始的延迟
        const delayMs = playbackStartMs - now;

        console.log(`🎯 [时钟管理器] 播放时序:`);
        console.log(`   目标播放时间: ${new Date(targetPlaybackTime).toISOString()}`);
        console.log(`   实际播放时间: ${new Date(playbackStartMs).toISOString()}`);
        console.log(`   当前时间: ${new Date(now).toISOString()}`);
        console.log(`   延迟: ${delayMs}ms`);

        if (delayMs > 0) {
          // 还没到播放时间，提交到混音器等待
          console.log(`⌛ [时钟管理器] 等待 ${delayMs}ms 后开始播放`);
          this.audioMixer.addAudio(result.operatorId, audioData, result.sampleRate, playbackStartMs, targetPlaybackTime);
        } else {
          // 立即提交到混音器播放
          console.log(`🎵 [时钟管理器] 立即播放音频 (时长: ${audioDurationSec.toFixed(2)}s)`);
          this.audioMixer.addAudio(result.operatorId, audioData, result.sampleRate, now, targetPlaybackTime);
        }
        
        // 记录音频添加到混音器的时间
        this.transmissionTracker.recordAudioAddedToMixer(result.operatorId);

        // 🔄 检查是否需要重新混音（编码完成后的兜底方案）
        if (this.shouldTriggerRemix()) {
          console.log(`🔄 [时钟管理器] 检测到需要重新混音，停止当前播放并重新混音`);

          try {
            // 1. 停止当前正在播放的音频，获取已播放的时间
            const elapsedTimeMs = await this.audioStreamManager.stopCurrentPlayback();
            console.log(`🛑 [时钟管理器] 已停止当前播放，已播放时间: ${elapsedTimeMs}ms`);

            // 2. 调用混音器重新混音
            const remixedAudio = await this.audioMixer.remixWithNewAudio(elapsedTimeMs);

            if (remixedAudio) {
              console.log(`🎵 [时钟管理器] 重新混音完成，开始播放:`);
              console.log(`   操作员: [${remixedAudio.operatorIds.join(', ')}]`);
              console.log(`   混音时长: ${remixedAudio.duration.toFixed(2)}s`);
              console.log(`   采样率: ${remixedAudio.sampleRate}Hz`);

              // 3. 播放重新混音后的音频（从中途开始）
              await this.audioStreamManager.playAudio(remixedAudio.audioData, remixedAudio.sampleRate);

              // 4. 重新计算PTT持续时间
              const actualPlaybackTimeMs = remixedAudio.duration * 1000;
              const pttHoldTimeMs = 200;
              const totalPTTTimeMs = actualPlaybackTimeMs + pttHoldTimeMs;

              // 5. 重新安排PTT停止
              this.schedulePTTStop(totalPTTTimeMs);

              console.log(`✅ [时钟管理器] 重新混音播放完成`);
            } else {
              console.warn(`⚠️ [时钟管理器] 重新混音返回null，跳过播放`);
            }
          } catch (remixError) {
            console.error(`❌ [时钟管理器] 重新混音失败:`, remixError);
            // 重新混音失败时，让混音器正常处理
          }
        }

      } catch (error) {
        console.error(`❌ [时钟管理器] 编码结果处理失败:`, error);
        this.emit('transmissionComplete', {
          operatorId: result.operatorId,
          success: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    });
    
    // 监听混音器的混音完成事件
    this.audioMixer.on('mixedAudioReady', async (mixedAudio: MixedAudio) => {
      try {
        console.log(`🎵 [时钟管理器] 混音完成，开始播放:`);
        console.log(`   操作员: [${mixedAudio.operatorIds.join(', ')}]`);
        console.log(`   混音时长: ${mixedAudio.duration.toFixed(2)}s`);
        console.log(`   采样率: ${mixedAudio.sampleRate}Hz`);
        
        // 记录混音完成时间
        for (const operatorId of mixedAudio.operatorIds) {
          this.transmissionTracker.recordMixedAudioReady(operatorId);
        }
        
        // 并行启动PTT和音频播放准备
        console.log(`📡 [时钟管理器] 并行启动PTT和音频播放`);
        
        // 记录音频播放开始时间（在实际播放之前记录）
        for (const operatorId of mixedAudio.operatorIds) {
          this.transmissionTracker.recordAudioPlaybackStart(operatorId);
        }
        
        // 启动PTT（不等待完成）
        const pttPromise = this.startPTT().then(() => {
          // PTT启动完成后记录时间
          for (const operatorId of mixedAudio.operatorIds) {
            this.transmissionTracker.recordPTTStart(operatorId);
          }
        });
        
        // 开始播放混音后的音频（这个方法会将数据写入音频缓冲区）
        const audioPromise = this.audioStreamManager.playAudio(mixedAudio.audioData, mixedAudio.sampleRate);

        // 计算音频实际播放时间 + 延迟停止时间
        const actualPlaybackTimeMs = mixedAudio.duration * 1000; // 音频实际播放时间
        const pttHoldTimeMs = 200;
        const totalPTTTimeMs = actualPlaybackTimeMs + pttHoldTimeMs; // 总的PTT持续时间
        
        console.log(`📡 [时钟管理器] PTT时序计算:`);
        console.log(`   音频播放时间: ${actualPlaybackTimeMs.toFixed(0)}ms`);
        console.log(`   PTT额外延迟: ${pttHoldTimeMs.toFixed(0)}ms`);
        console.log(`   PTT总持续时间: ${totalPTTTimeMs.toFixed(0)}ms`);
        
        // 安排PTT在音频播放完成后停止
        this.schedulePTTStop(totalPTTTimeMs);

        // 等待PTT和音频播放都完成（或者至少PTT完成）
        await Promise.all([pttPromise, audioPromise]);
        
        // 为所有参与混音的操作员发送成功事件
        for (const operatorId of mixedAudio.operatorIds) {
          this.emit('transmissionComplete', {
            operatorId,
            success: true,
            duration: mixedAudio.duration,
            mixedWith: mixedAudio.operatorIds.filter(id => id !== operatorId) // 与其他操作员混音
          });
        }
        
        console.log(`✅ [时钟管理器] 混音播放完成，通知 ${mixedAudio.operatorIds.length} 个操作员`);
        
      } catch (error) {
        console.error(`❌ [时钟管理器] 混音播放失败:`, error);
        
        // 播放失败时立即停止PTT
        await this.stopPTT();
        
        // 为所有参与混音的操作员发送失败事件
        for (const operatorId of mixedAudio.operatorIds) {
          this.emit('transmissionComplete', {
            operatorId,
            success: false,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    });

    this.realEncodeQueue.on('encodeError', (error, request) => {
      console.error(`❌ [时钟管理器] 编码失败:`, error);
      this.emit('transmissionComplete', {
        operatorId: request.operatorId,
        success: false,
        error: error.message
      });
    });

  }
  
  /**
   * 获取单例实例
   */
  static getInstance(): DigitalRadioEngine {
    if (!DigitalRadioEngine.instance) {
      DigitalRadioEngine.instance = new DigitalRadioEngine();
    }
    return DigitalRadioEngine.instance;
  }
  
  /**
   * 初始化时钟管理器
   */
  async initialize(): Promise<void> {
    console.log('🕐 [时钟管理器] 正在初始化...');

    // 显示应用程序路径信息
    await printAppPaths();

    // 从配置读取电台设置中的发射补偿值
    const radioConfig = ConfigManager.getInstance().getRadioConfig();
    const compensationMs = radioConfig.transmitCompensationMs || 0;
    console.log(`⚙️ [时钟管理器] 读取发射补偿配置: ${compensationMs}ms`);

    // 创建 SlotClock，传入补偿值
    this.slotClock = new SlotClock(this.clockSource, this.currentMode, compensationMs);
    
    // 监听时钟事件
    this.slotClock.on('slotStart', async (slotInfo) => {
      console.log(`🎯 [时隙开始] ID: ${slotInfo.id}, 开始时间: ${new Date(slotInfo.startMs).toISOString()}, 相位: ${slotInfo.phaseMs}ms, 漂移: ${slotInfo.driftMs}ms`);
      
      // 确保PTT在新时隙开始时被停止
      await this.forceStopPTT();
      
      this.emit('slotStart', slotInfo, this.slotPackManager.getLatestSlotPack());
      
      // 广播所有操作员的状态更新（包含更新的周期进度）
      this.operatorManager.broadcastAllOperatorStatusUpdates();
    });
    
    // 监听编码开始事件 (提前触发，留出编码时间)
    this.slotClock.on('encodeStart', (slotInfo) => {
      console.log(`🔧 [编码时机] ID: ${slotInfo.id}, 时间: ${new Date().toISOString()}, 提前量: ${this.currentMode.encodeAdvance}ms`);
      this.emit('encodeStart' as any, slotInfo);

      // 重置当前时隙的编码跟踪
      this.currentSlotId = slotInfo.id;
      this.currentSlotExpectedEncodes = 0;
      this.currentSlotCompletedEncodes = 0;

      // 处理发射请求队列 - 开始编码
      // RadioOperator 会在 encodeStart 事件中进行周期检查
      // 只有在正确的发射周期内才会发出 requestTransmit 事件加入队列
      // 这里处理队列中已经通过周期检查的发射请求
      const pendingCount = this.operatorManager.getPendingTransmissionsCount();
      this.operatorManager.processPendingTransmissions(slotInfo);

      // 记录期望的编码数量（processPendingTransmissions 会消费队列并启动编码）
      this.currentSlotExpectedEncodes = pendingCount;
      if (this.currentSlotExpectedEncodes > 0) {
        console.log(`📊 [编码跟踪] 时隙 ${slotInfo.id}: 期望 ${this.currentSlotExpectedEncodes} 个编码任务`);
      }
    });

    // 监听发射开始事件 (目标播放时间)
    this.slotClock.on('transmitStart', (slotInfo) => {
      console.log(`📡 [目标播放时机] ID: ${slotInfo.id}, 时间: ${new Date().toISOString()}, 延迟: ${this.currentMode.transmitTiming}ms`);

      // 检查编码是否完成
      if (this.currentSlotExpectedEncodes > 0 &&
          this.currentSlotCompletedEncodes < this.currentSlotExpectedEncodes) {
        const missingCount = this.currentSlotExpectedEncodes - this.currentSlotCompletedEncodes;
        console.warn(`⚠️ [编码超时] 发射时刻到达但编码未完成！期望 ${this.currentSlotExpectedEncodes} 个，已完成 ${this.currentSlotCompletedEncodes} 个，缺少 ${missingCount} 个`);

        // 发出警告事件到前端
        this.emit('timingWarning' as any, {
          title: '⚠️ 编码超时警告',
          text: `发射时刻已到达，但仍有 ${missingCount} 个编码任务未完成。这可能导致发射延迟或失败。建议检查发射补偿设置或减少同时发射的操作员数量。`
        });
      } else if (this.currentSlotExpectedEncodes > 0) {
        console.log(`✅ [编码跟踪] 所有编码任务已按时完成 (${this.currentSlotCompletedEncodes}/${this.currentSlotExpectedEncodes})`);
      }

      this.emit('transmitStart' as any, slotInfo);
      // 此时编码应该已经完成或接近完成，音频即将播放
    });
    
    this.slotClock.on('subWindow', (slotInfo, windowIdx) => {
      const totalWindows = this.currentMode.windowTiming?.length || 0;
      console.log(`🔍 [子窗口] 时隙: ${slotInfo.id}, 窗口: ${windowIdx}/${totalWindows}, 开始: ${new Date(slotInfo.startMs).toISOString()}`);
      this.emit('subWindow', { slotInfo, windowIdx });
    });
    
    // 创建 SlotScheduler - 使用真实的音频和解码系统
    this.slotScheduler = new SlotScheduler(
      this.slotClock,
      this.realDecodeQueue,
      this.audioStreamManager.getAudioProvider(),
      this._operatorManager,  // 传递操作员管理器作为发射状态检查器
      () => ConfigManager.getInstance().getFT8Config().decodeWhileTransmitting ?? false  // 配置函数
    );
    
    // 监听解码结果并通过 SlotPackManager 处理
    this.realDecodeQueue.on('decodeComplete', (result) => {
      // 通过 SlotPackManager 处理解码结果
      const updatedSlotPack = this.slotPackManager.processDecodeResult(result);
    });
    
    this.realDecodeQueue.on('decodeError', (error, request) => {
      console.error(`💥 [时钟管理器] 解码错误: 时隙=${request.slotId}, 窗口=${request.windowIdx}:`, error.message);
      this.emit('decodeError', { error, request });
    });
    
    // 监听发射日志事件，将发射信息添加到SlotPackManager
    this.on('transmissionLog' as any, (data: {
      operatorId: string;
      time: string;
      message: string;
      frequency: number;
      slotStartMs: number;
    }) => {
      // 生成时隙ID（与解码结果一致的格式）
      const slotId = `slot-${data.slotStartMs}`;
      
      // 添加发射帧到SlotPackManager
      this.slotPackManager.addTransmissionFrame(
        slotId,
        data.operatorId,
        data.message,
        data.frequency,
        data.slotStartMs
      );
    });

    // 监听 SlotPackManager 事件
    this.slotPackManager.on('slotPackUpdated', async (slotPack) => {
      console.log(`📦 [时钟管理器] 时隙包更新事件: ${slotPack.slotId}`);
      console.log(`   当前状态: ${slotPack.frames.length}个信号, 解码${slotPack.stats.totalDecodes}次`);
      
      // 如果有解码结果，显示标准格式的解码输出
      if (slotPack.frames.length > 0) {
        // 使用时隙开始时间而不是当前时间
        const slotStartTime = new Date(slotPack.startMs);
        
        for (const frame of slotPack.frames) {
          // 格式: HHMMSS SNR DT FREQ ~ MESSAGE  
          const utcTime = slotStartTime.toISOString().slice(11, 19).replace(/:/g, '').slice(0, 6); // HHMMSS
          
          // 检查是否为发射帧
          if (frame.snr === -999) {
            // 发射帧显示为 TX
            console.log(` - ${utcTime}  TX  ${frame.dt.toFixed(1).padStart(5)} ${Math.round(frame.freq).toString().padStart(4)} ~  ${frame.message}`);
          } else {
            // 接收帧正常显示SNR
            const snr = frame.snr >= 0 ? ` ${frame.snr}` : `${frame.snr}`; // SNR 带符号
            const dt = frame.dt.toFixed(1).padStart(5); // 时间偏移，1位小数，5位宽度
            const freq = Math.round(frame.freq).toString().padStart(4); // 频率，4位宽度
            const message = frame.message; // 消息不需要填充
            
            console.log(` - ${utcTime} ${snr.padStart(3)} ${dt} ${freq} ~  ${message}`);
          }
        }
      }
      
      this.emit('slotPackUpdated', slotPack);
    });
    
    // 初始化频谱调度器
    await this.spectrumScheduler.initialize(
      this.audioStreamManager.getAudioProvider(),
      this.audioStreamManager.getInternalSampleRate() // 使用内部处理采样率（12kHz）
    );
    
    // 监听频谱调度器事件
    this.spectrumScheduler.on('spectrumReady', (spectrum) => {
      // 📝 EventBus 优化：频谱数据已通过 EventBus 直达 WSServer（SpectrumScheduler.ts:279）
      // 此处仅保留健康检查逻辑，不再转发事件

      // 【采样监控】每100次检查一次健康状态
      this.spectrumEventCount++;
      if (this.spectrumEventCount % 100 === 0) {
        this.checkHighFrequencyEventsHealth();
      }
    });
    
    this.spectrumScheduler.on('error', (error) => {
      console.error('📊 [时钟管理器] 频谱分析错误:', error);
    });
    
    // 确保频谱调度器初始PTT状态正确
    this.spectrumScheduler.setPTTActive(this.isPTTActive);
    
    // 初始化操作员管理器
    await this.operatorManager.initialize();
    
    console.log(`✅ [时钟管理器] 初始化完成，当前模式: ${this.currentMode.name}`);
  }

  /**
   * 启动时钟（外部API，委托给状态机）
   */
  async start(): Promise<void> {
    if (!this.engineStateMachineActor) {
      throw new Error('引擎状态机未初始化');
    }

    // 如果已经在运行中，发送状态同步后返回
    if (isEngineState(this.engineStateMachineActor, EngineState.RUNNING)) {
      console.log('⚠️  [时钟管理器] 时钟已经在运行中，发送状态同步');
      const status = this.getStatus();
      this.emit('systemStatus', status);
      return;
    }

    // 如果正在启动中，等待启动完成
    if (isEngineState(this.engineStateMachineActor, EngineState.STARTING)) {
      console.log('⚠️  [时钟管理器] 时钟正在启动中，等待启动完成...');
      // TODO: 可以添加waitForEngineState等待逻辑
      return;
    }

    console.log('🎛️ [EngineStateMachine] 委托给状态机: START');
    this.engineStateMachineActor.send({ type: 'START' });
  }
  
  /**
   * 获取所有活跃的时隙包
   */
  getActiveSlotPacks(): SlotPack[] {
    return this.slotPackManager.getActiveSlotPacks();
  }

  /**
   * 获取指定时隙包
   */
  getSlotPack(slotId: string): SlotPack | null {
    return this.slotPackManager.getSlotPack(slotId);
  }

  /**
   * 设置当前模式
   */
  async setMode(mode: ModeDescriptor): Promise<void> {
    if (this.currentMode.name === mode.name) {
      console.log(`🔄 [时钟管理器] 已经是模式: ${mode.name}`);
      return;
    }

    console.log(`🔄 [时钟管理器] 切换模式: ${this.currentMode.name} -> ${mode.name}`);
    this.currentMode = mode;

    // 更新 SlotClock 的模式
    if (this.slotClock) {
      this.slotClock.setMode(mode);
    }

    // 更新 SlotPackManager 的模式
    this.slotPackManager.setMode(mode);

    // 发射模式变化事件
    this.emit('modeChanged', mode);
  }

  /**
   * 获取当前状态（双轨运行：同时查询状态机和Manager）
   */
  public getStatus() {
    // 统一 isDecoding 语义：只有当引擎运行且时钟正在运行时才表示正在解码
    const isActuallyDecoding = this.isRunning && (this.slotClock?.isRunning ?? false);

    // 获取状态机状态
    const engineState = this.engineStateMachineActor
      ? (this.engineStateMachineActor.getSnapshot().value as EngineState)
      : EngineState.IDLE;

    const engineContext = this.engineStateMachineActor
      ? getEngineContext(this.engineStateMachineActor)
      : null;

    return {
      // Manager状态（现有）
      isRunning: this.isRunning,
      isDecoding: isActuallyDecoding, // 明确语义：正在监听解码
      currentMode: this.currentMode,
      currentTime: this.clockSource.now(),
      nextSlotIn: this.slotClock?.getNextSlotIn() ?? 0,
      audioStarted: this.audioStarted,
      volumeGain: this.audioStreamManager.getVolumeGain(),
      volumeGainDb: this.audioStreamManager.getVolumeGainDb(),
      isPTTActive: this.isPTTActive,
      radioConnected: this.radioManager.isConnected(),
      radioReconnectInfo: this.radioManager.getReconnectInfo(),

      // 状态机状态（新增）
      engineState,
      engineContext: engineContext ? {
        error: engineContext.error?.message,
        startedResources: engineContext.startedResources,
        forcedStop: engineContext.forcedStop,
      } : null,
    };
  }

  /**
   * 停止引擎（外部API，委托给状态机）(Day7 改进)
   *
   * 状态机驱动的停止流程：
   * 1. 清理所有事件监听器（避免停止过程中触发不必要的事件）
   * 2. 按逆序停止所有资源（由 ResourceManager 管理）
   * 3. 处理停止过程中的异常（确保资源清理完整）
   */
  async stop(): Promise<void> {
    if (!this.engineStateMachineActor) {
      throw new Error('引擎状态机未初始化');
    }

    // 如果已经在空闲状态，发送状态同步后返回
    if (isEngineState(this.engineStateMachineActor, EngineState.IDLE)) {
      console.log('⚠️  [时钟管理器] 时钟已经停止，发送状态同步');
      const status = this.getStatus();
      this.emit('systemStatus', status);
      return;
    }

    // 如果正在停止中，等待停止完成 (Day7: 改进等待逻辑)
    if (isEngineState(this.engineStateMachineActor, EngineState.STOPPING)) {
      console.log('⚠️  [时钟管理器] 时钟正在停止中，等待停止完成...');
      try {
        const { waitForEngineState } = await import('./state-machines/engineStateMachine.js');
        await waitForEngineState(this.engineStateMachineActor, EngineState.IDLE, 10000);
        console.log('✅ [时钟管理器] 停止完成');
      } catch (error) {
        console.error('❌ [时钟管理器] 等待停止超时:', error);
        throw error;
      }
      return;
    }

    // 如果在错误状态，先尝试清理
    if (isEngineState(this.engineStateMachineActor, EngineState.ERROR)) {
      console.warn('⚠️  [时钟管理器] 引擎处于错误状态，发送STOP事件尝试清理');
    }

    console.log('🎛️ [EngineStateMachine] 委托给状态机: STOP');
    this.engineStateMachineActor.send({ type: 'STOP' });
  }
  
  /**
   * 销毁时钟管理器
   */
  async destroy(): Promise<void> {
    console.log('🗑️  [时钟管理器] 正在销毁...');
    await this.stop();
    
    // 清理PTT相关资源
    if (this.pttTimeoutId) {
      clearTimeout(this.pttTimeoutId);
      this.pttTimeoutId = null;
      console.log('🗑️  [时钟管理器] PTT计时器已清理');
    }
    
    // 销毁解码队列
    await this.realDecodeQueue.destroy();
    
    // 销毁编码队列
    await this.realEncodeQueue.destroy();
    
    // 清理 SlotPackManager
    await this.slotPackManager.cleanup();
    
    // 清理音频混音器
    if (this.audioMixer) {
      this.audioMixer.clear();
      this.audioMixer.removeAllListeners();
      console.log('🗑️  [时钟管理器] 音频混音器已清理');
    }
    
    // 销毁频谱调度器
    if (this.spectrumScheduler) {
      await this.spectrumScheduler.destroy();
      console.log('🗑️  [时钟管理器] 频谱调度器已销毁');
    }
    
    if (this.slotClock) {
      this.slotClock.removeAllListeners();
      this.slotClock = null;
    }
    
    this.slotScheduler = null;
    this.removeAllListeners();

    // 清理 RadioManager 事件监听器
    console.log(`🗑️  [时钟管理器] 移除 ${this.radioManagerEventListeners.size} 个 RadioManager 事件监听器`);
    for (const [eventName, handler] of this.radioManagerEventListeners.entries()) {
      this.radioManager.off(eventName as any, handler);
    }
    this.radioManagerEventListeners.clear();

    // 清理操作员管理器
    this.operatorManager.cleanup();
    
    // 清理传输跟踪器
    if (this.transmissionTracker) {
      this.transmissionTracker.cleanup();
      console.log('🗑️  [时钟管理器] 传输跟踪器已清理');
    }

    // 停止并清理状态机
    if (this.engineStateMachineActor) {
      console.log('🗑️  [时钟管理器] 停止引擎状态机...');
      this.engineStateMachineActor.stop();
      this.engineStateMachineActor = null;
      console.log('✅ [时钟管理器] 引擎状态机已停止');
    }

    // 取消注册内存泄漏检测
    MemoryLeakDetector.getInstance().unregister('DigitalRadioEngine');

    console.log('✅ [时钟管理器] 销毁完成');
  }

  /**
   * 获取所有可用模式
   */
  getAvailableModes(): ModeDescriptor[] {
    return Object.values(MODES);
  }

  /**
   * 设置音量增益（线性单位，向后兼容）
   */
  setVolumeGain(gain: number): void {
    this.audioStreamManager.setVolumeGain(gain);
    
    // 保存到配置文件
    const currentGain = this.audioStreamManager.getVolumeGain();
    const currentGainDb = this.audioStreamManager.getVolumeGainDb();
    ConfigManager.getInstance().updateLastVolumeGain(currentGain, currentGainDb).catch((error: any) => {
      console.warn('⚠️ [DigitalRadioEngine] 保存音量增益配置失败:', error);
    });
    
    // 广播音量变化事件，同时发送线性和dB值
    this.emit('volumeGainChanged', {
      gain: currentGain,
      gainDb: currentGainDb
    });
  }

  /**
   * 设置音量增益（dB单位）
   */
  setVolumeGainDb(gainDb: number): void {
    this.audioStreamManager.setVolumeGainDb(gainDb);
    
    // 保存到配置文件
    const currentGain = this.audioStreamManager.getVolumeGain();
    const currentGainDb = this.audioStreamManager.getVolumeGainDb();
    ConfigManager.getInstance().updateLastVolumeGain(currentGain, currentGainDb).catch((error: any) => {
      console.warn('⚠️ [DigitalRadioEngine] 保存音量增益配置失败:', error);
    });
    
    // 广播音量变化事件，同时发送线性和dB值
    this.emit('volumeGainChanged', {
      gain: currentGain,
      gainDb: currentGainDb
    });
  }

  /**
   * 获取当前音量增益（线性单位）
   */
  getVolumeGain(): number {
    return this.audioStreamManager.getVolumeGain();
  }

  /**
   * 获取当前音量增益（dB单位）
   */
  getVolumeGainDb(): number {
    return this.audioStreamManager.getVolumeGainDb();
  }

  /**
   * 启动PTT
   */
  private async startPTT(): Promise<void> {
    const pttStartTime = Date.now();
    console.log(`📡 [PTT] 开始启动PTT (${new Date(pttStartTime).toISOString()})`);
    
    if (this.isPTTActive) {
      console.log('📡 [PTT] PTT已经激活，跳过启动');
      return;
    }
    
    // 清除任何待定的PTT停止计时器
    if (this.pttTimeoutId) {
      clearTimeout(this.pttTimeoutId);
      this.pttTimeoutId = null;
    }
    
    if (this.radioManager.isConnected()) {
      try {
        console.log(`📡 [PTT] 调用radioManager.setPTT(true)...`);
        const radioCallStartTime = Date.now();
        
        await this.radioManager.setPTT(true);
        
        const radioCallEndTime = Date.now();
        const radioCallDuration = radioCallEndTime - radioCallStartTime;
        console.log(`📡 [PTT] radioManager.setPTT(true)完成，耗时: ${radioCallDuration}ms`);
        
        this.isPTTActive = true;

        // 通知频谱调度器PTT状态改变
        this.spectrumScheduler.setPTTActive(true);

        // 获取当前正在播放的操作员信息并发射PTT状态变化事件
        const currentAudio = this.audioMixer.getCurrentMixedAudio();
        const operatorIds = currentAudio ? currentAudio.operatorIds : [];
        this.emit('pttStatusChanged', {
          isTransmitting: true,
          operatorIds
        });
        console.log(`📡 [PTT] PTT状态广播: 开始发射, 操作员=[${operatorIds.join(', ')}]`);

        const pttEndTime = Date.now();
        const pttTotalDuration = pttEndTime - pttStartTime;
        console.log(`📡 [PTT] PTT启动成功，频谱分析已暂停，总耗时: ${pttTotalDuration}ms`);
      } catch (error) {
        console.error('📡 [PTT] PTT启动失败:', error);
        throw error;
      }
    } else {
      console.log('📡 [PTT] 电台未连接，跳过PTT启动');
    }
  }

  /**
   * 停止PTT
   */
  private async stopPTT(): Promise<void> {
    if (!this.isPTTActive) {
      console.log('📡 [PTT] PTT已经停止，跳过操作');
      return;
    }
    
    // 清除任何待定的PTT停止计时器
    if (this.pttTimeoutId) {
      clearTimeout(this.pttTimeoutId);
      this.pttTimeoutId = null;
    }
    
    if (this.radioManager.isConnected()) {
      try {
        await this.radioManager.setPTT(false);
        this.isPTTActive = false;

        // 通知频谱调度器PTT状态改变
        this.spectrumScheduler.setPTTActive(false);

        // 发射PTT停止事件
        this.emit('pttStatusChanged', {
          isTransmitting: false,
          operatorIds: []
        });
        console.log(`📡 [PTT] PTT状态广播: 停止发射`);

        console.log('📡 [PTT] PTT停止成功，频谱分析已恢复');
      } catch (error) {
        console.error('📡 [PTT] PTT停止失败:', error);
        // 即使停止失败，也要更新状态，避免状态不一致
        this.isPTTActive = false;
        this.spectrumScheduler.setPTTActive(false);
      }
    } else {
      this.isPTTActive = false;
      this.spectrumScheduler.setPTTActive(false);
      console.log('📡 [PTT] 电台未连接，更新PTT状态为停止，频谱分析已恢复');
    }
  }

  /**
   * 安排PTT停止
   */
  private schedulePTTStop(delayMs: number): void {
    // 清除任何现有的计时器
    if (this.pttTimeoutId) {
      clearTimeout(this.pttTimeoutId);
    }
    
    console.log(`📡 [PTT] 安排 ${delayMs}ms 后停止PTT`);
    
    this.pttTimeoutId = setTimeout(async () => {
      this.pttTimeoutId = null;
      await this.stopPTT();
    }, delayMs);
  }

  /**
   * 设置物理电台管理器事件监听器
   */
  private setupRadioManagerEventListeners(): void {
    // 监听电台连接成功
    const handleConnected = async () => {
      console.log('📡 [DigitalRadioEngine] 物理电台连接成功');

      // 获取完整的电台信息和配置
      const radioInfo = await this.radioManager.getRadioInfo();
      const radioConfig = this.radioManager.getConfig();

      // 广播电台状态更新事件
      this.emit('radioStatusChanged' as any, {
        connected: true,
        radioInfo,
        radioConfig,
        reconnectInfo: this.radioManager.getReconnectInfo()
      });

      // 连接成功后自动设置频率（根据配置中保存的最后频率）
      try {
        const lastFrequency = ConfigManager.getInstance().getLastSelectedFrequency();
        if (lastFrequency && lastFrequency.frequency) {
          console.log(`📡 [DigitalRadioEngine] 自动设置频率: ${(lastFrequency.frequency / 1000000).toFixed(3)} MHz (${lastFrequency.description || lastFrequency.mode})`);
          await this.radioManager.setFrequency(lastFrequency.frequency);
        } else {
          console.log('ℹ️ [DigitalRadioEngine] 未找到保存的频率配置，跳过自动设置');
        }
      } catch (err) {
        console.error('❌ [DigitalRadioEngine] 自动设置频率失败:', err);
        // 频率设置失败不影响后续流程
      }

      // 重连成功后自动启动系统（仅在真正重连时，不在首次启动时）
      const reconnectInfo = this.radioManager.getReconnectInfo();
      if (!this.isRunning && reconnectInfo.reconnectAttempts > 0) {
        console.log('🚀 [DigitalRadioEngine] 重连成功，自动启动系统');
        try {
          await this.start();
        } catch (err) {
          console.error('❌ [DigitalRadioEngine] 自动启动失败:', err);
        }
      }
    };
    this.radioManagerEventListeners.set('connected', handleConnected);
    this.radioManager.on('connected', handleConnected);

    // 监听电台断开连接
    const handleDisconnected = async (reason?: string) => {
      console.log(`📡 [DigitalRadioEngine] 物理电台断开连接: ${reason || '未知原因'}`);

      // 立即停止所有操作员的发射
      this.operatorManager.stopAllOperators();

      // 如果是在PTT激活时断开连接，立即停止PTT并停止引擎
      if (this.isPTTActive) {
        console.warn('⚠️ [DigitalRadioEngine] 电台在发射过程中断开连接，立即停止发射和监听');

        // 强制停止PTT
        await this.forceStopPTT();

        // 【状态机集成】发送RADIO_DISCONNECTED事件触发状态机停止
        if (this.engineStateMachineActor && isEngineState(this.engineStateMachineActor, EngineState.RUNNING)) {
          console.log('🎛️ [EngineStateMachine] 发送 RADIO_DISCONNECTED 事件');
          this.engineStateMachineActor.send({
            type: 'RADIO_DISCONNECTED',
            reason: reason || '电台在发射过程中断开连接'
          });
        }

        // 广播特殊的发射中断开连接事件
        this.emit('radioDisconnectedDuringTransmission' as any, {
          reason: reason || '电台在发射过程中断开连接',
          message: '电台在发射过程中断开连接，可能是发射功率过大导致USB通讯受到干扰。系统已自动停止发射和监听。',
          recommendation: '请检查电台设置，降低发射功率或改善通讯环境，然后重新连接电台。'
        });
      } else if (this.isRunning) {
        // 【状态机集成】非PTT激活时断开，也应该停止引擎
        console.warn('⚠️ [DigitalRadioEngine] 电台断开连接，自动停止引擎');

        if (this.engineStateMachineActor && isEngineState(this.engineStateMachineActor, EngineState.RUNNING)) {
          console.log('🎛️ [EngineStateMachine] 发送 RADIO_DISCONNECTED 事件');
          this.engineStateMachineActor.send({
            type: 'RADIO_DISCONNECTED',
            reason: reason || '电台断开连接'
          });
        }
      }

      // 广播电台状态更新事件（带用户指导）
      this.emit('radioStatusChanged' as any, {
        connected: false,
        radioInfo: null, // 断开时清空电台信息
        radioConfig: this.radioManager.getConfig(), // 保留配置信息
        reason,
        message: '电台已断开连接',
        recommendation: this.getDisconnectRecommendation(reason),
        reconnectInfo: this.radioManager.getReconnectInfo()
      });
    };
    this.radioManagerEventListeners.set('disconnected', handleDisconnected);
    this.radioManager.on('disconnected', handleDisconnected);


    // 监听电台错误
    const handleError = (error: Error) => {
      console.error(`📡 [DigitalRadioEngine] 物理电台错误: ${error.message}`);
      // 广播电台错误事件
      this.emit('radioError' as any, {
        error: error.message,
        reconnectInfo: this.radioManager.getReconnectInfo()
      });
    };
    this.radioManagerEventListeners.set('error', handleError);
    this.radioManager.on('error', handleError);

    // 监听电台数值表数据
    const handleMeterData = (data: any) => {
      // 📝 EventBus 优化：数值表数据已通过 EventBus 直达 WSServer（IcomWlanConnection.ts:321）
      // 此处仅保留健康检查逻辑，不再转发事件

      // 【采样监控】每100次检查一次健康状态
      this.meterEventCount++;
      if (this.meterEventCount % 100 === 0) {
        this.checkHighFrequencyEventsHealth();
      }
    };
    this.radioManagerEventListeners.set('meterData', handleMeterData);
    this.radioManager.on('meterData' as any, handleMeterData);

    // 监听电台频率变化（自动同步）
    const handleRadioFrequencyChanged = async (frequency: number) => {
      console.log(`📡 [DigitalRadioEngine] 检测到电台频率变化: ${(frequency / 1000000).toFixed(3)} MHz`);

      try {
        // 1. 查找匹配的预设频率（容差 500 Hz）
        const matchResult = this.frequencyManager.findMatchingPreset(frequency, 500);

        let frequencyInfo: {
          frequency: number;
          mode: string;
          band: string;
          radioMode?: string;
          description: string;
        };

        if (matchResult.preset) {
          // 匹配到预设频率
          console.log(`✅ [DigitalRadioEngine] 匹配到预设频率: ${matchResult.preset.description}`);
          frequencyInfo = {
            frequency: matchResult.preset.frequency,
            mode: matchResult.preset.mode,
            band: matchResult.preset.band,
            radioMode: matchResult.preset.radioMode,
            description: matchResult.preset.description || `${(matchResult.preset.frequency / 1000000).toFixed(3)} MHz`
          };
        } else {
          // 自定义频率
          console.log(`🔧 [DigitalRadioEngine] 未匹配预设，设为自定义频率`);
          frequencyInfo = {
            frequency: frequency,
            mode: 'FT8', // 默认模式
            band: 'Custom',
            description: `自定义 ${(frequency / 1000000).toFixed(3)} MHz`
          };
        }

        // 2. 更新配置管理器
        const configManager = ConfigManager.getInstance();
        configManager.updateLastSelectedFrequency({
          frequency: frequencyInfo.frequency,
          mode: frequencyInfo.mode,
          radioMode: frequencyInfo.radioMode,
          band: frequencyInfo.band,
          description: frequencyInfo.description
        });

        // 3. 清空历史解码数据
        this.slotPackManager.clearInMemory();
        console.log(`🧹 [DigitalRadioEngine] 已清空历史解码数据`);

        // 4. 广播频率变化事件
        this.emit('frequencyChanged', {
          frequency: frequencyInfo.frequency,
          mode: frequencyInfo.mode,
          band: frequencyInfo.band,
          radioMode: frequencyInfo.radioMode,
          description: frequencyInfo.description,
          radioConnected: true
        });

        console.log(`📡 [DigitalRadioEngine] 频率自动同步完成: ${frequencyInfo.description}`);
      } catch (error) {
        console.error(`❌ [DigitalRadioEngine] 处理频率变化失败:`, error);
      }
    };
    this.radioManagerEventListeners.set('radioFrequencyChanged', handleRadioFrequencyChanged);
    this.radioManager.on('radioFrequencyChanged', handleRadioFrequencyChanged);

    console.log(`📡 [DigitalRadioEngine] 已注册 ${this.radioManagerEventListeners.size} 个 RadioManager 事件监听器`);
  }

  /**
   * 清理所有事件监听器 (Day7)
   *
   * 在引擎停止时调用，确保所有监听器被正确移除，防止内存泄漏
   * 按照以下顺序清理：
   * 1. SlotClock 事件监听器
   * 2. 编解码队列事件监听器
   * 3. 音频混音器事件监听器
   * 4. SlotPackManager 事件监听器
   * 5. SpectrumScheduler 事件监听器
   * 6. RadioManager 事件监听器（已有专门的 Map 管理）
   */
  private cleanupEventListeners(): void {
    console.log('🧹 [DigitalRadioEngine] 开始清理所有事件监听器...');

    let totalRemoved = 0;

    try {
      // 1. 清理 SlotClock 事件监听器
      if (this.slotClock) {
        const clockEvents = ['slotStart', 'encodeStart', 'transmitStart', 'subWindow'];
        for (const event of clockEvents) {
          this.slotClock.removeAllListeners(event as any);
        }
        totalRemoved += clockEvents.length;
        console.log(`   ✓ 已清理 ${clockEvents.length} 个 SlotClock 事件监听器`);
      }

      // 2. 清理编解码队列事件监听器
      if (this.realEncodeQueue) {
        const encodeEvents = ['encodeComplete', 'encodeError'];
        for (const event of encodeEvents) {
          this.realEncodeQueue.removeAllListeners(event as any);
        }
        totalRemoved += encodeEvents.length;
        console.log(`   ✓ 已清理 ${encodeEvents.length} 个 EncodeQueue 事件监听器`);
      }

      if (this.realDecodeQueue) {
        const decodeEvents = ['decodeComplete', 'decodeError'];
        for (const event of decodeEvents) {
          this.realDecodeQueue.removeAllListeners(event as any);
        }
        totalRemoved += decodeEvents.length;
        console.log(`   ✓ 已清理 ${decodeEvents.length} 个 DecodeQueue 事件监听器`);
      }

      // 3. 清理音频混音器事件监听器
      if (this.audioMixer) {
        this.audioMixer.removeAllListeners('mixedAudioReady');
        totalRemoved += 1;
        console.log(`   ✓ 已清理 1 个 AudioMixer 事件监听器`);
      }

      // 4. 清理 SlotPackManager 事件监听器
      if (this.slotPackManager) {
        this.slotPackManager.removeAllListeners('slotPackUpdated');
        totalRemoved += 1;
        console.log(`   ✓ 已清理 1 个 SlotPackManager 事件监听器`);
      }

      // 5. 清理 SpectrumScheduler 事件监听器
      if (this.spectrumScheduler) {
        const spectrumEvents = ['spectrumReady', 'error'];
        for (const event of spectrumEvents) {
          this.spectrumScheduler.removeAllListeners(event as any);
        }
        totalRemoved += spectrumEvents.length;
        console.log(`   ✓ 已清理 ${spectrumEvents.length} 个 SpectrumScheduler 事件监听器`);
      }

      // 6. 清理 RadioManager 事件监听器（使用已有的 Map）
      if (this.radioManagerEventListeners.size > 0) {
        for (const [eventName, handler] of this.radioManagerEventListeners.entries()) {
          this.radioManager.off(eventName as any, handler);
        }
        const radioListenersCount = this.radioManagerEventListeners.size;
        this.radioManagerEventListeners.clear();
        totalRemoved += radioListenersCount;
        console.log(`   ✓ 已清理 ${radioListenersCount} 个 RadioManager 事件监听器`);
      }

      // 7. 清理 self 上的 transmissionLog 事件监听器
      this.removeAllListeners('transmissionLog' as any);
      totalRemoved += 1;
      console.log(`   ✓ 已清理 1 个 self transmissionLog 事件监听器`);

      console.log(`✅ [DigitalRadioEngine] 事件监听器清理完成，共清理 ${totalRemoved} 个监听器`);
    } catch (error) {
      console.error(`❌ [DigitalRadioEngine] 清理事件监听器时出错:`, error);
      // 继续执行，不中断停止流程
    }
  }

  /**
   * 注册所有资源到 ResourceManager (Day6)
   *
   * 资源按优先级和依赖关系启动，失败时自动回滚
   */
  private registerResources(): void {
    console.log('📦 [ResourceManager] 注册引擎资源...');

    const configManager = ConfigManager.getInstance();

    // 1. 物理电台 (优先级最高，最先启动)
    this.resourceManager.register({
      name: 'radio',
      start: async () => {
        const radioConfig = configManager.getRadioConfig();
        if (radioConfig.type === 'none') {
          console.log('📡 [ResourceManager] 无电台模式，跳过电台初始化');
          return;
        }
        console.log(`📡 [ResourceManager] 应用物理电台配置:`, radioConfig);
        await this.radioManager.applyConfig(radioConfig);
      },
      stop: async () => {
        if (this.radioManager.isConnected()) {
          await this.radioManager.disconnect('引擎停止');
        }
      },
      priority: 1,
      optional: true,
    });

    // 2. ICOM WLAN 音频适配器 (仅在 ICOM WLAN 模式下需要)
    this.resourceManager.register({
      name: 'icomWlanAudioAdapter',
      start: async () => {
        const radioConfig = configManager.getRadioConfig();
        if (radioConfig.type !== 'icom-wlan') {
          console.log('ℹ️ [ResourceManager] 非 ICOM WLAN 模式，跳过适配器初始化');
          return;
        }

        console.log(`📡 [ResourceManager] 初始化 ICOM WLAN 音频适配器`);
        const icomWlanManager = this.radioManager.getIcomWlanManager();
        if (!icomWlanManager || !icomWlanManager.isConnected()) {
          console.warn(`⚠️ [ResourceManager] ICOM WLAN 电台未连接，将回退到普通声卡输入`);
          return;
        }

        this.icomWlanAudioAdapter = new IcomWlanAudioAdapter(icomWlanManager);
        this.audioStreamManager.setIcomWlanAudioAdapter(this.icomWlanAudioAdapter);

        // 设置回调让 AudioDeviceManager 知道连接状态
        const audioDeviceManager = AudioDeviceManager.getInstance();
        audioDeviceManager.setIcomWlanConnectedCallback(() => {
          return icomWlanManager.isConnected();
        });

        console.log(`✅ [ResourceManager] ICOM WLAN 音频适配器已初始化`);
      },
      stop: async () => {
        if (this.icomWlanAudioAdapter) {
          this.icomWlanAudioAdapter.stopReceiving();
          this.audioStreamManager.setIcomWlanAudioAdapter(null);
          this.icomWlanAudioAdapter = null;
          console.log(`🛑 [ResourceManager] ICOM WLAN 音频适配器已清理`);
        }
      },
      priority: 2,
      dependencies: [],
      optional: true, // 可选资源，仅 ICOM WLAN 模式需要
    });

    // 3. 音频输入流
    this.resourceManager.register({
      name: 'audioInputStream',
      start: async () => {
        await this.audioStreamManager.startStream();
        console.log(`🎤 [ResourceManager] 音频输入流启动成功`);
      },
      stop: async () => {
        await this.audioStreamManager.stopStream();
        console.log(`🛑 [ResourceManager] 音频输入流已停止`);
      },
      priority: 3,
      dependencies: [],
      optional: false,
    });

    // 4. 音频输出流
    this.resourceManager.register({
      name: 'audioOutputStream',
      start: async () => {
        await this.audioStreamManager.startOutput();
        console.log(`🔊 [ResourceManager] 音频输出流启动成功`);

        // 恢复上次设置的音量增益
        const lastVolumeGain = configManager.getLastVolumeGain();
        if (lastVolumeGain) {
          console.log(`🔊 [ResourceManager] 恢复上次音量增益: ${lastVolumeGain.gainDb.toFixed(1)}dB`);
          this.audioStreamManager.setVolumeGainDb(lastVolumeGain.gainDb);
        } else {
          console.log(`🔊 [ResourceManager] 使用默认音量增益: 0.0dB`);
        }
      },
      stop: async () => {
        await this.audioStreamManager.stopOutput();
        console.log(`🛑 [ResourceManager] 音频输出流已停止`);
      },
      priority: 4,
      dependencies: ['audioInputStream'],
      optional: false,
    });

    // 5. 音频监听服务
    this.resourceManager.register({
      name: 'audioMonitorService',
      start: async () => {
        console.log('🎧 [ResourceManager] 初始化音频监听服务...');
        const audioProvider = this.audioStreamManager.getAudioProvider();
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
    this.resourceManager.register({
      name: 'clock',
      start: async () => {
        if (!this.slotClock) {
          throw new Error('时钟未初始化');
        }
        this.slotClock.start();
        console.log(`📡 [ResourceManager] 时钟已启动`);
      },
      stop: async () => {
        if (this.slotClock) {
          this.slotClock.stop();
          // 确保PTT被停止
          await this.stopPTT();
          console.log(`🛑 [ResourceManager] 时钟已停止`);
        }
      },
      priority: 6,
      dependencies: ['audioOutputStream'],
      optional: false,
    });

    // 7. 解码调度器
    this.resourceManager.register({
      name: 'slotScheduler',
      start: async () => {
        if (this.slotScheduler) {
          this.slotScheduler.start();
          console.log(`📡 [ResourceManager] 解码调度器已启动`);
        }
      },
      stop: async () => {
        if (this.slotScheduler) {
          this.slotScheduler.stop();
          console.log(`🛑 [ResourceManager] 解码调度器已停止`);
        }
      },
      priority: 7,
      dependencies: ['clock'],
      optional: false,
    });

    // 8. 频谱调度器
    this.resourceManager.register({
      name: 'spectrumScheduler',
      start: async () => {
        if (this.spectrumScheduler) {
          this.spectrumScheduler.start();
          console.log(`📊 [ResourceManager] 频谱分析调度器已启动`);
        }
      },
      stop: async () => {
        if (this.spectrumScheduler) {
          this.spectrumScheduler.stop();
          console.log(`🛑 [ResourceManager] 频谱分析调度器已停止`);
        }
      },
      priority: 8,
      dependencies: ['clock'],
      optional: false,
    });

    // 9. 操作员管理器
    this.resourceManager.register({
      name: 'operatorManager',
      start: async () => {
        this.operatorManager.start();
        console.log(`📡 [ResourceManager] 操作员管理器已启动`);
      },
      stop: async () => {
        this.operatorManager.stop();
        console.log(`🛑 [ResourceManager] 操作员管理器已停止`);
      },
      priority: 9,
      dependencies: ['clock'],
      optional: false,
    });

    console.log('✅ [ResourceManager] 所有资源已注册');
  }

  /**
   * 初始化引擎状态机 (XState v5)
   */
  private initializeEngineStateMachine(): void {
    console.log('🎛️ [EngineStateMachine] 初始化引擎状态机...');

    // 创建状态机输入回调
    const engineInput: EngineInput = {
      // 启动回调 - 执行实际的引擎启动逻辑
      onStart: async () => {
        console.log('🚀 [EngineStateMachine] 执行启动操作');
        await this.doStart();
      },

      // 停止回调 - 执行实际的引擎停止逻辑
      onStop: async () => {
        console.log('🛑 [EngineStateMachine] 执行停止操作');
        await this.doStop();
      },

      // 错误回调 - 处理状态机错误
      onError: (error) => {
        console.error('❌ [EngineStateMachine] 状态机错误:', error);
        // 错误已经通过Manager事件系统广播,这里只记录日志
      },

      // 状态变化回调 - 广播状态变化
      onStateChange: (state, context) => {
        console.log(`🔄 [EngineStateMachine] 状态变化: ${state}`, {
          error: context.error?.message,
          forcedStop: context.forcedStop,
          startedResources: context.startedResources,
        });

        // 发送systemStatus事件保持向后兼容
        const status = this.getStatus();
        this.emit('systemStatus', status);
      },
    };

    // 创建并启动状态机actor
    this.engineStateMachineActor = createEngineActor(engineInput, {
      devTools: process.env.NODE_ENV === 'development',
    });
    this.engineStateMachineActor.start();

    console.log('✅ [EngineStateMachine] 引擎状态机已初始化');
  }

  /**
   * 执行实际的引擎启动逻辑（由状态机调用）
   * 使用 ResourceManager 管理资源启动，失败时自动回滚 (Day6)
   * @private
   */
  private async doStart(): Promise<void> {
    if (!this.slotClock) {
      throw new Error('时钟管理器未初始化');
    }

    console.log(`🚀 [时钟管理器] 启动引擎，模式: ${this.currentMode.name}`);

    try {
      // 使用 ResourceManager 启动所有资源
      // 按优先级和依赖关系顺序启动，失败时自动回滚
      await this.resourceManager.startAll();

      // 设置状态标志
      this.isRunning = true;
      this.audioStarted = true;

      console.log(`✅ [时钟管理器] 引擎启动完成`);
    } catch (error) {
      console.error(`❌ [时钟管理器] 引擎启动失败:`, error);
      // ResourceManager 已自动回滚所有已启动的资源
      throw error;
    }
  }

  /**
   * 执行实际的引擎停止逻辑（由状态机调用）
   * 使用 ResourceManager 管理资源停止，按逆序清理 (Day6)
   * @private
   */
  private async doStop(): Promise<void> {
    console.log('🛑 [时钟管理器] 停止引擎');

    try {
      // 1. 先清理所有事件监听器（Day7）
      // 这样可以避免在停止过程中触发不必要的事件处理
      this.cleanupEventListeners();

      // 2. 使用 ResourceManager 停止所有资源
      // 按启动的逆序停止，确保依赖关系正确
      await this.resourceManager.stopAll();

      // 3. 清除状态标志
      this.isRunning = false;
      this.audioStarted = false;

      console.log(`✅ [时钟管理器] 引擎停止完成`);
    } catch (error) {
      console.error(`❌ [时钟管理器] 引擎停止失败:`, error);
      // 即使停止失败，也要清除状态标志
      this.isRunning = false;
      this.audioStarted = false;
      throw error;
    }
  }

  /**
   * 强制停止PTT（在时隙切换时调用）
   */
  private async forceStopPTT(): Promise<void> {
    if (this.isPTTActive) {
      console.log('📡 [PTT] 强制停止PTT（时隙切换）');
      await this.stopPTT();
    }
  }

  /**
   * 强制停止当前发射（公开方法）
   * 立即停止PTT并清空音频播放队列
   * 用于用户主动中断发射周期
   */
  public async forceStopTransmission(): Promise<void> {
    console.log('🛑 [DigitalRadioEngine] 强制停止发射');

    try {
      // 1. 停止当前音频播放
      const stoppedBytes = await this.audioStreamManager.stopCurrentPlayback();
      console.log(`🛑 [DigitalRadioEngine] 已停止音频播放，丢弃 ${stoppedBytes} 字节`);

      // 2. 立即停止PTT
      await this.forceStopPTT();

      // 3. 清空音频混音器队列
      this.audioMixer.clear();
      console.log('🛑 [DigitalRadioEngine] 已清空音频混音器队列');

      console.log('✅ [DigitalRadioEngine] 强制停止发射完成');
    } catch (error) {
      console.error('❌ [DigitalRadioEngine] 强制停止发射失败:', error);
      throw error;
    }
  }

  /**
   * 检测是否需要触发重新混音
   * 条件: 1. 音频正在播放  2. 混音器有当前混音音频  3. 有新的待混音音频
   */
  private shouldTriggerRemix(): boolean {
    // 检查音频是否正在播放
    const isAudioPlaying = this.audioStreamManager.isPlaying();

    // 检查混音器状态
    const mixerStatus = this.audioMixer.getStatus();

    // 条件判断
    const shouldRemix = isAudioPlaying && mixerStatus.pendingCount > 0;

    if (shouldRemix) {
      console.log(`🔄 [重新混音检测] 满足重新混音条件:`);
      console.log(`   音频播放中: ${isAudioPlaying}`);
      console.log(`   待混音音频数: ${mixerStatus.pendingCount}`);
      console.log(`   待混音操作员: [${mixerStatus.operatorIds.join(', ')}]`);
    }

    return shouldRemix;
  }

  /**
   * 检查高频事件健康状态（采样监控）
   * 每100次高频事件调用一次，避免性能影响
   */
  private checkHighFrequencyEventsHealth(): void {
    const now = Date.now();
    const timeSinceLastCheck = now - this.lastHealthCheckTimestamp;

    // 只有运行状态才进行健康检查
    if (!this.isRunning) {
      return;
    }

    // 至少间隔10秒才检查一次（避免过于频繁）
    if (timeSinceLastCheck < 10000) {
      return;
    }

    // 检查电台连接健康状态（如果长时间没有meter事件，可能是连接问题）
    const radioConnected = this.radioManager.isConnected();
    if (!radioConnected && this.isRunning) {
      console.warn('⚠️ [健康检查] 电台未连接，但引擎处于运行状态');
    }

    // 检查高频事件频率是否异常
    const spectrumRate = timeSinceLastCheck > 0 ? (this.spectrumEventCount / timeSinceLastCheck) * 1000 : 0;
    const meterRate = timeSinceLastCheck > 0 ? (this.meterEventCount / timeSinceLastCheck) * 1000 : 0;

    // 如果频谱事件频率异常低（<1Hz），可能有问题
    if (spectrumRate < 1 && this.isRunning) {
      console.warn(`⚠️ [健康检查] 频谱事件频率异常低: ${spectrumRate.toFixed(2)} Hz`);
    }

    // 如果数值表事件频率异常低（<0.5Hz），可能有问题
    if (meterRate < 0.5 && this.isRunning && radioConnected) {
      console.warn(`⚠️ [健康检查] 数值表事件频率异常低: ${meterRate.toFixed(2)} Hz`);
    }

    // 输出采样统计
    console.log(`📊 [健康检查] 高频事件采样统计 (${(timeSinceLastCheck / 1000).toFixed(1)}秒):`);
    console.log(`   频谱事件: ${this.spectrumEventCount} 次 (${spectrumRate.toFixed(1)} Hz)`);
    console.log(`   数值表事件: ${this.meterEventCount} 次 (${meterRate.toFixed(1)} Hz)`);

    // 重置计数器
    this.spectrumEventCount = 0;
    this.meterEventCount = 0;
    this.lastHealthCheckTimestamp = now;
  }

  /**
   * 根据断开原因生成用户友好的解决建议
   */
  private getDisconnectRecommendation(reason?: string): string {
    // 如果没有原因信息，返回通用建议
    if (!reason) {
      return '请检查电台是否开机，网络连接是否正常，然后尝试重新连接。';
    }

    const reasonLower = reason.toLowerCase();

    // USB通信相关错误
    if (reasonLower.includes('usb') || reasonLower.includes('通讯') || reasonLower.includes('通信')) {
      return '可能是USB通讯不稳定。请检查USB线缆连接，尝试更换USB端口或使用更短的USB线。';
    }

    // 网络相关错误 (ICOM WLAN)
    if (reasonLower.includes('network') || reasonLower.includes('网络') || reasonLower.includes('timeout') || reasonLower.includes('超时')) {
      return '可能是网络连接问题。请检查WiFi连接，确认电台和电脑在同一网络，检查防火墙设置。';
    }

    // 用户主动断开
    if (reasonLower.includes('disconnect()') || reasonLower.includes('用户') || reasonLower.includes('手动')) {
      return '连接已按要求断开。如需重新连接，请点击"连接电台"按钮。';
    }

    // 超时相关
    if (reasonLower.includes('timeout') || reasonLower.includes('超时') || reasonLower.includes('timed out')) {
      return '连接超时。请检查电台是否开机，网络或串口连接是否正常，然后重试。';
    }

    // IO错误
    if (reasonLower.includes('io error') || reasonLower.includes('i/o') || reasonLower.includes('设备')) {
      return '设备IO错误。请检查电台连接（USB/网络），确认电台开机并工作正常，然后重新连接。';
    }

    // 发射功率相关
    if (reasonLower.includes('功率') || reasonLower.includes('power') || reasonLower.includes('干扰')) {
      return '可能是发射功率过大导致干扰。请降低发射功率（建议50W以下），改善通讯环境，然后重新连接。';
    }

    // 通用建议
    return `连接已断开（${reason}）。请检查电台连接和设置，然后尝试重新连接。`;
  }
}
