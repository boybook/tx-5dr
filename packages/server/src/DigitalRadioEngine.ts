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
  
  // 真实的音频和解码系统
  private audioStreamManager: AudioStreamManager;
  private realDecodeQueue: WSJTXDecodeWorkQueue;
  private realEncodeQueue: WSJTXEncodeWorkQueue;
  private slotPackManager: SlotPackManager;
  private spectrumScheduler: SpectrumScheduler;
  
  // 音频混音器
  private audioMixer: AudioMixer;

  // 电台操作员管理器
  private _operatorManager: RadioOperatorManager;

  public get operatorManager(): RadioOperatorManager {
    return this._operatorManager;
  }

  /**
   * 获取时隙包管理器（用于API访问）
   */
  public getSlotPackManager(): SlotPackManager {
    return this.slotPackManager;
  }
  
  // 频谱分析配置常量
  private static readonly SPECTRUM_CONFIG = {
    ANALYSIS_INTERVAL_MS: 150,    // 频谱分析间隔
    FFT_SIZE: 4096,              // FFT大小
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
    
    // 初始化操作员管理器
    this._operatorManager = new RadioOperatorManager({
      eventEmitter: this,
      encodeQueue: this.realEncodeQueue,
      clockSource: this.clockSource,
      getCurrentMode: () => this.currentMode
    });
    
    // 初始化频谱调度器
    this.spectrumScheduler = new SpectrumScheduler({
      analysisInterval: DigitalRadioEngine.SPECTRUM_CONFIG.ANALYSIS_INTERVAL_MS,
      fftSize: DigitalRadioEngine.SPECTRUM_CONFIG.FFT_SIZE,
      windowFunction: DigitalRadioEngine.SPECTRUM_CONFIG.WINDOW_FUNCTION,
      workerPoolSize: DigitalRadioEngine.SPECTRUM_CONFIG.WORKER_POOL_SIZE,
      enabled: DigitalRadioEngine.SPECTRUM_CONFIG.ENABLED,
      targetSampleRate: DigitalRadioEngine.SPECTRUM_CONFIG.TARGET_SAMPLE_RATE
    });
    
    // 监听编码完成事件 - 修改为使用音频混音器
    this.realEncodeQueue.on('encodeComplete', async (result) => {
      try {
        console.log(`🎵 [时钟管理器] 编码完成，提交到混音器`, {
          operatorId: result.operatorId,
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
        
        // 计算从现在到播放开始的延迟
        const delayMs = playbackStartMs - now;
        
        if (delayMs > 0) {
          // 还没到播放时间，提交到混音器等待
          console.log(`⌛ [时钟管理器] 等待 ${delayMs}ms 后开始播放`);
          this.audioMixer.addAudio(result.operatorId, audioData, result.sampleRate, playbackStartMs);
        } else {
          // 立即提交到混音器播放
          console.log(`🎵 [时钟管理器] 立即播放音频 (时长: ${audioDurationSec.toFixed(2)}s)`);
          this.audioMixer.addAudio(result.operatorId, audioData, result.sampleRate, now);
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
        
        // 播放混音后的音频
        await this.audioStreamManager.playAudio(mixedAudio.audioData, mixedAudio.sampleRate);
        
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
    
    // 创建 SlotClock
    this.slotClock = new SlotClock(this.clockSource, this.currentMode);
    
    // 监听时钟事件
    this.slotClock.on('slotStart', (slotInfo) => {
      console.log(`🎯 [时隙开始] ID: ${slotInfo.id}, 开始时间: ${new Date(slotInfo.startMs).toISOString()}, 相位: ${slotInfo.phaseMs}ms, 漂移: ${slotInfo.driftMs}ms`);
      this.emit('slotStart', slotInfo, this.slotPackManager.getLatestSlotPack());
      
      // 广播所有操作员的状态更新（包含更新的周期进度）
      this.operatorManager.broadcastAllOperatorStatusUpdates();
    });
    
    // 监听发射开始事件
    this.slotClock.on('transmitStart', (slotInfo) => {
      console.log(`📡 [发射时机] ID: ${slotInfo.id}, 时间: ${new Date().toISOString()}, 延迟: ${this.currentMode.transmitTiming}ms`);
      this.emit('transmitStart' as any, slotInfo);
      
      // 处理待发射的消息
      this.operatorManager.handleTransmissions();
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
      this.audioStreamManager.getAudioProvider()
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
      48000 // 默认采样率，后续会从音频流管理器获取实际采样率
    );
    
    // 监听频谱调度器事件
    this.spectrumScheduler.on('spectrumReady', (spectrum) => {
      // 发射频谱数据事件给WebSocket客户端
      this.emit('spectrumData', spectrum);
    });
    
    this.spectrumScheduler.on('error', (error) => {
      console.error('📊 [时钟管理器] 频谱分析错误:', error);
    });
    
    // 初始化操作员管理器
    await this.operatorManager.initialize();
    
    console.log(`✅ [时钟管理器] 初始化完成，当前模式: ${this.currentMode.name}`);
  }

  /**
   * 启动时钟
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('⚠️  [时钟管理器] 时钟已经在运行中');
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
      
      console.log(`🎤 [时钟管理器] 使用音频设备配置:`, audioConfig);
      
      // 启动音频输入
      await this.audioStreamManager.startStream(audioConfig.inputDeviceId);
      console.log(`🎤 [时钟管理器] 音频输入流启动成功`);
      
      // 启动音频输出
      await this.audioStreamManager.startOutput(audioConfig.outputDeviceId);
      console.log(`🔊 [时钟管理器] 音频输出流启动成功`);
      
      audioStarted = true;
    } catch (error) {
      console.error(`❌ [时钟管理器] 音频流启动失败:`, error);
      console.warn(`⚠️ [时钟管理器] 将在没有音频输入/输出的情况下继续运行`);
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
    return {
      isRunning: this.isRunning,
      isDecoding: this.slotClock?.isRunning ?? false,
      currentMode: this.currentMode,
      currentTime: this.clockSource.now(),
      nextSlotIn: this.slotClock?.getNextSlotIn() ?? 0,
      audioStarted: this.audioStarted,
      volumeGain: this.audioStreamManager.getVolumeGain()
    };
  }
  
  /**
   * 停止时钟
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      console.log('⚠️  [时钟管理器] 时钟已经停止');
      return;
    }
    
    if (this.slotClock) {
      console.log('🛑 [时钟管理器] 停止时钟');
      this.slotClock.stop();
      
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
      } catch (error) {
        console.error(`❌ [时钟管理器] 音频流停止失败:`, error);
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
      this.emit('systemStatus', status);
    }
  }
  
  /**
   * 销毁时钟管理器
   */
  async destroy(): Promise<void> {
    console.log('🗑️  [时钟管理器] 正在销毁...');
    await this.stop();
    
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
    
    console.log('✅ [时钟管理器] 销毁完成');
  }

  /**
   * 获取所有可用模式
   */
  getAvailableModes(): ModeDescriptor[] {
    return Object.values(MODES);
  }

  /**
   * 设置音量增益
   */
  setVolumeGain(gain: number): void {
    this.audioStreamManager.setVolumeGain(gain);
    // 广播音量变化事件
    this.emit('volumeGainChanged', gain);
  }

  /**
   * 获取当前音量增益
   */
  getVolumeGain(): number {
    return this.audioStreamManager.getVolumeGain();
  }
}