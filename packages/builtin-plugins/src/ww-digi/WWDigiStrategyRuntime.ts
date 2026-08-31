import { randomUUID } from 'node:crypto';
import type {
  AssistedQueueDisplayState,
  AssistedQueueSnapshot,
  FrameMessage,
  ParsedFT8Message,
  PluginLogger,
  QueuedStrategyMutationResult,
  QueuedStrategyObservationMeta,
  QueuedStrategyRuntime,
  QueuedStrategyTargetRequest,
  StrategyDecisionMetaV2,
  StrategyDecisionResult,
  StrategyQSOCompletionEffect,
  StrategyQSOCompletionSettlement,
  StrategyRuntimeCheckpoint,
  StrategyRuntimeContext,
  StrategyRuntimeSlot,
  StrategyRuntimeSlotContentUpdate,
  StrategyRuntimeSnapshot,
  StrategyStreamStateUpdate,
  StrategyActionInvocation,
  StrategyActionResult,
  StrategyAttention,
  StrategyMessagePresentationProjection,
  StrategyOperatorTransmitCyclesChanged,
  StrategyTransmitGate,
  StreamPhysicalReceipt,
} from '@tx5dr/plugin-api';
import { normalizeCallsign } from '@tx5dr/plugin-api';
import {
  FT8MessageParser,
  CycleUtils,
  calculateGridDistance,
  isValidCallsign,
  isUndecodedCallsignPlaceholder,
} from '@tx5dr/core';
import { ParallelQSOCoordinator } from '@tx5dr/plugin-api/toolkit';
import type { ParallelQueueMutationResult } from '@tx5dr/plugin-api/toolkit';
import { AuthorizationLease, BoundedCallSessionController } from '@tx5dr/plugin-api/toolkit';
import { buildWWDigiCQ, buildWWDigiRogerGrid, parseWWDigiMessage } from './protocol.js';
import {
  WWDigiProtocolLane,
  type WWDigiEntryData,
  type WWDigiLaneConfig,
} from './WWDigiProtocolLane.js';
import {
  buildWWDigiCompletionEffect,
  initializeWWDigiProtocolContext,
  isWWDigiProtocolContext,
  reduceWWDigiInbound,
  type WWDigiProtocolContext,
} from './WWDigiProtocolContext.js';

const MIN_PROTOCOL_CONTEXT_RECEIVE_CYCLES = 12;

export interface WWDigiRuntimeConfig extends WWDigiLaneConfig {
  frequency: number;
  transmitCycles: number[];
  parallelStreams: number;
  maxConcurrentStreams: number;
  cqMaxAttempts?: number;
  cqSelectionPolicy?: 'FIRST' | 'MAX_DISTANCE' | 'MAX_SNR' | 'MIN_SNR';
  authorizedStaleReceiveCycles?: number;
  replaceQueueOnManualTarget?: boolean;
}

export interface WWDigiRuntimeOperator {
  readonly config: WWDigiRuntimeConfig;
  readonly isTransmitting: boolean;
  isTargetBeingWorkedByOthers(callsign: string): boolean;
  hasWorkedCallsign(callsign: string): Promise<boolean>;
}

export interface WWDigiPracticeOperatingIndex {
  revision: number;
  contestYear: number;
  callsign: string;
  workedByBand: Record<string, string[]>;
  workedFieldsByBand: Record<string, string[]>;
}

type WWDigiSnapshotExtension = {
  actions?: StrategyRuntimeSnapshot['actions'];
  attentions?: StrategyRuntimeSnapshot['attentions'];
  messagePresentation?: StrategyMessagePresentationProjection;
  transmitGate?: StrategyTransmitGate;
};

interface RuntimeCheckpoint {
  coordinator: ReturnType<ParallelQSOCoordinator<WWDigiEntryData>['checkpoint']>;
  callSession: ReturnType<BoundedCallSessionController['checkpoint']>;
  receiveEpoch: number;
  lastObservedReceiveSlotStartMs?: number;
  previousTransmitting: boolean;
  startPurpose?: 'authorized-work' | 'recovery-work';
  exhaustedAtReceiveEpoch?: number;
  stopAttention?: StrategyAttention;
  completionAttention?: StrategyAttention;
  pendingManualCycleAuthorization?: { transmitCycle: 0 | 1; authorizationId: string };
  allowQueuedCycleSelection: boolean;
  practiceEnabled?: boolean;
  practiceSessionDestroyPending?: boolean;
  practiceOperatingIndex?: WWDigiPracticeOperatingIndex;
  detachedCompletions?: Array<[string, DetachedCompletion]>;
  detachedCompletionEpoch?: number;
  detachedProtocolContexts?: Array<[string, DetachedProtocolContext]>;
}

interface DetachedCompletion {
  callsign: string;
  entryId?: string;
  effect: StrategyQSOCompletionEffect;
  emitted: boolean;
  settled?: 'committed' | 'failed';
}

interface DetachedProtocolContext {
  context: WWDigiProtocolContext;
  expiresAtReceiveEpoch: number;
}

function targetKey(callsign: string): string {
  const upper = callsign.trim().toUpperCase();
  return normalizeCallsign(upper) || upper;
}

function selectedSender(raw: string): { callsign?: string; grid?: string } {
  const parsed = parseWWDigiMessage(raw);
  if (parsed.type === 'unknown') {
    const standard = FT8MessageParser.parseMessage(raw) as {
      senderCallsign?: string;
      grid?: string;
    };
    return {
      callsign: standard.senderCallsign,
      grid: standard.grid,
    };
  }
  return {
    callsign: parsed.senderCallsign,
    grid: 'grid' in parsed ? parsed.grid : undefined,
  };
}

export class WWDigiStrategyRuntime implements QueuedStrategyRuntime {
  private readonly coordinator: ParallelQSOCoordinator<WWDigiEntryData>;
  private readonly lanesByStreamId = new Map<string, WWDigiProtocolLane>();
  private readonly callSession = new BoundedCallSessionController();
  private receiveEpoch = 0;
  private lastObservedReceiveSlotStartMs?: number;
  private previousTransmitting = false;
  private startPurpose?: 'authorized-work' | 'recovery-work';
  private exhaustedAtReceiveEpoch?: number;
  private stopAttention?: StrategyAttention;
  private completionAttention?: StrategyAttention;
  private pendingManualCycleAuthorization?: { transmitCycle: 0 | 1; authorizationId: string };
  private allowQueuedCycleSelection = false;
  private practiceEnabled = false;
  private practiceSessionDestroyPending = false;
  private practiceOperatingIndex?: WWDigiPracticeOperatingIndex;
  private readonly detachedCompletions = new Map<string, DetachedCompletion>();
  private detachedCompletionEpoch = 0;
  private readonly detachedProtocolContexts = new Map<string, DetachedProtocolContext>();

  constructor(
    private readonly operator: WWDigiRuntimeOperator,
    logger: PluginLogger,
    audioFrequenciesHz: readonly number[] | (() => readonly number[]),
    private readonly preflightMessage: (
      text: string,
      mode: 'FT8' | 'FT4',
    ) => Promise<{ encodable: boolean; error?: string; reason?: string }> = async () => ({ encodable: true }),
    private readonly snapshotExtension: () => WWDigiSnapshotExtension = () => ({}),
    private readonly completionDestination: () => StrategyQSOCompletionEffect['destination'] = () => undefined,
    private readonly practice?: {
      canStart: () => boolean;
      sessionKey: string;
      title: string;
    },
  ) {
    const resolveFrequencies = typeof audioFrequenciesHz === 'function'
      ? audioFrequenciesHz
      : () => audioFrequenciesHz;
    if (resolveFrequencies().length !== 3) throw new Error('WW Digi requires exactly three lane frequencies');
    this.previousTransmitting = operator.isTransmitting;
    this.coordinator = new ParallelQSOCoordinator<WWDigiEntryData>({
      maxSupportedStreams: 3,
      initialMaxStreams: this.parallelStreams(),
      entryIdPrefix: 'ww-digi',
      createLane: ({ streamId, laneIndex }) => {
        const lane = new WWDigiProtocolLane(
          streamId,
          () => {
            const frequencies = resolveFrequencies();
            if (frequencies.length !== 3 || !Number.isFinite(frequencies[laneIndex])) {
              throw new Error('WW Digi lane frequencies became invalid');
            }
            return frequencies[laneIndex]!;
          },
          () => this.operator.config,
          logger,
        );
        this.lanesByStreamId.set(streamId, lane);
        return lane;
      },
    });
  }

  checkpoint(): StrategyRuntimeCheckpoint {
    return {
      coordinator: this.coordinator.checkpoint(),
      callSession: this.callSession.checkpoint(),
      receiveEpoch: this.receiveEpoch,
      lastObservedReceiveSlotStartMs: this.lastObservedReceiveSlotStartMs,
      previousTransmitting: this.previousTransmitting,
      startPurpose: this.startPurpose,
      exhaustedAtReceiveEpoch: this.exhaustedAtReceiveEpoch,
      stopAttention: this.stopAttention,
      completionAttention: this.completionAttention,
      pendingManualCycleAuthorization: this.pendingManualCycleAuthorization,
      allowQueuedCycleSelection: this.allowQueuedCycleSelection,
      practiceEnabled: this.practiceEnabled,
      practiceSessionDestroyPending: this.practiceSessionDestroyPending,
      practiceOperatingIndex: this.practiceOperatingIndex,
      detachedCompletions: Array.from(this.detachedCompletions.entries()),
      detachedCompletionEpoch: this.detachedCompletionEpoch,
      detachedProtocolContexts: Array.from(this.detachedProtocolContexts.entries()),
    } satisfies RuntimeCheckpoint;
  }

