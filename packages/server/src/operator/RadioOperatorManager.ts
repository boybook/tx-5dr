import EventEmitter from 'eventemitter3';
import { 
  RadioOperator, 
  StandardQSOStrategy,
  ClockSourceSystem
} from '@tx5dr/core';
import { 
  type RadioOperatorConfig, 
  type OperatorConfig, 
  type TransmitRequest,
  type DigitalRadioEngineEvents,
  type ModeDescriptor,
  type QSORecord,
  MODES,
  QSOCommand
} from '@tx5dr/contracts';
import { CycleUtils, getBandFromFrequency } from '@tx5dr/core';
import { ConfigManager } from '../config/config-manager.js';
import { LogManager } from '../log/LogManager.js';
import type { WSJTXEncodeWorkQueue, EncodeRequest as WSJTXEncodeRequest } from '../decode/WSJTXEncodeWorkQueue.js';
import { WaveLogServiceManager } from '../services/WaveLogService.js';

export interface RadioOperatorManagerOptions {
  eventEmitter: EventEmitter<DigitalRadioEngineEvents>;
  encodeQueue: WSJTXEncodeWorkQueue;
  clockSource: ClockSourceSystem;
  getCurrentMode: () => ModeDescriptor;
  setRadioFrequency: (freq: number) => void;
  transmissionTracker?: any; // TransmissionTracker实例
  // 获取物理电台当前基频（Hz）；若无法获取，返回null
  getRadioFrequency?: () => Promise<number | null>;
}

/**
 * 电台操作员管理器 - 管理所有电台操作员相关的功能
 */
export class RadioOperatorManager {
  private operators: Map<string, RadioOperator> = new Map();
  private pendingTransmissions: TransmitRequest[] = [];
  private eventEmitter: EventEmitter<DigitalRadioEngineEvents>;
  private encodeQueue: WSJTXEncodeWorkQueue;
  private clockSource: ClockSourceSystem;
  private getCurrentMode: () => ModeDescriptor;
  private setRadioFrequency: (freq: number) => void;
  private isRunning: boolean = false;
  private logManager: LogManager;
  private transmissionTracker: any; // TransmissionTracker实例
  private getRadioFrequency?: () => Promise<number | null>;

