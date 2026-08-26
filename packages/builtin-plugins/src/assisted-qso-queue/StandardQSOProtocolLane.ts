import type {
  AssistedQueueDisplayState,
  AssistedQueuePauseReason,
  FrameMessage,
  ParsedFT8Message,
  PluginLogger,
  QueuedStrategyObservationMeta,
  StrategyDecisionMetaV2,
  StrategyQSOCompletionSettlement,
  StrategyRuntimeCheckpoint,
  StrategyRuntimeContext,
  StrategyRuntimeSlot,
  StrategyRuntimeSlotContentUpdate,
  StrategyRuntimeSnapshot,
  StreamPhysicalReceipt,
  SlotInfo,
} from '@tx5dr/plugin-api';
import { FT8MessageType, normalizeCallsign } from '@tx5dr/plugin-api';
import { FT8MessageParser } from '@tx5dr/core';
import type {
  ParallelQSOQueueEntry,
  ProtocolLane,
  ProtocolLaneDecision,
  ProtocolLaneSnapshot,
} from '../_shared/parallel-qso/index.js';
import {
  StandardQSOPluginRuntime,
  type StandardQSOPluginOperator,
} from '../standard-qso/StandardQSOPluginRuntime.js';

const FINAL_73_RETRY_WINDOW_SLOTS = 2;

export type PendingSlot = Exclude<StrategyRuntimeSlot, 'TX6'>;
export type QueueEntryState =
  | 'queued' | 'active' | 'engaged' | 'closing' | 'paused' | 'no-response' | 'review';

export interface PendingContext {
  revision: number;
  nextLocalTxSlot: PendingSlot | null;
  hasDirectEvidence: boolean;
  lastMessage?: { message: FrameMessage; slotInfo: SlotInfo };
  validUntil: number;
}

export interface AssistedQueueEntryData {
  source: 'manual' | 'inbound-direct';
  state: QueueEntryState;
  pending: PendingContext;
  pauseReason?: AssistedQueuePauseReason;
  noResponseCycles?: number;
  targetGrid?: string;
  lastSnr?: number;
  lastHeardAt?: number;
}

interface Final73Lease {
  targetKey: string;
  callsign: string;
  transmission: string;
  targetGrid?: string;
  reportSent?: number;
  reportReceived?: number;
  actualFrequency?: number;
  lifecycleEpoch: number;
  expiresAtSlotStartMs: number;
  pendingMessage?: { message: FrameMessage; slotInfo: SlotInfo };
  scheduled: boolean;
}

interface LaneCheckpoint {
  activeEntry?: ParallelQSOQueueEntry<AssistedQueueEntryData>;
  delegateAppliedPendingRevision: number;
  logCommitted: boolean;
  delegateReleased: boolean;
  lastOnAirSlot?: PendingSlot;
  lastOnAirLifecycleEpoch?: number;
  pendingSettlement?: { lifecycleEpoch: number; recordId: string };
  latestSlotStartMs: number;
  final73Lease?: Final73Lease;
  delegate: StrategyRuntimeCheckpoint;
}

export function normalized(value: string | undefined): string {
  if (!value) return '';
  const upper = value.trim().toUpperCase();
  return normalizeCallsign(upper) || upper;
}

export function callsignMatches(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left && right && normalized(left) === normalized(right));
}

export function senderOf(message: ParsedFT8Message): string | undefined {
  const sender = (message.message as { senderCallsign?: unknown }).senderCallsign;
  return typeof sender === 'string' && sender.trim() ? sender.trim().toUpperCase() : undefined;
}

export function targetOf(message: ParsedFT8Message): string | undefined {
  const target = (message.message as { targetCallsign?: unknown }).targetCallsign;
  return typeof target === 'string' && target.trim() ? target.trim().toUpperCase() : undefined;
}

export function gridOf(message: ParsedFT8Message): string | undefined {
  const directGrid = (message.message as { grid?: unknown }).grid;
  if (typeof directGrid === 'string' && directGrid.trim()) return directGrid.trim().toUpperCase();
  const analyzedGrid = message.logbookAnalysis?.grid;
  return typeof analyzedGrid === 'string' && analyzedGrid.trim()
    ? analyzedGrid.trim().toUpperCase()
    : undefined;
}

