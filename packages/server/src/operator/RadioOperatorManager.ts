/* eslint-disable @typescript-eslint/no-explicit-any */
// RadioOperatorManager - 事件处理和操作员管理需要使用any类型以处理动态事件

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
import { SyncServiceRegistry } from '../services/SyncServiceRegistry.js';
import { MemoryLeakDetector } from '../utils/MemoryLeakDetector.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('RadioOperatorManager');

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

  // 记录所有事件监听器,用于清理
  private eventListeners: Map<string, (...args: any[]) => void> = new Map();

  // 📊 Day13优化：记录上次发射的操作员状态哈希，用于去重
  private lastEmittedStatusHash: Map<string, string> = new Map();

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
    const handleRequestTransmit = (request: TransmitRequest) => {
      this.pendingTransmissions.push(request);
    };
    this.eventEmitter.on('requestTransmit', handleRequestTransmit);
    this.eventListeners.set('requestTransmit', handleRequestTransmit);

    // 监听记录QSO事件
    const handleRecordQSO = async (data: { operatorId: string; qsoRecord: QSORecord }) => {
      try {
        logger.info(`记录QSO: ${data.qsoRecord.callsign} (操作员: ${data.operatorId})`);
        
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

        logger.info(`记录QSO到日志本 ${logBook.name}: ${qsoToSave.callsign} @ ${new Date(qsoToSave.startTime).toISOString()} (${qsoToSave.frequency}Hz)`);
        await logBook.provider.addQSO(qsoToSave, data.operatorId);

        // QSO记录成功后，发射事件通知上层系统
        this.eventEmitter.emit('qsoRecordAdded' as any, {
          operatorId: data.operatorId,
          logBookId: logBook.id,
          qsoRecord: qsoToSave
        });
        logger.debug(`已发射 qsoRecordAdded 事件: ${data.qsoRecord.callsign}`);

        // 自动上传到同步服务（WaveLog/QRZ）- 使用修正后的频率数据
        const operatorCallsign = this.logManager.getOperatorCallsign(data.operatorId);
        if (operatorCallsign) {
          await this.handleAutoSync(qsoToSave, operatorCallsign, data.operatorId);
        }
        
        // 获取更新的统计信息并发射日志本更新事件
        try {
          const statistics = await logBook.provider.getStatistics();
          this.eventEmitter.emit('logbookUpdated' as any, {
            logBookId: logBook.id,
            statistics,
            operatorId: data.operatorId,
          });
          logger.debug(`已发射 logbookUpdated 事件: ${logBook.name}`);
        } catch (statsError) {
          console.warn(`⚠️ [操作员管理器] 获取日志本统计信息失败:`, statsError);
        }
        
      } catch (error) {
        console.error(`❌ [操作员管理器] 记录QSO失败:`, error);
      }
    };
    this.eventEmitter.on('recordQSO' as any, handleRecordQSO);
    this.eventListeners.set('recordQSO', handleRecordQSO);

    // 监听检查是否已通联事件
    const handleCheckHasWorkedCallsign = async (data: { operatorId: string; callsign: string; requestId: string }) => {
      try {
        // 获取操作员对应的日志本
        const logBook = await this.logManager.getOperatorLogBook(data.operatorId);
        let hasWorked = false;
        // 计算当前工作频段（用于按频段判重）：
        // 优先从物理电台读频率；否则退回到"最后选择的频率"配置
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
    };
    this.eventEmitter.on('checkHasWorkedCallsign' as any, handleCheckHasWorkedCallsign);
    this.eventListeners.set('checkHasWorkedCallsign', handleCheckHasWorkedCallsign);

    // 监听操作员发射周期变更事件
    const handleOperatorTransmitCyclesChanged = (data: { operatorId: string; transmitCycles: number[] }) => {
      logger.debug(`操作员 ${data.operatorId} 发射周期变更: [${data.transmitCycles.join(', ')}]`);
      // 立即检查并触发发射
      this.checkAndTriggerTransmission(data.operatorId);
      // 发送状态更新到前端
      this.emitOperatorStatusUpdate(data.operatorId);
    };
    this.eventEmitter.on('operatorTransmitCyclesChanged' as any, handleOperatorTransmitCyclesChanged);
    this.eventListeners.set('operatorTransmitCyclesChanged', handleOperatorTransmitCyclesChanged);

    // 监听操作员切换发射槽位事件
    const handleOperatorSlotChanged = (data: { operatorId: string; slot: string }) => {
      logger.debug(`操作员 ${data.operatorId} 切换发射槽位: ${data.slot}`);
      // 立即检查并触发发射
      this.checkAndTriggerTransmission(data.operatorId);
      // 发送状态更新到前端
      this.emitOperatorStatusUpdate(data.operatorId);
    };
    this.eventEmitter.on('operatorSlotChanged' as any, handleOperatorSlotChanged);
    this.eventListeners.set('operatorSlotChanged', handleOperatorSlotChanged);

    // 监听操作员发射内容变更事件
    const handleOperatorSlotContentChanged = (data: { operatorId: string; slot: string; content: string }) => {
      logger.debug(`操作员 ${data.operatorId} 编辑发射内容: 槽位=${data.slot}`);
      // 立即检查并触发发射（如果当前正在该槽位发射）
      const operator = this.operators.get(data.operatorId);
      if (operator) {
        const currentSlot = operator.transmissionStrategy?.userCommand?.({ command: 'get_state' } as any);
        if (currentSlot === data.slot) {
          logger.debug(`当前正在槽位 ${data.slot} 发射，立即更新发射内容`);
          this.checkAndTriggerTransmission(data.operatorId);
        }
      }
      // 发送状态更新到前端
      this.emitOperatorStatusUpdate(data.operatorId);
    };
    this.eventEmitter.on('operatorSlotContentChanged' as any, handleOperatorSlotContentChanged);
    this.eventListeners.set('operatorSlotContentChanged', handleOperatorSlotContentChanged);

    // 注册内存泄漏检测 (仅在开发环境启用)
    MemoryLeakDetector.getInstance().register('RadioOperatorManager', this.eventEmitter);
  }

  /**
   * 初始化操作员管理器
   */
  async initialize(): Promise<void> {
    logger.info('正在初始化...');
    
    // 初始化日志管理器
    await this.logManager.initialize();
    
    // 从配置文件初始化操作员（包括创建对应的日志本）
    await this.initializeOperatorsFromConfig();
    
    logger.info('初始化完成');
  }

  /**
   * 从配置文件初始化操作员
   */
  private async initializeOperatorsFromConfig(): Promise<void> {
    const configManager = ConfigManager.getInstance();
    const operatorsConfig = configManager.getOperatorsConfig();

    if (operatorsConfig.length === 0) {
      logger.info('没有配置的操作员，等待用户创建');
      return;
    }

    for (const config of operatorsConfig) {
      try {
        const operator = await this.addOperator(config);
        /* operator.start(); */
        logger.info(`操作员 ${config.id} 已创建`);
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
      (op: RadioOperator) => new StandardQSOStrategy(op),
      (myCallsign, targetCallsign, operatorId) =>
        this.isTargetBeingWorkedByOtherOperators(myCallsign, targetCallsign, operatorId)
    );
    
    // 注册操作员的呼号到日志管理器
    this.logManager.registerOperatorCallsign(config.id, config.myCallsign);
    
    // 立即为该呼号创建日志本
    try {
      await this.logManager.getOrCreateLogBookByCallsign(config.myCallsign);
      logger.info(`已为操作员 ${config.id} (呼号: ${config.myCallsign}) 创建日志本`);
    } catch (error) {
      console.error(`📻 [操作员管理器] 为操作员 ${config.id} (呼号: ${config.myCallsign}) 创建日志本失败:`, error);
    }
    
    // 如果配置中指定了日志本ID，连接到该日志本（向后兼容）
    if (config.logBookId) {
      this.connectOperatorToLogBook(config.id, config.logBookId);
    }
    
    // 监听操作员的slots更新事件
    operator.addSlotsUpdateListener((data: any) => {
      logger.debug(`操作员 ${data.operatorId} 的slots已更新`);
      this.emitOperatorStatusUpdate(data.operatorId);
    });

    // 监听操作员的状态变化事件
    operator.addStateChangeListener((data: any) => {
      logger.debug(`操作员 ${data.operatorId} 的状态已变化为: ${data.state}`);
      this.emitOperatorStatusUpdate(data.operatorId);
    });

    this.operators.set(config.id, operator);
    logger.info(`添加操作员: ${config.id}`);
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
    logger.info(`删除操作员: ${operatorId}`);
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
    logger.info(`操作员 ${operatorId} 已连接到日志本 ${logBookId}`);
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
    logger.info(`操作员 ${operatorId} 已断开日志本连接`);
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
      logger.debug(`已保存操作员 ${operatorId} 配置到文件:`, updates);
    }

    logger.debug(`更新操作员 ${operatorId} 上下文:`, context);
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
    
    logger.debug(`设置操作员 ${operatorId} 时隙: ${slot}`);
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
    logger.info(`启动操作员 ${operatorId} 发射`);
    
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
      logger.debug('操作员管理器未运行，跳过处理发射队列');
      return;
    }

    if (this.pendingTransmissions.length === 0) {
      logger.debug('发射队列为空，无待发射请求');
      return;
    }

    logger.debug(`处理发射队列: ${this.pendingTransmissions.length} 个待发射请求`);

    const currentMode = this.getCurrentMode();
    const slotStartMs = slotInfo.startMs; // 使用 slotInfo 中的准确时间戳
    const now = this.clockSource.now();
    const timeSinceSlotStartMs = now - slotStartMs;

    // 处理队列中的所有请求
    const requests = [...this.pendingTransmissions];
    this.pendingTransmissions = []; // 清空队列

    // 去重：相同操作员+相同消息只处理一次（防止重复发射）
    const uniqueRequests = requests.filter((req, index, self) =>
      index === self.findIndex(r =>
        r.operatorId === req.operatorId && r.transmission === req.transmission
      )
    );

    if (uniqueRequests.length < requests.length) {
      console.warn(`⚠️ [RadioOperatorManager] 检测到重复发射请求: ${requests.length} → ${uniqueRequests.length}`);
    }

    for (const request of uniqueRequests) {
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

      // 生成唯一的编码请求ID（用于去重和追踪）
      const requestId = `${operatorId}-${slotStartMs}-${Date.now()}`;

      // 提交到编码队列
      this.encodeQueue.push({
        operatorId,
        message: transmission,
        frequency,
        mode: currentMode.name === 'FT4' ? 'FT4' : 'FT8',
        slotStartMs: slotStartMs,
        timeSinceSlotStartMs: timeSinceSlotStartMs,
        requestId
      });

      logger.debug(`已处理操作员 ${operatorId} 的发射请求: "${transmission}", requestId=${requestId}`);
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
      logger.debug(`操作员 ${operatorId} 不在发射周期内`);
      // 即使不在发射周期内，也需要更新状态（cycleInfo会显示isTransmitCycle=false）
      this.emitOperatorStatusUpdate(operatorId);
      return;
    }
    
    // 生成发射内容
    const transmission = operator.transmissionStrategy?.handleTransmitSlot();
    if (!transmission) {
      logger.debug(`操作员 ${operatorId} 没有发射内容`);
      // 即使没有发射内容，也需要更新状态
      this.emitOperatorStatusUpdate(operatorId);
      return;
    }
    
    logger.debug(`在时隙中间触发发射: 操作员=${operatorId}, 已过时间=${timeSinceSlotStartMs}ms`);

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
      logger.debug('操作员管理器未运行，跳过处理发射请求');
      return;
    }

    // 获取当前时隙信息
    const now = this.clockSource.now();
    const currentMode = this.getCurrentMode();
    const currentSlotStartMs = Math.floor(now / currentMode.slotMs) * currentMode.slotMs;
    const currentTimeSinceSlotStartMs = now - currentSlotStartMs;

    logger.debug(`处理发射请求:`, {
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
        logger.debug(`操作员 ${operatorId} 不在发射周期内`);
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

      // 📝 注意：这里不发射 transmissionLog 事件
      // 原因：该方法当前未被调用（旧代码路径），且会与 processPendingTransmissions() 产生重复发射
      // transmissionLog 事件应该只在 processPendingTransmissions() 中统一发射

      // 启动传输跟踪
      if (this.transmissionTracker) {
        const slotId = `slot-${currentSlotStartMs}`;
        const targetTransmitTime = currentSlotStartMs + (currentMode.transmitTiming || 0);
        this.transmissionTracker.startTransmission(operatorId, slotId, targetTransmitTime);
        this.transmissionTracker.updatePhase(operatorId, 'preparing' as any);
      }

      // 生成唯一的编码请求ID（用于去重和追踪）
      const requestId = `${operatorId}-${currentSlotStartMs}-${Date.now()}`;

      // 提交到编码队列
      this.encodeQueue.push({
        operatorId,
        message: transmission,
        frequency,
        mode: currentMode.name === 'FT4' ? 'FT4' : 'FT8',
        slotStartMs: currentSlotStartMs,
        timeSinceSlotStartMs: currentTimeSinceSlotStartMs,
        requestId
      });

      logger.debug(`中途触发发射: ${operatorId}, requestId=${requestId}`);
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
    logger.info(`停止操作员 ${operatorId} 发射`);
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
        logger.info(`停止操作员 ${operatorId} 发射（电台断开）`);
        this.emitOperatorStatusUpdate(operatorId);
      }
    });
    
    if (stoppedCount > 0) {
      logger.info(`已停止 ${stoppedCount} 个操作员发射（电台断开连接）`);
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
    logger.info('从配置文件重新加载操作员');
    
    // 停止并移除所有现有操作员
    for (const [id, operator] of this.operators.entries()) {
      operator.stop();
      this.operators.delete(id);
      logger.info(`移除操作员: ${id}`);
    }
    
    // 重新从配置文件加载操作员
    this.initializeOperatorsFromConfig();
    
    logger.info('操作员重新加载完成');
  }

  /**
   * 同步添加操作员
   */
  async syncAddOperator(config: RadioOperatorConfig): Promise<RadioOperator> {
    const operator = await this.addOperator(config);
    
    /* if (this.isRunning) {
      operator.start();
    } */
    
    logger.info(`同步添加操作员: ${config.id}`);
    this.broadcastOperatorListUpdate();
    
    return operator;
  }

  /**
   * 同步删除操作员
   */
  async syncRemoveOperator(id: string): Promise<void> {
    this.removeOperator(id);
    logger.info(`同步删除操作员: ${id}`);
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
    
    logger.info(`同步更新操作员配置: ${config.id}`);
    this.broadcastOperatorListUpdate();
  }

  /**
   * 启动所有操作员
   */
  start(): void {
    this.isRunning = true;
    logger.info('启动');
  }

  /**
   * 停止所有操作员
   */
  stop(): void {
    for (const operator of this.operators.values()) {
      operator.stop();
    }
    this.isRunning = false;
    logger.info('停止');
  }

  /**
   * 清理资源
   */
  async cleanup(): Promise<void> {
    this.stop();

    // 移除所有事件监听器 (修复内存泄漏)
    logger.info(`移除 ${this.eventListeners.size} 个事件监听器`);
    for (const [eventName, handler] of this.eventListeners.entries()) {
      this.eventEmitter.off(eventName as any, handler);
    }
    this.eventListeners.clear();

    this.operators.clear();
    this.pendingTransmissions = [];

    // 关闭日志管理器
    await this.logManager.close();

    // 取消注册内存泄漏检测
    MemoryLeakDetector.getInstance().unregister('RadioOperatorManager');

    logger.info('清理完成');
  }

  /**
   * 发射操作员状态更新事件（触发前端更新）
   * 📊 Day13优化：添加状态去重，避免发射重复的状态更新
   */
  emitOperatorStatusUpdate(operatorId: string): void {
    const operatorStatus = this.getOperatorsStatus().find(op => op.id === operatorId);
    if (!operatorStatus) return;

    // 📊 计算状态哈希（仅包含关键字段）
    const statusHash = this.hashOperatorStatus(operatorStatus);
    const lastHash = this.lastEmittedStatusHash.get(operatorId);

    // 📊 状态去重：仅在状态变化时发送
    if (statusHash !== lastHash) {
      this.eventEmitter.emit('operatorStatusUpdate', operatorStatus);
      this.lastEmittedStatusHash.set(operatorId, statusHash);
    }
  }

  /**
   * 广播所有操作员的状态更新
   * 📊 Day13优化：使用去重方法，仅广播状态变化的操作员
   * 注意：实际的过滤逻辑在WSServer中处理
   */
  broadcastAllOperatorStatusUpdates(): void {
    const operators = this.getOperatorsStatus();
    for (const operator of operators) {
      // 📊 使用去重的方法，避免发射重复状态
      this.emitOperatorStatusUpdate(operator.id);
    }
  }

  /**
   * 广播操作员列表更新
   */
  private broadcastOperatorListUpdate(): void {
    const operators = this.getOperatorsStatus();
    logger.debug(`广播操作员列表更新，包含 ${operators.length} 个操作员`);
    this.eventEmitter.emit('operatorsList', { operators });
  }

  /**
   * 📊 Day13优化：计算操作员状态哈希（仅包含关键字段）
   * 用于状态去重，避免发射重复的状态更新
   *
   * 关键字段：
   * - isActive, isTransmitting, currentSlot（核心状态）
   * - context（完整上下文）
   * - strategy.state（策略状态）
   * - cycleInfo（周期信息）
   * - slots（时隙内容）
   * - transmitCycles（发射周期）
   *
   * 排除字段：
   * - id（标识符，非状态）
   * - strategy.name, strategy.availableSlots（基本不变）
   */
  private hashOperatorStatus(status: any): string {
    // 提取关键字段进行哈希
    const keyFields = {
      isActive: status.isActive,
      isTransmitting: status.isTransmitting,
      currentSlot: status.currentSlot,
      context: status.context,
      strategyState: status.strategy?.state,
      cycleInfo: status.cycleInfo,
      slots: status.slots,
      transmitCycles: status.transmitCycles,
    };

    // 使用 JSON 序列化作为哈希（简单有效）
    return JSON.stringify(keyFields);
  }

  /**
   * 用户命令处理（来自 RadioOperator）
   * 当操作员的发射周期被更改时触发发射检查
   */
  handleOperatorCommand(operatorId: string, command: any): void {
    if (command.command === 'set_transmit_cycles') {
      // 操作员的发射周期已更改，立即检查是否需要发射
      logger.debug(`操作员 ${operatorId} 的发射周期已更改`);
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
   * 检查指定呼号是否正在被其他同呼号操作者通联
   * @param myCallsign 自己的呼号
   * @param targetCallsign 要检查的目标呼号
   * @param currentOperatorId 当前操作者ID（排除自己）
   * @returns true表示有冲突，不应回复
   */
  isTargetBeingWorkedByOtherOperators(
    myCallsign: string,
    targetCallsign: string,
    currentOperatorId: string
  ): boolean {
    const normalizedMyCall = myCallsign.toUpperCase();
    const normalizedTarget = targetCallsign.toUpperCase();

    for (const [operatorId, operator] of this.operators.entries()) {
      // 跳过自己
      if (operatorId === currentOperatorId) continue;

      // 只检查同呼号的操作者
      if (operator.config.myCallsign.toUpperCase() !== normalizedMyCall) continue;

      // 检查该操作者的传输策略上下文
      const strategy = operator.transmissionStrategy as any;
      if (!strategy?.context) continue;

      // 检查是否正在通联目标呼号
      const currentTarget = strategy.context.targetCallsign;
      if (currentTarget && currentTarget.toUpperCase() === normalizedTarget) {
        // 检查是否在活跃的QSO状态或正在转换状态
        const currentState = strategy.getCurrentState?.();
        if (currentState) {
          // TX6状态下已设置目标 → 正在转换中 → 视为冲突
          if (currentState === 'TX6' && currentTarget) {
            logger.debug(`检测到冲突: 操作者 ${operatorId} (${operator.config.myCallsign}) 正在转换到 ${targetCallsign} (状态: ${currentState})`);
            return true;
          }
          // 非TX6状态（活跃QSO）→ 视为冲突
          if (currentState !== 'TX6') {
            logger.debug(`检测到冲突: 操作者 ${operatorId} (${operator.config.myCallsign}) 正在与 ${targetCallsign} 通联 (状态: ${currentState})`);
            return true;
          }
        }
      }
    }

    return false; // 无冲突
  }
  
  /**
   * 处理WaveLog自动上传
   */
  /**
   * 自动上传 QSO 到已启用的同步服务（WaveLog / QRZ）
   * LoTW 不支持逐条上传（需 TQSL 批量签名），跳过
   */
  private async handleAutoSync(qsoRecord: QSORecord, callsign: string, operatorId: string): Promise<void> {
    const registry = SyncServiceRegistry.getInstance();
    const configManager = ConfigManager.getInstance();
    const syncConfig = configManager.getCallsignSyncConfig(callsign);

    // WaveLog 自动上传
    const waveLogService = registry.getWaveLogService(callsign);
    if (waveLogService && syncConfig?.wavelog?.autoUploadQSO) {
      try {
        logger.info(`[WaveLog] 开始自动上传 QSO: ${qsoRecord.callsign} (呼号: ${callsign})`);
        const result = await waveLogService.uploadQSO(qsoRecord, false);
        if (result.success) {
          logger.info(`[WaveLog] QSO 上传成功: ${qsoRecord.callsign}`);
          this.eventEmitter.emit('waveLogUploadSuccess' as any, { operatorId, qsoRecord, message: result.message });
        } else {
          console.warn(`⚠️ [WaveLog] QSO 上传失败: ${qsoRecord.callsign} - ${result.message}`);
          this.eventEmitter.emit('waveLogUploadFailed' as any, { operatorId, qsoRecord, message: result.message });
        }
      } catch (error) {
        console.error(`❌ [WaveLog] QSO 自动上传异常: ${qsoRecord.callsign}`, error);
        this.eventEmitter.emit('waveLogUploadError' as any, {
          operatorId, qsoRecord, error: error instanceof Error ? error.message : '未知错误'
        });
      }
    }

    // QRZ 自动上传
    const qrzService = registry.getQRZService(callsign);
    if (qrzService && syncConfig?.qrz?.autoUploadQSO) {
      try {
        logger.info(`[QRZ] 开始自动上传 QSO: ${qsoRecord.callsign} (呼号: ${callsign})`);
        const result = await qrzService.uploadQSO(qsoRecord);
        if (result.success) {
          logger.info(`[QRZ] QSO 上传成功: ${qsoRecord.callsign}`);
        } else {
          console.warn(`⚠️ [QRZ] QSO 上传失败: ${qsoRecord.callsign} - ${result.message}`);
        }
      } catch (error) {
        console.error(`❌ [QRZ] QSO 自动上传异常: ${qsoRecord.callsign}`, error);
      }
    }
  }
} 
