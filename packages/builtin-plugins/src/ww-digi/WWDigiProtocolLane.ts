import type {
  ParsedFT8Message,
  PluginLogger,
  QueuedStrategyObservationMeta,
  StrategyDecisionMetaV2,
  StrategyQSOCompletionEffect,
  StrategyQSOCompletionSettlement,
  StrategyActionDescriptor,
  StrategyActionResult,
  StreamPhysicalReceipt,
} from '@tx5dr/plugin-api';
import { FT8MessageType } from '@tx5dr/plugin-api';
import type {
  ParallelQSOQueueEntry,
  ProtocolLane,
  ProtocolLaneActivation,
  ProtocolLaneDecision,
  ProtocolLaneSnapshot,
} from '@tx5dr/plugin-api/toolkit';
import { LaneFrequencyController } from '@tx5dr/plugin-api/toolkit';
import {
  buildWWDigi73,
  buildWWDigiRR73,
  parseWWDigiMessage,
} from './protocol.js';
import {
  buildWWDigiCompletionEffect,
  deriveWWDigiTransmission,
  initializeWWDigiProtocolContext,
  isWWDigiProtocolContext,
  reduceWWDigiInbound,
  reduceWWDigiPhysicalSuccess,
  setWWDigiOutgoingOverride,
  setWWDigiProtocolPhase,
  type WWDigiProtocolConfig,
  type WWDigiProtocolContext,
  type WWDigiProtocolPhase,
} from './WWDigiProtocolContext.js';

export interface WWDigiEntryData {
  authorizationId?: string;
  authorizedAt?: number;
  lastMessageRaw?: string;
  targetGrid?: string;
  lastSnr?: number;
  status?: 'candidate' | 'authorized' | 'paused' | 'cycle-paused' | 'stale' | 'no-response' | 'log-pending' | 'review' | 'dupe';
  authorizedReceiveEpoch?: number;
  lastHeardReceiveEpoch?: number;
  lastHeardCycle?: 0 | 1;
  firstHeardAt?: number;
  firstAudioFrequencyHz?: number;
  evidenceRevision?: number;
  dupe?: boolean;
  source?: 'manual' | 'cq';
  noResponseCycles?: number;
  protocolContext?: WWDigiProtocolContext;
  protocolContextExpiresAtReceiveEpoch?: number;
  alternateText?: string;
  encodingError?: string;
  cycleResume?: {
    streamId: string;
    transmitCycle: 0 | 1;
    laneCheckpoint: unknown;
    observeUntilReceiveEpoch: number;
    settlement?: 'committed' | 'failed';
  };
}

export interface WWDigiLaneConfig extends WWDigiProtocolConfig {
  maxAttempts: number;
  slotMs: number;
}

type UserSelectableLanePhase = WWDigiProtocolPhase;

const USER_SELECTABLE_PHASES: Array<{ id: UserSelectableLanePhase; label: string }> = [
  { id: 'wait-r-grid', label: 'stateWaitRGrid' },
  { id: 'wait-rr73', label: 'stateWaitRr73' },
  { id: 'wait-standard-final', label: 'stateWaitStandardFinal' },
  { id: 'send-rr73', label: 'stateSendRr73' },
];

interface CompletionState {
  effect: StrategyQSOCompletionEffect;
  emitted: boolean;
  settled?: 'committed' | 'failed';
}

interface FinalRetryLease {
  callsign: string;
  completionRecordId: string;
  completionState: 'committing' | 'committed' | 'failed';
  rr73Text: string;
  seventyThreeText: string;
  expiresAt: number;
  scheduledText?: string;
  awaitingRr73Decision?: boolean;
  awaiting73Decision: boolean;
}

interface WWDigiLaneCheckpoint {
  active?: ParallelQSOQueueEntry<WWDigiEntryData>;
  protocolContext?: WWDigiProtocolContext;
  qsoLifecycleEpoch: number;
  attempts: number;
  completion?: CompletionState;
  finalRetry?: FinalRetryLease;
  paused: boolean;
  recoveryLastReceivedText?: string;
  releaseRequested?: boolean;
  frequency: { manualFrequencyHz?: number };
  lastPhysicalFrame?: { frameId: string; revision: number };
}