  constructor(options: RadioOperatorManagerOptions) {
    this.eventEmitter = options.eventEmitter;
    this.encodeQueue = options.encodeQueue;
    this.clockSource = options.clockSource;
    this.getCurrentMode = options.getCurrentMode;
    this.setRadioFrequency = options.setRadioFrequency;
    this.logManager = LogManager.getInstance();
    this.transmissionTracker = options.transmissionTracker;
    this.getRadioFrequency = options.getRadioFrequency;

    // 监听发射请求
    this.eventEmitter.on('requestTransmit', (request: TransmitRequest) => {
      this.pendingTransmissions.push(request);
    });
    
    // 监听记录QSO事件
    this.eventEmitter.on('recordQSO' as any, async (data: { operatorId: string; qsoRecord: QSORecord }) => {
      try {
        console.log(`📝 [操作员管理器] 记录QSO: ${data.qsoRecord.callsign} (操作员: ${data.operatorId})`);
        
        // 获取操作员对应的日志本
        const logBook = await this.logManager.getOperatorLogBook(data.operatorId);
        if (!logBook) {
          const callsign = this.logManager.getOperatorCallsign(data.operatorId);
          if (!callsign) {
            console.error(`📝 [操作员管理器] 无法记录QSO: 操作员 ${data.operatorId} 未注册呼号`);
            return;
          } else {
            console.error(`📝 [操作员管理器] 无法记录QSO: 操作员 ${data.operatorId} (呼号: ${callsign}) 的日志本创建失败`);
            return;
          }
        }
        
        // 兜底校正频率：防止误将音频偏移(Hz)写入为绝对频率
        const operator = this.operators.get(data.operatorId);
        let baseFreq = 0;
        // 优先从物理电台获取全局基频
        if (this.getRadioFrequency) {
          try {
            const rf = await this.getRadioFrequency();
            if (rf && rf > 1_000_000) baseFreq = rf;
          } catch {}
        }
        // 若仍无效，回退到“最后选择的频率”配置
        if (!(baseFreq > 1_000_000)) {
          try {
            const cfg = ConfigManager.getInstance();
            const last = cfg.getLastSelectedFrequency();
            if (last && last.frequency && last.frequency > 1_000_000) {
              baseFreq = last.frequency;
              console.warn(`🛠️ [操作员管理器] 使用最后选择的频率作为基频: ${baseFreq}Hz`);
            }
          } catch {}
        }
        const originalFreq = data.qsoRecord.frequency || 0;
        let normalizedFreq = originalFreq;
        // 若记录频率小于1MHz，且操作员基础频率有效，则视为偏移量进行修正
        if (originalFreq > 0 && originalFreq < 1_000_000 && baseFreq > 1_000_000) {
          normalizedFreq = baseFreq + originalFreq;
          console.warn(`🛠️ [操作员管理器] 发现异常频率(${originalFreq}Hz)，已按偏移修正为 ${normalizedFreq}Hz (基频 ${baseFreq}Hz)`);
        } else if (originalFreq === 0 && baseFreq > 1_000_000) {
          normalizedFreq = baseFreq;
          console.warn(`🛠️ [操作员管理器] 记录频率缺失，使用基频 ${normalizedFreq}Hz`);
        }

        const qsoToSave: QSORecord = {
          ...data.qsoRecord,
          frequency: normalizedFreq
        };

        console.log(`📝 [操作员管理器] 记录QSO到日志本 ${logBook.name}: ${qsoToSave.callsign} @ ${new Date(qsoToSave.startTime).toISOString()} (${qsoToSave.frequency}Hz)`);
        await logBook.provider.addQSO(qsoToSave, data.operatorId);
        
        // QSO记录成功后，发射事件通知上层系统
        this.eventEmitter.emit('qsoRecordAdded' as any, {
          operatorId: data.operatorId,
          logBookId: logBook.id,
          qsoRecord: qsoToSave
        });
        console.log(`📡 [操作员管理器] 已发射 qsoRecordAdded 事件: ${data.qsoRecord.callsign}`);
        
        // 自动上传到WaveLog（如果已启用）
        await this.handleWaveLogAutoUpload(data.qsoRecord, data.operatorId);
        
        // 获取更新的统计信息并发射日志本更新事件
        try {
          const statistics = await logBook.provider.getStatistics();
          this.eventEmitter.emit('logbookUpdated' as any, {
            logBookId: logBook.id,
            statistics,
            operatorId: data.operatorId,
          });
          console.log(`📡 [操作员管理器] 已发射 logbookUpdated 事件: ${logBook.name}`);
        } catch (statsError) {
          console.warn(`⚠️ [操作员管理器] 获取日志本统计信息失败:`, statsError);
        }
        
      } catch (error) {
        console.error(`❌ [操作员管理器] 记录QSO失败:`, error);
      }
    });
    
    // 监听检查是否已通联事件
    this.eventEmitter.on('checkHasWorkedCallsign' as any, async (data: { operatorId: string; callsign: string; requestId: string }) => {
      try {
        // 获取操作员对应的日志本
        const logBook = await this.logManager.getOperatorLogBook(data.operatorId);
        let hasWorked = false;
        // 计算当前工作频段（用于按频段判重）：
        // 优先从物理电台读频率；否则退回到“最后选择的频率”配置
        let baseFreq = 0;
        if (this.getRadioFrequency) {
          try {
            const rf = await this.getRadioFrequency();
            if (rf && rf > 1_000_000) baseFreq = rf;
          } catch {}
        }
        if (!(baseFreq > 1_000_000)) {
          try {
            const cfg = ConfigManager.getInstance();
            const last = cfg.getLastSelectedFrequency();
            if (last && last.frequency && last.frequency > 1_000_000) {
              baseFreq = last.frequency;
            }
          } catch {}
        }
        const band = baseFreq > 1_000_000 ? getBandFromFrequency(baseFreq) : 'Unknown';
        
        if (!logBook) {
          const callsign = this.logManager.getOperatorCallsign(data.operatorId);
          if (!callsign) {
            console.warn(`📝 [操作员管理器] 检查已通联: 操作员 ${data.operatorId} 未注册呼号，默认返回false`);
            hasWorked = false;
          } else {
            console.warn(`📝 [操作员管理器] 检查已通联: 操作员 ${data.operatorId} (呼号: ${callsign}) 的日志本不存在，默认返回false`);
            hasWorked = false;
          }
        } else {
          hasWorked = await logBook.provider.hasWorkedCallsign(data.callsign, { operatorId: data.operatorId, band });
        }
        
        // 发送响应
        this.eventEmitter.emit('hasWorkedCallsignResponse' as any, {
          requestId: data.requestId,
          hasWorked
        });
      } catch (error) {
        console.error(`❌ [操作员管理器] 检查呼号失败:`, error);
        // 发送错误响应
        this.eventEmitter.emit('hasWorkedCallsignResponse' as any, {
          requestId: data.requestId,
          hasWorked: false
        });
      }
    });
    
    // 监听操作员发射周期变更事件
    this.eventEmitter.on('operatorTransmitCyclesChanged' as any, (data: { operatorId: string; transmitCycles: number[] }) => {
      console.log(`📻 [操作员管理器] 检测到操作员 ${data.operatorId} 发射周期变更: [${data.transmitCycles.join(', ')}]`);
      // 立即检查并触发发射
      this.checkAndTriggerTransmission(data.operatorId);
      // 发送状态更新到前端
      this.emitOperatorStatusUpdate(data.operatorId);
    });
    
    // 监听操作员切换发射槽位事件
    this.eventEmitter.on('operatorSlotChanged' as any, (data: { operatorId: string; slot: string }) => {
      console.log(`📻 [操作员管理器] 检测到操作员 ${data.operatorId} 切换发射槽位: ${data.slot}`);
      // 立即检查并触发发射
      this.checkAndTriggerTransmission(data.operatorId);
      // 发送状态更新到前端
      this.emitOperatorStatusUpdate(data.operatorId);
    });
    
    // 监听操作员发射内容变更事件
    this.eventEmitter.on('operatorSlotContentChanged' as any, (data: { operatorId: string; slot: string; content: string }) => {
      console.log(`📻 [操作员管理器] 检测到操作员 ${data.operatorId} 编辑发射内容: 槽位=${data.slot}`);
      // 立即检查并触发发射（如果当前正在该槽位发射）
      const operator = this.operators.get(data.operatorId);
      if (operator) {
        const currentSlot = operator.transmissionStrategy?.userCommand?.({ command: 'get_state' } as any);
        if (currentSlot === data.slot) {
          console.log(`📻 [操作员管理器] 当前正在槽位 ${data.slot} 发射，立即更新发射内容`);
          this.checkAndTriggerTransmission(data.operatorId);
        }
      }
      // 发送状态更新到前端
      this.emitOperatorStatusUpdate(data.operatorId);
    });
  }

