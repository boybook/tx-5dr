import type {
  AssistedQueueDisplayState,
  AssistedQueuePauseReason,
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
  SlotInfo,
} from '@tx5dr/plugin-api';
import { FT8MessageType, normalizeCallsign } from '@tx5dr/plugin-api';
import {
  FT8MessageParser,
  isValidCallsign,
  isUndecodedCallsignPlaceholder,
} from '@tx5dr/core';
import {
  StandardQSOPluginRuntime,
  type StandardQSOPluginOperator,
} from '../standard-qso/StandardQSOPluginRuntime.js';

const MAX_QUEUE_SIZE = 64;
const STALE_AFTER_MODE_SLOTS = 6;
const INACTIVE_AFTER_MODE_SLOTS = 12;

type PendingSlot = Exclude<StrategyRuntimeSlot, 'TX6'>;
type QueueEntryState = 'queued' | 'active' | 'engaged' | 'closing' | 'paused' | 'no-response' | 'review';

interface PendingContext {
  revision: number;
  nextLocalTxSlot: PendingSlot | null;
  hasDirectEvidence: boolean;
  lastMessage?: { message: FrameMessage; slotInfo: SlotInfo };
  validUntil: number;
}

interface QueueEntry {
  entryId: string;
  targetKey: string;
  callsign: string;
  source: 'manual' | 'inbound-direct';
  state: QueueEntryState;
  pending: PendingContext;
  delegateAppliedPendingRevision: number;
  pauseReason?: AssistedQueuePauseReason;
  noResponseCycles?: number;
  targetGrid?: string;
  lastSnr?: number;
  lastHeardAt?: number;
  logCommitted: boolean;
  delegateReleased: boolean;
  lastOnAirSlot?: PendingSlot;
  lastOnAirLifecycleEpoch?: number;
  pendingSettlement?: { lifecycleEpoch: number; recordId: string };
}

interface QueueCheckpoint {
  version: number;
  nextEntrySequence: number;
  entries: QueueEntry[];
  activeEntryId?: string;
  lastQueueFullWarningAt: number;
  latestSlotStartMs: number;
  delegate: StrategyRuntimeCheckpoint;
}

export interface AssistedQSOQueueRuntimeOptions {
  operator: StandardQSOPluginOperator;
  isTransmitting: () => boolean;
  logger: PluginLogger;
}

function normalized(value: string | undefined): string {
  if (!value) return '';
  const upper = value.trim().toUpperCase();
  return normalizeCallsign(upper) || upper;
}

function callsignMatches(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left && right && normalized(left) === normalized(right));
}

function senderOf(message: ParsedFT8Message): string | undefined {
  const sender = (message.message as { senderCallsign?: unknown }).senderCallsign;
  return typeof sender === 'string' && sender.trim() ? sender.trim().toUpperCase() : undefined;
}

function targetOf(message: ParsedFT8Message): string | undefined {
  const target = (message.message as { targetCallsign?: unknown }).targetCallsign;
  return typeof target === 'string' && target.trim() ? target.trim().toUpperCase() : undefined;
}

function gridOf(message: ParsedFT8Message): string | undefined {
  const directGrid = (message.message as { grid?: unknown }).grid;
  if (typeof directGrid === 'string' && directGrid.trim()) return directGrid.trim().toUpperCase();
  const analyzedGrid = message.logbookAnalysis?.grid;
  return typeof analyzedGrid === 'string' && analyzedGrid.trim()
    ? analyzedGrid.trim().toUpperCase()
    : undefined;
}

function isDirectedTo(message: ParsedFT8Message, callsign: string): boolean {
  if (callsignMatches(targetOf(message), callsign)) return true;
  if (message.message.type !== FT8MessageType.FOX_RR73) return false;
  const completed = (message.message as { completedCallsign?: unknown }).completedCallsign;
  return typeof completed === 'string' && callsignMatches(completed, callsign);
}

function slotInfoFromMessage(message: ParsedFT8Message, modeName: string, slotMs: number): SlotInfo {
  return {
    id: message.slotId,
    startMs: message.timestamp,
    utcSeconds: Math.floor(message.timestamp / 1000),
    phaseMs: 0,
    driftMs: 0,
    cycleNumber: Math.floor(message.timestamp / slotMs) % 2,
    mode: modeName,
  };
}

function lastMessageFromParsed(message: ParsedFT8Message, modeName: string, slotMs: number) {
  return {
    message: {
      message: message.rawMessage,
      snr: message.snr,
      dt: message.dt,
      freq: message.df,
      confidence: 1,
    } as FrameMessage,
    slotInfo: slotInfoFromMessage(message, modeName, slotMs),
  };
}

