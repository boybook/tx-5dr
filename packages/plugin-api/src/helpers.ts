import type {
  ParsedFT8Message,
  SlotInfo,
  SlotPack,
  FrameMessage,
  ModeDescriptor,
  EngineMode,
  PermissionGrant,
  PluginPanelDescriptor,
  CapabilityList,
  CapabilityState,
  RadioPowerResponse,
  RadioPowerStateEvent,
  RadioPowerSupportInfo,
  RadioPowerTarget,
} from '@tx5dr/contracts';
import type { StrategyRuntimeSnapshot } from './runtime.js';
import type {
  LogbookBatchMutation,
  LogbookBatchResult,
  LogbookQsoSnapshot,
} from '@tx5dr/core';

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
   * Stored values are returned by value, so mutating the result does not update
   * persistence until {@link set} is called. When the key is missing, the
   * caller-owned `defaultValue` is returned unchanged.
   */
  get<T = unknown>(key: string, defaultValue?: T): T;

  /**
   * Persists a JSON-compatible snapshot under the given key.
   *
   * `undefined` follows JSON object semantics and removes the key. Cycles,
   * BigInt values, functions and Host capabilities are rejected with
   * `PLUGIN_DATA_NOT_SERIALIZABLE`.
   */
  set(key: string, value: unknown): void;

  /** Atomically updates one value shared by every instance of this plugin. */
  update<T = unknown>(key: string, reducer: (current: T | undefined) => T | undefined): T | undefined;

  /**
   * Removes a stored key and its value.
   */
  delete(key: string): void;

  /**
   * Returns an independent snapshot of all stored entries in this scope.
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

/** Read-only live view of one plugin storage scope. */
export interface ReadonlyKVStore {
  get<T = unknown>(key: string, defaultValue?: T): T;
  has(key: string): boolean;
  keys(): string[];
}

export interface DigitalMessagePreflightRequest {
  mode: 'FT8' | 'FT4';
  text: string;
}

export interface DigitalMessagePreflightResult {
  encodable: boolean;
  requestedText: string;
  transmittedText?: string;
  reason?: 'empty' | 'encoder_changed_text' | 'encode_failed';
  error?: string;
}