  restore(checkpoint: StrategyRuntimeCheckpoint): void {
    const state = checkpoint as RuntimeCheckpoint;
    if (!state?.coordinator) throw new Error('Invalid WW Digi runtime checkpoint');
    this.coordinator.restore(state.coordinator);
    if (state.callSession) this.callSession.restore(state.callSession);
    this.receiveEpoch = state.receiveEpoch ?? 0;
    this.lastObservedReceiveSlotStartMs = state.lastObservedReceiveSlotStartMs;
    this.previousTransmitting = state.previousTransmitting === true;
    this.startPurpose = state.startPurpose;
    this.exhaustedAtReceiveEpoch = state.exhaustedAtReceiveEpoch;
    this.stopAttention = state.stopAttention;
    this.completionAttention = state.completionAttention;
    this.pendingManualCycleAuthorization = state.pendingManualCycleAuthorization;
    this.allowQueuedCycleSelection = state.allowQueuedCycleSelection === true;
    this.practiceEnabled = state.practiceEnabled === true;
    this.practiceSessionDestroyPending = state.practiceSessionDestroyPending === true;
    this.practiceOperatingIndex = state.practiceOperatingIndex
      ? structuredClone(state.practiceOperatingIndex)
      : undefined;
    this.detachedCompletions.clear();
    for (const [recordId, completion] of state.detachedCompletions ?? []) {
      this.detachedCompletions.set(recordId, structuredClone(completion));
    }
    this.detachedCompletionEpoch = state.detachedCompletionEpoch ?? 0;
    this.detachedProtocolContexts.clear();
    for (const [key, detached] of state.detachedProtocolContexts ?? []) {
      this.detachedProtocolContexts.set(key, structuredClone(detached));
    }
  }

  observeDecodedMessages(messages: ParsedFT8Message[], meta: QueuedStrategyObservationMeta): boolean {
    if (!this.operator.isTransmitting) this.previousTransmitting = false;
    let changed = false;
    const observedCycle = CycleUtils.isEvenCycle(meta.slotInfo.cycleNumber) ? 0 : 1;
    const isReceiveSlot = !this.operator.config.transmitCycles.includes(observedCycle);
    if (isReceiveSlot && (this.lastObservedReceiveSlotStartMs === undefined
        || meta.slotInfo.startMs > this.lastObservedReceiveSlotStartMs)) {
      this.lastObservedReceiveSlotStartMs = meta.slotInfo.startMs;
      this.receiveEpoch += 1;
      changed = this.expireProtocolContexts() || changed;
      changed = this.expireAuthorizations() || changed;
    }
    let resumeSelectedCycle = false;
    for (const message of messages) {
      if (message.isPartialDecode) continue;
      const sender = selectedSender(message.rawMessage);
      if (!sender.callsign) continue;
      const callsign = sender.callsign.trim().toUpperCase();
      changed = this.observeDetachedProtocolContext(callsign, message) || changed;
      const parsed = parseWWDigiMessage(message.rawMessage);
      let entry = this.coordinator.findEntryByTargetKey(targetKey(callsign));
      const lastHeardCycle = CycleUtils.isEvenCycle(meta.slotInfo.cycleNumber) ? 0 : 1;
      const isDirectedGridReply = parsed.type === 'grid'
        && targetKey(parsed.targetCallsign) === targetKey(this.operator.config.myCallsign)
        && targetKey(parsed.senderCallsign) === targetKey(callsign);
      if (!entry && this.callSession.isArmed && isDirectedGridReply
          && this.isPermissiveTarget(callsign)
          && !this.operator.isTargetBeingWorkedByOthers(callsign)
          && this.callSession.beginCollecting(meta.slotInfo.id)) {
        const result = this.coordinator.enqueue({
          targetKey: targetKey(callsign),
          callsign,
          requestedTransmitCycle: (1 - lastHeardCycle) as 0 | 1,
          data: {
            status: 'candidate',
            source: 'cq',
            lastMessageRaw: message.rawMessage,
            lastSnr: message.snr,
            targetGrid: sender.grid,
            firstHeardAt: message.timestamp,
            firstAudioFrequencyHz: message.df,
            lastHeardReceiveEpoch: this.receiveEpoch,
            lastHeardCycle,
            evidenceRevision: 1,
            protocolContext: initializeWWDigiProtocolContext({
              callsign,
              audioFrequencyHz: message.df,
              now: message.timestamp,
              lastMessageRaw: message.rawMessage,
              lastMessageAt: message.timestamp,
              targetGrid: sender.grid,
              lastSnr: message.snr,
            }, this.operator.config),
          },
        });
        if (result.outcome !== 'rejected') {
          entry = result.entry ?? this.coordinator.findEntryByTargetKey(targetKey(callsign));
          changed = true;
        }
      }
      if (!entry) continue;
      const targetCallsign = 'targetCallsign' in parsed ? parsed.targetCallsign : undefined;
      const activeEntryIds = this.coordinator.getQueueSnapshot().activeEntryIds;
      const isActive = activeEntryIds.includes(entry.entryId);
      const requestedTransmitCycle = (1 - lastHeardCycle) as 0 | 1;
      if (!isActive) {
        this.coordinator.setRequestedTransmitCycle(entry.entryId, requestedTransmitCycle);
      }
      if (!activeEntryIds.includes(entry.entryId)
          && (entry.data.status === 'authorized'
            || entry.data.status === 'cycle-paused'
            || entry.data.status === 'no-response') && targetCallsign
          && targetKey(targetCallsign) !== targetKey(this.operator.config.myCallsign)) {
        if (this.coordinator.updateEntry(entry.entryId, (data) => {
          data.status = 'paused';
          data.authorizationId = undefined;
          data.authorizedAt = undefined;
          data.authorizedReceiveEpoch = undefined;
          data.cycleResume = undefined;
          return true;
        })) changed = true;
      }
      if (!isActive && isWWDigiProtocolContext(entry.data.protocolContext)) {
        const reduced = reduceWWDigiInbound(
          entry.data.protocolContext,
          message,
          this.operator.config,
        );
        if (reduced.changed) {
          const canComplete = entry.data.status !== 'candidate' && entry.data.status !== 'dupe';
          if (reduced.completed && canComplete) {
            const streamId = `recovered-${entry.targetKey}`;
            const effect = buildWWDigiCompletionEffect(reduced.context, {
              streamId,
              lifecycleEpoch: ++this.detachedCompletionEpoch,
              endTime: message.timestamp,
              authorizationId: entry.data.authorizationId,
              recoveredFinalAcknowledgement: true,
            }, this.operator.config);
            if (!this.detachedCompletions.has(effect.record.id)) {
              this.detachedCompletions.set(effect.record.id, {
                callsign: entry.callsign,
                entryId: entry.entryId,
                effect,
                emitted: false,
              });
            }
            this.coordinator.updateEntry(entry.entryId, (data) => {
              data.status = 'log-pending';
              data.protocolContext = undefined;
              data.protocolContextExpiresAtReceiveEpoch = undefined;
              return true;
            });
          } else {
            this.coordinator.updateEntry(entry.entryId, (data) => {
              data.protocolContext = structuredClone(reduced.context);
              data.protocolContextExpiresAtReceiveEpoch = this.protocolContextExpiryEpoch();
              data.targetGrid = reduced.context.targetGrid;
              if (data.status === 'no-response' && data.authorizationId) {
                data.status = 'authorized';
                data.authorizedAt = Date.now();
                data.authorizedReceiveEpoch = this.receiveEpoch;
                data.noResponseCycles = undefined;
              }
              return true;
            });
          }
          changed = true;
        }
      }
      let parkedMatchesSelectedCycle = false;
      if (this.coordinator.updateEntry(entry.entryId, (data) => {
        let updated = false;
        if (sender.grid && data.targetGrid !== sender.grid) {
          data.targetGrid = sender.grid;
          updated = true;
        }
        if (data.lastMessageRaw !== message.rawMessage) {
          data.lastMessageRaw = message.rawMessage;
          data.evidenceRevision = (data.evidenceRevision ?? 0) + 1;
          updated = true;
        }
        if (data.lastSnr !== message.snr) {
          data.lastSnr = message.snr;
          updated = true;
        }
        if (data.lastHeardReceiveEpoch !== this.receiveEpoch) {
          data.lastHeardReceiveEpoch = this.receiveEpoch;
          updated = true;
        }
        if (data.lastHeardCycle !== lastHeardCycle) {
          data.lastHeardCycle = lastHeardCycle;
          updated = true;
        }
        if (data.firstHeardAt === undefined) {
          data.firstHeardAt = message.timestamp;
          updated = true;
        }
        if (data.status === 'cycle-paused'
            && data.cycleResume) {
          if (data.cycleResume.transmitCycle !== requestedTransmitCycle) {
            data.cycleResume.transmitCycle = requestedTransmitCycle;
            updated = true;
          }
          const updatedCheckpoint = this.lanesByStreamId.get(data.cycleResume.streamId)
            ?.applyDecodedMessagesToCheckpoint(data.cycleResume.laneCheckpoint, [message]);
          if (updatedCheckpoint !== undefined) {
            data.cycleResume.laneCheckpoint = updatedCheckpoint;
            updated = true;
          }
          parkedMatchesSelectedCycle = requestedTransmitCycle
            === (this.operator.config.transmitCycles[0] === 1 ? 1 : 0);
        }
        return updated;
      })) changed = true;
      if (parkedMatchesSelectedCycle) resumeSelectedCycle = true;
    }
    if (resumeSelectedCycle) this.switchActiveCycle(this.operator.config.transmitCycles[0] === 1 ? 1 : 0);
    const observed = this.coordinator.observe(messages, meta);
    return observed || changed;
  }