  /**
   * 初始化操作员管理器
   */
  async initialize(): Promise<void> {
    console.log('📻 [操作员管理器] 正在初始化...');
    
    // 初始化日志管理器
    await this.logManager.initialize();
    
    // 从配置文件初始化操作员（包括创建对应的日志本）
    await this.initializeOperatorsFromConfig();
    
    console.log('✅ [操作员管理器] 初始化完成');
  }

  /**
   * 从配置文件初始化操作员
   */
  private async initializeOperatorsFromConfig(): Promise<void> {
    const configManager = ConfigManager.getInstance();
    const operatorsConfig = configManager.getOperatorsConfig();

    if (operatorsConfig.length === 0) {
      console.log('📻 [操作员管理器] 没有配置的操作员，等待用户创建');
      return;
    }

    for (const config of operatorsConfig) {
      try {
        const operator = await this.addOperator(config);
        /* operator.start(); */
        console.log(`📻 [操作员管理器] 操作员 ${config.id} 已创建`);
      } catch (error) {
        console.error(`❌ [操作员管理器] 创建操作员 ${config.id} 失败:`, error);
      }
    }
  }

  /**
   * 将RadioOperatorConfig转换为OperatorConfig
   */
  private convertToOperatorConfig(config: RadioOperatorConfig): OperatorConfig {
    return {
      id: config.id,
      myCallsign: config.myCallsign,
      myGrid: config.myGrid || '',
      frequency: config.frequency,
      transmitCycles: config.transmitCycles,
      maxQSOTimeoutCycles: config.maxQSOTimeoutCycles,
      maxCallAttempts: config.maxCallAttempts,
      autoReplyToCQ: config.autoReplyToCQ,
      autoResumeCQAfterFail: config.autoResumeCQAfterFail,
      autoResumeCQAfterSuccess: config.autoResumeCQAfterSuccess,
      replyToWorkedStations: config.replyToWorkedStations ?? false,
      prioritizeNewCalls: config.prioritizeNewCalls ?? true,
      mode: config.mode || MODES.FT8,
    };
  }

  /**
   * 添加电台操作员
   */
  async addOperator(config: RadioOperatorConfig): Promise<RadioOperator> {
    if (this.operators.has(config.id)) {
      throw new Error(`操作员 ${config.id} 已存在`);
    }

    const operatorConfig = this.convertToOperatorConfig(config);
    const operator = new RadioOperator(
      operatorConfig,
      this.eventEmitter,
      (op: RadioOperator) => new StandardQSOStrategy(op)
    );
    
    // 注册操作员的呼号到日志管理器
    this.logManager.registerOperatorCallsign(config.id, config.myCallsign);
    
    // 立即为该呼号创建日志本
    try {
      await this.logManager.getOrCreateLogBookByCallsign(config.myCallsign);
      console.log(`📻 [操作员管理器] 已为操作员 ${config.id} (呼号: ${config.myCallsign}) 创建日志本`);
    } catch (error) {
      console.error(`📻 [操作员管理器] 为操作员 ${config.id} (呼号: ${config.myCallsign}) 创建日志本失败:`, error);
    }
    
    // 如果配置中指定了日志本ID，连接到该日志本（向后兼容）
    if (config.logBookId) {
      this.connectOperatorToLogBook(config.id, config.logBookId);
    }
    
    // 监听操作员的slots更新事件
    operator.addSlotsUpdateListener((data: any) => {
      console.log(`📻 [操作员管理器] 操作员 ${data.operatorId} 的slots已更新`);
      this.emitOperatorStatusUpdate(data.operatorId);
    });

    // 监听操作员的状态变化事件
    operator.addStateChangeListener((data: any) => {
      console.log(`📻 [操作员管理器] 操作员 ${data.operatorId} 的状态已变化为: ${data.state}`);
      this.emitOperatorStatusUpdate(data.operatorId);
    });

    this.operators.set(config.id, operator);
    console.log(`📻 [操作员管理器] 添加操作员: ${config.id}`);
    return operator;
  }

