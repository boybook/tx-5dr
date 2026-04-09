import type {
  ParsedFT8Message,
  SlotInfo,
  SlotPack,
  QSORecord,
  FrameMessage,
  OperatorSlots,
  ModeDescriptor,
} from '@tx5dr/contracts';
import type { StrategyRuntimeSnapshot } from './runtime.js';

/**
 * Simple persistent key-value store exposed to plugins.
 *
 * Values are serialized by the host. Keep payloads reasonably small and prefer
 * plain JSON-compatible data for maximum portability.
 */
export interface KVStore {
  /**
   * Reads a stored value.
   *
   * When the key is missing, the provided `defaultValue` is returned instead.
   */
  get<T = unknown>(key: string, defaultValue?: T): T;

  /**
   * Persists a value under the given key.
   */
  set(key: string, value: unknown): void;

  /**
   * Removes a stored key and its value.
   */
  delete(key: string): void;

  /**
   * Returns a shallow snapshot of all stored entries in this scope.
   */
  getAll(): Record<string, unknown>;
}

/**
 * Structured logger dedicated to a plugin instance.
 *
 * Messages should be concise and machine-friendly because they may appear in
 * both backend logs and operator-facing diagnostics.
 */
export interface PluginLogger {
  /** Writes a verbose diagnostic message. */
  debug(message: string, data?: Record<string, unknown>): void;
  /** Writes a lifecycle or informational message. */
  info(message: string, data?: Record<string, unknown>): void;
  /** Writes a warning that does not stop plugin execution. */
  warn(message: string, data?: Record<string, unknown>): void;
  /** Writes an error with optional structured details or an exception object. */
  error(message: string, error?: unknown): void;
}

/**
 * Host-managed named timers for plugin code.
 */
export interface PluginTimers {
  /**
   * Starts or replaces a named interval timer.
   *
   * When the timer fires, the host invokes {@link PluginHooks.onTimer} with the
   * same id.
   */
  set(id: string, intervalMs: number): void;

  /** Clears a named timer if it exists. */
  clear(id: string): void;

  /** Clears all timers owned by the current plugin instance. */
  clearAll(): void;
}

/**
 * Control surface for the active operator instance.
 *
 * This interface lets plugins inspect operator state and request host-managed
 * actions such as starting automation, calling a target or notifying the UI.
 */
export interface OperatorControl {
  /** Unique operator identifier used by the host. */
  readonly id: string;
  /** Whether this operator is currently transmitting or otherwise armed. */
  readonly isTransmitting: boolean;
  /** Configured callsign of the operator/station. */
  readonly callsign: string;
  /** Configured grid locator of the operator/station. */
  readonly grid: string;
  /** Current audio offset frequency in Hz within the passband. */
  readonly frequency: number;
  /** Active digital mode descriptor, for example FT8 or FT4. */
  readonly mode: ModeDescriptor;
  /** Current transmit cycle selection where `0` is even and `1` is odd. */
  readonly transmitCycles: number[];
  /** Current automation runtime snapshot visible to the operator UI. */
  readonly automation: StrategyRuntimeSnapshot | null;

  /** Enables transmission/automation for the current operator. */
  startTransmitting(): void;

  /** Disables transmission/automation for the current operator. */
  stopTransmitting(): void;

  /**
   * Requests that the operator call the specified target station.
   *
   * Passing `lastMessage` helps the host preserve the triggering context.
   */
  call(callsign: string, lastMessage?: { message: FrameMessage; slotInfo: SlotInfo }): void;

  /**
   * Updates the operator's transmit cycle preference.
   *
   * Pass a single value or an array to support alternating or multi-cycle modes.
   */
  setTransmitCycles(cycles: number | number[]): void;

  /**
   * Checks whether this operator has previously worked the given callsign.
   */
  hasWorkedCallsign(callsign: string): Promise<boolean>;

  /**
   * Checks whether another operator with the same station identity is already
   * working the target callsign.
   */
  isTargetBeingWorkedByOthers(targetCallsign: string): boolean;

  /**
   * Records a completed QSO through the host logbook pipeline.
   */
  recordQSO(record: QSORecord): void;

