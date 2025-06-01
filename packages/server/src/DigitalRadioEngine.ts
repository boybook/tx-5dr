import { 
  SlotClock, 
  SlotScheduler, 
  ClockSourceSystem,
  RadioOperator,
  StandardQSOStrategy
} from '@tx5dr/core';
import { MODES, type ModeDescriptor, type SlotPack, type DigitalRadioEngineEvents, type OperatorConfig, type TransmitRequest } from '@tx5dr/contracts';
import { EventEmitter } from 'eventemitter3';
import { AudioStreamManager } from './audio/AudioStreamManager';
import { WSJTXDecodeWorkQueue } from './decode/WSJTXDecodeWorkQueue';
import { WSJTXEncodeWorkQueue, type EncodeRequest as WSJTXEncodeRequest } from './decode/WSJTXEncodeWorkQueue';
import { SlotPackManager } from './slot/SlotPackManager';
import { ConfigManager } from './config/config-manager';
import { SpectrumScheduler } from './audio/SpectrumScheduler';

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

  // 电台操作员管理
  private operators: Map<string, RadioOperator> = new Map();
  private pendingTransmissions: TransmitRequest[] = [];
  
  // 频谱分析配置常量
  private static readonly SPECTRUM_CONFIG = {
    ANALYSIS_INTERVAL_MS: 150,    // 100ms间隔进行频谱分析
    FFT_SIZE: 4096,              // FFT大小
    WINDOW_FUNCTION: 'hann' as const,
    WORKER_POOL_SIZE: 1,
    ENABLED: true,
    TARGET_SAMPLE_RATE: 6400     // 目标采样率6.4kHz
  };
  
  private constructor() {
    super();
    this.clockSource = new ClockSourceSystem();
    this.audioStreamManager = new AudioStreamManager();
    this.realDecodeQueue = new WSJTXDecodeWorkQueue(1);
    this.realEncodeQueue = new WSJTXEncodeWorkQueue(1);
    this.slotPackManager = new SlotPackManager();
    
    // 初始化频谱调度器
    this.spectrumScheduler = new SpectrumScheduler({
      analysisInterval: DigitalRadioEngine.SPECTRUM_CONFIG.ANALYSIS_INTERVAL_MS,
      fftSize: DigitalRadioEngine.SPECTRUM_CONFIG.FFT_SIZE,
      windowFunction: DigitalRadioEngine.SPECTRUM_CONFIG.WINDOW_FUNCTION,
      workerPoolSize: DigitalRadioEngine.SPECTRUM_CONFIG.WORKER_POOL_SIZE,
      enabled: DigitalRadioEngine.SPECTRUM_CONFIG.ENABLED,
      targetSampleRate: DigitalRadioEngine.SPECTRUM_CONFIG.TARGET_SAMPLE_RATE
    });

    // 监听发射请求
    this.on('requestTransmit', (request: TransmitRequest) => {
      this.pendingTransmissions.push(request);
    });
    
    // 监听编码完成事件
    this.realEncodeQueue.on('encodeComplete', async (result) => {
      try {
        console.log(`🎵 [时钟管理器] 编码完成，计算播放时序`, {
          operatorId: result.operatorId,
          duration: result.duration
        });
        
        // 计算当前模式的时序参数
        const slotDurationSec = this.currentMode.slotMs / 1000; // 周期时长（秒）
        const audioDurationSec = result.duration; // 音频时长（秒）
        
        // 计算居中播放需要的延迟时间
        const centeringDelaySec = (slotDurationSec - audioDurationSec) / 2;
        
        console.log(`⏰ [时钟管理器] 播放时序计算:`);
        console.log(`   周期时长: ${slotDurationSec}s`);
        console.log(`   音频时长: ${audioDurationSec.toFixed(2)}s`);
        console.log(`   居中延迟: ${centeringDelaySec.toFixed(2)}s`);
        
        // 获取当前时隙信息
        const now = this.clockSource.now();
        const currentSlotStartMs = Math.floor(now / this.currentMode.slotMs) * this.currentMode.slotMs;
        const timeSinceSlotStartMs = now - currentSlotStartMs;
        const timeSinceSlotStartSec = timeSinceSlotStartMs / 1000;
        
        console.log(`   当前时隙开始: ${new Date(currentSlotStartMs).toISOString()}`);
        console.log(`   时隙已过时间: ${timeSinceSlotStartSec.toFixed(2)}s`);
        
        // 计算应该开始播放的时间点
        const playbackStartSec = centeringDelaySec;
        let delayMs = 0;
        
        if (timeSinceSlotStartSec < playbackStartSec) {
          // 还没到播放时间，需要等待
          delayMs = (playbackStartSec - timeSinceSlotStartSec) * 1000;
          console.log(`⌛ [时钟管理器] 等待播放，延迟: ${delayMs.toFixed(0)}ms`);
        } else if (timeSinceSlotStartSec < playbackStartSec + audioDurationSec) {
          // 已经过了开始时间但还在播放窗口内，立即播放
          const lateMs = (timeSinceSlotStartSec - playbackStartSec) * 1000;
          console.log(`⚠️ [时钟管理器] 播放稍晚，已过时间: ${lateMs.toFixed(0)}ms，立即播放`);
          delayMs = 0;
        } else {
          // 已经错过了整个播放窗口，跳过这次播放
          console.warn(`❌ [时钟管理器] 错过播放窗口，跳过此次发射`);
          console.warn(`   播放窗口: ${playbackStartSec.toFixed(2)}s - ${(playbackStartSec + audioDurationSec).toFixed(2)}s`);
          console.warn(`   当前时间: ${timeSinceSlotStartSec.toFixed(2)}s`);
          
          this.emit('transmissionComplete' as any, {
            operatorId: result.operatorId,
            success: false,
            error: '错过播放窗口'
          });
          return;
        }
        
        // 如果需要延迟，设置定时器
        if (delayMs > 0) {
          setTimeout(async () => {
            try {
              console.log(`🎵 [时钟管理器] 开始播放音频`);
              await this.audioStreamManager.playAudio(result.audioData, result.sampleRate);
              
              this.emit('transmissionComplete' as any, {
                operatorId: result.operatorId,
                success: true,
                duration: result.duration
              });
            } catch (error) {
              console.error(`❌ [时钟管理器] 延迟播放失败:`, error);
              this.emit('transmissionComplete' as any, {
                operatorId: result.operatorId,
                success: false,
                error: error instanceof Error ? error.message : String(error)
              });
            }
          }, delayMs);
        } else {
          // 立即播放
          console.log(`🎵 [时钟管理器] 立即播放音频`);
          await this.audioStreamManager.playAudio(result.audioData, result.sampleRate);
          
          this.emit('transmissionComplete' as any, {
            operatorId: result.operatorId,
            success: true,
            duration: result.duration
          });
        }
        
      } catch (error) {
        console.error(`❌ [时钟管理器] 音频播放失败:`, error);
        this.emit('transmissionComplete' as any, {
          operatorId: result.operatorId,
          success: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    });
    
    this.realEncodeQueue.on('encodeError', (error, request) => {
      console.error(`❌ [时钟管理器] 编码失败:`, error);
      this.emit('transmissionComplete' as any, {
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
    
    // 创建 SlotClock
    this.slotClock = new SlotClock(this.clockSource, this.currentMode);
    
    // 监听时钟事件
    this.slotClock.on('slotStart', (slotInfo) => {
      console.log(`🎯 [时隙开始] ID: ${slotInfo.id}, 开始时间: ${new Date(slotInfo.startMs).toISOString()}, 相位: ${slotInfo.phaseMs}ms, 漂移: ${slotInfo.driftMs}ms`);
      this.emit('slotStart', slotInfo);
      
      // 处理待发射的消息
      this.handleTransmissions();
      
      // 广播所有操作员的状态更新（包含更新的周期进度）
      this.broadcastAllOperatorStatusUpdates();
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
      // 简化单次解码完成的日志
      // console.log(`🔧 [时钟管理器] 解码完成: 时隙=${result.slotId}, 窗口=${result.windowIdx}, 信号数=${result.frames.length}`);
      
      // 通过 SlotPackManager 处理解码结果
      const updatedSlotPack = this.slotPackManager.processDecodeResult(result);
      // SlotPackManager 会处理详细的日志输出
    });
    
    this.realDecodeQueue.on('decodeError', (error, request) => {
      console.error(`💥 [时钟管理器] 解码错误: 时隙=${request.slotId}, 窗口=${request.windowIdx}:`, error.message);
      this.emit('decodeError', { error, request });
    });
    
    // 监听 SlotPackManager 事件
    this.slotPackManager.on('slotPackUpdated', (slotPack) => {
      console.log(`📦 [时钟管理器] 时隙包更新事件: ${slotPack.slotId}`);
      console.log(`   当前状态: ${slotPack.frames.length}个信号, 解码${slotPack.stats.totalDecodes}次`);
      
      // 如果有解码结果，显示标准格式的解码输出
      if (slotPack.frames.length > 0) {
        // 使用时隙开始时间而不是当前时间
        const slotStartTime = new Date(slotPack.startMs);
        
        for (const frame of slotPack.frames) {
          // 格式: HHMMSS SNR DT FREQ ~ MESSAGE
          const utcTime = slotStartTime.toISOString().slice(11, 19).replace(/:/g, '').slice(0, 6); // HHMMSS
          const snr = frame.snr >= 0 ? ` ${frame.snr}` : `${frame.snr}`; // SNR 带符号
          const dt = frame.dt.toFixed(1).padStart(5); // 时间偏移，1位小数，5位宽度
          const freq = Math.round(frame.freq).toString().padStart(4); // 频率，4位宽度
          const message = frame.message; // 消息不需要填充
          
          console.log(` - ${utcTime} ${snr.padStart(3)} ${dt} ${freq} ~  ${message}`);
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
    
    // 创建固定的电台操作员实例
    this.initializeDefaultOperator();
    
    console.log(`✅ [时钟管理器] 初始化完成，当前模式: ${this.currentMode.name}`);
  }
  
  /**
   * 初始化默认的电台操作员
   */
  private initializeDefaultOperator(): void {
    const defaultConfig: OperatorConfig = {
      id: 'default-operator',
      myCallsign: 'BG5DRB',
      myGrid: 'OP09',
      frequency: 1550,
      mode: this.currentMode,
      transmitCycles: [0], // 偶数周期发射
      maxQSOTimeoutCycles: 10,
      maxCallAttempts: 3,
      autoReplyToCQ: false,
      autoResumeCQAfterFail: false,
      autoResumeCQAfterSuccess: false,
    };

    try {
      const operator = this.addOperator(defaultConfig);
      operator.start();
      console.log('📻 [时钟管理器] 默认电台操作员已创建并启动');
    } catch (error) {
      console.error('❌ [时钟管理器] 创建默认电台操作员失败:', error);
    }
  }

  /**
   * 获取所有操作员的状态信息
   */
  getOperatorsStatus(): any[] {
    const operators = [];
    
    for (const [id, operator] of this.operators.entries()) {
      // 计算周期信息
      let cycleInfo;
      if (this.slotClock && this.isRunning) {
        const now = this.clockSource.now();
        const slotMs = this.currentMode.slotMs;
        const currentSlotStartMs = Math.floor(now / slotMs) * slotMs;
        const cycleProgress = (now - currentSlotStartMs) / slotMs;
        
        // 根据操作员的transmitCycles配置判断是否为发射周期
        const cycleNumber = Math.floor(currentSlotStartMs / slotMs);
        let isTransmitCycle = false;
        
        if (this.currentMode.cycleType === 'EVEN_ODD') {
          // FT8偶奇周期模式：0=偶数周期，1=奇数周期
          const evenOddCycle = cycleNumber % 2;
          isTransmitCycle = operator.getTransmitCycles().includes(evenOddCycle);
        } else if (this.currentMode.cycleType === 'CONTINUOUS') {
          // FT4连续周期模式：根据配置的transmitCycles判断
          isTransmitCycle = operator.getTransmitCycles().includes(cycleNumber);
        }
        
        cycleInfo = {
          currentCycle: cycleNumber,
          isTransmitCycle,
          cycleProgress
        };
      }
      
      // 从策略获取slots信息
      let slots;
      let currentSlot = 'TX6';
      let targetContext = { 
        targetCall: '', 
        targetGrid: '', 
        reportSent: 0,
        reportReceived: 0
      };
      
      if (operator.transmissionStrategy) {
        try {
          // 获取slots
          const slotsResult = operator.transmissionStrategy.userCommand?.({
            command: 'get_slots'
          } as any);
          if (slotsResult && typeof slotsResult === 'object') {
            slots = slotsResult;
          }
          
          // 获取当前状态
          const stateResult = operator.transmissionStrategy.userCommand?.({
            command: 'get_state'
          } as any);
          if (stateResult && typeof stateResult === 'string') {
            currentSlot = stateResult;
          }
          
          // 获取策略状态和上下文 - 通过类型转换访问
          const strategy = operator.transmissionStrategy as any;
          if (strategy.context) {
            const context = strategy.context;
            targetContext = {
              targetCall: context.targetCallsign || '',
              targetGrid: context.targetGrid || '',
              reportSent: context.reportSent ?? 0,
              reportReceived: context.reportReceived ?? 0
            };
          }
        } catch (error) {
          console.error(`获取操作员 ${id} 的slots信息失败:`, error);
        }
      }
      
      operators.push({
        id,
        isActive: this.isRunning, // 基于引擎状态判断活跃状态
        isTransmitting: operator.isTransmitting, // 操作员发射状态
        currentSlot, // 从策略获取当前时隙
        context: {
          myCall: operator.config.myCallsign,
          myGrid: operator.config.myGrid,
          targetCall: targetContext.targetCall,
          targetGrid: targetContext.targetGrid,
          frequency: operator.config.frequency,
          reportSent: targetContext.reportSent,
          reportReceived: targetContext.reportReceived,
        },
        strategy: {
          name: 'StandardQSOStrategy',
          state: currentSlot, // 当前策略状态
          availableSlots: ['TX1', 'TX2', 'TX3', 'TX4', 'TX5', 'TX6']
        },
        cycleInfo,
        slots, // 添加slots信息
        transmitCycles: operator.getTransmitCycles(), // 添加发射周期配置
      });
    }
    
    return operators;
  }

  /**
   * 更新操作员上下文
   */
  updateOperatorContext(operatorId: string, context: any): void {
    const operator = this.operators.get(operatorId);
    if (!operator) {
      throw new Error(`操作员 ${operatorId} 不存在`);
    }
    
    // 更新操作员配置
    operator.config.myCallsign = context.myCall || operator.config.myCallsign;
    operator.config.myGrid = context.myGrid || operator.config.myGrid;
    operator.config.frequency = context.frequency || operator.config.frequency;
    
    console.log(`📻 [时钟管理器] 更新操作员 ${operatorId} 上下文:`, context);
    
    // 发射操作员状态更新事件
    this.emitOperatorStatusUpdate(operatorId);
  }

  /**
   * 设置操作员时隙
   */
  setOperatorSlot(operatorId: string, slot: string): void {
    const operator = this.operators.get(operatorId);
    if (!operator) {
      throw new Error(`操作员 ${operatorId} 不存在`);
    }
    
    // 使用 userCommand 来设置时隙
    operator.userCommand({
      type: 'setSlot',
      slot: slot
    } as any);
    
    console.log(`📻 [时钟管理器] 设置操作员 ${operatorId} 时隙: ${slot}`);
    
    // 发射操作员状态更新事件
    this.emitOperatorStatusUpdate(operatorId);
  }

  /**
   * 启动操作员发射
   */
  startOperator(operatorId: string): void {
    const operator = this.operators.get(operatorId);
    if (!operator) {
      throw new Error(`操作员 ${operatorId} 不存在`);
    }
    
    operator.start();
    console.log(`📻 [时钟管理器] 启动操作员 ${operatorId} 发射`);
    
    // 发射操作员状态更新事件
    this.emitOperatorStatusUpdate(operatorId);
  }

  /**
   * 停止操作员发射
   */
  stopOperator(operatorId: string): void {
    const operator = this.operators.get(operatorId);
    if (!operator) {
      throw new Error(`操作员 ${operatorId} 不存在`);
    }
    
    operator.stop();
    console.log(`📻 [时钟管理器] 停止操作员 ${operatorId} 发射`);
    
    // 发射操作员状态更新事件
    this.emitOperatorStatusUpdate(operatorId);
  }

  /**
   * 发射操作员状态更新事件
   */
  private emitOperatorStatusUpdate(operatorId: string): void {
    const operatorStatus = this.getOperatorsStatus().find(op => op.id === operatorId);
    if (operatorStatus) {
      // 使用 emit 发射自定义事件
      this.emit('operatorStatusUpdate' as any, operatorStatus);
    }
  }

  /**
   * 添加电台操作员
   */
  addOperator(config: OperatorConfig): RadioOperator {
    if (this.operators.has(config.id)) {
      throw new Error(`操作员 ${config.id} 已存在`);
    }

    const operator = new RadioOperator(
      config,
      this,
      (op: RadioOperator) => new StandardQSOStrategy(op)
    );

    // 监听操作员的slots更新事件
    operator.addSlotsUpdateListener((data: any) => {
      console.log(`📻 [时钟管理器] 操作员 ${data.operatorId} 的slots已更新`);
      // 发射操作员状态更新事件
      this.emitOperatorStatusUpdate(data.operatorId);
    });

    // 监听操作员的状态变化事件
    operator.addStateChangeListener((data: any) => {
      console.log(`📻 [时钟管理器] 操作员 ${data.operatorId} 的状态已变化为: ${data.state}`);
      // 发射操作员状态更新事件
      this.emitOperatorStatusUpdate(data.operatorId);
    });

    this.operators.set(config.id, operator);
    console.log(`📻 [时钟管理器] 添加操作员: ${config.id}`);
    return operator;
  }

  /**
   * 移除电台操作员
   */
  removeOperator(id: string): void {
    const operator = this.operators.get(id);
    if (operator) {
      operator.stop();
      this.operators.delete(id);
      console.log(`📻 [时钟管理器] 移除操作员: ${id}`);
    }
  }

  /**
   * 获取电台操作员
   */
  getOperator(id: string): RadioOperator | undefined {
    return this.operators.get(id);
  }

  /**
   * 获取所有电台操作员
   */
  getAllOperators(): RadioOperator[] {
    return Array.from(this.operators.values());
  }

  /**
   * 处理发射请求
   */
  private handleTransmissions(): void {
    if (this.pendingTransmissions.length === 0) {
      return;
    }

    // 检查当前是否是发射周期
    const now = this.clockSource.now();
    const currentSlotStartMs = Math.floor(now / this.currentMode.slotMs) * this.currentMode.slotMs;
    const timeSinceSlotStartMs = now - currentSlotStartMs;
    
    // 只有在时隙刚开始时（前500ms内）才处理发射请求，避免重复处理
    if (timeSinceSlotStartMs > 500) {
      console.log(`⏰ [时钟管理器] 时隙已过 ${timeSinceSlotStartMs}ms，跳过发射处理`);
      return;
    }

    console.log(`📢 [时钟管理器] 处理 ${this.pendingTransmissions.length} 个待发射消息`);
    console.log(`⏰ [时钟管理器] 当前时隙开始: ${new Date(currentSlotStartMs).toISOString()}`);
    console.log(`⏰ [时钟管理器] 时隙已过时间: ${timeSinceSlotStartMs}ms`);
    
    // 处理每个发射请求
    const transmissionsToProcess = [...this.pendingTransmissions];
    this.pendingTransmissions = []; // 立即清空待发射队列，避免重复处理
    
    for (const request of transmissionsToProcess) {
      try {
        console.log(`📻 [发射] 操作员: ${request.operatorId}, 消息: "${request.transmission}"`);
        
        // 获取操作员配置以获取频率
        const operator = this.operators.get(request.operatorId);
        const frequency = operator?.config.frequency || 1500; // 默认频率1500Hz
        
        // 创建编码请求
        const encodeRequest: WSJTXEncodeRequest = {
          operatorId: request.operatorId,
          message: request.transmission,
          frequency: frequency,
          mode: this.currentMode.name === 'FT4' ? 'FT4' : 'FT8'
        };
        
        console.log(`🎵 [发射] 编码参数: 频率=${frequency}Hz, 模式=${encodeRequest.mode}`);
        console.log(`⏰ [发射] 提交编码请求，将在适当时机播放`);
        
        // 提交到编码队列
        this.realEncodeQueue.push(encodeRequest);
        
      } catch (error) {
        console.error(`❌ [发射失败] 操作员: ${request.operatorId}, 错误:`, error);
        
        // 发射失败事件
        this.emit('transmissionComplete' as any, {
          operatorId: request.operatorId,
          success: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
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
      // 不抛出错误，让Engine继续运行
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
      audioStarted: this.audioStarted
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
      this.audioStarted = false; // 重置音频状态
      
      // 停止频谱调度器
      if (this.spectrumScheduler) {
        this.spectrumScheduler.stop();
        console.log(`🛑 [时钟管理器] 停止频谱分析调度器`);
      }

      // 停止所有操作员
      for (const operator of this.operators.values()) {
        operator.stop();
      }
      
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
    this.slotPackManager.cleanup();
    
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
    
    // 清理操作员
    this.operators.clear();
    
    console.log('✅ [时钟管理器] 销毁完成');
  }

  /**
   * 获取所有可用模式
   */
  getAvailableModes(): ModeDescriptor[] {
    return Object.values(MODES);
  }

  /**
   * 广播所有操作员的状态更新
   */
  private broadcastAllOperatorStatusUpdates(): void {
    // console.log('📢 [广播] 开始广播所有操作员状态更新');
    const operators = this.getOperatorsStatus();
    // console.log(`📢 [广播] 获取到 ${operators.length} 个操作员状态`);
    for (const operator of operators) {
      /* console.log(`📢 [广播] 广播操作员 ${operator.id} 状态:`, {
        currentCycle: operator.cycleInfo?.currentCycle,
        isTransmitCycle: operator.cycleInfo?.isTransmitCycle,
        isTransmitting: operator.isTransmitting,
        transmitCycles: operator.transmitCycles
      }); */
      this.emit('operatorStatusUpdate' as any, operator);
    }
    // console.log('📢 [广播] 完成广播所有操作员状态更新');
  }
} 