  enqueueTarget(request: QueuedStrategyTargetRequest): QueuedStrategyMutationResult {
    const callsign = request.callsign.trim().toUpperCase();
    if (!this.isPermissiveTarget(callsign)) {
      return this.mutationResult({
        outcome: 'rejected', reason: 'invalid_target', version: this.coordinator.getQueueSnapshot().version, affectedStreamIds: [],
      });
    }
    let targetGrid: string | undefined;
    let lastMessageRaw: string | undefined;
    let requestedTransmitCycle: 0 | 1 | undefined;
    if (request.lastMessage) {
      const sender = selectedSender(request.lastMessage.message.message);
      if (sender.callsign && targetKey(sender.callsign) === targetKey(callsign)) {
        targetGrid = sender.grid;
        lastMessageRaw = request.lastMessage.message.message;
        requestedTransmitCycle = ((request.lastMessage.slotInfo.cycleNumber + 1) % 2) as 0 | 1;
      }
    }
    const requiresAlternate = !isValidCallsign(callsign) || callsign.includes('/');
    const input: Parameters<typeof this.coordinator.enqueue>[0] = {
      targetKey: targetKey(callsign),
      callsign,
      requestedTransmitCycle,
      data: {
        authorizationId: randomUUID(),
        authorizedAt: Date.now(),
        authorizedReceiveEpoch: this.receiveEpoch,
        lastHeardReceiveEpoch: this.receiveEpoch,
        lastHeardCycle: request.lastMessage
          ? (CycleUtils.isEvenCycle(request.lastMessage.slotInfo.cycleNumber) ? 0 : 1)
          : undefined,
        source: 'manual',
        evidenceRevision: 1,
        firstHeardAt: request.lastMessage?.slotInfo.startMs,
        lastMessageRaw,
        lastSnr: request.lastMessage?.message.snr,
        targetGrid,
        status: requiresAlternate ? 'review' : 'authorized',
        encodingError: requiresAlternate ? 'special_callsign_requires_preflight' : undefined,
        protocolContext: requiresAlternate ? undefined : initializeWWDigiProtocolContext({
          callsign,
          audioFrequencyHz: request.lastMessage?.message.freq ?? this.operator.config.frequency,
          now: request.lastMessage?.slotInfo.startMs ?? Date.now(),
          lastMessageRaw,
          lastMessageAt: request.lastMessage?.slotInfo.startMs,
          targetGrid,
          lastSnr: request.lastMessage?.message.snr,
        }, this.operator.config),
      },
    };
    if (this.operator.config.replaceQueueOnManualTarget !== true) {
      const result = this.coordinator.enqueue(input);
      if (result.outcome === 'accepted' && !this.operator.isTransmitting) {
        this.allowQueuedCycleSelection = true;
      }
      return this.mutationResult(result);
    }
    if (this.hasUnsettledCompletionWork()) {
      return this.mutationResult({
        outcome: 'rejected',
        reason: 'active_entry',
        version: this.coordinator.getQueueSnapshot().version,
        affectedStreamIds: [],
      });
    }
    const checkpoint = this.checkpoint();
    try {
      this.detachAndRemoveExecutableWork();
      const result = this.coordinator.enqueue(input);
      if (result.outcome !== 'accepted') {
        this.restore(checkpoint);
        return this.mutationResult(result);
      }
      this.callSession.reset();
      this.exhaustedAtReceiveEpoch = undefined;
      this.stopAttention = undefined;
      this.pendingManualCycleAuthorization = undefined;
      this.startPurpose = this.operator.isTransmitting ? undefined : 'authorized-work';
      this.allowQueuedCycleSelection = true;
      return { ...this.mutationResult(result), requestOperatorStart: true };
    } catch (error) {
      this.restore(checkpoint);
      throw error;
    }
  }

  reorderTarget(entryId: string, beforeEntryId: string | null, expectedVersion: number): QueuedStrategyMutationResult {
    return this.mutationResult(this.coordinator.reorder(entryId, beforeEntryId, expectedVersion));
  }

  retryTarget(entryId: string, expectedVersion: number): QueuedStrategyMutationResult {
    const snapshot = this.coordinator.getQueueSnapshot();
    if (snapshot.version !== expectedVersion) {
      return { outcome: 'rejected', reason: 'version_conflict', snapshot: this.getQueueSnapshot() };
    }
    const entry = this.coordinator.getEntry(entryId);
    if (!entry) return { outcome: 'rejected', reason: 'entry_not_found', snapshot: this.getQueueSnapshot() };
    if (entry.data.status !== 'no-response') {
      return { outcome: 'rejected', reason: 'entry_not_retryable', snapshot: this.getQueueSnapshot() };
    }
    this.coordinator.updateEntry(entryId, (data) => {
      data.status = 'authorized';
      data.authorizationId = randomUUID();
      data.authorizedAt = Date.now();
      data.authorizedReceiveEpoch = this.receiveEpoch;
      data.noResponseCycles = undefined;
      return true;
    });
    if (!this.operator.isTransmitting) this.allowQueuedCycleSelection = true;
    return { outcome: 'accepted', snapshot: this.getQueueSnapshot() };
  }

  removeTarget(entryId: string, expectedVersion: number): QueuedStrategyMutationResult {
    const result = this.coordinator.remove(entryId, expectedVersion);
    if (result.outcome === 'accepted' && this.coordinator.getQueueSnapshot().entries.length === 0) {
      this.allowQueuedCycleSelection = false;
    }
    return this.mutationResult(result);
  }

  clearTargets(expectedVersion: number): QueuedStrategyMutationResult {
    const result = this.coordinator.clear(expectedVersion);
    if (result.outcome === 'accepted') {
      this.allowQueuedCycleSelection = false;
      this.detachedProtocolContexts.clear();
    }
    return this.mutationResult(result);
  }

  getQueueSnapshot(): AssistedQueueSnapshot {
    this.syncParallelStreams();
    const snapshot = this.coordinator.getQueueSnapshot();
    const streamsById = new Map(this.coordinator.getStreams().map((stream) => [stream.streamId, stream]));
    return {
      version: snapshot.version,
      activeEntryId: snapshot.activeEntryIds[0],
      activeEntryIds: snapshot.activeEntryIds,
      maxActiveStreams: snapshot.maxActiveStreams,
      requestedMaxActiveStreams: this.requestedParallelStreams(),
      rows: snapshot.entries.map((row, order) => {
        const stream = row.streamId ? streamsById.get(row.streamId) : undefined;
        const status = row.entry.data.status;
        const parkedLogFailed = status === 'cycle-paused'
          && row.entry.data.cycleResume?.settlement === 'failed';
        const displayState: AssistedQueueDisplayState = status === 'candidate' ? 'candidate'
          : status === 'dupe' ? 'dupe'
          : status === 'authorized' && !row.active ? 'authorized'
          : status === 'log-pending' ? 'closing'
          : status === 'review' || parkedLogFailed || stream?.currentState === 'review' ? 'review'
          : status === 'stale' || status === 'paused' || status === 'cycle-paused' ? 'paused'
          : status === 'no-response' ? 'no-response'
            : stream?.currentState === 'closing' ? 'closing'
              : row.active ? 'engaged' : 'later';
        return {
          entryId: row.entry.entryId,
          callsign: row.entry.callsign,
          order,
          draggable: !row.active,
          displayState,
          tone: status === 'dupe' ? 'warning'
            : status === 'authorized' && !row.active ? 'success'
            : status === 'log-pending' ? 'active'
            : status === 'review' || parkedLogFailed || stream?.currentState === 'review' ? 'danger'
            : status === 'stale' || status === 'paused' ? 'warning'
            : status === 'cycle-paused' ? 'neutral'
            : status === 'no-response' ? 'warning'
              : row.active ? 'active' : 'neutral',
          icon: status === 'dupe' ? 'triangle-alert'
            : status === 'authorized' && !row.active ? 'check-circle'
            : status === 'log-pending' ? 'clock'
            : status === 'review' || parkedLogFailed || stream?.currentState === 'review' ? 'triangle-alert'
            : status === 'stale' || status === 'paused' || status === 'cycle-paused' ? 'pause'
            : status === 'no-response' ? 'clock'
              : row.active ? 'radio' : 'circle',
          targetGrid: row.entry.data.targetGrid,
          lastSnr: row.entry.data.lastSnr,
          lastHeardCyclesAgo: row.entry.data.lastHeardReceiveEpoch === undefined
            ? undefined
            : Math.max(0, this.receiveEpoch - row.entry.data.lastHeardReceiveEpoch),
          lastHeardCycle: row.entry.data.lastHeardCycle,
          streamId: row.streamId,
          audioFrequencyHz: row.audioFrequencyHz,
          authorizationId: row.entry.data.authorizationId,
          pauseReason: status === 'stale' ? 'stale' as const : undefined,
          noResponseCycles: row.entry.data.noResponseCycles,
          actions: row.active ? [] : this.queueActions(row.entry),
        };
      }),
    };
  }

