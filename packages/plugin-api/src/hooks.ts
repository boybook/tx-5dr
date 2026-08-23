import type { ParsedFT8Message, SlotInfo, SlotPack, QSORecord, FrameMessage, FrequencyState, PluginPermission } from '@tx5dr/contracts';
import type { PluginContextFor } from './context.js';

/**
 * Candidate message plus an accumulated ranking score.
 *
 * The host constructs this shape before invoking
 * {@link PluginHooks.onScoreCandidates}. Each scoring plugin may adjust the
 * numeric `score`, then the host uses the final values to rank target stations.
 */
export interface ScoredCandidate extends ParsedFT8Message {
  /**
   * Relative desirability assigned by the scoring pipeline.
   *
   * Higher values are preferred. Plugins may add or subtract from the incoming
   * score, which means scoring logic composes naturally across multiple utility
   * plugins.
   */
  score: number;
}

/** Structured explanation emitted when an active QSO lifecycle fails. */
export interface QSOFailureInfo {
  /** Callsign of the station being worked when the failure occurred. */
  targetCallsign: string;
  /** Human-readable failure summary suitable for diagnostics. */
  reason: string;
  /** Optional protocol/runtime stage identifier, such as `TX2`. */
  stage?: string;
  /** Number of transmissions that received no response, when applicable. */
  unansweredTransmissions?: number;
  /** Whether the target replied at least once before the failure. */
  hadTargetReply?: boolean;
}

/**
 * Decision returned from {@link StrategyRuntime.decide}.
 *
 * The shape is intentionally extensible so future API revisions can add new
 * control signals without breaking existing plugins.
 */
export interface StrategyDecision {
  /**
   * Requests that the host stop this operator's automation and leave the
   * active QSO flow. This is a policy stop, not a physical RF interrupt: any
   * committed/on-air frame is allowed to finish.
   */
  stop?: boolean;
  /**
   * Requests that the host keep a short receive-only gate after a successful
   * QSO stop. This lets a strategy turn off CQ/transmit UI while still
   * accepting direct protocol calls that arrive in the completion window.
   */
  silentListen?: {
    reason: 'qso-success';
    acceptDirectedCalls: boolean;
    graceSlots?: number;
    excludeCallsigns?: string[];
  };
  /** Optional structured reason for a strategy-requested QSO failure stop. */
  qsoFailure?: QSOFailureInfo;
}

/**
 * Metadata describing why a strategy decision is being evaluated.
 *
 * @deprecated API v2 strategy runtimes receive `StrategyDecisionMetaV2` from
 * `runtime.ts`; this legacy shape is retained for source compatibility only.
 */
export interface StrategyDecisionMeta {
  /**
   * Indicates that the host is re-processing a late decode during the same TX
   * window rather than advancing to a brand-new decision cycle.
   *
   * Strategy runtimes can use this to avoid double-counting timeouts or other
   * one-shot transitions.
   */
  isReDecision?: boolean;
}

/**
 * Pairing of a received frame and its slot metadata.
 *
 * This is commonly passed back into strategy/runtime APIs when a plugin wants
 * to remember which exact message triggered a target selection.
 */
export interface LastMessageInfo {
  /** Original frame as received from the decoder or playback pipeline. */
  message: FrameMessage;
  /** Slot timing metadata for the frame. */
  slotInfo: SlotInfo;
}

/**
 * Declarative automatic-call request proposed by a utility plugin.
 *
 * Utility plugins should prefer returning this shape from
 * {@link PluginHooks.onAutoCallCandidate} instead of directly submitting a call
 * command from a broadcast hook. This lets the host arbitrate between multiple
 * simultaneous auto-call plugins in a deterministic way.
 */
export interface AutoCallProposal {
  /** Target callsign that should be called next. */
  callsign: string;
  /** Optional arbitration priority; higher values win. */
  priority?: number;
  /** Optional triggering frame context used to preserve slot alignment. */
  lastMessage?: LastMessageInfo;
}

/**
 * Immutable metadata about the automatic-call proposal that won arbitration.
 */
export interface AutoCallExecutionRequest {
  /** Plugin name that produced the winning proposal. */
  sourcePluginName: string;
  /** Target callsign chosen by the arbitration step. */
  callsign: string;
  /** Slot that is currently being processed when the autocall starts. */
  slotInfo: SlotInfo;
  /**
   * Source receive slot that produced the accepted proposal.
   *
   * Execution-stage plugins should prefer this slot when they need to inspect
   * the decode environment that triggered the autocall, such as picking a
   * quieter transmit offset from the previous RX slot.
   */
  sourceSlotInfo?: SlotInfo;
  /** Optional triggering frame context preserved from the proposal stage. */
  lastMessage?: LastMessageInfo;
}

/**
 * Host-managed execution plan for an accepted automatic-call proposal.
 *
 * Utility plugins may refine this plan in
 * {@link PluginHooks.onConfigureAutoCallExecution}. The host then applies the
 * merged plan before calling the active strategy runtime.
 */
export interface AutoCallExecutionPlan {
  /**
   * Optional transmit audio offset to apply before starting the automatic call.
   */
  audioFrequency?: number;
}

/**
 * Raw and parsed decode activity for one slot.
 *
 * This is intentionally protocol-neutral: plugins can consume the original
 * `SlotPack.frames` when they need decoder metadata such as confidence while
 * still receiving the host-parsed messages used by normal decision hooks.
 */
export interface SlotActivityEvent {
  /** Timing and identity of the slot represented by this event. */
  slotInfo: SlotInfo;
  /** Complete decoder slot pack, or `null` for reset/no-pack events. */
  slotPack: SlotPack | null;
  /** Original decoder frames in their received order. */
  frames: FrameMessage[];
  /** Host-parsed messages derived from the frames. */
  messages: ParsedFT8Message[];
  /** Whether the data is live, replayed, or clearing prior slot state. */
  source: 'live' | 'replay' | 'reset';
}

