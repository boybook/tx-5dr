import type { ParsedFT8Message, FrameMessage, SlotInfo, QSORecord } from '@tx5dr/contracts';
import type { StrategyDecision } from './hooks.js';

/**
 * Legacy identifiers for the six selectable FT8 transmit messages.
 *
 * These labels describe message choices, not T/R time slots or parallel QSO
 * streams. User-facing interfaces should call them Tx messages.
 */
export type StrategyRuntimeSlot = 'TX1' | 'TX2' | 'TX3' | 'TX4' | 'TX5' | 'TX6';

/**
 * Mutable strategy context maintained by the host/runtime pair.
 *
 * This object captures the operator's current conversation target and selected
 * radio metadata. Strategy implementations can patch it incrementally through
 * {@link StrategyRuntime.patchContext}.
 */
export interface StrategyRuntimeContext {
  /** Currently selected target callsign, if any. */
  targetCallsign?: string;
  /** Grid locator reported by the target station, if known. */
  targetGrid?: string;
  /** Signal report sent to the target station. */
  reportSent?: number;
  /** Signal report received from the target station. */
  reportReceived?: number;
  /** Actual RF/audio frequency being used for the active QSO. */
  actualFrequency?: number;
}

/**
 * Serializable snapshot of the strategy runtime.
 *
 * The host forwards this structure to operator-facing UI so users can inspect
 * the current automation state without coupling the UI to strategy internals.
 */
export interface StrategyRuntimeSnapshot {
  /** Stable or semi-stable state identifier chosen by the strategy runtime. */
  currentState: string;
  /** Text currently queued or associated with each logical transmit slot. */
  slots?: Partial<Record<StrategyRuntimeSlot, string>>;
  /** Current conversation metadata tracked by the runtime. */
  context?: StrategyRuntimeContext;
  /** Optional legacy list of user-visible next Tx messages or branch hints. */
  availableSlots?: string[];
  /** Host correlation token for QSO persistence; it is not an RF decision epoch. */
  qsoLifecycleEpoch?: number;
  /** Active protocol lanes owned by a parallel-capable strategy. */
  streams?: StrategyStreamSnapshot[];
  /** Optional compact projection exposed by queue-capable strategies. */
  queue?: AssistedQueueSnapshot;
  /** Plugin-declared operator controls rendered without business interpretation. */
  actions?: StrategyActionDescriptor[];
  /** Plugin-declared operator attention items. */
  attentions?: StrategyAttention[];
  /** Optional strategy-owned presentation for decoded message history. */
  messagePresentation?: StrategyMessagePresentationProjection;
  /** Strategy-owned operator-start gate, enforced by both Host UI and Server. */
  transmitGate?: StrategyTransmitGate;
}

/** Semantic tone requested by strategy-owned message presentation rules. */
export type StrategyMessagePresentationTone = 'neutral' | 'primary' | 'secondary' | 'success' | 'warning' | 'danger';

/** Compact label and semantic tone rendered beside a decoded message. */
export interface StrategyMessagePresentationBadge {
  /** Literal label or plugin locale key. */
  label: string;
  /** Host-themed semantic tone; plugins cannot provide CSS. */
  tone: StrategyMessagePresentationTone;
}

/** Bounded token matcher evaluated by the Host against normalized message tokens. */
export interface StrategyMessagePresentationTokenMatch {
  /** Exact, case-insensitive token matching; arbitrary regular expressions are not accepted. */
  firstTokenIn?: string[];
  /** Matches when any normalized message token equals one of these values. */
  anyTokenIn?: string[];
}

/** Named visual class assigned by a strategy presentation projection. */
export interface StrategyMessagePresentationClass {
  /** @deprecated Use `badges`; retained for API v2 snapshot compatibility. */
  badge?: { label: string; tone: StrategyMessagePresentationTone };
  /** Badges revealed when the optional emphasis matcher succeeds. */
  badges?: StrategyMessagePresentationBadge[];
  /** Semantic row treatment; Host maps tones to its theme and never accepts plugin CSS. */
  row?: {
    tone: StrategyMessagePresentationTone;
    background?: 'none' | 'soft';
    accent?: boolean;
  };
  /**
   * Only expose badges and soft row emphasis when any matcher succeeds.
   * The accent, text decoration and opacity remain visible when none match.
   */
  emphasisWhen?: StrategyMessagePresentationTokenMatch[];
  /** Optional semantic strike-through for completed or excluded rows. */
  textDecoration?: 'line-through';
  /** Optional semantic opacity treatment. */
  opacity?: 'normal' | 'muted';
}