function callsignMatches(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left && right && left.trim().toUpperCase() === right.trim().toUpperCase());
}

export class WWDigiProtocolLane implements ProtocolLane<WWDigiEntryData> {
  private active?: ParallelQSOQueueEntry<WWDigiEntryData>;
  private protocolContext?: WWDigiProtocolContext;
  private qsoLifecycleEpoch = 0;
  private attempts = 0;
  private completion?: CompletionState;
  private finalRetry?: FinalRetryLease;
  private paused = false;
  private recoveryLastReceivedText?: string;
  private releaseRequested = false;
  private lastPhysicalFrame?: { frameId: string; revision: number };
  private readonly frequencyController: LaneFrequencyController;

  constructor(
    readonly streamId: string,
    private readonly resolveAudioFrequencyHz: () => number,
    private readonly getConfig: () => WWDigiLaneConfig,
    private readonly logger: PluginLogger,
  ) {
    this.frequencyController = new LaneFrequencyController(resolveAudioFrequencyHz);
  }

  get audioFrequencyHz(): number {
    return this.frequencyController.frequencyHz;
  }

  activate(entry: Readonly<ParallelQSOQueueEntry<WWDigiEntryData>>): ProtocolLaneActivation {
    if (this.active || this.hasPendingWork()) return { accepted: false };
    // New authorized work takes precedence over a passive post-completion observer.
    this.finalRetry = undefined;
    this.active = structuredClone(entry);
    this.qsoLifecycleEpoch += 1;
    this.attempts = 0;
    this.completion = undefined;
    this.lastPhysicalFrame = undefined;
    this.paused = false;
    this.recoveryLastReceivedText = undefined;
    this.releaseRequested = false;
    this.protocolContext = isWWDigiProtocolContext(entry.data.protocolContext)
        && callsignMatches(entry.data.protocolContext.callsign, entry.callsign)
      ? structuredClone(entry.data.protocolContext)
      : initializeWWDigiProtocolContext({
          callsign: entry.callsign,
          audioFrequencyHz: this.audioFrequencyHz,
          now: Date.now(),
          lastMessageRaw: entry.data.lastMessageRaw,
          lastMessageAt: entry.data.firstHeardAt,
          targetGrid: entry.data.targetGrid,
          lastSnr: entry.data.lastSnr,
          alternateText: entry.data.alternateText,
        }, this.getConfig());
    this.protocolContext.audioFrequencyHz = this.audioFrequencyHz;
    return { accepted: true };
  }

  deactivate(_reason: string): void {
    this.active = undefined;
    this.protocolContext = undefined;
    this.qsoLifecycleEpoch = 0;
    this.attempts = 0;
    this.completion = undefined;
    this.lastPhysicalFrame = undefined;
    this.paused = false;
    this.recoveryLastReceivedText = undefined;
    this.releaseRequested = false;
  }

  hasPendingWork(): boolean {
    this.expireFinalRetry(Date.now());
    return Boolean(this.active || this.finalRetry?.scheduledText);
  }

  shouldObserve(): boolean {
    this.expireFinalRetry(Date.now());
    return this.finalRetry !== undefined;
  }

  observe(messages: ParsedFT8Message[], _meta: QueuedStrategyObservationMeta): boolean {
    const lease = this.finalRetry;
    if (!lease) return false;
    this.expireFinalRetry(messages.reduce((latest, message) => Math.max(latest, message.timestamp), Date.now()));
    if (!this.finalRetry) return true;
    const config = this.getConfig();
    for (const message of messages) {
      const parsed = parseWWDigiMessage(message.rawMessage);
      if (parsed.type === 'roger-grid'
          && callsignMatches(parsed.senderCallsign, lease.callsign)
          && callsignMatches(parsed.targetCallsign, config.myCallsign)) {
        this.recoveryLastReceivedText = message.rawMessage;
        lease.awaitingRr73Decision = true;
        return true;
      }
      const standard = message.message;
      const standardSender = 'senderCallsign' in standard ? standard.senderCallsign : undefined;
      const standardTarget = 'targetCallsign' in standard ? standard.targetCallsign : undefined;
      const repeatedFinal = parsed.type === 'rr73'
        || standard.type === FT8MessageType.RRR;
      if (repeatedFinal
          && callsignMatches('senderCallsign' in parsed ? parsed.senderCallsign : standardSender, lease.callsign)
          && callsignMatches('targetCallsign' in parsed ? parsed.targetCallsign : standardTarget, config.myCallsign)) {
        this.recoveryLastReceivedText = message.rawMessage;
        lease.awaitingRr73Decision = false;
        lease.awaiting73Decision = true;
        return true;
      }
    }
    return false;
  }