/** Read-only digital-mode validation; no audio or encoder handle is exposed. */
export interface DigitalMessagePreflight {
  check(request: DigitalMessagePreflightRequest): Promise<DigitalMessagePreflightResult>;
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
 * Remote UDP endpoint metadata for datagrams received by plugin-owned sockets.
 */
export interface PluginUdpRemoteInfo {
  /** Source IP address reported by the UDP socket. */
  address: string;
  /** Source UDP port. */
  port: number;
  /** Address family reported by Node.js, typically `IPv4` or `IPv6`. */
  family: string;
  /** Datagram size in bytes. */
  size: number;
}

/** Local endpoint used when binding a plugin-owned UDP socket. */
export interface PluginUdpBindOptions {
  /** Local interface/address. Omit to use the Host default. */
  host?: string;
  /** Local port. Omit or use `0` to let the operating system choose one. */
  port?: number;
}

/** Options applied when the Host creates a plugin-owned UDP socket. */
export interface PluginUdpSocketOptions {
  /** IP family. Defaults to `udp4`. */
  type?: 'udp4' | 'udp6';
  /** Whether multiple sockets may reuse the local address. */
  reuseAddr?: boolean;
  /** Whether the socket may send IPv4 broadcast datagrams. */
  broadcast?: boolean;
  /** Multicast time-to-live applied to outbound multicast packets. */
  multicastTtl?: number;
}

/**
 * Host-owned UDP socket capability.
 *
 * The handle may be stored by the plugin, but its methods are invocation
 * guarded. Close it during unload when possible; Host cleanup also closes all
 * sockets owned by the plugin instance.
 */
export interface PluginUdpSocket {
  /** Binds the socket and resolves when it is ready to receive datagrams. */
  bind(options?: PluginUdpBindOptions): Promise<void>;
  /** Sends one datagram to the exact remote host and port. */
  send(data: Uint8Array | string, port: number, host: string): Promise<void>;
  /** Registers the callback used for received datagrams. */
  onMessage(handler: (data: Uint8Array, remote: PluginUdpRemoteInfo) => void | Promise<void>): void;
  /** Registers the callback used for socket-level errors. */
  onError(handler: (error: Error) => void): void;
  /** Closes the socket. Calling it again is safe. */
  close(): Promise<void>;
}

/** Factory and bulk-cleanup surface for UDP sockets owned by one plugin instance. */
export interface PluginUdpControl {
  /** Creates an unbound socket with the requested options. */
  createSocket(options?: PluginUdpSocketOptions): PluginUdpSocket;
  /** Closes every UDP socket created through this control. */
  closeAll(): Promise<void>;
}

/** Network capability exposed when the plugin declares `network`. */
export interface PluginNetworkControl {
  /** UDP socket factory. HTTP requests use the sibling `ctx.fetch` capability. */
  readonly udp: PluginUdpControl;
}

/**
 * A message delivered through the plugin-to-plugin event bus.
 *
 * Every message carries metadata about its publisher so subscribers can
 * apply routing or filtering logic based on the source plugin.
 */
export interface PluginEventBusMessage {
  /** The topic this message was published to. */
  topic: string;
  /**
   * Structured-clone-compatible payload. The host does not interpret its
   * business schema, but delivers an independent value to each subscriber.
   */
  payload: unknown;
  /** Epoch milliseconds when the host dispatched the message. */
  timestamp: number;
  /** Identity of the plugin instance that published this message. */
  publisher: {
    /** Name of the publishing plugin (from its `PluginDefinition.name`). */
    pluginName: string;
    /** Whether the publisher is a global or per-operator instance. */
    instanceScope: 'operator' | 'global';
    /** Operator ID when the publisher is an operator-scoped instance. */
    operatorId?: string;
  };
}

/**
 * Permission-gated pub/sub bus for in-process plugin-to-plugin communication.
 *
 * Topics are plain strings shared across all plugin instances within the same
 * host process. Handlers are started synchronously in subscription order.
 * Async handlers run independently; their errors are captured and logged by
 * the host rather than propagated to the publisher.
 *
 * **Lifecycle**: the host automatically removes all subscriptions owned by a
 * plugin instance when it unloads. Individual subscriptions can be cancelled
 * earlier by calling the function returned from {@link subscribe}.
 *
 * **Topic naming**: use dot-separated, plugin-prefixed names to avoid
 * collisions — for example `my-plugin.status.changed` or
 * `callsign-filter.match.found`.
 */
export interface PluginEventBus {
  /**
   * Publishes a message to all current subscribers of the given topic.
   *
   * This is a fire-and-forget operation. The host guarantees that subscriber
   * exceptions never propagate back to the caller. The call itself throws
   * synchronously when the payload is not structured-clone compatible or
   * contains a Host capability.
   *
   * @param topic - Exact topic string to publish to.
   * @param payload - Optional structured-clone-compatible data. Keep payloads reasonably small.
   */
  publish(topic: string, payload?: unknown): void;

  /**
   * Subscribes to messages on the given topic.
   *
   * The same handler function instance will only be added once per topic.
   * Different closures with identical logic are treated as distinct subscribers.
   *
   * @param topic - Exact topic string to listen on.
   * @param handler - Callback invoked for each matching message. May return a
   *   `Promise`; the host catches rejections and logs them.
   * @returns An unsubscribe function. Calling it more than once is a no-op.
   */
  subscribe(
    topic: string,
    handler: (message: PluginEventBusMessage) => void | Promise<void>,
  ): () => void;
}

/**
 * Read-only summary of another operator in the same Host.
 */
export interface OtherOperatorSnapshot {
  /** Unique operator identifier used by the host. */
  readonly id: string;
  /** Configured callsign of the operator/station. */
  readonly callsign: string;
  /** Configured grid locator of the operator/station. */
  readonly grid: string;
  /** Current transmit audio offset in Hz within the passband. */
  readonly audioFrequencyHz: number;
  /** Active digital mode descriptor, for example FT8 or FT4. */
  readonly mode: ModeDescriptor;
  /** Whether this operator is currently transmitting or otherwise armed. */
  readonly isTransmitting: boolean;
  /** Current transmit cycle selection where `0` is even and `1` is odd. */
  readonly transmitCycles: number[];
  /** Current automation runtime snapshot when available. */
  readonly automation?: StrategyRuntimeSnapshot | null;
}

/**
 * Read-only state and query surface for the current operator-scoped plugin
 * instance. Mutations are submitted through `ctx.operatorCommands` when the
 * plugin declares `operator:transmit-control`.
 */
export interface OperatorSnapshot {
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
  /** Host-admitted stream ceiling after radio-frequency and operator safety policy. */
  readonly maxConcurrentStreams: number;
  /** Current automation runtime snapshot visible to the operator UI. */
  readonly automation: StrategyRuntimeSnapshot | null;

