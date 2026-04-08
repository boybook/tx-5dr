import type { KVStore, PluginLogger, PluginTimers, OperatorControl, RadioControl, LogbookAccess, BandAccess, UIBridge } from './helpers.js';

/**
 * Plugin Context — the API surface available to plugins at runtime.
 *
 * Each plugin receives a PluginContext instance scoped to a specific operator.
 * The context provides access to configuration, storage, logging, operator control,
 * radio control, logbook queries, band data, UI communication, and optionally HTTP.
 */
export interface PluginContext {
  /** User-configured setting values (read-only, injected from config.json). */
  readonly config: Readonly<Record<string, unknown>>;

  /** Persistent KV storage. */
  readonly store: {
    /** Shared across all operators. */
    readonly global: KVStore;
    /** Scoped to the current operator. */
    readonly operator: KVStore;
  };

  /** Logger — outputs to system log and the frontend plugin log panel. */
  readonly log: PluginLogger;

  /** Timer management — set named interval timers that trigger onTimer hooks. */
  readonly timers: PluginTimers;

  /** Control the current operator (start/stop, call, set cycles). */
  readonly operator: OperatorControl;

  /** Control and query the physical radio. */
  readonly radio: RadioControl;

  /** Query the logbook (has worked callsign/DXCC/grid). */
  readonly logbook: LogbookAccess;

  /** Query band/decode data. */
  readonly band: BandAccess;

  /** Push data to frontend panels. */
  readonly ui: UIBridge;

  /**
   * Controlled HTTP fetch.
   * Only available if the plugin declares 'network' permission.
   * Undefined otherwise.
   */
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}
