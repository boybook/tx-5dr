/* eslint-disable @typescript-eslint/no-explicit-any */
// RadioOperatorManager - 事件处理和操作员管理需要使用any类型以处理动态事件

import EventEmitter from 'eventemitter3';
import {
  RadioOperator,
  StandardQSOStrategy,
  ClockSourceSystem,
  FT8MessageParser,
} from '@tx5dr/core';
import {
  type RadioOperatorConfig,
  type OperatorConfig,
  type TransmitRequest,
  type DigitalRadioEngineEvents,
  type ModeDescriptor,
  type QSORecord,
  type SlotPack,
  type FrameMessage,
  MODES,
} from '@tx5dr/contracts';
import { CycleUtils, getBandFromFrequency } from '@tx5dr/core';
import { ConfigManager } from '../config/config-manager.js';
import { LogManager } from '../log/LogManager.js';
import type { WSJTXEncodeWorkQueue } from '../decode/WSJTXEncodeWorkQueue.js';
import type { SlotPackManager } from '../slot/SlotPackManager.js';
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
  slotPackManager: SlotPackManager;
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
  private slotPackManager: SlotPackManager;
  private isRunning: boolean = false;
  private logManager: LogManager;
  private transmissionTracker: any; // TransmissionTracker实例
  private getRadioFrequency?: () => Promise<number | null>;

  // 记录所有事件监听器,用于清理
  private eventListeners: Map<string, (...args: any[]) => void> = new Map();

  // 晚到解码重决策相关状态
  private static readonly REDECIDE_DEADLINE_MS = 4000;

  // 每个操作员的最新编码请求ID，用于丢弃过期编码结果
  private latestEncodeRequestIds: Map<string, string> = new Map();

  // 📊 Day13优化：记录上次发射的操作员状态哈希，用于去重
  private lastEmittedStatusHash: Map<string, string> = new Map();

  // 当前正在实际PTT发射的操作员ID集合
  private activeTransmissionOperatorIds: Set<string> = new Set();

  constructor(options: RadioOperatorManagerOptions) {
    this.eventEmitter = options.eventEmitter;
    this.encodeQueue = options.encodeQueue;
    this.clockSource = options.clockSource;
    this.getCurrentMode = options.getCurrentMode;
    this.setRadioFrequency = options.setRadioFrequency;
    this.slotPackManager = options.slotPackManager;
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
        logger.debug(`Recording QSO: ${data.qsoRecord.callsign} (operator: ${data.operatorId})`);

        // 获取操作员对应的日志本
        const logBook = await this.logManager.getOperatorLogBook(data.operatorId);
        if (!logBook) {
          const callsign = this.logManager.getOperatorCallsign(data.operatorId);
          if (!callsign) {
            logger.error(`Cannot record QSO: operator ${data.operatorId} has no registered callsign`);
            return;
          } else {
            logger.error(`Cannot record QSO: failed to create logbook for operator ${data.operatorId} (callsign: ${callsign})`);
            return;
          }
        }
        
        // 兜底校正频率：防止误将音频偏移(Hz)写入为绝对频率
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
              logger.warn(`Using last selected frequency as base frequency: ${baseFreq}Hz`);
            }
          } catch {}
        }
        const originalFreq = data.qsoRecord.frequency || 0;
        let normalizedFreq = originalFreq;
        // 若记录频率小于1MHz，且操作员基础频率有效，则视为偏移量进行修正
        if (originalFreq > 0 && originalFreq < 1_000_000 && baseFreq > 1_000_000) {
          normalizedFreq = baseFreq + originalFreq;
          logger.warn(`Abnormal frequency detected (${originalFreq}Hz), corrected to offset-based value ${normalizedFreq}Hz (base freq ${baseFreq}Hz)`);
        } else if (originalFreq === 0 && baseFreq > 1_000_000) {
          normalizedFreq = baseFreq;
          logger.warn(`QSO frequency missing, using base frequency ${normalizedFreq}Hz`);
        }

        const normalizedQSO: QSORecord = {
          ...data.qsoRecord,
          frequency: normalizedFreq
        };

        const completedQSO = await this.completeAutomaticQSORecord(data.operatorId, normalizedQSO);
        const mergeCandidate = await this.findMergeCandidate(logBook.provider, completedQSO);

        let persistedQSO = completedQSO;
        let eventName: 'qsoRecordAdded' | 'qsoRecordUpdated' = 'qsoRecordAdded';

        if (mergeCandidate) {
          const mergedQSO = this.mergeQSORecord(mergeCandidate, completedQSO);
          const { id: _id, ...updates } = mergedQSO;

          logger.debug(`Updating existing QSO ${mergeCandidate.id} in logbook ${logBook.name}: ${mergedQSO.callsign} @ ${new Date(mergedQSO.startTime).toISOString()} (${mergedQSO.frequency}Hz)`);
          await logBook.provider.updateQSO(mergeCandidate.id, updates);
          persistedQSO = await logBook.provider.getQSO(mergeCandidate.id) ?? { ...mergedQSO, id: mergeCandidate.id };
          eventName = 'qsoRecordUpdated';
        } else {
          logger.debug(`Saving QSO to logbook ${logBook.name}: ${completedQSO.callsign} @ ${new Date(completedQSO.startTime).toISOString()} (${completedQSO.frequency}Hz)`);
          await logBook.provider.addQSO(completedQSO, data.operatorId);
          persistedQSO = completedQSO;

          // 自动上传到同步服务（WaveLog/QRZ/LoTW）仅在新增时触发，避免外部重复记录
          const operatorCallsign = this.logManager.getOperatorCallsign(data.operatorId);
          if (operatorCallsign) {
            await this.handleAutoSync(persistedQSO, operatorCallsign, data.operatorId);
          }
        }

        this.eventEmitter.emit(eventName as any, {
          operatorId: data.operatorId,
          logBookId: logBook.id,
          qsoRecord: persistedQSO
        });
        logger.debug(`Emitted ${eventName} event: ${persistedQSO.callsign}`);
        
        // 获取更新的统计信息并发射日志本更新事件
        try {
          const statistics = await logBook.provider.getStatistics();
          this.eventEmitter.emit('logbookUpdated' as any, {
            logBookId: logBook.id,
            statistics,
            operatorId: data.operatorId,
          });
          logger.debug(`Emitted logbookUpdated event: ${logBook.name}`);
        } catch (statsError) {
          logger.warn(`Failed to get logbook statistics:`, statsError);
        }

      } catch (error) {
        logger.error(`Failed to record QSO:`, error);
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
            logger.warn(`Check has-worked: operator ${data.operatorId} has no registered callsign, returning false`);
            hasWorked = false;
          } else {
            logger.warn(`Check has-worked: logbook not found for operator ${data.operatorId} (callsign: ${callsign}), returning false`);
            hasWorked = false;
          }
        } else {
          hasWorked = await logBook.provider.hasWorkedCallsign(data.callsign, { band });
        }

        // 发送响应
        this.eventEmitter.emit('hasWorkedCallsignResponse' as any, {
          requestId: data.requestId,
          hasWorked
        });
      } catch (error) {
        logger.error(`Failed to check callsign:`, error);
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
      logger.debug(`Operator ${data.operatorId} transmit cycles changed: [${data.transmitCycles.join(', ')}]`);
      // 立即检查并触发发射
      this.checkAndTriggerTransmission(data.operatorId);
      // 发送状态更新到前端
      this.emitOperatorStatusUpdate(data.operatorId);
    };
    this.eventEmitter.on('operatorTransmitCyclesChanged' as any, handleOperatorTransmitCyclesChanged);
    this.eventListeners.set('operatorTransmitCyclesChanged', handleOperatorTransmitCyclesChanged);

    // 监听操作员切换发射槽位事件
    const handleOperatorSlotChanged = (data: { operatorId: string; slot: string }) => {
      logger.debug(`Operator ${data.operatorId} slot changed: ${data.slot}`);
      // 立即检查并触发发射
      this.checkAndTriggerTransmission(data.operatorId);
      // 发送状态更新到前端
      this.emitOperatorStatusUpdate(data.operatorId);
    };
    this.eventEmitter.on('operatorSlotChanged' as any, handleOperatorSlotChanged);
    this.eventListeners.set('operatorSlotChanged', handleOperatorSlotChanged);

    // 监听操作员频率变更事件 — 仅当该操作员正在实际 PTT 发射时触发重编码
    const handleOperatorFrequencyChanged = (data: { operatorId: string; frequency: number }) => {
      logger.debug(`Operator ${data.operatorId} frequency changed: ${data.frequency}`);
      if (this.activeTransmissionOperatorIds.has(data.operatorId)) {
        this.checkAndTriggerTransmission(data.operatorId);
      }
      this.emitOperatorStatusUpdate(data.operatorId);
    };
    this.eventEmitter.on('operatorFrequencyChanged' as any, handleOperatorFrequencyChanged);
    this.eventListeners.set('operatorFrequencyChanged', handleOperatorFrequencyChanged);

    // 监听操作员发射内容变更事件
    const handleOperatorSlotContentChanged = (data: { operatorId: string; slot: string; content: string }) => {
      logger.debug(`Operator ${data.operatorId} slot content edited: slot=${data.slot}`);
      // 立即检查并触发发射（如果当前正在该槽位发射）
      const operator = this.operators.get(data.operatorId);
      if (operator) {
        const currentSlot = operator.transmissionStrategy?.userCommand?.({ command: 'get_state' } as any);
        if (currentSlot === data.slot) {
          logger.debug(`Currently transmitting on slot ${data.slot}, updating content immediately`);
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
    logger.info('Initializing...');

    // 初始化日志管理器
    await this.logManager.initialize();

    // 从配置文件初始化操作员（包括创建对应的日志本）
    await this.initializeOperatorsFromConfig();

    logger.info('Initialized');
  }

  /**
   * 从配置文件初始化操作员
   */
  private async initializeOperatorsFromConfig(): Promise<void> {
    const configManager = ConfigManager.getInstance();
    const operatorsConfig = configManager.getOperatorsConfig();

    if (operatorsConfig.length === 0) {
      logger.info('No operators configured, waiting for user to create one');
      return;
    }

    for (const config of operatorsConfig) {
      try {
        const _operator = await this.addOperator(config);
        /* operator.start(); */
        logger.info(`Operator ${config.id} created`);
      } catch (error) {
        logger.error(`Failed to create operator ${config.id}:`, error);
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
      targetSelectionPriorityMode: config.targetSelectionPriorityMode ?? (config.prioritizeNewCalls === false ? 'balanced' : 'dxcc_first'),
      mode: config.mode || MODES.FT8,
    };
  }

  /**
   * 添加电台操作员
   */
  async addOperator(config: RadioOperatorConfig): Promise<RadioOperator> {
    if (this.operators.has(config.id)) {
      throw new Error(`operator ${config.id} already exists`);
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
      logger.info(`Created logbook for operator ${config.id} (callsign: ${config.myCallsign})`);
    } catch (error) {
      logger.error(`Failed to create logbook for operator ${config.id} (callsign: ${config.myCallsign}):`, error);
    }
    
    // 如果配置中指定了日志本ID，连接到该日志本（向后兼容）
    if (config.logBookId) {
      this.connectOperatorToLogBook(config.id, config.logBookId);
    }
    
    // 监听操作员的slots更新事件
    operator.addSlotsUpdateListener((data: any) => {
      logger.debug(`Operator ${data.operatorId} slots updated`);
      this.emitOperatorStatusUpdate(data.operatorId);
    });

    // 监听操作员的状态变化事件
    operator.addStateChangeListener((data: any) => {
      logger.debug(`Operator ${data.operatorId} state changed to: ${data.state}`);
      this.emitOperatorStatusUpdate(data.operatorId);
    });

    this.operators.set(config.id, operator);
    logger.info(`Operator added: ${config.id}`);
    return operator;
  }

  /**
   * 删除操作员
   */
  removeOperator(operatorId: string): void {
    const operator = this.operators.get(operatorId);
    if (!operator) {
      throw new Error(`operator ${operatorId} not found`);
    }

    // 断开与日志本的连接
    this.logManager.disconnectOperatorFromLogBook(operatorId);
    
    this.operators.delete(operatorId);
    logger.info(`Operator removed: ${operatorId}`);
  }

  /**
   * 将操作员连接到指定日志本
   */
  async connectOperatorToLogBook(operatorId: string, logBookId: string): Promise<void> {
    const operator = this.operators.get(operatorId);
    if (!operator) {
      throw new Error(`operator ${operatorId} not found`);
    }

    await this.logManager.connectOperatorToLogBook(operatorId, logBookId);
    logger.info(`Operator ${operatorId} connected to logbook ${logBookId}`);
  }

  /**
   * 断开操作员与日志本的连接（使用默认日志本）
   */
  disconnectOperatorFromLogBook(operatorId: string): void {
    const operator = this.operators.get(operatorId);
    if (!operator) {
      throw new Error(`operator ${operatorId} not found`);
    }

    this.logManager.disconnectOperatorFromLogBook(operatorId);
    logger.info(`Operator ${operatorId} disconnected from logbook`);
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
          logger.error(`Failed to get status for operator ${id}:`, error);
          slots = {};
        }
      }
      
      operators.push({
        id,
        isActive: this.isRunning,
        isTransmitting: operator.isTransmitting,
        isInActivePTT: this.activeTransmissionOperatorIds.has(id),
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
          targetSelectionPriorityMode: operator.config.targetSelectionPriorityMode,
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
      throw new Error(`operator ${operatorId} not found`);
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
    if (context.frequency !== undefined) {
      const clampedFreq = Math.max(1, Math.min(3000, context.frequency));
      if (clampedFreq !== operator.config.frequency) {
        operator.config.frequency = clampedFreq;
        updates.frequency = clampedFreq;
        // 如果该操作员正在实际 PTT 发射，触发重编码和重混音
        if (this.activeTransmissionOperatorIds.has(operatorId)) {
          this.checkAndTriggerTransmission(operatorId);
        }
      }
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
    if (context.targetSelectionPriorityMode !== undefined && context.targetSelectionPriorityMode !== operator.config.targetSelectionPriorityMode) {
      operator.config.targetSelectionPriorityMode = context.targetSelectionPriorityMode;
      updates.targetSelectionPriorityMode = context.targetSelectionPriorityMode;
    }

    // 如果有任何字段发生了变化，保存到配置文件
    if (Object.keys(updates).length > 0) {
      const configManager = ConfigManager.getInstance();
      await configManager.updateOperatorConfig(operatorId, updates);
      logger.debug(`Saved operator ${operatorId} config to file:`, updates);
    }

    logger.debug(`Updated operator ${operatorId} context:`, context);
    this.emitOperatorStatusUpdate(operatorId);
  }

  /**
   * 仅持久化操作员上下文到配置文件（不更新内存、不触发广播）
   * 用于 handleUserCommand 中 update_context 的持久化步骤，
   * 内存更新已由 operator.userCommand 处理。
   */
  async persistOperatorContext(operatorId: string, context: any): Promise<void> {
    const operator = this.operators.get(operatorId);
    if (!operator) {
      throw new Error(`operator ${operatorId} not found`);
    }

    // 比较并构建更新对象（仅包含实际变化的字段）
    const updates: Partial<RadioOperatorConfig> = {};

    if (context.myCall !== undefined && context.myCall !== operator.config.myCallsign) {
      updates.myCallsign = context.myCall;
    }
    if (context.myGrid !== undefined && context.myGrid !== operator.config.myGrid) {
      updates.myGrid = context.myGrid;
    }
    if (context.frequency !== undefined) {
      const clampedFreq = Math.max(1, Math.min(3000, context.frequency));
      if (clampedFreq !== operator.config.frequency) {
        updates.frequency = clampedFreq;
      }
    }
    if (context.autoReplyToCQ !== undefined && context.autoReplyToCQ !== operator.config.autoReplyToCQ) {
      updates.autoReplyToCQ = context.autoReplyToCQ;
    }
    if (context.autoResumeCQAfterFail !== undefined && context.autoResumeCQAfterFail !== operator.config.autoResumeCQAfterFail) {
      updates.autoResumeCQAfterFail = context.autoResumeCQAfterFail;
    }
    if (context.autoResumeCQAfterSuccess !== undefined && context.autoResumeCQAfterSuccess !== operator.config.autoResumeCQAfterSuccess) {
      updates.autoResumeCQAfterSuccess = context.autoResumeCQAfterSuccess;
    }
    if (context.replyToWorkedStations !== undefined && context.replyToWorkedStations !== operator.config.replyToWorkedStations) {
      updates.replyToWorkedStations = context.replyToWorkedStations;
    }
    if (context.prioritizeNewCalls !== undefined && context.prioritizeNewCalls !== operator.config.prioritizeNewCalls) {
      updates.prioritizeNewCalls = context.prioritizeNewCalls;
    }
    if (context.targetSelectionPriorityMode !== undefined && context.targetSelectionPriorityMode !== operator.config.targetSelectionPriorityMode) {
      updates.targetSelectionPriorityMode = context.targetSelectionPriorityMode;
    }

    if (Object.keys(updates).length > 0) {
      const configManager = ConfigManager.getInstance();
      await configManager.updateOperatorConfig(operatorId, updates);
      logger.debug(`Persisted operator ${operatorId} context to file:`, updates);
    }
  }

  /**
   * 设置操作员时隙
   */
  setOperatorSlot(operatorId: string, slot: string): void {
    const operator = this.operators.get(operatorId);
    if (!operator) {
      throw new Error(`operator ${operatorId} not found`);
    }
    
    operator.userCommand({
      type: 'setSlot',
      slot: slot
    } as any);
    
    logger.debug(`Set operator ${operatorId} slot: ${slot}`);
    this.emitOperatorStatusUpdate(operatorId);
  }

  /**
   * 启动操作员发射
   */
  startOperator(operatorId: string): void {
    const operator = this.operators.get(operatorId);
    if (!operator) {
      throw new Error(`operator ${operatorId} not found`);
    }
    
    operator.start();
    logger.info(`Started transmitting for operator ${operatorId}`);
    
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
      logger.debug('Manager not running, skipping transmission queue processing');
      return;
    }

    if (this.pendingTransmissions.length === 0) {
      logger.debug('Transmission queue is empty, no pending requests');
      return;
    }

    logger.debug(`Processing transmission queue: ${this.pendingTransmissions.length} pending request(s)`);

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
      logger.warn(`Duplicate transmit requests detected: ${requests.length} → ${uniqueRequests.length}`);
    }

    for (const request of uniqueRequests) {
      const operatorId = request.operatorId;
      const transmission = request.transmission;

      // 获取操作员的频率
      const operator = this.operators.get(operatorId);
      if (!operator) {
        logger.warn(`Operator ${operatorId} not found, skipping transmit request`);
        continue;
      }

      const frequency = operator.config.frequency || 0;

      // 广播发射日志
      this.eventEmitter.emit('transmissionLog' as any, {
        operatorId,
        time: new Date(slotStartMs).toISOString().slice(11, 19).replace(/:/g, ''),
        message: transmission,
        frequency: frequency,
        slotStartMs: slotStartMs,
        replaceExisting: request.replaceExisting,
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

      // 记录该操作员的最新编码请求ID（用于丢弃过期编码结果）
      this.latestEncodeRequestIds.set(operatorId, requestId);

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

      logger.debug(`Processed transmit request for operator ${operatorId}: "${transmission}", requestId=${requestId}`);
    }
  }

  /**
   * 检查并触发单个操作员的发射
   * 用于在时隙中间启动或切换发射周期时立即触发
   */
  private checkAndTriggerTransmission(operatorId: string, options?: { replaceExisting?: boolean }): void {
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
      logger.debug(`Operator ${operatorId} is not in a transmit cycle`);
      // 即使不在发射周期内，也需要更新状态（cycleInfo会显示isTransmitCycle=false）
      this.emitOperatorStatusUpdate(operatorId);
      return;
    }

    // 生成发射内容
    const transmission = operator.transmissionStrategy?.handleTransmitSlot();
    if (!transmission) {
      logger.debug(`Operator ${operatorId} has no transmission content`);
      // 即使没有发射内容，也需要更新状态
      this.emitOperatorStatusUpdate(operatorId);
      return;
    }
    
    logger.debug(`Mid-slot transmission triggered: operator=${operatorId}, elapsed=${timeSinceSlotStartMs}ms`);

    // 将发射请求加入队列（仅入队，交由统一的队列消费层处理）
    const request: TransmitRequest = {
      operatorId,
      transmission,
      replaceExisting: options?.replaceExisting,
    };
    this.pendingTransmissions.push(request);
    operator.notifyTransmissionQueued(transmission);

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
   * 当晚到的解码结果更新 SlotPack 时调用。
   * 立即评估是否需要重决策（依赖 messageSet 过滤防止无效触发）。
   * @param slotPack 更新后的 SlotPack
   */
  reDecideOnLateDecodes(slotPack: SlotPack): void {
    if (!this.isRunning) return;

    const now = this.clockSource.now();
    const mode = this.getCurrentMode();
    const slotMs = mode.slotMs;
    const currentSlotStartMs = Math.floor(now / slotMs) * slotMs;
    const elapsed = now - currentSlotStartMs;

    if (elapsed > RadioOperatorManager.REDECIDE_DEADLINE_MS) return;

    // 立即执行重决策（不 debounce），依赖 messageSet 过滤 + latestEncodeRequestIds 防止副作用
    this.executeReDecision(slotPack);
  }

  /**
   * 获取操作员的最新编码请求ID（用于过期编码结果检查）
   */
  getLatestEncodeRequestId(operatorId: string): string | undefined {
    return this.latestEncodeRequestIds.get(operatorId);
  }

  /**
   * 时隙边界清理：清空编码请求ID映射
   */
  onSlotBoundary(): void {
    this.latestEncodeRequestIds.clear();
  }

  /**
   * 执行晚到解码重决策
   */
  private async executeReDecision(slotPack: SlotPack): Promise<void> {
    if (!this.isRunning) return;

    const now = this.clockSource.now();
    const mode = this.getCurrentMode();
    const slotMs = mode.slotMs;
    const currentSlotStartMs = Math.floor(now / slotMs) * slotMs;

    if (now - currentSlotStartMs > RadioOperatorManager.REDECIDE_DEADLINE_MS) return;

    for (const [operatorId, operator] of this.operators) {
      if (!operator.isTransmitting) continue;

      const utcSeconds = Math.floor(currentSlotStartMs / 1000);
      const isTransmitCycle = CycleUtils.isOperatorTransmitCycle(
        operator.getTransmitCycles(), utcSeconds, slotMs
      );
      if (!isTransmitCycle) continue;

      try {
        const changed = await operator.reDecideWithUpdatedSlotPack(slotPack);
        if (changed) {
          logger.info(`Late decode re-decision triggered re-encode for operator ${operatorId}`);
          this.checkAndTriggerTransmission(operatorId, { replaceExisting: true });
        }
      } catch (err) {
        logger.error(`Late re-decision failed for operator ${operatorId}:`, err);
      }
    }
  }

  /**
   * 处理发射请求
   * @param midSlot 是否在时隙中间调用（默认false）
   */
  handleTransmissions(midSlot: boolean = false): void {
    if (!this.isRunning) {
      logger.debug('Manager not running, skipping transmission handling');
      return;
    }

    // 获取当前时隙信息
    const now = this.clockSource.now();
    const currentMode = this.getCurrentMode();
    const currentSlotStartMs = Math.floor(now / currentMode.slotMs) * currentMode.slotMs;
    const currentTimeSinceSlotStartMs = now - currentSlotStartMs;

    logger.debug(`Handling transmissions:`, {
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
        logger.debug(`Operator ${operatorId} is not in a transmit cycle`);
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

      logger.debug(`Mid-slot transmission triggered: ${operatorId}, requestId=${requestId}`);
    });
  }

  /**
   * 停止操作员发射
   */
  stopOperator(operatorId: string): void {
    const operator = this.operators.get(operatorId);
    if (!operator) {
      throw new Error(`operator ${operatorId} not found`);
    }
    
    operator.stop();
    logger.info(`Stopped transmitting for operator ${operatorId}`);
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
        logger.info(`Stopped transmitting for operator ${operatorId} (radio disconnected)`);
        this.emitOperatorStatusUpdate(operatorId);
      }
    });
    
    if (stoppedCount > 0) {
      logger.info(`Stopped ${stoppedCount} operator(s) transmitting (radio disconnected)`);
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
    for (const [_operatorId, operator] of this.operators) {
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
    logger.info('Reloading operators from config file');

    // 停止并移除所有现有操作员
    for (const [id, operator] of this.operators.entries()) {
      operator.stop();
      this.operators.delete(id);
      logger.info(`Operator removed: ${id}`);
    }

    // 重新从配置文件加载操作员
    this.initializeOperatorsFromConfig();

    logger.info('Operators reloaded');
  }

  /**
   * 同步添加操作员
   */
  async syncAddOperator(config: RadioOperatorConfig): Promise<RadioOperator> {
    const operator = await this.addOperator(config);
    
    /* if (this.isRunning) {
      operator.start();
    } */
    
    logger.info(`Operator synced and added: ${config.id}`);
    this.broadcastOperatorListUpdate();
    
    return operator;
  }

  /**
   * 同步删除操作员
   */
  async syncRemoveOperator(id: string): Promise<void> {
    this.removeOperator(id);
    logger.info(`Operator synced and removed: ${id}`);
    this.broadcastOperatorListUpdate();
  }

  /**
   * 同步更新操作员配置
   */
  async syncUpdateOperator(config: RadioOperatorConfig): Promise<void> {
    const operator = this.operators.get(config.id);
    if (!operator) {
      throw new Error(`operator ${config.id} not found`);
    }

    const operatorConfig = this.convertToOperatorConfig(config);
    Object.assign(operator.config, operatorConfig);
    
    logger.info(`Operator config synced and updated: ${config.id}`);
    this.emitOperatorStatusUpdate(config.id);
  }

  /**
   * 将操作员发射周期持久化到配置文件
   * 当通过 WS 命令 set_transmit_cycles 修改时，需要同步到配置文件，
   * 否则下次 syncUpdateOperator() 会用文件旧值覆盖内存中的新值
   */
  async persistTransmitCycles(operatorId: string, transmitCycles: number[]): Promise<void> {
    const configManager = ConfigManager.getInstance();
    await configManager.updateOperatorConfig(operatorId, { transmitCycles });
    logger.debug(`Persisted transmitCycles for operator ${operatorId}: [${transmitCycles.join(', ')}]`);
  }

  /**
   * 启动所有操作员
   */
  start(): void {
    this.isRunning = true;
    logger.info('Started');
  }

  /**
   * 停止所有操作员
   */
  stop(): void {
    for (const operator of this.operators.values()) {
      operator.stop();
    }
    this.isRunning = false;
    logger.info('Stopped');
  }

  /**
   * 清理资源
   */
  async cleanup(): Promise<void> {
    this.stop();

    // 移除所有事件监听器 (修复内存泄漏)
    logger.info(`Removing ${this.eventListeners.size} event listener(s)`);
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

    logger.info('Cleanup complete');
  }

  /**
   * 更新当前正在实际PTT发射的操作员列表
   * 当PTT状态变更（开始/停止/重混音）时由TransmissionPipeline调用
   */
  updateActiveTransmissionOperators(operatorIds: string[]): void {
    const newSet = new Set(operatorIds);
    const changed = new Set<string>();

    for (const id of newSet) {
      if (!this.activeTransmissionOperatorIds.has(id)) changed.add(id);
    }
    for (const id of this.activeTransmissionOperatorIds) {
      if (!newSet.has(id)) changed.add(id);
    }

    this.activeTransmissionOperatorIds = newSet;

    for (const id of changed) {
      this.emitOperatorStatusUpdate(id);
    }
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
    logger.debug(`Broadcasting operator list update, ${operators.length} operator(s)`);
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
      isInActivePTT: status.isInActivePTT,
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
      logger.debug(`Operator ${operatorId} transmit cycles changed`);
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
            logger.debug(`Conflict detected: operator ${operatorId} (${operator.config.myCallsign}) is transitioning to ${targetCallsign} (state: ${currentState})`);
            return true;
          }
          // 非TX6状态（活跃QSO）→ 视为冲突
          if (currentState !== 'TX6') {
            logger.debug(`Conflict detected: operator ${operatorId} (${operator.config.myCallsign}) is working ${targetCallsign} (state: ${currentState})`);
            return true;
          }
        }
      }
    }

    return false; // 无冲突
  }

  private async completeAutomaticQSORecord(operatorId: string, qsoRecord: QSORecord): Promise<QSORecord> {
    const myCallsign = (qsoRecord.myCallsign || this.logManager.getOperatorCallsign(operatorId) || '').toUpperCase();
    const targetCallsign = qsoRecord.callsign.toUpperCase();
    const slotMs = this.getSlotDurationForMode(qsoRecord.mode);
    const historyStartMs = Math.max(0, qsoRecord.startTime - slotMs);
    const historyEndMs = qsoRecord.endTime ?? qsoRecord.startTime;
    const historySlotPacks = await this.collectRelevantSlotPacks(historyStartMs, historyEndMs);
    const dayStartMs = Date.parse(new Date(historyEndMs).toISOString().split('T')[0] + 'T00:00:00.000Z');
    const dailySlotPacks = await this.collectRelevantSlotPacks(dayStartMs, historyEndMs);

    const grid = qsoRecord.grid || this.findHistoricalGrid(dailySlotPacks, targetCallsign, historyEndMs);
    const messages = this.rebuildQSOMessageHistory(historySlotPacks, {
      operatorId,
      myCallsign,
      targetCallsign,
      startMs: historyStartMs,
      endMs: historyEndMs,
    });

    return {
      ...qsoRecord,
      callsign: targetCallsign,
      myCallsign: myCallsign || qsoRecord.myCallsign,
      grid,
      messages,
    };
  }

  private async collectRelevantSlotPacks(startMs: number, endMs: number): Promise<SlotPack[]> {
    const merged = new Map<string, SlotPack>();
    const activeSlotPacks = this.slotPackManager.getActiveSlotPacks();

    for (const slotPack of activeSlotPacks) {
      if (slotPack.startMs <= endMs && slotPack.endMs >= startMs) {
        merged.set(slotPack.slotId, slotPack);
      }
    }

    const dateStrings = this.getDateStringsBetween(startMs, endMs);
    for (const dateStr of dateStrings) {
      const records = await this.slotPackManager.readStoredRecords(dateStr);
      const latestBySlot = new Map<string, SlotPack>();

      for (const record of records) {
        const slotPack = record.slotPack;
        if (slotPack.startMs > endMs || slotPack.endMs < startMs) {
          continue;
        }
        const existing = latestBySlot.get(slotPack.slotId);
        if (!existing || slotPack.stats.lastUpdated >= existing.stats.lastUpdated) {
          latestBySlot.set(slotPack.slotId, slotPack);
        }
      }

      for (const [slotId, slotPack] of latestBySlot.entries()) {
        if (!merged.has(slotId)) {
          merged.set(slotId, slotPack);
        }
      }
    }

    return Array.from(merged.values()).sort((left, right) => {
      if (left.startMs !== right.startMs) {
        return left.startMs - right.startMs;
      }
      return left.slotId.localeCompare(right.slotId);
    });
  }

  private findHistoricalGrid(slotPacks: SlotPack[], targetCallsign: string, endMs: number): string | undefined {
    const sorted = [...slotPacks]
      .filter(slotPack => slotPack.startMs <= endMs)
      .sort((left, right) => right.startMs - left.startMs);

    for (const slotPack of sorted) {
      for (const frame of slotPack.frames) {
        if (frame.snr === -999) {
          continue;
        }

        try {
          const parsed = FT8MessageParser.parseMessage(frame.message);
          if (parsed.type === 'cq' && parsed.senderCallsign?.toUpperCase() === targetCallsign && parsed.grid) {
            return parsed.grid;
          }
          if (parsed.type === 'call' && parsed.senderCallsign?.toUpperCase() === targetCallsign && parsed.grid) {
            return parsed.grid;
          }
        } catch (error) {
          logger.warn(`Failed to parse frame while resolving grid: "${frame.message}"`, error);
        }
      }
    }

    return undefined;
  }

  private rebuildQSOMessageHistory(
    slotPacks: SlotPack[],
    options: { operatorId: string; myCallsign: string; targetCallsign: string; startMs: number; endMs: number }
  ): string[] {
    const messages: string[] = [];

    for (const slotPack of slotPacks) {
      if (slotPack.startMs > options.endMs || slotPack.endMs < options.startMs) {
        continue;
      }

      for (const frame of slotPack.frames) {
        if (!this.isFrameRelatedToQSO(frame, options)) {
          continue;
        }
        messages.push(frame.message);
      }
    }

    return messages;
  }

  private isFrameRelatedToQSO(
    frame: FrameMessage,
    options: { operatorId: string; myCallsign: string; targetCallsign: string }
  ): boolean {
    if (frame.snr === -999) {
      return frame.operatorId === options.operatorId && frame.message.toUpperCase().includes(options.targetCallsign);
    }

    try {
      const parsed = FT8MessageParser.parseMessage(frame.message);
      switch (parsed.type) {
        case 'cq':
          return parsed.senderCallsign?.toUpperCase() === options.targetCallsign;
        case 'call':
        case 'signal_report':
        case 'roger_report':
        case 'rrr':
        case '73': {
          const sender = parsed.senderCallsign?.toUpperCase();
          const target = parsed.targetCallsign?.toUpperCase();
          return sender !== undefined
            && target !== undefined
            && (
              (sender === options.targetCallsign && target === options.myCallsign)
              || (sender === options.myCallsign && target === options.targetCallsign)
            );
        }
        case 'fox_rr73':
          return parsed.completedCallsign?.toUpperCase() === options.myCallsign
            || parsed.nextCallsign?.toUpperCase() === options.myCallsign;
        default:
          return false;
      }
    } catch (error) {
      logger.warn(`Failed to parse frame while rebuilding QSO history: "${frame.message}"`, error);
      return false;
    }
  }

  private async findMergeCandidate(
    provider: { getLastQSOWithCallsign: (callsign: string, operatorId?: string) => Promise<QSORecord | null> },
    qsoRecord: QSORecord
  ): Promise<QSORecord | null> {
    const latestQSO = await provider.getLastQSOWithCallsign(qsoRecord.callsign);
    if (!latestQSO) {
      return null;
    }

    const existingBand = latestQSO.frequency > 0 ? getBandFromFrequency(latestQSO.frequency) : null;
    const incomingBand = qsoRecord.frequency > 0 ? getBandFromFrequency(qsoRecord.frequency) : null;
    if (!existingBand || !incomingBand || existingBand !== incomingBand) {
      return null;
    }

    if ((latestQSO.mode || '').toUpperCase() !== (qsoRecord.mode || '').toUpperCase()) {
      return null;
    }

    const latestTime = latestQSO.endTime ?? latestQSO.startTime;
    const incomingTime = qsoRecord.endTime ?? qsoRecord.startTime;
    if (Math.abs(incomingTime - latestTime) > 5 * 60 * 1000) {
      return null;
    }

    return latestQSO;
  }

  private mergeQSORecord(existing: QSORecord, incoming: QSORecord): QSORecord {
    const existingEndTime = existing.endTime ?? existing.startTime;
    const incomingEndTime = incoming.endTime ?? incoming.startTime;

    return {
      ...existing,
      ...incoming,
      id: existing.id,
      startTime: Math.min(existing.startTime, incoming.startTime),
      endTime: Math.max(existingEndTime, incomingEndTime),
      grid: incoming.grid || existing.grid,
      reportSent: incoming.reportSent || existing.reportSent,
      reportReceived: incoming.reportReceived || existing.reportReceived,
      messages: incoming.messages.length > 0 ? incoming.messages : existing.messages,
      lotwQslSent: existing.lotwQslSent,
      lotwQslReceived: existing.lotwQslReceived,
      lotwQslSentDate: existing.lotwQslSentDate,
      lotwQslReceivedDate: existing.lotwQslReceivedDate,
      qrzQslSent: existing.qrzQslSent,
      qrzQslReceived: existing.qrzQslReceived,
      qrzQslSentDate: existing.qrzQslSentDate,
      qrzQslReceivedDate: existing.qrzQslReceivedDate,
    };
  }

  private getSlotDurationForMode(mode: string): number {
    return mode.toUpperCase() === 'FT4' ? MODES.FT4.slotMs : MODES.FT8.slotMs;
  }

  private getDateStringsBetween(startMs: number, endMs: number): string[] {
    const startDate = new Date(startMs);
    const endDate = new Date(endMs);
    const results = new Set<string>();

    results.add(startDate.toISOString().split('T')[0]);
    results.add(endDate.toISOString().split('T')[0]);

    return [...results];
  }
  
  /**
   * 触发自动同步（公开包装，供路由层调用）
   */
  public async triggerAutoSync(qsoRecord: QSORecord, callsign: string, operatorId: string): Promise<void> {
    return this.handleAutoSync(qsoRecord, callsign, operatorId);
  }

  /**
   * 自动上传 QSO 到已启用的同步服务（WaveLog / QRZ / LoTW）
   */
  private async handleAutoSync(qsoRecord: QSORecord, callsign: string, operatorId: string): Promise<void> {
    const registry = SyncServiceRegistry.getInstance();
    const configManager = ConfigManager.getInstance();
    const syncConfig = configManager.getCallsignSyncConfig(callsign);

    // WaveLog 自动上传
    const waveLogService = registry.getWaveLogService(callsign);
    if (waveLogService && syncConfig?.wavelog?.autoUploadQSO) {
      try {
        logger.info(`[WaveLog] Auto-uploading QSO: ${qsoRecord.callsign} (callsign: ${callsign})`);
        const result = await waveLogService.uploadQSO(qsoRecord, false);
        if (result.status === 'duplicate') {
          logger.info(`[WaveLog] QSO already exists in WaveLog: ${qsoRecord.callsign} - ${result.message}`);
          this.eventEmitter.emit('waveLogUploadSuccess' as any, { operatorId, qsoRecord, message: result.message });
        } else if (result.success) {
          logger.info(`[WaveLog] QSO upload successful: ${qsoRecord.callsign}`);
          this.eventEmitter.emit('waveLogUploadSuccess' as any, { operatorId, qsoRecord, message: result.message });
        } else {
          logger.warn(`[WaveLog] QSO upload failed: ${qsoRecord.callsign} - ${result.message}`);
          this.eventEmitter.emit('waveLogUploadFailed' as any, { operatorId, qsoRecord, message: result.message });
        }
      } catch (error) {
        logger.error(`[WaveLog] QSO auto-upload error: ${qsoRecord.callsign}`, error);
        this.eventEmitter.emit('waveLogUploadError' as any, {
          operatorId, qsoRecord, error: error instanceof Error ? error.message : 'unknown error'
        });
      }
    }

    // QRZ 自动上传
    const qrzService = registry.getQRZService(callsign);
    if (qrzService && syncConfig?.qrz?.autoUploadQSO) {
      try {
        logger.info(`[QRZ] Auto-uploading QSO: ${qsoRecord.callsign} (callsign: ${callsign})`);
        const result = await qrzService.uploadQSO(qsoRecord);
        if (result.success) {
          logger.info(`[QRZ] QSO upload successful: ${qsoRecord.callsign}`);
        } else {
          logger.warn(`[QRZ] QSO upload failed: ${qsoRecord.callsign} - ${result.message}`);
        }
      } catch (error) {
        logger.error(`[QRZ] QSO auto-upload error: ${qsoRecord.callsign}`, error);
      }
    }

    // LoTW 自动上传
    const lotwService = registry.getLoTWService(callsign);
    if (lotwService && syncConfig?.lotw?.autoUploadQSO) {
      try {
        logger.info(`[LoTW] Auto-uploading QSO: ${qsoRecord.callsign} (callsign: ${callsign})`);
        const result = await lotwService.uploadQSOs([qsoRecord], callsign);
        if (result.success && result.uploadedCount > 0) {
          const existingSyncConfig = configManager.getCallsignSyncConfig(callsign);
          if (existingSyncConfig?.lotw) {
            await configManager.updateCallsignSyncConfig(callsign, {
              lotw: {
                ...existingSyncConfig.lotw,
                lastUploadTime: Date.now(),
              },
            });
          }
          const logBook = await this.logManager.getOperatorLogBook(operatorId);
          if (logBook) {
            const now = Date.now();
            await logBook.provider.updateQSO(qsoRecord.id, {
              lotwQslSent: 'Y',
              lotwQslSentDate: qsoRecord.lotwQslSentDate || now,
            });
          }
          logger.info(`[LoTW] QSO upload successful: ${qsoRecord.callsign}`);
        } else {
          logger.warn(`[LoTW] QSO upload failed: ${qsoRecord.callsign} - ${result.message}`);
        }
      } catch (error) {
        logger.error(`[LoTW] QSO auto-upload error: ${qsoRecord.callsign}`, error);
      }
    }
  }
} 