  /** Returns read-only snapshots for operators other than the current instance. */
  getOtherOperators(): OtherOperatorSnapshot[];

  /**
   * Checks whether this operator has previously worked the given callsign.
   */
  hasWorkedCallsign(callsign: string, options?: { anyBand?: boolean }): Promise<boolean>;

  /**
   * Checks whether another operator with the same station identity is already
   * working the target callsign.
   */
  isTargetBeingWorkedByOthers(targetCallsign: string): boolean;

}

/**
 * Declarative operator mutations accepted by the host transmission framework.
 *
 * The command set deliberately contains no PTT, audio, mixer, encoder, raw
 * transmit or emergency-stop primitive. Plugins can request product actions;
 * only the host coordinators may translate them into a physical RF lifecycle.
 */
export type PluginOperatorCommand =
  | { type: 'start-automation' }
  | { type: 'stop-automation' }
  | {
      type: 'request-call';
      callsign: string;
      lastMessage?: { message: FrameMessage; slotInfo: SlotInfo };
    }
  | {
      type: 'reply-to-decode';
      callsign: string;
      lastMessage: { message: FrameMessage; slotInfo: SlotInfo };
      modifiers?: number;
    }
  | { type: 'set-transmit-cycles'; cycles: number | number[] }
  | { type: 'remove-contribution' }
  | { type: 'clear-decodes'; window?: number }
  | { type: 'set-free-text'; text: string }
  | { type: 'send-free-text'; text?: string }
  | { type: 'set-temporary-location'; location: string }
  | {
      type: 'highlight-callsign';
      callsign: string;
      background?: string | null;
      foreground?: string | null;
      lastOnly?: boolean;
    };

/** Settlement returned after the Host accepts an operator command. */
export interface PluginOperatorCommandResult {
  /** Host command epoch allocated before any asynchronous work begins. */
  epoch: number;
  /** `superseded` means a newer host command revoked this request. */
  outcome: 'completed' | 'superseded';
}

/**
 * Capability-scoped command port for plugins with
 * `operator:transmit-control` and API v2.
 *
 * The property is omitted from contexts without that capability. Every submit
 * is invocation-guarded and enters the host's per-operator intent lane.
 */
export interface OperatorCommandPort {
  /**
   * Submits one high-level operator command through the Host intent lane.
   * Rejects when the invocation expired, the plugin safety gate is disabled,
   * or the current physical lifecycle cannot accept the command.
   */
  submit(command: PluginOperatorCommand): Promise<PluginOperatorCommandResult>;
}

/**
 * Read-only operating-mode projection that is safe for plugins.
 */
export interface RadioOperatingMode {
  /**
   * TX-5DR engine mode that owns the current radio operating mode.
   */
  readonly engineMode: EngineMode;

  /**
   * ADIF-compatible main mode, for example `SSB`, `FM`, `CW`, `FT8` or `MFSK`.
   */
  readonly mode: string;

  /**
   * ADIF-compatible submode when applicable, for example `USB`, `LSB` or `FT4`.
   */
  readonly submode?: string;

  /**
   * Raw radio modulation mode reported or remembered by the host, for example `USB`.
   */
  readonly radioMode?: string;

  /**
   * TX-5DR runtime mode descriptor used by automation and timing subsystems.
   */
  readonly descriptor: ModeDescriptor;
}

/** Read-only frequency, band, mode and connection state for the active radio. */
export interface RadioView {
  /** Current tuned radio frequency in Hz. */
  readonly frequency: number;
  /** Human-readable current band label, for example `20m`. */
  readonly band: string;
  /** Current operating mode projected to ADIF mode/submode semantics. */
  readonly mode: RadioOperatingMode;
  /** Whether the radio transport is currently connected. */
  readonly isConnected: boolean;
  /** Whether the active radio is a Host-provided simulation rather than physical RF. */
  readonly isSimulation: boolean;

}

/**
 * Access to the host-managed radio capability negotiation system.
 */
export interface RadioCapabilitiesView {
  /** Returns the current capability descriptor/state snapshot. */
  getSnapshot(): CapabilityList;

  /** Returns a single capability state from the current snapshot, or null. */
  getState(id: string): CapabilityState | null;