  /**
   * 删除操作员
   */
  removeOperator(operatorId: string): void {
    const operator = this.operators.get(operatorId);
    if (!operator) {
      throw new Error(`操作员 ${operatorId} 不存在`);
    }

    // 断开与日志本的连接
    this.logManager.disconnectOperatorFromLogBook(operatorId);
    
    this.operators.delete(operatorId);
    console.log(`📻 [操作员管理器] 删除操作员: ${operatorId}`);
  }

  /**
   * 将操作员连接到指定日志本
   */
  async connectOperatorToLogBook(operatorId: string, logBookId: string): Promise<void> {
    const operator = this.operators.get(operatorId);
    if (!operator) {
      throw new Error(`操作员 ${operatorId} 不存在`);
    }

    await this.logManager.connectOperatorToLogBook(operatorId, logBookId);
    console.log(`📻 [操作员管理器] 操作员 ${operatorId} 已连接到日志本 ${logBookId}`);
  }

  /**
   * 断开操作员与日志本的连接（使用默认日志本）
   */
  disconnectOperatorFromLogBook(operatorId: string): void {
    const operator = this.operators.get(operatorId);
    if (!operator) {
      throw new Error(`操作员 ${operatorId} 不存在`);
    }

    this.logManager.disconnectOperatorFromLogBook(operatorId);
    console.log(`📻 [操作员管理器] 操作员 ${operatorId} 已断开日志本连接`);
  }

  /**
   * 获取操作员当前连接的日志本信息
   */
  getOperatorLogBookInfo(operatorId: string): { logBookId: string | null; logBook: any } {
    const logBookId = this.logManager.getOperatorLogBookId(operatorId);
    const logBook = logBookId ? this.logManager.getLogBook(logBookId) : null;
    
    return {
      logBookId,
      logBook: logBook ? {
        id: logBook.id,
        name: logBook.name,
        description: logBook.description,
        filePath: logBook.filePath,
        lastUsed: logBook.lastUsed,
        isActive: logBook.isActive
      } : null
    };
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
   * 获取待处理发射队列的大小
   */
  getPendingTransmissionsCount(): number {
    return this.pendingTransmissions.length;
  }

  /**
   * 获取所有操作员的状态信息
   */
  getOperatorsStatus(): any[] {
    const operators = [];
    const currentMode = this.getCurrentMode();
    
    for (const [id, operator] of this.operators.entries()) {
      // 计算周期信息
      let cycleInfo;
      if (this.isRunning) {
        const now = this.clockSource.now();
        const slotMs = currentMode.slotMs;
        const currentSlotStartMs = Math.floor(now / slotMs) * slotMs;
        const cycleProgress = (now - currentSlotStartMs) / slotMs;
        
        // 使用统一的周期计算方法
        const utcSeconds = Math.floor(currentSlotStartMs / 1000);
        const cycleNumber = CycleUtils.calculateCycleNumber(utcSeconds, currentMode.slotMs);
        const isTransmitCycle = CycleUtils.isOperatorTransmitCycle(
          operator.getTransmitCycles(),
          utcSeconds,
          currentMode.slotMs
        );
        
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
          const slotsResult = operator.transmissionStrategy.userCommand?.({
            command: 'get_slots'
          } as any);
          if (slotsResult && typeof slotsResult === 'object') {
            slots = slotsResult;
          }
          
          const stateResult = operator.transmissionStrategy.userCommand?.({
            command: 'get_state'
          } as any);
          if (stateResult && typeof stateResult === 'string') {
            currentSlot = stateResult;
          }
          
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
          console.error(`❌ [操作员管理器] 获取操作员 ${id} 状态失败:`, error);
          slots = {};
        }
      }
      
      operators.push({
        id,
        isActive: this.isRunning,
        isTransmitting: operator.isTransmitting,
        currentSlot,
        context: {
          myCall: operator.config.myCallsign,
          myGrid: operator.config.myGrid,
          targetCall: targetContext.targetCall,
          targetGrid: targetContext.targetGrid,
          frequency: operator.config.frequency,
          reportSent: targetContext.reportSent,
          reportReceived: targetContext.reportReceived,
          // 自动化设置
          autoReplyToCQ: operator.config.autoReplyToCQ,
          autoResumeCQAfterFail: operator.config.autoResumeCQAfterFail,
          autoResumeCQAfterSuccess: operator.config.autoResumeCQAfterSuccess,
          replyToWorkedStations: operator.config.replyToWorkedStations,
          prioritizeNewCalls: operator.config.prioritizeNewCalls,
        },
        strategy: {
          name: 'StandardQSOStrategy',
          state: currentSlot,
          availableSlots: ['TX1', 'TX2', 'TX3', 'TX4', 'TX5', 'TX6']
        },
        cycleInfo,
        slots,
        transmitCycles: operator.getTransmitCycles(),
      });
    }
    
    return operators;
  }