/**
 * Protocol-neutral radio frequency/band change event.
 */
export type FrequencyChangeState = FrequencyState;

/**
 * Hook collection implemented by a plugin.
 *
 * Hooks fall into three broad categories:
 * - pipeline hooks transform candidate lists before target selection;
 * - strategy-only hooks steer the active automation runtime;
 * - broadcast hooks observe lifecycle events and side effects.
 *
 * Hooks should be quick and defensive. A misbehaving plugin can delay the whole
 * decode pipeline, so expensive work should be throttled, cached, or explicitly
 * awaited with cancellation and error handling rather than detached in the
 * background.
 *
 * DTO arguments are detached snapshots and may be inspected or transformed
 * without mutating Host state. `ctx` properties that perform Host operations are
 * live capabilities and may only be invoked before the current Hook settles.
 */
export interface PluginHooks<Permissions extends readonly PluginPermission[] = readonly []> {
  /**
   * Proposes an automatic call target while the operator is idle.
   *
   * The host collects proposals from all active utility plugins, resolves
   * conflicts deterministically, and then triggers at most one host-managed
   * `requestCall(...)` action for the winning proposal.
   */
  onAutoCallCandidate?(
    slotInfo: SlotInfo,
    messages: ParsedFT8Message[],
    ctx: PluginContextFor<Permissions>,
  ): AutoCallProposal | null | undefined | Promise<AutoCallProposal | null | undefined>;

  /**
   * Refines how an accepted automatic-call proposal should be executed.
   *
   * The host runs this as a utility-plugin pipeline after proposal
   * arbitration. Each plugin receives the current execution plan and may return
   * an updated copy. This is the preferred place to centralize execution
   * policies such as pre-call frequency selection.
   */
  onConfigureAutoCallExecution?(
    request: AutoCallExecutionRequest,
    plan: AutoCallExecutionPlan,
    ctx: PluginContextFor<Permissions>,
  ): AutoCallExecutionPlan | null | undefined | Promise<AutoCallExecutionPlan | null | undefined>;

  /**
   * Filters candidate target messages before the scoring phase.
   *
   * The returned array feeds into the next plugin in the utility pipeline.
   * Returning an empty array intentionally removes every remaining candidate.
   */
  onFilterCandidates?(
    candidates: ParsedFT8Message[],
    ctx: PluginContextFor<Permissions>,
  ): ParsedFT8Message[] | Promise<ParsedFT8Message[]>;

  /**
   * Adjusts ranking scores for the current candidate list.
   *
   * Implementations typically add bonuses or penalties based on DXCC, signal
   * quality, duplicate history or custom operator preferences.
   */
  onScoreCandidates?(
    candidates: ScoredCandidate[],
    ctx: PluginContextFor<Permissions>,
  ): ScoredCandidate[] | Promise<ScoredCandidate[]>;

  /**
   * Broadcast at the start of every slot with the slot metadata and decoded
   * messages already associated with that slot.
   */
  onSlotStart?(slotInfo: SlotInfo, messages: ParsedFT8Message[], ctx: PluginContextFor<Permissions>): void | Promise<void>;

  /**
   * Broadcast with raw slot/frame context plus parsed messages.
   *
   * Prefer this hook when a plugin needs full decoder metadata or wants to
   * preserve a cache suitable for replay/status integrations.
   */
  onSlotActivity?(event: SlotActivityEvent, ctx: PluginContextFor<Permissions>): void | Promise<void>;

  /**
   * Broadcast whenever decoded messages become available.
   *
   * This fires even when the operator is idle, which makes it a good place for
   * monitoring, trigger detection and passive analytics.
   */
  onDecode?(messages: ParsedFT8Message[], ctx: PluginContextFor<Permissions>): void | Promise<void>;

  /**
   * Broadcast when the host operating frequency or band changes.
   */
  onFrequencyChange?(state: FrequencyChangeState, ctx: PluginContextFor<Permissions>): void | Promise<void>;

  /**
   * Reserved QSO-start notification.
   *
   * @deprecated The Host does not currently dispatch this hook. Do not use it
   * for state transitions; observe decoded/slot activity or the active strategy
   * snapshot instead until an explicit QSO-start event is implemented.
   */
  onQSOStart?(info: { targetCallsign: string; grid?: string }, ctx: PluginContextFor<Permissions>): void | Promise<void>;

  /**
   * Broadcast after a QSO has been completed and recorded.
   */
  onQSOComplete?(record: QSORecord, ctx: PluginContextFor<Permissions>): void | Promise<void>;

  /**
   * Broadcast when an in-progress QSO terminates unsuccessfully.
   */
  onQSOFail?(info: QSOFailureInfo, ctx: PluginContextFor<Permissions>): void | Promise<void>;

  /**
   * Broadcast when a named timer created through {@link PluginContext.timers}
   * fires.
   */
  onTimer?(timerId: string, ctx: PluginContextFor<Permissions>): void | Promise<void>;

  /**
   * Broadcast when the user clicks one of the plugin's declared quick actions.
   */
  onUserAction?(actionId: string, payload: unknown, ctx: PluginContextFor<Permissions>): void | Promise<void>;

  /**
   * Broadcast after one or more persisted plugin settings have changed.
   *
   * The first argument is the Host's merged persisted settings object for the
   * affected scope, not only the keys changed by the latest update.
   */
  onConfigChange?(changes: Record<string, unknown>, ctx: PluginContextFor<Permissions>): void | Promise<void>;
}
