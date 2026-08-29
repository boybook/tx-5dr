/* eslint-disable @typescript-eslint/no-explicit-any */
// RadioOperatorManager - 事件处理和操作员管理需要使用any类型以处理动态事件

import EventEmitter from 'eventemitter3';
import {
  RadioOperator,
  ClockSourceSystem,
  FT8MessageParser,
  LogbookOperationError,
  type ILogProvider,
} from '@tx5dr/core';
import {
  type RadioOperatorConfig,
  type OperatorConfig,
  type TransmitRequest,
  type TransmitBatchRequest,
  type DigitalRadioEngineEvents,
  type ModeDescriptor,
  type LogBookInfo,
  type QSORecord,
  type QSOPersistencePolicy,
  type SlotPack,
  type FrameMessage,
  type DecodeApContext,
  type SlotInfo,
  MODES,
  sanitizeCallsignInput,
  sanitizeGridInput,
} from '@tx5dr/contracts';
import {
  CycleUtils,
  getBandFromFrequency,
  getStandardDigitalFrequencyMatch,
  type StandardDigitalFrequencyMatch,
} from '@tx5dr/core';
import { ConfigManager } from '../config/config-manager.js';
import { LogManager } from '../log/LogManager.js';
import { resolveQsoComment } from '@tx5dr/plugin-api';
import type { WSJTXEncodeWorkQueue } from '../decode/WSJTXEncodeWorkQueue.js';
import type { SlotPackManager } from '../slot/SlotPackManager.js';
import type { CallsignContextTracker } from '../slot/CallsignContextTracker.js';
import { MemoryLeakDetector } from '../utils/MemoryLeakDetector.js';
import { createLogger } from '../utils/logger.js';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { DigitalFrameCoordinator } from '../transmission/DigitalFrameCoordinator.js';
import { OperatorIntentCoordinator } from '../transmission/OperatorIntentCoordinator.js';
import { TargetReservationCoordinator } from '../transmission/TargetReservationCoordinator.js';
import { buildTrackId, normalizeStreamId } from '../transmission/TransmissionIntent.js';

const logger = createLogger('RadioOperatorManager');

type QueuedTransmitRequest = TransmitRequest & {
  waitForTransmitCycle?: boolean;
  completeOperatorSet?: boolean;
};

const DEFAULT_MAX_SAME_TRANSMISSION_COUNT = 20;
const SAME_TRANSMISSION_GUARD_RESET_REASON = 'same transmission guard limit';
const DISTINCT_QSO_BATCH_MAX_REPLANS = 2;
const AP_DECODE_QSO_PROGRESS: Record<string, number | undefined> = {
  TX3: 3,
  TX4: 4,
};

function normalizeApCallsign(value: string | undefined): string | undefined {
  const normalized = value?.trim().toUpperCase();
  if (!normalized || normalized.length < 3) return undefined;
  return normalized;
}

function normalizeApGrid(value: string | undefined): string | undefined {
  const normalized = value?.trim().toUpperCase();
  if (!normalized || normalized.length < 4) return undefined;
  return normalized;
}

function isLogbookRevisionConflict(error: unknown): boolean {
  return !!error
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: unknown }).code === 'LOGBOOK_REVISION_CONFLICT';
}

function qsoLifecycleKey(operatorId: string, streamId?: string): string {
  return `${operatorId}\0${streamId?.trim() ?? ''}`;
}

function normalizeOperatorContext(context: any): any {
  return {
    ...context,
    ...(typeof context?.myCall === 'string'
      ? { myCall: sanitizeCallsignInput(context.myCall) }
      : {}),
    ...(typeof context?.myGrid === 'string'
      ? { myGrid: sanitizeGridInput(context.myGrid) }
      : {}),
  };
}

/** True when a logged RST/SNR field is absent. "0" and "+00" are valid reports. */
function isMissingSignalReport(value: string | undefined | null): boolean {
  return value === undefined || value === null || value === '';
}

function preferSignalReport(
  ...candidates: Array<string | undefined | null>
): string | undefined {
  for (const candidate of candidates) {
    if (!isMissingSignalReport(candidate)) {
      return candidate ?? undefined;
    }
  }
  return undefined;
}

interface SameTransmissionGuardState {
  canonicalMessage: string;
  count: number;
  lastCountedSlotStartMs: number;
}

interface SameTransmissionGuardEvaluation {
  allowed: boolean;
  guardKey?: string;
  nextState?: SameTransmissionGuardState;
  attemptedCount?: number;
  maxCount?: number;
}

export interface UnsavedQsoAttempt {
  attemptId: string;
  operatorId: string;
  logBookId: string;
  qsoRecord: QSORecord;
  qsoLifecycleId?: string;
  qsoLifecycleEpoch?: number;
  qsoRuntimeGeneration?: number;
  streamId?: string;
  persistencePolicy?: QSOPersistencePolicy;
  destination?: { kind: 'plugin-session'; sessionId: string };
  sourcePluginName?: string;
  createdAt: number;
}

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
  // 获取最近已知电台基频（Hz）；自动决策热路径使用它避免等待硬件I/O
  getKnownRadioFrequency?: () => number | null;
  // 虚拟频率是否生效（已计入与 rig split 的互斥）；编码时据此决定是否平移音频载波
  getFakeFrequencyEnabled?: () => boolean;
  callsignTracker?: CallsignContextTracker;
  digitalFrameCoordinator?: DigitalFrameCoordinator;
  getTransmitCompensationMs?: () => number;
  intentCoordinator?: OperatorIntentCoordinator;
}

/**
 * 电台操作员管理器 - 管理所有电台操作员相关的功能
 */
export class RadioOperatorManager {
  private operators: Map<string, RadioOperator> = new Map();
  private pendingTransmissions: QueuedTransmitRequest[] = [];
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
  private getKnownRadioFrequency?: () => number | null;
  private getFakeFrequencyEnabled?: () => boolean;
  private callsignTracker?: CallsignContextTracker;
  private readonly digitalFrameCoordinator: DigitalFrameCoordinator;
  private readonly getTransmitCompensationMs: () => number;
  private readonly intentCoordinator: OperatorIntentCoordinator;

  // 虚拟频率：当前时隙冻结的 dial 平移量（Hz）。按 slotStartMs 冻结，
  // 保证同一时隙内中途加入的操作员复用同一 shift，与已编码音频匹配。
  private currentSlotTxDialShift: { slotStartMs: number; shiftHz: number } | null = null;
  // 虚拟频率常量：目标音频载波频率与滞回半宽（Hz）
  private static readonly FAKE_FREQ_TARGET_HZ = 1500;
  private static readonly FAKE_FREQ_HYSTERESIS_HZ = 200;
  // 插件管理器引用（延迟注入，引擎初始化完成后设置）
  private _pluginManager?: import('../plugin/PluginManager.js').PluginManager;

  // 记录所有事件监听器,用于清理
  private eventListeners: Map<string, (...args: any[]) => void> = new Map();

  // 晚到解码重决策窗口：保留槽尾 500ms，避免贴近下个 slotStart 时与下一轮事件竞态。
  // FT8 (15s) → 14500ms；FT4 (7.5s) → 7000ms
  private static readonly REDECIDE_DEADLINE_SLOT_END_GUARD_MS = 500;

  private getRedecideDeadlineMs(): number {
    const slotMs = this.getCurrentMode().slotMs;
    return Math.max(0, slotMs - RadioOperatorManager.REDECIDE_DEADLINE_SLOT_END_GUARD_MS);
  }