  /**
   * 更新操作员上下文
   */
  async updateOperatorContext(operatorId: string, context: any): Promise<void> {
    const operator = this.operators.get(operatorId);
    if (!operator) {
      throw new Error(`操作员 ${operatorId} 不存在`);
    }

    // 构建更新对象（只包含实际变化的字段）
    const updates: Partial<RadioOperatorConfig> = {};

    // 更新基本信息
    if (context.myCall !== undefined && context.myCall !== operator.config.myCallsign) {
      operator.config.myCallsign = context.myCall;
      updates.myCallsign = context.myCall;
    }
    if (context.myGrid !== undefined && context.myGrid !== operator.config.myGrid) {
      operator.config.myGrid = context.myGrid;
      updates.myGrid = context.myGrid;
    }
    if (context.frequency !== undefined && context.frequency !== operator.config.frequency) {
      operator.config.frequency = context.frequency;
      updates.frequency = context.frequency;
    }

    // 更新自动化设置
    if (context.autoReplyToCQ !== undefined && context.autoReplyToCQ !== operator.config.autoReplyToCQ) {
      operator.config.autoReplyToCQ = context.autoReplyToCQ;
      updates.autoReplyToCQ = context.autoReplyToCQ;
    }
    if (context.autoResumeCQAfterFail !== undefined && context.autoResumeCQAfterFail !== operator.config.autoResumeCQAfterFail) {
      operator.config.autoResumeCQAfterFail = context.autoResumeCQAfterFail;
      updates.autoResumeCQAfterFail = context.autoResumeCQAfterFail;
    }
    if (context.autoResumeCQAfterSuccess !== undefined && context.autoResumeCQAfterSuccess !== operator.config.autoResumeCQAfterSuccess) {
      operator.config.autoResumeCQAfterSuccess = context.autoResumeCQAfterSuccess;
      updates.autoResumeCQAfterSuccess = context.autoResumeCQAfterSuccess;
    }
    if (context.replyToWorkedStations !== undefined && context.replyToWorkedStations !== operator.config.replyToWorkedStations) {
      operator.config.replyToWorkedStations = context.replyToWorkedStations;
      updates.replyToWorkedStations = context.replyToWorkedStations;
    }
    if (context.prioritizeNewCalls !== undefined && context.prioritizeNewCalls !== operator.config.prioritizeNewCalls) {
      operator.config.prioritizeNewCalls = context.prioritizeNewCalls;
      updates.prioritizeNewCalls = context.prioritizeNewCalls;
    }

    // 如果有任何字段发生了变化，保存到配置文件
    if (Object.keys(updates).length > 0) {
      const configManager = ConfigManager.getInstance();
      await configManager.updateOperatorConfig(operatorId, updates);
      console.log(`💾 [操作员管理器] 已保存操作员 ${operatorId} 配置到文件:`, updates);
    }

    console.log(`📻 [操作员管理器] 更新操作员 ${operatorId} 上下文:`, context);
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
    
    operator.userCommand({
      type: 'setSlot',
      slot: slot
    } as any);
    
    console.log(`📻 [操作员管理器] 设置操作员 ${operatorId} 时隙: ${slot}`);
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
    console.log(`📻 [操作员管理器] 启动操作员 ${operatorId} 发射`);
    
    // 立即检查并触发发射（如果在发射周期内）
    this.checkAndTriggerTransmission(operatorId);
    
    this.emitOperatorStatusUpdate(operatorId);
  }

  /**
   * 处理待发射队列
   * 由 DigitalRadioEngine 在 transmitStart 事件时调用
   * 处理所有通过了 RadioOperator 周期检查的发射请求
   * @param slotInfo 时隙信息(包含准确的时间戳)
   */
  processPendingTransmissions(slotInfo: any): void {
    if (!this.isRunning) {
      console.log('⚠️ [RadioOperatorManager] 操作员管理器未运行，跳过处理发射队列');
      return;
    }

    if (this.pendingTransmissions.length === 0) {
      console.log('📡 [RadioOperatorManager] 发射队列为空，无待发射请求');
      return;
    }

    console.log(`📡 [RadioOperatorManager] 处理发射队列: ${this.pendingTransmissions.length} 个待发射请求`);

    const currentMode = this.getCurrentMode();
    const slotStartMs = slotInfo.startMs; // 使用 slotInfo 中的准确时间戳
    const now = this.clockSource.now();
    const timeSinceSlotStartMs = now - slotStartMs;

    // 处理队列中的所有请求
    const requests = [...this.pendingTransmissions];
    this.pendingTransmissions = []; // 清空队列

    for (const request of requests) {
      const operatorId = request.operatorId;
      const transmission = request.transmission;

      // 获取操作员的频率
      const operator = this.operators.get(operatorId);
      if (!operator) {
        console.warn(`⚠️ [RadioOperatorManager] 操作员 ${operatorId} 不存在，跳过发射请求`);
        continue;
      }

      const frequency = operator.config.frequency || 0;

      // 广播发射日志
      this.eventEmitter.emit('transmissionLog' as any, {
        operatorId,
        time: new Date(slotStartMs).toISOString().slice(11, 19).replace(/:/g, ''),
        message: transmission,
        frequency: frequency,
        slotStartMs: slotStartMs
      });

      // 启动传输跟踪
      if (this.transmissionTracker) {
        const slotId = `slot-${slotStartMs}`;
        const targetTransmitTime = slotStartMs + (currentMode.transmitTiming || 0);
        this.transmissionTracker.startTransmission(operatorId, slotId, targetTransmitTime);
        this.transmissionTracker.updatePhase(operatorId, 'preparing' as any);
      }

      // 提交到编码队列
      this.encodeQueue.push({
        operatorId,
        message: transmission,
        frequency,
        mode: currentMode.name === 'FT4' ? 'FT4' : 'FT8',
        slotStartMs: slotStartMs,
        timeSinceSlotStartMs: timeSinceSlotStartMs
      });

      console.log(`📡 [RadioOperatorManager] 已处理操作员 ${operatorId} 的发射请求: "${transmission}"`);
    }
  }