  /** Refreshes readable capability values and returns the updated snapshot. */
  refresh(): Promise<CapabilityList>;
}

/** Declarative radio mutations accepted by the host radio coordinator. */
export type PluginRadioCommand =
  | { type: 'set-frequency'; frequency: number }
  | {
      /** Atomically changes band and optionally starts the radio's tuner while RF is idle. */
      type: 'switch-band';
      frequency: number;
      autoTune?: boolean;
    };

/**
 * Capability-scoped radio command port.
 *
 * This port exists only for plugins with `radio:control`. It deliberately does
 * not expose a radio connection, PTT primitive, mode switch, audio output or
 * any other physical device object.
 */
export interface RadioCommandPort {
  /** Submits a frequency/band command after Host physical-idle validation. */
  submit(command: PluginRadioCommand): Promise<void>;
}

/** Explicit tuner operations; no arbitrary capability identifier is accepted. */
export type PluginRadioTunerCommand =
  | { type: 'set-enabled'; enabled: boolean }
  | { type: 'start-manual-tune' };

/** Capability-scoped tuner command port for `radio:tuner-control` plugins. */
export interface RadioTunerCommandPort {
  /** Submits one explicit tuner operation after Host safety validation. */
  submit(command: PluginRadioTunerCommand): Promise<void>;
}

/** Optional target profile and startup behavior for a radio power command. */
export interface RadioPowerSetOptions {
  /** Profile to target. Defaults to the active profile. */
  profileId?: string;
  /** Start TX-5DR after physical power-on. Defaults to true. */
  autoEngine?: boolean;
}

/**
 * Access to physical radio power management.
 */
export interface RadioPowerView {
  /** Returns power support information for the active or specified profile. */
  getSupport(profileId?: string): Promise<RadioPowerSupportInfo>;

  /** Returns the last known power transition state for the active or specified profile. */
  getState(profileId?: string): RadioPowerStateEvent | null;
}

/** Declarative power-state transition accepted by `ctx.radioPowerCommands`. */
export type PluginRadioPowerCommand = {
  /** Command discriminator. */
  type: 'set-power';
  /** Requested physical/controller power target. */
  state: RadioPowerTarget;
  /** Optional profile selection and automatic engine startup behavior. */
  options?: RadioPowerSetOptions;
};

/** Capability-scoped physical power command port for `radio:power` plugins. */
export interface RadioPowerCommandPort {
  /** Requests a power transition and resolves with the Host's final state. */
  submit(command: PluginRadioPowerCommand): Promise<RadioPowerResponse>;
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
 * The host resolves an already registered concrete logbook on each operation,
 * which keeps the handle valid across reloads without implicitly creating data.
 */
export interface CallsignLogbookReadAccess {
  /** Normalized callsign that scopes this accessor. */
  readonly callsign: string;

  /** Returns the resolved logbook id, or null when no logbook is registered. */
  getLogBookId(): Promise<string | null>;

  /** Waits until the Host has finished opening this logbook and it is readable. */
  awaitReady(options?: { timeoutMs?: number }): Promise<void>;

