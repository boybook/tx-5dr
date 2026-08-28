import { randomUUID } from 'node:crypto';
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
import { FT8MessageParser } from '@tx5dr/core';
import type {
  ParallelQSOQueueEntry,
  ProtocolLane,
  ProtocolLaneActivation,
  ProtocolLaneDecision,
  ProtocolLaneSnapshot,
} from '@tx5dr/plugin-api/toolkit';
import { LaneFrequencyController } from '@tx5dr/plugin-api/toolkit';
import {
  buildWWDigiGrid,
  buildWWDigi73,
  buildWWDigiRogerGrid,
  buildWWDigiRR73,
  parseWWDigiMessage,
} from './protocol.js';

export interface WWDigiEntryData {
  authorizationId?: string;
  authorizedAt?: number;
  lastMessageRaw?: string;
  targetGrid?: string;
  lastSnr?: number;
  status?: 'candidate' | 'authorized' | 'paused' | 'stale' | 'no-response' | 'review' | 'dupe';
  authorizedReceiveEpoch?: number;
  lastHeardReceiveEpoch?: number;
  lastHeardCycle?: 0 | 1;
  firstHeardAt?: number;
  firstAudioFrequencyHz?: number;
  evidenceRevision?: number;
  dupe?: boolean;
  source?: 'manual' | 'cq';
  noResponseCycles?: number;
  alternateText?: string;
  encodingError?: string;
}

export interface WWDigiLaneConfig {
  myCallsign: string;
  myGrid: string;
  modeName: 'FT8' | 'FT4';
  maxAttempts: number;
  slotMs: number;
}

type LanePhase = 'idle' | 'wait-r-grid' | 'wait-rr73' | 'wait-standard-final' | 'send-rr73' | 'closing' | 'review';
type UserSelectableLanePhase = Extract<LanePhase, 'wait-r-grid' | 'wait-rr73' | 'wait-standard-final' | 'send-rr73'>;

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
  rr73Text: string;
  seventyThreeText: string;
  expiresAt: number;
  scheduledText?: string;
  awaitingRr73Decision?: boolean;
  awaiting73Decision: boolean;
}

interface WWDigiLaneCheckpoint {
  active?: ParallelQSOQueueEntry<WWDigiEntryData>;
  phase: LanePhase;
  outgoing: string | null;
  targetGrid?: string;
  qsoStartTime?: number;
  qsoLifecycleEpoch: number;
  attempts: number;
  history: string[];
  completion?: CompletionState;
  finalRetry?: FinalRetryLease;
  paused: boolean;
  hasDirectedReply: boolean;
  lastReceivedText?: string;
  releaseRequested?: boolean;
  frequency: { manualFrequencyHz?: number };
  lastPhysicalFrame?: { frameId: string; revision: number };
}

function callsignMatches(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left && right && left.trim().toUpperCase() === right.trim().toUpperCase());
}

export class WWDigiProtocolLane implements ProtocolLane<WWDigiEntryData> {
  private active?: ParallelQSOQueueEntry<WWDigiEntryData>;
  private phase: LanePhase = 'idle';
  private outgoing: string | null = null;
  private targetGrid?: string;
  private qsoStartTime?: number;
  private qsoLifecycleEpoch = 0;
  private attempts = 0;
  private history: string[] = [];
  private completion?: CompletionState;
  private finalRetry?: FinalRetryLease;
  private paused = false;
  private hasDirectedReply = false;
  private lastReceivedText?: string;
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
    const config = this.getConfig();
    // New authorized work takes precedence over a passive post-completion observer.
    this.finalRetry = undefined;
    this.active = structuredClone(entry);
    this.qsoLifecycleEpoch += 1;
    this.qsoStartTime = Date.now();
    this.attempts = 0;
    this.history = entry.data.lastMessageRaw ? [entry.data.lastMessageRaw] : [];
    this.targetGrid = entry.data.targetGrid;
    this.completion = undefined;
    this.lastPhysicalFrame = undefined;
    this.paused = false;
    this.hasDirectedReply = false;
    this.lastReceivedText = undefined;
    this.releaseRequested = false;

