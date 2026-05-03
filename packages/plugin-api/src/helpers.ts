import type {
  ParsedFT8Message,
  SlotInfo,
  SlotPack,
  QSORecord,
  FrameMessage,
  OperatorSlots,
  ModeDescriptor,
  PermissionGrant,
  PluginPanelDescriptor,
  CapabilityList,
  CapabilityState,
  RadioPowerResponse,
  RadioPowerStateEvent,
  RadioPowerSupportInfo,
  RadioPowerTarget,
  WriteCapabilityPayload,
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

  /**
   * Flushes pending writes to persistent storage.
   *
   * In normal operation the host flushes automatically. Call this explicitly
   * only when you need to guarantee that recently written data survives a
   * crash or restart (e.g. during a migration sequence).
   */
  flush(): Promise<void>;
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

  /** Negotiated radio capability controls. Requires radio plugin permissions. */
  readonly capabilities: RadioCapabilitiesControl;

  /** Physical radio power controls. Requires radio plugin permissions. */
  readonly power: RadioPowerControl;

  /**
   * Requests a frequency change.
   *
   * The host remains responsible for serializing hardware access and enforcing
   * any safety or capability constraints.
   */
  setFrequency(freq: number): Promise<void>;
}

/**
 * Access to the host-managed radio capability negotiation system.
 */
export interface RadioCapabilitiesControl {
  /** Returns the current capability descriptor/state snapshot. Requires `radio:read`. */
  getSnapshot(): CapabilityList;

  /** Returns a single capability state from the current snapshot, or null. Requires `radio:read`. */
  getState(id: string): CapabilityState | null;

  /** Refreshes readable capability values and returns the updated snapshot. Requires `radio:read`. */
  refresh(): Promise<CapabilityList>;

  /** Writes a capability value or triggers an action capability. Requires `radio:control`. */
  write(payload: WriteCapabilityPayload): Promise<void>;
}

export interface RadioPowerSetOptions {
  /** Profile to target. Defaults to the active profile. */
  profileId?: string;
  /** Start TX-5DR after physical power-on. Defaults to true. */
  autoEngine?: boolean;
}

/**
 * Access to physical radio power management.
 */
export interface RadioPowerControl {
  /** Returns power support information for the active or specified profile. Requires `radio:read`. */
  getSupport(profileId?: string): Promise<RadioPowerSupportInfo>;

  /** Returns the last known power transition state for the active or specified profile. Requires `radio:read`. */
  getState(profileId?: string): RadioPowerStateEvent | null;

  /** Requests a physical power transition. Requires `radio:power`. */
  set(state: RadioPowerTarget, options?: RadioPowerSetOptions): Promise<RadioPowerResponse>;
}

/**
 * Filter criteria for querying QSO records from the logbook.
 *
 * This type is defined in the plugin-api layer so plugins have no compile-time
 * dependency on core internals. The host translates it to the storage layer's
 * native query format.
 */
export interface QSOQueryFilter {
  /** Match a specific callsign (exact match). */
  callsign?: string;
  /** Restrict to a time window (epoch ms). */
  timeRange?: { start: number; end: number };
  /** Restrict to a frequency window (Hz). */
  frequencyRange?: { min: number; max: number };
  /** Mode filter (e.g. 'FT8'). */
  mode?: string;
  /** Band filter (e.g. '20m'). Compared via getBandFromFrequency on stored records. */
  band?: string;
  /**
   * QSL confirmation status filter.
   * - `'confirmed'`: at least one platform confirmed
   * - `'uploaded'`: at least one platform uploaded but not confirmed
   * - `'none'`: not uploaded to any platform
   */
  qslStatus?: 'confirmed' | 'uploaded' | 'none';
  /** Maximum number of records to return. */
  limit?: number;
  /** Number of records to skip (for pagination). */
  offset?: number;
  /** Sort direction. Defaults to descending (newest first). */
  orderDirection?: 'asc' | 'desc';
}

/**
 * Callsign-bound view over a single logbook.
 *
 * The host resolves the concrete logbook lazily on each operation, which keeps
 * the handle valid even if the underlying logbook is created or reloaded later.
 */
export interface CallsignLogbookAccess {
  /** Normalized callsign that scopes this accessor. */
  readonly callsign: string;

