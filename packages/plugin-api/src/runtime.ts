import type { ParsedFT8Message, FrameMessage, SlotInfo } from '@tx5dr/contracts';
import type { StrategyDecision, StrategyDecisionMeta } from './hooks.js';

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

/**
 * Active controller for a `strategy` plugin.
 *
 * The host delegates core automation flow to this runtime. A strategy runtime is
 * expected to be lightweight, synchronous where possible and deterministic with
 * respect to the incoming slot/decode stream.
 */
export interface StrategyRuntime {
  /**
   * Re-evaluates the current automation state using the latest decoded messages.
   *
   * Return `{ stop: true }` to ask the host to stop transmitting. Any other
   * decision fields can be added in future API revisions, so plugins should
   * return an object rather than a bare boolean.
   */
  decide(
    messages: ParsedFT8Message[],
    meta?: StrategyDecisionMeta,
  ): Promise<StrategyDecision> | StrategyDecision;

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
  ): void;

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