  decide(
    messages: ParsedFT8Message[],
    _meta: StrategyDecisionMetaV2,
  ): ProtocolLaneDecision<WWDigiEntryData> {
    this.expireFinalRetry(Date.now());
    if (!this.active || !this.protocolContext) return {};
    if (this.releaseRequested) {
      return {
        release: { disposition: 'remove-entry', reason: 'WW Digi QSO ended by operator' },
        queueChanged: true,
      };
    }
    const config = this.getConfig();
    const queueChanged = this.processReceivedMessages(messages);

    if (this.completion?.settled === 'committed') {
      return {
        release: { disposition: 'remove-entry', reason: 'WW Digi QSO committed' },
        queueChanged: true,
      };
    }
    if (this.completion?.settled === 'failed') return { queueChanged: true };
    if (this.completion && !this.completion.emitted) {
      this.completion.emitted = true;
      return {
        qsoCompletion: structuredClone(this.completion.effect),
        entryData: {
          ...structuredClone(this.active.data),
          status: 'log-pending',
          protocolContext: undefined,
          protocolContextExpiresAtReceiveEpoch: undefined,
        },
        release: { disposition: 'retain-entry', reason: 'WW Digi RF exchange complete' },
        queueChanged: true,
      };
    }
    if (!this.completion && this.attempts >= Math.max(1, config.maxAttempts)) {
      const callsign = this.active.callsign;
      const timeoutStage = this.protocolContext.phase;
      return {
        qsoFailure: {
          targetCallsign: callsign,
          reason: 'ww_digi_no_response',
          stage: timeoutStage,
          unansweredTransmissions: this.attempts,
          hadTargetReply: this.protocolContext.hasDirectedReply,
        },
        entryData: {
          ...structuredClone(this.active.data),
          protocolContext: structuredClone(this.protocolContext),
        },
        release: { disposition: 'retain-entry', reason: 'WW Digi target did not respond' },
        queueChanged: true,
      };
    }
    return { queueChanged };
  }

  getTransmitText(): string | null {
    if (this.paused) return null;
    if (this.finalRetry?.scheduledText) return this.finalRetry.scheduledText;
    if (!this.active || !this.protocolContext || this.completion) return null;
    return deriveWWDigiTransmission(this.protocolContext, this.getConfig());
  }

