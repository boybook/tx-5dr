import { EventEmitter } from 'eventemitter3';
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
  MODES
} from '@tx5dr/contracts';
import { ConfigManager } from '../config/config-manager.js';
import { LogManager } from '../log/LogManager.js';
import type { WSJTXEncodeWorkQueue, EncodeRequest as WSJTXEncodeRequest } from '../decode/WSJTXEncodeWorkQueue.js';

export interface RadioOperatorManagerOptions {
  eventEmitter: EventEmitter<DigitalRadioEngineEvents>;
  encodeQueue: WSJTXEncodeWorkQueue;
  clockSource: ClockSourceSystem;
  getCurrentMode: () => ModeDescriptor;
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
  private isRunning: boolean = false;
  private logManager: LogManager;

  constructor(options: RadioOperatorManagerOptions) {
    this.eventEmitter = options.eventEmitter;
    this.encodeQueue = options.encodeQueue;
    this.clockSource = options.clockSource;
    this.getCurrentMode = options.getCurrentMode;
    this.logManager = LogManager.getInstance();

    // 监听发射请求
    this.eventEmitter.on('requestTransmit', (request: TransmitRequest) => {
      this.pendingTransmissions.push(request);
    });
    
    // 监听记录QSO事件
    this.eventEmitter.on('recordQSO' as any, async (data: { operatorId: string; qsoRecord: QSORecord }) => {
      try {
        console.log(`📝 [操作员管理器] 记录QSO: ${data.qsoRecord.callsign} (操作员: ${data.operatorId})`);
        
        // 获取操作员连接的日志本
        const logBook = this.logManager.getOperatorLogBook(data.operatorId);
        if (!logBook) {
          throw new Error(`操作员 ${data.operatorId} 未连接到任何日志本`);
        }
        
        console.log(`📝 [操作员管理器] 记录QSO到日志本 ${logBook.name}: ${data.qsoRecord.callsign} @ ${new Date(data.qsoRecord.startTime).toISOString()}`);
        await logBook.provider.addQSO(data.qsoRecord, data.operatorId);
        
      } catch (error) {
        console.error(`❌ [操作员管理器] 记录QSO失败:`, error);
      }
    });
    
    // 监听检查是否已通联事件
    this.eventEmitter.on('checkHasWorkedCallsign' as any, async (data: { operatorId: string; callsign: string; requestId: string }) => {
      try {
        // 获取操作员连接的日志本
        const logBook = this.logManager.getOperatorLogBook(data.operatorId);
        if (!logBook) {
          throw new Error(`操作员 ${data.operatorId} 未连接到任何日志本`);
        }
        
        const hasWorked = await logBook.provider.hasWorkedCallsign(data.callsign, data.operatorId);
        
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
    
    this.initializeOperatorsFromConfig();
    
    console.log('✅ [操作员管理器] 初始化完成');
  }

  /**
   * 从配置文件初始化操作员
   */
  private initializeOperatorsFromConfig(): void {
    const configManager = ConfigManager.getInstance();
    const operatorsConfig = configManager.getOperatorsConfig();

    if (operatorsConfig.length === 0) {
      console.log('📻 [操作员管理器] 没有配置的操作员，等待用户创建');
      return;
    }

    for (const config of operatorsConfig) {
      try {
        const operator = this.addOperator(config);
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
  addOperator(config: RadioOperatorConfig): RadioOperator {
    if (this.operators.has(config.id)) {
      throw new Error(`操作员 ${config.id} 已存在`);
    }

    const operatorConfig = this.convertToOperatorConfig(config);
    const operator = new RadioOperator(
      operatorConfig,
      this.eventEmitter,
      (op: RadioOperator) => new StandardQSOStrategy(op)
    );
    
    // 如果配置中指定了日志本ID，连接到该日志本
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
  getOperatorLogBookInfo(operatorId: string): { logBookId: string; logBook: any } {
    const logBookId = this.logManager.getOperatorLogBookId(operatorId);
    const logBook = this.logManager.getLogBook(logBookId);
    
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
        
        const cycleNumber = Math.floor(currentSlotStartMs / slotMs);
        let isTransmitCycle = false;
        
        if (currentMode.cycleType === 'EVEN_ODD') {
          const evenOddCycle = cycleNumber % 2;
          isTransmitCycle = operator.getTransmitCycles().includes(evenOddCycle);
        } else if (currentMode.cycleType === 'CONTINUOUS') {
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
          console.error(`获取操作员 ${id} 的slots信息失败:`, error);
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
  updateOperatorContext(operatorId: string, context: any): void {
    const operator = this.operators.get(operatorId);
    if (!operator) {
      throw new Error(`操作员 ${operatorId} 不存在`);
    }
    
    // 更新基本信息
    if (context.myCall !== undefined) operator.config.myCallsign = context.myCall;
    if (context.myGrid !== undefined) operator.config.myGrid = context.myGrid;
    if (context.frequency !== undefined) operator.config.frequency = context.frequency;
    
    // 更新自动化设置
    if (context.autoReplyToCQ !== undefined) operator.config.autoReplyToCQ = context.autoReplyToCQ;
    if (context.autoResumeCQAfterFail !== undefined) operator.config.autoResumeCQAfterFail = context.autoResumeCQAfterFail;
    if (context.autoResumeCQAfterSuccess !== undefined) operator.config.autoResumeCQAfterSuccess = context.autoResumeCQAfterSuccess;
    if (context.replyToWorkedStations !== undefined) operator.config.replyToWorkedStations = context.replyToWorkedStations;
    if (context.prioritizeNewCalls !== undefined) operator.config.prioritizeNewCalls = context.prioritizeNewCalls;
    
    console.log(`📻 [操作员管理器] 更新操作员 ${operatorId} 上下文:`, context);
    this.emitOperatorStatusUpdate(operatorId);
    // 也广播完整操作员列表更新，确保前端能及时刷新
    this.broadcastOperatorListUpdate();
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
    
    // 检查是否在发射周期内
    const cycleNumber = Math.floor(currentSlotStartMs / slotMs);
    let isTransmitCycle = false;
    
    if (currentMode.cycleType === 'EVEN_ODD') {
      const evenOddCycle = cycleNumber % 2;
      isTransmitCycle = operator.getTransmitCycles().includes(evenOddCycle);
    } else if (currentMode.cycleType === 'CONTINUOUS') {
      isTransmitCycle = operator.getTransmitCycles().includes(cycleNumber);
    }
    
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
    
    // 立即将发射请求加入队列
    const request: TransmitRequest = {
      operatorId,
      transmission
    };
    this.pendingTransmissions.push(request);
    
    // 立即处理发射（传入 midSlot=true 标记）
    this.handleTransmissions(true);
    
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

      // 检查是否在发射周期内
      const cycleNumber = Math.floor(currentSlotStartMs / currentMode.slotMs);
      let isTransmitCycle = false;
      
      if (currentMode.cycleType === 'EVEN_ODD') {
        const evenOddCycle = cycleNumber % 2;
        isTransmitCycle = operator.getTransmitCycles().includes(evenOddCycle);
      } else if (currentMode.cycleType === 'CONTINUOUS') {
        isTransmitCycle = operator.getTransmitCycles().includes(cycleNumber);
      }

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

      // 广播发射日志
      this.eventEmitter.emit('transmissionLog' as any, {
        operatorId,
        time: new Date(currentSlotStartMs).toISOString().slice(11, 19).replace(/:/g, ''),
        message: transmission,
        frequency: frequency,
        slotStartMs: currentSlotStartMs
      });

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
    const operator = this.addOperator(config);
    
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
} 