  async decide(messages: ParsedFT8Message[], meta: StrategyDecisionMetaV2): Promise<StrategyDecisionResult> {
    this.syncParallelStreams();
    const detachedCompletions = this.takeDetachedCompletions();
    if (this.snapshotExtension().transmitGate) {
      this.previousTransmitting = false;
      return this.result({ qsoCompletions: detachedCompletions, stop: this.operator.isTransmitting });
    }
    if (!this.operator.isTransmitting) {
      this.previousTransmitting = false;
      return this.result({ qsoCompletions: detachedCompletions });
    }
    if (!this.previousTransmitting) {
      this.previousTransmitting = true;
      this.stopAttention = undefined;
      if (this.startPurpose !== undefined || this.hasQueueEntries()) {
        this.startPurpose = undefined;
        this.callSession.reset();
      } else {
        this.armCallSession();
      }
    }

    this.resumeCommittedParkedLanes();
    const decision = await this.coordinator.decide(messages, meta);
    const parkedCompletions = this.collectParkedCompletions();
    const protocolCompletions = [...decision.qsoCompletions, ...parkedCompletions];
    const completedTargetKeys = new Set(protocolCompletions.map((effect) => targetKey(effect.record.callsign)));
    this.discardDetachedDuplicates(completedTargetKeys);
    const releasedCompletionByStream = new Map(decision.qsoCompletions.flatMap((effect) => (
      effect.streamId ? [[effect.streamId, effect] as const] : []
    )));
    for (const released of decision.releasedEntries) {
      if (released.disposition !== 'retain-entry') continue;
      const completion = releasedCompletionByStream.get(released.streamId);
      if (completion) {
        this.detachedCompletions.set(completion.record.id, {
          callsign: completion.record.callsign,
          entryId: released.entryId,
          effect: structuredClone(completion),
          emitted: true,
        });
        this.coordinator.updateEntry(released.entryId, (data) => {
          data.status = 'log-pending';
          return true;
        });
        continue;
      }
      this.coordinator.updateEntry(released.entryId, (data) => {
        data.status = 'no-response';
        if (isWWDigiProtocolContext(data.protocolContext)) {
          data.protocolContextExpiresAtReceiveEpoch = this.protocolContextExpiryEpoch();
        }
        data.noResponseCycles = decision.qsoFailures
          .find((failure) => targetKey(failure.targetCallsign) === targetKey(
            this.coordinator.getEntry(released.entryId)?.callsign ?? '',
          ))?.unansweredTransmissions;
        return true;
      });
    }
    await this.classifyCandidateDupes();
    if (this.callSession.state === 'collecting' || this.callSession.state === 'batch-active') {
      await this.authorizeCollectedBatch();
    }
    await this.authorizePendingManualCycleBatch();

    if (this.callSession.state === 'calling'
        && this.exhaustedAtReceiveEpoch !== undefined
        && this.receiveEpoch > this.exhaustedAtReceiveEpoch) {
      this.callSession.finishNoResponse();
      this.stopAttention = {
        id: 'cq-no-response', tone: 'warning', title: 'attentionCqNoResponse',
        description: 'attentionCqNoResponseDesc',
        params: { count: this.callSession.successfulCalls },
        notify: true,
      };
      this.previousTransmitting = false;
      return this.result({ qsoCompletions: detachedCompletions, stop: true });
    }
    const configuredCycle = this.operator.config.transmitCycles[0] === 1 ? 1 : 0;
    const allowCycleSelection = this.allowQueuedCycleSelection;
    const fill = await this.coordinator.fillAvailableLanes({
      currentTransmitCycle: configuredCycle,
      isEligible: (entry) => entry.data.status === 'authorized'
        && (allowCycleSelection
          || entry.requestedTransmitCycle === undefined
          || entry.requestedTransmitCycle === configuredCycle)
        && !this.operator.isTargetBeingWorkedByOthers(entry.callsign),
    });
    if (fill.activatedEntryIds.length > 0) this.allowQueuedCycleSelection = false;
    const projected = this.result({
      qsoCompletions: [
        ...protocolCompletions,
        ...detachedCompletions.filter((effect) => !completedTargetKeys.has(targetKey(effect.record.callsign))),
      ],
      qsoFailures: decision.qsoFailures,
      requestedTransmitCycle: allowCycleSelection ? fill.requestedTransmitCycle : undefined,
    });
    if ((projected.transmissions?.length ?? 0) === 0 && this.shouldStopForIdle()) {
      const candidates = this.countCandidates();
      const invalid = this.countInvalidAuthorizations();
      const cyclePaused = this.countCyclePaused();
      this.stopAttention = candidates > 0
        ? {
            id: 'cq-candidates-awaiting-authorization', tone: 'info',
            title: 'attentionCandidatesAwaitingAuthorization',
            description: 'attentionCandidatesAwaitingAuthorizationDesc', params: { count: candidates },
            notify: true,
          }
        : invalid > 0 ? {
            id: 'cq-authorizations-invalid', tone: 'warning', title: 'attentionAuthorizationsInvalid',
            description: 'attentionAuthorizationsInvalidDesc', params: { count: invalid }, notify: true,
          } : cyclePaused > 0 ? {
            id: 'qso-other-cycle-paused', tone: 'info', title: 'attentionOtherCyclePaused',
            description: 'attentionOtherCyclePausedDesc', params: { count: cyclePaused }, notify: true,
          } : {
            id: 'cq-session-complete', tone: 'success', title: 'attentionSessionComplete',
            description: 'attentionSessionCompleteDesc',
            notify: true,
          };
      this.callSession.finish('authorized-work-drained');
      this.previousTransmitting = false;
      return { ...projected, stop: true, snapshot: this.getSnapshot() };
    }
    return projected;
  }

  getTransmitText(): string | null {
    return this.getTransmissions()[0]?.text ?? null;
  }

  getTransmissions() {
    this.syncParallelStreams();
    if (!this.operator.isTransmitting) {
      this.previousTransmitting = false;
      return [];
    }
    const transmissions = this.coordinator.getTransmissions();
    if (transmissions.length > 0) return transmissions;
    const queue = this.coordinator.getQueueSnapshot();
    const hasCqBlockingWork = this.coordinator.getQueueSnapshot().activeEntryIds.length > 0
      || queue.entries.some((row) => row.entry.data.status === 'authorized'
        || (row.entry.data.status === 'review' && !this.hasFailedDetachedCompletion(row.entry.entryId)));
    if (hasCqBlockingWork) return [];
    if (this.callSession.state !== 'calling') return [];
    return [{
      streamId: 'cq',
      text: buildWWDigiCQ(this.operator.config.myCallsign, this.operator.config.myGrid),
      audioFrequencyHz: this.operator.config.frequency,
    }];
  }

  requestCall(_callsign: string, _lastMessage?: { message: FrameMessage; slotInfo: import('@tx5dr/plugin-api').SlotInfo }): boolean {
    return false;
  }

  getSnapshot(): StrategyRuntimeSnapshot {
    this.syncParallelStreams();
    this.expireCompletionAttention();
    const streams = this.coordinator.getStreams();
    const primary = streams[0];
    const extension = this.snapshotExtension();
    return {
      currentState: streams.length > 0 ? 'parallel' : 'TX6',
      context: primary ? {
        targetCallsign: primary.targetCallsign,
        targetGrid: primary.targetGrid,
        actualFrequency: primary.audioFrequencyHz,
      } : undefined,
      availableSlots: ['TX6'],
      qsoLifecycleEpoch: primary?.qsoLifecycleEpoch,
      streams,
      queue: this.getQueueSnapshot(),
      actions: extension.actions,
      attentions: [
        ...(this.callSession.state === 'calling' ? [{
          id: 'cq-calling', tone: 'info' as const, title: 'attentionCqCalling',
          description: 'attentionCqCallingDesc',
          params: { current: this.callSession.successfulCalls, total: this.callSession.maxAttempts },
        }] : []),
        ...(this.callSession.state === 'collecting' ? [{
          id: 'cq-collecting', tone: 'info' as const, title: 'attentionCqCollecting',
          description: 'attentionCqCollectingDesc', params: { count: this.countCandidates() },
        }] : []),
        ...(this.countCyclePaused() > 0 ? [{
          id: 'qso-other-cycle-paused', tone: 'info' as const, title: 'attentionOtherCyclePaused',
          description: 'attentionOtherCyclePausedDesc', params: { count: this.countCyclePaused() },
        }] : []),
        ...(this.stopAttention ? [this.stopAttention] : []),
        ...(this.completionAttention ? [this.completionAttention] : []),
        ...(extension.attentions ?? []),
      ],
      messagePresentation: extension.messagePresentation,
      transmitGate: extension.transmitGate,
    };
  }