  getSnapshot(): ProtocolLaneSnapshot | null {
    if (!this.active && !this.finalRetry) return null;
    const completionState = !this.active && this.finalRetry ? this.finalRetry.completionState
      : this.completion?.settled === 'failed' ? 'failed'
      : this.completion?.settled === 'committed' ? 'committed'
        : this.completion ? 'committing'
          : this.protocolContext?.hasDirectedReply ? 'ready' : 'not-ready';
    const currentState = this.active
      ? this.completion?.settled === 'failed' ? 'review'
        : this.completion ? 'closing'
          : this.protocolContext?.phase ?? 'idle'
      : 'final-retry';
    return {
      currentState,
      targetCallsign: this.active?.callsign ?? this.finalRetry?.callsign,
      targetGrid: this.protocolContext?.targetGrid,
      qsoLifecycleEpoch: this.qsoLifecycleEpoch,
      stateOptions: this.active && this.protocolContext && !this.paused && !this.completion
        ? USER_SELECTABLE_PHASES.map(({ id, label }) => ({
          id,
          label,
          transmitText: deriveWWDigiTransmission(this.protocolContext!, this.getConfig(), id),
        }))
        : [],
      actions: this.getActions(),
      attentions: this.finalRetry?.awaiting73Decision ? [{
        id: 'repeated-final',
        tone: 'warning',
        title: 'attentionRepeatedRr73',
        description: 'attentionRepeatedRr73Desc',
        actionIds: ['send-73-once', 'resend-rr73', 'finish-recovery'],
      }] : this.finalRetry?.awaitingRr73Decision ? [{
        id: 'repeated-exchange',
        tone: 'warning',
        title: 'attentionRepeatedExchange',
        description: 'attentionRepeatedExchangeDesc',
        actionIds: ['resend-rr73', 'finish-recovery'],
      }] : !this.active && this.finalRetry ? [{
        id: 'completion-recovery-observing',
        tone: 'info',
        title: 'attentionRecoveryObserving',
        description: 'attentionRecoveryObservingDesc',
        actionIds: ['resend-rr73', 'finish-recovery'],
      }] : [],
      completion: { state: completionState, recordId: this.completion?.effect.record.id },
      lastReceivedText: this.protocolContext?.lastReceivedText ?? this.recoveryLastReceivedText,
      nextTransmitText: this.getTransmitText() ?? undefined,
    };
  }

  async invokeAction(actionId: string, payload?: unknown): Promise<StrategyActionResult | void> {
    if (actionId === 'pause') {
      this.paused = true;
      return { requestDecision: true };
    }
    if (actionId === 'resume') {
      this.paused = false;
      return { requestDecision: true };
    }
    if (actionId === 'set-frequency') {
      const value = Number((payload as { value?: unknown } | undefined)?.value);
      this.frequencyController.setManual(value);
      return { requestDecision: true };
    }
    if (actionId === 'reset-frequency') {
      this.frequencyController.useAutomatic();
      return { requestDecision: true };
    }
    if (actionId === 'send-alternate') {
      const value = (payload as { value?: unknown } | undefined)?.value;
      if (typeof value !== 'string' || !value.trim() || !this.active || !this.protocolContext) {
        throw new Error('alternate_message_invalid');
      }
      this.protocolContext = setWWDigiOutgoingOverride(
        this.protocolContext,
        value.trim().toUpperCase().replace(/\s+/g, ' '),
      );
      this.paused = false;
      this.attempts = 0;
      return { requestDecision: true };
    }
    if (actionId === 'log-current') {
      if (!this.active || !this.protocolContext?.hasDirectedReply || this.completion) {
        throw new Error('manual_log_not_available');
      }
      this.prepareCompletion();
      const completion = this.completion as CompletionState | undefined;
      if (!completion) return;
      completion.emitted = true;
      return { qsoCompletions: [structuredClone(completion.effect)] };
    }
    if (actionId === 'retry-log') {
      if (!this.completion || this.completion.settled !== 'failed') {
        throw new Error('log_retry_not_available');
      }
      this.completion.settled = undefined;
      this.completion.emitted = true;
      return { qsoCompletions: [structuredClone(this.completion.effect)] };
    }
    if (actionId === 'end-qso') {
      this.releaseRequested = true;
      return { requestDecision: true };
    }
    const retry = this.finalRetry;
    if (!retry) throw new Error('strategy_action_not_available');
    if (actionId === 'send-73-once') {
      retry.scheduledText = retry.seventyThreeText;
      retry.awaitingRr73Decision = false;
      retry.awaiting73Decision = false;
      return { requestDecision: true };
    }
    if (actionId === 'resend-rr73') {
      retry.scheduledText = retry.rr73Text;
      retry.awaitingRr73Decision = false;
      retry.awaiting73Decision = false;
      return { requestDecision: true };
    }
    if (actionId === 'finish-recovery') {
      this.finalRetry = undefined;
      return { requestDecision: true };
    }
    throw new Error('strategy_action_not_available');
  }

