import type {
  PluginSettingDescriptor,
  PluginQuickAction,
  PluginQuickSetting,
  PluginPanelDescriptor,
  PluginPermission,
  PluginType,
  PluginInstanceScope,
  PluginUIPageDescriptor,
} from '@tx5dr/contracts';
import type {
  PluginCleanupContext,
  PluginContextFor,
  PluginEligibilityContext,
  StrategyPluginContext,
} from './context.js';
import type { PluginHooks } from './hooks.js';
import type { StrategyRuntime } from './runtime.js';
import type { SimulationScenarioDescriptor } from './simulation.js';

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
 * import { definePlugin } from '@tx5dr/plugin-api';
 *
 * export default definePlugin({
 *   apiVersion: 2,
 *   name: 'my-plugin',
 *   version: '1.0.0',
 *   type: 'utility',
 *   description: 'Annotates interesting decoded stations.',
 *   permissions: [],
 *   hooks: {
 *     onDecode(messages, ctx) {
 *       ctx.log.info('decoded', { count: messages.length });
 *     },
 *   },
 * });
 * ```
 *
 * @example
 * ```ts
 * import { definePlugin } from '@tx5dr/plugin-api';
 *
 * export default definePlugin({
 *   apiVersion: 2,
 *   name: 'my-strategy',
 *   version: '1.0.0',
 *   type: 'strategy',
 *   createStrategyRuntime() {
 *     return {
 *       checkpoint() {
 *         return {};
 *       },
 *       restore() {},
 *       decide() {
 *         return {
 *           transmission: null,
 *           snapshot: this.getSnapshot(),
 *         };
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
 * });
 * ```
 */
export interface PluginDefinition<
  Permissions extends readonly PluginPermission[] = readonly [],
> {
  /**
   * Public API contract version. All new plugins should use `2`.
   *
   * API v2 is required for strategy plugins and for utility plugins that request
   * any mutation capability: `operator:transmit-control`, `radio:control`,
   * `radio:tuner-control`, `radio:power`, `logbook:write` or `logbook:sync`.
   */
  apiVersion?: 2;

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

  /** Optional strategy capabilities advertised to Host UI and routing. */
  strategyFeatures?: {
    /** Declares the `QueuedStrategyRuntime` assisted-target queue contract. */
    targetQueue?: 1;
    /** Declares support for more than one active target lane. */
    parallelTargetQueue?: 1;
    /** Controls whether enqueueing may start a stopped operator. */
    queueActivation?: 'immediate' | 'operator-toggle';
    /** Blocks unscoped plugin commands; the strategy may consume its own audited operator authorization. */
    manualInitiation?: 1;
    /** Strategy-specific cap applied in addition to the operator cap. */
    maxConcurrentStreams?: number;
  };

  /** Development-only virtual-radio peer scenarios. The Host owns execution and RF safety. */
  simulationScenarios?: SimulationScenarioDescriptor[];

  /**
   * Controls whether the host creates one instance per operator or a single
   * shared instance for the whole station.
   *
   * Defaults to `operator` when omitted.
   * Global scope is utility-only. It cannot use operator-scoped settings or
   * quick settings, and only global-compatible hooks/panels are accepted by the
   * loader. Use it for station-wide sync, network services and radio policy.
   */
  instanceScope?: PluginInstanceScope;

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
  permissions?: Permissions;

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
   * Static panel descriptors used to render plugin-owned UI sections.
   *
   * Structured panels (`key-value`, `table`, `log`, `chart`) receive live data
   * through {@link PluginContext.ui.send}. Iframe panels (`component: 'iframe'`)
   * render a custom HTML page and communicate via `invoke` / `onPush`.
   * The host exposes these static descriptors as the reserved `manifest`
   * contribution group. Plugins that need to add or remove panels at runtime
   * should use {@link PluginContext.ui.setPanelContributions} instead of
   * predeclaring placeholder panels.
   *
   * Each panel has a `slot` that controls where it renders: `'operator'` (the
   * default, shown in the operator card), `'automation'` (shown in the
   * top-right automation popover), `'operator-action'` (an icon-and-text page
   * action beside the operator logbook button), `'main-right'` (the optional far-right main
   * pane), `'voice-left-top'` (above the voice frequency card),
   * `'voice-right-top'` (the tabbed top area of the voice right panel),
   * `'cw-left-top'` (above the CW frequency card),
   * `'cw-right-top'` (the tabbed top area of the CW right panel), or
   * `'radio-control-toolbar'` (a global utility iframe button in RadioControl).
   * An `operator-action` panel must use `component: 'iframe'` and
   * `openMode: 'page'`; the Host binds it to that operator and opens the
   * referenced custom UI as a standalone page.
   * Panels may also declare a preferred `width`, such as `'full'`, so hosts can
   * promote more important live panels.
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
  createStrategyRuntime?(ctx: StrategyPluginContext): StrategyRuntime;

  /**
   * Runs after the plugin instance has been loaded and the context is ready.
   *
   * Use this for startup work such as warming caches, scheduling Host timers or
   * sending initial panel data. Await required asynchronous work before returning;
   * do not detach continuations that retain Host capabilities after the callback.
   */
  onLoad?(ctx: PluginContextFor<Permissions>): void | Promise<void>;

  /**
   * Runs before the plugin instance is unloaded.
   *
   * Use this to release external resources or flush state that is not already
   * handled through the host abstractions. Any timers created via
   * {@link PluginContext.timers} are cleared automatically by the host.
   */
  onUnload?(ctx: PluginCleanupContext): void | Promise<void>;

  /**
   * Event and pipeline hooks implemented by the plugin.
   *
   * Hooks let utility plugins observe or transform the message flow, and let the
   * active strategy participate in decision making.
   */
  hooks?: PluginHooks<Permissions>;

  /**
   * Safety gate for the operator command port.
   *
   * Plugins that declare `operator:transmit-control` must implement this or
   * {@link isAutoCallEnabled}. The host evaluates it immediately before each
   * command so disabled remote-control or integration features cannot retain
   * command authority.
   */
  isTransmitControlEnabled?(ctx: PluginEligibilityContext): boolean;

  /**
   * Marks an operator-scoped plugin as an automatic calling controller and
   * reports whether that behavior is currently enabled.
   *
   * The host uses this declaration for the auto-call indicator and pause UI.
   * It also acts as the command-port safety gate when
   * {@link isTransmitControlEnabled} is omitted. Integrations that can submit
   * occasional external commands but are not auto-call controllers should
   * implement only {@link isTransmitControlEnabled}.
   */
  isAutoCallEnabled?(ctx: PluginEligibilityContext): boolean;
}

/** Type-erased plugin definition used by the host after module loading. */
// Permission tuples are invariant because callback contexts depend on their
// exact literals, so the host registry needs a deliberate existential erasure.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyPluginDefinition = PluginDefinition<any>;

/**
 * Defines a plugin while preserving literal permissions for capability-aware
 * callback context inference. New plugins should use this helper instead of
 * widening their definition to `PluginDefinition`.
 */
export function definePlugin<
  const Permissions extends readonly PluginPermission[] = readonly [],
>(definition: PluginDefinition<Permissions>): PluginDefinition<Permissions> {
  return definition;
}