  patchContext(_patch: Partial<StrategyRuntimeContext>): void {}
  setState(_state: StrategyRuntimeSlot): void {}
  isPracticeEnabled(): boolean {
    if (this.practiceEnabled && this.practice?.canStart() !== true) this.revokePractice();
    return this.practiceEnabled;
  }
  getPracticeOperatingIndex(): WWDigiPracticeOperatingIndex | undefined {
    return this.practiceOperatingIndex ? structuredClone(this.practiceOperatingIndex) : undefined;
  }
  setPracticeOperatingIndex(index: WWDigiPracticeOperatingIndex): void {
    if (!this.practiceEnabled) return;
    this.practiceOperatingIndex = structuredClone(index);
  }
  revokePractice(): boolean {
    const changed = this.practiceEnabled;
    this.practiceEnabled = false;
    if (changed) {
      this.practiceSessionDestroyPending = true;
      this.practiceOperatingIndex = undefined;
    }
    return changed;
  }
  setStreamState(update: StrategyStreamStateUpdate): void {
    this.coordinator.setStreamState(update.streamId, update.stateId, update.expectedLifecycleEpoch);
  }
  async invokeAction(invocation: StrategyActionInvocation): Promise<StrategyActionResult | void> {
    if (invocation.target.kind === 'runtime') {
      if (invocation.actionId === 'start-practice' && this.practice) {
        if (!this.practice.canStart()) throw new Error('practice_not_available');
        this.practiceEnabled = true;
        this.practiceSessionDestroyPending = false;
        this.practiceOperatingIndex = {
          revision: 0,
          contestYear: this.operator.config.contestYear ?? new Date().getUTCFullYear(),
          callsign: this.operator.config.myCallsign.trim().toUpperCase(),
          workedByBand: {},
          workedFieldsByBand: {},
        };
        return {
          requestDecision: true,
          logbookSessionEffects: [{
            operation: 'open', sessionKey: this.practice.sessionKey,
            title: this.practice.title, retention: 'runtime',
          }],
        };
      }
      if (invocation.actionId === 'stop-practice' && this.practice) {
        this.practiceEnabled = false;
        this.practiceSessionDestroyPending = false;
        this.practiceOperatingIndex = undefined;
        return {
          requestDecision: true,
          logbookSessionEffects: [{ operation: 'destroy', sessionKey: this.practice.sessionKey }],
        };
      }
      throw new Error('strategy_action_not_available');
    }
    if (invocation.target.kind === 'stream') {
      if (invocation.actionId === 'send-alternate') {
        const text = (invocation.payload as { value?: unknown } | undefined)?.value;
        if (typeof text !== 'string') throw new Error('alternate_message_invalid');
        const checked = await this.preflightMessage(text, this.operator.config.modeName);
        if (!checked.encodable) throw new Error(checked.error || checked.reason || 'alternate_message_not_encodable');
      }
      const result = this.withCompletionDestination(await this.coordinator.invokeStreamAction(
        invocation.target.streamId,
        invocation.target.lifecycleEpoch,
        invocation.actionId,
        invocation.payload,
      ));
      this.validateLaneSpacing();
      if ((invocation.actionId === 'send-73-once' || invocation.actionId === 'resend-rr73')
          && !this.operator.isTransmitting) {
        this.startPurpose = 'recovery-work';
        this.previousTransmitting = false;
        return { ...(result ?? {}), requestDecision: true, requestOperatorStart: true };
      }
      return result;
    }
    const entry = this.coordinator.getEntry(invocation.target.entryId);
    if (!entry) throw new Error('entry_not_found');
    if (invocation.actionId === 'end-queued-target') {
      this.clearCompletionRecovery(entry.callsign);
      this.coordinator.remove(entry.entryId, invocation.target.queueVersion);
      return { requestDecision: true };
    }
    if (invocation.actionId === 'retry-parked-log') {
      const resume = entry.data.cycleResume;
      if (entry.data.status !== 'cycle-paused' || resume?.settlement !== 'failed') {
        throw new Error('log_retry_not_available');
      }
      const retry = this.lanesByStreamId.get(resume.streamId)
        ?.retryCompletionInCheckpoint(resume.laneCheckpoint);
      if (!retry) throw new Error('log_retry_not_available');
      this.coordinator.updateEntry(entry.entryId, (data) => {
        if (data.status !== 'cycle-paused' || !data.cycleResume) return false;
        data.cycleResume.laneCheckpoint = retry.checkpoint;
        data.cycleResume.settlement = undefined;
        return true;
      });
      return this.withCompletionDestination({
        qsoCompletions: [{ ...retry.effect, streamId: resume.streamId }],
      });
    }
    if (invocation.actionId === 'retry-detached-log') {
      const completion = Array.from(this.detachedCompletions.values()).find((candidate) => (
        candidate.entryId === entry.entryId && candidate.settled === 'failed'
      ));
      if (!completion) throw new Error('log_retry_not_available');
      completion.settled = undefined;
      completion.emitted = true;
      return this.withCompletionDestination({ qsoCompletions: [structuredClone(completion.effect)] });
    }
    if (invocation.actionId === 'authorize-target' || invocation.actionId === 'authorize-dupe') {
      this.authorizeEntry(entry.entryId);
      this.stopAttention = undefined;
      const requestOperatorStart = !this.operator.isTransmitting;
      if (requestOperatorStart) {
        this.startPurpose = 'authorized-work';
        this.allowQueuedCycleSelection = true;
        this.previousTransmitting = false;
      }
      return { requestDecision: true, requestOperatorStart };
    }
    if (invocation.actionId === 'revoke-authorization') {
      this.coordinator.updateEntry(entry.entryId, (data) => {
        data.status = data.dupe ? 'dupe' : 'candidate';
        data.authorizationId = undefined;
        data.authorizedAt = undefined;
        data.authorizedReceiveEpoch = undefined;
        return true;
      });
      return { requestDecision: true };
    }
    if (invocation.actionId === 'set-alternate-and-authorize') {
      const text = (invocation.payload as { value?: unknown } | undefined)?.value;
      if (typeof text !== 'string') throw new Error('alternate_message_invalid');
      const normalized = text.trim().toUpperCase().replace(/\s+/g, ' ');
      const checked = await this.preflightMessage(normalized, this.operator.config.modeName);
      if (!checked.encodable) throw new Error(checked.error || checked.reason || 'alternate_message_not_encodable');
      this.authorizeEntry(entry.entryId, { alternateText: normalized });
      const requestOperatorStart = !this.operator.isTransmitting;
      if (requestOperatorStart) {
        this.startPurpose = 'authorized-work';
        this.allowQueuedCycleSelection = true;
        this.previousTransmitting = false;
      }
      return { requestDecision: true, requestOperatorStart };
    }
    if (invocation.actionId === 'retry-target' || invocation.actionId === 'reauthorize-target') {
      this.authorizeEntry(entry.entryId);
      const requestOperatorStart = !this.operator.isTransmitting;
      if (requestOperatorStart) {
        this.startPurpose = 'authorized-work';
        this.allowQueuedCycleSelection = true;
        this.previousTransmitting = false;
      }
      return { requestDecision: true, requestOperatorStart };
    }
    if (invocation.actionId === 'pause-target') {
      this.coordinator.updateEntry(entry.entryId, (data) => { data.status = 'paused'; return true; });
      return { requestDecision: true };
    }
    throw new Error('strategy_action_not_available');
  }
  setSlotContent(_update: StrategyRuntimeSlotContentUpdate): void {}

  onOperatorTransmitCyclesChanged(change: StrategyOperatorTransmitCyclesChanged): boolean {
    if (change.source !== 'manual') return false;
    const previous = change.previousTransmitCycles.length === 1
      ? change.previousTransmitCycles[0]
      : undefined;
    const selected = change.transmitCycles.length === 1 ? change.transmitCycles[0] : undefined;
    if ((selected !== 0 && selected !== 1) || selected === previous) return false;
    const hasCyclePausedQso = this.coordinator.getQueueSnapshot().entries.some((row) => (
      row.entry.data.status === 'cycle-paused'
    ));
    if (!this.operator.isTransmitting && !hasCyclePausedQso) return false;
    this.switchActiveCycle(selected);
    if (!this.operator.isTransmitting) return true;
    this.pendingManualCycleAuthorization = {
      transmitCycle: selected,
      authorizationId: randomUUID(),
    };
    this.allowQueuedCycleSelection = false;
    this.stopAttention = undefined;
    return true;
  }

  settleQSOCompletion(settlement: StrategyQSOCompletionSettlement): void {
    const detached = this.detachedCompletions.get(settlement.recordId);
    if (detached
        && detached.effect.lifecycleEpoch === settlement.lifecycleEpoch
        && detached.effect.streamId === settlement.streamId) {
      detached.settled = settlement.status;
      if (settlement.streamId) {
        this.lanesByStreamId.get(settlement.streamId)
          ?.settleDetachedCompletion(settlement.recordId, settlement.status);
      }
      if (settlement.status === 'committed') {
        this.detachedCompletions.delete(settlement.recordId);
        const snapshot = this.coordinator.getQueueSnapshot();
        const row = snapshot.entries.find((candidate) => !candidate.active && (
          detached.entryId
            ? candidate.entry.entryId === detached.entryId
            : targetKey(candidate.entry.callsign) === targetKey(detached.callsign)
        ));
        if (row) this.coordinator.remove(row.entry.entryId, snapshot.version);
      } else {
        const row = detached.entryId
          ? this.coordinator.getEntry(detached.entryId)
          : this.coordinator.findEntryByTargetKey(targetKey(detached.callsign));
        if (row) {
          this.coordinator.updateEntry(row.entryId, (data) => {
            data.status = 'review';
            return true;
          });
        }
      }
      return;
    }
    this.coordinator.settleQSOCompletion(settlement);
    const configuredCycle = this.operator.config.transmitCycles[0] === 1 ? 1 : 0;
    for (const row of this.coordinator.getQueueSnapshot().entries) {
      const resume = row.entry.data.cycleResume;
      if (row.entry.data.status !== 'cycle-paused' || !resume || resume.streamId !== settlement.streamId) continue;
      const checkpoint = this.lanesByStreamId.get(resume.streamId)
        ?.settleCompletionInCheckpoint(resume.laneCheckpoint, settlement);
      if (checkpoint === undefined) continue;
      this.coordinator.setRequestedTransmitCycle(row.entry.entryId, configuredCycle);
      this.coordinator.updateEntry(row.entry.entryId, (data) => {
        if (data.status !== 'cycle-paused' || !data.cycleResume) return false;
        data.cycleResume = {
          ...data.cycleResume,
          transmitCycle: configuredCycle,
          laneCheckpoint: checkpoint,
          settlement: settlement.status,
        };
        return true;
      });
    }
    this.resumeCommittedParkedLanes();
  }