  /**
   * Pushes updated slot text content to the frontend operator view.
   */
  notifySlotsUpdated(slots: OperatorSlots): void;

  /**
   * Pushes a strategy state change notification to the frontend operator view.
   */
  notifyStateChanged(state: string): void;
}

/**
 * Read/write access to radio state that is safe for plugins.
 */
export interface RadioControl {
  /** Current tuned radio frequency in Hz. */
  readonly frequency: number;
  /** Human-readable current band label, for example `20m`. */
  readonly band: string;
  /** Whether the radio transport is currently connected. */
  readonly isConnected: boolean;

  /**
   * Requests a frequency change.
   *
   * The host remains responsible for serializing hardware access and enforcing
   * any safety or capability constraints.
   */
  setFrequency(freq: number): Promise<void>;
}

/**
 * Read-only helpers backed by the station logbook.
 */
export interface LogbookAccess {
  /** Checks whether the callsign has already been worked. */
  hasWorked(callsign: string): Promise<boolean>;
  /** Checks whether the DXCC entity has already been worked. */
  hasWorkedDXCC(dxccEntity: string): Promise<boolean>;
  /** Checks whether the Maidenhead grid has already been worked. */
  hasWorkedGrid(grid: string): Promise<boolean>;
}

/**
 * Optional constraints used when asking the host for a quieter transmit offset.
 */
export interface IdleTransmitFrequencyOptions {
  /** Slot identifier to analyze. Defaults to the latest available slot when omitted. */
  slotId?: string;
  /** Inclusive lower bound in Hz within the passband. */
  minHz?: number;
  /** Inclusive upper bound in Hz within the passband. */
  maxHz?: number;
  /** Guard bandwidth in Hz to keep around occupied frequencies. */
  guardHz?: number;
}

/**
 * Reason codes returned by the host when evaluating whether a decoded target
 * should be eligible for automatic CQ-style replies.
 */
export type AutoTargetEligibilityReason =
  | 'non_cq_message'
  | 'plain_cq'
  | 'missing_callsign_identity'
  | 'missing_target_identity'
  | 'unsupported_activity_token'
  | 'unsupported_callback_token'
  | 'continent_match'
  | 'continent_mismatch'
  | 'dx_match'
  | 'dx_same_continent'
  | 'entity_match'
  | 'entity_mismatch'
  | 'unknown_modifier';

/**
 * Structured result returned by the host for automatic-target eligibility
 * checks.
 */
export interface AutoTargetEligibilityDecision {
  /** Whether the host would currently allow automation to react to the target. */
  eligible: boolean;
  /** Machine-friendly explanation of the decision. */
  reason: AutoTargetEligibilityReason;
  /** Directed CQ modifier/token extracted from the message, when present. */
  modifier?: string;
}

/**
 * Read-only access to the current decode environment.
 */
export interface BandAccess {
  /**
   * Returns the active CQ-like callers known in the current slot context.
   */
  getActiveCallers(): ParsedFT8Message[];

  /**
   * Returns the latest slot pack snapshot, or `null` if no slot has been
   * processed yet.
   */
  getLatestSlotPack(): SlotPack | null;

  /**
   * Asks the host to recommend a quieter transmit audio offset for the current
   * decode environment.
   *
   * Returns `null` when the host cannot evaluate the slot or when no suitable
   * idle window is found.
   */
  findIdleTransmitFrequency(options?: IdleTransmitFrequencyOptions): number | null;

  /**
   * Evaluates whether the given decoded message is eligible for automatic
   * target selection under the host's built-in CQ modifier rules.
   *
   * This lets third-party plugins reuse the same directed-CQ policy that the
   * host applies to standard autocall and auto-reply flows.
   */
  evaluateAutoTargetEligibility(message: ParsedFT8Message): AutoTargetEligibilityDecision;
}

/**
 * Minimal bridge for sending structured data to plugin panels in the frontend.
 */
export interface UIBridge {
  /**
   * Publishes new panel data for the given declarative panel id.
   */
  send(panelId: string, data: unknown): void;
}