  /** Queries QSO records matching the given filter. */
  queryQSOs(filter: QSOQueryFilter): Promise<import('@tx5dr/contracts').QSORecord[]>;
  /** Reads records and their content revision from one consistent logbook snapshot. */
  readQsoSnapshot(filter?: QSOQueryFilter): Promise<LogbookQsoSnapshot>;
  /** Counts QSO records matching the given filter. */
  countQSOs(filter?: QSOQueryFilter): Promise<number>;
  /** Returns current statistics for this callsign's logbook. */
  getStatistics(): Promise<import('@tx5dr/contracts').LogBookStatistics | null>;
}

/** Durable mutation operations scoped to one normalized station callsign. */
export interface CallsignLogbookCommandPort {
  /** Normalized callsign that scopes this accessor. */
  readonly callsign: string;
  /** Adds a QSO and resolves with the final record after durable commit. */
  addQSO(record: import('@tx5dr/contracts').QSORecord): Promise<import('@tx5dr/contracts').QSORecord>;
  /** Updates a QSO and resolves with the final record after durable commit. */
  updateQSO(
    qsoId: string,
    updates: Partial<import('@tx5dr/contracts').QSORecord>,
  ): Promise<import('@tx5dr/contracts').QSORecord>;
  /** Applies a revision-guarded set of QSO additions and updates as one durable transaction. */
  applyQsoBatch(
    mutations: readonly LogbookBatchMutation[],
    options: { expectedRevision: string },
  ): Promise<LogbookBatchResult>;
  /** Notifies the frontend that this callsign's logbook changed. */
  notifyUpdated(operatorId?: string): Promise<void>;
}

/** Combined read/write callsign-bound logbook capability. */
export interface CallsignLogbookAccess
  extends CallsignLogbookReadAccess, CallsignLogbookCommandPort {}

/** Stable descriptor for one Host-managed, plugin-owned logbook session. */
export interface PluginLogbookSessionDescriptor {
  /** Stable key within the owning plugin and station callsign. */
  sessionKey: string;
  /** Station callsign whose QSOs belong to this session. */
  stationCallsign: string;
  /** User-facing session title. */
  title: string;
  /** Durable by default; runtime sessions are deleted when explicitly destroyed or the Host exits. */
  retention?: 'durable' | 'runtime';
}

/** Read/write access to one plugin-owned logbook session. */
export interface PluginLogbookSessionAccess extends CallsignLogbookAccess {
  /** Opaque Host-issued session logbook identifier. */
  readonly id: string;
  /** User-facing title supplied when the session was opened. */
  readonly title: string;
  /** Destroys a runtime-retained session. Durable sessions reject this operation. */
  destroy(): Promise<void>;
}

/** Host-arbitrated access to logbook sessions owned by the current plugin. */
export interface PluginLogbookSessions {
  /** Opens or reuses a durable session without changing the station's primary logbook. */
  open(descriptor: PluginLogbookSessionDescriptor): Promise<PluginLogbookSessionAccess>;
  /** Destroys an existing runtime-retained session owned by this plugin and operator. */
  destroy(sessionKey: string): Promise<void>;
}

/** Read-only worked-status and QSO query capability for `logbook:read`. */
export interface LogbookReadAccess {
  // === Read-only helpers (original) ===

  /** Checks whether the callsign has already been worked. */
  hasWorked(callsign: string, options?: { anyBand?: boolean }): Promise<boolean>;
  /** Checks whether the DXCC entity has already been worked. */
  hasWorkedDXCC(dxccEntity: string): Promise<boolean>;
  /** Checks whether the Maidenhead grid has already been worked. */
  hasWorkedGrid(grid: string): Promise<boolean>;

  // === Query ===

  /** Queries QSO records matching the given filter. */
  queryQSOs(filter: QSOQueryFilter): Promise<import('@tx5dr/contracts').QSORecord[]>;
  /** Reads records and their content revision from one consistent logbook snapshot. */
  readQsoSnapshot(filter?: QSOQueryFilter): Promise<LogbookQsoSnapshot>;
  /** Counts QSO records matching the given filter. */
  countQSOs(filter?: QSOQueryFilter): Promise<number>;

  /** Returns a read-only callsign-bound accessor suitable for global plugin instances. */
  forCallsign(callsign: string): CallsignLogbookReadAccess;
}

/** Durable mutation operations exposed by the `logbook:write` permission. */
export interface LogbookCommandPort {
  /** Adds a QSO and resolves with the final record after durable commit. */
  addQSO(record: import('@tx5dr/contracts').QSORecord): Promise<import('@tx5dr/contracts').QSORecord>;
  /** Updates a QSO and resolves with the final record after durable commit. */
  updateQSO(
    qsoId: string,
    updates: Partial<import('@tx5dr/contracts').QSORecord>,
  ): Promise<import('@tx5dr/contracts').QSORecord>;
  /** Applies a revision-guarded set of QSO additions and updates as one durable transaction. */
  applyQsoBatch(
    mutations: readonly LogbookBatchMutation[],
    options: { expectedRevision: string },
  ): Promise<LogbookBatchResult>;

  // === Notification ===

  /** Notifies the frontend to refresh logbook data (call after batch writes). */
  notifyUpdated(): Promise<void>;

  /** Returns a callsign-bound durable mutation port for global plugin instances. */
  forCallsign(callsign: string): CallsignLogbookCommandPort;
}

/** @deprecated Prefer capability-specific LogbookReadAccess and LogbookCommandPort. */
export interface LogbookAccess extends LogbookReadAccess, LogbookCommandPort {
  /** Returns a combined read/write accessor for the requested station callsign. */
  forCallsign(callsign: string): CallsignLogbookAccess;
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
   * idle window is found. A successful result also reserves that offset for the
   * current operator and analyzed slot so later operators avoid selecting the
   * same window.
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
   * Publishes a JSON-compatible snapshot for the given declarative panel id.
   * Mutating the caller's object after this call does not alter panel state.
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