/** Assigns a class when a Host-extracted fact is new within a partition. */
export interface StrategyMessagePresentationNoveltyRule {
  /** Canonical message fact extracted by Host before comparing plugin-owned known values. */
  fact: 'grid-field-2';
  /** Plugin-owned known values keyed by the configured partition. */
  knownValuesByPartition: Record<string, string[]>;
  /** Presentation class used when the extracted fact is not known. */
  classId: string;
}

/** Adds a badge when a bounded token matcher accepts the decoded message. */
export interface StrategyMessagePresentationTagRule {
  /** Stable rule identity for diagnostics and replacement. */
  id: string;
  /** Host-evaluated token matcher. */
  match: StrategyMessagePresentationTokenMatch;
  /** Badge rendered when the matcher succeeds. */
  badge: StrategyMessagePresentationBadge;
}

/** Complete strategy-owned, data-only presentation projection for decoded messages. */
export interface StrategyMessagePresentationProjection {
  /** Monotonic plugin revision used to replace stale projections. */
  revision: number;
  /** Whether the projection replaces logbook presentation or augments it. */
  mode: 'replace-logbook' | 'augment';
  /** Canonical message subject classified by the projection. */
  subject: 'sender-callsign';
  /** Partition used for assignments and novelty checks. */
  partitionBy: 'band' | 'mode' | 'none';
  /** Optional partition allowlist. */
  eligiblePartitions?: string[];
  /** Class applied when no assignment or rule selects another class. */
  defaultClass?: string;
  /** Strategy-defined presentation classes keyed by stable ID. */
  classes: Record<string, StrategyMessagePresentationClass>;
  /** Explicit subject-to-class assignments. */
  assignments: Array<{ subject: string; partition?: string; classId: string }>;
  /** Optional Host-evaluated novelty rules. */
  noveltyRules?: StrategyMessagePresentationNoveltyRule[];
  /** Optional Host-evaluated tag rules. */
  tagRules?: StrategyMessagePresentationTagRule[];
}

/** Strategy-owned reason that prevents an operator from starting transmission. */
export interface StrategyTransmitGate {
  /** Always false while the gate is present. */
  allowed: false;
  /** Literal message or plugin locale key shown to the operator. */
  reason: string;
  /** Optional strategy action that can resolve the gate. */
  actionId?: string;
}

/** Semantic tone used for strategy-owned operator actions. */
export type StrategyActionTone = 'default' | 'primary' | 'success' | 'warning' | 'danger';
/** Host layout requested for a strategy-owned action. */
export type StrategyActionPresentation = 'primary' | 'secondary' | 'menu' | 'segmented';

/** Optional value editor attached to a strategy-owned action. */
export type StrategyActionInput =
  | {
      kind: 'text';
      label?: string;
      value?: string;
      placeholder?: string;
      maxLength?: number;
    }
  | {
      kind: 'number' | 'audio-frequency';
      label?: string;
      value?: number;
      min?: number;
      max?: number;
      step?: number;
      unit?: string;
      spectrumPick?: boolean;
    };