  onTransmissionsCompleted(receipts: StreamPhysicalReceipt[]): void {
    if (receipts.some((receipt) => receipt.streamId === 'cq')
        && this.callSession.onPhysicalCallSuccess()
        && this.callSession.attemptsExhausted) {
      this.exhaustedAtReceiveEpoch = this.receiveEpoch;
    }
    const laneReceipts = receipts.filter((receipt) => receipt.streamId !== 'cq');
    for (const receipt of laneReceipts) {
      for (const row of this.coordinator.getQueueSnapshot().entries) {
        const resume = row.entry.data.cycleResume;
        if (row.entry.data.status !== 'cycle-paused' || resume?.streamId !== receipt.streamId) continue;
        const checkpoint = this.lanesByStreamId.get(receipt.streamId)
          ?.applyPhysicalSuccessToCheckpoint(resume.laneCheckpoint, receipt);
        if (checkpoint === undefined) continue;
        this.coordinator.updateEntry(row.entry.entryId, (data) => {
          if (data.status !== 'cycle-paused' || data.cycleResume?.streamId !== receipt.streamId) return false;
          data.cycleResume.laneCheckpoint = checkpoint;
          return true;
        });
      }
    }
    this.coordinator.onPhysicalReceipts(laneReceipts);
  }

  onTransmissionQueued(transmission: string): void {
    const current = this.coordinator.getTransmissions().find((item) => item.text === transmission);
    if (!current) return;
    this.coordinator.onPhysicalReceipts([{
      ...current,
      frameId: 'legacy',
      revision: Date.now(),
      physicalConfirmed: true,
    }]);
  }

  reset(reason?: string): void {
    this.coordinator.reset(reason);
    this.callSession.reset();
    this.receiveEpoch = 0;
    this.lastObservedReceiveSlotStartMs = undefined;
    this.previousTransmitting = this.operator.isTransmitting;
    this.startPurpose = undefined;
    this.exhaustedAtReceiveEpoch = undefined;
    this.stopAttention = undefined;
    this.completionAttention = undefined;
    this.pendingManualCycleAuthorization = undefined;
    this.allowQueuedCycleSelection = false;
    this.revokePractice();
    this.detachedCompletions.clear();
    this.detachedCompletionEpoch = 0;
    this.detachedProtocolContexts.clear();
  }

  private result(options: {
    qsoCompletions?: StrategyDecisionResult['qsoCompletions'];
    qsoFailures?: StrategyDecisionResult['qsoFailures'];
    requestedTransmitCycle?: number;
    stop?: boolean;
  } = {}): StrategyDecisionResult {
    const qsoCompletions = this.withCompletionDestination({
      qsoCompletions: options.qsoCompletions,
    })?.qsoCompletions;
    const logbookSessionEffects = this.practiceSessionDestroyPending && this.practice
      ? [{ operation: 'destroy' as const, sessionKey: this.practice.sessionKey }]
      : undefined;
    this.practiceSessionDestroyPending = false;
    return {
      transmission: null,
      transmissions: this.getTransmissions(),
      snapshot: this.getSnapshot(),
      qsoCompletions,
      logbookSessionEffects,
      qsoFailures: options.qsoFailures,
      requestedTransmitCycle: options.requestedTransmitCycle,
      stop: options.stop ?? false,
    };
  }

  private syncParallelStreams(): void {
    const streams = this.parallelStreams();
    if (streams === this.coordinator.getMaxStreams()) return;
    const preemptedEntryIds = this.coordinator.setMaxStreams(streams, { preemptExcess: true });
    for (const entryId of preemptedEntryIds) {
      this.coordinator.updateEntry(entryId, (data) => {
        data.status = 'authorized';
        return true;
      });
    }
  }

  private requestedParallelStreams(): number {
    return Math.max(1, Math.min(3, Math.trunc(this.operator.config.parallelStreams || 1)));
  }

  private isPermissiveTarget(callsign: string): boolean {
    return /^[A-Z0-9]+(?:\/[A-Z0-9]+)*$/.test(callsign)
      && /[A-Z]/.test(callsign)
      && /[0-9]/.test(callsign)
      && callsign.length <= 13
      && !isUndecodedCallsignPlaceholder(callsign)
      && targetKey(callsign) !== targetKey(this.operator.config.myCallsign);
  }

  private armCallSession(): void {
    this.allowQueuedCycleSelection = false;
    this.exhaustedAtReceiveEpoch = undefined;
    this.callSession.arm({
      authorizationId: randomUUID(),
      maxAttempts: Math.max(1, Math.min(20, Math.trunc(this.operator.config.cqMaxAttempts ?? 6))),
      capacity: this.parallelStreams(),
    });
  }

  private hasQueueEntries(): boolean {
    return this.coordinator.getQueueSnapshot().entries.length > 0;
  }

  private countCandidates(): number {
    return this.coordinator.getQueueSnapshot().entries.filter((row) => (
      row.entry.data.status === 'candidate' || row.entry.data.status === 'dupe'
    )).length;
  }

  private countInvalidAuthorizations(): number {
    return this.coordinator.getQueueSnapshot().entries.filter((row) => (
      row.entry.data.status === 'stale'
      || row.entry.data.status === 'paused'
      || row.entry.data.status === 'no-response'
    )).length;
  }

  private countCyclePaused(): number {
    return this.coordinator.getQueueSnapshot().entries.filter((row) => (
      row.entry.data.status === 'cycle-paused'
    )).length;
  }

  private shouldStopForIdle(): boolean {
    if (this.callSession.state === 'calling' || this.callSession.state === 'collecting') return false;
    if (this.coordinator.getQueueSnapshot().activeEntryIds.length > 0) return false;
    return !this.coordinator.getQueueSnapshot().entries.some((row) => {
      if (row.entry.data.status === 'authorized'
          || (row.entry.data.status === 'review' && !this.hasFailedDetachedCompletion(row.entry.entryId))) return true;
      const resume = row.entry.data.cycleResume;
      if (row.entry.data.status !== 'cycle-paused' || !resume || resume.settlement !== undefined) return false;
      return this.receiveEpoch < resume.observeUntilReceiveEpoch;
    });
  }

  private collectParkedCompletions(): StrategyQSOCompletionEffect[] {
    const effects: StrategyQSOCompletionEffect[] = [];
    for (const row of this.coordinator.getQueueSnapshot().entries) {
      const resume = row.entry.data.cycleResume;
      if (row.entry.data.status !== 'cycle-paused' || !resume) continue;
      const pending = this.lanesByStreamId.get(resume.streamId)
        ?.takePendingCompletionFromCheckpoint(resume.laneCheckpoint);
      if (!pending) continue;
      this.coordinator.updateEntry(row.entry.entryId, (data) => {
        if (data.status !== 'cycle-paused' || !data.cycleResume) return false;
        data.cycleResume.laneCheckpoint = pending.checkpoint;
        return true;
      });
      effects.push({ ...pending.effect, streamId: resume.streamId });
    }
    return effects;
  }

  private resumeCommittedParkedLanes(): void {
    const configuredCycle = this.operator.config.transmitCycles[0] === 1 ? 1 : 0;
    const parked = this.coordinator.getQueueSnapshot().entries.filter((row) => (
      row.entry.data.status === 'cycle-paused'
      && row.entry.data.cycleResume?.settlement === 'committed'
    ));
    for (const row of parked) {
      const resume = row.entry.data.cycleResume!;
      this.coordinator.setRequestedTransmitCycle(row.entry.entryId, configuredCycle);
      this.coordinator.updateEntry(row.entry.entryId, (data) => {
        data.status = 'authorized';
        data.cycleResume = undefined;
        return true;
      });
      const activated = this.coordinator.activateEntry(row.entry.entryId, {
        currentTransmitCycle: configuredCycle,
        streamId: resume.streamId,
      });
      if (activated.activatedEntryIds.length === 0) {
        this.coordinator.updateEntry(row.entry.entryId, (data) => {
          data.status = 'cycle-paused';
          data.cycleResume = structuredClone(resume);
          return true;
        });
        continue;
      }
      this.lanesByStreamId.get(resume.streamId)?.restore(structuredClone(resume.laneCheckpoint));
    }
  }

  private switchActiveCycle(selectedCycle: 0 | 1): void {
    const checkpoint = this.coordinator.checkpoint();
    const streamsById = new Map(this.coordinator.getStreams().map((stream) => [stream.streamId, stream]));
    for (const binding of checkpoint.bindings) {
      if (binding.transmitCycle === selectedCycle) continue;
      const completionState = streamsById.get(binding.streamId)?.completion?.state;
      if (completionState === 'committing' || completionState === 'committed' || completionState === 'failed') {
        continue;
      }
      const laneCheckpoint = checkpoint.lanes.find((lane) => lane.streamId === binding.streamId)?.checkpoint;
      if (laneCheckpoint === undefined) continue;
      this.coordinator.releaseEntry(binding.entryId, {
        removeEntry: false,
        resetLane: true,
        reason: 'operator selected the other transmit cycle',
      });
      this.coordinator.updateEntry(binding.entryId, (data) => {
        data.status = 'cycle-paused';
        data.cycleResume = {
          streamId: binding.streamId,
          transmitCycle: binding.transmitCycle,
          laneCheckpoint: structuredClone(laneCheckpoint),
          observeUntilReceiveEpoch: this.receiveEpoch + 2,
        };
        return true;
      });
    }

    const resumable = this.coordinator.getQueueSnapshot().entries
      .filter((row) => row.entry.data.status === 'cycle-paused'
        && row.entry.data.cycleResume?.transmitCycle === selectedCycle)
      .sort((left, right) => (
        left.entry.data.cycleResume!.streamId.localeCompare(right.entry.data.cycleResume!.streamId)
      ));
    for (const row of resumable) {
      const resume = row.entry.data.cycleResume!;
      this.coordinator.updateEntry(row.entry.entryId, (data) => {
        data.status = 'authorized';
        data.cycleResume = undefined;
        return true;
      });
      const activated = this.coordinator.activateEntry(row.entry.entryId, {
        currentTransmitCycle: selectedCycle,
        streamId: resume.streamId,
      });
      if (activated.activatedEntryIds.length === 0) {
        this.coordinator.updateEntry(row.entry.entryId, (data) => {
          data.status = 'cycle-paused';
          data.cycleResume = structuredClone(resume);
          return true;
        });
        continue;
      }
      this.lanesByStreamId.get(resume.streamId)?.restore(structuredClone(resume.laneCheckpoint));
    }
  }

