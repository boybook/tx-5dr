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
  StrategyTransmitGate,
  StreamPhysicalReceipt,
} from '@tx5dr/plugin-api';
import { normalizeCallsign } from '@tx5dr/plugin-api';
import {
  FT8MessageParser,
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

export interface WWDigiRuntimeConfig extends WWDigiLaneConfig {
  frequency: number;
  transmitCycles: number[];
  parallelStreams: number;
  maxConcurrentStreams: number;
  cqMaxAttempts?: number;
  cqSelectionPolicy?: 'FIRST' | 'MAX_DISTANCE' | 'MAX_SNR' | 'MIN_SNR';
  authorizedStaleReceiveCycles?: number;
}

export interface WWDigiRuntimeOperator {
  readonly config: WWDigiRuntimeConfig;
  readonly isTransmitting: boolean;
  isTargetBeingWorkedByOthers(callsign: string): boolean;
  hasWorkedCallsign(callsign: string): Promise<boolean>;
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
  lastObservedSlotId?: string;
  previousTransmitting: boolean;
  startPurpose?: 'authorized-work' | 'recovery-work';
  exhaustedAtReceiveEpoch?: number;
  stopAttention?: StrategyAttention;
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
  private readonly callSession = new BoundedCallSessionController();
  private receiveEpoch = 0;
  private lastObservedSlotId?: string;
  private previousTransmitting = false;
  private startPurpose?: 'authorized-work' | 'recovery-work';
  private exhaustedAtReceiveEpoch?: number;
  private stopAttention?: StrategyAttention;

  constructor(
    private readonly operator: WWDigiRuntimeOperator,
    logger: PluginLogger,
    audioFrequenciesHz: readonly number[] | (() => readonly number[]),
    private readonly preflightMessage: (
      text: string,
      mode: 'FT8' | 'FT4',
    ) => Promise<{ encodable: boolean; error?: string; reason?: string }> = async () => ({ encodable: true }),
    private readonly snapshotExtension: () => WWDigiSnapshotExtension = () => ({}),
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
      createLane: ({ streamId, laneIndex }) => new WWDigiProtocolLane(
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
      ),
    });
  }

  checkpoint(): StrategyRuntimeCheckpoint {
    return {
      coordinator: this.coordinator.checkpoint(),
      callSession: this.callSession.checkpoint(),
      receiveEpoch: this.receiveEpoch,
      lastObservedSlotId: this.lastObservedSlotId,
      previousTransmitting: this.previousTransmitting,
      startPurpose: this.startPurpose,
      exhaustedAtReceiveEpoch: this.exhaustedAtReceiveEpoch,
      stopAttention: this.stopAttention,
    } satisfies RuntimeCheckpoint;
  }

  restore(checkpoint: StrategyRuntimeCheckpoint): void {
    const state = checkpoint as RuntimeCheckpoint;
    if (!state?.coordinator) throw new Error('Invalid WW Digi runtime checkpoint');
    this.coordinator.restore(state.coordinator);
    if (state.callSession) this.callSession.restore(state.callSession);
    this.receiveEpoch = state.receiveEpoch ?? 0;
    this.lastObservedSlotId = state.lastObservedSlotId;
    this.previousTransmitting = state.previousTransmitting === true;
    this.startPurpose = state.startPurpose;
    this.exhaustedAtReceiveEpoch = state.exhaustedAtReceiveEpoch;
    this.stopAttention = state.stopAttention;
  }

  observeDecodedMessages(messages: ParsedFT8Message[], meta: QueuedStrategyObservationMeta): boolean {
    if (!this.operator.isTransmitting) this.previousTransmitting = false;
    let changed = false;
    if (meta.slotInfo.id !== this.lastObservedSlotId) {
      this.lastObservedSlotId = meta.slotInfo.id;
      this.receiveEpoch += 1;
      changed = this.expireAuthorizations() || changed;
    }
    for (const message of messages) {
      if (message.isPartialDecode) continue;
      const sender = selectedSender(message.rawMessage);
      if (!sender.callsign) continue;
      const callsign = sender.callsign.trim().toUpperCase();
      const parsed = parseWWDigiMessage(message.rawMessage);
      let entry = this.coordinator.findEntryByTargetKey(targetKey(callsign));
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
          requestedTransmitCycle: ((meta.slotInfo.cycleNumber + 1) % 2) as 0 | 1,
          data: {
            status: 'candidate',
            source: 'cq',
            lastMessageRaw: message.rawMessage,
            lastSnr: message.snr,
            targetGrid: sender.grid,
            firstHeardAt: message.timestamp,
            firstAudioFrequencyHz: message.df,
            lastHeardReceiveEpoch: this.receiveEpoch,
            evidenceRevision: 1,
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
      if (!activeEntryIds.includes(entry.entryId)
          && entry.data.status === 'authorized' && targetCallsign
          && targetKey(targetCallsign) !== targetKey(this.operator.config.myCallsign)) {
        if (this.coordinator.updateEntry(entry.entryId, (data) => {
          data.status = 'paused';
          data.authorizationId = undefined;
          data.authorizedAt = undefined;
          data.authorizedReceiveEpoch = undefined;
          return true;
        })) changed = true;
        continue;
      }
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
        return updated;
      })) changed = true;
    }
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
    return this.mutationResult(this.coordinator.enqueue({
      targetKey: targetKey(callsign),
      callsign,
      requestedTransmitCycle,
      data: {
        authorizationId: randomUUID(),
        authorizedAt: Date.now(),
        authorizedReceiveEpoch: this.receiveEpoch,
        lastHeardReceiveEpoch: this.receiveEpoch,
        source: 'manual',
        evidenceRevision: 1,
        lastMessageRaw,
        lastSnr: request.lastMessage?.message.snr,
        targetGrid,
        status: requiresAlternate ? 'review' : 'authorized',
        encodingError: requiresAlternate ? 'special_callsign_requires_preflight' : undefined,
      },
    }));
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
    return { outcome: 'accepted', snapshot: this.getQueueSnapshot() };
  }

  removeTarget(entryId: string, expectedVersion: number): QueuedStrategyMutationResult {
    return this.mutationResult(this.coordinator.remove(entryId, expectedVersion));
  }

  clearTargets(expectedVersion: number): QueuedStrategyMutationResult {
    return this.mutationResult(this.coordinator.clear(expectedVersion));
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
        const displayState: AssistedQueueDisplayState = status === 'candidate' ? 'candidate'
          : status === 'dupe' ? 'dupe'
          : status === 'authorized' && !row.active ? 'authorized'
          : status === 'review' || stream?.currentState === 'review' ? 'review'
          : status === 'stale' || status === 'paused' ? 'paused'
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
            : status === 'review' || stream?.currentState === 'review' ? 'danger'
            : status === 'stale' || status === 'paused' ? 'warning'
            : status === 'no-response' ? 'warning'
              : row.active ? 'active' : 'neutral',
          icon: status === 'dupe' ? 'triangle-alert'
            : status === 'authorized' && !row.active ? 'check-circle'
            : status === 'review' || stream?.currentState === 'review' ? 'triangle-alert'
            : status === 'stale' || status === 'paused' ? 'pause'
            : status === 'no-response' ? 'clock'
              : row.active ? 'radio' : 'circle',
          targetGrid: row.entry.data.targetGrid,
          lastSnr: row.entry.data.lastSnr,
          lastHeardCyclesAgo: row.entry.data.lastHeardReceiveEpoch === undefined
            ? undefined
            : Math.max(0, this.receiveEpoch - row.entry.data.lastHeardReceiveEpoch),
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
    if (this.snapshotExtension().transmitGate) {
      this.previousTransmitting = false;
      return this.result({ stop: this.operator.isTransmitting });
    }
    if (!this.operator.isTransmitting) {
      this.previousTransmitting = false;
      return this.result();
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

    const decision = await this.coordinator.decide(messages, meta);
    for (const released of decision.releasedEntries) {
      if (released.disposition !== 'retain-entry') continue;
      this.coordinator.updateEntry(released.entryId, (data) => {
        data.status = 'no-response';
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
      return this.result({ stop: true });
    }
    const configuredCycle = this.operator.config.transmitCycles[0] === 1 ? 1 : 0;
    const fill = await this.coordinator.fillAvailableLanes({
      currentTransmitCycle: configuredCycle,
      isEligible: (entry) => entry.data.status === 'authorized'
        && !this.operator.isTargetBeingWorkedByOthers(entry.callsign),
    });
    const projected = this.result({
      qsoCompletions: decision.qsoCompletions,
      qsoFailures: decision.qsoFailures,
      requestedTransmitCycle: fill.requestedTransmitCycle,
    });
    if ((projected.transmissions?.length ?? 0) === 0 && this.shouldStopForIdle()) {
      const candidates = this.countCandidates();
      const invalid = this.countInvalidAuthorizations();
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
      || queue.entries.some((row) => row.entry.data.status === 'authorized' || row.entry.data.status === 'review');
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
        ...(this.stopAttention ? [this.stopAttention] : []),
        ...(extension.attentions ?? []),
      ],
      messagePresentation: extension.messagePresentation,
      transmitGate: extension.transmitGate,
    };
  }

  patchContext(_patch: Partial<StrategyRuntimeContext>): void {}
  setState(_state: StrategyRuntimeSlot): void {}
  setStreamState(update: StrategyStreamStateUpdate): void {
    this.coordinator.setStreamState(update.streamId, update.stateId, update.expectedLifecycleEpoch);
  }
  async invokeAction(invocation: StrategyActionInvocation): Promise<StrategyActionResult | void> {
    if (invocation.target.kind === 'runtime') {
      throw new Error('strategy_action_not_available');
    }
    if (invocation.target.kind === 'stream') {
      if (invocation.actionId === 'send-alternate') {
        const text = (invocation.payload as { value?: unknown } | undefined)?.value;
        if (typeof text !== 'string') throw new Error('alternate_message_invalid');
        const checked = await this.preflightMessage(text, this.operator.config.modeName);
        if (!checked.encodable) throw new Error(checked.error || checked.reason || 'alternate_message_not_encodable');
      }
      const result = await this.coordinator.invokeStreamAction(
        invocation.target.streamId,
        invocation.target.lifecycleEpoch,
        invocation.actionId,
        invocation.payload,
      );
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
      this.coordinator.remove(entry.entryId, invocation.target.queueVersion);
      return { requestDecision: true };
    }
    if (invocation.actionId === 'authorize-target' || invocation.actionId === 'authorize-dupe') {
      this.authorizeEntry(entry.entryId);
      this.stopAttention = undefined;
      const requestOperatorStart = !this.operator.isTransmitting;
      if (requestOperatorStart) {
        this.startPurpose = 'authorized-work';
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
        this.previousTransmitting = false;
      }
      return { requestDecision: true, requestOperatorStart };
    }
    if (invocation.actionId === 'retry-target' || invocation.actionId === 'reauthorize-target') {
      this.authorizeEntry(entry.entryId);
      const requestOperatorStart = !this.operator.isTransmitting;
      if (requestOperatorStart) {
        this.startPurpose = 'authorized-work';
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

  settleQSOCompletion(settlement: StrategyQSOCompletionSettlement): void {
    this.coordinator.settleQSOCompletion(settlement);
  }

  onTransmissionsCompleted(receipts: StreamPhysicalReceipt[]): void {
    if (receipts.some((receipt) => receipt.streamId === 'cq')
        && this.callSession.onPhysicalCallSuccess()
        && this.callSession.attemptsExhausted) {
      this.exhaustedAtReceiveEpoch = this.receiveEpoch;
    }
    this.coordinator.onPhysicalReceipts(receipts.filter((receipt) => receipt.streamId !== 'cq'));
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
    this.lastObservedSlotId = undefined;
    this.previousTransmitting = this.operator.isTransmitting;
    this.startPurpose = undefined;
    this.exhaustedAtReceiveEpoch = undefined;
    this.stopAttention = undefined;
  }

  private result(options: {
    qsoCompletions?: StrategyDecisionResult['qsoCompletions'];
    qsoFailures?: StrategyDecisionResult['qsoFailures'];
    requestedTransmitCycle?: number;
    stop?: boolean;
  } = {}): StrategyDecisionResult {
    return {
      transmission: null,
      transmissions: this.getTransmissions(),
      snapshot: this.getSnapshot(),
      qsoCompletions: options.qsoCompletions,
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

  private shouldStopForIdle(): boolean {
    if (this.callSession.state === 'calling' || this.callSession.state === 'collecting') return false;
    if (this.coordinator.getQueueSnapshot().activeEntryIds.length > 0) return false;
    return !this.coordinator.getQueueSnapshot().entries.some((row) => (
      row.entry.data.status === 'authorized' || row.entry.data.status === 'review'
    ));
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
