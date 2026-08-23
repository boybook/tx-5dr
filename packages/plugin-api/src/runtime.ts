import type { ParsedFT8Message, FrameMessage, SlotInfo, QSORecord } from '@tx5dr/contracts';
import type { StrategyDecision } from './hooks.js';

/**
 * Logical FT8 transmit slot identifiers used by the built-in automation model.
 *
 * These labels correspond to the six sequential transmit messages in a typical
 * FT8 QSO flow and are used for status snapshots and UI updates.
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
  /** Optional list of user-visible next states, modes or branch hints. */
  availableSlots?: string[];
  /** Host correlation token for QSO persistence; it is not an RF decision epoch. */
  qsoLifecycleEpoch?: number;
  /** Optional compact projection exposed by queue-capable strategies. */
  queue?: AssistedQueueSnapshot;
}

/** User-facing phase shown for one row in a queue-capable strategy. */
export type AssistedQueueDisplayState =
  | 'TX1' | 'TX2' | 'TX3' | 'TX4' | 'TX5'
  | 'engaged' | 'closing' | 'paused' | 'no-response' | 'later' | 'review';

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
}

/** Versioned queue projection embedded in `StrategyRuntimeSnapshot.queue`. */
export interface AssistedQueueSnapshot {
  /** Monotonically increasing revision used for optimistic mutations. */
  version: number;
  /** Entry currently owned by the active QSO lifecycle, when any. */
  activeEntryId?: string;
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

/** Declarative request for the Host to durably commit one completed QSO. */
export interface StrategyQSOCompletionEffect {
  /** Complete QSO record to validate and persist. */
  record: QSORecord;
  /** Stable within one strategy runtime generation; distinct from RF decision epochs. */
  lifecycleEpoch: number;
}

/** Host acknowledgement for a previously returned QSO completion effect. */
export interface StrategyQSOCompletionSettlement {
  /** Lifecycle epoch copied from the effect being settled. */
  lifecycleEpoch: number;
  /** Record ID from the accepted completion effect after Host persistence settles. */
  recordId: string;
  /** Whether the Host committed the record or the durable operation failed. */
  status: 'committed' | 'failed';
}

/** Complete output of one speculative strategy decision. */
export interface StrategyDecisionResult extends StrategyDecision {
  /** Exact text to queue next, or `null` when this decision should not transmit. */
  transmission: string | null;
  /** UI/diagnostic snapshot produced from the same post-decision state. */
  snapshot: StrategyRuntimeSnapshot;
  /** Optional QSO persistence effect executed by the Host after acceptance. */
  qsoCompletion?: StrategyQSOCompletionEffect;
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
}
