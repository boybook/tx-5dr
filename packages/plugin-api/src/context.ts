import type {
  KVStore,
  ReadonlyKVStore,
  PluginLogger,
  PluginTimers,
  OperatorSnapshot,
  OperatorCommandPort,
  RadioView,
  RadioCapabilitiesView,
  RadioCommandPort,
  RadioTunerCommandPort,
  RadioPowerView,
  RadioPowerCommandPort,
  LogbookReadAccess,
  LogbookAccess,
  PluginLogbookSessions,
  BandAccess,
  UIBridge,
  PluginFileStore,
  PluginNetworkControl,
  PluginEventBus,
} from './helpers.js';
import type { PluginPermission } from '@tx5dr/contracts';
import type { LogbookSyncRegistrar } from './sync.js';
import type { HostSettingsControl } from './settings.js';
import type { HostDependencies } from './host-dependencies.js';

/**
 * Runtime services exposed to a plugin instance.
 *
 * The host creates a {@link PluginContext} for each loaded plugin/operator
 * combination. It is the main entry point for everything that a plugin can do
 * at runtime: read resolved settings, persist state, control the operator,
 * interact with the radio, publish UI updates and, when permitted, perform HTTP
 * requests.
 *
 * The context is intentionally capability-oriented. If a method is not exposed
 * here, plugin code should treat it as unavailable rather than reaching into
 * TX-5DR internals.
 */
export interface PluginContextBase {
  /** Bundled Plugin API version. Use plugin declarations for compatibility checks. */
  readonly pluginApiVersion: string;

  /**
   * Resolved plugin configuration values.
   *
   * The host validates and persists settings, then supplies a detached snapshot
   * before invoking hooks or lifecycle methods. Mutating nested values does not
   * update persistence; call {@link PluginContextBase.updateConfig} instead. Use
   * {@link PluginHooks.onConfigChange} to react to updates.
   */
  readonly config: Readonly<Record<string, unknown>>;

  /**
   * Applies a partial patch to this plugin's settings.
   *
   * The patch is shallow-merged with existing resolved settings
   * according to the instance scope (operator or global).
   * After the update, the host persists the change, notifies
   * all instances via {@link PluginHooks.onConfigChange}, and
   * pushes the new status to the frontend.
   */
  updateConfig(patch: Record<string, unknown>): Promise<void>;

  /**
   * Persistent key-value stores provisioned for the plugin.
   *
   * Each scope is isolated by plugin identity. Use `global` for shared plugin
   * data and `operator` for values that should not leak across operators.
   */
  readonly store: {
    /**
     * Storage shared by all operators and all sessions of this plugin.
     */
    readonly global: KVStore;

    /**
     * Storage isolated to the current operator instance.
     */
    readonly operator: KVStore;
  };

  /** Read-only validation for exact FT8/FT4 message encoding. */
  readonly digitalMessagePreflight: import('./helpers.js').DigitalMessagePreflight;

  /**
   * Structured logger scoped to the plugin.
   *
   * Messages typically appear in backend logs and, when applicable, in frontend
   * plugin log views.
   */
  readonly log: PluginLogger;

  /**
   * Named timer manager owned by the host.
   *
   * Timers created here are automatically cleaned up when the plugin unloads, so
   * prefer this over raw `setInterval` calls inside plugin code.
   */
  readonly timers: PluginTimers;

  /** Read-only snapshot and query surface for the current operator. */
  readonly operator: OperatorSnapshot;

  /**
   * Read-only projection of the physical radio state.
   */
  readonly radio: RadioView;

  /**
   * Read-only access to current-band and slot decode data.
   */
  readonly band: BandAccess;

  /**
   * Bridge for pushing structured data into declarative plugin panels and
   * for communicating with custom iframe UI pages.
   */
  readonly ui: UIBridge;

  /**
   * Persistent binary file storage sandboxed to the plugin.
   *
   * Files are stored in the plugin data directory under a host-managed sandbox.
   * Use this for binary assets such as certificates, images or cached data.
   * For structured JSON data, prefer {@link PluginContext.store} instead.
   */
  readonly files: PluginFileStore;

}

type CapabilityProperty<
  Permissions extends readonly PluginPermission[],
  Permission extends PluginPermission,
  Property extends object,
> = number extends Permissions['length']
  ? object
  : Permission extends Permissions[number] ? Property : object;

type SettingsCapability<Permissions extends readonly PluginPermission[]> =
  number extends Permissions['length']
    ? object
    : Extract<Permissions[number], `settings:${string}`> extends never
      ? object
      : {
          readonly settings:
            CapabilityProperty<Permissions, 'settings:ft8', Pick<HostSettingsControl, 'ft8'>>
            & CapabilityProperty<Permissions, 'settings:decode-windows', Pick<HostSettingsControl, 'decodeWindows'>>
            & CapabilityProperty<Permissions, 'settings:realtime', Pick<HostSettingsControl, 'realtime'>>
            & CapabilityProperty<Permissions, 'settings:frequency-presets', Pick<HostSettingsControl, 'frequencyPresets'>>
            & CapabilityProperty<Permissions, 'settings:station', Pick<HostSettingsControl, 'station'>>
            & CapabilityProperty<Permissions, 'settings:psk-reporter', Pick<HostSettingsControl, 'pskReporter'>>
            & CapabilityProperty<Permissions, 'settings:ntp', Pick<HostSettingsControl, 'ntp'>>;
        };