/** One context-sensitive command wholly owned by a strategy plugin. */
export interface StrategyActionDescriptor {
  /** Stable action identifier passed back to the owning runtime. */
  id: string;
  /** Literal label or plugin locale key. */
  label: string;
  /** Optional literal description or plugin locale key. */
  description?: string;
  /** Host icon identifier. */
  icon?: string;
  /** Semantic action tone. */
  tone?: StrategyActionTone;
  /** Preferred Host layout for this command. */
  presentation?: StrategyActionPresentation;
  /** Optional group identity used by menus and segmented controls. */
  groupId?: string;
  /** Whether a toggle-like action is currently selected. */
  selected?: boolean;
  /** Explanation shown while the action is disabled. */
  disabledReason?: string;
  /** Optional exact transmission preview. */
  previewText?: string;
  /** Confirmation dialog requested before invocation. */
  confirmation?: {
    title: string;
    description?: string;
    confirmLabel?: string;
    cancelLabel?: string;
  };
  /** Optional text, number, or audio-frequency editor. */
  input?: StrategyActionInput;
  /** Host-validated navigation to a page declared by the owning plugin. */
  navigation?: { kind: 'plugin-page'; pageId: string };
}

/** Strategy-owned operator attention item with optional actions and notification. */
export interface StrategyAttention {
  /** Stable identity used to replace or dismiss the item. */
  id: string;
  /** Semantic severity rendered by the Host. */
  tone: 'info' | 'warning' | 'danger' | 'success';
  /** Literal title or plugin locale key. */
  title: string;
  /** Optional literal description or plugin locale key. */
  description?: string;
  /** Locale interpolation parameters. */
  params?: Record<string, string | number>;
  /** Whether the Host may surface an out-of-page notification. */
  notify?: boolean;
  /** Epoch milliseconds after which the Host may discard the item. */
  expiresAt?: number;
  /** Strategy action IDs offered with the item. */
  actionIds?: string[];
}

/** Durable QSO completion state projected by one strategy stream. */
export interface StrategyCompletionProjection {
  /** Current preparation or commit phase. */
  state: 'not-ready' | 'ready' | 'committing' | 'committed' | 'failed';
  /** Optional literal label or plugin locale key. */
  label?: string;
  /** Durable record ID once the Host commits the QSO. */
  recordId?: string;
}

/** One user-selectable state exposed by a strategy-owned state machine. */
export interface StrategyStateOption {
  /** Stable state identifier understood only by the owning strategy. */
  id: string;
  /** Literal label or plugin locale key shown by the Host UI. */
  label?: string;
  /** Exact transmission produced when this state is selected, when applicable. */
  transmitText?: string;
}

/** One independently progressing parallel QSO inside an operator strategy. */
export interface StrategyStreamSnapshot {
  /** Stable identity within the owning strategy runtime. */
  streamId: string;
  /** Current lane state selected by the protocol implementation. */
  currentState: string;
  /** Target station currently owned by this lane. */
  targetCallsign?: string;
  /** Last accepted target grid, when known. */
  targetGrid?: string;
  /** Audio carrier used by this lane in hertz. */
  audioFrequencyHz: number;
  /** Lane-local lifecycle epoch used to correlate durable QSO effects. */
  qsoLifecycleEpoch: number;
  /** Protocol-approved states that the operator may select for this lane. */
  stateOptions?: StrategyStateOption[];
  /** Context-sensitive actions owned by this lane. */
  actions?: StrategyActionDescriptor[];
  /** Operator attention items owned by this lane. */
  attentions?: StrategyAttention[];
  /** Durable QSO completion projection for this lane. */
  completion?: StrategyCompletionProjection;
  /** Most recent accepted inbound protocol text. */
  lastReceivedText?: string;
  /** Exact text this lane plans to transmit next. */
  nextTransmitText?: string;
}

/** Optimistic target for a strategy action invocation. */
export type StrategyActionTarget =
  | { kind: 'runtime' }
  | { kind: 'stream'; streamId: string; lifecycleEpoch: number }
  | { kind: 'queue-entry'; entryId: string; queueVersion: number };

/** Host-validated invocation of one strategy-owned action. */
export interface StrategyActionInvocation {
  /** Runtime, stream, or queue entry that owns the action. */
  target: StrategyActionTarget;
  /** Action identifier from the current strategy projection. */
  actionId: string;
  /** Untrusted action input that the strategy must validate. */
  payload?: unknown;
}

/** Host-managed plugin logbook session effect returned by an accepted action or decision. */
export type StrategyLogbookSessionEffect =
  | { operation: 'open'; sessionKey: string; title: string; retention?: 'durable' | 'runtime' }
  | { operation: 'destroy'; sessionKey: string };

