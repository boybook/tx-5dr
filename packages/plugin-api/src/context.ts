import type {
  KVStore,
  PluginLogger,
  PluginTimers,
  OperatorControl,
  RadioControl,
  LogbookAccess,
  BandAccess,
  UIBridge,
  PluginFileStore,
} from './helpers.js';
import type { LogbookSyncRegistrar } from './sync.js';

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
export interface PluginContext {
  /**
   * Resolved plugin configuration values.
   *
   * The host validates and persists settings, then injects the final values into
   * this readonly map before invoking hooks or lifecycle methods. Use
   * {@link PluginHooks.onConfigChange} to react to updates.
   */
  readonly config: Readonly<Record<string, unknown>>;

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

  /**
   * Control surface for the current operator.
   */
  readonly operator: OperatorControl;

  /**
   * Access to the physical radio state and tuning controls.
   */
  readonly radio: RadioControl;

  /**
   * Full logbook access — read-only queries, record writes and UI notifications.
   *
   * Provides the original read-only helpers (`hasWorked`, `hasWorkedDXCC`,
   * `hasWorkedGrid`) plus advanced query (`queryQSOs`, `countQSOs`), write
   * (`addQSO`, `updateQSO`) and notification (`notifyUpdated`) capabilities.
   * Sync providers and other data-oriented plugins use the write methods to
   * self-orchestrate their flow without host-side special handling.
   */
  readonly logbook: LogbookAccess;

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

  /**
   * Logbook sync registration entry point.
   *
   * Utility plugins that implement logbook synchronization call
   * `ctx.logbookSync.register(provider)` during `onLoad` to register their
   * sync provider. The host manages the provider lifecycle and UI integration.
   */
  readonly logbookSync: LogbookSyncRegistrar;

  /**
   * Permission-gated HTTP client.
   *
   * This method is only available when the plugin declares the corresponding
   * network permission. Treat it as optional and feature-detect before calling.
   */
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}