  /** Requests a fresh operator/runtime projection after plugin-owned state changes. */
  refreshOperatorProjection(): void;

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
   * Pushes a JSON-compatible data snapshot to the specific page session.
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
   * Pushes a JSON-compatible data snapshot to an iframe UI page by page id.
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
 * application-defined invoke requests from their iframe-based UIs. The Host
 * does not interpret the business schema, but it enforces the page/session
 * authorization and JSON data boundary in both directions.
 */
export interface PluginUIHandler {
  /**
   * Called when the iframe sends an invoke request via `bridge.invoke(action, data)`.
   *
   * @param pageId - The page that sent the message.
   * @param action - Developer-defined action identifier.
   * @param data - JSON-compatible snapshot from the iframe; validate it as
   *   untrusted input before use.
   * @param requestContext - Host-authenticated page context, including any
   * bound resource for this page session.
   * @returns A JSON-compatible response snapshot sent back to the iframe.
   */
  onMessage(
    pageId: string,
    action: string,
    data: unknown,
    requestContext: PluginUIRequestContext,
  ): Promise<unknown>;
}

/** Host-authenticated user identity attached to an iframe invoke request. */
export interface PluginUIRequestUser {
  /** Stable token/session identifier; not the raw credential. */
  readonly tokenId: string;
  /** Effective role at the time the Host authorizes the request. */
  readonly role: 'viewer' | 'operator' | 'admin';
  /** Operator IDs the current user is allowed to access. */
  readonly operatorIds: string[];
  /** Fine-grained grants associated with the authenticated user, when present. */
  readonly permissionGrants?: PermissionGrant[];
}

/** Resource identity resolved and authorized from the page descriptor binding. */
export interface PluginUIBoundResource {
  /** Kind declared by `resourceBinding`. */
  readonly kind: 'callsign' | 'operator';
  /** Normalized callsign or authorized operator ID. */
  readonly value: string;
}

/** Plugin instance selected by the Host for this page request. */
export type PluginUIInstanceTarget =
  | { readonly kind: 'global' }
  | { readonly kind: 'operator'; readonly operatorId: string };

/** Read-only identity of one active plugin iframe page session. */
export interface PluginUIPageSessionInfo {
  /** Unique ID used for exact session pushes. */
  readonly sessionId: string;
  /** `PluginDefinition.ui.pages` entry rendered by this session. */
  readonly pageId: string;
  /** Host-authorized resource binding, when the page declares one. */
  readonly resource?: PluginUIBoundResource;
}

/** Page-session identity plus an exact push channel back to that iframe. */
export interface PluginUIPageContext extends PluginUIPageSessionInfo {
  /** Sends a JSON-compatible snapshot to this exact page session. */
  push(action: string, data?: unknown): void;
}

/**
 * Host-authenticated context passed to an iframe page handler.
 *
 * Treat `data` from the iframe as untrusted input. Use this context, rather
 * than caller-supplied IDs, for authorization and storage scoping.
 */
export interface PluginUIRequestContext {
  /** Same exact page session identifier exposed as `page.sessionId`. */
  readonly pageSessionId: string;
  /** User identity authorized by the Host for this request. */
  readonly user: PluginUIRequestUser;
  /** Bound callsign/operator, when required by the page descriptor. */
  readonly resource?: PluginUIBoundResource;
  /** Global or operator plugin instance receiving the request. */
  readonly instanceTarget: PluginUIInstanceTarget;
  /** Exact page session/push capability, valid only during the current handler invocation. */
  readonly page: PluginUIPageContext;
  /**
   * Page-scoped file storage shared with iframe `tx5dr.file*()` calls.
   *
   * Use this in `registerPageHandler()` handlers to read files uploaded by the
   * current iframe page session without reconstructing host-internal scope
   * paths. Both `page` and `files` are exact-invocation capabilities: do not
   * retain and invoke them after the current `onMessage()` promise settles.
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
  /** Writes a copy of the Buffer, creating or replacing the file. */
  write(path: string, data: Buffer): Promise<void>;

  /** Reads a file into a new Buffer. Returns `null` when the path does not exist. */
  read(path: string): Promise<Buffer | null>;

  /** Deletes a file. Returns `true` if the file existed and was removed. */
  delete(path: string): Promise<boolean>;

  /** Lists file paths under the given prefix (or all files when omitted). */
  list(prefix?: string): Promise<string[]>;
}