  setUserState(stateId: string): boolean {
    if (!this.active || !this.protocolContext || this.completion) return false;
    const option = USER_SELECTABLE_PHASES.find((candidate) => candidate.id === stateId);
    if (!option) return false;
    if (this.protocolContext.phase === option.id) return false;
    const previousPhase = this.protocolContext.phase;
    this.protocolContext = setWWDigiProtocolPhase(this.protocolContext, option.id);
    this.attempts = 0;
    this.logger.info('WW Digi lane state changed by operator', {
      streamId: this.streamId,
      targetCallsign: this.active.callsign,
      from: previousPhase,
      to: option.id,
    });
    return true;
  }

  checkpoint(): unknown {
    return structuredClone({
      active: this.active,
      protocolContext: this.protocolContext,
      qsoLifecycleEpoch: this.qsoLifecycleEpoch,
      attempts: this.attempts,
      completion: this.completion,
      finalRetry: this.finalRetry,
      paused: this.paused,
      recoveryLastReceivedText: this.recoveryLastReceivedText,
      releaseRequested: this.releaseRequested,
      frequency: this.frequencyController.checkpoint(),
      lastPhysicalFrame: this.lastPhysicalFrame,
    } satisfies WWDigiLaneCheckpoint);
  }

  restore(checkpoint: unknown): void {
    const state = checkpoint as WWDigiLaneCheckpoint;
    if (!state || !Number.isInteger(state.qsoLifecycleEpoch)) {
      throw new Error('Invalid WW Digi lane checkpoint');
    }
    this.active = state.active ? structuredClone(state.active) : undefined;
    this.protocolContext = state.protocolContext ? structuredClone(state.protocolContext) : undefined;
    this.qsoLifecycleEpoch = state.qsoLifecycleEpoch;
    this.attempts = state.attempts;
    this.completion = state.completion ? structuredClone(state.completion) : undefined;
    this.finalRetry = state.finalRetry ? { ...state.finalRetry } : undefined;
    this.paused = state.paused === true;
    this.recoveryLastReceivedText = state.recoveryLastReceivedText;
    this.releaseRequested = state.releaseRequested === true;
    this.frequencyController.restore(state.frequency ?? {});
    this.lastPhysicalFrame = state.lastPhysicalFrame ? { ...state.lastPhysicalFrame } : undefined;
  }

  onPhysicalSuccess(receipt: StreamPhysicalReceipt): boolean {
    if (receipt.streamId !== this.streamId) return false;
    const previous = this.lastPhysicalFrame;
    if (previous && (receipt.frameId === previous.frameId && receipt.revision <= previous.revision)) return false;
    this.lastPhysicalFrame = { frameId: receipt.frameId, revision: receipt.revision };

    if (this.finalRetry?.scheduledText && receipt.text === this.finalRetry.scheduledText) {
      this.finalRetry.scheduledText = undefined;
      this.finalRetry.expiresAt = Date.now() + this.getConfig().slotMs * 4;
      return true;
    }
    if (!this.active || !this.protocolContext
        || receipt.text !== deriveWWDigiTransmission(this.protocolContext, this.getConfig())) return true;
    const reduced = reduceWWDigiPhysicalSuccess(
      this.protocolContext,
      receipt.text,
      Date.now(),
      receipt.audioFrequencyHz,
    );
    this.protocolContext = reduced.context;
    this.attempts += 1;
    if (reduced.completed) this.prepareCompletion();
    return true;
  }

  applyDecodedMessagesToCheckpoint(
    checkpoint: unknown,
    messages: ParsedFT8Message[],
  ): unknown | undefined {
    return this.updateCheckpoint(checkpoint, () => this.processReceivedMessages(messages));
  }

  applyPhysicalSuccessToCheckpoint(
    checkpoint: unknown,
    receipt: StreamPhysicalReceipt,
  ): unknown | undefined {
    return this.updateCheckpoint(checkpoint, () => this.onPhysicalSuccess(receipt));
  }

