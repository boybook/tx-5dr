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
  StrategyQSOCompletionSettlement,
  StrategyRuntimeCheckpoint,
  StrategyRuntimeContext,
  StrategyRuntimeSlot,
  StrategyRuntimeSlotContentUpdate,
  StrategyRuntimeSnapshot,
  StrategyStreamStateUpdate,
  StrategyActionInvocation,
  StrategyActionResult,
  StreamPhysicalReceipt,
  SlotInfo,
} from '@tx5dr/plugin-api';
import { FT8MessageType } from '@tx5dr/plugin-api';
import {
  FT8MessageParser,
  CycleUtils,
  isValidCallsign,
  isUndecodedCallsignPlaceholder,
} from '@tx5dr/core';
import {
  ParallelQSOCoordinator,
  type ParallelQSOCoordinatorCheckpoint,
  type ParallelQSOQueueEntry,
} from '@tx5dr/plugin-api/toolkit';
import type { StandardQSOPluginOperator } from '../standard-qso/StandardQSOPluginRuntime.js';
import {
  StandardQSOProtocolLane,
  type AssistedQueueEntryData,
  type PendingSlot,
  callsignMatches,
  gridOf,
  isDirectedTo,
  lastMessageFromParsed,
  normalized,
  pendingSlotForMessage,
  senderOf,
  targetOf,
} from './StandardQSOProtocolLane.js';

const MAX_QUEUE_SIZE = 64;
const MAX_PARALLEL_STREAMS = 3;
const STALE_AFTER_MODE_SLOTS = 6;
const INACTIVE_AFTER_MODE_SLOTS = 12;

interface QueueCheckpoint {
  coordinator: ParallelQSOCoordinatorCheckpoint<AssistedQueueEntryData>;
  latestSlotStartMs: number;
  lastQueueFullWarningAt: number;
}

export interface AssistedQSOQueueRuntimeOptions {
  operator: StandardQSOPluginOperator;
  isTransmitting: () => boolean;
  logger: PluginLogger;
  getMaxStreams?: () => number;
  getStreamLimit?: () => number;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function parsedSelectedMessage(lastMessage: { message: FrameMessage; slotInfo: SlotInfo }): ParsedFT8Message {
  return {
    message: FT8MessageParser.parseMessage(lastMessage.message.message),
    snr: lastMessage.message.snr,
    dt: lastMessage.message.dt,
    df: lastMessage.message.freq,
    rawMessage: lastMessage.message.message,
    slotId: lastMessage.slotInfo.id,
    timestamp: lastMessage.slotInfo.startMs,
  };
}

function clampMaxStreams(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(MAX_PARALLEL_STREAMS, Math.trunc(value)));
}

export class AssistedQSOQueueRuntime implements QueuedStrategyRuntime {
  private readonly operator: StandardQSOPluginOperator;
  private readonly isTransmitting: () => boolean;
  private readonly logger: PluginLogger;
  private readonly getConfiguredMaxStreams: () => number;
  private readonly getStreamLimit: () => number;
  private readonly coordinator: ParallelQSOCoordinator<AssistedQueueEntryData>;
  private readonly lanes: StandardQSOProtocolLane[] = [];
  private latestSlotStartMs = 0;
  private lastQueueFullWarningAt = Number.NEGATIVE_INFINITY;

  constructor(options: AssistedQSOQueueRuntimeOptions) {
    this.operator = options.operator;
    this.isTransmitting = options.isTransmitting;
    this.logger = options.logger;
    this.getConfiguredMaxStreams = options.getMaxStreams ?? (() => 1);
    this.getStreamLimit = options.getStreamLimit ?? (() => MAX_PARALLEL_STREAMS);
    this.coordinator = new ParallelQSOCoordinator({
      maxSupportedStreams: MAX_PARALLEL_STREAMS,
      initialMaxStreams: this.readMaxStreams(),
      maxQueueSize: MAX_QUEUE_SIZE,
      createLane: ({ streamId, laneIndex }) => {
        const lane = new StandardQSOProtocolLane({
          streamId,
          laneIndex,
          operator: this.operator,
          logger: this.logger,
        });
        this.lanes.push(lane);
        return lane;
      },
    });
  }