type MainLogbookCapability<Permissions extends readonly PluginPermission[]> =
  'logbook:write' extends Permissions[number]
    ? LogbookAccess
    : 'logbook:read' extends Permissions[number]
      ? LogbookReadAccess
      : object;

type SessionLogbookCapability<Permissions extends readonly PluginPermission[]> =
  'logbook:session' extends Permissions[number]
    ? { readonly sessions: PluginLogbookSessions }
    : object;

type LogbookCapability<Permissions extends readonly PluginPermission[]> =
  number extends Permissions['length']
    ? object
    : Extract<Permissions[number], 'logbook:read' | 'logbook:write' | 'logbook:session'> extends never
      ? object
      : { readonly logbook: MainLogbookCapability<Permissions> & SessionLogbookCapability<Permissions> };

/**
 * Plugin context whose privileged ports are derived from literal manifest
 * permissions. Capabilities that were not declared do not exist in the type.
 *
 * Host handles are invocation-scoped. In particular, a `Response` returned by
 * `ctx.fetch` and its Headers/body reader must be consumed before the current
 * Host callback settles; retaining the native handle for later use results in
 * `PLUGIN_INVOCATION_EXPIRED`.
 */
export type PluginContextFor<Permissions extends readonly PluginPermission[]> =
  PluginContextBase
  & CapabilityProperty<Permissions, 'operator:transmit-control', {
    readonly operatorCommands: OperatorCommandPort;
  }>
  & CapabilityProperty<Permissions, 'radio:read', {
    readonly radioCapabilities: RadioCapabilitiesView;
    readonly radioPower: RadioPowerView;
  }>
  & CapabilityProperty<Permissions, 'radio:control', {
    readonly radioCommands: RadioCommandPort;
  }>
  & CapabilityProperty<Permissions, 'radio:tuner-control', {
    readonly radioTunerCommands: RadioTunerCommandPort;
  }>
  & CapabilityProperty<Permissions, 'radio:power', {
    readonly radioPowerCommands: RadioPowerCommandPort;
  }>
  & LogbookCapability<Permissions>
  & CapabilityProperty<Permissions, 'logbook:sync', {
    readonly logbookSync: LogbookSyncRegistrar;
  }>
  & SettingsCapability<Permissions>
  & CapabilityProperty<Permissions, 'network', {
    readonly network: PluginNetworkControl;
    readonly fetch: (url: string, init?: RequestInit) => Promise<Response>;
  }>
  & CapabilityProperty<Permissions, 'plugin:event-bus', {
    readonly eventBus: PluginEventBus;
  }>
  & CapabilityProperty<Permissions, 'host:hamlib', {
    readonly hostDependencies: HostDependencies & Required<Pick<HostDependencies, 'hamlib'>>;
  }>;

/** Safe default context for code that has not declared literal permissions. */
export type PluginContext = PluginContextFor<readonly []>;

/**
 * Teardown-only context passed to `onUnload`.
 *
 * Cleanup may inspect the read-only operator state, flush plugin-owned state
 * and release plugin-owned files. The Host also permits previously acquired
 * native-resource and UI handles to finish cleanup, but does not reopen radio,
 * network, event-bus, logbook or command capabilities while the instance is
 * being revoked.
 */
export type PluginCleanupContext = Pick<
  PluginContextBase,
  'store' | 'log' | 'timers' | 'files' | 'operator'
>;

/** Host-side erased runtime shape. Public plugin definitions should use `definePlugin()`. */
export type RuntimePluginContext = PluginContextBase & Partial<{
  operatorCommands: OperatorCommandPort;
  radioCapabilities: RadioCapabilitiesView;
  radioCommands: RadioCommandPort;
  radioTunerCommands: RadioTunerCommandPort;
  radioPower: RadioPowerView;
  radioPowerCommands: RadioPowerCommandPort;
  logbook: LogbookReadAccess | LogbookAccess | { readonly sessions: PluginLogbookSessions };
  logbookSync: LogbookSyncRegistrar;
  settings: Partial<HostSettingsControl>;
  network: PluginNetworkControl;
  eventBus: PluginEventBus;
  hostDependencies: HostDependencies;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
}>;

/**
 * Deliberately narrow context captured by a speculative strategy runtime.
 * Decisions can inspect operator state and emit a result, but cannot retain a
 * command, radio, logbook-write, network, timer or UI capability.
 */
export interface StrategyPluginContext {
  /** Bundled Plugin API version available before the strategy runtime is created. */
  readonly pluginApiVersion: string;
  /** Detached snapshot of the strategy plugin's resolved configuration. */
  readonly config: Readonly<Record<string, unknown>>;
  /** Logger scoped to this strategy instance. */
  readonly log: PluginLogger;
  /** Read-only operator snapshot; mutation ports are deliberately absent. */
  readonly operator: OperatorSnapshot;
  /** Read-only projection of the current radio band and operating mode. */
  readonly radio: RadioView;
  /** Live, read-only views of the storage scopes declared by this plugin. */
  readonly store: {
    readonly global: ReadonlyKVStore;
    readonly operator: ReadonlyKVStore;
  };
  /** Read-only exact-message encoding validation. */
  readonly digitalMessagePreflight: import('./helpers.js').DigitalMessagePreflight;
}

/** Minimal context used to evaluate a transmit-control eligibility predicate. */
export interface PluginEligibilityContext {
  /** Current detached configuration snapshot used by the synchronous gate. */
  readonly config: Readonly<Record<string, unknown>>;
}