/** Declarative effects returned after invoking a strategy-owned action. */
export interface StrategyActionResult {
  /** Requests a fresh speculative decision after the action commits. */
  requestDecision?: boolean;
  /** Start this operator through the Host's normal automation path after a direct user action. */
  requestOperatorStart?: boolean;
  /** QSO effects prepared and committed by the Host. */
  qsoCompletions?: StrategyQSOCompletionEffect[];
  /** Host-managed plugin logbook session operations caused by this explicit action. */
  logbookSessionEffects?: StrategyLogbookSessionEffect[];
  /** Stable action outcome for UI feedback and diagnostics. */
  outcome?: { code: string; message?: string };
}

/** Optimistic request to move one strategy-owned lane to a user-selectable state. */
export interface StrategyStreamStateUpdate {
  /** Lane to update. */
  streamId: string;
  /** Strategy-approved target state. */
  stateId: string;
  /** Optimistic lane lifecycle epoch from the current projection. */
  expectedLifecycleEpoch: number;
}

/** One independently encoded transmission contributed by a strategy. */
export interface StrategyTransmission {
  /** Stable lane identity within one operator. */
  streamId: string;
  /** Exact FT8/FT4 text to encode. */
  text: string;
  /** Audio carrier frequency in hertz. */
  audioFrequencyHz: number;
}

/** Physical confirmation for one transmitted lane in an atomic frame. */
export interface StreamPhysicalReceipt extends StrategyTransmission {
  /** Host physical-frame identity. */
  frameId: string;
  /** Monotonic physical-frame revision. */
  revision: number;
  /** Literal proof that this lane reached physical transmission. */
  physicalConfirmed: true;
}

/** User-facing phase shown for one row in a queue-capable strategy. */
export type AssistedQueueDisplayState =
  | 'TX1' | 'TX2' | 'TX3' | 'TX4' | 'TX5'
  | 'engaged' | 'closing' | 'paused' | 'no-response' | 'later' | 'review'
  | 'candidate' | 'authorized' | 'dupe';

/** Why a queued target is temporarily paused instead of being selected. */
export type AssistedQueuePauseReason = 'target-busy' | 'stale';

/** Semantic color treatment requested for an assisted queue row. */
export type AssistedQueueTone = 'neutral' | 'active' | 'success' | 'warning' | 'danger';

/** Host icon identifier requested for an assisted queue row. */
export type AssistedQueueIcon =
  | 'circle' | 'radio' | 'check-circle' | 'loader-circle' | 'clock' | 'pause' | 'triangle-alert';

/** Stable, serializable UI projection of one queued target. */
export interface AssistedQueueRow {
  /** Queue-entry identity used by reorder/remove/retry commands. */
  entryId: string;
  /** Target station callsign. */
  callsign: string;
  /** Zero-based display order in the current snapshot. */
  order: number;
  /** Whether the UI may offer drag-to-reorder for this row. */
  draggable: boolean;
  /** Current protocol or queue phase shown to the operator. */
  displayState: AssistedQueueDisplayState;
  /** Semantic visual treatment for the row. */
  tone: AssistedQueueTone;
  /** Icon chosen by the strategy for the current state. */
  icon: AssistedQueueIcon;
  /** Why this row is paused, when `displayState` is `paused`. */
  pauseReason?: AssistedQueuePauseReason;
  /** Consecutive no-response cycles observed for this target. */
  noResponseCycles?: number;
  /** Last known Maidenhead grid locator for the target. */
  targetGrid?: string;
  /** Most recently decoded signal report in dB. */
  lastSnr?: number;
  /** Receive cycles elapsed since this target was last decoded. */
  lastHeardCyclesAgo?: number;
  /** Cycle in which the target was most recently decoded transmitting. */
  lastHeardCycle?: 0 | 1;
  /** Active strategy stream currently processing this entry. */
  streamId?: string;
  /** Reserved audio carrier when the entry owns a stream. */
  audioFrequencyHz?: number;
  /** Audited operator authorization associated with this entry. */
  authorizationId?: string;
  /** Plugin-declared row actions. Omission preserves legacy queue controls. */
  actions?: StrategyActionDescriptor[];
}