  checkpoint(): StrategyRuntimeCheckpoint {
    return clone({
      coordinator: this.coordinator.checkpoint(),
      latestSlotStartMs: this.latestSlotStartMs,
      lastQueueFullWarningAt: this.lastQueueFullWarningAt,
    } satisfies QueueCheckpoint);
  }

  restore(checkpoint: StrategyRuntimeCheckpoint): void {
    const state = checkpoint as QueueCheckpoint;
    if (!state || typeof state !== 'object' || !state.coordinator) {
      throw new Error('Invalid assisted queue checkpoint');
    }
    this.coordinator.restore(state.coordinator);
    this.latestSlotStartMs = state.latestSlotStartMs ?? 0;
    this.lastQueueFullWarningAt = state.lastQueueFullWarningAt ?? Number.NEGATIVE_INFINITY;
  }

  observeDecodedMessages(messages: ParsedFT8Message[], meta: QueuedStrategyObservationMeta): boolean {
    if (meta.signal.aborted) return false;
    const before = this.queueProjectionFingerprint();
    const beforeVersion = this.coordinator.getQueueSnapshot().version;
    this.latestSlotStartMs = Math.max(this.latestSlotStartMs, meta.slotInfo.startMs);
    this.updatePauseStates(meta.slotInfo.startMs);
    const mode = this.operator.config.mode;
    const fallback = this.fallbackSlot();

    for (const message of messages) {
      if (message.isPartialDecode) continue;
      const sender = senderOf(message);
      if (!sender || !isValidCallsign(sender) || isUndecodedCallsignPlaceholder(sender)) continue;
      if (callsignMatches(sender, this.operator.config.myCallsign)) continue;
      const key = normalized(sender);
      const direct = isDirectedTo(message, this.operator.config.myCallsign);
      let entry = this.coordinator.findEntryByTargetKey(key);

      if (!entry && direct && (
        message.message.type === FT8MessageType.CALL
        || message.message.type === FT8MessageType.SIGNAL_REPORT
      )) {
        const result = this.coordinator.enqueue({
          targetKey: key,
          callsign: sender,
          requestedTransmitCycle: (meta.slotInfo.cycleNumber + 1) % 2 as 0 | 1,
          data: this.createEntryData('inbound-direct', fallback),
        });
        if (result.outcome === 'rejected') {
          if (result.reason === 'queue_full'
              && message.timestamp - this.lastQueueFullWarningAt >= mode.slotMs * 2) {
            this.lastQueueFullWarningAt = message.timestamp;
            this.logger.warn('Ignoring inbound caller because the assisted queue is full', { callsign: sender });
          }
          continue;
        }
        entry = result.entry;
      }
      if (!entry || entry.data.state === 'review') continue;
      if (!callsignMatches(sender, entry.callsign)) continue;

      const wasPriority = this.isPriorityInboundEntry(entry);
      const relevantCq = message.message.type === FT8MessageType.CQ;
      const correlatedProtocol = direct && this.laneForEntry(entry.entryId)?.isCorrelatedMessage(message) === true;
      const canRefreshContext = relevantCq || (direct && (
        message.message.type === FT8MessageType.CALL
        || message.message.type === FT8MessageType.SIGNAL_REPORT
        || correlatedProtocol
      ));
      const changed = this.coordinator.updateEntry(entry.entryId, (data) => {
        const fingerprint = JSON.stringify(data);
        const recovers = data.state === 'paused' || data.state === 'no-response';
        data.lastHeardAt = message.timestamp;
        data.lastHeardCycle = CycleUtils.isEvenCycle(meta.slotInfo.cycleNumber) ? 0 : 1;
        data.lastSnr = message.snr;
        data.targetGrid = gridOf(message) ?? data.targetGrid;
        data.pending.validUntil = message.timestamp + mode.slotMs * STALE_AFTER_MODE_SLOTS;
        if (recovers) {
          data.state = 'queued';
          data.pauseReason = undefined;
          data.noResponseCycles = undefined;
          if (!canRefreshContext) {
            data.pending = {
              revision: data.pending.revision + 1,
              nextLocalTxSlot: fallback,
              hasDirectEvidence: false,
              validUntil: message.timestamp + mode.slotMs * STALE_AFTER_MODE_SLOTS,
            };
          }
        }
        if (canRefreshContext) {
          const nextSlot = pendingSlotForMessage(message, this.operator.config.myCallsign, fallback);
          const previousRaw = data.pending.lastMessage?.message.message;
          const previousSlot = data.pending.lastMessage?.slotInfo.startMs;
          if (message.rawMessage !== previousRaw
              || message.timestamp !== previousSlot
              || data.pending.nextLocalTxSlot !== nextSlot) {
            data.pending = {
              revision: data.pending.revision + 1,
              nextLocalTxSlot: nextSlot,
              hasDirectEvidence: direct,
              lastMessage: lastMessageFromParsed(message, mode.name, mode.slotMs),
              validUntil: message.timestamp + mode.slotMs * STALE_AFTER_MODE_SLOTS,
            };
          }
        }
        return fingerprint !== JSON.stringify(data);
      });
      entry = this.coordinator.getEntry(entry.entryId)!;
      if (canRefreshContext) {
        this.coordinator.setRequestedTransmitCycle(
          entry.entryId,
          (meta.slotInfo.cycleNumber + 1) % 2 as 0 | 1,
        );
        entry = this.coordinator.getEntry(entry.entryId)!;
      }
      if ((!wasPriority || changed) && this.isPriorityInboundEntry(entry)) {
        this.promotePriorityInbound(entry.entryId);
      }

      if (!canRefreshContext && !direct && targetOf(message)) {
        const streamId = this.activeStreamIdForEntry(entry.entryId);
        if (streamId && this.laneForEntry(entry.entryId)?.getActiveData()?.state === 'active') {
          this.coordinator.updateEntry(entry.entryId, (data) => {
            data.state = 'paused';
            data.pauseReason = 'target-busy';
            data.noResponseCycles = undefined;
            return true;
          });
          this.coordinator.releaseEntry(entry.entryId, {
            removeEntry: false,
            reason: 'assisted queue target started working another station',
            resetLane: true,
          });
        } else if (!streamId && entry.data.state !== 'paused' && entry.data.state !== 'no-response') {
          this.coordinator.updateEntry(entry.entryId, (data) => {
            data.state = 'paused';
            data.pauseReason = 'target-busy';
            data.noResponseCycles = undefined;
            return true;
          });
        }
      }
    }
    this.refreshActiveLanes();
    this.coordinator.observe(messages, meta);
    this.syncLaneEntryData();
    const changed = this.queueProjectionFingerprint() !== before;
    if (changed && this.coordinator.getQueueSnapshot().version === beforeVersion) {
      this.coordinator.markChanged();
    }
    return changed;
  }

