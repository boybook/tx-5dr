import type {
  PluginSettingDescriptor,
  PluginQuickAction,
  PluginQuickSetting,
  PluginPanelDescriptor,
  PluginPermission,
  PluginType,
} from '@tx5dr/contracts';
import type { PluginContext } from './context.js';
import type { PluginHooks } from './hooks.js';
import type { StrategyRuntime } from './runtime.js';

/**
 * Plugin Definition — the shape of a plugin's default export.
 *
 * This is the main interface that plugin authors implement.
 *
 * @example
 * ```js
 * // Single JS file with JSDoc (low barrier):
 * /** @type {import('@tx5dr/plugin-api').PluginDefinition} *\/
 * export default {
 *   name: 'my-plugin',
 *   version: '1.0.0',
 *   type: 'utility',
 *   hooks: {
 *     onDecode(messages, ctx) {
 *       ctx.log.info('decoded', { count: messages.length });
 *     }
 *   }
 * };
 * ```
 *
 * @example
 * ```ts
 * // TypeScript with full type checking (high ceiling):
 * import type { PluginDefinition } from '@tx5dr/plugin-api';
 *
 * const plugin: PluginDefinition = {
 *   name: 'my-plugin',
 *   version: '1.0.0',
 *   type: 'strategy',
 *   settings: {
 *     maxRetries: { type: 'number', default: 3, label: 'Max Retries' },
 *   },
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
 * export default plugin;
 * ```
 */
export interface PluginDefinition {
  /** Unique plugin name (used as identifier). */
  name: string;

  /** Semantic version string. */
  version: string;

  /**
   * Plugin type.
   * - 'strategy': Mutually exclusive per operator. Only one can be active.
   * - 'utility': Stackable. Multiple can be active simultaneously.
   */
  type: PluginType;

  /** Human-readable description. */
  description?: string;

  /** Permissions required by this plugin. */
  permissions?: PluginPermission[];

  /**
   * Declarative settings.
   * The framework automatically generates a settings UI from these descriptors.
   * Values are available at runtime via `ctx.config`.
   */
  settings?: Record<string, PluginSettingDescriptor>;

  /**
   * Quick action buttons shown in the operator panel.
   * Clicking triggers `hooks.onUserAction(actionId, payload, ctx)`.
   */
  quickActions?: PluginQuickAction[];

  /**
   * Operator-scope settings surfaced in the top-right automation quick panel.
   */
  quickSettings?: PluginQuickSetting[];

  /**
   * Panels for data display.
   * The framework provides built-in renderers (table, key-value, chart, log).
   * Push data to panels via `ctx.ui.send(panelId, data)`.
   */
  panels?: PluginPanelDescriptor[];

  /**
   * Storage configuration.
   * Declare which scopes ('global', 'operator') this plugin needs.
   */
  storage?: { scopes: ('global' | 'operator')[] };

  /**
   * Strategy runtime factory.
   * Required for `type: 'strategy'`, forbidden for `type: 'utility'`.
   */
  createStrategyRuntime?(ctx: PluginContext): StrategyRuntime;

  /**
   * Called when the plugin is loaded by the plugin subsystem.
   * Use for initialization.
   */
  onLoad?(ctx: PluginContext): void | Promise<void>;

  /**
   * Called when the plugin is unloaded by the plugin subsystem.
   * Use for cleanup. Timers are automatically cleared.
   */
  onUnload?(ctx: PluginContext): void | Promise<void>;

  /** Hook implementations. */
  hooks?: PluginHooks;
}