export function isDirectedTo(message: ParsedFT8Message, callsign: string): boolean {
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

export function lastMessageFromParsed(
  message: ParsedFT8Message,
  modeName: string,
  slotMs: number,
): { message: FrameMessage; slotInfo: SlotInfo } {
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

export function pendingSlotForMessage(
  message: ParsedFT8Message,
  myCallsign: string,
  fallback: PendingSlot,
): PendingSlot | null {
  const direct = isDirectedTo(message, myCallsign);
  if (!direct) return message.message.type === FT8MessageType.CQ ? 'TX1' : fallback;
  switch (message.message.type) {
    case FT8MessageType.CALL: return 'TX2';
    case FT8MessageType.SIGNAL_REPORT: return 'TX3';
    case FT8MessageType.ROGER_REPORT: return 'TX4';
    case FT8MessageType.RRR: return 'TX5';
    case FT8MessageType.SEVENTY_THREE:
    case FT8MessageType.FOX_RR73:
      return null;
    default: return fallback;
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function resolveLaneFrequency(
  operator: StandardQSOPluginOperator,
  laneIndex: number,
): number {
  const config = operator.config;
  const configured = config.frequency;
  const base = configured >= 300 && configured <= 4_700 ? Math.round(configured) : 1_500;
  const spacingHz = config.mode.name === 'FT4' ? 100 : 60;
  return Math.min(5_000, base + laneIndex * spacingHz);
}

export class StandardQSOProtocolLane implements ProtocolLane<AssistedQueueEntryData> {
  readonly streamId: string;
  private readonly laneIndex: number;
  private readonly sourceOperator: StandardQSOPluginOperator;
  private readonly operator: StandardQSOPluginOperator;
  private readonly delegate: StandardQSOPluginRuntime;
  private readonly logger: PluginLogger;
  private activeEntry?: ParallelQSOQueueEntry<AssistedQueueEntryData>;
  private delegateAppliedPendingRevision = 0;
  private logCommitted = false;
  private delegateReleased = false;
  private lastOnAirSlot?: PendingSlot;
  private lastOnAirLifecycleEpoch?: number;
  private pendingSettlement?: { lifecycleEpoch: number; recordId: string };
  private latestSlotStartMs = 0;
  private final73Lease?: Final73Lease;

  constructor(options: {
    streamId: string;
    laneIndex: number;
    operator: StandardQSOPluginOperator;
    logger: PluginLogger;
  }) {
    this.streamId = options.streamId;
    this.laneIndex = options.laneIndex;
    this.logger = options.logger;
    const sourceOperator = options.operator;
    this.sourceOperator = sourceOperator;
    this.operator = {
      get config() {
        const config = sourceOperator.config;
        return { ...config, frequency: resolveLaneFrequency(sourceOperator, options.laneIndex) };
      },
      hasWorkedCallsign: (callsign, callOptions) => sourceOperator.hasWorkedCallsign(callsign, callOptions),
      isTargetBeingWorkedByOthers: (callsign) => sourceOperator.isTargetBeingWorkedByOthers(callsign),
    };
    this.delegate = new StandardQSOPluginRuntime(this.operator, this.logger);
  }

  get audioFrequencyHz(): number {
    return resolveLaneFrequency(this.sourceOperator, this.laneIndex);
  }

  activate(entry: Readonly<ParallelQSOQueueEntry<AssistedQueueEntryData>>) {
    if (this.activeEntry || this.hasPendingWork()) return { accepted: false };
    this.delegate.reset('assisted queue lane activation');
    const activation = this.delegate.activateTarget({
      callsign: entry.callsign,
      lastMessage: entry.data.pending.lastMessage,
    });
    if (!activation.accepted || activation.initialSlot !== entry.data.pending.nextLocalTxSlot) {
      this.delegate.reset('assisted queue lane activation rejected');
      return { accepted: false };
    }
    this.activeEntry = clone(entry);
    this.activeEntry.data.state = entry.data.pending.hasDirectEvidence
      && entry.data.pending.nextLocalTxSlot === 'TX3'
      ? 'engaged'
      : 'active';
    this.activeEntry.data.pauseReason = undefined;
    this.activeEntry.data.noResponseCycles = undefined;
    this.delegateAppliedPendingRevision = entry.data.pending.revision;
    this.logCommitted = false;
    this.delegateReleased = false;
    this.lastOnAirSlot = undefined;
    this.lastOnAirLifecycleEpoch = activation.lifecycleEpoch;
    this.pendingSettlement = undefined;
    return { accepted: true };
  }

  refreshEntry(entry: ParallelQSOQueueEntry<AssistedQueueEntryData>): void {
    if (this.activeEntry?.entryId !== entry.entryId) return;
    const protocolState = this.activeEntry.data.state;
    this.activeEntry = clone(entry);
    if (protocolState === 'active'
        || protocolState === 'engaged'
        || protocolState === 'closing'
        || protocolState === 'review') {
      this.activeEntry.data.state = protocolState;
    }
  }

  deactivate(reason: string): void {
    this.activeEntry = undefined;
    this.delegateAppliedPendingRevision = 0;
    this.logCommitted = false;
    this.delegateReleased = false;
    this.lastOnAirSlot = undefined;
    this.lastOnAirLifecycleEpoch = undefined;
    this.pendingSettlement = undefined;
    this.delegate.reset(reason);
  }

  hasPendingWork(): boolean {
    return this.final73Lease?.scheduled === true || this.final73Lease?.pendingMessage !== undefined;
  }

  shouldObserve(): boolean {
    return this.final73Lease !== undefined;
  }

  observe(messages: ParsedFT8Message[], meta: QueuedStrategyObservationMeta): boolean {
    const before = this.projectionFingerprint();
    this.latestSlotStartMs = Math.max(this.latestSlotStartMs, meta.slotInfo.startMs);
    this.expireFinal73Lease(meta.slotInfo.startMs);
    for (const message of messages) {
      if (message.isPartialDecode) continue;
      this.observeFinal73Retry(message, meta.slotInfo);
      const entry = this.activeEntry;
      if (!entry || !isDirectedTo(message, this.operator.config.myCallsign)) continue;
      const sender = senderOf(message);
      if (message.message.type !== FT8MessageType.FOX_RR73
          && !callsignMatches(sender, entry.callsign)) continue;
      const correlated = this.hasProtocolCorrelation(message.message.type);
      if (message.message.type === FT8MessageType.SIGNAL_REPORT
          || (correlated && (message.message.type === FT8MessageType.ROGER_REPORT
            || message.message.type === FT8MessageType.RRR))) {
        entry.data.state = message.message.type === FT8MessageType.RRR ? 'closing' : 'engaged';
      } else if (correlated && (message.message.type === FT8MessageType.SEVENTY_THREE
          || message.message.type === FT8MessageType.FOX_RR73)) {
        entry.data.state = 'closing';
      }
    }
    return before !== this.projectionFingerprint();
  }

  async decide(
    messages: ParsedFT8Message[],
    meta: StrategyDecisionMetaV2,
  ): Promise<ProtocolLaneDecision<AssistedQueueEntryData>> {
    if (meta.signal.aborted) throw new DOMException('Strategy decision aborted', 'AbortError');
    this.expireFinal73Lease(this.latestSlotStartMs);
    if (this.final73Lease?.scheduled
        || (this.final73Lease?.pendingMessage && this.canScheduleFinal73Retry())) {
      this.final73Lease.scheduled = true;
      return {};
    }
    const entry = this.activeEntry;
    if (!entry) return {};
    const before = this.projectionFingerprint();
    const pendingMessage = entry.data.pending.lastMessage
      && this.delegateAppliedPendingRevision < entry.data.pending.revision
      ? parsedFromLastMessage(entry.data.pending.lastMessage)
      : undefined;
    const decisionMessages = pendingMessage && !messages.some((message) => (
      message.rawMessage === pendingMessage.rawMessage && message.timestamp === pendingMessage.timestamp
    )) ? [...messages, pendingMessage] : messages;
    const relevant = decisionMessages.filter((message) => this.isEligibleActiveMessage(entry, message));
    const final73LeaseCandidate = this.captureFinal73Lease(entry);
    const decision = await this.delegate.decide(relevant, meta);
    if (pendingMessage) this.delegateAppliedPendingRevision = entry.data.pending.revision;
    if (decision.qsoCompletion) {
      entry.data.state = 'closing';
      this.pendingSettlement = {
        lifecycleEpoch: decision.qsoCompletion.lifecycleEpoch,
        recordId: decision.qsoCompletion.record.id,
      };
    }
    if (decision.snapshot.currentState === 'TX4' || decision.snapshot.currentState === 'TX5') {
      entry.data.state = 'closing';
    } else if (decision.snapshot.context?.reportReceived !== undefined && entry.data.state === 'active') {
      entry.data.state = 'engaged';
    }

    if (decision.qsoFailure) {
      this.markNoResponse(entry, decision.qsoFailure);
      return {
        qsoFailure: decision.qsoFailure,
        entryData: clone(entry.data),
        queueChanged: true,
        release: { disposition: 'retain-entry', reason: decision.qsoFailure.reason },
      };
    }
    if (decision.stop && !decision.snapshot.context?.targetCallsign) {
      if (final73LeaseCandidate) this.final73Lease = final73LeaseCandidate;
      this.delegateReleased = true;
      if (this.logCommitted) {
        return {
          entryData: clone(entry.data),
          queueChanged: true,
          release: { disposition: 'remove-entry', reason: 'QSO complete' },
        };
      }
      if (!this.pendingSettlement && !decision.qsoCompletion) {
        this.markNoResponse(entry);
        return {
          entryData: clone(entry.data),
          queueChanged: true,
          release: { disposition: 'retain-entry', reason: 'no response' },
        };
      }
    }
    const changed = before !== this.projectionFingerprint();
    return {
      qsoCompletion: decision.qsoCompletion,
      entryData: changed ? clone(entry.data) : undefined,
      queueChanged: changed,
    };
  }

  getTransmitText(): string | null {
    if (this.final73Lease?.scheduled) return this.final73Lease.transmission;
    if (!this.activeEntry
        || this.delegateReleased
        || this.activeEntry.data.state === 'paused'
        || this.activeEntry.data.state === 'no-response'
        || this.activeEntry.data.state === 'review') return null;
    return this.delegate.getTransmitText();
  }

  getSnapshot(): ProtocolLaneSnapshot | null {
    const active = this.activeEntry;
    if (active) {
      const protocol = this.delegate.getSnapshot();
      const canSelectState = !this.delegateReleased
        && (active.data.state === 'active' || active.data.state === 'engaged' || active.data.state === 'closing');
      return {
        currentState: protocol.currentState,
        targetCallsign: active.callsign,
        targetGrid: active.data.targetGrid ?? protocol.context?.targetGrid,
        qsoLifecycleEpoch: protocol.qsoLifecycleEpoch ?? 0,
        stateOptions: canSelectState
          ? (protocol.availableSlots ?? []).map((id) => ({
            id,
            label: id,
            transmitText: protocol.slots?.[id as StrategyRuntimeSlot],
          }))
          : [],
      };
    }
    const legacy = this.getLegacySnapshot();
    if (!this.final73Lease?.scheduled) return null;
    return {
      currentState: legacy.currentState,
      targetCallsign: legacy.context?.targetCallsign,
      targetGrid: legacy.context?.targetGrid,
      qsoLifecycleEpoch: legacy.qsoLifecycleEpoch ?? 0,
      stateOptions: [],
    };
  }

  getLegacySnapshot(): StrategyRuntimeSnapshot {
    const delegate = this.delegate.getSnapshot();
    const lease = this.final73Lease;
    if (!lease?.scheduled) return delegate;
    return {
      ...delegate,
      currentState: 'TX5',
      slots: { ...delegate.slots, TX5: lease.transmission },
      context: {
        ...delegate.context,
        targetCallsign: lease.callsign,
        targetGrid: lease.targetGrid,
        reportSent: lease.reportSent,
        reportReceived: lease.reportReceived,
        actualFrequency: lease.actualFrequency,
      },
      qsoLifecycleEpoch: lease.lifecycleEpoch,
    };
  }

  getIdleCQText(): string | null {
    return this.delegate.getIdleCQText();
  }

  getActiveEntryId(): string | undefined {
    return this.activeEntry?.entryId;
  }

  getActiveData(): AssistedQueueEntryData | undefined {
    return this.activeEntry ? clone(this.activeEntry.data) : undefined;
  }

  canPreemptActive(): boolean {
    return this.activeEntry?.data.state === 'active'
      && this.delegate.getSnapshot().currentState === 'TX1'
      && this.activeEntry.data.pending.hasDirectEvidence === false;
  }

  isCorrelatedMessage(message: ParsedFT8Message): boolean {
    return this.activeEntry !== undefined
      && isDirectedTo(message, this.operator.config.myCallsign)
      && this.isEligibleActiveMessage(this.activeEntry, message);
  }

  canSettle(settlement: StrategyQSOCompletionSettlement): boolean {
    return this.pendingSettlement?.lifecycleEpoch === settlement.lifecycleEpoch
      && this.pendingSettlement.recordId === settlement.recordId;
  }

  isReadyToReleaseAfterSettlement(): boolean {
    return this.delegateReleased && this.logCommitted;
  }

  settleQSOCompletion(settlement: StrategyQSOCompletionSettlement): boolean {
    if (!this.canSettle(settlement)) return false;
    this.delegate.settleQSOCompletion(settlement);
    if (settlement.status === 'committed') this.logCommitted = true;
    else if (this.activeEntry) this.activeEntry.data.state = 'review';
    this.pendingSettlement = undefined;
    return true;
  }

  onPhysicalSuccess(receipt: StreamPhysicalReceipt): void {
    this.onLegacyPhysicalSuccess(receipt.text);
  }

  onLegacyPhysicalSuccess(transmission: string): void {
    const lease = this.final73Lease;
    if (lease?.scheduled && transmission === lease.transmission) {
      lease.scheduled = false;
      lease.pendingMessage = undefined;
      lease.expiresAtSlotStartMs = this.final73LeaseExpiryFrom(this.latestSlotStartMs);
      this.logger.debug('Final 73 retry reached physical success', { callsign: lease.callsign });
      return;
    }
    const snapshot = this.delegate.getSnapshot();
    const matchingSlot = (Object.entries(snapshot.slots ?? {}) as Array<[StrategyRuntimeSlot, string]>)
      .find(([, text]) => text === transmission)?.[0];
    if (matchingSlot && matchingSlot !== 'TX6') {
      this.lastOnAirSlot = matchingSlot;
      this.lastOnAirLifecycleEpoch = snapshot.qsoLifecycleEpoch;
    }
    this.delegate.onTransmissionQueued(transmission);
  }

  patchContext(patch: Partial<StrategyRuntimeContext>): void {
    this.delegate.patchContext(patch);
  }

  setState(state: StrategyRuntimeSlot): void {
    this.delegate.setState(state);
  }

  setUserState(stateId: string): boolean {
    if (!this.activeEntry || this.delegateReleased
        || (this.activeEntry.data.state !== 'active'
          && this.activeEntry.data.state !== 'engaged'
          && this.activeEntry.data.state !== 'closing')) return false;
    const snapshot = this.delegate.getSnapshot();
    if (!snapshot.availableSlots?.includes(stateId)) return false;
    if (snapshot.currentState === stateId) return false;
    this.delegate.setState(stateId as StrategyRuntimeSlot);
    return true;
  }

  setSlotContent(update: StrategyRuntimeSlotContentUpdate): void {
    this.delegate.setSlotContent(update);
  }

  checkpoint(): LaneCheckpoint {
    return clone({
      activeEntry: this.activeEntry,
      delegateAppliedPendingRevision: this.delegateAppliedPendingRevision,
      logCommitted: this.logCommitted,
      delegateReleased: this.delegateReleased,
      lastOnAirSlot: this.lastOnAirSlot,
      lastOnAirLifecycleEpoch: this.lastOnAirLifecycleEpoch,
      pendingSettlement: this.pendingSettlement,
      latestSlotStartMs: this.latestSlotStartMs,
      final73Lease: this.final73Lease,
      delegate: this.delegate.checkpoint(),
    });
  }

  restore(checkpoint: unknown): void {
    const state = checkpoint as LaneCheckpoint;
    if (!state || typeof state !== 'object') throw new Error('Invalid standard QSO lane checkpoint');
    this.activeEntry = state.activeEntry ? clone(state.activeEntry) : undefined;
    this.delegateAppliedPendingRevision = state.delegateAppliedPendingRevision;
    this.logCommitted = state.logCommitted;
    this.delegateReleased = state.delegateReleased;
    this.lastOnAirSlot = state.lastOnAirSlot;
    this.lastOnAirLifecycleEpoch = state.lastOnAirLifecycleEpoch;
    this.pendingSettlement = state.pendingSettlement ? clone(state.pendingSettlement) : undefined;
    this.latestSlotStartMs = state.latestSlotStartMs;
    this.final73Lease = state.final73Lease ? clone(state.final73Lease) : undefined;
    this.delegate.restore(state.delegate);
  }

  reset(reason?: string): void {
    this.activeEntry = undefined;
    this.delegateAppliedPendingRevision = 0;
    this.logCommitted = false;
    this.delegateReleased = false;
    this.lastOnAirSlot = undefined;
    this.lastOnAirLifecycleEpoch = undefined;
    this.pendingSettlement = undefined;
    this.latestSlotStartMs = 0;
    this.final73Lease = undefined;
    this.delegate.reset(reason);
  }

  displayState(): AssistedQueueDisplayState {
    const data = this.activeEntry?.data;
    if (!data) return 'review';
    if (data.state === 'engaged') return 'engaged';
    if (data.state === 'closing') return 'closing';
    if (data.state === 'paused') return 'paused';
    if (data.state === 'no-response') return 'no-response';
    if (data.state === 'review') return 'review';
    return data.pending.nextLocalTxSlot ?? 'review';
  }

  private markNoResponse(
    entry: ParallelQSOQueueEntry<AssistedQueueEntryData>,
    failure?: import('@tx5dr/plugin-api').QSOFailureInfo,
  ): void {
    entry.data.state = 'no-response';
    entry.data.noResponseCycles = failure?.stage === 'TX1'
      ? this.operator.config.maxCallAttempts
      : failure?.stage
        ? this.operator.config.maxQSOTimeoutCycles
        : this.operator.config.maxCallAttempts;
    entry.data.pauseReason = undefined;
    this.lastOnAirSlot = undefined;
    this.lastOnAirLifecycleEpoch = undefined;
    this.pendingSettlement = undefined;
    this.delegateReleased = false;
  }

  private captureFinal73Lease(
    entry: ParallelQSOQueueEntry<AssistedQueueEntryData>,
  ): Final73Lease | undefined {
    const snapshot = this.delegate.getSnapshot();
    const lifecycleEpoch = snapshot.qsoLifecycleEpoch;
    const transmission = snapshot.slots?.TX5;
    const targetCallsign = snapshot.context?.targetCallsign;
    if (snapshot.currentState !== 'TX5'
        || !transmission
        || !targetCallsign
        || !callsignMatches(targetCallsign, entry.callsign)
        || this.lastOnAirSlot !== 'TX5'
        || this.lastOnAirLifecycleEpoch !== lifecycleEpoch
        || lifecycleEpoch === undefined) return undefined;
    return {
      targetKey: entry.targetKey,
      callsign: entry.callsign,
      transmission,
      targetGrid: snapshot.context?.targetGrid,
      reportSent: snapshot.context?.reportSent,
      reportReceived: snapshot.context?.reportReceived,
      actualFrequency: snapshot.context?.actualFrequency,
      lifecycleEpoch,
      expiresAtSlotStartMs: this.final73LeaseExpiryFrom(this.latestSlotStartMs),
      scheduled: false,
    };
  }

  private observeFinal73Retry(message: ParsedFT8Message, slotInfo: SlotInfo): void {
    const lease = this.final73Lease;
    if (!lease
        || lease.scheduled
        || message.message.type !== FT8MessageType.RRR
        || !callsignMatches(senderOf(message), lease.callsign)
        || !callsignMatches(targetOf(message), this.operator.config.myCallsign)
        || slotInfo.startMs > lease.expiresAtSlotStartMs) return;
    const lastMessage = lastMessageFromParsed(
      message,
      this.operator.config.mode.name,
      this.operator.config.mode.slotMs,
    );
    if (lease.pendingMessage?.message.message === lastMessage.message.message
        && lease.pendingMessage.slotInfo.startMs === lastMessage.slotInfo.startMs) return;
    lease.pendingMessage = lastMessage;
  }

  private canScheduleFinal73Retry(): boolean {
    if (!this.activeEntry) return true;
    return this.canPreemptActive();
  }

  private expireFinal73Lease(slotStartMs: number): void {
    const lease = this.final73Lease;
    if (!lease || lease.scheduled || slotStartMs <= lease.expiresAtSlotStartMs) return;
    this.final73Lease = undefined;
  }

  private final73LeaseExpiryFrom(slotStartMs: number): number {
    const slotMs = this.operator.config.mode.slotMs;
    const reference = slotStartMs > 0
      ? slotStartMs
      : Math.floor(Date.now() / slotMs) * slotMs;
    return reference + slotMs * FINAL_73_RETRY_WINDOW_SLOTS;
  }

  private hasProtocolCorrelation(type: ParsedFT8Message['message']['type']): boolean {
    const lifecycleEpoch = this.delegate.getSnapshot().qsoLifecycleEpoch;
    if (this.lastOnAirLifecycleEpoch !== lifecycleEpoch) return false;
    switch (type) {
      case FT8MessageType.ROGER_REPORT:
        return this.lastOnAirSlot === 'TX2' || this.lastOnAirSlot === 'TX3';
      case FT8MessageType.RRR:
        return this.lastOnAirSlot === 'TX3' || this.lastOnAirSlot === 'TX4';
      case FT8MessageType.SEVENTY_THREE:
      case FT8MessageType.FOX_RR73:
        return this.lastOnAirSlot === 'TX3'
          || this.lastOnAirSlot === 'TX4'
          || this.lastOnAirSlot === 'TX5';
      default:
        return false;
    }
  }

  private isEligibleActiveMessage(
    entry: ParallelQSOQueueEntry<AssistedQueueEntryData>,
    message: ParsedFT8Message,
  ): boolean {
    if (message.isPartialDecode) return false;
    if (message.message.type === FT8MessageType.FOX_RR73) {
      const sender = senderOf(message);
      return isDirectedTo(message, this.operator.config.myCallsign)
        && (!sender || callsignMatches(sender, entry.callsign))
        && this.hasProtocolCorrelation(message.message.type);
    }
    if (!callsignMatches(senderOf(message), entry.callsign)) return false;
    if (message.message.type === FT8MessageType.ROGER_REPORT
        || message.message.type === FT8MessageType.RRR
        || message.message.type === FT8MessageType.SEVENTY_THREE) {
      return this.hasProtocolCorrelation(message.message.type);
    }
    return true;
  }

  private projectionFingerprint(): string {
    return JSON.stringify({
      entry: this.activeEntry?.data,
      lease: this.final73Lease,
      snapshot: this.getLegacySnapshot(),
    });
  }
}