  enqueueTarget(request: QueuedStrategyTargetRequest): QueuedStrategyMutationResult {
    const callsign = request.callsign.trim().toUpperCase();
    if (!isValidCallsign(callsign)
        || isUndecodedCallsignPlaceholder(callsign)
        || callsignMatches(callsign, this.operator.config.myCallsign)) {
      return this.result('rejected', 'invalid_target');
    }
    const fallback = this.fallbackSlot();
    const data = this.createEntryData('manual', fallback);
    let requestedTransmitCycle: 0 | 1 | undefined;
    if (request.lastMessage) {
      const parsed = parsedSelectedMessage(request.lastMessage);
      const selectedSender = senderOf(parsed);
      const direct = isDirectedTo(parsed, this.operator.config.myCallsign);
      if (callsignMatches(selectedSender, callsign)) {
        data.targetGrid = gridOf(parsed);
        data.lastSnr = request.lastMessage.message.snr;
        data.lastHeardAt = request.lastMessage.slotInfo.startMs;
        data.lastHeardCycle = CycleUtils.isEvenCycle(request.lastMessage.slotInfo.cycleNumber) ? 0 : 1;
        this.latestSlotStartMs = Math.max(this.latestSlotStartMs, request.lastMessage.slotInfo.startMs);
        data.pending.nextLocalTxSlot = direct && parsed.message.type === FT8MessageType.CALL
          ? 'TX2'
          : direct && parsed.message.type === FT8MessageType.SIGNAL_REPORT
            ? 'TX3'
            : fallback;
        data.pending.hasDirectEvidence = direct && (
          parsed.message.type === FT8MessageType.CALL
          || parsed.message.type === FT8MessageType.SIGNAL_REPORT
        );
        data.pending.lastMessage = clone(request.lastMessage);
        data.pending.validUntil = request.lastMessage.slotInfo.startMs
          + this.operator.config.mode.slotMs * STALE_AFTER_MODE_SLOTS;
        requestedTransmitCycle = (request.lastMessage.slotInfo.cycleNumber + 1) % 2 as 0 | 1;
      }
    }
    const mutation = this.coordinator.enqueue({
      targetKey: normalized(callsign),
      callsign,
      requestedTransmitCycle,
      data,
    });
    if (mutation.outcome === 'accepted' && mutation.entry && this.isPriorityInboundEntry(mutation.entry)) {
      this.promotePriorityInbound(mutation.entry.entryId);
    }
    return this.fromCoordinatorMutation(mutation.outcome, mutation.reason);
  }