  /** Returns the resolved logbook id, or null when no logbook exists yet. */
  getLogBookId(): Promise<string | null>;

  /** Queries QSO records matching the given filter. */
  queryQSOs(filter: QSOQueryFilter): Promise<import('@tx5dr/contracts').QSORecord[]>;
  /** Counts QSO records matching the given filter. */
  countQSOs(filter?: QSOQueryFilter): Promise<number>;
  /** Adds a new QSO record to this callsign's logbook. */
  addQSO(record: import('@tx5dr/contracts').QSORecord): Promise<void>;
  /** Updates partial fields of an existing QSO record. */
  updateQSO(qsoId: string, updates: Partial<import('@tx5dr/contracts').QSORecord>): Promise<void>;
  /** Returns current statistics for this callsign's logbook. */
  getStatistics(): Promise<import('@tx5dr/contracts').LogBookStatistics | null>;
  /** Notifies the frontend that this callsign's logbook changed. */
  notifyUpdated(operatorId?: string): Promise<void>;
}

/**
 * Full logbook access for plugins.
 *
 * Extends the original read-only helpers with query, write and notification
 * capabilities so that sync providers can self-orchestrate their entire flow
 * without host-side special handling.
 */
export interface LogbookAccess {
  // === Read-only helpers (original) ===

  /** Checks whether the callsign has already been worked. */
  hasWorked(callsign: string): Promise<boolean>;
  /** Checks whether the DXCC entity has already been worked. */
  hasWorkedDXCC(dxccEntity: string): Promise<boolean>;
  /** Checks whether the Maidenhead grid has already been worked. */
  hasWorkedGrid(grid: string): Promise<boolean>;

  // === Query ===

  /** Queries QSO records matching the given filter. */
  queryQSOs(filter: QSOQueryFilter): Promise<import('@tx5dr/contracts').QSORecord[]>;
  /** Counts QSO records matching the given filter. */
  countQSOs(filter?: QSOQueryFilter): Promise<number>;

  /** Returns a callsign-bound accessor suitable for global plugin instances. */
  forCallsign(callsign: string): CallsignLogbookAccess;

  // === Write ===

  /** Adds a new QSO record. Deduplication is the caller's responsibility. */
  addQSO(record: import('@tx5dr/contracts').QSORecord): Promise<void>;
  /** Updates partial fields of an existing QSO record (e.g. QSL status). */
  updateQSO(qsoId: string, updates: Partial<import('@tx5dr/contracts').QSORecord>): Promise<void>;

  // === Notification ===

  /** Notifies the frontend to refresh logbook data (call after batch writes). */
  notifyUpdated(): Promise<void>;
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
 * Dynamic metadata for a plugin panel, sent via {@link UIBridge.setPanelMeta}.
 */
export interface PanelMeta {
  /**
   * Overrides the panel title dynamically.
   * - i18n key (e.g. `"statusActive"`): resolved from the plugin's locale namespace
   * - literal string (e.g. `"Active: 5"`): displayed as-is
   * - empty string `""`: hides the title bar entirely (immersive)
   * - null / undefined: reverts to the statically declared title
   */
  title?: string | null;

  /**
   * Interpolation values for the title when it is an i18n key.
   * For example, if the plugin locale defines `"statusActive": "Active: {{count}}"`,
   * pass `{ count: 5 }` to render "Active: 5".
   */
  titleValues?: Record<string, unknown>;

  /**
   * Controls whether the panel is visible.
   * - false: the host hides the panel entirely (it takes no layout space)
   * - true / undefined: normal display
   */
  visible?: boolean;
}

/**
 * Minimal bridge for sending structured data to plugin panels in the frontend.
 */
export interface UIBridge {
  /**
   * Publishes new panel data for the given declarative panel id.
   */
  send(panelId: string, data: unknown): void;

  /**
   * Updates the panel's display metadata at runtime. All fields are optional
   * and use patch semantics. Subsequent calls overwrite previous values for the
   * same keys.
   */
  setPanelMeta(panelId: string, meta: PanelMeta): void;

  /**
   * Replaces one runtime-owned group of plugin UI panels for this plugin
   * instance. Static `PluginDefinition.panels` are exposed by the host as the
   * reserved `manifest` group; plugins should use their own stable group ids.
   */
  setPanelContributions(groupId: string, panels: PluginPanelDescriptor[]): void;