  /**
   * 检查并触发单个操作员的发射
   * 用于在时隙中间启动或切换发射周期时立即触发
   */
  private checkAndTriggerTransmission(operatorId: string): void {
    const operator = this.operators.get(operatorId);
    if (!operator || !operator.isTransmitting) {
      return;
    }

    const currentMode = this.getCurrentMode();
    const now = this.clockSource.now();
    const slotMs = currentMode.slotMs;
    const currentSlotStartMs = Math.floor(now / slotMs) * slotMs;
    const timeSinceSlotStartMs = now - currentSlotStartMs;
    
    // 使用统一的周期计算方法
    const utcSeconds = Math.floor(currentSlotStartMs / 1000);
    const isTransmitCycle = CycleUtils.isOperatorTransmitCycle(
      operator.getTransmitCycles(),
      utcSeconds,
      currentMode.slotMs
    );
    
    if (!isTransmitCycle) {
      console.log(`📻 [操作员管理器] 操作员 ${operatorId} 不在发射周期内`);
      // 即使不在发射周期内，也需要更新状态（cycleInfo会显示isTransmitCycle=false）
      this.emitOperatorStatusUpdate(operatorId);
      return;
    }
    
    // 生成发射内容
    const transmission = operator.transmissionStrategy?.handleTransmitSlot();
    if (!transmission) {
      console.log(`📻 [操作员管理器] 操作员 ${operatorId} 没有发射内容`);
      // 即使没有发射内容，也需要更新状态
      this.emitOperatorStatusUpdate(operatorId);
      return;
    }
    
    console.log(`📻 [操作员管理器] 在时隙中间触发发射: 操作员=${operatorId}, 已过时间=${timeSinceSlotStartMs}ms`);

    // 将发射请求加入队列（仅入队，交由统一的队列消费层处理）
    const request: TransmitRequest = {
      operatorId,
      transmission
    };
    this.pendingTransmissions.push(request);

    // 由统一的队列消费层处理：构造当前时隙信息并消费队列
    // 这样可以确保：
    // 1) 所有编码请求都通过相同路径进入（避免重复）
    // 2) 正确计算 timeSinceSlotStartMs 以支持中途重新混音/发射
    // 3) 队列被正确清空，避免跨入下一个非发射周期误发
    const slotInfo = {
      id: `slot-${currentSlotStartMs}`,
      startMs: currentSlotStartMs,
    } as any;
    this.processPendingTransmissions(slotInfo);
    
    // 发送状态更新到前端
    this.emitOperatorStatusUpdate(operatorId);
  }