  reorderTarget(entryId: string, beforeEntryId: string | null, expectedVersion: number): QueuedStrategyMutationResult {
    const mutation = this.coordinator.reorder(entryId, beforeEntryId, expectedVersion);
    return this.fromCoordinatorMutation(mutation.outcome, mutation.reason);
  }

  retryTarget(entryId: string, expectedVersion: number): QueuedStrategyMutationResult {
    if (expectedVersion !== this.coordinator.getQueueSnapshot().version) {
      return this.result('rejected', 'version_conflict');
    }
    const entry = this.coordinator.getEntry(entryId);
    if (!entry) return this.result('rejected', 'entry_not_found');
    if (entry.data.state !== 'no-response' || entry.data.noResponseCycles === undefined) {
      return this.result('rejected', 'entry_not_retryable');
    }
    const fallback = this.fallbackSlot();
    this.coordinator.updateEntry(entryId, (data) => {
      data.state = 'queued';
      data.noResponseCycles = undefined;
      data.pauseReason = undefined;
      data.pending = {
        revision: data.pending.revision + 1,
        nextLocalTxSlot: fallback,
        hasDirectEvidence: false,
        validUntil: Number.POSITIVE_INFINITY,
      };
      return true;
    });
    return this.result('accepted');
  }

  removeTarget(entryId: string, expectedVersion: number): QueuedStrategyMutationResult {
    const mutation = this.coordinator.remove(entryId, expectedVersion);
    return this.fromCoordinatorMutation(mutation.outcome, mutation.reason);
  }

  clearTargets(expectedVersion: number): QueuedStrategyMutationResult {
    const mutation = this.coordinator.clear(expectedVersion);
    return this.fromCoordinatorMutation(mutation.outcome, mutation.reason);
  }

  getQueueSnapshot(): AssistedQueueSnapshot {
    this.syncMaxStreams();
    const snapshot = this.coordinator.getQueueSnapshot();
    return {
      version: snapshot.version,
      activeEntryId: snapshot.activeEntryIds[0],
      activeEntryIds: snapshot.activeEntryIds,
      maxActiveStreams: snapshot.maxActiveStreams,
      requestedMaxActiveStreams: this.readRequestedMaxStreams(),
      rows: snapshot.entries.map((row, order) => {
        const lane = row.active ? this.lanes.find((candidate) => candidate.streamId === row.streamId) : undefined;
        const data = lane?.getActiveData() ?? row.entry.data;
        const displayState = lane?.displayState() ?? this.displayState(data);
        return {
          entryId: row.entry.entryId,
          callsign: row.entry.callsign,
          order,
          draggable: !row.active,
          displayState,
          tone: data.state === 'review' ? 'danger'
            : data.state === 'closing' ? 'warning'
              : data.state === 'no-response' ? 'warning'
                : data.state === 'engaged' ? 'success'
                  : row.active ? 'active' : 'neutral',
          icon: data.state === 'review' ? 'triangle-alert'
            : data.state === 'closing' ? 'loader-circle'
              : data.state === 'engaged' ? 'check-circle'
                : data.state === 'paused' ? 'pause'
                  : data.state === 'no-response' ? 'clock'
                    : row.active ? 'radio' : 'circle',
          pauseReason: data.pauseReason,
          noResponseCycles: data.noResponseCycles,
          targetGrid: data.targetGrid,
          lastSnr: data.lastSnr,
          lastHeardCyclesAgo: data.lastHeardAt === undefined
            ? undefined
            : Math.max(0, Math.floor(
              (this.latestSlotStartMs - data.lastHeardAt) / this.operator.config.mode.slotMs,
            )),
          lastHeardCycle: data.lastHeardCycle,
          streamId: row.streamId,
          audioFrequencyHz: row.audioFrequencyHz,
          actions: row.active ? [] : [
            ...(data.state === 'no-response' ? [{
              id: 'retry-target', label: 'actionRetry', icon: 'rotate-right', tone: 'primary' as const, presentation: 'primary' as const,
            }] : []),
            { id: 'remove-target', label: 'actionRemove', icon: 'trash', tone: 'danger' as const, presentation: 'menu' as const },
          ],
        };
      }),
    };
  }

