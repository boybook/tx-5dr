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
  StreamPhysicalReceipt,
} from '@tx5dr/plugin-api';
import { normalizeCallsign } from '@tx5dr/plugin-api';
import { FT8MessageParser, isValidCallsign, isUndecodedCallsignPlaceholder } from '@tx5dr/core';
import { ParallelQSOCoordinator } from '@tx5dr/plugin-api/toolkit';
import type { ParallelQueueMutationResult } from '@tx5dr/plugin-api/toolkit';
import { AuthorizationLease, ExplicitCQController } from '@tx5dr/plugin-api/toolkit';
import { buildWWDigiCQ, parseWWDigiMessage } from './protocol.js';
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
  authorizationReceiveCycles?: number;
}

export interface WWDigiRuntimeOperator {
  readonly config: WWDigiRuntimeConfig;
  readonly isTransmitting: boolean;
  isTargetBeingWorkedByOthers(callsign: string): boolean;
}

interface RuntimeCheckpoint {
  coordinator: ReturnType<ParallelQSOCoordinator<WWDigiEntryData>['checkpoint']>;
  cq: ReturnType<ExplicitCQController['checkpoint']>;
  receiveEpoch: number;
  lastObservedSlotId?: string;
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
  private readonly cq = new ExplicitCQController();
  private receiveEpoch = 0;
  private lastObservedSlotId?: string;