function parsedFromLastMessage(lastMessage: { message: FrameMessage; slotInfo: SlotInfo }): ParsedFT8Message {
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

function pendingSlotForMessage(
  message: ParsedFT8Message,
  myCallsign: string,
  fallback: PendingSlot,
): PendingSlot | null {
  const direct = isDirectedTo(message, myCallsign);
  if (!direct) {
    return message.message.type === FT8MessageType.CQ ? 'TX1' : fallback;
  }
  switch (message.message.type) {
    case FT8MessageType.CALL: return 'TX2';
    case FT8MessageType.SIGNAL_REPORT: return 'TX3';
    case FT8MessageType.ROGER_REPORT: return 'TX4';
    case FT8MessageType.RRR: return 'TX5';
    case FT8MessageType.SEVENTY_THREE: return null;
    case FT8MessageType.FOX_RR73: return null;
    default: return fallback;
  }
}

export class AssistedQSOQueueRuntime implements QueuedStrategyRuntime {
  private readonly delegate: StandardQSOPluginRuntime;
  private readonly operator: StandardQSOPluginOperator;
  private readonly isTransmitting: () => boolean;
  private readonly logger: PluginLogger;
  private entries: QueueEntry[] = [];
  private activeEntryId?: string;
  private version = 0;
  private nextEntrySequence = 0;
  private lastQueueFullWarningAt = Number.NEGATIVE_INFINITY;
  private latestSlotStartMs = 0;

  constructor(options: AssistedQSOQueueRuntimeOptions) {
    this.operator = options.operator;
    this.isTransmitting = options.isTransmitting;
    this.logger = options.logger;
    this.delegate = new StandardQSOPluginRuntime(options.operator, options.logger);
  }

  checkpoint(): StrategyRuntimeCheckpoint {
    return {
      version: this.version,
      nextEntrySequence: this.nextEntrySequence,
      entries: structuredClone(this.entries),
      activeEntryId: this.activeEntryId,
      lastQueueFullWarningAt: this.lastQueueFullWarningAt,
      latestSlotStartMs: this.latestSlotStartMs,
      delegate: structuredClone(this.delegate.checkpoint()),
    } satisfies QueueCheckpoint;
  }

  restore(checkpoint: StrategyRuntimeCheckpoint): void {
    const state = checkpoint as QueueCheckpoint;
    if (!state || !Array.isArray(state.entries)) throw new Error('Invalid assisted queue checkpoint');
    this.version = state.version;
    this.nextEntrySequence = state.nextEntrySequence;
    this.entries = structuredClone(state.entries);
    this.activeEntryId = state.activeEntryId;
    this.lastQueueFullWarningAt = state.lastQueueFullWarningAt ?? Number.NEGATIVE_INFINITY;
    this.latestSlotStartMs = state.latestSlotStartMs ?? 0;
    this.delegate.restore(state.delegate);
  }

  observeDecodedMessages(messages: ParsedFT8Message[], meta: QueuedStrategyObservationMeta): boolean {
    if (meta.signal.aborted) return false;
    const before = this.queueProjectionFingerprint();
    this.latestSlotStartMs = Math.max(this.latestSlotStartMs, meta.slotInfo.startMs);
    this.updatePauseStates(meta.slotInfo.startMs);
    const mode = this.operator.config.mode;
    const fallback = this.operator.config.skipTx1 === true ? 'TX2' : 'TX1';

    for (const message of messages) {
      if (message.isPartialDecode) continue;
      const sender = senderOf(message);
      if (!sender || !isValidCallsign(sender) || isUndecodedCallsignPlaceholder(sender)) continue;
      if (callsignMatches(sender, this.operator.config.myCallsign)) continue;
      const key = normalized(sender);
      const direct = isDirectedTo(message, this.operator.config.myCallsign);
      let entry = this.entries.find((candidate) => candidate.targetKey === key);

      if (!entry && direct && (
        message.message.type === FT8MessageType.CALL
        || message.message.type === FT8MessageType.SIGNAL_REPORT
      )) {
        if (this.entries.length >= MAX_QUEUE_SIZE) {
          if (message.timestamp - this.lastQueueFullWarningAt >= mode.slotMs * 2) {
            this.lastQueueFullWarningAt = message.timestamp;
            this.logger.warn('Ignoring inbound caller because the assisted queue is full', { callsign: sender });
          }
          continue;
        }
        entry = this.createEntry(sender, 'inbound-direct', fallback);
        this.entries.push(entry);
      }
      if (!entry || entry.state === 'review') continue;

      const relevantCq = message.message.type === FT8MessageType.CQ;
      const existingTarget = callsignMatches(sender, entry.callsign);
      if (!existingTarget) continue;
      const wasPriorityInbound = this.isPriorityInboundEntry(entry);
      const recoversFromObservation = entry.state === 'paused' || entry.state === 'no-response';
      entry.lastHeardAt = message.timestamp;
      entry.lastSnr = message.snr;
      entry.targetGrid = gridOf(message) ?? entry.targetGrid;
      entry.pending.validUntil = message.timestamp + mode.slotMs * STALE_AFTER_MODE_SLOTS;

      const correlatedProtocol = direct && this.hasProtocolCorrelation(entry, message.message.type);
      const canRefreshContext = relevantCq || (direct && (
        message.message.type === FT8MessageType.CALL
        || message.message.type === FT8MessageType.SIGNAL_REPORT
        || correlatedProtocol
      ));
      if (recoversFromObservation) {
        entry.state = 'queued';
        entry.pauseReason = undefined;
        entry.noResponseCycles = undefined;
        if (!canRefreshContext) {
          entry.pending = {
            revision: entry.pending.revision + 1,
            nextLocalTxSlot: fallback,
            hasDirectEvidence: false,
            validUntil: message.timestamp + mode.slotMs * STALE_AFTER_MODE_SLOTS,
          };
        }
      }
      if (canRefreshContext) {
        const nextSlot = pendingSlotForMessage(message, this.operator.config.myCallsign, fallback);
        const nextRaw = message.rawMessage;
        const previousRaw = entry.pending.lastMessage?.message.message;
        const previousSlot = entry.pending.lastMessage?.slotInfo.startMs;
        if (nextRaw !== previousRaw || previousSlot !== message.timestamp || entry.pending.nextLocalTxSlot !== nextSlot) {
          entry.pending = {
            revision: entry.pending.revision + 1,
            nextLocalTxSlot: nextSlot,
            hasDirectEvidence: direct,
            lastMessage: lastMessageFromParsed(message, mode.name, mode.slotMs),
            validUntil: message.timestamp + mode.slotMs * STALE_AFTER_MODE_SLOTS,
          };
        }
        if (!wasPriorityInbound && this.isPriorityInboundEntry(entry)) {
          this.promotePriorityInbound(entry.entryId);
        }
      } else if (!direct && targetOf(message)) {
        if (entry.entryId === this.activeEntryId && entry.state === 'active') {
          this.pauseEntry(entry, 'target-busy');
          this.activeEntryId = undefined;
          this.delegate.reset('assisted queue target started working another station');
        } else if (entry.entryId !== this.activeEntryId
          && entry.state !== 'paused'
          && entry.state !== 'no-response') {
          this.pauseEntry(entry, 'target-busy');
        }
      }

      if (entry.entryId === this.activeEntryId && direct && (
        message.message.type === FT8MessageType.SIGNAL_REPORT || correlatedProtocol
      )) {
        if (
          message.message.type === FT8MessageType.SIGNAL_REPORT
          || message.message.type === FT8MessageType.ROGER_REPORT
          || message.message.type === FT8MessageType.RRR
        ) {
          if (entry.state !== 'engaged' && entry.state !== 'closing') {
            entry.state = message.message.type === FT8MessageType.RRR ? 'closing' : 'engaged';
          }
        } else if (message.message.type === FT8MessageType.SEVENTY_THREE
          || message.message.type === FT8MessageType.FOX_RR73) {
          entry.state = 'closing';
        }
      }
    }
    return this.bumpVersionIfProjectionChanged(before);
  }

  enqueueTarget(request: QueuedStrategyTargetRequest): QueuedStrategyMutationResult {
    const callsign = request.callsign.trim().toUpperCase();
    if (!isValidCallsign(callsign) || isUndecodedCallsignPlaceholder(callsign)) {
      return this.result('rejected', 'invalid_target');
    }
    if (callsignMatches(callsign, this.operator.config.myCallsign)) return this.result('rejected', 'invalid_target');
    const targetKey = normalized(callsign);
    if (this.entries.some((entry) => entry.targetKey === targetKey)) return this.result('duplicate');
    if (this.entries.length >= MAX_QUEUE_SIZE) return this.result('rejected', 'queue_full');

    const fallback = this.operator.config.skipTx1 === true ? 'TX2' : 'TX1';
    const entry = this.createEntry(callsign, 'manual', fallback);
    if (request.lastMessage) {
      const parsed = FT8MessageParser.parseMessage(request.lastMessage.message.message);
      const selectedSender = 'senderCallsign' in parsed ? parsed.senderCallsign : undefined;
      const direct = callsignMatches(
        (parsed as { targetCallsign?: string }).targetCallsign,
        this.operator.config.myCallsign,
      );
      const type = parsed.type;
      if (callsignMatches(selectedSender, callsign)) {
        const selectedGrid = (parsed as { grid?: unknown }).grid;
        entry.targetGrid = typeof selectedGrid === 'string' && selectedGrid.trim()
          ? selectedGrid.trim().toUpperCase()
          : undefined;
        entry.lastSnr = request.lastMessage.message.snr;
        entry.lastHeardAt = request.lastMessage.slotInfo.startMs;
        this.latestSlotStartMs = Math.max(this.latestSlotStartMs, request.lastMessage.slotInfo.startMs);
        entry.pending.nextLocalTxSlot = direct && type === FT8MessageType.CALL
          ? 'TX2'
          : direct && type === FT8MessageType.SIGNAL_REPORT
            ? 'TX3'
            : fallback;
        entry.pending.hasDirectEvidence = direct && (
          type === FT8MessageType.CALL || type === FT8MessageType.SIGNAL_REPORT
        );
        entry.pending.lastMessage = structuredClone(request.lastMessage);
        entry.pending.validUntil = request.lastMessage.slotInfo.startMs
          + this.operator.config.mode.slotMs * STALE_AFTER_MODE_SLOTS;
      }
    }
    this.entries.push(entry);
    if (this.isPriorityInboundEntry(entry)) this.promotePriorityInbound(entry.entryId);
    this.bumpVersion();
    return this.result('accepted');
  }

  reorderTarget(entryId: string, beforeEntryId: string | null, expectedVersion: number): QueuedStrategyMutationResult {
    if (expectedVersion !== this.version) return this.result('rejected', 'version_conflict');
    if (entryId === this.activeEntryId) return this.result('rejected', 'active_entry');
    const from = this.entries.findIndex((entry) => entry.entryId === entryId);
    if (from < 0) return this.result('rejected', 'entry_not_found');
    if (beforeEntryId === entryId) return this.result('accepted');
    if (beforeEntryId && !this.entries.some((entry) => entry.entryId === beforeEntryId)) {
      return this.result('rejected', 'entry_not_found');
    }
    const before = this.queueProjectionFingerprint();
    const [entry] = this.entries.splice(from, 1);
    const target = beforeEntryId ? this.entries.findIndex((candidate) => candidate.entryId === beforeEntryId) : -1;
    const minimum = this.activeEntryId && this.entries[0]?.entryId === this.activeEntryId ? 1 : 0;
    const insertAt = target < 0 ? this.entries.length : Math.max(minimum, target);
    this.entries.splice(insertAt, 0, entry);
    this.bumpVersionIfProjectionChanged(before);
    return this.result('accepted');
  }

  retryTarget(entryId: string, expectedVersion: number): QueuedStrategyMutationResult {
    if (expectedVersion !== this.version) return this.result('rejected', 'version_conflict');
    const entry = this.entries.find((candidate) => candidate.entryId === entryId);
    if (!entry) return this.result('rejected', 'entry_not_found');
    if (entry.state !== 'no-response' || entry.noResponseCycles === undefined) {
      return this.result('rejected', 'entry_not_retryable');
    }

    const fallback = this.operator.config.skipTx1 === true ? 'TX2' : 'TX1';
    entry.state = 'queued';
    entry.noResponseCycles = undefined;
    entry.pauseReason = undefined;
    entry.lastOnAirSlot = undefined;
    entry.lastOnAirLifecycleEpoch = undefined;
    entry.pendingSettlement = undefined;
    entry.logCommitted = false;
    entry.delegateReleased = false;
    entry.pending = {
      revision: entry.pending.revision + 1,
      nextLocalTxSlot: fallback,
      hasDirectEvidence: false,
      validUntil: Number.POSITIVE_INFINITY,
    };
    this.bumpVersion();
    return this.result('accepted');
  }

  removeTarget(entryId: string, expectedVersion: number): QueuedStrategyMutationResult {
    if (expectedVersion !== this.version) return this.result('rejected', 'version_conflict');
    const index = this.entries.findIndex((entry) => entry.entryId === entryId);
    if (index < 0) return this.result('rejected', 'entry_not_found');
    const active = entryId === this.activeEntryId;
    this.entries.splice(index, 1);
    if (active) {
      this.activeEntryId = undefined;
      this.delegate.reset('assisted queue active target removed by operator');
    }
    this.bumpVersion();
    return this.result('accepted');
  }

  clearTargets(expectedVersion: number): QueuedStrategyMutationResult {
    if (expectedVersion !== this.version) return this.result('rejected', 'version_conflict');
    if (this.entries.length === 0) return this.result('accepted');

    this.entries = [];
    this.activeEntryId = undefined;
    this.delegate.reset('assisted queue cleared by operator');
    this.bumpVersion();
    return this.result('accepted');
  }

  getQueueSnapshot(): AssistedQueueSnapshot {
    const ordered = this.activeEntryId
      ? [
          ...this.entries.filter((entry) => entry.entryId === this.activeEntryId),
          ...this.entries.filter((entry) => entry.entryId !== this.activeEntryId),
        ]
      : [...this.entries];
    return {
      version: this.version,
      activeEntryId: this.activeEntryId,
      rows: ordered.map((entry, order) => {
        const displayState = this.displayState(entry);
        const active = entry.entryId === this.activeEntryId;
        return {
          entryId: entry.entryId,
          callsign: entry.callsign,
          order,
          draggable: !active,
          displayState,
          tone: entry.state === 'review' ? 'danger'
            : entry.state === 'closing' ? 'warning'
              : entry.state === 'no-response' ? 'warning'
              : entry.state === 'engaged' ? 'success'
                : active ? 'active'
                  : 'neutral',
          icon: entry.state === 'review' ? 'triangle-alert'
            : entry.state === 'closing' ? 'loader-circle'
              : entry.state === 'engaged' ? 'check-circle'
                : entry.state === 'paused' ? 'pause'
                  : entry.state === 'no-response' ? 'clock'
                  : active ? 'radio'
                    : 'circle',
          pauseReason: entry.pauseReason,
          noResponseCycles: entry.noResponseCycles,
          targetGrid: entry.targetGrid,
          lastSnr: entry.lastSnr,
          lastHeardCyclesAgo: entry.lastHeardAt === undefined
            ? undefined
            : Math.max(0, Math.floor(
              (this.latestSlotStartMs - entry.lastHeardAt) / this.operator.config.mode.slotMs,
            )),
        };
      }),
    };
  }

  async decide(messages: ParsedFT8Message[], meta: StrategyDecisionMetaV2): Promise<StrategyDecisionResult> {
    if (meta.signal.aborted) throw new DOMException('Strategy decision aborted', 'AbortError');
    const before = this.queueProjectionFingerprint();
    this.updatePauseStates(Date.now());
    if (!this.isTransmitting()) {
      this.bumpVersionIfProjectionChanged(before);
      return this.resultSnapshot(null);
    }

    let requestedTransmitCycle: number | undefined;
    const active = this.getActiveEntry();
    if (active && active.state === 'active' && this.canPreemptActive(active)) {
      const opportunity = await this.selectEligibleDirectOpportunity(active.entryId);
      if (opportunity) requestedTransmitCycle = this.preemptActive(opportunity);
    }
    if (!this.activeEntryId) {
      const candidate = await this.selectEligibleCandidate();
      if (candidate) requestedTransmitCycle = this.activate(candidate);
    }

    const current = this.getActiveEntry();
    if (!current) {
      this.bumpVersionIfProjectionChanged(before);
      return this.resultSnapshot(this.getIdleCQText());
    }
    const pendingMessage = current.pending.lastMessage
      && current.delegateAppliedPendingRevision < current.pending.revision
      ? parsedFromLastMessage(current.pending.lastMessage)
      : undefined;
    if (pendingMessage) {
      requestedTransmitCycle ??= (current.pending.lastMessage!.slotInfo.cycleNumber + 1) % 2;
    }
    const decisionMessages = pendingMessage && !messages.some((message) => (
      message.rawMessage === pendingMessage.rawMessage && message.timestamp === pendingMessage.timestamp
    )) ? [...messages, pendingMessage] : messages;
    const relevant = decisionMessages.filter((message) => {
      const sender = senderOf(message);
      return this.isEligibleActiveMessage(current, message) && (
        message.message.type === FT8MessageType.FOX_RR73
        || callsignMatches(sender, current.callsign)
        || message.rawMessage.toUpperCase().includes(current.callsign.toUpperCase())
      );
    });
    const decision = await this.delegate.decide(relevant, meta);
    if (pendingMessage) current.delegateAppliedPendingRevision = current.pending.revision;
    const snapshot = decision.snapshot;
    if (decision.qsoCompletion) {
      current.state = 'closing';
      current.pendingSettlement = {
        lifecycleEpoch: decision.qsoCompletion.lifecycleEpoch,
        recordId: decision.qsoCompletion.record.id,
      };
    }
    if (snapshot.currentState === 'TX4' || snapshot.currentState === 'TX5') current.state = 'closing';
    else if (snapshot.context?.reportReceived !== undefined && current.state === 'active') current.state = 'engaged';

    if (decision.qsoFailure) {
      this.markNoResponse(current, decision.qsoFailure);
      this.bumpVersionIfProjectionChanged(before);
      return this.resultSnapshot(this.getTransmitText(), { qsoFailure: decision.qsoFailure });
    }
    if (decision.stop && !snapshot.context?.targetCallsign) {
      current.delegateReleased = true;
      if (current.logCommitted) {
        this.completeActive(current);
        const candidate = this.selectCandidate();
        if (candidate) requestedTransmitCycle = this.activate(candidate);
      } else if (!current.pendingSettlement && !decision.qsoCompletion) {
        this.markNoResponse(current);
      }
      this.bumpVersionIfProjectionChanged(before);
      return this.resultSnapshot(this.getTransmitText(), {
        qsoCompletion: decision.qsoCompletion,
        silentListen: decision.silentListen,
        requestedTransmitCycle,
      });
    }
    this.bumpVersionIfProjectionChanged(before);
    return {
      ...decision,
      stop: false,
      silentListen: undefined,
      transmission: this.getTransmitText(),
      snapshot: this.getSnapshot(),
      requestedTransmitCycle,
    };
  }

  getTransmitText(): string | null {
    if (!this.isTransmitting()) return null;
    if (!this.activeEntryId) return this.getIdleCQText();
    const entry = this.getActiveEntry();
    if (!entry
      || entry.delegateReleased
      || entry.state === 'paused'
      || entry.state === 'no-response'
      || entry.state === 'review') return null;
    return this.delegate.getTransmitText();
  }

  requestCall(callsign: string, lastMessage?: { message: FrameMessage; slotInfo: SlotInfo }): boolean {
    return this.enqueueTarget({ callsign, lastMessage }).outcome !== 'rejected';
  }

  getSnapshot(): StrategyRuntimeSnapshot {
    const delegate = this.delegate.getSnapshot();
    return { ...delegate, queue: this.getQueueSnapshot() };
  }

  patchContext(patch: Partial<StrategyRuntimeContext>): void { this.delegate.patchContext(patch); }
  setState(state: StrategyRuntimeSlot): void { this.delegate.setState(state); }
  setSlotContent(update: StrategyRuntimeSlotContentUpdate): void { this.delegate.setSlotContent(update); }

  settleQSOCompletion(settlement: StrategyQSOCompletionSettlement): void {
    const before = this.queueProjectionFingerprint();
    this.delegate.settleQSOCompletion(settlement);
    const entry = this.entries.find((candidate) => (
      candidate.pendingSettlement?.lifecycleEpoch === settlement.lifecycleEpoch
      && candidate.pendingSettlement.recordId === settlement.recordId
    ));
    if (!entry) return;
    if (settlement.status === 'committed') {
      entry.logCommitted = true;
      if (entry.delegateReleased) this.completeActive(entry);
    } else {
      entry.state = 'review';
    }
    entry.pendingSettlement = undefined;
    this.bumpVersionIfProjectionChanged(before);
  }

  onTransmissionQueued(transmission: string): void {
    const entry = this.getActiveEntry();
    const snapshot = this.delegate.getSnapshot();
    if (entry) {
      const matchingSlot = (Object.entries(snapshot.slots ?? {}) as Array<[StrategyRuntimeSlot, string]>)
        .find(([, text]) => text === transmission)?.[0];
      if (matchingSlot && matchingSlot !== 'TX6') {
        entry.lastOnAirSlot = matchingSlot;
        entry.lastOnAirLifecycleEpoch = snapshot.qsoLifecycleEpoch;
      }
    }
    this.delegate.onTransmissionQueued(transmission);
  }

  reset(reason?: string): void {
    this.entries = [];
    this.activeEntryId = undefined;
    this.version = 0;
    this.nextEntrySequence = 0;
    this.lastQueueFullWarningAt = Number.NEGATIVE_INFINITY;
    this.latestSlotStartMs = 0;
    this.delegate.reset(reason);
  }

  private createEntry(callsign: string, source: QueueEntry['source'], fallback: PendingSlot): QueueEntry {
    return {
      entryId: `queue-${++this.nextEntrySequence}`,
      targetKey: normalized(callsign),
      callsign: callsign.trim().toUpperCase(),
      source,
      state: 'queued',
      pending: {
        revision: 0,
        nextLocalTxSlot: fallback,
        hasDirectEvidence: false,
        validUntil: Number.POSITIVE_INFINITY,
      },
      delegateAppliedPendingRevision: 0,
      logCommitted: false,
      delegateReleased: false,
    };
  }

  private selectCandidate(): QueueEntry | undefined {
    const ready = this.entries.filter((entry) => entry.state === 'queued'
      && entry.pending.nextLocalTxSlot !== null
      && !this.operator.isTargetBeingWorkedByOthers(entry.callsign));
    return ready[0];
  }

  private async selectEligibleCandidate(): Promise<QueueEntry | undefined> {
    return this.selectEligibleEntry(() => this.selectCandidate());
  }

  private getIdleCQText(): string | null {
    if (this.activeEntryId || this.selectCandidate()) return null;
    if (this.entries.some((entry) => (
      entry.state === 'review'
      || entry.state === 'closing'
      || entry.pendingSettlement !== undefined
    ))) return null;
    return this.delegate.getIdleCQText();
  }

  private isPriorityInboundEntry(entry: QueueEntry): boolean {
    return entry.state === 'queued'
      && entry.pending.hasDirectEvidence
      && (entry.pending.nextLocalTxSlot === 'TX2' || entry.pending.nextLocalTxSlot === 'TX3');
  }

  private promotePriorityInbound(entryId: string): void {
    if (entryId === this.activeEntryId) return;
    const from = this.entries.findIndex((entry) => entry.entryId === entryId);
    if (from < 0) return;
    const [entry] = this.entries.splice(from, 1);
    let insertAt = this.activeEntryId
      ? Math.max(0, this.entries.findIndex((candidate) => candidate.entryId === this.activeEntryId) + 1)
      : 0;
    while (insertAt < this.entries.length && this.isPriorityInboundEntry(this.entries[insertAt]!)) {
      insertAt += 1;
    }
    this.entries.splice(insertAt, 0, entry);
  }

  private selectDirectOpportunity(excludeEntryId: string): QueueEntry | undefined {
    return this.entries.find((entry) => entry.entryId !== excludeEntryId
      && entry.state === 'queued'
      && entry.pending.hasDirectEvidence
      && (entry.pending.nextLocalTxSlot === 'TX2' || entry.pending.nextLocalTxSlot === 'TX3')
      && !this.operator.isTargetBeingWorkedByOthers(entry.callsign));
  }

  private async selectEligibleDirectOpportunity(excludeEntryId: string): Promise<QueueEntry | undefined> {
    return this.selectEligibleEntry(() => this.selectDirectOpportunity(excludeEntryId));
  }

  private async selectEligibleEntry(select: () => QueueEntry | undefined): Promise<QueueEntry | undefined> {
    let entry = select();
    while (entry) {
      if (entry.source !== 'inbound-direct' || this.operator.config.replyToWorkedStations) {
        return entry;
      }
      if (!await this.operator.hasWorkedCallsign(entry.callsign)) {
        return entry;
      }

      this.logger.debug('Removing automatically queued caller already worked under current settings', {
        callsign: entry.callsign,
      });
      const entryId = entry.entryId;
      this.entries = this.entries.filter((candidate) => candidate.entryId !== entryId);
      entry = select();
    }
    return undefined;
  }

  private canPreemptActive(entry: QueueEntry): boolean {
    return this.delegate.getSnapshot().currentState === 'TX1'
      && entry.pending.hasDirectEvidence === false;
  }

  private activate(entry: QueueEntry): number | undefined {
    this.delegate.reset('assisted queue target activation');
    const activation = this.delegate.activateTarget({
      callsign: entry.callsign,
      lastMessage: entry.pending.lastMessage,
    });
    if (!activation.accepted || activation.initialSlot !== entry.pending.nextLocalTxSlot) {
      entry.state = 'review';
      this.delegate.reset('assisted queue activation rejected');
      return undefined;
    }
    const entryIndex = this.entries.findIndex((candidate) => candidate.entryId === entry.entryId);
    if (entryIndex > 0) {
      this.entries.splice(entryIndex, 1);
      this.entries.unshift(entry);
    }
    this.activeEntryId = entry.entryId;
    entry.state = 'active';
    entry.logCommitted = false;
    entry.delegateReleased = false;
    entry.lastOnAirLifecycleEpoch = activation.lifecycleEpoch;
    entry.pendingSettlement = undefined;
    entry.delegateAppliedPendingRevision = entry.pending.revision;
    return entry.pending.lastMessage
      ? (entry.pending.lastMessage.slotInfo.cycleNumber + 1) % 2
      : undefined;
  }

  private preemptActive(next: QueueEntry): number | undefined {
    const current = this.getActiveEntry();
    if (current) {
      current.state = 'queued';
      this.moveToEnd(current.entryId);
    }
    this.activeEntryId = undefined;
    return this.activate(next);
  }

  private markNoResponse(
    entry: QueueEntry,
    failure?: import('@tx5dr/plugin-api').QSOFailureInfo,
  ): void {
    entry.state = 'no-response';
    entry.noResponseCycles = failure?.stage === 'TX1'
      ? this.operator.config.maxCallAttempts
      : failure?.stage
        ? this.operator.config.maxQSOTimeoutCycles
        : this.operator.config.maxCallAttempts;
    entry.pauseReason = undefined;
    entry.lastOnAirSlot = undefined;
    entry.lastOnAirLifecycleEpoch = undefined;
    entry.pendingSettlement = undefined;
    entry.delegateReleased = false;
    this.moveToEnd(entry.entryId);
    this.activeEntryId = undefined;
    this.delegate.reset('assisted queue no-response hold');
  }

  private markInactive(entry: QueueEntry): void {
    entry.state = 'no-response';
    entry.noResponseCycles = undefined;
    entry.pauseReason = undefined;
    entry.lastOnAirSlot = undefined;
    entry.lastOnAirLifecycleEpoch = undefined;
    entry.pendingSettlement = undefined;
    entry.delegateReleased = false;
  }

  private completeActive(entry: QueueEntry): void {
    this.entries = this.entries.filter((candidate) => candidate.entryId !== entry.entryId);
    this.activeEntryId = undefined;
    this.delegate.reset('assisted queue QSO complete');
  }

  private moveToEnd(entryId: string): void {
    const index = this.entries.findIndex((entry) => entry.entryId === entryId);
    if (index < 0) return;
    const [entry] = this.entries.splice(index, 1);
    this.entries.push(entry);
  }

  private pauseEntry(
    entry: QueueEntry,
    reason: AssistedQueuePauseReason,
  ): void {
    entry.state = 'paused';
    entry.pauseReason = reason;
    entry.noResponseCycles = undefined;
  }

  private updatePauseStates(now: number): boolean {
    let changed = false;
    const slotMs = this.operator.config.mode.slotMs;
    for (const entry of this.entries) {
      if (entry.pending.validUntil === Number.POSITIVE_INFINITY) continue;
      const evidenceAt = entry.lastHeardAt ?? entry.pending.lastMessage?.slotInfo.startMs;
      const inactiveCycles = evidenceAt === undefined
        ? STALE_AFTER_MODE_SLOTS
        : Math.max(0, Math.floor((now - evidenceAt) / slotMs));
      if (entry.state === 'paused' && inactiveCycles >= INACTIVE_AFTER_MODE_SLOTS) {
        this.markInactive(entry);
        changed = true;
      } else if (entry.pending.validUntil < now && entry.state === 'queued') {
        this.pauseEntry(entry, 'stale');
        changed = true;
      } else if (entry.pending.validUntil < now
        && entry.entryId === this.activeEntryId
        && (entry.state === 'active' || entry.state === 'engaged' || entry.state === 'closing')
        && !entry.pendingSettlement
        && !this.isTransmitting()) {
        this.pauseEntry(entry, 'stale');
        this.activeEntryId = undefined;
        this.delegate.reset('assisted queue active context expired while paused');
        changed = true;
      }
    }
    return changed;
  }

  private hasProtocolCorrelation(entry: QueueEntry, type: ParsedFT8Message['message']['type']): boolean {
    if (entry.entryId !== this.activeEntryId) return false;
    const lifecycleEpoch = this.delegate.getSnapshot().qsoLifecycleEpoch;
    if (entry.lastOnAirLifecycleEpoch !== lifecycleEpoch) return false;
    switch (type) {
      case FT8MessageType.ROGER_REPORT:
        return entry.lastOnAirSlot === 'TX2' || entry.lastOnAirSlot === 'TX3';
      case FT8MessageType.RRR:
        return entry.lastOnAirSlot === 'TX3' || entry.lastOnAirSlot === 'TX4';
      case FT8MessageType.SEVENTY_THREE:
      case FT8MessageType.FOX_RR73:
        return entry.lastOnAirSlot === 'TX3'
          || entry.lastOnAirSlot === 'TX4'
          || entry.lastOnAirSlot === 'TX5';
      default:
        return false;
    }
  }

  private isEligibleActiveMessage(entry: QueueEntry, message: ParsedFT8Message): boolean {
    if (message.isPartialDecode) return false;
    if (message.message.type === FT8MessageType.FOX_RR73) {
      const sender = senderOf(message);
      return isDirectedTo(message, this.operator.config.myCallsign)
        && (!sender || callsignMatches(sender, entry.callsign))
        && this.hasProtocolCorrelation(entry, message.message.type);
    }
    if (!callsignMatches(senderOf(message), entry.callsign)) return false;
    if (message.message.type === FT8MessageType.ROGER_REPORT
      || message.message.type === FT8MessageType.RRR
      || message.message.type === FT8MessageType.SEVENTY_THREE) {
      return this.hasProtocolCorrelation(entry, message.message.type);
    }
    return true;
  }

  private getActiveEntry(): QueueEntry | undefined {
    return this.entries.find((entry) => entry.entryId === this.activeEntryId);
  }

  private displayState(entry: QueueEntry): AssistedQueueDisplayState {
    if (entry.state === 'engaged') return 'engaged';
    if (entry.state === 'closing') return 'closing';
    if (entry.state === 'paused') return 'paused';
    if (entry.state === 'no-response') return 'no-response';
    if (entry.state === 'review') return 'review';
    return entry.pending.nextLocalTxSlot ?? 'review';
  }

  private result(
    outcome: QueuedStrategyMutationResult['outcome'],
    reason?: QueuedStrategyMutationResult['reason'],
  ): QueuedStrategyMutationResult {
    return { outcome, reason, snapshot: this.getQueueSnapshot() };
  }

  private resultSnapshot(
    transmission: string | null,
    extras: Partial<StrategyDecisionResult> = {},
  ): StrategyDecisionResult {
    return { ...extras, transmission, snapshot: this.getSnapshot() };
  }

  private bumpVersion(): void { this.version += 1; }

  private queueProjectionFingerprint(): string {
    const snapshot = this.getQueueSnapshot();
    return JSON.stringify({ activeEntryId: snapshot.activeEntryId, rows: snapshot.rows });
  }

  private bumpVersionIfProjectionChanged(before: string): boolean {
    if (this.queueProjectionFingerprint() === before) return false;
    this.bumpVersion();
    return true;
  }
}