  async decide(messages: ParsedFT8Message[], meta: StrategyDecisionMetaV2): Promise<StrategyDecisionResult> {
    if (meta.signal.aborted) throw new DOMException('Strategy decision aborted', 'AbortError');
    this.syncMaxStreams();
    this.updatePauseStates(Date.now());
    if (!this.isTransmitting()) return this.resultSnapshot([]);

    const firstFill = await this.prepareLanes();
    this.refreshActiveLanes();
    const aggregate = await this.coordinator.decide(messages, meta);
    this.syncLaneEntryData();
    for (const released of aggregate.releasedEntries) {
      if (released.disposition === 'retain-entry') this.moveToEnd(released.entryId);
    }
    const refill = aggregate.releasedEntries.length > 0 ? await this.prepareLanes() : undefined;
    this.refreshActiveLanes();
    const transmissions = this.getTransmissions();
    const qsoCompletions = aggregate.qsoCompletions;
    const qsoFailures = aggregate.qsoFailures;
    return {
      stop: false,
      transmission: transmissions[0]?.text ?? null,
      transmissions,
      snapshot: this.getSnapshot(),
      qsoCompletion: qsoCompletions.length === 1 ? qsoCompletions[0] : undefined,
      qsoCompletions: qsoCompletions.length > 1 ? qsoCompletions : undefined,
      qsoFailure: qsoFailures.length === 1 ? qsoFailures[0] : undefined,
      qsoFailures: qsoFailures.length > 1 ? qsoFailures : undefined,
      requestedTransmitCycle: firstFill.requestedTransmitCycle ?? refill?.requestedTransmitCycle,
    };
  }

  invokeAction(invocation: StrategyActionInvocation): StrategyActionResult | void {
    if (invocation.target.kind !== 'queue-entry') throw new Error('strategy_action_not_available');
    if (invocation.actionId === 'retry-target') {
      const result = this.retryTarget(invocation.target.entryId, invocation.target.queueVersion);
      if (result.outcome !== 'accepted') throw new Error(result.reason ?? 'strategy_action_not_available');
      return { requestDecision: true };
    }
    if (invocation.actionId === 'remove-target') {
      const result = this.removeTarget(invocation.target.entryId, invocation.target.queueVersion);
      if (result.outcome !== 'accepted') throw new Error(result.reason ?? 'strategy_action_not_available');
      return { requestDecision: true };
    }
    throw new Error('strategy_action_not_available');
  }

  getTransmitText(): string | null {
    if (!this.isTransmitting()) return null;
    return this.getTransmissions()[0]?.text ?? null;
  }

  getTransmissions() {
    this.syncMaxStreams();
    if (!this.isTransmitting()) return [];
    const transmissions = this.coordinator.getTransmissions();
    if (transmissions.length > 0) return transmissions;
    const idleCQ = this.getIdleCQText();
    return idleCQ ? [{
      streamId: this.lanes[0]!.streamId,
      text: idleCQ,
      audioFrequencyHz: this.lanes[0]!.audioFrequencyHz,
    }] : [];
  }

  requestCall(callsign: string, lastMessage?: { message: FrameMessage; slotInfo: SlotInfo }): boolean {
    return this.enqueueTarget({ callsign, lastMessage }).outcome !== 'rejected';
  }

  getSnapshot(): StrategyRuntimeSnapshot {
    this.syncMaxStreams();
    const primary = this.primaryLane().getLegacySnapshot();
    return {
      ...primary,
      streams: this.coordinator.getStreams(),
      queue: this.getQueueSnapshot(),
    };
  }

  patchContext(patch: Partial<StrategyRuntimeContext>): void { this.primaryLane().patchContext(patch); }
  setState(state: StrategyRuntimeSlot): void { this.primaryLane().setState(state); }
  setStreamState(update: StrategyStreamStateUpdate): void {
    this.coordinator.setStreamState(update.streamId, update.stateId, update.expectedLifecycleEpoch);
  }
  setSlotContent(update: StrategyRuntimeSlotContentUpdate): void { this.primaryLane().setSlotContent(update); }