/** Versioned queue projection embedded in `StrategyRuntimeSnapshot.queue`. */
export interface AssistedQueueSnapshot {
  /** Monotonically increasing revision used for optimistic mutations. */
  version: number;
  /** Entry currently owned by the active QSO lifecycle, when any. */
  activeEntryId?: string;
  /** Entries currently owned by parallel QSO lifecycles. */
  activeEntryIds?: string[];
  /** Maximum number of entries that may be active at once. */
  maxActiveStreams?: number;
  /** User-requested stream count before Host radio-frequency policy is applied. */
  requestedMaxActiveStreams?: number;
  /** Queue rows in display order. */
  rows: AssistedQueueRow[];
}

/** Metadata supplied when a queue-capable strategy observes decoded messages. */
export interface QueuedStrategyObservationMeta {
  /** Slot that produced the decoded messages. */
  slotInfo: SlotInfo;
  /** Why the Host is asking the strategy to observe this batch. */
  source: StrategyDecisionSource;
  /** Aborts when this observation is superseded or the instance stops. */
  signal: AbortSignal;
}

/** Target and optional triggering frame submitted to an assisted queue. */
export interface QueuedStrategyTargetRequest {
  /** Callsign to normalize and enqueue. */
  callsign: string;
  /** Authentic decoder frame/slot pair that triggered the request, when known. */
  lastMessage?: { message: FrameMessage; slotInfo: SlotInfo };
}

/** Result of an assisted queue mutation, including the authoritative snapshot. */
export interface QueuedStrategyMutationResult {
  /** Whether the mutation changed the queue, was already satisfied, or was rejected. */
  outcome: 'accepted' | 'duplicate' | 'rejected';
  /** Machine-readable rejection reason. */
  reason?: 'queue_full' | 'invalid_target' | 'entry_not_found' | 'entry_not_retryable' | 'active_entry' | 'version_conflict';
  /** Authoritative queue state after the attempted mutation. */
  snapshot: AssistedQueueSnapshot;
  /** Requests a normal operator start after this explicit manual queue mutation. */
  requestOperatorStart?: boolean;
}

/** Optional capability implemented by strategies that own a target queue. */
export interface QueuedStrategyRuntime extends StrategyRuntime {
  /** Incorporates a decoded batch and returns whether the queue projection changed. */
  observeDecodedMessages(messages: ParsedFT8Message[], meta: QueuedStrategyObservationMeta): boolean;
  /** Adds a target unless it is invalid, duplicated or the queue is full. */
  enqueueTarget(request: QueuedStrategyTargetRequest): QueuedStrategyMutationResult;
  /** Moves an entry before another entry, or to the end when `beforeEntryId` is null. */
  reorderTarget(entryId: string, beforeEntryId: string | null, expectedVersion: number): QueuedStrategyMutationResult;
  /** Removes a non-active entry using optimistic version validation. */
  removeTarget(entryId: string, expectedVersion: number): QueuedStrategyMutationResult;
  /** Makes a retryable failed/no-response entry eligible again. */
  retryTarget?(entryId: string, expectedVersion: number): QueuedStrategyMutationResult;
  /** Removes every non-active entry using optimistic version validation. */
  clearTargets?(expectedVersion: number): QueuedStrategyMutationResult;
  /** Returns the current detached queue snapshot. */
  getQueueSnapshot(): AssistedQueueSnapshot;
}

/** Runtime type guard for the optional assisted-target queue capability. */
export function isQueuedStrategyRuntime(runtime: StrategyRuntime): runtime is QueuedStrategyRuntime {
  const candidate = runtime as Partial<QueuedStrategyRuntime>;
  return typeof candidate.observeDecodedMessages === 'function'
    && typeof candidate.enqueueTarget === 'function'
    && typeof candidate.reorderTarget === 'function'
    && typeof candidate.removeTarget === 'function'
    && typeof candidate.getQueueSnapshot === 'function';
}