  /**
   * Clears a runtime-owned panel contribution group for this plugin instance.
   */
  clearPanelContributions(groupId: string): void;

  /**
   * Registers a handler for custom messages sent from iframe UI pages via the
   * `bridge.invoke()` SDK method. The host routes incoming invoke requests to
   * the handler and sends the return value back to the iframe.
   *
   * Only one handler can be registered per plugin instance. Calling this method
   * again replaces the previous handler.
   */
  registerPageHandler(handler: PluginUIHandler): void;

  /**
   * Pushes a custom message to the specific page session.
   *
   * Prefer this API whenever the plugin already knows the target session id
   * (for example from {@link PluginUIRequestContext.pageSessionId} or
   * `requestContext.page.sessionId`).
   */
  pushToSession(pageSessionId: string, action: string, data?: unknown): void;

  /**
   * Lists active page sessions for the current plugin instance and page id.
   *
   * This is useful for background timers or sync completions that need to
   * notify every open page tied to the same runtime instance.
   */
  listActivePageSessions(pageId: string): PluginUIPageSessionInfo[];

  /**
   * Pushes a custom message to an iframe UI page by page id.
   *
   * This compatibility helper only succeeds when exactly one active session of
   * the current plugin instance matches the page id. If multiple sessions are
   * open, the host throws `explicit_page_session_required`.
   */
  pushToPage(pageId: string, action: string, data?: unknown): void;
}

/**
 * Handler for custom messages sent from iframe UI pages.
 *
 * Plugins register a handler via `ctx.ui.registerPageHandler()` to receive
 * arbitrary invoke requests from their iframe-based UIs. The host acts as a
 * transparent router — it does not inspect or interpret the action or data.
 */
export interface PluginUIHandler {
  /**
   * Called when the iframe sends an invoke request via `bridge.invoke(action, data)`.
   *
   * @param pageId - The page that sent the message.
   * @param action - Developer-defined action identifier.
   * @param data - Arbitrary payload from the iframe.
   * @param requestContext - Host-authenticated page context, including any
   * bound resource for this page session.
   * @returns The response value sent back to the iframe.
   */
  onMessage(
    pageId: string,
    action: string,
    data: unknown,
    requestContext: PluginUIRequestContext,
  ): Promise<unknown>;
}

export interface PluginUIRequestUser {
  readonly tokenId: string;
  readonly role: 'viewer' | 'operator' | 'admin';
  readonly operatorIds: string[];
  readonly permissionGrants?: PermissionGrant[];
}

export interface PluginUIBoundResource {
  readonly kind: 'callsign' | 'operator';
  readonly value: string;
}

export type PluginUIInstanceTarget =
  | { readonly kind: 'global' }
  | { readonly kind: 'operator'; readonly operatorId: string };

export interface PluginUIPageSessionInfo {
  readonly sessionId: string;
  readonly pageId: string;
  readonly resource?: PluginUIBoundResource;
}

export interface PluginUIPageContext extends PluginUIPageSessionInfo {
  push(action: string, data?: unknown): void;
}

export interface PluginUIRequestContext {
  readonly pageSessionId: string;
  readonly user: PluginUIRequestUser;
  readonly resource?: PluginUIBoundResource;
  readonly instanceTarget: PluginUIInstanceTarget;
  readonly page: PluginUIPageContext;
  /**
   * Page-scoped file storage shared with iframe `tx5dr.file*()` calls.
   *
   * Use this in `registerPageHandler()` handlers to read files uploaded by the
   * current iframe page session without reconstructing host-internal scope
   * paths.
   */
  readonly files: PluginFileStore;
}

/**
 * Persistent binary file storage for plugins.
 *
 * Files are stored in a sandboxed directory under the plugin's data path. Path
 * traversal outside the sandbox is rejected by the host.
 */
export interface PluginFileStore {
  /** Writes (or overwrites) a file at the given path. */
  write(path: string, data: Buffer): Promise<void>;

  /** Reads a file. Returns `null` when the path does not exist. */
  read(path: string): Promise<Buffer | null>;

  /** Deletes a file. Returns `true` if the file existed and was removed. */
  delete(path: string): Promise<boolean>;

  /** Lists file paths under the given prefix (or all files when omitted). */
  list(prefix?: string): Promise<string[]>;
}