    if (entry.data.alternateText) {
      this.phase = 'wait-r-grid';
      this.outgoing = entry.data.alternateText;
      return { accepted: true };
    }
    const selected = entry.data.lastMessageRaw
      ? parseWWDigiMessage(entry.data.lastMessageRaw)
      : { type: 'unknown' as const };
    const selectedStandard = entry.data.lastMessageRaw
      ? FT8MessageParser.parseMessage(entry.data.lastMessageRaw)
      : undefined;
    if (selectedStandard?.type === FT8MessageType.SIGNAL_REPORT
        && callsignMatches(selectedStandard.targetCallsign, config.myCallsign)
        && callsignMatches(selectedStandard.senderCallsign, entry.callsign)) {
      this.phase = 'wait-standard-final';
      this.hasDirectedReply = true;
      this.lastReceivedText = entry.data.lastMessageRaw;
      this.outgoing = FT8MessageParser.generateMessage({
        type: FT8MessageType.ROGER_REPORT,
        senderCallsign: config.myCallsign,
        targetCallsign: entry.callsign,
        report: entry.data.lastSnr ?? 0,
      });
    } else if (selected.type === 'grid'
        && callsignMatches(selected.targetCallsign, config.myCallsign)
        && callsignMatches(selected.senderCallsign, entry.callsign)) {
      this.targetGrid = selected.grid;
      this.hasDirectedReply = true;
      this.lastReceivedText = entry.data.lastMessageRaw;
      this.phase = 'wait-rr73';
      this.outgoing = buildWWDigiRogerGrid(entry.callsign, config.myCallsign, config.myGrid);
    } else {
      if (selected.type === 'cq' && callsignMatches(selected.senderCallsign, entry.callsign)) {
        this.targetGrid = selected.grid;
      }
      this.phase = 'wait-r-grid';
      this.outgoing = buildWWDigiGrid(entry.callsign, config.myCallsign, config.myGrid);
    }
    return { accepted: true };
  }

  deactivate(_reason: string): void {
    this.active = undefined;
    this.phase = 'idle';
    this.outgoing = null;
    this.targetGrid = undefined;
    this.qsoStartTime = undefined;
    this.attempts = 0;
    this.history = [];
    this.completion = undefined;
    this.lastPhysicalFrame = undefined;
    this.paused = false;
    this.hasDirectedReply = false;
    this.lastReceivedText = undefined;
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
        this.lastReceivedText = message.rawMessage;
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
        this.lastReceivedText = message.rawMessage;
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
    if (!this.active) return {};
    if (this.releaseRequested) {
      return {
        release: { disposition: 'remove-entry', reason: 'WW Digi QSO ended by operator' },
        queueChanged: true,
      };
    }
    const config = this.getConfig();
    let queueChanged = false;

    for (const message of messages) {
      const parsed = parseWWDigiMessage(message.rawMessage);
      const standard = message.message;
      if (!('senderCallsign' in parsed)
          || !callsignMatches(parsed.senderCallsign, this.active.callsign)) {
        if (this.phase === 'wait-r-grid'
            && standard.type === FT8MessageType.SIGNAL_REPORT
            && callsignMatches(standard.senderCallsign, this.active.callsign)
            && callsignMatches(standard.targetCallsign, config.myCallsign)) {
          this.acceptInbound(message.rawMessage);
          this.phase = 'wait-standard-final';
          this.outgoing = FT8MessageParser.generateMessage({
            type: FT8MessageType.ROGER_REPORT,
            senderCallsign: config.myCallsign,
            targetCallsign: this.active.callsign,
            report: message.snr,
          });
          this.attempts = 0;
          queueChanged = true;
        } else if ((this.phase === 'wait-standard-final' || this.phase === 'wait-rr73')
            && this.attempts > 0
            && (standard.type === FT8MessageType.RRR
              || standard.type === FT8MessageType.SEVENTY_THREE)
            && callsignMatches(standard.senderCallsign, this.active.callsign)
            && callsignMatches(standard.targetCallsign, config.myCallsign)) {
          this.acceptInbound(message.rawMessage);
          this.prepareCompletion();
          queueChanged = true;
        }
        continue;
      }

      if (this.phase === 'wait-r-grid' && parsed.type === 'roger-grid'
          && callsignMatches(parsed.targetCallsign, config.myCallsign)) {
        this.acceptInbound(message.rawMessage);
        this.targetGrid = parsed.grid;
        this.phase = 'send-rr73';
        this.outgoing = buildWWDigiRR73(this.active.callsign, config.myCallsign);
        this.attempts = 0;
        queueChanged = true;
      } else if (this.phase === 'wait-rr73' && parsed.type === 'rr73'
          && callsignMatches(parsed.targetCallsign, config.myCallsign)) {
        this.acceptInbound(message.rawMessage);
        this.prepareCompletion();
        queueChanged = true;
      } else if (this.phase === 'wait-standard-final' && this.attempts > 0 && parsed.type === 'rr73'
          && callsignMatches(parsed.targetCallsign, config.myCallsign)) {
        this.acceptInbound(message.rawMessage);
        this.prepareCompletion();
        queueChanged = true;
      }
    }

    if (this.completion?.settled === 'committed') {
      return {
        release: { disposition: 'remove-entry', reason: 'WW Digi QSO committed' },
        queueChanged: true,
      };
    }
    if (this.completion?.settled === 'failed') {
      this.phase = 'review';
      return { queueChanged: true };
    }
    if (this.completion && !this.completion.emitted) {
      this.completion.emitted = true;
      return { qsoCompletion: structuredClone(this.completion.effect), queueChanged };
    }
    if (!this.completion && this.attempts >= Math.max(1, config.maxAttempts)) {
      const callsign = this.active.callsign;
      const timeoutStage = this.phase;
      this.phase = 'idle';
      this.outgoing = null;
      return {
        qsoFailure: {
          targetCallsign: callsign,
          reason: 'ww_digi_no_response',
          stage: timeoutStage,
          unansweredTransmissions: this.attempts,
          hadTargetReply: this.history.length > 1,
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
    if (this.phase === 'review' || this.phase === 'closing') return null;
    return this.outgoing;
  }

  getSnapshot(): ProtocolLaneSnapshot | null {
    if (!this.active && !this.finalRetry) return null;
    const completionState = !this.active && this.finalRetry ? 'committed'
      : this.completion?.settled === 'failed' ? 'failed'
      : this.completion?.settled === 'committed' ? 'committed'
        : this.completion ? 'committing'
          : this.hasDirectedReply ? 'ready' : 'not-ready';
    return {
      currentState: this.active ? this.phase : 'final-retry',
      targetCallsign: this.active?.callsign ?? this.finalRetry?.callsign,
      targetGrid: this.targetGrid,
      qsoLifecycleEpoch: this.qsoLifecycleEpoch,
      stateOptions: this.active && !this.paused && !this.completion && this.phase !== 'review' && this.phase !== 'closing'
        ? USER_SELECTABLE_PHASES.map(({ id, label }) => ({
          id,
          label,
          transmitText: id === this.phase ? this.outgoing ?? undefined : this.transmitTextForPhase(id) ?? undefined,
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
      lastReceivedText: this.lastReceivedText,
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
      if (typeof value !== 'string' || !value.trim() || !this.active) throw new Error('alternate_message_invalid');
      this.outgoing = value.trim().toUpperCase().replace(/\s+/g, ' ');
      this.paused = false;
      this.attempts = 0;
      return { requestDecision: true };
    }
    if (actionId === 'log-current') {
      if (!this.active || !this.hasDirectedReply || this.completion) throw new Error('manual_log_not_available');
      this.prepareCompletion();
      const completion = this.completion as CompletionState | undefined;
      if (!completion) return;
      completion.emitted = true;
      return { qsoCompletions: [structuredClone(completion.effect)] };
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
    if (!this.active || this.completion) return false;
    const option = USER_SELECTABLE_PHASES.find((candidate) => candidate.id === stateId);
    if (!option) return false;
    if (this.phase === option.id) return false;
    const outgoing = this.transmitTextForPhase(option.id);
    if (!outgoing) return false;
    const previousPhase = this.phase;
    this.phase = option.id;
    this.outgoing = outgoing;
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
      phase: this.phase,
      outgoing: this.outgoing,
      targetGrid: this.targetGrid,
      qsoStartTime: this.qsoStartTime,
      qsoLifecycleEpoch: this.qsoLifecycleEpoch,
      attempts: this.attempts,
      history: this.history,
      completion: this.completion,
      finalRetry: this.finalRetry,
      paused: this.paused,
      hasDirectedReply: this.hasDirectedReply,
      lastReceivedText: this.lastReceivedText,
      releaseRequested: this.releaseRequested,
      frequency: this.frequencyController.checkpoint(),
      lastPhysicalFrame: this.lastPhysicalFrame,
    } satisfies WWDigiLaneCheckpoint);
  }

  restore(checkpoint: unknown): void {
    const state = checkpoint as WWDigiLaneCheckpoint;
    if (!state || !Array.isArray(state.history)) throw new Error('Invalid WW Digi lane checkpoint');
    this.active = state.active ? structuredClone(state.active) : undefined;
    this.phase = state.phase;
    this.outgoing = state.outgoing;
    this.targetGrid = state.targetGrid;
    this.qsoStartTime = state.qsoStartTime;
    this.qsoLifecycleEpoch = state.qsoLifecycleEpoch;
    this.attempts = state.attempts;
    this.history = [...state.history];
    this.completion = state.completion ? structuredClone(state.completion) : undefined;
    this.finalRetry = state.finalRetry ? { ...state.finalRetry } : undefined;
    this.paused = state.paused === true;
    this.hasDirectedReply = state.hasDirectedReply === true;
    this.lastReceivedText = state.lastReceivedText;
    this.releaseRequested = state.releaseRequested === true;
    this.frequencyController.restore(state.frequency ?? {});
    this.lastPhysicalFrame = state.lastPhysicalFrame ? { ...state.lastPhysicalFrame } : undefined;
  }

  onPhysicalSuccess(receipt: StreamPhysicalReceipt): void {
    if (receipt.streamId !== this.streamId) return;
    const previous = this.lastPhysicalFrame;
    if (previous && (receipt.frameId === previous.frameId && receipt.revision <= previous.revision)) return;
    this.lastPhysicalFrame = { frameId: receipt.frameId, revision: receipt.revision };

    if (this.finalRetry?.scheduledText && receipt.text === this.finalRetry.scheduledText) {
      this.finalRetry.scheduledText = undefined;
      this.finalRetry.expiresAt = Date.now() + this.getConfig().slotMs * 4;
      return;
    }
    if (!this.active || receipt.text !== this.outgoing) return;
    this.history.push(receipt.text);
    this.attempts += 1;
    if (this.phase === 'send-rr73' && this.hasDirectedReply) this.prepareCompletion();
  }

  settleQSOCompletion(settlement: StrategyQSOCompletionSettlement): boolean {
    if (!this.completion
        || settlement.streamId !== this.streamId
        || settlement.lifecycleEpoch !== this.qsoLifecycleEpoch) return false;
    this.completion.settled = settlement.status;
    if (settlement.status === 'failed') {
      this.phase = 'review';
      this.outgoing = null;
    }
    return true;
  }

  reset(_reason?: string): void {
    this.active = undefined;
    this.phase = 'idle';
    this.outgoing = null;
    this.targetGrid = undefined;
    this.qsoStartTime = undefined;
    this.qsoLifecycleEpoch = 0;
    this.attempts = 0;
    this.history = [];
    this.completion = undefined;
    this.finalRetry = undefined;
    this.paused = false;
    this.hasDirectedReply = false;
    this.lastReceivedText = undefined;
    this.releaseRequested = false;
    this.frequencyController.useAutomatic();
    this.lastPhysicalFrame = undefined;
  }

  private acceptInbound(rawMessage: string): void {
    if (this.history[this.history.length - 1] !== rawMessage) this.history.push(rawMessage);
    this.hasDirectedReply = true;
    this.lastReceivedText = rawMessage;
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
        previewText: this.outgoing ?? undefined,
        input: { kind: 'text', label: 'actionAlternateMessage', value: this.outgoing ?? '', maxLength: 32 },
      },
    ];
    if (this.frequencyController.mode === 'manual') {
      actions.push({ id: 'reset-frequency', label: 'actionResetFrequency', icon: 'rotate-left', presentation: 'menu' });
    }
    if (this.hasDirectedReply && !this.completion) {
      actions.push({
        id: 'log-current', label: 'actionLogCurrent', icon: 'book', tone: 'warning', presentation: 'menu',
        confirmation: {
          title: 'confirmLogCurrent',
          description: this.targetGrid ? 'confirmLogCurrentDesc' : 'confirmLogCurrentMissingGrid',
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

  private transmitTextForPhase(phase: UserSelectableLanePhase): string | null {
    if (!this.active) return null;
    const config = this.getConfig();
    if (phase === 'wait-r-grid') {
      return buildWWDigiGrid(this.active.callsign, config.myCallsign, config.myGrid);
    }
    if (phase === 'wait-rr73') {
      return buildWWDigiRogerGrid(this.active.callsign, config.myCallsign, config.myGrid);
    }
    if (phase === 'wait-standard-final') {
      return FT8MessageParser.generateMessage({
        type: FT8MessageType.ROGER_REPORT,
        senderCallsign: config.myCallsign,
        targetCallsign: this.active.callsign,
        report: this.active.data.lastSnr ?? 0,
      });
    }
    return buildWWDigiRR73(this.active.callsign, config.myCallsign);
  }

  private prepareCompletion(): void {
    if (!this.active || this.completion) return;
    const config = this.getConfig();
    const now = Date.now();
    const recordId = randomUUID();
    const effect: StrategyQSOCompletionEffect = {
      streamId: this.streamId,
      lifecycleEpoch: this.qsoLifecycleEpoch,
      persistencePolicy: 'preserve-distinct',
      metadata: {
        authorizationId: this.active.data.authorizationId,
        streamId: this.streamId,
      },
      record: {
        id: recordId,
        callsign: this.active.callsign,
        grid: this.targetGrid,
        frequency: this.audioFrequencyHz,
        mode: config.modeName,
        startTime: this.qsoStartTime ?? now,
        endTime: now,
        messageHistory: [...this.history],
        myCallsign: config.myCallsign,
        myGrid: config.myGrid,
        contestId: 'WW-DIGI',
      },
    };
    this.completion = { effect, emitted: false };
    this.phase = 'closing';
    this.outgoing = null;
    this.finalRetry = {
      callsign: this.active.callsign,
      rr73Text: buildWWDigiRR73(this.active.callsign, config.myCallsign),
      seventyThreeText: buildWWDigi73(this.active.callsign, config.myCallsign),
      expiresAt: now + config.slotMs * 4,
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