  settleQSOCompletion(settlement: StrategyQSOCompletionSettlement): void {
    const lane = settlement.streamId
      ? this.lanes.find((candidate) => candidate.streamId === settlement.streamId)
      : this.lanes.find((candidate) => candidate.canSettle(settlement));
    if (lane?.settleQSOCompletion(settlement) !== true) return;
    this.coordinator.markChanged();
    const entryId = lane.getActiveEntryId();
    if (entryId && lane.isReadyToReleaseAfterSettlement()) {
      this.coordinator.releaseEntry(entryId, {
        removeEntry: true,
        reason: 'QSO persistence committed',
      });
    }
  }

  onTransmissionQueued(transmission: string): void {
    this.lanes.find((lane) => lane.getTransmitText() === transmission)
      ?.onLegacyPhysicalSuccess(transmission);
  }

  onTransmissionsCompleted(receipts: StreamPhysicalReceipt[]): void {
    this.coordinator.onPhysicalReceipts(receipts);
  }

  reset(reason?: string): void {
    this.latestSlotStartMs = 0;
    this.lastQueueFullWarningAt = Number.NEGATIVE_INFINITY;
    this.coordinator.reset(reason);
    this.syncMaxStreams();
  }

  private async prepareLanes() {
    await this.removeIneligibleWorkedInbound();
    const previouslyActiveEntryIds = new Set(this.coordinator.getQueueSnapshot().activeEntryIds);
    const fill = await this.fillLanes();
    for (const entryId of fill.rejectedEntryIds) {
      this.coordinator.updateEntry(entryId, (data) => {
        data.state = 'review';
        return true;
      });
    }
    const snapshot = this.coordinator.getQueueSnapshot();
    if (snapshot.activeEntryIds.length === snapshot.maxActiveStreams) {
      const opportunity = this.selectDirectOpportunity();
      const preemptible = this.lanes.find((lane) => {
        const entryId = lane.getActiveEntryId();
        return entryId && previouslyActiveEntryIds.has(entryId) && lane.canPreemptActive();
      });
      if (opportunity && preemptible?.getActiveEntryId()) {
        const currentTransmitCycle = this.currentTransmitCycle();
        if (snapshot.activeEntryIds.length > 1
            && opportunity.requestedTransmitCycle !== undefined
            && opportunity.requestedTransmitCycle !== currentTransmitCycle) {
          return fill;
        }
        const previousEntryId = preemptible.getActiveEntryId()!;
        const preemptedStreamId = preemptible.streamId;
        this.coordinator.releaseEntry(previousEntryId, {
          removeEntry: false,
          reason: 'priority inbound caller preempted unanswered TX1',
          resetLane: true,
        });
        this.moveToEnd(previousEntryId);
        const preemptFill = this.coordinator.activateEntry(opportunity.entryId, {
          currentTransmitCycle,
          streamId: preemptedStreamId,
        });
        for (const entryId of preemptFill.rejectedEntryIds) {
          this.coordinator.updateEntry(entryId, (data) => {
            data.state = 'review';
            return true;
          });
        }
        return {
          ...fill,
          activatedEntryIds: [...fill.activatedEntryIds, ...preemptFill.activatedEntryIds],
          rejectedEntryIds: [...fill.rejectedEntryIds, ...preemptFill.rejectedEntryIds],
          requestedTransmitCycle: fill.requestedTransmitCycle ?? preemptFill.requestedTransmitCycle,
        };
      }
    }
    return fill;
  }

  private fillLanes() {
    return this.coordinator.fillAvailableLanes({
      currentTransmitCycle: this.currentTransmitCycle(),
      isEligible: (entry) => entry.data.state === 'queued'
        && entry.data.pending.nextLocalTxSlot !== null
        && !this.operator.isTargetBeingWorkedByOthers(entry.callsign),
    });
  }

  private async removeIneligibleWorkedInbound(): Promise<void> {
    if (this.operator.config.replyToWorkedStations) return;
    for (const row of this.coordinator.getQueueSnapshot().entries) {
      if (row.active || row.entry.data.source !== 'inbound-direct') continue;
      if (!await this.operator.hasWorkedCallsign(row.entry.callsign)) continue;
      this.logger.debug('Removing automatically queued caller already worked under current settings', {
        callsign: row.entry.callsign,
      });
      this.coordinator.remove(row.entry.entryId, this.coordinator.getQueueSnapshot().version);
    }
  }