/**
 * Describes a slot text mutation emitted by the strategy runtime.
 */
export interface StrategyRuntimeSlotContentUpdate {
  /** Logical slot whose rendered content should be updated. */
  slot: StrategyRuntimeSlot;
  /** Human-readable content for the slot, usually an FT8 message template. */
  content: string;
}

/** Trigger that caused the Host to request a strategy decision. */
export type StrategyDecisionSource = 'slot-auto' | 'late-decode';

/** Invocation metadata for a speculative API v2 strategy decision. */
export interface StrategyDecisionMetaV2 {
  /** Monotonic Host decision epoch; newer epochs supersede older decisions. */
  epoch: number;
  /** Slot progression or late-decode event that triggered the decision. */
  source: StrategyDecisionSource;
  /** `true` when new information caused the current slot to be evaluated again. */
  isReDecision: boolean;
  /** Aborts when this decision is superseded, times out or the instance stops. */
  signal: AbortSignal;
}

/**
 * Strategy-owned state captured before a speculative decision.
 *
 * The value must be structured-clone compatible and must not contain Host
 * capabilities, functions, promises or external resource handles.
 */
export type StrategyRuntimeCheckpoint = unknown;

/** Operator transmit-cycle selection observed by an active strategy runtime. */
export interface StrategyOperatorTransmitCyclesChanged {
  /** Previous Host-selected transmit cycles. */
  previousTransmitCycles: number[];
  /** Current Host-selected transmit cycles. */
  transmitCycles: number[];
  /** Source of the accepted cycle change. */
  source?: 'manual' | 'plugin' | 'late-decode' | 'slot-auto';
}

/** Declarative request for the Host to durably commit one completed QSO. */
export interface StrategyQSOCompletionEffect {
  /** Complete QSO record to validate and persist. */
  record: QSORecord;
  /** Stable within one strategy runtime generation; distinct from RF decision epochs. */
  lifecycleEpoch: number;
  /** Lane that produced the completion; omitted by legacy single-lane strategies. */
  streamId?: string;
  /** Host persistence behavior requested by the strategy. */
  persistencePolicy?: 'merge-nearby' | 'preserve-distinct';
  /** Optional Host-issued destination. Omitted effects use the operator's primary logbook. */
  destination?:
    | { kind: 'plugin-session'; sessionId: string }
    | { kind: 'plugin-session-key'; sessionKey: string };
  /** Structured-cloneable source metadata returned with post-commit delivery. */
  metadata?: Record<string, unknown>;
}

/** Host acknowledgement for a previously returned QSO completion effect. */
export interface StrategyQSOCompletionSettlement {
  /** Lifecycle epoch copied from the effect being settled. */
  lifecycleEpoch: number;
  /** Record ID from the accepted completion effect, used for correlation. */
  recordId: string;
  /** Final durable record ID; differs when the Host merged into an existing QSO. */
  persistedRecordId?: string;
  /** Whether the Host committed the record or the durable operation failed. */
  status: 'committed' | 'failed';
  /** Lane copied from the accepted completion effect. */
  streamId?: string;
  /** Detached source metadata copied from the accepted completion effect. */
  metadata?: Record<string, unknown>;
}

/** Complete output of one speculative strategy decision. */
export interface StrategyDecisionResult extends StrategyDecision {
  /** Exact text to queue next, or `null` when this decision should not transmit. */
  transmission: string | null;
  /** Parallel transmissions. New strategies use this instead of `transmission`. */
  transmissions?: StrategyTransmission[];
  /** UI/diagnostic snapshot produced from the same post-decision state. */
  snapshot: StrategyRuntimeSnapshot;
  /** Optional QSO persistence effect executed by the Host after acceptance. */
  qsoCompletion?: StrategyQSOCompletionEffect;
  /** Parallel QSO effects committed in the same accepted decision. */
  qsoCompletions?: StrategyQSOCompletionEffect[];
  /** Host-managed plugin logbook lifecycle effects accepted with this decision. */
  logbookSessionEffects?: StrategyLogbookSessionEffect[];
  /** Optional cycle selected from the triggering RX frame; applied by the host after target reservation. */
  requestedTransmitCycle?: number;
}