  private withCompletionDestination(result: StrategyActionResult | void): StrategyActionResult | void {
    if (!result?.qsoCompletions?.length) return result;
    const destination = this.completionDestination();
    if (!destination) return result;
    return {
      ...result,
      qsoCompletions: result.qsoCompletions.map((effect) => ({
        ...effect,
        destination,
        record: this.practiceEnabled && effect.record.contestEntry ? {
          ...effect.record,
          contestEntry: {
            ...effect.record.contestEntry,
            annotations: {
              ...effect.record.contestEntry.annotations,
              practice: true,
            },
          },
        } : effect.record,
      })),
    };
  }

  private takeDetachedCompletions(): StrategyQSOCompletionEffect[] {
    const effects: StrategyQSOCompletionEffect[] = [];
    for (const completion of this.detachedCompletions.values()) {
      if (completion.emitted || completion.settled) continue;
      completion.emitted = true;
      effects.push(structuredClone(completion.effect));
    }
    return effects;
  }

  private observeDetachedProtocolContext(callsign: string, message: ParsedFT8Message): boolean {
    const key = targetKey(callsign);
    const detached = this.detachedProtocolContexts.get(key);
    if (!detached) return false;
    const reduced = reduceWWDigiInbound(detached.context, message, this.operator.config);
    if (!reduced.changed) return false;
    if (!reduced.completed) {
      detached.context = structuredClone(reduced.context);
      detached.expiresAtReceiveEpoch = this.protocolContextExpiryEpoch();
      return true;
    }
    const streamId = `recovered-${key}`;
    const effect = buildWWDigiCompletionEffect(reduced.context, {
      streamId,
      lifecycleEpoch: ++this.detachedCompletionEpoch,
      endTime: message.timestamp,
      recoveredFinalAcknowledgement: true,
    }, this.operator.config);
    if (!this.detachedCompletions.has(effect.record.id)) {
      this.detachedCompletions.set(effect.record.id, {
        callsign: reduced.context.callsign,
        effect,
        emitted: false,
      });
    }
    this.detachedProtocolContexts.delete(key);
    return true;
  }

  private discardDetachedDuplicates(completedTargetKeys: ReadonlySet<string>): void {
    for (const [recordId, completion] of this.detachedCompletions) {
      if (!completedTargetKeys.has(targetKey(completion.callsign))) continue;
      this.detachedCompletions.delete(recordId);
    }
    for (const key of completedTargetKeys) this.detachedProtocolContexts.delete(key);
  }

  private clearCompletionRecovery(callsign: string): void {
    const key = targetKey(callsign);
    this.detachedProtocolContexts.delete(key);
    for (const [recordId, completion] of this.detachedCompletions) {
      if (targetKey(completion.callsign) === key) this.detachedCompletions.delete(recordId);
    }
  }

  private async classifyCandidateDupes(): Promise<void> {
    for (const row of this.coordinator.getQueueSnapshot().entries) {
      if (row.entry.data.status !== 'candidate' || row.entry.data.dupe !== undefined) continue;
      const dupe = await this.operator.hasWorkedCallsign(row.entry.callsign);
      this.coordinator.updateEntry(row.entry.entryId, (data) => {
        data.dupe = dupe;
        if (dupe) data.status = 'dupe';
        return true;
      });
    }
  }

  private async authorizeCollectedBatch(): Promise<void> {
    const candidates = this.coordinator.getQueueSnapshot().entries
      .filter((row) => row.entry.data.status === 'candidate' && row.entry.data.dupe !== true)
      .sort((left, right) => this.compareCandidates(left.entry, right.entry));
    const selected: typeof candidates = [];
    const remainingCapacity = this.callSession.capacity - this.callSession.selectedTargetKeys.length;
    for (const row of candidates) {
      if (selected.length >= remainingCapacity) break;
      const text = buildWWDigiRogerGrid(
        row.entry.callsign,
        this.operator.config.myCallsign,
        this.operator.config.myGrid,
      );
      const checked = await this.preflightMessage(text, this.operator.config.modeName);
      if (!checked.encodable) {
        this.coordinator.updateEntry(row.entry.entryId, (data) => {
          data.status = 'review';
          data.encodingError = checked.error || checked.reason || 'message_not_encodable';
          return true;
        });
        continue;
      }
      selected.push(row);
    }
    const authorizationId = this.callSession.authorizationId!;
    for (const row of selected) {
      this.coordinator.updateEntry(row.entry.entryId, (data) => {
        data.status = 'authorized';
        data.authorizationId = authorizationId;
        data.authorizedAt = Date.now();
        data.authorizedReceiveEpoch = this.receiveEpoch;
        return true;
      });
    }
    if (this.callSession.state === 'collecting') {
      this.callSession.activateBatch(selected.map((row) => row.entry.targetKey));
    } else if (selected.length > 0) {
      this.callSession.extendBatch(selected.map((row) => row.entry.targetKey));
    }
    this.exhaustedAtReceiveEpoch = undefined;
  }

  private async authorizePendingManualCycleBatch(): Promise<void> {
    const pending = this.pendingManualCycleAuthorization;
    if (!pending) return;
    this.pendingManualCycleAuthorization = undefined;
    const snapshot = this.coordinator.getQueueSnapshot();
    const authorizationCapacity = this.parallelStreams();
    const candidates = snapshot.entries
      .filter((row) => !row.active
        && row.entry.data.status === 'candidate'
        && row.entry.data.dupe !== true
        && row.entry.requestedTransmitCycle === pending.transmitCycle)
      .sort((left, right) => this.compareCandidates(left.entry, right.entry));
    let authorized = 0;
    for (const row of candidates) {
      if (authorized >= authorizationCapacity) break;
      const text = buildWWDigiRogerGrid(
        row.entry.callsign,
        this.operator.config.myCallsign,
        this.operator.config.myGrid,
      );
      const checked = await this.preflightMessage(text, this.operator.config.modeName);
      if (!checked.encodable) {
        this.coordinator.updateEntry(row.entry.entryId, (data) => {
          data.status = 'review';
          data.encodingError = checked.error || checked.reason || 'message_not_encodable';
          return true;
        });
        continue;
      }
      this.coordinator.updateEntry(row.entry.entryId, (data) => {
        data.status = 'authorized';
        data.authorizationId = pending.authorizationId;
        data.authorizedAt = Date.now();
        data.authorizedReceiveEpoch = this.receiveEpoch;
        return true;
      });
      authorized += 1;
    }
  }

  private compareCandidates(left: import('@tx5dr/plugin-api/toolkit').ParallelQSOQueueEntry<WWDigiEntryData>, right: import('@tx5dr/plugin-api/toolkit').ParallelQSOQueueEntry<WWDigiEntryData>): number {
    const policy = this.operator.config.cqSelectionPolicy ?? 'MAX_DISTANCE';
    if (policy === 'MAX_DISTANCE') {
      const leftDistance = left.data.targetGrid
        ? calculateGridDistance(this.operator.config.myGrid, left.data.targetGrid) : null;
      const rightDistance = right.data.targetGrid
        ? calculateGridDistance(this.operator.config.myGrid, right.data.targetGrid) : null;
      if (leftDistance !== rightDistance) {
        if (leftDistance === null) return 1;
        if (rightDistance === null) return -1;
        return rightDistance - leftDistance;
      }
    } else if (policy === 'MAX_SNR' || policy === 'MIN_SNR') {
      const leftSnr = left.data.lastSnr ?? Number.NEGATIVE_INFINITY;
      const rightSnr = right.data.lastSnr ?? Number.NEGATIVE_INFINITY;
      if (leftSnr !== rightSnr) return policy === 'MAX_SNR' ? rightSnr - leftSnr : leftSnr - rightSnr;
    }
    return (left.data.firstHeardAt ?? 0) - (right.data.firstHeardAt ?? 0)
      || (left.data.firstAudioFrequencyHz ?? 0) - (right.data.firstAudioFrequencyHz ?? 0)
      || left.callsign.localeCompare(right.callsign);
  }