  private getIdleCQText(): string | null {
    const snapshot = this.coordinator.getQueueSnapshot();
    if (snapshot.activeEntryIds.length > 0) return null;
    if (snapshot.entries.some((row) => row.entry.data.state === 'queued'
        && row.entry.data.pending.nextLocalTxSlot !== null
        && !this.operator.isTargetBeingWorkedByOthers(row.entry.callsign))) return null;
    if (snapshot.entries.some((row) => row.entry.data.state === 'review'
        || row.entry.data.state === 'closing')) return null;
    return this.lanes[0]!.getIdleCQText();
  }

  private refreshActiveLanes(): void {
    for (const row of this.coordinator.getQueueSnapshot().entries) {
      if (!row.active || !row.streamId) continue;
      this.lanes.find((lane) => lane.streamId === row.streamId)?.refreshEntry(row.entry);
    }
  }

  private syncLaneEntryData(): void {
    for (const lane of this.lanes) {
      const entryId = lane.getActiveEntryId();
      const laneData = lane.getActiveData();
      if (!entryId || !laneData) continue;
      this.coordinator.updateEntry(entryId, (data) => {
        if (JSON.stringify(data) === JSON.stringify(laneData)) return false;
        Object.assign(data, clone(laneData));
        return true;
      });
    }
  }

  private updatePauseStates(now: number): void {
    const slotMs = this.operator.config.mode.slotMs;
    for (const row of this.coordinator.getQueueSnapshot().entries) {
      const entry = row.entry;
      if (entry.data.pending.validUntil === Number.POSITIVE_INFINITY) continue;
      const evidenceAt = entry.data.lastHeardAt ?? entry.data.pending.lastMessage?.slotInfo.startMs;
      const inactiveCycles = evidenceAt === undefined
        ? STALE_AFTER_MODE_SLOTS
        : Math.max(0, Math.floor((now - evidenceAt) / slotMs));
      if (entry.data.state === 'paused' && inactiveCycles >= INACTIVE_AFTER_MODE_SLOTS) {
        this.coordinator.updateEntry(entry.entryId, (data) => {
          data.state = 'no-response';
          data.noResponseCycles = undefined;
          data.pauseReason = undefined;
          return true;
        });
      } else if (entry.data.pending.validUntil < now && entry.data.state === 'queued') {
        this.coordinator.updateEntry(entry.entryId, (data) => {
          data.state = 'paused';
          data.pauseReason = 'stale';
          data.noResponseCycles = undefined;
          return true;
        });
      } else if (entry.data.pending.validUntil < now
          && row.active
          && (entry.data.state === 'active'
            || entry.data.state === 'engaged'
            || entry.data.state === 'closing')
          && !this.isTransmitting()) {
        this.coordinator.updateEntry(entry.entryId, (data) => {
          data.state = 'paused';
          data.pauseReason = 'stale';
          data.noResponseCycles = undefined;
          return true;
        });
        this.coordinator.releaseEntry(entry.entryId, {
          removeEntry: false,
          reason: 'assisted queue active context expired while paused',
          resetLane: true,
        });
      }
    }
  }

  private promotePriorityInbound(entryId: string): void {
    const snapshot = this.coordinator.getQueueSnapshot();
    const row = snapshot.entries.find((candidate) => candidate.entry.entryId === entryId);
    if (!row || row.active || !this.isPriorityInboundEntry(row.entry)) return;
    const before = snapshot.entries.find((candidate) => (
      !candidate.active
      && candidate.entry.entryId !== entryId
      && !this.isPriorityInboundEntry(candidate.entry)
    ));
    this.coordinator.reorder(entryId, before?.entry.entryId ?? null, snapshot.version);
  }

  private selectDirectOpportunity(): ParallelQSOQueueEntry<AssistedQueueEntryData> | undefined {
    return this.coordinator.getQueueSnapshot().entries.find((row) => (
      !row.active
      && row.entry.data.state === 'queued'
      && this.isPriorityInboundEntry(row.entry)
      && !this.operator.isTargetBeingWorkedByOthers(row.entry.callsign)
    ))?.entry;
  }

