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

export type AssistedQueueDisplayState =
  | 'TX1' | 'TX2' | 'TX3' | 'TX4' | 'TX5'
  | 'engaged' | 'closing' | 'paused' | 'no-response' | 'later' | 'review';

export type AssistedQueuePauseReason = 'target-busy' | 'stale';

export type AssistedQueueTone = 'neutral' | 'active' | 'success' | 'warning' | 'danger';

export type AssistedQueueIcon =
  | 'circle' | 'radio' | 'check-circle' | 'loader-circle' | 'clock' | 'pause' | 'triangle-alert';

export interface AssistedQueueRow {
  entryId: string;
  callsign: string;
  order: number;
  draggable: boolean;
  displayState: AssistedQueueDisplayState;
  tone: AssistedQueueTone;
  icon: AssistedQueueIcon;
  pauseReason?: AssistedQueuePauseReason;
  noResponseCycles?: number;
  targetGrid?: string;
  lastSnr?: number;
  lastHeardCyclesAgo?: number;
}

export interface AssistedQueueSnapshot {
  version: number;
  activeEntryId?: string;
  rows: AssistedQueueRow[];
}

export interface QueuedStrategyObservationMeta {
  slotInfo: SlotInfo;
  source: StrategyDecisionSource;
  signal: AbortSignal;
}

export interface QueuedStrategyTargetRequest {
  callsign: string;
  lastMessage?: { message: FrameMessage; slotInfo: SlotInfo };
}

export interface QueuedStrategyMutationResult {
  outcome: 'accepted' | 'duplicate' | 'rejected';
  reason?: 'queue_full' | 'invalid_target' | 'entry_not_found' | 'entry_not_retryable' | 'active_entry' | 'version_conflict';
  snapshot: AssistedQueueSnapshot;
}

/** Optional capability implemented by strategies that own a target queue. */
export interface QueuedStrategyRuntime extends StrategyRuntime {
  observeDecodedMessages(messages: ParsedFT8Message[], meta: QueuedStrategyObservationMeta): boolean;
  enqueueTarget(request: QueuedStrategyTargetRequest): QueuedStrategyMutationResult;
  reorderTarget(entryId: string, beforeEntryId: string | null, expectedVersion: number): QueuedStrategyMutationResult;
  removeTarget(entryId: string, expectedVersion: number): QueuedStrategyMutationResult;
  retryTarget?(entryId: string, expectedVersion: number): QueuedStrategyMutationResult;
  clearTargets?(expectedVersion: number): QueuedStrategyMutationResult;
  getQueueSnapshot(): AssistedQueueSnapshot;
}

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

export type StrategyDecisionSource = 'slot-auto' | 'late-decode';

export interface StrategyDecisionMetaV2 {
  epoch: number;
  source: StrategyDecisionSource;
  isReDecision: boolean;
  signal: AbortSignal;
}

export type StrategyRuntimeCheckpoint = unknown;

export interface StrategyQSOCompletionEffect {
  record: QSORecord;
  /** Stable within one strategy runtime generation; distinct from RF decision epochs. */
  lifecycleEpoch: number;
}

export interface StrategyQSOCompletionSettlement {
  lifecycleEpoch: number;
  recordId: string;
  status: 'committed' | 'failed';
}

export interface StrategyDecisionResult extends StrategyDecision {
  transmission: string | null;
  snapshot: StrategyRuntimeSnapshot;
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
  checkpoint(): StrategyRuntimeCheckpoint;

  restore(checkpoint: StrategyRuntimeCheckpoint): void;

  /**
   * Optional acknowledgement for a declarative QSO effect. Implementations may
   * use it to prevent a completed contact from leaking into the next lifecycle.
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
