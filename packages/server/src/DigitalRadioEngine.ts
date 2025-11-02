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

  // 编码状态跟踪（用于检测编码超时）
  private currentSlotExpectedEncodes: number = 0; // 当前时隙期望的编码数量
  private currentSlotCompletedEncodes: number = 0; // 当前时隙已完成的编码数量
  private currentSlotId: string = ''; // 当前时隙ID

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
      // 发射频谱数据事件给WebSocket客户端
      this.emit('spectrumData', spectrum);
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
   * 启动时钟
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('⚠️  [时钟管理器] 时钟已经在运行中，发送状态同步');
      // 即使重复调用也发射状态事件确保前端同步
      const status = this.getStatus();
      console.log(`📡 [时钟管理器] 发射systemStatus事件(重复调用): isRunning=${status.isRunning}, isDecoding=${status.isDecoding}`);
      this.emit('systemStatus', status);
      return;
    }
    
    if (!this.slotClock) {
      throw new Error('时钟管理器未初始化');
    }
    
    console.log(`🚀 [时钟管理器] 启动时钟，模式: ${this.currentMode.name}`);

    // 启动音频流
    let audioStarted = false;
    try {
      // 从配置管理器获取音频设备设置
      const configManager = ConfigManager.getInstance();
      const audioConfig = configManager.getAudioConfig();
      const radioConfig = configManager.getRadioConfig();

      console.log(`🎤 [时钟管理器] 使用音频设备配置:`, audioConfig);

      // 先连接物理电台（如果配置）- ICOM WLAN 模式需要先建立连接
      await this.radioManager.applyConfig(radioConfig);
      console.log(`📡 [时钟管理器] 物理电台配置已应用:`, radioConfig);

      // 等待短暂时间，确保任何延迟错误被触发（例如网络超时）
      await new Promise(resolve => setTimeout(resolve, 200));

      // 如果配置为 ICOM WLAN 模式，初始化音频适配器
      if (radioConfig.type === 'icom-wlan') {
        console.log(`📡 [时钟管理器] 检测到 ICOM WLAN 模式，初始化音频适配器`);

        const icomWlanManager = this.radioManager.getIcomWlanManager();
        if (icomWlanManager && icomWlanManager.isConnected()) {
          // 创建 ICOM WLAN 音频适配器（原生 12kHz，零重采样优化）
          this.icomWlanAudioAdapter = new IcomWlanAudioAdapter(
            icomWlanManager
          );

          // 注入到 AudioStreamManager
          this.audioStreamManager.setIcomWlanAudioAdapter(this.icomWlanAudioAdapter);

          // 设置回调让 AudioDeviceManager 知道连接状态
          const audioDeviceManager = AudioDeviceManager.getInstance();
          audioDeviceManager.setIcomWlanConnectedCallback(() => {
            return icomWlanManager.isConnected();
          });

          console.log(`✅ [时钟管理器] ICOM WLAN 音频适配器已初始化`);
        } else {
          console.warn(`⚠️ [时钟管理器] ICOM WLAN 未连接，音频适配器未初始化`);
          throw new Error('ICOM WLAN 电台连接失败，无法启动音频流');
        }
      }

      // 启动音频输入 - 不需要传递设备ID，AudioStreamManager会从配置中自动解析设备名称
      await this.audioStreamManager.startStream();
      console.log(`🎤 [时钟管理器] 音频输入流启动成功`);

      // 启动音频输出 - 不需要传递设备ID，AudioStreamManager会从配置中自动解析设备名称
      await this.audioStreamManager.startOutput();
      console.log(`🔊 [时钟管理器] 音频输出流启动成功`);

      // 恢复上次设置的音量增益
      const lastVolumeGain = configManager.getLastVolumeGain();
      if (lastVolumeGain) {
        console.log(`🔊 [时钟管理器] 恢复上次设置的音量增益: ${lastVolumeGain.gainDb.toFixed(1)}dB (${lastVolumeGain.gain.toFixed(3)})`);
        // 直接设置到 audioStreamManager，不触发保存逻辑避免递归
        this.audioStreamManager.setVolumeGainDb(lastVolumeGain.gainDb);
      } else {
        console.log(`🔊 [时钟管理器] 使用默认音量增益: 0.0dB (1.000)`);
      }

      audioStarted = true;
    } catch (error) {
      console.error(`❌ [时钟管理器] 音频流启动失败:`, error);

      // 清理可能残留的连接，确保状态一致
      try {
        console.log('🧹 [时钟管理器] 清理电台连接...');
        await this.radioManager.disconnect('启动失败，清理连接');
      } catch (cleanupError) {
        console.warn('⚠️ [时钟管理器] 清理电台连接时出错:', cleanupError);
      }

      // 电台连接失败时停止启动，让重连机制接管
      throw error;
    }
    
    this.slotClock.start();
    
    // 启动 SlotScheduler
    if (this.slotScheduler) {
      this.slotScheduler.start();
      console.log(`📡 [时钟管理器] 启动解码调度器`);
    }
    
    // 启动频谱调度器
    if (this.spectrumScheduler) {
      this.spectrumScheduler.start();
      console.log(`📊 [时钟管理器] 启动频谱分析调度器`);
    }
    
    // 启动操作员管理器
    this.operatorManager.start();
    
    this.isRunning = true;
    this.audioStarted = audioStarted;
    
    // 发射系统状态变化事件
    const status = this.getStatus();
    console.log(`📡 [时钟管理器] 发射systemStatus事件: isRunning=${status.isRunning}, isDecoding=${status.isDecoding}`);
    this.emit('systemStatus', status);
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
   * 获取当前状态
   */
  public getStatus() {
    // 统一 isDecoding 语义：只有当引擎运行且时钟正在运行时才表示正在解码
    const isActuallyDecoding = this.isRunning && (this.slotClock?.isRunning ?? false);
    
    return {
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
      radioReconnectInfo: this.radioManager.getReconnectInfo()
    };
  }
  
  /**
   * 停止时钟
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      console.log('⚠️  [时钟管理器] 时钟已经停止，发送状态同步');
      // 即使重复调用也发射状态事件确保前端同步
      const status = this.getStatus();
      console.log(`📡 [时钟管理器] 发射systemStatus事件(重复调用): isRunning=${status.isRunning}, isDecoding=${status.isDecoding}`);
      this.emit('systemStatus', status);
      return;
    }
    
    if (this.slotClock) {
      console.log('🛑 [时钟管理器] 停止时钟');
      this.slotClock.stop();
      
      // 确保PTT被停止
      await this.stopPTT();
      
      // 停止 SlotScheduler
      if (this.slotScheduler) {
        this.slotScheduler.stop();
        console.log(`🛑 [时钟管理器] 停止解码调度器`);
      }
      
      // 停止音频流
      try {
        await this.audioStreamManager.stopStream();
        console.log(`🛑 [时钟管理器] 音频输入流停止成功`);

        await this.audioStreamManager.stopOutput();
        console.log(`🛑 [时钟管理器] 音频输出流停止成功`);

        // 断开物理电台
        await this.radioManager.disconnect();
        console.log(`🛑 [时钟管理器] 物理电台已断开`);
      } catch (error) {
        console.error(`❌ [时钟管理器] 音频流停止失败:`, error);
      }

      // 清理 ICOM WLAN 音频适配器
      if (this.icomWlanAudioAdapter) {
        this.icomWlanAudioAdapter.stopReceiving();
        this.audioStreamManager.setIcomWlanAudioAdapter(null);
        this.icomWlanAudioAdapter = null;
        console.log(`🛑 [时钟管理器] ICOM WLAN 音频适配器已清理`);
      }

      this.isRunning = false;
      this.audioStarted = false;
      
      // 停止频谱调度器
      if (this.spectrumScheduler) {
        this.spectrumScheduler.stop();
        console.log(`🛑 [时钟管理器] 停止频谱分析调度器`);
      }

      // 停止操作员管理器
      this.operatorManager.stop();
      
      // 发射系统状态变化事件
      const status = this.getStatus();
      console.log(`📡 [时钟管理器] 发射systemStatus事件: isRunning=${status.isRunning}, isDecoding=${status.isDecoding}`);
      this.emit('systemStatus', status);
    }
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
    
    // 清理操作员管理器
    this.operatorManager.cleanup();
    
    // 清理传输跟踪器
    if (this.transmissionTracker) {
      this.transmissionTracker.cleanup();
      console.log('🗑️  [时钟管理器] 传输跟踪器已清理');
    }
    
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
    this.radioManager.on('connected', async () => {
      console.log('📡 [DigitalRadioEngine] 物理电台连接成功');
      // 广播电台状态更新事件
      this.emit('radioStatusChanged' as any, {
        connected: true,
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
    });

    // 监听电台断开连接
    this.radioManager.on('disconnected', async (reason) => {
      console.log(`📡 [DigitalRadioEngine] 物理电台断开连接: ${reason || '未知原因'}`);
      
      // 立即停止所有操作员的发射
      this.operatorManager.stopAllOperators();
      
      // 如果是在PTT激活时断开连接，立即停止PTT并停止引擎
      if (this.isPTTActive) {
        console.warn('⚠️ [DigitalRadioEngine] 电台在发射过程中断开连接，立即停止发射和监听');
        
        // 强制停止PTT
        await this.forceStopPTT();
        
        // 停止引擎以防止继续尝试发射
        if (this.isRunning) {
          try {
            await this.stop();
            console.log('🛑 [DigitalRadioEngine] 因电台断开连接已停止监听');
          } catch (error) {
            console.error('❌ [DigitalRadioEngine] 停止引擎时出错:', error);
          }
        }
        
        // 广播特殊的发射中断开连接事件
        this.emit('radioDisconnectedDuringTransmission' as any, {
          reason: reason || '电台在发射过程中断开连接',
          message: '电台在发射过程中断开连接，可能是发射功率过大导致USB通讯受到干扰。系统已自动停止发射和监听。',
          recommendation: '请检查电台设置，降低发射功率或改善通讯环境，然后重新连接电台。'
        });
      }
      
      // 广播电台状态更新事件
      this.emit('radioStatusChanged' as any, {
        connected: false,
        reason,
        reconnectInfo: this.radioManager.getReconnectInfo()
      });
    });

    // 监听重连开始
    this.radioManager.on('reconnecting', (attempt) => {
      console.log(`📡 [DigitalRadioEngine] 物理电台重连中 (第${attempt}次尝试)`);
      // 广播重连状态更新事件
      this.emit('radioReconnecting' as any, {
        attempt,
        reconnectInfo: this.radioManager.getReconnectInfo()
      });
    });

    // 监听重连失败
    this.radioManager.on('reconnectFailed', (error, attempt) => {
      console.warn(`📡 [DigitalRadioEngine] 物理电台重连失败 (第${attempt}次): ${error.message}`);
      // 广播重连失败事件
      this.emit('radioReconnectFailed' as any, {
        error: error.message,
        attempt,
        reconnectInfo: this.radioManager.getReconnectInfo()
      });
    });

    // 监听重连停止
    this.radioManager.on('reconnectStopped', (maxAttempts) => {
      console.error(`📡 [DigitalRadioEngine] 物理电台重连停止 (已达最大${maxAttempts}次尝试)`);
      // 广播重连停止事件
      this.emit('radioReconnectStopped' as any, {
        maxAttempts,
        reconnectInfo: this.radioManager.getReconnectInfo()
      });
    });

    // 监听电台错误
    this.radioManager.on('error', (error) => {
      console.error(`📡 [DigitalRadioEngine] 物理电台错误: ${error.message}`);
      // 广播电台错误事件
      this.emit('radioError' as any, {
        error: error.message,
        reconnectInfo: this.radioManager.getReconnectInfo()
      });
    });

    // 监听电台数值表数据
    this.radioManager.on('meterData' as any, (data: any) => {
      // 转发数值表数据事件
      this.emit('meterData' as any, data);
    });

    // 监听电台频率变化（自动同步）
    this.radioManager.on('radioFrequencyChanged', async (frequency: number) => {
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
    });
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
}
