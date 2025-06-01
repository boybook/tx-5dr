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
  MODES
} from '@tx5dr/contracts';
import { ConfigManager } from '../config/config-manager';
import type { WSJTXEncodeWorkQueue, EncodeRequest as WSJTXEncodeRequest } from '../decode/WSJTXEncodeWorkQueue';

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

  constructor(options: RadioOperatorManagerOptions) {
    this.eventEmitter = options.eventEmitter;
    this.encodeQueue = options.encodeQueue;
    this.clockSource = options.clockSource;
    this.getCurrentMode = options.getCurrentMode;

    // 监听发射请求
    this.eventEmitter.on('requestTransmit', (request: TransmitRequest) => {
      this.pendingTransmissions.push(request);
    });
  }

  /**
   * 初始化操作员管理器
   */
  initialize(): void {
    console.log('📻 [操作员管理器] 初始化...');
    this.initializeOperatorsFromConfig();
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
        operator.start();
        console.log(`📻 [操作员管理器] 操作员 ${config.id} 已创建并启动`);
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
   * 移除电台操作员
   */
  removeOperator(id: string): void {
    const operator = this.operators.get(id);
    if (operator) {
      operator.stop();
      this.operators.delete(id);
      console.log(`📻 [操作员管理器] 移除操作员: ${id}`);
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
    
    operator.config.myCallsign = context.myCall || operator.config.myCallsign;
    operator.config.myGrid = context.myGrid || operator.config.myGrid;
    operator.config.frequency = context.frequency || operator.config.frequency;
    
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
    
    if (this.isRunning) {
      operator.start();
    }
    
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
   * 处理发射请求
   */
  handleTransmissions(): void {
    if (this.pendingTransmissions.length === 0) {
      return;
    }

    const currentMode = this.getCurrentMode();
    const now = this.clockSource.now();
    const currentSlotStartMs = Math.floor(now / currentMode.slotMs) * currentMode.slotMs;
    const timeSinceSlotStartMs = now - currentSlotStartMs;
    
    // 只有在时隙刚开始时（前500ms内）才处理发射请求
    if (timeSinceSlotStartMs > 500) {
      console.log(`⏰ [操作员管理器] 时隙已过 ${timeSinceSlotStartMs}ms，跳过发射处理`);
      return;
    }

    console.log(`📢 [操作员管理器] 处理 ${this.pendingTransmissions.length} 个待发射消息`);
    
    const transmissionsToProcess = [...this.pendingTransmissions];
    this.pendingTransmissions = [];
    
    for (const request of transmissionsToProcess) {
      try {
        console.log(`📻 [发射] 操作员: ${request.operatorId}, 消息: "${request.transmission}"`);
        
        const operator = this.operators.get(request.operatorId);
        const frequency = operator?.config.frequency || 1500;
        
        const encodeRequest: WSJTXEncodeRequest = {
          operatorId: request.operatorId,
          message: request.transmission,
          frequency: frequency,
          mode: currentMode.name === 'FT4' ? 'FT4' : 'FT8'
        };
        
        console.log(`🎵 [发射] 编码参数: 频率=${frequency}Hz, 模式=${encodeRequest.mode}`);
        console.log(`⏰ [发射] 提交编码请求，将在适当时机播放`);
        
        this.encodeQueue.push(encodeRequest);
        
      } catch (error) {
        console.error(`❌ [发射失败] 操作员: ${request.operatorId}, 错误:`, error);
        
        this.eventEmitter.emit('transmissionComplete', {
          operatorId: request.operatorId,
          success: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
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
  cleanup(): void {
    this.stop();
    this.operators.clear();
    this.pendingTransmissions = [];
    console.log('📻 [操作员管理器] 清理完成');
  }

  /**
   * 发射操作员状态更新事件
   */
  private emitOperatorStatusUpdate(operatorId: string): void {
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
    this.eventEmitter.emit('operatorsList', operators);
  }
} 