/**
 * Active controller for a `strategy` plugin.
 *
 * The host delegates core automation flow to this runtime. A strategy runtime is
 * expected to be lightweight, synchronous where possible and deterministic with
 * respect to the incoming slot/decode stream.
 */
export interface StrategyRuntime {
  /** Captures all mutable state needed to roll back the next decision. */
  checkpoint(): StrategyRuntimeCheckpoint;

  /** Restores a previously captured checkpoint after a decision is discarded. */
  restore(checkpoint: StrategyRuntimeCheckpoint): void;

  /**
   * Observes an already-applied Host transmit-cycle selection. Returning true
   * asks the Host to publish the resulting runtime projection.
   */
  onOperatorTransmitCyclesChanged?(change: StrategyOperatorTransmitCyclesChanged): boolean;

  /**
   * Optional acknowledgement for a declarative QSO effect. Implementations may
   * use it to prevent a completed contact from leaking into the next lifecycle.
   * The Host invokes it only for an accepted effect from the same runtime
   * generation and reports whether durable persistence committed or failed.
   */
  settleQSOCompletion?(settlement: StrategyQSOCompletionSettlement): void;

  /**
   * Re-evaluates the current automation state using the latest decoded messages.
   *
   * Return `{ stop: true }` to stop this operator's automation and prevent new
   * frames. It never grants an RF interrupt: an already committed/on-air frame
   * is allowed to finish. Explicit operator contribution removal is available
   * only through the invocation-guarded `operator:transmit-control` command
   * port outside speculative strategy execution.
   */
  decide(
    messages: ParsedFT8Message[],
    meta: StrategyDecisionMetaV2,
  ): Promise<StrategyDecisionResult> | StrategyDecisionResult;

  /**
   * Returns the exact text that should be transmitted next, or `null` when no
   * transmission should be queued.
   */
  getTransmitText(): string | null;

  /**
   * Returns every lane that should contribute to the next physical frame.
   * Legacy runtimes may omit this method; the Host then maps getTransmitText()
   * to the `default` stream at the operator's configured audio frequency.
   */
  getTransmissions?(): StrategyTransmission[];

  /**
   * Requests that the runtime initiate or resume a call to a target station.
   *
   * The optional `lastMessage` provides the frame that triggered the call, which
   * is useful when reacting to a specific CQ or completion signal.
   * Return exactly `false` to reject the target; `true` or `void` means the
   * runtime accepted it and the Host may start the operator.
   */
  requestCall(
    callsign: string,
    lastMessage?: { message: FrameMessage; slotInfo: SlotInfo },
  ): boolean | void;

  /**
   * Produces a serializable runtime snapshot for diagnostics and UI.
   */
  getSnapshot(): StrategyRuntimeSnapshot;

  /**
   * Applies a partial update to the runtime context.
   */
  patchContext(patch: Partial<StrategyRuntimeContext>): void;

  /**
   * Switches the runtime to a specific logical transmit slot/state.
   */
  setState(state: StrategyRuntimeSlot): void;

  /** Switches one independently progressing lane to a strategy-approved state. */
  setStreamState?(update: StrategyStreamStateUpdate): void;

  /** Executes one plugin-declared runtime, stream or queue-entry action. */
  invokeAction?(
    invocation: StrategyActionInvocation,
  ): StrategyActionResult | void | Promise<StrategyActionResult | void>;

  /**
   * Updates the human-readable content associated with a logical slot.
   */
  setSlotContent(update: StrategyRuntimeSlotContentUpdate): void;

  /**
   * Clears transient state and returns the runtime to an idle baseline.
   *
   * The optional `reason` is intended for logging or diagnostics only.
   */
  reset(reason?: string): void;

  /**
   * Optional notification that a transmission has just been queued by the host.
   *
   * Use this to mirror queued text into internal state when needed.
   */
  onTransmissionQueued?(transmission: string): void;

  /** Physical success notification for a complete parallel frame. */
  onTransmissionsCompleted?(receipts: StreamPhysicalReceipt[]): void;
}