  private queueActions(entry: import('@tx5dr/plugin-api/toolkit').ParallelQSOQueueEntry<WWDigiEntryData>) {
    const detachedLogFailed = this.hasFailedDetachedCompletion(entry.entryId);
    if (detachedLogFailed) {
      return [{
        id: 'retry-detached-log', label: 'actionRetry', icon: 'rotate-right', tone: 'primary' as const, presentation: 'primary' as const,
      }, {
        id: 'end-queued-target', label: 'actionEndQso', icon: 'xmark', tone: 'danger' as const, presentation: 'menu' as const,
      }];
    }
    if (entry.data.status === 'log-pending') return [];
    if (entry.data.status === 'candidate') {
      return [{
        id: 'authorize-target', label: 'actionAuthorize', icon: 'check', tone: 'primary' as const, presentation: 'primary' as const,
      }, {
        id: 'end-queued-target', label: 'actionEndQso', icon: 'xmark', tone: 'danger' as const, presentation: 'menu' as const,
      }];
    }
    if (entry.data.status === 'dupe') {
      return [{
        id: 'authorize-dupe', label: 'actionAuthorizeDupe', icon: 'triangle-alert', tone: 'warning' as const, presentation: 'primary' as const,
        confirmation: { title: 'confirmAuthorizeDupe', description: 'confirmAuthorizeDupeDesc', confirmLabel: 'actionAuthorizeDupe' },
      }, {
        id: 'end-queued-target', label: 'actionEndQso', icon: 'xmark', tone: 'danger' as const, presentation: 'menu' as const,
      }];
    }
    if (entry.data.status === 'authorized') {
      return [{
        id: 'revoke-authorization', label: 'actionRevokeAuthorization', icon: 'ban', presentation: 'menu' as const,
      }, {
        id: 'end-queued-target', label: 'actionEndQso', icon: 'xmark', tone: 'danger' as const, presentation: 'menu' as const,
      }];
    }
    if (entry.data.status === 'review') {
      const template = `<${entry.callsign}> ${this.operator.config.myCallsign} ${this.operator.config.myGrid}`;
      return [{
        id: 'set-alternate-and-authorize',
        label: 'actionAlternateMessage',
        description: 'actionAlternateMessageDesc',
        icon: 'pen',
        tone: 'warning' as const,
        presentation: 'primary' as const,
        input: { kind: 'text' as const, label: 'actionAlternateMessage', value: template, maxLength: 32 },
      }, {
        id: 'end-queued-target', label: 'actionEndQso', icon: 'xmark', tone: 'danger' as const, presentation: 'menu' as const,
      }];
    }
    if (entry.data.status === 'stale' || entry.data.status === 'paused') {
      return [{
        id: 'reauthorize-target', label: 'actionReauthorize', icon: 'rotate-right', tone: 'primary' as const, presentation: 'primary' as const,
      }, {
        id: 'end-queued-target', label: 'actionEndQso', icon: 'xmark', tone: 'danger' as const, presentation: 'menu' as const,
      }];
    }
    if (entry.data.status === 'cycle-paused') {
      return [...(entry.data.cycleResume?.settlement === 'failed' ? [{
        id: 'retry-parked-log', label: 'actionRetry', icon: 'rotate-right', tone: 'primary' as const, presentation: 'primary' as const,
      }] : []), {
        id: 'end-queued-target', label: 'actionEndQso', icon: 'xmark', tone: 'danger' as const, presentation: 'menu' as const,
      }];
    }
    if (entry.data.status === 'no-response') {
      return [{
        id: 'retry-target', label: 'actionRetry', icon: 'rotate-right', tone: 'primary' as const, presentation: 'primary' as const,
      }, {
        id: 'pause-target', label: 'actionLater', icon: 'pause', presentation: 'menu' as const,
      }, {
        id: 'end-queued-target', label: 'actionEndQso', icon: 'xmark', tone: 'danger' as const, presentation: 'menu' as const,
      }];
    }
    return [{ id: 'pause-target', label: 'actionLater', icon: 'pause', presentation: 'menu' as const }, {
      id: 'end-queued-target', label: 'actionEndQso', icon: 'xmark', tone: 'danger' as const, presentation: 'menu' as const,
    }];
  }

  private hasFailedDetachedCompletion(entryId: string): boolean {
    return Array.from(this.detachedCompletions.values()).some((completion) => (
      completion.entryId === entryId && completion.settled === 'failed'
    ));
  }

  notifyQsoLogged(recordId: string, callsign: string, grid: string | undefined, claimedScore: number): void {
    if (!callsign) return;
    this.completionAttention = {
      id: `qso-logged-${recordId}`,
      tone: 'success',
      title: 'attentionQsoLogged',
      description: 'attentionQsoLoggedDesc',
      params: { callsign, grid: grid || 'ZZ00', score: claimedScore },
      notify: true,
      expiresAt: Date.now() + 8_000,
    };
  }

  private expireCompletionAttention(): void {
    if (this.completionAttention?.expiresAt !== undefined
        && Date.now() >= this.completionAttention.expiresAt) {
      this.completionAttention = undefined;
    }
  }

  private hasUnsettledCompletionWork(): boolean {
    if (this.coordinator.getStreams().some((stream) => (
      stream.completion?.state === 'committing' || stream.completion?.state === 'failed'
    ))) return true;
    return this.coordinator.getQueueSnapshot().entries.some((row) => {
      const resume = row.entry.data.cycleResume;
      return row.entry.data.status === 'cycle-paused'
        && resume !== undefined
        && this.lanesByStreamId.get(resume.streamId)
          ?.hasUnsettledCompletionInCheckpoint(resume.laneCheckpoint) === true;
    });
  }

  private detachAndRemoveExecutableWork(): void {
    const preservedEntryIds = new Set(Array.from(this.detachedCompletions.values()).flatMap((completion) => (
      completion.entryId ? [completion.entryId] : []
    )));
    for (const row of this.coordinator.getQueueSnapshot().entries) {
      if (preservedEntryIds.has(row.entry.entryId)) continue;
      const resume = row.entry.data.cycleResume;
      const context = row.active && row.streamId
        ? this.lanesByStreamId.get(row.streamId)?.readProtocolContext()
        : resume
          ? this.lanesByStreamId.get(resume.streamId)?.readProtocolContext(resume.laneCheckpoint)
          : row.entry.data.protocolContext;
      if (isWWDigiProtocolContext(context)) {
        this.detachedProtocolContexts.set(row.entry.targetKey, {
          context: structuredClone(context),
          expiresAtReceiveEpoch: this.protocolContextExpiryEpoch(),
        });
      }
      const removed = this.coordinator.remove(
        row.entry.entryId,
        this.coordinator.getQueueSnapshot().version,
      );
      if (removed.outcome !== 'accepted') throw new Error(removed.reason ?? 'queue_replace_failed');
    }
  }

  private protocolContextExpiryEpoch(): number {
    const configured = Math.max(
      1,
      Math.min(60, Math.trunc(this.operator.config.authorizedStaleReceiveCycles ?? 12)),
    );
    return this.receiveEpoch + Math.max(MIN_PROTOCOL_CONTEXT_RECEIVE_CYCLES, configured);
  }

  private expireProtocolContexts(): boolean {
    let changed = false;
    for (const [key, detached] of this.detachedProtocolContexts) {
      if (this.receiveEpoch < detached.expiresAtReceiveEpoch) continue;
      this.detachedProtocolContexts.delete(key);
      changed = true;
    }
    for (const row of this.coordinator.getQueueSnapshot().entries) {
      if (row.active || !isWWDigiProtocolContext(row.entry.data.protocolContext)) continue;
      const expiresAt = row.entry.data.protocolContextExpiresAtReceiveEpoch;
      if (expiresAt === undefined || this.receiveEpoch < expiresAt) continue;
      if (this.coordinator.updateEntry(row.entry.entryId, (data) => {
        data.protocolContext = undefined;
        data.protocolContextExpiresAtReceiveEpoch = undefined;
        data.lastMessageRaw = undefined;
        return true;
      })) changed = true;
    }
    return changed;
  }

  private expireAuthorizations(): boolean {
    let changed = false;
    const expiry = Math.max(1, Math.min(60, Math.trunc(this.operator.config.authorizedStaleReceiveCycles ?? 12)));
    for (const row of this.coordinator.getQueueSnapshot().entries) {
      if (row.active || row.entry.data.status !== 'authorized') continue;
      const authorizedAt = row.entry.data.lastHeardReceiveEpoch
        ?? row.entry.data.authorizedReceiveEpoch ?? this.receiveEpoch;
      const lease = new AuthorizationLease({
        authorizationId: row.entry.data.authorizationId!,
        authorizedAtCycle: authorizedAt,
        expiresAfterReceiveCycles: expiry,
      });
      if (lease.isFresh(this.receiveEpoch)) continue;
      if (this.coordinator.updateEntry(row.entry.entryId, (data) => {
        data.status = 'stale';
        return true;
      })) changed = true;
    }
    return changed;
  }

  private parallelStreams(): number {
    const hostLimit = Math.max(1, Math.min(3, Math.trunc(this.operator.config.maxConcurrentStreams || 1)));
    return Math.min(this.requestedParallelStreams(), hostLimit);
  }

  private authorizeEntry(entryId: string, options: { alternateText?: string } = {}): void {
    if (!this.coordinator.updateEntry(entryId, (data) => {
      data.status = 'authorized';
      data.authorizationId = randomUUID();
      data.authorizedAt = Date.now();
      data.authorizedReceiveEpoch = this.receiveEpoch;
      data.noResponseCycles = undefined;
      data.encodingError = undefined;
      if (options.alternateText) data.alternateText = options.alternateText;
      return true;
    })) throw new Error('entry_not_found');
  }

  private validateLaneSpacing(): void {
    const frequencies = this.coordinator.getStreams().map((stream) => stream.audioFrequencyHz).sort((a, b) => a - b);
    const minimum = this.operator.config.modeName === 'FT4' ? 100 : 60;
    for (let index = 1; index < frequencies.length; index += 1) {
      if (frequencies[index]! - frequencies[index - 1]! < minimum) {
        throw new Error('audio_frequency_conflict');
      }
    }
  }

  private mutationResult(result: ParallelQueueMutationResult<WWDigiEntryData>): QueuedStrategyMutationResult {
    const reason = result.reason === 'queue_full' || result.reason === 'invalid_target'
      || result.reason === 'entry_not_found' || result.reason === 'active_entry'
      || result.reason === 'version_conflict'
      ? result.reason
      : undefined;
    return { outcome: result.outcome, reason, snapshot: this.getQueueSnapshot() };
  }
}