  private resolveCurrentBandForWorkedCheck(): string {
    let baseFreq = 0;

    if (this.getKnownRadioFrequency) {
      try {
        const rf = this.getKnownRadioFrequency();
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

    return baseFreq > 1_000_000 ? getBandFromFrequency(baseFreq) : 'Unknown';
  }

  private getStandardFrequencyStreamRestriction(
    mode: ModeDescriptor = this.getCurrentMode(),
  ): StandardDigitalFrequencyMatch | null {
    let frequency: number | null = null;
    try {
      frequency = this.getKnownRadioFrequency?.() ?? null;
    } catch {
      frequency = null;
    }
    return getStandardDigitalFrequencyMatch(mode.name, frequency);
  }

  assertStandardFrequencyStreamLimit(
    tracks: readonly { operatorId: string; streamId?: string }[],
    mode: ModeDescriptor = this.getCurrentMode(),
  ): void {
    const restriction = this.getStandardFrequencyStreamRestriction(mode);
    if (!restriction) return;
    const counts = new Map<string, number>();
    for (const track of tracks) counts.set(track.operatorId, (counts.get(track.operatorId) ?? 0) + 1);
    const violation = [...counts.entries()].find(([, count]) => count > 1);
    if (!violation) return;
    throw new Error(
      `Operator ${violation[0]} cannot transmit ${violation[1]} TX slots on the standard `
      + `${restriction.modeName} dial frequency ${restriction.standardFrequency / 1_000_000} MHz`,
    );
  }

  private notifyStandardFrequencyStreamFallback(
    operatorId: string,
    match: StandardDigitalFrequencyMatch,
  ): void {
    logger.warn('Rejected multi-stream transmission on a standard digital frequency', {
      operatorId,
      ...match,
    });
    this.eventEmitter.emit('textMessage', {
      title: 'Multi-slot transmission reduced',
      text: `The standard ${match.modeName} frequency allows one TX slot per operator; multi-slot transmission was rejected.`,
      color: 'warning',
      timeout: 8000,
      key: 'standardFrequencyMultiStreamFallback',
      params: {
        mode: match.modeName,
        frequency: String(match.standardFrequency / 1_000_000),
      },
    });
  }

  // 📊 Day13优化：记录上次发射的操作员状态哈希，用于去重
  private lastEmittedStatusHash: Map<string, string> = new Map();

  // 当前正在实际PTT发射的操作员ID集合
  private activeTransmissionOperatorIds: Set<string> = new Set();

  // 每操作员连续相同发射文本计数，用于防止插件/策略卡住后无限重复发射。
  private sameTransmissionGuardStates: Map<string, SameTransmissionGuardState> = new Map();
  // Stream IDs are plugin-owned, so the physical text set is guarded separately
  // to prevent rotating IDs from resetting the fail-safe.
  private operatorTransmissionSetGuardStates: Map<string, SameTransmissionGuardState> = new Map();
  private readonly unsavedQsoAttempts = new Map<string, UnsavedQsoAttempt>();
  private readonly qsoPersistenceInFlight = new Map<string, string>();
  private readonly unsavedQsoRetryFlights = new Map<string, Promise<QSORecord>>();
  private readonly preparedQsoCandidates = new Map<string, QSORecord>();
  private readonly activeQsoLifecycles = new Map<string, {
    epoch: number;
    runtimeGeneration?: number;
  }>();
  private readonly targetReservations = new TargetReservationCoordinator();
  private transmissionMaintenanceReason: string | null = null;

  constructor(options: RadioOperatorManagerOptions) {
    this.eventEmitter = options.eventEmitter;
    this.encodeQueue = options.encodeQueue;
    this.clockSource = options.clockSource;
    this.getCurrentMode = options.getCurrentMode;
    this.setRadioFrequency = options.setRadioFrequency;
    this.slotPackManager = options.slotPackManager;
    this.logManager = LogManager.getInstance();
    this.logManager.setApplicationEventSink((event, data) => {
      this.eventEmitter.emit(event as any, data as any);
    });
    this.transmissionTracker = options.transmissionTracker;
    this.getRadioFrequency = options.getRadioFrequency;
    this.getKnownRadioFrequency = options.getKnownRadioFrequency;
    this.getFakeFrequencyEnabled = options.getFakeFrequencyEnabled;
    this.callsignTracker = options.callsignTracker;
    this.digitalFrameCoordinator = options.digitalFrameCoordinator ?? new DigitalFrameCoordinator();
    this.intentCoordinator = options.intentCoordinator ?? new OperatorIntentCoordinator();
    this.getTransmitCompensationMs = options.getTransmitCompensationMs ?? (() => 0);

    // 监听发射请求
    const handleRequestTransmit = (request: TransmitRequest) => {
      if (this.transmissionMaintenanceReason) {
        logger.debug('Discarded transmit request during maintenance', {
          operatorId: request.operatorId,
          reason: this.transmissionMaintenanceReason,
        });
        return;
      }
      this.pendingTransmissions.push({
        ...request,
        streamId: normalizeStreamId(request.streamId),
        decisionEpoch: request.decisionEpoch ?? this.intentCoordinator.getCurrentEpoch(request.operatorId),
      });
    };
    this.eventEmitter.on('requestTransmit', handleRequestTransmit);
    this.eventListeners.set('requestTransmit', handleRequestTransmit);

    const handleRequestTransmitBatch = (request: TransmitBatchRequest) => {
      if (this.transmissionMaintenanceReason) return;
      const operator = this.operators.get(request.operatorId);
      if (!operator) return;
      const standardFrequencyRestriction = this.getStandardFrequencyStreamRestriction();
      const maxStreams = standardFrequencyRestriction ? 1 : (operator.config.maxConcurrentStreams ?? 3);
      const uniqueStreamIds = new Set(request.transmissions.map((item) => normalizeStreamId(item.streamId)));
      if (request.transmissions.length > maxStreams || uniqueStreamIds.size !== request.transmissions.length) {
        logger.warn('Rejected invalid operator transmission set', {
          operatorId: request.operatorId,
          transmissionCount: request.transmissions.length,
          maxStreams,
        });
        if (standardFrequencyRestriction && request.transmissions.length > 1) {
          this.notifyStandardFrequencyStreamFallback(request.operatorId, standardFrequencyRestriction);
        }
        return;
      }

      this.pendingTransmissions = this.pendingTransmissions.filter(
        (candidate) => candidate.operatorId !== request.operatorId,
      );
      if (request.transmissions.length === 0) {
        if (request.replaceExisting) {
          this.requestStrategyStop(request.operatorId, request.reason ?? 'operator transmission set became empty');
        }
        return;
      }
      const decisionEpoch = request.decisionEpoch ?? this.intentCoordinator.getCurrentEpoch(request.operatorId);
      for (const transmission of request.transmissions) {
        this.pendingTransmissions.push({
          operatorId: request.operatorId,
          streamId: normalizeStreamId(transmission.streamId),
          transmission: transmission.transmission,
          audioFrequencyHz: transmission.audioFrequencyHz,
          replaceExisting: request.replaceExisting,
          source: request.source,
          reason: request.reason,
          decisionEpoch,
          completeOperatorSet: true,
        });
      }
    };
    this.eventEmitter.on('requestTransmitBatch', handleRequestTransmitBatch);
    this.eventListeners.set('requestTransmitBatch', handleRequestTransmitBatch);

    // 监听记录QSO事件
    const handleRecordQSO = async (data: {
      operatorId: string;
      streamId?: string;
      qsoLifecycleId?: string;
      qsoLifecycleEpoch?: number;
      qsoRuntimeGeneration?: number;
      qsoRecord: QSORecord;
      persistencePolicy?: QSOPersistencePolicy;
      destination?: { kind: 'plugin-session'; sessionId: string };
      sourcePluginName?: string;
      retryAttemptId?: string;
      resolve?: (record: QSORecord) => void;
      reject?: (error: unknown) => void;
    }) => {
      let retryAttempt = data.retryAttemptId
        ? this.unsavedQsoAttempts.get(data.retryAttemptId)
        : undefined;
      if (!data.retryAttemptId && !retryAttempt && data.qsoLifecycleId) {
        retryAttempt = this.getUnsavedQsosForOperator(data.operatorId).find((attempt) => (
          attempt.qsoLifecycleId === data.qsoLifecycleId
            && attempt.qsoRecord.id === data.qsoRecord.id
        ));
      }
      const destination = retryAttempt?.destination ?? data.destination;
      const sourcePluginName = retryAttempt?.sourcePluginName ?? data.sourcePluginName;
      let targetLogBookId = retryAttempt?.logBookId
        ?? destination?.sessionId
        ?? this.logManager.getOperatorLogBookId(data.operatorId)
        ?? `operator-${data.operatorId}`;
      const persistenceKey = data.qsoLifecycleId ?? `${data.operatorId}:legacy:${data.qsoRecord.id}`;
      const activePersistence = this.qsoPersistenceInFlight.get(data.operatorId);
      if (activePersistence) {
        data.reject?.(new LogbookOperationError(
          'LOGBOOK_MAINTENANCE',
          activePersistence === persistenceKey
            ? 'This QSO persistence lifecycle is already in progress'
            : 'A QSO persistence operation is already in progress for this operator',
        ));
        return;
      }
      this.qsoPersistenceInFlight.set(data.operatorId, persistenceKey);
      try {
        logger.debug(`Recording QSO: ${data.qsoRecord.callsign} (operator: ${data.operatorId})`);

        const pendingAttempts = this.getUnsavedQsosForOperator(data.operatorId);
        if (pendingAttempts.length > 0 && !retryAttempt) {
          const error = new LogbookOperationError(
            'LOGBOOK_MAINTENANCE',
            'Resolve the existing unsaved QSO before recording another contact',
          );
          const attemptId = this.rememberUnsavedQso(
            data.operatorId,
            targetLogBookId,
            data.qsoRecord,
            data.qsoLifecycleId,
            data.qsoLifecycleEpoch,
            data.qsoRuntimeGeneration,
            data.persistencePolicy,
            data.streamId,
            destination,
            sourcePluginName,
          );
          if (this.isCurrentQsoLifecycle(
            data.operatorId,
            data.qsoLifecycleEpoch,
            data.qsoRuntimeGeneration,
            data.streamId,
          )) {
            this.pauseOperatorAfterLogbookFailure(data.operatorId);
          }
          this.eventEmitter.emit('logbookWriteFailed' as any, {
            logBookId: targetLogBookId,
            operatorId: data.operatorId,
            attemptId,
            unsavedCount: this.getUnsavedQsosForOperator(data.operatorId).length,
            error: {
              code: error.code,
              message: error.message,
              occurredAt: Date.now(),
            },
          });
          data.reject?.(error);
          return;
        }
        if (data.retryAttemptId
            && (!retryAttempt || retryAttempt.operatorId !== data.operatorId)) {
          const error = new LogbookOperationError(
            'LOGBOOK_UNSAVED_QSO_NOT_FOUND',
            'The unsaved QSO retry attempt no longer exists',
          );
          data.reject?.(error);
          return;
        }

        const operatorCallsign = this.logManager.getOperatorCallsign(data.operatorId);
        const logBook = destination
          ? (sourcePluginName && operatorCallsign
            ? this.logManager.getPluginSessionLogBook(
                destination.sessionId,
                sourcePluginName,
                operatorCallsign,
              )
            : null)
          : await this.logManager.getOperatorLogBook(data.operatorId);
        if (!logBook) {
          const callsign = operatorCallsign;
          const message = destination
            ? 'Cannot record QSO: plugin logbook session is unavailable or not owned by the active strategy'
            : !callsign
            ? `Cannot record QSO: operator ${data.operatorId} has no registered callsign`
            : `Cannot record QSO: failed to create logbook for operator ${data.operatorId} (callsign: ${callsign})`;
          logger.error(message);
          this.eventEmitter.emit('logbookWriteFailed' as any, {
            logBookId: targetLogBookId,
            operatorId: data.operatorId,
            attemptId: this.rememberUnsavedQso(
              data.operatorId,
              targetLogBookId,
              data.qsoRecord,
              data.qsoLifecycleId,
              data.qsoLifecycleEpoch,
              data.qsoRuntimeGeneration,
              data.persistencePolicy,
              data.streamId,
              destination,
              sourcePluginName,
            ),
            unsavedCount: 1,
            error: {
              code: 'LOGBOOK_UNAVAILABLE',
              message,
              occurredAt: Date.now(),
            },
          });
          const error = new LogbookOperationError('LOGBOOK_UNAVAILABLE', message);
          data.reject?.(error);
          if (this.isCurrentQsoLifecycle(
            data.operatorId,
            data.qsoLifecycleEpoch,
            data.qsoRuntimeGeneration,
            data.streamId,
          )) {
            this.pauseOperatorAfterLogbookFailure(data.operatorId);
          }
          return;
        }
        targetLogBookId = logBook.id;
        const logbookHealth = logBook.binding?.kind === 'plugin-session'
          ? logBook.provider.getHealth()
          : undefined;
        if (logbookHealth && (!logbookHealth.readable || !logbookHealth.writable)) {
          throw new LogbookOperationError(
            logbookHealth.state === 'loading' ? 'LOGBOOK_LOADING' : 'LOGBOOK_UNAVAILABLE',
            `Logbook ${logBook.name} is not writable (${logbookHealth.state})`,
          );
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

        const completedQSO = retryAttempt
          ? { ...retryAttempt.qsoRecord, messageHistory: [...retryAttempt.qsoRecord.messageHistory] }
          : await this.completeAutomaticQSORecord(data.operatorId, normalizedQSO);
        // Retain the exact first candidate so an explicit retry cannot silently
        // rebuild a different history, report, or frequency later.
        this.preparedQsoCandidates.set(persistenceKey, completedQSO);
        const persistencePolicy = retryAttempt?.persistencePolicy ?? data.persistencePolicy ?? 'merge-nearby';
        const mergeCandidate = persistencePolicy === 'merge-nearby'
          ? await this.findMergeCandidate(logBook.provider, completedQSO)
          : null;

        let persistedQSO: QSORecord;
        let eventName: 'qsoRecordAdded' | 'qsoRecordUpdated' = 'qsoRecordAdded';
        let shouldAutoSync = false;

        if (mergeCandidate) {
          const mergedQSO = this.mergeQSORecord(mergeCandidate, completedQSO);
          const { id: _id, ...updates } = mergedQSO;

          logger.debug(`Updating existing QSO ${mergeCandidate.id} in logbook ${logBook.name}: ${mergedQSO.callsign} @ ${new Date(mergedQSO.startTime).toISOString()} (${mergedQSO.frequency}Hz)`);
          persistedQSO = await logBook.provider.updateQSO(mergeCandidate.id, updates, data.operatorId);
          eventName = 'qsoRecordUpdated';
        } else if (persistencePolicy === 'preserve-distinct') {
          logger.debug(`Saving distinct QSO to logbook ${logBook.name}: ${completedQSO.callsign} @ ${new Date(completedQSO.startTime).toISOString()} (${completedQSO.frequency}Hz)`);
          persistedQSO = await this.addDistinctQSO(logBook.provider, completedQSO, data.operatorId);
          shouldAutoSync = true;
        } else {
          logger.debug(`Saving QSO to logbook ${logBook.name}: ${completedQSO.callsign} @ ${new Date(completedQSO.startTime).toISOString()} (${completedQSO.frequency}Hz)`);
          persistedQSO = await logBook.provider.addQSO(completedQSO, data.operatorId);
          shouldAutoSync = true;
        }

        if (!persistedQSO) {
          throw new Error('Logbook provider completed without returning the durably committed QSO');
        }

        logger.info('QSO durably committed', {
          operation: eventName === 'qsoRecordAdded' ? 'add' : 'update',
          operatorId: data.operatorId,
          logBookId: logBook.id,
          qsoId: persistedQSO.id,
          callsign: persistedQSO.callsign,
          grid: persistedQSO.grid || null,
          startTime: persistedQSO.startTime,
          endTime: persistedQSO.endTime ?? null,
          frequency: persistedQSO.frequency,
          mode: persistedQSO.mode,
        });

        if (retryAttempt) {
          this.unsavedQsoAttempts.delete(retryAttempt.attemptId);
        } else {
          this.clearUnsavedQsoForLifecycle(data.operatorId, data.qsoLifecycleId, data.qsoRecord.id);
        }
        this.preparedQsoCandidates.delete(persistenceKey);
        if (this.isCurrentQsoLifecycle(
          data.operatorId,
          data.qsoLifecycleEpoch,
          data.qsoRuntimeGeneration,
          data.streamId,
        )) {
          if (this.getUnsavedQsosForOperator(data.operatorId).length === 0) {
            this.operators.get(data.operatorId)?.clearLogbookFailureBlock();
          }
        }
        if (this.qsoPersistenceInFlight.get(data.operatorId) === persistenceKey) {
          this.qsoPersistenceInFlight.delete(data.operatorId);
        }
        data.resolve?.(persistedQSO);

        // Everything below is a post-commit side effect. A listener, sync plugin,
        // or statistics failure must never turn a durable QSO into a write failure.
        const isPluginSession = logBook.binding?.kind === 'plugin-session';
        if (!isPluginSession) {
          try {
            this.eventEmitter.emit(eventName as any, {
              operatorId: data.operatorId,
              logBookId: logBook.id,
              qsoRecord: persistedQSO
            });
            logger.debug(`Emitted ${eventName} event: ${persistedQSO.callsign}`);
          } catch (eventError) {
            logger.warn(`Failed to emit ${eventName} after QSO commit:`, eventError);
          }
        }

        if (shouldAutoSync && logBook.binding?.kind !== 'plugin-session') {
          const operatorCallsign = this.logManager.getOperatorCallsign(data.operatorId);
          if (operatorCallsign) {
            try {
              await this.handleAutoSync(persistedQSO, operatorCallsign);
            } catch (syncError) {
              logger.warn('Auto-sync failed after QSO commit:', syncError);
            }
          }
        }

        try {
          if (logBook.binding?.kind === 'plugin-session') {
            await this._pluginManager?.notifyPluginSessionQSOComplete?.(
              data.operatorId,
              logBook.binding.pluginName,
              persistedQSO,
            );
          } else {
            await this._pluginManager?.notifyQSOComplete(data.operatorId, persistedQSO);
          }
        } catch (pluginError) {
          logger.warn('Plugin QSO completion notification failed after QSO commit:', pluginError);
        }
        
        // 获取更新的统计信息并发射日志本更新事件
        if (!isPluginSession) {
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
        }

      } catch (error) {
        logger.error(`Failed to record QSO:`, error);
        const attemptId = this.rememberUnsavedQso(
          data.operatorId,
          targetLogBookId,
          this.preparedQsoCandidates.get(persistenceKey) ?? data.qsoRecord,
          data.qsoLifecycleId,
          data.qsoLifecycleEpoch,
          data.qsoRuntimeGeneration,
          data.persistencePolicy,
          data.streamId,
          destination,
          sourcePluginName,
        );
        this.preparedQsoCandidates.delete(persistenceKey);
        if (this.isCurrentQsoLifecycle(
          data.operatorId,
          data.qsoLifecycleEpoch,
          data.qsoRuntimeGeneration,
          data.streamId,
        )) {
          this.pauseOperatorAfterLogbookFailure(data.operatorId);
        }
        const operationError = error instanceof LogbookOperationError ? error : undefined;
        this.eventEmitter.emit('logbookWriteFailed' as any, {
          logBookId: targetLogBookId,
          operatorId: data.operatorId,
          attemptId,
          unsavedCount: this.getUnsavedQsosForOperator(data.operatorId).length,
          error: {
            code: operationError?.code ?? 'LOGBOOK_WRITE_FAILED',
            message: error instanceof Error ? error.message : String(error),
            systemCode: operationError?.systemCode,
            occurredAt: Date.now(),
          },
        });
        data.reject?.(error);
      } finally {
        if (this.qsoPersistenceInFlight.get(data.operatorId) === persistenceKey) {
          this.qsoPersistenceInFlight.delete(data.operatorId);
        }
      }
    };
    this.eventEmitter.on('recordQSO', handleRecordQSO);
    this.eventListeners.set('recordQSO', handleRecordQSO);

    const handleQsoLifecycleChanged = (data: {
      operatorId: string;
      streamId?: string;
      lifecycleEpoch: number;
      runtimeGeneration?: number;
    }) => {
      this.activeQsoLifecycles.set(qsoLifecycleKey(data.operatorId, data.streamId), {
        epoch: data.lifecycleEpoch,
        runtimeGeneration: data.runtimeGeneration,
      });
    };
    this.eventEmitter.on('qsoLifecycleChanged', handleQsoLifecycleChanged);
    this.eventListeners.set('qsoLifecycleChanged', handleQsoLifecycleChanged);

    // 监听检查是否已通联事件
    const handleCheckHasWorkedCallsign = async (data: { operatorId: string; callsign: string; requestId: string }) => {
      try {
        // 获取操作员对应的日志本
        const logBook = await this.logManager.getOperatorLogBook(data.operatorId);
        let hasWorked = false;
        const band = this.resolveCurrentBandForWorkedCheck();

        if (!logBook) {
          const callsign = this.logManager.getOperatorCallsign(data.operatorId);
          if (!callsign) {
            logger.warn(`Check has-worked: operator ${data.operatorId} has no registered callsign, returning false`);
            hasWorked = false;
          } else {
            logger.warn(`Check has-worked: logbook not found for operator ${data.operatorId} (callsign: ${callsign}), returning false`);
            hasWorked = false;
          }
        } else if (band === 'Unknown') {
          hasWorked = false;
        } else {
          hasWorked = await logBook.provider.hasWorkedCallsign(data.callsign, { band });
        }

        // 发送响应
        this.eventEmitter.emit('hasWorkedCallsignResponse', {
          requestId: data.requestId,
          hasWorked
        });
      } catch (error) {
        logger.error(`Failed to check callsign:`, error);
        // 发送错误响应
        this.eventEmitter.emit('hasWorkedCallsignResponse', {
          requestId: data.requestId,
          hasWorked: false
        });
      }
    };
    this.eventEmitter.on('checkHasWorkedCallsign', handleCheckHasWorkedCallsign);
    this.eventListeners.set('checkHasWorkedCallsign', handleCheckHasWorkedCallsign);

    // 监听操作员发射周期变更事件
    const handleOperatorTransmitCyclesChanged = (data: {
      operatorId: string;
      previousTransmitCycles?: number[];
      transmitCycles: number[];
      commandEpoch?: number;
      source?: 'manual' | 'plugin' | 'late-decode' | 'slot-auto';
      reason?: string;
    }) => {
      logger.debug(`Operator ${data.operatorId} transmit cycles changed: [${data.transmitCycles.join(', ')}]`);
      if (typeof this._pluginManager?.notifyOperatorTransmitCyclesChanged === 'function') {
        this._pluginManager.notifyOperatorTransmitCyclesChanged(data.operatorId, {
          previousTransmitCycles: data.previousTransmitCycles ?? [],
          transmitCycles: data.transmitCycles,
          source: data.source,
        });
      }
      this._pluginManager?.invalidateDecisionMessageSet(data.operatorId);
      this.requestOperatorFrameMutation(data.operatorId, {
        kind: 'transmit-cycles',
        source: data.source,
        commandEpoch: data.commandEpoch,
        reason: data.reason ?? 'operator transmit cycles changed',
      });
      this.emitOperatorStatusUpdate(data.operatorId);
    };
    this.eventEmitter.on('operatorTransmitCyclesChanged', handleOperatorTransmitCyclesChanged);
    this.eventListeners.set('operatorTransmitCyclesChanged', handleOperatorTransmitCyclesChanged);

    // operator.start()/stop() 可能来自插件 requestCall，而不是显式 startOperator/stopOperator。
    // 这里保证面板能收到 isTransmitting 的即时变化；槽位/状态变化由 addOperator 中的监听器刷新。
    const handleOperatorStatusChanged = (data: { operatorId: string }) => {
      logger.debug(`Operator ${data.operatorId} status changed`);
      this.emitOperatorStatusUpdate(data.operatorId);
    };
    this.eventEmitter.on('operatorStatusChanged' as any, handleOperatorStatusChanged);
    this.eventListeners.set('operatorStatusChanged', handleOperatorStatusChanged);

    // 监听操作员切换发射槽位事件
    const handleOperatorSlotChanged = (data: { operatorId: string; slot: string }) => {
      const operator = this.operators.get(data.operatorId);
      const now = this.clockSource.now();
      const slotMs = this.getCurrentMode().slotMs;
      const slotStartMs = Math.floor(now / slotMs) * slotMs;
      // Bumped from debug→info: this event is the bridge between an external
      // setState and the immediate checkAndTriggerTransmission that would emit
      // an out-of-band TX. Pairing it with WS audit logs lets us reconstruct
      // the trigger chain when a slot anomaly is reported.
      logger.info('operatorSlotChanged → checkAndTriggerTransmission', {
        operatorId: data.operatorId,
        newSlot: data.slot,
        isTransmitting: operator?.isTransmitting ?? false,
        elapsedInSlotMs: now - slotStartMs,
      });
      this.requestOperatorFrameMutation(data.operatorId, {
        kind: 'slot',
        reason: 'operator transmit slot changed',
      });
      this.emitOperatorStatusUpdate(data.operatorId);
    };
    this.eventEmitter.on('operatorSlotChanged', handleOperatorSlotChanged);
    this.eventListeners.set('operatorSlotChanged', handleOperatorSlotChanged);

    const handleOperatorStreamStateChanged = (data: {
      operatorId: string;
      streamId: string;
      state: string;
      commandEpoch?: number;
      source?: 'manual' | 'plugin' | 'late-decode' | 'slot-auto';
    }) => {
      logger.info('operatorStreamStateChanged -> requestOperatorFrameMutation', {
        operatorId: data.operatorId,
        streamId: data.streamId,
        newState: data.state,
      });
      this.requestOperatorFrameMutation(data.operatorId, {
        kind: 'slot',
        commandEpoch: data.commandEpoch,
        source: data.source,
        reason: `operator stream ${data.streamId} state changed`,
      });
      this.emitOperatorStatusUpdate(data.operatorId);
    };
    this.eventEmitter.on('operatorStreamStateChanged', handleOperatorStreamStateChanged);
    this.eventListeners.set('operatorStreamStateChanged', handleOperatorStreamStateChanged);

    // 兼容仍通过事件更新频率的 host 入口；内置 Manager 路径直接调用同一 mutation 方法。
    const handleOperatorFrequencyChanged = (data: { operatorId: string; frequency: number }) => {
      logger.debug(`Operator ${data.operatorId} frequency changed: ${data.frequency}`);
      this.requestOperatorFrameMutation(data.operatorId, {
        kind: 'frequency',
        reason: 'operator audio frequency changed',
      });
      this.emitOperatorStatusUpdate(data.operatorId);
    };
    this.eventEmitter.on('operatorFrequencyChanged', handleOperatorFrequencyChanged);
    this.eventListeners.set('operatorFrequencyChanged', handleOperatorFrequencyChanged);

    // 监听操作员发射内容变更事件
    const handleOperatorSlotContentChanged = (data: { operatorId: string; slot: string; content: string }) => {
      logger.debug(`Operator ${data.operatorId} slot content edited: slot=${data.slot}`);
      // 立即检查并触发发射（如果当前正在该槽位发射）
      const currentSlot = this._pluginManager?.getOperatorRuntimeStatus(data.operatorId)?.currentSlot;
      if (currentSlot === data.slot) {
        logger.debug(`Currently transmitting on slot ${data.slot}, updating content immediately`);
        this.requestOperatorFrameMutation(data.operatorId, {
          kind: 'slot-content',
          reason: 'current transmit slot content changed',
        });
      }
      this.emitOperatorStatusUpdate(data.operatorId);
    };
    this.eventEmitter.on('operatorSlotContentChanged', handleOperatorSlotContentChanged);
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
    if (ConfigManager.getInstance().getOperatorsConfig().length === 0) {
      this.logManager.skipBootstrapPrewarm?.('No configured operators; logbook prewarm skipped');
    }

    // 从配置文件初始化操作员（包括创建对应的日志本）
    await this.initializeOperatorsFromConfig();
    if (ConfigManager.getInstance().getOperatorsConfig().length > 0 && this.operators.size === 0) {
      this.logManager.skipBootstrapPrewarm?.('No available operators were created; logbook prewarm skipped');
    }

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
      maxConcurrentStreams: config.maxConcurrentStreams ?? 3,
      transmitCycles: config.transmitCycles,
      maxQSOTimeoutCycles: 0,
      maxCallAttempts: 0,
      autoReplyToCQ: false,
      autoResumeCQAfterFail: false,
      autoResumeCQAfterSuccess: false,
      replyToWorkedStations: false,
      prioritizeNewCalls: true,
      targetSelectionPriorityMode: 'dxcc_first',
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
      (myCallsign, targetCallsign, operatorId) =>
        this.isTargetBeingWorkedByOtherOperators(myCallsign, targetCallsign, operatorId)
    );
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
    await this.syncOperatorLogbookBinding(config.id, config.myCallsign, config.logBookId);
    if (this._pluginManager?.isRunning()) {
      await this._pluginManager.initInstancesForOperator(config.id);
    }
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

    // Remove only the operator identity. The callsign logbook is durable and
    // may still be shared by another operator or reused by a replacement.
    this.logManager.unregisterOperatorCallsign(operatorId);
    
    this.operators.delete(operatorId);
    this.targetReservations.releaseOperator(operatorId);
    this.clearActiveQsoLifecycles(operatorId);
    this.clearSameTransmissionGuard(operatorId);
    this._pluginManager?.removeInstancesForOperator(operatorId);
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
  getOperatorLogBookInfo(operatorId: string): { logBookId: string | null; logBook: LogBookInfo | null } {
    const logBookId = this.logManager.getOperatorLogBookId(operatorId);
    const logBook = logBookId ? this.logManager.getLogBook(logBookId) : null;
    
    return {
      logBookId,
      logBook: logBook ? {
        id: logBook.id,
        name: logBook.name,
        description: logBook.description,
        fileName: path.basename(logBook.filePath),
        storageKind: logBook.storageKind,
        createdAt: logBook.createdAt,
        lastUsed: logBook.lastUsed,
        isActive: logBook.isActive,
        health: logBook.provider.getHealth(),
      } : null
    };
  }

  /**
   * 获取电台操作员
   */
  getOperator(id: string): RadioOperator | undefined {
    return this.operators.get(id);
  }

  /** getOperatorById — alias for getOperator (used by PluginManager) */
  getOperatorById(id: string): RadioOperator | undefined {
    return this.operators.get(id);
  }

  getTransmissionFactContext(operatorId: string): {
    frequency: number;
    frequencyContext?: import('@tx5dr/contracts').SlotPackFrequencyContext;
  } | null {
    const operator = this.operators.get(operatorId);
    if (!operator) return null;
    return {
      frequency: operator.config.frequency || 0,
      frequencyContext: this.slotPackManager.getFrequencyContext(),
    };
  }

  /** 设置插件管理器（引擎初始化完成后由 DigitalRadioEngine 调用） */
  setPluginManager(pm: import('../plugin/PluginManager.js').PluginManager): void {
    this._pluginManager = pm;
  }

  /**
   * 获取所有电台操作员
   */
  getAllOperators(): RadioOperator[] {
    return Array.from(this.operators.values());
  }

  /**
   * 查询某操作员是否已与某呼号通联（供 PluginManager 使用）
   */
  async hasWorkedCallsign(operatorId: string, callsign: string, options?: { anyBand?: boolean }): Promise<boolean> {
    try {
      const logBook = await this.logManager.getOperatorLogBook(operatorId);
      if (!logBook) return false;
      if (options?.anyBand) {
        return logBook.provider.hasWorkedCallsign(callsign, {});
      }
      const band = this.resolveCurrentBandForWorkedCheck();
      if (band === 'Unknown') return false;
      return logBook.provider.hasWorkedCallsign(callsign, { band });
    } catch {
      return false;
    }
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
    for (const [id, operator] of this.operators.entries()) {
      const runtimeState = this._pluginManager?.getOperatorRuntimeStatus(id);
      const runtimeSnapshot = runtimeState
        ? (({ strategyName: _strategyName, currentSlot: _currentSlot, ...snapshot }) => ({
            ...snapshot,
            currentState: runtimeState.currentSlot,
          }))(runtimeState)
        : undefined;
      const queueExecutionSuspended = this._pluginManager?.isQueueExecutionSuspended?.(id) === true;
      const currentTransmissions = operator.isTransmitting && !queueExecutionSuspended
        ? this._pluginManager?.getCurrentTransmissions?.(id) ?? []
        : [];
      const hasTransmitIntent = currentTransmissions.length > 0;
      const currentSlot = runtimeState?.currentSlot ?? 'TX6';
      const slots = runtimeState?.slots;
      let targetGrid = String(runtimeState?.context?.targetGrid ?? '');
      const targetCall = String(runtimeState?.context?.targetCallsign ?? '');
      const activeQueueEntryIds = new Set(
        runtimeState?.queue?.activeEntryIds
          ?? (runtimeState?.queue?.activeEntryId ? [runtimeState.queue.activeEntryId] : []),
      );
      const targetCalls = Array.from(new Set([
        ...(runtimeState?.streams ?? []).map((stream) => stream.targetCallsign),
        ...(runtimeState?.queue?.rows ?? [])
          .filter((row) => activeQueueEntryIds.has(row.entryId))
          .map((row) => row.callsign),
        targetCall,
      ].flatMap((callsign) => {
        const normalized = callsign?.trim().toUpperCase();
        return normalized ? [normalized] : [];
      })));
      if (!targetGrid && targetCall && this.callsignTracker) {
        targetGrid = this.callsignTracker.getGrid(targetCall) ?? '';
      }

      const rawReportSent = runtimeState?.context?.reportSent;
      const rawReportReceived = runtimeState?.context?.reportReceived;
      const targetContext = {
        targetCall,
        targetGrid,
        // Keep unset reports as undefined. Coercing to 0 pollutes QSO logs
        // because FT8 SNR of 0 is valid and UI echoes can write the sentinel back.
        reportSent: typeof rawReportSent === 'number' && Number.isFinite(rawReportSent)
          ? rawReportSent
          : undefined,
        reportReceived: typeof rawReportReceived === 'number' && Number.isFinite(rawReportReceived)
          ? rawReportReceived
          : undefined,
      };
      
      operators.push({
        id,
        isActive: this.isRunning,
        isTransmitting: operator.isTransmitting,
        isInActivePTT: this.activeTransmissionOperatorIds.has(id),
        hasTransmitIntent,
        currentTransmissions,
        currentSlot,
        context: {
          myCall: operator.config.myCallsign,
          myGrid: operator.config.myGrid,
          targetCalls,
          targetCall: targetContext.targetCall,
          targetGrid: targetContext.targetGrid,
          frequency: operator.config.frequency,
          reportSent: targetContext.reportSent,
          reportReceived: targetContext.reportReceived,
        },
        strategy: {
          name: runtimeState?.strategyName ?? 'standard-qso',
          state: currentSlot,
          availableSlots: runtimeState?.availableSlots ?? ['TX1', 'TX2', 'TX3', 'TX4', 'TX5', 'TX6']
        },
        runtime: runtimeSnapshot,
        slots,
        transmitCycles: operator.getTransmitCycles(),
      });
    }
    
    return operators;
  }

  /**
   * 更新操作员上下文
   */
  async updateOperatorContext(
    operatorId: string,
    context: any,
    mutation?: {
      commandEpoch?: number;
      source?: 'manual' | 'plugin' | 'late-decode' | 'slot-auto';
      reason?: string;
    },
  ): Promise<void> {
    const operator = this.operators.get(operatorId);
    if (!operator) {
      throw new Error(`operator ${operatorId} not found`);
    }
    const normalizedContext = normalizeOperatorContext(context);
    const transmissionBefore = this._pluginManager?.getCurrentTransmission(operatorId) ?? null;
    let frequencyChanged = false;

    // 构建更新对象（只包含实际变化的字段）
    const updates: Partial<RadioOperatorConfig> = {};

    // 更新基本信息
    if (normalizedContext.myCall !== undefined && normalizedContext.myCall !== operator.config.myCallsign) {
      operator.config.myCallsign = normalizedContext.myCall;
      updates.myCallsign = normalizedContext.myCall;
    }
    if (normalizedContext.myGrid !== undefined && normalizedContext.myGrid !== operator.config.myGrid) {
      operator.config.myGrid = normalizedContext.myGrid;
      updates.myGrid = normalizedContext.myGrid;
    }
    if (normalizedContext.frequency !== undefined) {
      const clampedFreq = Math.max(1, Math.min(3000, normalizedContext.frequency));
      if (clampedFreq !== operator.config.frequency) {
        operator.config.frequency = clampedFreq;
        updates.frequency = clampedFreq;
        frequencyChanged = true;
      }
    }

    const runtimePatch: Record<string, unknown> = {};
    if (normalizedContext.targetCallsign !== undefined) runtimePatch.targetCallsign = normalizedContext.targetCallsign;
    if (normalizedContext.targetGrid !== undefined) runtimePatch.targetGrid = normalizedContext.targetGrid;
    if (normalizedContext.reportSent !== undefined) {
      runtimePatch.reportSent = normalizedContext.reportSent ?? undefined;
    }
    if (normalizedContext.reportReceived !== undefined) {
      runtimePatch.reportReceived = normalizedContext.reportReceived ?? undefined;
    }
    if (Object.keys(runtimePatch).length > 0) {
      this._pluginManager?.patchOperatorRuntimeContext(operatorId, runtimePatch as any);
    }

    const transmissionAfter = this._pluginManager?.getCurrentTransmission(operatorId) ?? null;
    const transmissionChanged = this.canonicalizeTransmissionMessage(transmissionBefore ?? '')
      !== this.canonicalizeTransmissionMessage(transmissionAfter ?? '');
    if (frequencyChanged || transmissionChanged) {
      this.requestOperatorFrameMutation(operatorId, {
        kind: frequencyChanged ? 'frequency' : 'context',
        reason: mutation?.reason ?? (frequencyChanged
          ? 'operator audio frequency changed'
          : 'operator context changed current transmit text'),
        commandEpoch: mutation?.commandEpoch,
        source: mutation?.source,
      });
    }

    // Frame mutation is latency-sensitive and follows the in-memory desired
    // state. Configuration durability remains awaited by the API caller, but
    // cannot delay an in-slot replacement behind filesystem I/O.
    if (Object.keys(updates).length > 0) {
      const configManager = ConfigManager.getInstance();
      await configManager.updateOperatorConfig(operatorId, updates);
      if (updates.myCallsign) {
        const persistedOperator = configManager.getOperatorConfig(operatorId);
        await this.syncOperatorLogbookBinding(
          operatorId,
          updates.myCallsign,
          persistedOperator?.logBookId,
        );
      }
      logger.debug(`Saved operator ${operatorId} config to file:`, updates);
    }

    logger.debug(`Updated operator ${operatorId} context:`, normalizedContext);
    this.emitOperatorStatusUpdate(operatorId);
  }

  /**
   * 仅持久化操作员上下文到配置文件（不更新内存、不触发广播）
   * 用于兼容需要只落盘基本信息的场景。
   */
  async persistOperatorContext(operatorId: string, context: any): Promise<void> {
    const operator = this.operators.get(operatorId);
    if (!operator) {
      throw new Error(`operator ${operatorId} not found`);
    }
    const normalizedContext = normalizeOperatorContext(context);

    // 比较并构建更新对象（仅包含实际变化的字段）
    const updates: Partial<RadioOperatorConfig> = {};

    if (normalizedContext.myCall !== undefined && normalizedContext.myCall !== operator.config.myCallsign) {
      updates.myCallsign = normalizedContext.myCall;
    }
    if (normalizedContext.myGrid !== undefined && normalizedContext.myGrid !== operator.config.myGrid) {
      updates.myGrid = normalizedContext.myGrid;
    }
    if (normalizedContext.frequency !== undefined) {
      const clampedFreq = Math.max(1, Math.min(3000, normalizedContext.frequency));
      if (clampedFreq !== operator.config.frequency) {
        updates.frequency = clampedFreq;
      }
    }
    if (Object.keys(updates).length > 0) {
      const configManager = ConfigManager.getInstance();
      await configManager.updateOperatorConfig(operatorId, updates);
      logger.debug(`Persisted operator ${operatorId} context to file:`, updates);
    }
  }

  setOperatorRuntimeState(operatorId: string, state: import('@tx5dr/contracts').OperatorRuntimeSlot): void {
    const operator = this.operators.get(operatorId);
    if (!operator) {
      throw new Error(`operator ${operatorId} not found`);
    }

    this._pluginManager?.setOperatorRuntimeState(operatorId, state);
    logger.debug(`Set operator ${operatorId} runtime state: ${state}`);
    this.emitOperatorStatusUpdate(operatorId);
  }

  async setOperatorStreamState(
    operatorId: string,
    update: { streamId: string; stateId: string; expectedLifecycleEpoch: number },
  ): Promise<void> {
    const operator = this.operators.get(operatorId);
    if (!operator) throw new Error(`operator ${operatorId} not found`);
    await this._pluginManager?.setOperatorStreamState(operatorId, update);
    this.emitOperatorStatusUpdate(operatorId);
  }

  async invokeOperatorStrategyAction(
    operatorId: string,
    invocation: import('@tx5dr/plugin-api').StrategyActionInvocation,
  ): Promise<void> {
    if (!this.operators.has(operatorId)) throw new Error(`operator ${operatorId} not found`);
    if (!this._pluginManager) throw new Error('plugin_manager_unavailable');
    await this._pluginManager.invokeOperatorStrategyAction(operatorId, invocation);
    this.emitOperatorStatusUpdate(operatorId);
  }

  async setOperatorRuntimeSlotContent(
    operatorId: string,
    slot: import('@tx5dr/contracts').OperatorRuntimeSlot,
    content: string,
  ): Promise<void> {
    const operator = this.operators.get(operatorId);
    if (!operator) {
      throw new Error(`operator ${operatorId} not found`);
    }

    const persistedSettings = this._pluginManager?.setOperatorRuntimeSlotContent(operatorId, slot, content);
    if (persistedSettings) {
      await ConfigManager.getInstance().setOperatorPluginSettings(
        operatorId,
        'standard-qso',
        persistedSettings,
      );
    }
    logger.debug(`Set operator ${operatorId} runtime slot content: slot=${slot}`);
    this.emitOperatorStatusUpdate(operatorId);
  }

  async setOperatorTransmitCycles(operatorId: string, transmitCycles: number[]): Promise<void> {
    const operator = this.operators.get(operatorId);
    if (!operator) {
      throw new Error(`operator ${operatorId} not found`);
    }

    const outcome = await this.intentCoordinator.submit(operatorId, 'manual', async (token, signal) => {
      await this.persistTransmitCycles(operatorId, transmitCycles);
      if (signal.aborted || !this.intentCoordinator.isCurrent(token)) return;
      operator.setTransmitCycles(transmitCycles, {
        commandEpoch: token.epoch,
        source: 'manual',
        reason: 'operator selected transmit cycle',
      });
      this.emitOperatorStatusUpdate(operatorId);
    });
    if (outcome.status !== 'completed') throw new Error('transmit_cycle_command_superseded');
  }

  /**
   * 启动操作员发射
   */
  startOperator(operatorId: string): void {
    this.startOperatorInternal(operatorId, false);
  }

  /**
   * Arms an idle operator for a strategy action. Decision and physical-frame
   * scheduling remain with the caller's existing intent transaction.
   */
  prepareOperatorStrategyStart(operatorId: string): boolean {
    return this.startOperatorInternal(operatorId, true);
  }

  cancelPreparedOperatorStrategyStart(operatorId: string, reason: string): void {
    const operator = this.operators.get(operatorId);
    if (!operator) {
      throw new Error(`operator ${operatorId} not found`);
    }
    this._pluginManager?.suspendQueueExecution?.(operatorId);
    this.pendingTransmissions = this.pendingTransmissions.filter(
      (request) => request.operatorId !== operatorId,
    );
    this.releaseTargetReservation(operatorId);
    this.requestStrategyStop(operatorId, reason);
    this.clearSameTransmissionGuard(operatorId);
    operator.stop();
    logger.info(`Cancelled prepared strategy start for operator ${operatorId}`, { reason });
    this.emitOperatorStatusUpdate(operatorId);
  }

  private startOperatorInternal(operatorId: string, deferInitialDecision: boolean): boolean {
    const operator = this.operators.get(operatorId);
    if (!operator) {
      throw new Error(`operator ${operatorId} not found`);
    }
    if (deferInitialDecision && operator.isTransmitting) return false;
    const transmitGate = typeof this._pluginManager?.getOperatorTransmitGate === 'function'
      ? this._pluginManager.getOperatorTransmitGate(operatorId)
      : undefined;
    if (transmitGate) {
      throw new Error(`strategy_transmit_blocked: ${transmitGate.reason}`);
    }
    if ([...this.unsavedQsoAttempts.values()].some(attempt => attempt.operatorId === operatorId)) {
      throw new LogbookOperationError(
        'LOGBOOK_MAINTENANCE',
        'Resolve the unsaved QSO before restarting automatic operation',
      );
    }

    const started = !operator.isTransmitting;
    this.clearSameTransmissionGuard(operatorId);
    operator.start();
    logger.info(`Started transmitting for operator ${operatorId}`);
    this.emitOperatorStatusUpdate(operatorId);

    if (deferInitialDecision) {
      this._pluginManager?.suspendQueueExecution?.(operatorId);
      return started;
    }

    if (this._pluginManager?.hasTargetQueue?.(operatorId)) {
      void this._pluginManager.resumeQueueExecution(operatorId).then((validated) => {
        if (validated && operator.isTransmitting) this.checkAndTriggerTransmission(operatorId);
      }).catch((error) => {
        logger.warn(`Failed to revalidate assisted queue execution for ${operatorId}`, error);
      });
      return started;
    }

    // 立即检查并触发发射（如果在发射周期内）
    this.checkAndTriggerTransmission(operatorId);
    return started;
  }

  listUnsavedQsos(logBookId: string, operatorIds?: ReadonlySet<string>): Array<{
    attemptId: string;
    operatorId: string;
    createdAt: number;
    callsign: string;
    mode: string;
  }> {
    return [...this.unsavedQsoAttempts.values()]
      .filter(attempt => attempt.logBookId === logBookId
        && (!operatorIds || operatorIds.has(attempt.operatorId)))
      .map(attempt => ({
        attemptId: attempt.attemptId,
        operatorId: attempt.operatorId,
        createdAt: attempt.createdAt,
        callsign: attempt.qsoRecord.callsign,
        mode: attempt.qsoRecord.mode,
      }));
  }

  async retryUnsavedQso(
    logBookId: string,
    attemptId: string,
    operatorIds?: ReadonlySet<string>,
  ): Promise<QSORecord> {
    const activeRetry = this.unsavedQsoRetryFlights.get(attemptId);
    if (activeRetry) return activeRetry;

    const attempt = this.requireUnsavedAttempt(logBookId, attemptId, operatorIds);
    const operator = this.operators.get(attempt.operatorId);
    if (!operator) {
      throw new LogbookOperationError('LOGBOOK_UNSAVED_QSO_NOT_FOUND', 'The operator for this unsaved QSO is unavailable');
    }
    const retry = operator.recordQSOLog({
        ...attempt.qsoRecord,
        messageHistory: [...attempt.qsoRecord.messageHistory],
      }, {
        retryAttemptId: attempt.attemptId,
        qsoLifecycleId: attempt.qsoLifecycleId,
        qsoLifecycleEpoch: attempt.qsoLifecycleEpoch,
        qsoRuntimeGeneration: attempt.qsoRuntimeGeneration,
        streamId: attempt.streamId,
        persistencePolicy: attempt.persistencePolicy,
        destination: attempt.destination,
        sourcePluginName: attempt.sourcePluginName,
      })
      .then((persisted) => {
        if (this.isCurrentQsoLifecycle(
          attempt.operatorId,
          attempt.qsoLifecycleEpoch,
          attempt.qsoRuntimeGeneration,
          attempt.streamId,
        ) && this.getUnsavedQsosForOperator(attempt.operatorId).length === 0) {
          this._pluginManager?.resetOperatorPluginRuntime(
            attempt.operatorId,
            'unsaved QSO durably persisted by explicit retry',
          );
        }
        return persisted;
      })
      .finally(() => {
        if (this.unsavedQsoRetryFlights.get(attemptId) === retry) {
          this.unsavedQsoRetryFlights.delete(attemptId);
        }
      });
    this.unsavedQsoRetryFlights.set(attemptId, retry);
    return retry;
  }

  discardUnsavedQso(
    logBookId: string,
    attemptId: string,
    operatorIds?: ReadonlySet<string>,
  ): void {
    const attempt = this.requireUnsavedAttempt(logBookId, attemptId, operatorIds);
    if (this.unsavedQsoRetryFlights.has(attemptId)) {
      throw new LogbookOperationError(
        'LOGBOOK_MAINTENANCE',
        'This unsaved QSO is currently being retried',
      );
    }
    this.unsavedQsoAttempts.delete(attempt.attemptId);
    if (this.getUnsavedQsosForOperator(attempt.operatorId).length === 0) {
      this.operators.get(attempt.operatorId)?.clearLogbookFailureBlock();
      this._pluginManager?.resetOperatorPluginRuntime(
        attempt.operatorId,
        'unsaved QSO explicitly discarded',
      );
    }
  }

  private requireUnsavedAttempt(
    logBookId: string,
    attemptId: string,
    operatorIds?: ReadonlySet<string>,
  ): UnsavedQsoAttempt {
    const attempt = this.unsavedQsoAttempts.get(attemptId);
    if (!attempt
      || attempt.logBookId !== logBookId
      || (operatorIds && !operatorIds.has(attempt.operatorId))) {
      throw new LogbookOperationError('LOGBOOK_UNSAVED_QSO_NOT_FOUND', 'The unsaved QSO no longer exists');
    }
    return attempt;
  }

  private rememberUnsavedQso(
    operatorId: string,
    logBookId: string,
    record: QSORecord,
    qsoLifecycleId?: string,
    qsoLifecycleEpoch?: number,
    qsoRuntimeGeneration?: number,
    persistencePolicy?: QSOPersistencePolicy,
    streamId?: string,
    destination?: { kind: 'plugin-session'; sessionId: string },
    sourcePluginName?: string,
  ): string {
    const existing = this.getUnsavedQsosForOperator(operatorId).find((attempt) => (
      qsoLifecycleId !== undefined
        ? attempt.qsoLifecycleId === qsoLifecycleId
        : attempt.qsoRecord.id === record.id
    ));
    if (existing) return existing.attemptId;
    const attemptId = randomUUID();
    this.unsavedQsoAttempts.set(attemptId, {
      attemptId,
      operatorId,
      logBookId,
      qsoRecord: { ...record, messageHistory: [...record.messageHistory] },
      qsoLifecycleId,
      qsoLifecycleEpoch,
      qsoRuntimeGeneration,
      streamId,
      persistencePolicy,
      destination,
      sourcePluginName,
      createdAt: Date.now(),
    });
    return attemptId;
  }

  private getUnsavedQsosForOperator(operatorId: string): UnsavedQsoAttempt[] {
    return [...this.unsavedQsoAttempts.values()].filter(attempt => attempt.operatorId === operatorId);
  }

  private clearUnsavedQsoForLifecycle(
    operatorId: string,
    qsoLifecycleId?: string,
    qsoRecordId?: string,
  ): void {
    for (const [attemptId, attempt] of this.unsavedQsoAttempts) {
      if (attempt.operatorId === operatorId
          && (qsoLifecycleId !== undefined
            ? attempt.qsoLifecycleId === qsoLifecycleId
            : attempt.qsoRecord.id === qsoRecordId)) {
        this.unsavedQsoAttempts.delete(attemptId);
      }
    }
  }

  private isCurrentQsoLifecycle(
    operatorId: string,
    lifecycleEpoch?: number,
    runtimeGeneration?: number,
    streamId?: string,
  ): boolean {
    if (lifecycleEpoch === undefined) return true;
    const active = this.activeQsoLifecycles.get(qsoLifecycleKey(operatorId, streamId));
    if (!active) return true;
    if (active.epoch !== lifecycleEpoch) return false;
    return runtimeGeneration === undefined
      || active.runtimeGeneration === undefined
      || active.runtimeGeneration === runtimeGeneration;
  }

  private clearActiveQsoLifecycles(operatorId: string): void {
    const prefix = `${operatorId}\0`;
    for (const key of this.activeQsoLifecycles.keys()) {
      if (key.startsWith(prefix)) this.activeQsoLifecycles.delete(key);
    }
  }

  private pauseOperatorAfterLogbookFailure(operatorId: string): void {
    const operator = this.operators.get(operatorId);
    if (!operator) return;
    this.clearSameTransmissionGuard(operatorId);
    operator.blockForLogbookFailure();
    const frameStop = this.requestStrategyStop(operatorId, 'logbook durability failure');
    if (this._pluginManager?.hasTargetQueue?.(operatorId) !== true) {
      const resetPluginRuntime = this._pluginManager?.resetOperatorPluginRuntime?.bind(this._pluginManager);
      if (resetPluginRuntime) {
        try {
          resetPluginRuntime(operatorId, 'logbook durability failure');
        } catch (error) {
          logger.warn(`Failed to reset plugin runtime for ${operatorId} after a logbook failure`, error);
          this.resetPluginRuntime(operatorId, 'logbook durability failure');
        }
      } else {
        this.resetPluginRuntime(operatorId, 'logbook durability failure');
      }
    }
    this.emitOperatorStatusUpdate(operatorId);
    logger.error(`Paused operator ${operatorId} after a logbook durability failure`, { frameStop });
  }

  private canonicalizeTransmissionMessage(message: string): string {
    return message.trim().replace(/\s+/g, ' ').toUpperCase();
  }

  private getMaxSameTransmissionCount(): number {
    try {
      const configured = ConfigManager.getInstance().getFT8Config().maxSameTransmissionCount;
      if (typeof configured === 'number' && Number.isFinite(configured)) {
        const normalized = Math.trunc(configured);
        return normalized <= 0 ? Number.POSITIVE_INFINITY : normalized;
      }
    } catch (error) {
      logger.warn('Failed to read maxSameTransmissionCount, using default', error);
    }
    return DEFAULT_MAX_SAME_TRANSMISSION_COUNT;
  }

  private clearSameTransmissionGuard(operatorId: string): void {
    const prefix = `${operatorId}\u0000`;
    for (const key of this.sameTransmissionGuardStates.keys()) {
      if (key.startsWith(prefix)) this.sameTransmissionGuardStates.delete(key);
    }
    this.operatorTransmissionSetGuardStates.delete(operatorId);
  }

  private evaluateSameTransmissionGuard(
    operatorId: string,
    streamId: string,
    transmission: string,
    slotStartMs: number,
  ): SameTransmissionGuardEvaluation {
    const canonicalMessage = this.canonicalizeTransmissionMessage(transmission);
    return this.evaluateTransmissionGuardState(
      this.sameTransmissionGuardStates,
      buildTrackId(operatorId, streamId),
      canonicalMessage,
      slotStartMs,
    );
  }

  private evaluateOperatorTransmissionSetGuard(
    operatorId: string,
    transmissions: readonly string[],
    slotStartMs: number,
  ): SameTransmissionGuardEvaluation {
    const canonicalMessage = JSON.stringify(
      transmissions
        .map((transmission) => this.canonicalizeTransmissionMessage(transmission))
        .filter(Boolean)
        .sort(),
    );
    return this.evaluateTransmissionGuardState(
      this.operatorTransmissionSetGuardStates,
      operatorId,
      canonicalMessage === '[]' ? '' : canonicalMessage,
      slotStartMs,
    );
  }

  private evaluateTransmissionGuardState(
    states: ReadonlyMap<string, SameTransmissionGuardState>,
    guardKey: string,
    canonicalMessage: string,
    slotStartMs: number,
  ): SameTransmissionGuardEvaluation {
    if (!canonicalMessage) return { allowed: true };
    const previous = states.get(guardKey);
    if (!previous || previous.canonicalMessage !== canonicalMessage) {
      return {
        allowed: true,
        guardKey,
        nextState: { canonicalMessage, count: 1, lastCountedSlotStartMs: slotStartMs },
      };
    }

    if (previous.lastCountedSlotStartMs === slotStartMs) {
      return { allowed: true, guardKey };
    }

    const nextCount = previous.count + 1;
    const maxCount = this.getMaxSameTransmissionCount();
    if (nextCount > maxCount) {
      return {
        allowed: false,
        guardKey,
        attemptedCount: nextCount,
        maxCount,
      };
    }

    return {
      allowed: true,
      guardKey,
      nextState: {
        canonicalMessage,
        count: nextCount,
        lastCountedSlotStartMs: slotStartMs,
      },
    };
  }

  private commitSameTransmissionGuardEvaluations(
    evaluations: readonly SameTransmissionGuardEvaluation[],
    states: Map<string, SameTransmissionGuardState> = this.sameTransmissionGuardStates,
  ): void {
    for (const evaluation of evaluations) {
      if (evaluation.guardKey && evaluation.nextState) {
        states.set(evaluation.guardKey, evaluation.nextState);
      }
    }
  }

  private stopOperatorAfterSameTransmissionLimit(
    operatorId: string,
    transmission: string,
    attemptedCount: number,
    maxCount: number,
  ): void {
    const operator = this.operators.get(operatorId);
    if (!operator) {
      return;
    }

    logger.warn('Same transmission limit reached, stopping operator', {
      operatorId,
      transmission,
      attemptedCount,
      maxCount,
    });

    this.eventEmitter.emit('textMessage', {
      title: 'Repeated transmission stopped',
      text: `Operator ${operatorId} was stopped after attempting to transmit the same message ${attemptedCount} times in a row.`,
      color: 'warning',
      timeout: 8000,
      key: 'sameTransmissionLimit',
      params: {
        operatorId,
        attemptedCount: String(attemptedCount),
        maxCount: String(maxCount),
        transmission,
      },
    });

    operator.stop();
    const resetOperatorPluginRuntime = this._pluginManager?.resetOperatorPluginRuntime?.bind(this._pluginManager);
    if (resetOperatorPluginRuntime) {
      try {
        resetOperatorPluginRuntime(operatorId, SAME_TRANSMISSION_GUARD_RESET_REASON);
        return;
      } catch (error) {
        logger.warn('Failed to reset plugin runtime after same transmission limit, falling back to local cleanup', {
          operatorId,
          error,
        });
      }
    }

    this.resetPluginRuntime(operatorId, SAME_TRANSMISSION_GUARD_RESET_REASON);
  }

  /**
   * 处理待发射队列
   * 由 DigitalRadioEngine 在 transmitStart 事件时调用
   * 处理所有通过了 RadioOperator 周期检查的发射请求
   * @param slotInfo 时隙信息(包含准确的时间戳)
   */
  processPendingTransmissions(slotInfo: any): void {
    if (this.transmissionMaintenanceReason) {
      this.pendingTransmissions = [];
      return;
    }
    if (!this.isRunning || this.pendingTransmissions.length === 0) return;

    const currentMode = this.getCurrentMode();
    const slotStartMs = slotInfo.startMs;
    const now = this.clockSource.now();
    const timeSinceSlotStartMs = now - slotStartMs;
    const requests = [...this.pendingTransmissions];
    this.pendingTransmissions = [];

    const slotId = `slot-${slotStartMs}`;
    const completeSetOperators = new Set(
      requests.filter((request) => request.completeOperatorSet).map((request) => request.operatorId),
    );
    const latestByTrack = new Map<string, QueuedTransmitRequest>();
    for (const request of requests) {
      latestByTrack.set(buildTrackId(request.operatorId, request.streamId), request);
    }

    // A physical mixed frame is atomic. A correction for one participant must
    // re-encode every remaining participant so no track from the old revision
    // can be relabelled as part of the replacement frame.
    const currentFrame = this.digitalFrameCoordinator.getCurrentFrameForSlot(slotId);
    if (currentFrame && requests.length > 0) {
      const currentIntents = this.digitalFrameCoordinator.getIntentRequests(currentFrame.frameId);
      for (const intent of currentIntents) {
        const trackId = buildTrackId(intent.operatorId, intent.streamId);
        if (completeSetOperators.has(intent.operatorId) || latestByTrack.has(trackId)) continue;
        const transmission = intent.text ?? this._pluginManager?.getCurrentTransmission(intent.operatorId);
        if (!transmission) continue;
        latestByTrack.set(trackId, {
          operatorId: intent.operatorId,
          streamId: normalizeStreamId(intent.streamId),
          transmission,
          audioFrequencyHz: intent.audioFrequencyHz,
          replaceExisting: true,
          source: intent.source === 'persistence' || intent.source === 'device'
            ? 'plugin'
            : intent.source,
          reason: 'complete mixed-frame rebuild',
          decisionEpoch: intent.decisionEpoch,
        });
      }
    }
    const uniqueRequests = Array.from(latestByTrack.values()).map((request) => currentFrame
      ? {
          ...request,
          replaceExisting: true,
          reason: request.reason ?? 'complete mixed-frame rebuild',
        }
      : request);
    if (uniqueRequests.length < requests.length) {
      logger.warn(`Superseded transmit requests detected: ${requests.length} -> ${uniqueRequests.length}`);
    }

    const admissionGroups: Array<{
      operatorId: string;
      completeOperatorSet: boolean;
      requests: QueuedTransmitRequest[];
    }> = [];
    const completeGroupsByOperator = new Map<string, typeof admissionGroups[number]>();
    for (const request of uniqueRequests) {
      if (!completeSetOperators.has(request.operatorId)) {
        admissionGroups.push({
          operatorId: request.operatorId,
          completeOperatorSet: false,
          requests: [request],
        });
        continue;
      }
      let group = completeGroupsByOperator.get(request.operatorId);
      if (!group) {
        group = { operatorId: request.operatorId, completeOperatorSet: true, requests: [] };
        completeGroupsByOperator.set(request.operatorId, group);
        admissionGroups.push(group);
      }
      group.requests.push(request);
    }

    const waitingForTransmitCycle: QueuedTransmitRequest[] = [];
    const admittedGroups: Array<{
      requests: QueuedTransmitRequest[];
      guardEvaluations: SameTransmissionGuardEvaluation[];
    }> = [];
    for (const group of admissionGroups) {
      const operator = this.operators.get(group.operatorId);
      if (!operator?.isTransmitting) continue;

      const standardFrequencyRestriction = this.getStandardFrequencyStreamRestriction(currentMode);
      if (standardFrequencyRestriction && group.requests.length > 1) {
        this.notifyStandardFrequencyStreamFallback(group.operatorId, standardFrequencyRestriction);
        continue;
      }

      const currentEpoch = this.intentCoordinator.getCurrentEpoch(group.operatorId);
      const stale = group.requests.find((request) => request.decisionEpoch !== currentEpoch);
      if (stale) {
        logger.debug('Discarded stale queued transmission intent set', {
          operatorId: group.operatorId,
          completeOperatorSet: group.completeOperatorSet,
          requestEpoch: stale.decisionEpoch,
          currentEpoch,
        });
        continue;
      }

      const isTransmitCycle = CycleUtils.isOperatorTransmitCycleFromMs(
        operator.getTransmitCycles(),
        slotStartMs,
        currentMode.slotMs,
      );
      if (!isTransmitCycle && group.requests.some((request) => request.waitForTransmitCycle)) {
        waitingForTransmitCycle.push(...group.requests);
        continue;
      }

      const placeholder = group.requests.find((request) => (
        FT8MessageParser.rawContainsUndecodedCallsign(request.transmission)
      ));
      if (placeholder) {
        logger.warn('Refusing operator transmission set containing an undecoded placeholder', {
          operatorId: group.operatorId,
          streamId: normalizeStreamId(placeholder.streamId),
          completeOperatorSet: group.completeOperatorSet,
        });
        continue;
      }

      const guardEvaluations = group.requests.map((request) => this.evaluateSameTransmissionGuard(
        request.operatorId,
        normalizeStreamId(request.streamId),
        request.transmission,
        slotStartMs,
      ));
      const rejectedGuardIndex = guardEvaluations.findIndex((evaluation) => !evaluation.allowed);
      if (rejectedGuardIndex >= 0) {
        const rejectedRequest = group.requests[rejectedGuardIndex]!;
        const rejected = guardEvaluations[rejectedGuardIndex]!;
        this.stopOperatorAfterSameTransmissionLimit(
          group.operatorId,
          rejectedRequest.transmission,
          rejected.attemptedCount!,
          rejected.maxCount!,
        );
        continue;
      }

      // Reject an internally invalid complete set without suppressing otherwise
      // independent operators that can still contribute to this physical frame.
      if (!this.validateMultiTrackFrequencies(group.requests, currentMode.name)) continue;
      admittedGroups.push({ requests: group.requests, guardEvaluations });
    }
    if (waitingForTransmitCycle.length > 0) {
      this.requeueForNextSlot(waitingForTransmitCycle, 'waiting for operator transmit cycle');
    }
    const admittedRequestsByOperator = new Map<string, QueuedTransmitRequest[]>();
    for (const group of admittedGroups) {
      const operatorRequests = admittedRequestsByOperator.get(group.requests[0]!.operatorId) ?? [];
      operatorRequests.push(...group.requests);
      admittedRequestsByOperator.set(group.requests[0]!.operatorId, operatorRequests);
    }
    const rejectedOperatorSets = new Set<string>();
    const operatorSetGuardEvaluations: SameTransmissionGuardEvaluation[] = [];
    for (const [operatorId, operatorRequests] of admittedRequestsByOperator) {
      const evaluation = this.evaluateOperatorTransmissionSetGuard(
        operatorId,
        operatorRequests.map((request) => request.transmission),
        slotStartMs,
      );
      if (!evaluation.allowed) {
        rejectedOperatorSets.add(operatorId);
        const messages = [...new Set(operatorRequests.map((request) => request.transmission))];
        this.stopOperatorAfterSameTransmissionLimit(
          operatorId,
          messages.join(' | '),
          evaluation.attemptedCount!,
          evaluation.maxCount!,
        );
        continue;
      }
      operatorSetGuardEvaluations.push(evaluation);
    }

    const eligibleGroups = admittedGroups.filter(
      (group) => !rejectedOperatorSets.has(group.requests[0]!.operatorId),
    );
    const eligibleRequests = eligibleGroups.flatMap((group) => group.requests);
    if (eligibleRequests.length === 0) return;
    if (!this.validateMultiTrackFrequencies(eligibleRequests, currentMode.name)) return;

    const playbackStartMs = slotStartMs + Math.max(
      0,
      (currentMode.transmitTiming || 0) - this.getTransmitCompensationMs(),
    );

    const prepared = this.digitalFrameCoordinator.prepareFrame({
      slotId,
      intents: eligibleRequests.map((request) => ({
        operatorId: request.operatorId,
        streamId: normalizeStreamId(request.streamId),
        source: request.source ?? (request.replaceExisting ? 'late-decode' : 'plugin'),
        reason: request.reason ?? (request.replaceExisting ? 'replace existing frame' : 'slot transmission'),
        text: request.transmission,
        audioFrequencyHz: request.audioFrequencyHz,
        decisionEpoch: request.decisionEpoch
          ?? this.intentCoordinator.getCurrentEpoch(request.operatorId),
      })),
      nowMs: now,
      slotEndMs: slotStartMs + currentMode.slotMs,
      expectedDurationMs: currentMode.name === 'FT4' ? 6_000 : 12_640,
      playbackStartMs,
    });
    if (!prepared.frame || prepared.action === 'defer-next-slot') {
      logger.info('Transmission correction deferred to next slot', {
        slotId,
        reason: prepared.reason,
        operatorIds: eligibleRequests.map((request) => request.operatorId),
      });
      this.requeueForNextSlot(eligibleRequests, prepared.reason ?? 'complete frame does not fit current slot');
      return;
    }
    this.commitSameTransmissionGuardEvaluations(
      eligibleGroups.flatMap((group) => group.guardEvaluations),
    );
    this.commitSameTransmissionGuardEvaluations(
      operatorSetGuardEvaluations,
      this.operatorTransmissionSetGuardStates,
    );
    this.digitalFrameCoordinator.beginEncoding(prepared.frame.frameId);

    const slotShiftHz = this.resolveSlotTxDialShift(
      slotStartMs,
      eligibleRequests,
      this.getFakeFrequencyEnabled?.() ?? false,
    );

    for (const request of eligibleRequests) {
      const operatorId = request.operatorId;
      const streamId = normalizeStreamId(request.streamId);
      const transmission = request.transmission;
      const operator = this.operators.get(operatorId)!;
      const frequency = request.audioFrequencyHz ?? operator.config.frequency ?? 0;
      const trackId = buildTrackId(operatorId, streamId);
      const intent = prepared.intents.find((candidate) => candidate.trackId === trackId)!;
      const requestId = `${prepared.frame.frameId}:${trackId}:${intent.decisionEpoch}`;
      if (this.transmissionTracker) {
        this.transmissionTracker.startTransmission(operatorId, slotId, playbackStartMs);
        this.transmissionTracker.updatePhase(operatorId, 'preparing' as any);
      }

      const encodeFrequency = slotShiftHz !== 0
        ? Math.max(0, Math.round(frequency - slotShiftHz))
        : frequency;
      if (slotShiftHz !== 0 && Math.round(frequency - slotShiftHz) < 0) {
        logger.warn('Fake frequency clamp under frozen slot shift', { operatorId, frequency, slotShiftHz });
      }

      void this.encodeQueue.push({
        operatorId,
        streamId,
        trackId,
        message: transmission,
        frequency: encodeFrequency,
        mode: currentMode.name === 'FT4' ? 'FT4' : 'FT8',
        slotStartMs,
        timeSinceSlotStartMs,
        requestId,
        txDialShiftHz: slotShiftHz,
        frameId: prepared.frame.frameId,
        frameRevision: prepared.frame.revision,
        decisionEpoch: intent.decisionEpoch,
      });
    }
  }

  private validateMultiTrackFrequencies(
    requests: QueuedTransmitRequest[],
    modeName: string,
  ): boolean {
    if (requests.length <= 1) return true;
    const minimumSpacingHz = modeName.toUpperCase() === 'FT4' ? 100 : 60;
    const frequencies = requests.map((request) => ({
      operatorId: request.operatorId,
      streamId: normalizeStreamId(request.streamId),
      frequency: request.audioFrequencyHz
        ?? this.operators.get(request.operatorId)?.config.frequency
        ?? 0,
    })).sort((left, right) => left.frequency - right.frequency);
    const invalidRange = frequencies.find((item) => item.frequency < 100 || item.frequency > 5000);
    let conflict: { left: typeof frequencies[number]; right: typeof frequencies[number] } | undefined;
    for (let index = 1; index < frequencies.length; index += 1) {
      if (frequencies[index].frequency - frequencies[index - 1].frequency < minimumSpacingHz) {
        conflict = { left: frequencies[index - 1], right: frequencies[index] };
        break;
      }
    }
    if (!invalidRange && !conflict) return true;

    logger.warn('Rejected multi-signal frame with unsafe audio-frequency layout', {
      modeName,
      minimumSpacingHz,
      invalidRange,
      conflict,
    });
    this.eventEmitter.emit('textMessage', {
      title: 'Multi-signal frequency conflict',
      text: conflict
        ? `Audio carriers must be at least ${minimumSpacingHz} Hz apart.`
        : 'Audio carriers must stay between 100 and 5000 Hz.',
      color: 'warning',
      timeout: 8000,
      key: 'multiSignalFrequencyConflict',
      params: { minimumSpacingHz: String(minimumSpacingHz) },
    });
    return false;
  }

  /**
   * 虚拟频率：计算/复用本时隙统一的 dial 平移量（Hz）。
   * - 按 slotStartMs 冻结：同一时隙首次计算后固定，保证中途加入的操作员复用同一 shift，
   *   与已编码音频及单次 dial 平移匹配（避免功能在时隙中途被切换导致 RF 错配）。
   * - 多操作员：取所有发射操作员音频频率的 min/max 中心，把整团混音平移进甜区。
   * - 滞回：中心已落在 [target±hysteresis] 内则不平移，避免每时隙来回切频。
   */
  private resolveSlotTxDialShift(
    slotStartMs: number,
    requests: QueuedTransmitRequest[],
    enabled: boolean,
  ): number {
    if (this.currentSlotTxDialShift?.slotStartMs === slotStartMs) {
      return this.currentSlotTxDialShift.shiftHz; // 本时隙已冻结
    }

    let shiftHz = 0;
    if (enabled) {
      const freqs = requests
        .filter((request) => this.operators.get(request.operatorId)?.isTransmitting)
        .map((request) => request.audioFrequencyHz
          ?? this.operators.get(request.operatorId)?.config.frequency
          ?? 0)
        .filter((f) => f > 0);

      if (freqs.length > 0) {
        const center = (Math.min(...freqs) + Math.max(...freqs)) / 2;
        if (Math.abs(center - RadioOperatorManager.FAKE_FREQ_TARGET_HZ)
            > RadioOperatorManager.FAKE_FREQ_HYSTERESIS_HZ) {
          shiftHz = Math.round(center - RadioOperatorManager.FAKE_FREQ_TARGET_HZ);
        }
      }
    }

    this.currentSlotTxDialShift = { slotStartMs, shiftHz };
    return shiftHz;
  }

  /**
   * 虚拟频率：本时隙是否已提交 dial 平移计划（即已过 encodeStart、shift 已冻结）。
   * 物理上 tone 期间不可移动 dial，因此一旦提交，发射中的频率变更必须顺延到下一时隙。
   */
  private isFakeFrequencyCommittedForCurrentSlot(): boolean {
    if (!(this.getFakeFrequencyEnabled?.() ?? false)) {
      return false;
    }
    const mode = this.getCurrentMode();
    const now = this.clockSource.now();
    const currentSlotStartMs = Math.floor(now / mode.slotMs) * mode.slotMs;
    return this.currentSlotTxDialShift?.slotStartMs === currentSlotStartMs;
  }

  /**
   * Reconciles one already-applied operator property change with the current
   * candidate/physical frame. Configuration remains the source of the desired
   * state; this method is the only bridge that mutates the frame lifecycle.
   */
  private requestOperatorFrameMutation(
    operatorId: string,
    mutation: {
      kind: 'frequency' | 'transmit-cycles' | 'slot' | 'slot-content' | 'context';
      reason: string;
      source?: 'manual' | 'plugin' | 'late-decode' | 'slot-auto';
      commandEpoch?: number;
    },
  ): void {
    if (this.transmissionMaintenanceReason) return;
    if (this._pluginManager?.isQueueExecutionSuspended?.(operatorId)) return;

    if (mutation.kind === 'frequency' && this.isFakeFrequencyCommittedForCurrentSlot()) {
      logger.debug('Deferring operator frequency mutation to next slot because fake frequency is committed', {
        operatorId,
      });
      return;
    }

    const decisionEpoch = mutation.commandEpoch
      ?? this.intentCoordinator.abortOperator(operatorId, mutation.reason);
    if (mutation.commandEpoch !== undefined
        && mutation.commandEpoch !== this.intentCoordinator.getCurrentEpoch(operatorId)) {
      logger.debug('Discarded stale operator frame mutation', {
        operatorId,
        mutation: mutation.kind,
        commandEpoch: mutation.commandEpoch,
        currentEpoch: this.intentCoordinator.getCurrentEpoch(operatorId),
      });
      return;
    }

    this.pendingTransmissions = this.pendingTransmissions.filter(
      (request) => request.operatorId !== operatorId,
    );

    const operator = this.operators.get(operatorId);
    const mode = this.getCurrentMode();
    const now = this.clockSource.now();
    const slotStartMs = Math.floor(now / mode.slotMs) * mode.slotMs;
    const isTransmitCycle = !!operator && CycleUtils.isOperatorTransmitCycleFromMs(
      operator.getTransmitCycles(),
      slotStartMs,
      mode.slotMs,
    );
    const transmissions = operator?.isTransmitting
      ? this._pluginManager?.getCurrentTransmissions(operatorId) ?? []
      : [];

    if (!operator?.isTransmitting || !isTransmitCycle || transmissions.length === 0) {
      const outcome = this.requestStrategyStop(operatorId, mutation.reason);
      logger.debug('Operator frame mutation removed or deferred its current contribution', {
        operatorId,
        mutation: mutation.kind,
        outcome,
        isTransmitting: operator?.isTransmitting ?? false,
        isTransmitCycle,
        hasTransmission: transmissions.length > 0,
      });
      return;
    }

    const slotId = `slot-${slotStartMs}`;
    const currentFrame = this.digitalFrameCoordinator.getCurrentFrameForSlot(slotId);
    const source: TransmitRequest['source'] = mutation.source === 'late-decode'
      ? 'late-decode'
      : mutation.source === 'plugin' || mutation.source === 'slot-auto'
        ? 'plugin'
        : 'operator-edit';
    this.checkAndTriggerTransmission(operatorId, {
      replaceExisting: Boolean(currentFrame),
      source,
      reason: mutation.reason,
      decisionEpoch,
    });
  }

  /**
   * 检查并触发单个操作员的发射
   * 用于在时隙中间启动或切换发射周期时立即触发
   */
  private checkAndTriggerTransmission(operatorId: string, options?: {
    replaceExisting?: boolean;
    source?: TransmitRequest['source'];
    reason?: string;
    decisionEpoch?: number;
  }): void {
    if (this.transmissionMaintenanceReason) return;
    const operator = this.operators.get(operatorId);
    if (!operator || !operator.isTransmitting) {
      return;
    }

    const currentMode = this.getCurrentMode();
    const now = this.clockSource.now();
    const slotMs = currentMode.slotMs;
    const currentSlotStartMs = Math.floor(now / slotMs) * slotMs;
    const timeSinceSlotStartMs = now - currentSlotStartMs;

    const isTransmitCycle = CycleUtils.isOperatorTransmitCycleFromMs(
      operator.getTransmitCycles(),
      currentSlotStartMs,
      slotMs
    );

    if (!isTransmitCycle) {
      logger.debug(`Operator ${operatorId} is not in a transmit cycle`);
      return;
    }

    const transmissions = this._pluginManager?.getCurrentTransmissions(operatorId) ?? [];
    if (transmissions.length === 0) {
      logger.debug(`Operator ${operatorId} has no transmission content`);
      return;
    }
    
    logger.debug(`Mid-slot transmission triggered: operator=${operatorId}, elapsed=${timeSinceSlotStartMs}ms`);

    // 将发射请求加入队列（仅入队，交由统一的队列消费层处理）
    const currentFrame = this.digitalFrameCoordinator.getCurrentFrameForSlot(`slot-${currentSlotStartMs}`);
    const request: TransmitBatchRequest = {
      operatorId,
      transmissions: transmissions.map((item) => ({
        streamId: item.streamId,
        transmission: item.text,
        audioFrequencyHz: item.audioFrequencyHz,
      })),
      // Any new intent inside an already prepared/physical frame must rebuild
      // the complete mixed frame. Otherwise a double-click or a mid-slot TX
      // toggle would silently drop the other participants from the waveform.
      replaceExisting: options?.replaceExisting ?? !!currentFrame,
      source: options?.source
        ?? (options?.replaceExisting ? 'late-decode' : (currentFrame ? 'operator-edit' : undefined)),
      reason: options?.reason
        ?? (options?.replaceExisting
          ? 'replace existing frame'
          : (currentFrame ? 'complete mixed-frame rebuild after operator edit' : undefined)),
      decisionEpoch: options?.decisionEpoch
        ?? this.intentCoordinator.getCurrentEpoch(operatorId),
    };
    this.pendingTransmissions = this.pendingTransmissions.filter((candidate) => candidate.operatorId !== operatorId);
    for (const transmission of request.transmissions) {
      this.pendingTransmissions.push({
        operatorId,
        streamId: transmission.streamId,
        transmission: transmission.transmission,
        audioFrequencyHz: transmission.audioFrequencyHz,
        replaceExisting: request.replaceExisting,
        source: request.source,
        reason: request.reason,
        decisionEpoch: request.decisionEpoch,
        completeOperatorSet: true,
      });
    }

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

    if (elapsed > this.getRedecideDeadlineMs()) return;

    // 校验 slotPack 必须属于「上一 RX 槽」。防御式挡住任何把当前 TX 槽或更早
    // 的 slotPack 传进来的调用（如 addTransmissionFrame 的 slotPackUpdated 漏
    // 到这条路径）——这类 slotPack 缺失上一 RX 槽的 context，会让 standard-qso
    // 误判「无新 directCall → 清理 QSO 上下文」。
    const prevRxSlotStartMs = currentSlotStartMs - slotMs;
    if (slotPack.startMs !== prevRxSlotStartMs) {
      logger.debug(
        `reDecideOnLateDecodes rejecting slotPack from wrong slot: got=${slotPack.startMs} expected=${prevRxSlotStartMs} currentSlot=${currentSlotStartMs}`,
      );
      return;
    }

    // 立即执行重决策；operator command epoch 会丢弃晚到的旧决策结果。
    this.executeReDecision(slotPack);
  }

  /**
   * 当 DecisionOrchestrator 检测到 slotStart/encodeStart 竞态导致的过时编码时调用。
   * 使用 replaceExisting=true 替换当前时隙中已排队的编码。
   */
  triggerPostDecisionReEncode(
    operatorId: string,
    options?: { source?: TransmitRequest['source']; reason?: string; decisionEpoch?: number },
  ): void {
    logger.info(`Post-decision re-encode triggered: operator=${operatorId}`);
    this.checkAndTriggerTransmission(operatorId, {
      replaceExisting: true,
      source: options?.source,
      reason: options?.reason,
      decisionEpoch: options?.decisionEpoch,
    });
  }

  resetPluginRuntime(operatorId: string, reason: string): void {
    this.pendingTransmissions = this.pendingTransmissions.filter(
      (request) => request.operatorId !== operatorId,
    );
    this.clearSameTransmissionGuard(operatorId);
    this.lastEmittedStatusHash.delete(operatorId);
    logger.info(`Operator plugin runtime reset: operator=${operatorId}, reason=${reason}`);
    this.emitOperatorStatusUpdate(operatorId);
  }

  requestStrategyStop(operatorId: string, reason: string): 'cancelled' | 'deferred' | 'not-found' {
    const currentFrame = this.digitalFrameCoordinator.getCurrentFrameForOperator(operatorId);
    const remainingIntents = currentFrame
      ? this.digitalFrameCoordinator.getIntentRequests(currentFrame.frameId)
        .filter((intent) => intent.operatorId !== operatorId)
      : [];
    const outcome = this.digitalFrameCoordinator.requestStrategyStop(operatorId, reason);

    if (outcome === 'cancelled' && remainingIntents.length > 0) {
      for (const intent of remainingIntents) {
        if (!intent.text || !this.operators.get(intent.operatorId)?.isTransmitting) continue;
        this.pendingTransmissions.push({
          operatorId: intent.operatorId,
          streamId: normalizeStreamId(intent.streamId),
          transmission: intent.text,
          audioFrequencyHz: intent.audioFrequencyHz,
          replaceExisting: true,
          source: intent.source === 'persistence' || intent.source === 'device'
            ? 'plugin'
            : intent.source,
          reason: `mixed-frame rebuild after ${reason}`,
          decisionEpoch: intent.decisionEpoch,
        });
      }
      if (this.pendingTransmissions.length > 0) {
        const mode = this.getCurrentMode();
        const now = this.clockSource.now();
        const slotStartMs = Math.floor(now / mode.slotMs) * mode.slotMs;
        this.processPendingTransmissions({ id: `slot-${slotStartMs}`, startMs: slotStartMs });
      }
    }
    return outcome;
  }

  notifyPhysicalTransmissionsComplete(
    operatorId: string,
    receipts: import('@tx5dr/plugin-api').StreamPhysicalReceipt[],
  ): void {
    this._pluginManager?.notifyTransmissionsCompleted?.(operatorId, receipts);
  }

  notifyPhysicalTransmissionComplete(operatorId: string, transmission: string): void {
    this._pluginManager?.notifyTransmissionQueued?.(operatorId, transmission);
  }

  deferPreparedFrameToNextSlot(frameId: string, reason: string): boolean {
    const intents = this.digitalFrameCoordinator.getIntentRequests(frameId);
    const cancelled = this.digitalFrameCoordinator.deferFrame(frameId, reason);
    if (cancelled?.phase !== 'cancelled' || intents.length === 0) return false;
    this.requeueForNextSlot(intents.flatMap((intent) => {
      if (!intent.text) return [];
      return [{
        operatorId: intent.operatorId,
        streamId: normalizeStreamId(intent.streamId),
        transmission: intent.text,
        audioFrequencyHz: intent.audioFrequencyHz,
        replaceExisting: true,
        source: intent.source === 'persistence' || intent.source === 'device'
          ? 'plugin' as const
          : intent.source,
        reason,
        decisionEpoch: intent.decisionEpoch,
      }];
    }), reason);
    return true;
  }

  requeuePhysicalFrameAfterOutputFailure(frameId: string, reason: string): string[] {
    const requests = this.digitalFrameCoordinator.getIntentRequests(frameId).flatMap((intent) => {
      if (!intent.text) return [];
      const operator = this.operators.get(intent.operatorId);
      if (!operator?.isTransmitting) return [];
      if (intent.decisionEpoch !== this.intentCoordinator.getCurrentEpoch(intent.operatorId)) {
        logger.debug('Discarded stale physical retry intent', {
          frameId,
          operatorId: intent.operatorId,
          intentEpoch: intent.decisionEpoch,
          currentEpoch: this.intentCoordinator.getCurrentEpoch(intent.operatorId),
        });
        return [];
      }
      return [{
        operatorId: intent.operatorId,
        streamId: normalizeStreamId(intent.streamId),
        transmission: intent.text,
        audioFrequencyHz: intent.audioFrequencyHz,
        replaceExisting: true,
        source: intent.source === 'persistence' || intent.source === 'device'
          ? 'plugin' as const
          : intent.source,
        reason,
        decisionEpoch: intent.decisionEpoch,
      }];
    });
    this.requeueForNextSlot(requests, reason);
    return Array.from(new Set(requests.map((request) => request.operatorId)));
  }

  private requeueForNextSlot(requests: QueuedTransmitRequest[], reason: string): void {
    const byTrack = new Map(
      this.pendingTransmissions.map((request) => [buildTrackId(request.operatorId, request.streamId), request]),
    );
    for (const request of requests) {
      if (!this.operators.get(request.operatorId)?.isTransmitting) continue;
      const trackId = buildTrackId(request.operatorId, request.streamId);
      if (byTrack.has(trackId)) continue;
      byTrack.set(trackId, {
        ...request,
        replaceExisting: true,
        reason: `deferred to next slot: ${reason}`,
        waitForTransmitCycle: true,
      });
    }
    this.pendingTransmissions = Array.from(byTrack.values());
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

    if (now - currentSlotStartMs > this.getRedecideDeadlineMs()) return;

    for (const [operatorId, operator] of this.operators) {
      const canWakeStoppedOperator = !operator.isTransmitting
        && this._pluginManager?.shouldProcessStoppedOperatorReDecision(operatorId, slotPack) === true;
      if (!operator.isTransmitting && !canWakeStoppedOperator) continue;

      const isTransmitCycle = CycleUtils.isOperatorTransmitCycleFromMs(
        operator.getTransmitCycles(), currentSlotStartMs, slotMs
      );
      if (!isTransmitCycle && !canWakeStoppedOperator) continue;

      try {
        const changed = await this._pluginManager?.reDecideOperator(operatorId, slotPack);
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
   * 停止操作员发射
   */
  stopOperator(operatorId: string): void {
    const operator = this.operators.get(operatorId);
    if (!operator) {
      throw new Error(`operator ${operatorId} not found`);
    }
    
    const epoch = this.intentCoordinator.abortOperator(operatorId, 'operator stopped');
    this._pluginManager?.suspendQueueExecution?.(operatorId);
    this.pendingTransmissions = this.pendingTransmissions.filter((request) => request.operatorId !== operatorId);
    this.releaseTargetReservation(operatorId, epoch);
    this.requestStrategyStop(operatorId, 'operator stopped');
    this.clearSameTransmissionGuard(operatorId);
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
        const epoch = this.intentCoordinator.abortOperator(operatorId, 'all operators stopped');
        this._pluginManager?.suspendQueueExecution?.(operatorId);
        this.releaseTargetReservation(operatorId, epoch);
        this.requestStrategyStop(operatorId, 'all operators stopped');
        operator.stop();
        this.clearSameTransmissionGuard(operatorId);
        stoppedCount++;
        logger.info(`Stopped transmitting for operator ${operatorId} (radio disconnected)`);
        this.emitOperatorStatusUpdate(operatorId);
      }
    });
    
    if (stoppedCount > 0) {
      logger.info(`Stopped ${stoppedCount} operator(s) transmitting (radio disconnected)`);
    }
  }

  enterTransmissionMaintenance(reason: string): void {
    this.transmissionMaintenanceReason = reason;
    this.pendingTransmissions = [];
    for (const operatorId of this.operators.keys()) {
      this.intentCoordinator.abortOperator(operatorId, reason);
    }
    this.digitalFrameCoordinator.cancelAllPreCommitFrames(reason);
  }

  exitTransmissionMaintenance(): void {
    this.transmissionMaintenanceReason = null;
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
    const currentMode = this.getCurrentMode();

    // 检查每个操作员
    for (const [_operatorId, operator] of this.operators) {
      if (!operator.isTransmitting) {
        continue;
      }

      // 基于 slotInfo.startMs 的周期判断（避免 FT4 亚秒级截断）
      const isTransmitCycle = CycleUtils.isOperatorTransmitCycleFromMs(
        operator.getTransmitCycles(),
        slotInfo.startMs,
        currentMode.slotMs
      );

      if (isTransmitCycle) {
        return true; // 找到准备发射的操作员
      }
    }

    return false;
  }

  /**
   * Select a single conservative AP decode context for the slot being decoded.
   * Only TX3/TX4 active QSO states are enabled because other states can trigger
   * wide-band AP passes in WSJT-X and undo the decode performance win.
   */
  getDecodeApContext(slotInfo: SlotInfo, _windowIdx?: number): DecodeApContext | undefined {
    if (!this.isRunning || this.getCurrentMode().name !== 'FT8') {
      return undefined;
    }

    const currentMode = this.getCurrentMode();
    const candidates: DecodeApContext[] = [];

    for (const [operatorId, operator] of this.operators) {
      if (!operator.isTransmitting) {
        continue;
      }

      const isTransmitCycle = CycleUtils.isOperatorTransmitCycleFromMs(
        operator.getTransmitCycles(),
        slotInfo.startMs,
        currentMode.slotMs,
      );
      if (isTransmitCycle) {
        continue;
      }

      const runtimeState = this._pluginManager?.getOperatorRuntimeStatus(operatorId);
      const currentSlot = runtimeState?.currentSlot ?? 'TX6';
      const qsoProgress = AP_DECODE_QSO_PROGRESS[currentSlot];
      if (!qsoProgress) {
        continue;
      }

      const myCall = normalizeApCallsign(operator.config.myCallsign);
      const dxCall = normalizeApCallsign(String(runtimeState?.context?.targetCallsign ?? ''));
      if (!myCall || !dxCall) {
        continue;
      }

      const runtimeGrid = normalizeApGrid(String(runtimeState?.context?.targetGrid ?? ''));
      const trackerGrid = this.callsignTracker ? normalizeApGrid(this.callsignTracker.getGrid(dxCall) ?? '') : undefined;
      const myGrid = normalizeApGrid(operator.config.myGrid ?? '');

      candidates.push({
        operatorId,
        myCall,
        ...(myGrid ? { myGrid } : {}),
        dxCall,
        ...(runtimeGrid || trackerGrid ? { dxGrid: runtimeGrid ?? trackerGrid } : {}),
        frequencyHz: Number(operator.config.frequency || 0),
        qsoProgress,
        currentSlot,
      });
    }

    candidates.sort((a, b) =>
      b.qsoProgress - a.qsoProgress
      || a.operatorId.localeCompare(b.operatorId)
    );

    return candidates[0];
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
      this.targetReservations.releaseOperator(id);
      this.clearActiveQsoLifecycles(id);
      this.clearSameTransmissionGuard(id);
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

    // Runtime-created operators can be opened immediately after this method
    // returns. Wait until their callsign logbook is registered, while leaving
    // the full provider scan in the background.
    await this.logManager.getOrCreateLogBookByCallsign(config.myCallsign);
    
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
    await this.syncOperatorLogbookBinding(config.id, operatorConfig.myCallsign, config.logBookId);
    
    logger.info(`Operator config synced and updated: ${config.id}`);
    this.emitOperatorStatusUpdate(config.id);
  }

  private async syncOperatorLogbookBinding(
    operatorId: string,
    callsign: string,
    logBookId?: string,
  ): Promise<void> {
    this.logManager.registerOperatorCallsign(operatorId, callsign);
    this.logManager.prewarmLogBookByCallsign?.(callsign);

    if (logBookId) {
      try {
        await this.connectOperatorToLogBook(operatorId, logBookId);
      } catch (error) {
        logger.error(`Failed to connect operator ${operatorId} to logbook ${logBookId}:`, error);
      }
    }
  }

  /**
   * 将操作员发射周期持久化到配置文件
   * 当通过 WS 命令 setOperatorTransmitCycles 修改时，需要同步到配置文件，
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
    for (const [operatorId, operator] of this.operators) {
      operator.stop();
      this.clearSameTransmissionGuard(operatorId);
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
    this.targetReservations.clear();
    this.activeQsoLifecycles.clear();
    this.pendingTransmissions = [];
    this.sameTransmissionGuardStates.clear();
    this.operatorTransmissionSetGuardStates.clear();

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
   * 获取当前开启发射的操作员数量
   * 用于虚拟频差模式的多op发射检测
   */
  getTransmittingOperatorCount(): number {
    let count = 0;
    for (const operator of this.operators.values()) {
      if (operator.isTransmitting) {
        count++;
      }
    }
    return count;
  }

  /**
   * 获取虚拟频差是否实际生效
   * 用于广播给前端显示开关状态
   */
  isFakeFrequencyEffective(): boolean {
    return this.getFakeFrequencyEnabled?.() ?? false;
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
   * - strategy.name, strategy.state（策略模式和状态）
   * - runtime（完整插件运行时投影）
   * - slots（时隙内容）
   * - transmitCycles（发射周期）
   *
   * 排除字段：
   * - id（标识符，非状态）
   * - strategy.availableSlots（基本不变）
   */
  private hashOperatorStatus(status: any): string {
    // 提取关键字段进行哈希
    const keyFields = {
      isActive: status.isActive,
      isTransmitting: status.isTransmitting,
      isInActivePTT: status.isInActivePTT,
      hasTransmitIntent: status.hasTransmitIntent,
      currentSlot: status.currentSlot,
      context: status.context,
      strategyName: status.strategy?.name,
      strategyState: status.strategy?.state,
      runtime: status.runtime,
      currentTransmissions: status.currentTransmissions,
      slots: status.slots,
      transmitCycles: status.transmitCycles,
    };

    // 使用 JSON 序列化作为哈希（简单有效）
    return JSON.stringify(keyFields);
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

    if (this.targetReservations.isReservedByOther(normalizedMyCall, normalizedTarget, currentOperatorId)) {
      return true;
    }

    for (const [operatorId, operator] of this.operators.entries()) {
      // 跳过自己
      if (operatorId === currentOperatorId) continue;
      if (!operator.isTransmitting) continue;

      // 只检查同呼号的操作者
      if (operator.config.myCallsign.toUpperCase() !== normalizedMyCall) continue;

      const runtimeState = this._pluginManager?.getOperatorRuntimeStatus(operatorId);
      const strategyContext = runtimeState?.context;
      if (!strategyContext) continue;

      // 检查是否正在通联目标呼号
      const currentTarget = String(strategyContext.targetCallsign ?? '');
      if (currentTarget && currentTarget.toUpperCase() === normalizedTarget) {
        // 检查是否在活跃的QSO状态或正在转换状态
        const currentState = runtimeState?.currentSlot;
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

  transitionTargetReservation(operatorId: string, epoch: number, targetCallsign?: string): boolean {
    const operator = this.operators.get(operatorId);
    if (!operator) return false;
    return this.targetReservations.tryTransition({
      stationCallsign: operator.config.myCallsign,
      targetCallsign,
      operatorId,
      epoch,
    });
  }

  transitionTargetReservations(
    operatorId: string,
    epoch: number,
    targets: Array<{ streamId: string; targetCallsign: string }>,
  ): boolean {
    const operator = this.operators.get(operatorId);
    if (!operator) return false;
    return this.targetReservations.tryReplaceOperatorTargets({
      stationCallsign: operator.config.myCallsign,
      targets,
      operatorId,
      epoch,
    });
  }

  releaseTargetReservation(operatorId: string, epoch?: number): void {
    this.targetReservations.releaseOperator(operatorId, epoch);
  }

  private async completeAutomaticQSORecord(operatorId: string, qsoRecord: QSORecord): Promise<QSORecord> {
    const myCallsign = (qsoRecord.myCallsign || this.logManager.getOperatorCallsign(operatorId) || '').toUpperCase();
    const targetCallsign = qsoRecord.callsign.toUpperCase();
    const slotMs = this.getSlotDurationForMode(qsoRecord.mode);
    const historyStartMs = Math.max(0, qsoRecord.startTime - slotMs);
    const historyEndMs = qsoRecord.endTime ?? qsoRecord.startTime;
    const historySlotPacks = await this.collectRelevantSlotPacks(historyStartMs, historyEndMs);

    const grid = qsoRecord.grid
      || this.callsignTracker?.getGrid(targetCallsign);

    const history = this.rebuildQSOMessageHistory(historySlotPacks, {
      operatorId,
      myCallsign,
      targetCallsign,
      startMs: historyStartMs,
      endMs: historyEndMs,
    });

    // Only a local on-air TX frame may refine reportSent. RX frames remain
    // decoder candidates; reportReceived comes from the strategy-accepted effect.
    let reportSent = preferSignalReport(history.reportSent, qsoRecord.reportSent);
    let reportReceived = qsoRecord.reportReceived;

    // Recover remaining gaps from CallsignContextTracker.
    // Do not use truthiness checks: "0" is a valid FT8 report.
    if (this.callsignTracker && myCallsign) {
      if (isMissingSignalReport(reportSent)) {
        const sent = this.callsignTracker.getReport(myCallsign, targetCallsign);
        if (sent !== undefined) {
          reportSent = sent.toString();
        }
      }
      if (isMissingSignalReport(reportReceived)) {
        const received = this.callsignTracker.getReport(targetCallsign, myCallsign);
        if (received !== undefined) {
          reportReceived = received.toString();
        }
      }
    }

    const completedRecord = {
      ...qsoRecord,
      callsign: targetCallsign,
      myCallsign: myCallsign || qsoRecord.myCallsign,
      grid,
      reportSent: preferSignalReport(reportSent, qsoRecord.reportSent),
      reportReceived: preferSignalReport(reportReceived, qsoRecord.reportReceived),
      messageHistory: history.messages,
    };
    return {
      ...completedRecord,
      comment: resolveQsoComment(completedRecord),
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

  private rebuildQSOMessageHistory(
    slotPacks: SlotPack[],
    options: { operatorId: string; myCallsign: string; targetCallsign: string; startMs: number; endMs: number }
  ): { messages: string[]; reportSent?: string } {
    const messages: string[] = [];
    let reportSent: string | undefined;

    for (const slotPack of slotPacks) {
      if (slotPack.startMs > options.endMs || slotPack.endMs < options.startMs) {
        continue;
      }

      for (const frame of slotPack.frames) {
        if (!this.isFrameRelatedToQSO(frame, options)) {
          continue;
        }
        messages.push(frame.message);
        if (frame.snr === -999 && frame.operatorId === options.operatorId) {
          reportSent = this.extractTransmittedReport(
            frame.message,
            options.myCallsign,
            options.targetCallsign,
          ) ?? reportSent;
        }
      }
    }

    return { messages, reportSent };
  }

  private extractTransmittedReport(
    message: string,
    myCallsign: string,
    targetCallsign: string,
  ): string | undefined {
    const me = myCallsign.toUpperCase();
    const them = targetCallsign.toUpperCase();

    try {
      const parsed = FT8MessageParser.parseMessage(message);
      if (parsed.type !== 'signal_report' && parsed.type !== 'roger_report') {
        return undefined;
      }
      if (typeof parsed.report !== 'number' || !Number.isFinite(parsed.report)) {
        return undefined;
      }
      const sender = parsed.senderCallsign?.toUpperCase();
      const target = parsed.targetCallsign?.toUpperCase();
      if (sender !== me || target !== them) return undefined;
      return FT8MessageParser.generateSignalReport(parsed.report);
    } catch (error) {
      logger.warn(`Failed to parse local TX frame while extracting its QSO report: "${message}"`, error);
      return undefined;
    }
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

  private async addDistinctQSO(
    provider: ILogProvider,
    qsoRecord: QSORecord,
    operatorId: string,
  ): Promise<QSORecord> {
    for (let replanCount = 0; ; replanCount += 1) {
      const snapshot = await provider.readQsoSnapshot();
      try {
        const result = await provider.applyQsoBatch(
          [{ type: 'add', record: qsoRecord }],
          { expectedRevision: snapshot.revision },
          operatorId,
        );
        const outcome = result.outcomes.find((candidate) => candidate.inputIndex === 0);
        if (!outcome || outcome.status !== 'added') {
          throw new Error('Distinct QSO batch completed without an added record outcome');
        }
        return outcome.record;
      } catch (error) {
        if (!isLogbookRevisionConflict(error) || replanCount >= DISTINCT_QSO_BATCH_MAX_REPLANS) {
          throw error;
        }
      }
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

    const messageHistory = incoming.messageHistory.length > 0 ? incoming.messageHistory : existing.messageHistory;
    const merged = {
      ...existing,
      ...incoming,
      id: existing.id,
      startTime: Math.min(existing.startTime, incoming.startTime),
      endTime: Math.max(existingEndTime, incomingEndTime),
      grid: incoming.grid || existing.grid,
      // "0" is a valid FT8 report; do not treat it as missing via ||.
      reportSent: preferSignalReport(incoming.reportSent, existing.reportSent),
      reportReceived: preferSignalReport(incoming.reportReceived, existing.reportReceived),
      messageHistory,
      lotwQslSent: existing.lotwQslSent,
      lotwQslReceived: existing.lotwQslReceived,
      lotwQslSentDate: existing.lotwQslSentDate,
      lotwQslReceivedDate: existing.lotwQslReceivedDate,
      qrzQslSent: existing.qrzQslSent,
      qrzQslReceived: existing.qrzQslReceived,
      qrzQslSentDate: existing.qrzQslSentDate,
      qrzQslReceivedDate: existing.qrzQslReceivedDate,
    };

    return {
      ...merged,
      comment: resolveQsoComment(merged),
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
  public async triggerAutoSync(qsoRecord: QSORecord, callsign: string, _operatorId: string): Promise<void> {
    return this.handleAutoSync(qsoRecord, callsign);
  }

  /**
   * 自动上传 QSO 到已启用的同步服务（全部通过插件系统 LogbookSyncHost）
   */
  private async handleAutoSync(qsoRecord: QSORecord, callsign: string): Promise<void> {
    // All sync providers are plugin-based — delegate to LogbookSyncHost
    this._pluginManager?.logbookSyncHost.onQSOComplete(callsign, qsoRecord);
  }
}