  /**
   * 处理发射请求
   * @param midSlot 是否在时隙中间调用（默认false）
   */
  handleTransmissions(midSlot: boolean = false): void {
    if (!this.isRunning) {
      console.log('⚠️ [RadioOperatorManager] 操作员管理器未运行，跳过处理发射请求');
      return;
    }

    // 获取当前时隙信息
    const now = this.clockSource.now();
    const currentMode = this.getCurrentMode();
    const currentSlotStartMs = Math.floor(now / currentMode.slotMs) * currentMode.slotMs;
    const currentTimeSinceSlotStartMs = now - currentSlotStartMs;

    console.log(`📡 [RadioOperatorManager] 处理发射请求:`, {
      midSlot,
      currentSlotStartMs: new Date(currentSlotStartMs).toISOString(),
      timeSinceSlotStart: currentTimeSinceSlotStartMs
    });

    // 处理每个操作员的发射请求
    this.operators.forEach((operator, operatorId) => {
      if (!operator.isTransmitting) {
        return;
      }

      // 使用统一的周期计算方法
      const utcSeconds = Math.floor(currentSlotStartMs / 1000);
      const isTransmitCycle = CycleUtils.isOperatorTransmitCycle(
        operator.getTransmitCycles(),
        utcSeconds,
        currentMode.slotMs
      );

      if (!isTransmitCycle) {
        console.log(`📻 [RadioOperatorManager] 操作员 ${operatorId} 不在发射周期内`);
        return;
      }

      // 获取操作员的发射内容
      const transmission = operator.transmissionStrategy?.handleTransmitSlot();
      if (!transmission) {
        return;
      }

      // 获取操作员的频率
      const frequency = operator.config.frequency || 0;

      // 注释：不在发射过程中设置频率，避免电台在PTT状态下拒绝频率变更
      // 频率应该在发射前预先设置，而不是在发射过程中设置

      // 广播发射日志
      this.eventEmitter.emit('transmissionLog' as any, {
        operatorId,
        time: new Date(currentSlotStartMs).toISOString().slice(11, 19).replace(/:/g, ''),
        message: transmission,
        frequency: frequency,
        slotStartMs: currentSlotStartMs
      });

      // 启动传输跟踪
      if (this.transmissionTracker) {
        const slotId = `slot-${currentSlotStartMs}`;
        const targetTransmitTime = currentSlotStartMs + (currentMode.transmitTiming || 0);
        this.transmissionTracker.startTransmission(operatorId, slotId, targetTransmitTime);
        this.transmissionTracker.updatePhase(operatorId, 'preparing' as any);
      }

      // 提交到编码队列
      this.encodeQueue.push({
        operatorId,
        message: transmission,
        frequency,
        mode: currentMode.name === 'FT4' ? 'FT4' : 'FT8',
        slotStartMs: currentSlotStartMs,
        timeSinceSlotStartMs: currentTimeSinceSlotStartMs
      });
    });
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
    console.log(`📻 [操作员管理器] 停止操作员 ${operatorId} 发射`);
    this.emitOperatorStatusUpdate(operatorId);
  }

  /**
   * 停止所有操作员发射
   * 通常在电台断开连接时调用
   */
  stopAllOperators(): void {
    let stoppedCount = 0;
    
    this.operators.forEach((operator, operatorId) => {
      if (operator.isTransmitting) {
        operator.stop();
        stoppedCount++;
        console.log(`📻 [操作员管理器] 停止操作员 ${operatorId} 发射（电台断开）`);
        this.emitOperatorStatusUpdate(operatorId);
      }
    });
    
    if (stoppedCount > 0) {
      console.log(`📻 [操作员管理器] 已停止 ${stoppedCount} 个操作员发射（电台断开连接）`);
    }
  }

  /**
   * 检查指定时隙是否有任何操作员准备发射
   * 基于slotInfo的时间判断周期，确保与解码数据的时隙一致
   * @param slotInfo 时隙信息，用于确定周期
   * @returns true 如果有操作员在该时隙的周期准备发射
   */
  hasActiveTransmissionsInCurrentCycle(slotInfo: any): boolean {
    if (!this.isRunning) {
      return false;
    }

    // 使用slotInfo的时间判断周期，而不是当前实时时间
    // 这样可以确保周期判断与解码数据的时隙一致
    // 即使解码窗口延迟到下一个时隙才触发（如windowTiming[4]=250），
    // 判断的仍然是slotInfo对应时隙的周期
    const utcSeconds = Math.floor(slotInfo.startMs / 1000);
    const currentMode = this.getCurrentMode();

    // 检查每个操作员
    for (const [operatorId, operator] of this.operators) {
      if (!operator.isTransmitting) {
        continue;
      }

      // 基于slotInfo的周期判断
      const isTransmitCycle = CycleUtils.isOperatorTransmitCycle(
        operator.getTransmitCycles(),
        utcSeconds,
        currentMode.slotMs
      );

      if (isTransmitCycle) {
        return true; // 找到准备发射的操作员
      }
    }

    return false;
  }

  /**
   * 从配置文件重新加载所有操作员
   */
  async reloadOperatorsFromConfig(): Promise<void> {
    console.log('🔄 [操作员管理器] 从配置文件重新加载操作员');
    
    // 停止并移除所有现有操作员
    for (const [id, operator] of this.operators.entries()) {
      operator.stop();
      this.operators.delete(id);
      console.log(`🛑 [操作员管理器] 移除操作员: ${id}`);
    }
    
    // 重新从配置文件加载操作员
    this.initializeOperatorsFromConfig();
    
    console.log('✅ [操作员管理器] 操作员重新加载完成');
  }

  /**
   * 同步添加操作员
   */
  async syncAddOperator(config: RadioOperatorConfig): Promise<RadioOperator> {
    const operator = await this.addOperator(config);
    
    /* if (this.isRunning) {
      operator.start();
    } */
    
    console.log(`📻 [操作员管理器] 同步添加操作员: ${config.id}`);
    this.broadcastOperatorListUpdate();
    
    return operator;
  }

  /**
   * 同步删除操作员
   */
  async syncRemoveOperator(id: string): Promise<void> {
    this.removeOperator(id);
    console.log(`📻 [操作员管理器] 同步删除操作员: ${id}`);
    this.broadcastOperatorListUpdate();
  }