  readProtocolContext(checkpoint?: unknown): WWDigiProtocolContext | undefined {
    if (checkpoint === undefined) {
      return this.protocolContext ? structuredClone(this.protocolContext) : undefined;
    }
    const live = this.checkpoint();
    try {
      this.restore(checkpoint);
      return this.protocolContext ? structuredClone(this.protocolContext) : undefined;
    } finally {
      this.restore(live);
    }
  }

  hasUnsettledCompletionInCheckpoint(checkpoint: unknown): boolean {
    const live = this.checkpoint();
    try {
      this.restore(checkpoint);
      return this.completion !== undefined;
    } finally {
      this.restore(live);
    }
  }

  takePendingCompletionFromCheckpoint(checkpoint: unknown): {
    checkpoint: unknown;
    effect: StrategyQSOCompletionEffect;
  } | undefined {
    const live = this.checkpoint();
    try {
      this.restore(checkpoint);
      if (!this.completion || this.completion.emitted) return undefined;
      this.completion.emitted = true;
      return {
        checkpoint: this.checkpoint(),
        effect: structuredClone(this.completion.effect),
      };
    } finally {
      this.restore(live);
    }
  }

  settleCompletionInCheckpoint(
    checkpoint: unknown,
    settlement: StrategyQSOCompletionSettlement,
  ): unknown | undefined {
    return this.updateCheckpoint(checkpoint, () => this.settleQSOCompletion(settlement));
  }

  retryCompletionInCheckpoint(checkpoint: unknown): {
    checkpoint: unknown;
    effect: StrategyQSOCompletionEffect;
  } | undefined {
    const live = this.checkpoint();
    try {
      this.restore(checkpoint);
      if (!this.completion || this.completion.settled !== 'failed') return undefined;
      this.completion.settled = undefined;
      this.completion.emitted = true;
      return {
        checkpoint: this.checkpoint(),
        effect: structuredClone(this.completion.effect),
      };
    } finally {
      this.restore(live);
    }
  }

  settleQSOCompletion(settlement: StrategyQSOCompletionSettlement): boolean {
    if (!this.completion
        || settlement.streamId !== this.streamId
        || settlement.lifecycleEpoch !== this.qsoLifecycleEpoch
        || settlement.recordId !== this.completion.effect.record.id) return false;
    this.completion.settled = settlement.status;
    this.settleDetachedCompletion(settlement.recordId, settlement.status);
    return true;
  }

  settleDetachedCompletion(recordId: string, status: 'committed' | 'failed'): boolean {
    if (!this.finalRetry || this.finalRetry.completionRecordId !== recordId) return false;
    this.finalRetry.completionState = status;
    return true;
  }

  reset(_reason?: string): void {
    this.active = undefined;
    this.protocolContext = undefined;
    this.attempts = 0;
    this.completion = undefined;
    this.finalRetry = undefined;
    this.paused = false;
    this.recoveryLastReceivedText = undefined;
    this.releaseRequested = false;
    this.frequencyController.useAutomatic();
    this.lastPhysicalFrame = undefined;
  }

  private processReceivedMessages(messages: ParsedFT8Message[]): boolean {
    if (!this.active || !this.protocolContext) return false;
    let changed = false;
    for (const message of messages) {
      const reduced = reduceWWDigiInbound(this.protocolContext, message, this.getConfig());
      if (!reduced.changed) continue;
      this.protocolContext = reduced.context;
      this.attempts = 0;
      if (reduced.completed) this.prepareCompletion(message.timestamp);
      changed = true;
    }
    return changed;
  }

  private updateCheckpoint(checkpoint: unknown, update: () => boolean): unknown | undefined {
    const live = this.checkpoint();
    try {
      this.restore(checkpoint);
      return update() ? this.checkpoint() : undefined;
    } finally {
      this.restore(live);
    }
  }