  private isPriorityInboundEntry(entry: ParallelQSOQueueEntry<AssistedQueueEntryData>): boolean {
    return entry.data.state === 'queued'
      && entry.data.pending.hasDirectEvidence
      && (entry.data.pending.nextLocalTxSlot === 'TX2'
        || entry.data.pending.nextLocalTxSlot === 'TX3');
  }

  private moveToEnd(entryId: string): void {
    const version = this.coordinator.getQueueSnapshot().version;
    this.coordinator.reorder(entryId, null, version);
  }

  private laneForEntry(entryId: string): StandardQSOProtocolLane | undefined {
    const streamId = this.activeStreamIdForEntry(entryId);
    return streamId ? this.lanes.find((lane) => lane.streamId === streamId) : undefined;
  }

  private activeStreamIdForEntry(entryId: string): string | undefined {
    return this.coordinator.getQueueSnapshot().entries
      .find((row) => row.active && row.entry.entryId === entryId)?.streamId;
  }

  private primaryLane(): StandardQSOProtocolLane {
    const activeStreamId = this.coordinator.getQueueSnapshot().entries.find((row) => row.active)?.streamId;
    return this.lanes.find((lane) => lane.streamId === activeStreamId)
      ?? this.lanes.find((lane) => lane.getSnapshot() !== null)
      ?? this.lanes[0]!;
  }

  private createEntryData(source: AssistedQueueEntryData['source'], fallback: PendingSlot): AssistedQueueEntryData {
    return {
      source,
      state: 'queued',
      pending: {
        revision: 0,
        nextLocalTxSlot: fallback,
        hasDirectEvidence: false,
        validUntil: Number.POSITIVE_INFINITY,
      },
    };
  }

  private displayState(data: AssistedQueueEntryData): AssistedQueueDisplayState {
    if (data.state === 'engaged') return 'engaged';
    if (data.state === 'closing') return 'closing';
    if (data.state === 'paused') return 'paused';
    if (data.state === 'no-response') return 'no-response';
    if (data.state === 'review') return 'review';
    return data.pending.nextLocalTxSlot ?? 'review';
  }

  private fallbackSlot(): PendingSlot {
    return this.operator.config.skipTx1 === true ? 'TX2' : 'TX1';
  }

  private currentTransmitCycle(): 0 | 1 {
    return this.operator.config.transmitCycles[0] === 1 ? 1 : 0;
  }

  private readRequestedMaxStreams(): number {
    return clampMaxStreams(this.getConfiguredMaxStreams());
  }

  private readMaxStreams(): number {
    return Math.min(this.readRequestedMaxStreams(), clampMaxStreams(this.getStreamLimit()));
  }

  private syncMaxStreams(): void {
    const preemptedEntryIds = this.coordinator.setMaxStreams(
      this.readMaxStreams(),
      { preemptExcess: true },
    );
    for (const entryId of preemptedEntryIds) {
      this.coordinator.updateEntry(entryId, (data) => {
        data.state = 'queued';
        data.pauseReason = undefined;
        data.noResponseCycles = undefined;
        return true;
      });
    }
  }

  private fromCoordinatorMutation(
    outcome: 'accepted' | 'duplicate' | 'rejected',
    reason?: 'queue_full' | 'invalid_target' | 'entry_not_found' | 'active_entry' | 'version_conflict',
  ): QueuedStrategyMutationResult {
    return { outcome, reason, snapshot: this.getQueueSnapshot() };
  }

  private result(
    outcome: QueuedStrategyMutationResult['outcome'],
    reason?: QueuedStrategyMutationResult['reason'],
  ): QueuedStrategyMutationResult {
    return { outcome, reason, snapshot: this.getQueueSnapshot() };
  }

  private resultSnapshot(transmissions: ReturnType<AssistedQSOQueueRuntime['getTransmissions']>): StrategyDecisionResult {
    return {
      transmission: transmissions[0]?.text ?? null,
      transmissions,
      snapshot: this.getSnapshot(),
    };
  }

  private queueProjectionFingerprint(): string {
    const snapshot = this.getQueueSnapshot();
    return JSON.stringify({
      activeEntryIds: snapshot.activeEntryIds,
      maxActiveStreams: snapshot.maxActiveStreams,
      rows: snapshot.rows,
    });
  }
}