  /**
   * 同步更新操作员配置
   */
  async syncUpdateOperator(config: RadioOperatorConfig): Promise<void> {
    const operator = this.operators.get(config.id);
    if (!operator) {
      throw new Error(`操作员 ${config.id} 不存在`);
    }

    const operatorConfig = this.convertToOperatorConfig(config);
    Object.assign(operator.config, operatorConfig);
    
    console.log(`📻 [操作员管理器] 同步更新操作员配置: ${config.id}`);
    this.broadcastOperatorListUpdate();
  }

  /**
   * 启动所有操作员
   */
  start(): void {
    this.isRunning = true;
    console.log('📻 [操作员管理器] 启动');
  }

  /**
   * 停止所有操作员
   */
  stop(): void {
    for (const operator of this.operators.values()) {
      operator.stop();
    }
    this.isRunning = false;
    console.log('📻 [操作员管理器] 停止');
  }

  /**
   * 清理资源
   */
  async cleanup(): Promise<void> {
    this.stop();
    this.operators.clear();
    this.pendingTransmissions = [];
    
    // 关闭日志管理器
    await this.logManager.close();
    
    console.log('📻 [操作员管理器] 清理完成');
  }

  /**
   * 发射操作员状态更新事件（触发前端更新）
   */
  emitOperatorStatusUpdate(operatorId: string): void {
    const operatorStatus = this.getOperatorsStatus().find(op => op.id === operatorId);
    if (operatorStatus) {
      this.eventEmitter.emit('operatorStatusUpdate', operatorStatus);
    }
  }

  /**
   * 广播所有操作员的状态更新
   * 注意：这个方法只发射事件，实际的过滤逻辑在WSServer中处理
   */
  broadcastAllOperatorStatusUpdates(): void {
    const operators = this.getOperatorsStatus();
    for (const operator of operators) {
      this.eventEmitter.emit('operatorStatusUpdate', operator);
    }
  }

  /**
   * 广播操作员列表更新
   */
  private broadcastOperatorListUpdate(): void {
    const operators = this.getOperatorsStatus();
    console.log(`📻 [操作员管理器] 广播操作员列表更新，包含 ${operators.length} 个操作员`);
    this.eventEmitter.emit('operatorsList', { operators });
  }

  /**
   * 用户命令处理（来自 RadioOperator）
   * 当操作员的发射周期被更改时触发发射检查
   */
  handleOperatorCommand(operatorId: string, command: any): void {
    if (command.command === 'set_transmit_cycles') {
      // 操作员的发射周期已更改，立即检查是否需要发射
      console.log(`📻 [操作员管理器] 操作员 ${operatorId} 的发射周期已更改`);
      this.checkAndTriggerTransmission(operatorId);
    }
  }
  
  /**
   * 获取日志管理器
   */
  getLogManager(): LogManager {
    return this.logManager;
  }
  
  /**
   * 处理WaveLog自动上传
   */
  private async handleWaveLogAutoUpload(qsoRecord: QSORecord, operatorId: string): Promise<void> {
    try {
      // 获取WaveLog配置
      const configManager = ConfigManager.getInstance();
      const waveLogConfig = configManager.getWaveLogConfig();
      
      // 检查是否启用自动上传
      if (!waveLogConfig.enabled || !waveLogConfig.autoUploadQSO) {
        console.log(`📊 [WaveLog] 自动上传已禁用，跳过 ${qsoRecord.callsign}`);
        return;
      }
      
      // 获取WaveLog服务实例
      const waveLogManager = WaveLogServiceManager.getInstance();
      const waveLogService = waveLogManager.getService();
      
      if (!waveLogService) {
        console.warn(`⚠️ [WaveLog] 服务未初始化，无法上传 ${qsoRecord.callsign}`);
        return;
      }
      
      console.log(`📊 [WaveLog] 开始自动上传 QSO: ${qsoRecord.callsign} (操作员: ${operatorId})`);
      
      // 上传QSO到WaveLog
      const result = await waveLogService.uploadQSO(qsoRecord, false);
      
      if (result.success) {
        console.log(`✅ [WaveLog] QSO 上传成功: ${qsoRecord.callsign}`);
        
        // 发射WaveLog上传成功事件
        this.eventEmitter.emit('waveLogUploadSuccess' as any, {
          operatorId,
          qsoRecord,
          message: result.message
        });
      } else {
        console.warn(`⚠️ [WaveLog] QSO 上传失败: ${qsoRecord.callsign} - ${result.message}`);
        
        // 发射WaveLog上传失败事件
        this.eventEmitter.emit('waveLogUploadFailed' as any, {
          operatorId,
          qsoRecord,
          message: result.message
        });
      }
      
    } catch (error) {
      console.error(`❌ [WaveLog] QSO 自动上传异常: ${qsoRecord.callsign}`, error);
      
      // 发射WaveLog上传错误事件
      this.eventEmitter.emit('waveLogUploadError' as any, {
        operatorId,
        qsoRecord,
        error: error instanceof Error ? error.message : '未知错误'
      });
    }
  }
} 