  constructor(
    private readonly operator: WWDigiRuntimeOperator,
    logger: PluginLogger,
    audioFrequenciesHz: readonly number[] | (() => readonly number[]),
    private readonly preflightMessage: (
      text: string,
      mode: 'FT8' | 'FT4',
    ) => Promise<{ encodable: boolean; error?: string; reason?: string }> = async () => ({ encodable: true }),
  ) {
    const resolveFrequencies = typeof audioFrequenciesHz === 'function'
      ? audioFrequenciesHz
      : () => audioFrequenciesHz;
    if (resolveFrequencies().length !== 3) throw new Error('WW Digi requires exactly three lane frequencies');
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
      cq: this.cq.checkpoint(),
      receiveEpoch: this.receiveEpoch,
      lastObservedSlotId: this.lastObservedSlotId,
    } satisfies RuntimeCheckpoint;
  }

  restore(checkpoint: StrategyRuntimeCheckpoint): void {
    const state = checkpoint as RuntimeCheckpoint;
    if (!state?.coordinator) throw new Error('Invalid WW Digi runtime checkpoint');
    this.coordinator.restore(state.coordinator);
    if (state.cq) this.cq.restore(state.cq);
    this.receiveEpoch = state.receiveEpoch ?? 0;
    this.lastObservedSlotId = state.lastObservedSlotId;
  }

  observeDecodedMessages(messages: ParsedFT8Message[], meta: QueuedStrategyObservationMeta): boolean {
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
      const entry = this.coordinator.findEntryByTargetKey(targetKey(sender.callsign));
      if (!entry) continue;
      if (this.coordinator.updateEntry(entry.entryId, (data) => {
        let updated = false;
        if (sender.grid && data.targetGrid !== sender.grid) {
          data.targetGrid = sender.grid;
          updated = true;
        }
        if (data.lastMessageRaw !== message.rawMessage) {
          data.lastMessageRaw = message.rawMessage;
          updated = true;
        }
        if (data.lastSnr !== message.snr) {
          data.lastSnr = message.snr;
          updated = true;
        }
        return updated;
      })) changed = true;
    }
    const observed = this.coordinator.observe(messages, meta);
    this.cq.setSuppressed(Boolean(this.coordinator.getStreams().some((stream) => (stream.attentions?.length ?? 0) > 0)));
    return observed || changed;
  }

  enqueueTarget(request: QueuedStrategyTargetRequest): QueuedStrategyMutationResult {
    const callsign = request.callsign.trim().toUpperCase();
    const permissiveCallsign = /^[A-Z0-9]+(?:\/[A-Z0-9]+)*$/.test(callsign)
      && /[A-Z]/.test(callsign) && /[0-9]/.test(callsign) && callsign.length <= 13;
    if (!permissiveCallsign
        || isUndecodedCallsignPlaceholder(callsign)
        || targetKey(callsign) === targetKey(this.operator.config.myCallsign)) {
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
        lastMessageRaw,
        lastSnr: request.lastMessage?.message.snr,
        targetGrid,
        status: requiresAlternate ? 'review' : 'queued',
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
      data.status = 'queued';
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
        const displayState: AssistedQueueDisplayState = status === 'review' || stream?.currentState === 'review' ? 'review'
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
          tone: status === 'review' || stream?.currentState === 'review' ? 'danger'
            : status === 'stale' || status === 'paused' ? 'warning'
            : status === 'no-response' ? 'warning'
              : row.active ? 'active' : 'neutral',
          icon: status === 'review' || stream?.currentState === 'review' ? 'triangle-alert'
            : status === 'stale' || status === 'paused' ? 'pause'
            : status === 'no-response' ? 'clock'
              : row.active ? 'radio' : 'circle',
          targetGrid: row.entry.data.targetGrid,
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
    if (!this.operator.isTransmitting) return this.result();

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
    const configuredCycle = this.operator.config.transmitCycles[0] === 1 ? 1 : 0;
    const fill = await this.coordinator.fillAvailableLanes({
      currentTransmitCycle: configuredCycle,
      isEligible: (entry) => entry.data.status === 'queued'
        && !this.operator.isTargetBeingWorkedByOthers(entry.callsign),
    });
    return this.result({
      qsoCompletions: decision.qsoCompletions,
      qsoFailures: decision.qsoFailures,
      requestedTransmitCycle: fill.requestedTransmitCycle,
    });
  }

  getTransmitText(): string | null {
    return this.getTransmissions()[0]?.text ?? null;
  }

  getTransmissions() {
    this.syncParallelStreams();
    if (!this.operator.isTransmitting) return [];
    const transmissions = this.coordinator.getTransmissions();
    if (transmissions.length > 0) return transmissions;
    if (this.coordinator.getQueueSnapshot().entries.length > 0) return [];
    if (!this.cq.shouldTransmit()) return [];
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
      actions: (['off', 'once', 'repeat'] as const).map((mode) => ({
        id: `cq-${mode}`,
        label: mode === 'off' ? 'cqOff' : mode === 'once' ? 'cqOnce' : 'cqRepeat',
        icon: mode === 'off' ? 'ban' : mode === 'once' ? 'tower-broadcast' : 'repeat',
        presentation: 'segmented' as const,
        groupId: 'cq-mode',
        selected: this.cq.currentMode === mode,
        tone: this.cq.currentMode === mode ? 'primary' as const : 'default' as const,
      })),
      attentions: streams.flatMap((stream) => stream.attentions ?? []),
    };
  }

  patchContext(_patch: Partial<StrategyRuntimeContext>): void {}
  setState(_state: StrategyRuntimeSlot): void {}
  setStreamState(update: StrategyStreamStateUpdate): void {
    this.coordinator.setStreamState(update.streamId, update.stateId, update.expectedLifecycleEpoch);
  }
  async invokeAction(invocation: StrategyActionInvocation): Promise<StrategyActionResult | void> {
    if (invocation.target.kind === 'runtime') {
      const mode = invocation.actionId.replace(/^cq-/, '');
      if (mode !== 'off' && mode !== 'once' && mode !== 'repeat') throw new Error('strategy_action_not_available');
      this.cq.setMode(mode);
      return { requestDecision: true, outcome: { code: `cq_${mode}` } };
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
      return result;
    }
    const entry = this.coordinator.getEntry(invocation.target.entryId);
    if (!entry) throw new Error('entry_not_found');
    if (invocation.actionId === 'end-queued-target') {
      this.coordinator.remove(entry.entryId, invocation.target.queueVersion);
      return { requestDecision: true };
    }
    if (invocation.actionId === 'set-alternate-and-authorize') {
      const text = (invocation.payload as { value?: unknown } | undefined)?.value;
      if (typeof text !== 'string') throw new Error('alternate_message_invalid');
      const normalized = text.trim().toUpperCase().replace(/\s+/g, ' ');
      const checked = await this.preflightMessage(normalized, this.operator.config.modeName);
      if (!checked.encodable) throw new Error(checked.error || checked.reason || 'alternate_message_not_encodable');
      this.authorizeEntry(entry.entryId, { alternateText: normalized });
      return { requestDecision: true };
    }
    if (invocation.actionId === 'retry-target' || invocation.actionId === 'reauthorize-target') {
      this.authorizeEntry(entry.entryId);
      return { requestDecision: true };
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
    if (receipts.some((receipt) => receipt.streamId === 'cq')) this.cq.onPhysicalSuccess();
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
    this.cq.setMode('off');
    this.cq.setSuppressed(false);
    this.receiveEpoch = 0;
    this.lastObservedSlotId = undefined;
  }

  private result(options: {
    qsoCompletions?: StrategyDecisionResult['qsoCompletions'];
    qsoFailures?: StrategyDecisionResult['qsoFailures'];
    requestedTransmitCycle?: number;
  } = {}): StrategyDecisionResult {
    return {
      transmission: null,
      transmissions: this.getTransmissions(),
      snapshot: this.getSnapshot(),
      qsoCompletions: options.qsoCompletions,
      qsoFailures: options.qsoFailures,
      requestedTransmitCycle: options.requestedTransmitCycle,
      stop: false,
    };
  }

  private syncParallelStreams(): void {
    const streams = this.parallelStreams();
    if (streams === this.coordinator.getMaxStreams()) return;
    const preemptedEntryIds = this.coordinator.setMaxStreams(streams, { preemptExcess: true });
    for (const entryId of preemptedEntryIds) {
      this.coordinator.updateEntry(entryId, (data) => {
        data.status = 'queued';
        return true;
      });
    }
  }

  private requestedParallelStreams(): number {
    return Math.max(1, Math.min(3, Math.trunc(this.operator.config.parallelStreams || 1)));
  }

  private queueActions(entry: import('@tx5dr/plugin-api/toolkit').ParallelQSOQueueEntry<WWDigiEntryData>) {
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
    const expiry = Math.max(1, Math.min(20, Math.trunc(this.operator.config.authorizationReceiveCycles ?? 4)));
    for (const row of this.coordinator.getQueueSnapshot().entries) {
      if (row.active || row.entry.data.status !== 'queued') continue;
      const authorizedAt = row.entry.data.authorizedReceiveEpoch ?? this.receiveEpoch;
      const lease = new AuthorizationLease({
        authorizationId: row.entry.data.authorizationId,
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
      data.status = 'queued';
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