  private getActions(): StrategyActionDescriptor[] {
    if (!this.active && this.finalRetry) {
      return [
        ...(this.finalRetry.awaiting73Decision ? [{
          id: 'send-73-once', label: 'actionSend73', icon: 'paper-plane', tone: 'primary', presentation: 'primary',
          previewText: this.finalRetry.seventyThreeText,
        } satisfies StrategyActionDescriptor] : []),
        {
          id: 'resend-rr73', label: 'actionResendRr73', icon: 'rotate-right', presentation: 'secondary',
          previewText: this.finalRetry.rr73Text,
        },
        { id: 'finish-recovery', label: 'actionFinishRecovery', icon: 'check', presentation: 'menu' },
      ];
    }
    if (!this.active) return [];
    if (this.completion?.settled === 'failed') {
      return [{
        id: 'retry-log', label: 'actionRetry', icon: 'rotate-right', tone: 'primary', presentation: 'primary',
      }, {
        id: 'end-qso', label: 'actionEndQso', icon: 'xmark', tone: 'danger', presentation: 'menu',
        confirmation: { title: 'confirmEndQso', description: 'confirmEndQsoDesc', confirmLabel: 'actionEndQso' },
      }];
    }
    const protocolText = this.protocolContext
      ? deriveWWDigiTransmission(this.protocolContext, this.getConfig())
      : undefined;
    const actions: StrategyActionDescriptor[] = [
      this.paused
        ? { id: 'resume', label: 'actionResume', icon: 'play', tone: 'primary', presentation: 'primary' }
        : { id: 'pause', label: 'actionPause', icon: 'pause', presentation: 'secondary' },
      {
        id: 'set-frequency', label: 'actionSetFrequency', icon: 'wave-square', presentation: 'menu',
        input: {
          kind: 'audio-frequency', label: 'actionSetFrequency', value: this.audioFrequencyHz,
          min: 100, max: 5000, step: 10, unit: 'Hz', spectrumPick: true,
        },
      },
      {
        id: 'send-alternate', label: 'actionAlternateMessage', icon: 'pen', presentation: 'menu',
        previewText: protocolText,
        input: { kind: 'text', label: 'actionAlternateMessage', value: protocolText ?? '', maxLength: 32 },
      },
    ];
    if (this.frequencyController.mode === 'manual') {
      actions.push({ id: 'reset-frequency', label: 'actionResetFrequency', icon: 'rotate-left', presentation: 'menu' });
    }
    if (this.protocolContext?.hasDirectedReply && !this.completion) {
      actions.push({
        id: 'log-current', label: 'actionLogCurrent', icon: 'book', tone: 'warning', presentation: 'menu',
        confirmation: {
          title: 'confirmLogCurrent',
          description: this.protocolContext.targetGrid ? 'confirmLogCurrentDesc' : 'confirmLogCurrentMissingGrid',
          confirmLabel: 'actionLogCurrent',
        },
      });
    }
    actions.push({
      id: 'end-qso', label: 'actionEndQso', icon: 'xmark', tone: 'danger', presentation: 'menu',
      confirmation: { title: 'confirmEndQso', description: 'confirmEndQsoDesc', confirmLabel: 'actionEndQso' },
    });
    return actions;
  }

  private prepareCompletion(endTime = Date.now()): void {
    if (!this.active || !this.protocolContext || this.completion) return;
    const config = this.getConfig();
    const effect = buildWWDigiCompletionEffect(this.protocolContext, {
      streamId: this.streamId,
      lifecycleEpoch: this.qsoLifecycleEpoch,
      endTime,
      authorizationId: this.active.data.authorizationId,
    }, config);
    this.completion = { effect, emitted: false };
    this.finalRetry = {
      callsign: this.active.callsign,
      completionRecordId: effect.record.id,
      completionState: 'committing',
      rr73Text: buildWWDigiRR73(this.active.callsign, config.myCallsign),
      seventyThreeText: buildWWDigi73(this.active.callsign, config.myCallsign),
      expiresAt: endTime + config.slotMs * 4,
      awaiting73Decision: false,
    };
    this.logger.info('WW Digi lane completed over the air', {
      streamId: this.streamId,
      callsign: this.active.callsign,
      lifecycleEpoch: this.qsoLifecycleEpoch,
    });
  }

  private expireFinalRetry(now: number): void {
    if (this.finalRetry && !this.finalRetry.scheduledText && now > this.finalRetry.expiresAt) {
      this.finalRetry = undefined;
    }
  }
}
