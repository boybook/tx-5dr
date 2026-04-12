import type {
  PluginSettingDescriptor,
  PluginQuickAction,
  PluginQuickSetting,
  PluginPanelDescriptor,
  PluginPermission,
  PluginType,
  PluginUIPageDescriptor,
} from '@tx5dr/contracts';
import type { PluginContext } from './context.js';
import type { PluginHooks } from './hooks.js';
import type { StrategyRuntime } from './runtime.js';

/**
 * Describes a TX-5DR plugin module.
 *
 * The default export of a plugin package or entry file must satisfy this
 * interface. It combines declarative metadata, optional UI descriptors and the
 * runtime callbacks that the host invokes after the plugin is loaded.
 *
 * A plugin can be one of two categories:
 * - `strategy`: owns the operator automation state machine and is mutually
 *   exclusive per operator.
 * - `utility`: augments the pipeline or UI and can run alongside other utility
 *   plugins.
 *
 * The TX-5DR host reads this definition once during load, validates the static
 * fields and then wires the lifecycle callbacks and hooks into the plugin
 * subsystem.
 *
 * @example
 * ```js
 * /** @type {import('@tx5dr/plugin-api').PluginDefinition} *\/
 * export default {
 *   name: 'my-plugin',
 *   version: '1.0.0',
 *   type: 'utility',
 *   description: 'Annotates interesting decoded stations.',
 *   hooks: {
 *     onDecode(messages, ctx) {
 *       ctx.log.info('decoded', { count: messages.length });
 *     },
 *   },
 * };
 * ```
 *
 * @example
 * ```ts
 * import type { PluginDefinition } from '@tx5dr/plugin-api';
 *
 * const plugin: PluginDefinition = {
 *   name: 'my-strategy',
 *   version: '1.0.0',
 *   type: 'strategy',
 *   createStrategyRuntime(ctx) {
 *     return {
 *       decide() {
 *         return { stop: false };
 *       },
 *       getTransmitText() {
 *         return null;
 *       },
 *       requestCall() {},
 *       getSnapshot() {
 *         return { currentState: 'idle' };
 *       },
 *       patchContext() {},
 *       setState() {},
 *       setSlotContent() {},
 *       reset() {},
 *     };
 *   },
 * };
 *
 * export default plugin;
 * ```
 */
export interface PluginDefinition {
  /**
   * Stable machine-readable plugin identifier.
   *
   * This value is used as the plugin's identity in manifests, persisted
   * configuration, log records and runtime lookups. Treat it as an immutable ID
   * once the plugin is released.
   */
  name: string;

  /**
   * Semantic version of the plugin implementation.
   *
   * The host does not currently enforce a compatibility policy, but publishing a
   * valid semver string makes diagnostics and upgrades much easier.
   */
  version: string;

  /**
   * Declares how the host should schedule and combine this plugin.
   *
   * - `strategy` plugins provide a {@link StrategyRuntime} and are selected as
   *   the active automation implementation for an operator.
   * - `utility` plugins participate in filters, scoring, monitoring and UI, but
   *   do not own the core automation state machine.
   */
  type: PluginType;

  /**
   * Human-readable summary shown in plugin management UIs.
   *
   * Keep this short and product-oriented so operators can quickly understand the
   * plugin's purpose.
   */
  description?: string;

  /**
   * Explicitly declares privileged capabilities required by the plugin.
   *
   * Permissions allow the host to gate sensitive features such as network
   * access. Always declare the smallest set that the plugin truly needs.
   */
  permissions?: PluginPermission[];

  /**
   * Declarative settings schema for generated configuration forms.
   *
   * Each key becomes a persisted config entry. The host validates and stores the
   * values, then exposes the resolved runtime config through
   * {@link PluginContext.config}. Use this for durable, user-facing settings
   * rather than ephemeral runtime state.
   */
  settings?: Record<string, PluginSettingDescriptor>;

  /**
   * Lightweight button actions shown in operator-facing quick action areas.
   *
   * These are intended for one-shot commands such as reset, clear or manual
   * trigger operations. When clicked, the host invokes
   * {@link PluginHooks.onUserAction} with the configured action id.
   */
  quickActions?: PluginQuickAction[];

  /**
   * Quick settings surfaced in compact operator-facing automation panels.
   *
   * Use these for high-frequency adjustments that operators may need to tweak
   * during operation, such as a threshold, target list or enable flag.
   */
  quickSettings?: PluginQuickSetting[];

  /**
   * Panel descriptors used to render plugin-owned UI sections.
   *
   * Structured panels (`key-value`, `table`, `log`, `chart`) receive live data
   * through {@link PluginContext.ui.send}. Iframe panels (`component: 'iframe'`)
   * render a custom HTML page and communicate via `invoke` / `onPush`.
   *
   * Each panel has a `slot` that controls where it renders: `'operator'` (the
   * default, shown in the operator card) or `'automation'` (shown in the
   * top-right automation popover).
   */
  panels?: PluginPanelDescriptor[];

  /**
   * Declares which persistent storage scopes should be provisioned.
   *
   * Request `global` storage for data shared by the whole station, and
   * `operator` storage for per-operator state. The corresponding stores are then
   * available via {@link PluginContext.store}.
   */
  storage?: { scopes: ('global' | 'operator')[] };

  /**
   * Declares custom UI pages served from the plugin's static file directory.
   *
   * Pages are rendered inside an iframe by the host's `PluginIframeHost`
   * component. The host automatically injects CSS design tokens and a
   * communication bridge SDK. Plugins can use any web technology inside the
   * iframe.
   *
   * Pages are declarative — they only define _what_ exists, not _where_ it is
   * rendered. The rendering location is decided by consumers (e.g. a logbook
   * sync host renders the page in a settings modal tab, while a future
   * dashboard host may render it in a side panel).
   */
  ui?: {
    /** Static file directory relative to the plugin root (default: 'ui'). */
    dir?: string;
    /** Registered custom UI pages. */
    pages?: PluginUIPageDescriptor[];
  };

  /**
   * Creates the strategy runtime for a `strategy` plugin.
   *
   * This method is required when {@link PluginDefinition.type} is `strategy` and
   * should be omitted for utility plugins. The returned runtime becomes the
   * operator's active automation controller.
   */
  createStrategyRuntime?(ctx: PluginContext): StrategyRuntime;

  /**
   * Runs after the plugin instance has been loaded and the context is ready.
   *
   * Use this for startup work such as warming caches, scheduling timers or
   * sending initial panel data. Keep it fast; long-running work should be
   * deferred or done asynchronously.
   */
  onLoad?(ctx: PluginContext): void | Promise<void>;

  /**
   * Runs before the plugin instance is unloaded.
   *
   * Use this to release external resources or flush state that is not already
   * handled through the host abstractions. Any timers created via
   * {@link PluginContext.timers} are cleared automatically by the host.
   */
  onUnload?(ctx: PluginContext): void | Promise<void>;

  /**
   * Event and pipeline hooks implemented by the plugin.
   *
   * Hooks let utility plugins observe or transform the message flow, and let the
   * active strategy participate in decision making.
   */
  hooks?: PluginHooks;
}
