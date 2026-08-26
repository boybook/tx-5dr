import { randomUUID } from 'node:crypto';
import type {
  ParsedFT8Message,
  PluginLogger,
  QueuedStrategyObservationMeta,
  StrategyDecisionMetaV2,
  StrategyQSOCompletionEffect,
  StrategyQSOCompletionSettlement,
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
} from '../_shared/parallel-qso/ProtocolLane.js';
import {
  buildWWDigiGrid,
  buildWWDigiRogerGrid,
  buildWWDigiRR73,
  parseWWDigiMessage,
} from './protocol.js';

export interface WWDigiEntryData {
  authorizationId: string;
  authorizedAt: number;
  lastMessageRaw?: string;
  targetGrid?: string;
  lastSnr?: number;
  status?: 'queued' | 'no-response' | 'review';
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
  text: string;
  expiresAt: number;
  scheduled: boolean;
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
  private lastPhysicalFrame?: { frameId: string; revision: number };

  constructor(
    readonly streamId: string,
    private readonly resolveAudioFrequencyHz: () => number,
    private readonly getConfig: () => WWDigiLaneConfig,
    private readonly logger: PluginLogger,
  ) {}

  get audioFrequencyHz(): number {
    return this.resolveAudioFrequencyHz();
  }

  activate(entry: Readonly<ParallelQSOQueueEntry<WWDigiEntryData>>): ProtocolLaneActivation {
    if (this.active || this.hasPendingWork()) return { accepted: false };
    const config = this.getConfig();
    this.active = structuredClone(entry);
    this.qsoLifecycleEpoch += 1;
    this.qsoStartTime = Date.now();
    this.attempts = 0;
    this.history = entry.data.lastMessageRaw ? [entry.data.lastMessageRaw] : [];
    this.targetGrid = entry.data.targetGrid;
    this.completion = undefined;
    this.lastPhysicalFrame = undefined;

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
  }

  hasPendingWork(): boolean {
    this.expireFinalRetry(Date.now());
    return Boolean(this.active || this.finalRetry);
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
        lease.scheduled = true;
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
        } else if (this.phase === 'wait-standard-final'
            && this.attempts > 0
            && (standard.type === FT8MessageType.RRR
              || standard.type === FT8MessageType.SEVENTY_THREE)
            && callsignMatches(standard.senderCallsign, this.active.callsign)
            && callsignMatches(standard.targetCallsign, config.myCallsign)) {
          this.acceptInbound(message.rawMessage);
          this.prepareCompletion(false);
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
        this.prepareCompletion(false);
        queueChanged = true;
      } else if (this.phase === 'wait-standard-final' && this.attempts > 0 && parsed.type === 'rr73'
          && callsignMatches(parsed.targetCallsign, config.myCallsign)) {
        this.acceptInbound(message.rawMessage);
        this.prepareCompletion(false);
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
    if (this.finalRetry?.scheduled) return this.finalRetry.text;
    if (this.phase === 'review' || this.phase === 'closing') return null;
    return this.outgoing;
  }

  getSnapshot(): ProtocolLaneSnapshot | null {
    if (!this.active && !this.finalRetry) return null;
    return {
      currentState: this.active ? this.phase : 'final-retry',
      targetCallsign: this.active?.callsign ?? this.finalRetry?.callsign,
      targetGrid: this.targetGrid,
      qsoLifecycleEpoch: this.qsoLifecycleEpoch,
      stateOptions: this.active && !this.completion && this.phase !== 'review' && this.phase !== 'closing'
        ? USER_SELECTABLE_PHASES.map(({ id, label }) => ({
          id,
          label,
          transmitText: id === this.phase ? this.outgoing ?? undefined : this.transmitTextForPhase(id) ?? undefined,
        }))
        : [],
    };
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
    this.lastPhysicalFrame = state.lastPhysicalFrame ? { ...state.lastPhysicalFrame } : undefined;
  }

  onPhysicalSuccess(receipt: StreamPhysicalReceipt): void {
    if (receipt.streamId !== this.streamId) return;
    const previous = this.lastPhysicalFrame;
    if (previous && (receipt.frameId === previous.frameId && receipt.revision <= previous.revision)) return;
    this.lastPhysicalFrame = { frameId: receipt.frameId, revision: receipt.revision };

    if (this.finalRetry?.scheduled && receipt.text === this.finalRetry.text) {
      this.finalRetry.scheduled = false;
      this.finalRetry.expiresAt = Date.now() + this.getConfig().slotMs * 2;
      return;
    }
    if (!this.active || receipt.text !== this.outgoing) return;
    this.history.push(receipt.text);
    this.attempts += 1;
    if (this.phase === 'send-rr73') this.prepareCompletion(true);
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
    this.lastPhysicalFrame = undefined;
  }

  private acceptInbound(rawMessage: string): void {
    if (this.history[this.history.length - 1] !== rawMessage) this.history.push(rawMessage);
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

  private prepareCompletion(withFinalRetry: boolean): void {
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
    if (withFinalRetry) {
      this.finalRetry = {
        callsign: this.active.callsign,
        text: buildWWDigiRR73(this.active.callsign, config.myCallsign),
        expiresAt: now + config.slotMs * 2,
        scheduled: false,
      };
    }
    this.logger.info('WW Digi lane completed over the air', {
      streamId: this.streamId,
      callsign: this.active.callsign,
      lifecycleEpoch: this.qsoLifecycleEpoch,
    });
  }

  private expireFinalRetry(now: number): void {
    if (this.finalRetry && !this.finalRetry.scheduled && now > this.finalRetry.expiresAt) {
      this.finalRetry = undefined;
    }
  }
}
