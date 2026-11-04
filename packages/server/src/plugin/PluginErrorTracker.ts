import { createLogger } from '../utils/logger.js';
import type { PluginInstance } from './types.js';
import type { PluginAutoDisableInfo, PluginErrorRecord } from '@tx5dr/contracts';
import { createPluginErrorRecord, recordPluginAutoDisable } from './plugin-diagnostics.js';

const logger = createLogger('PluginErrorTracker');

const MAX_CONSECUTIVE_ERRORS = 5;

/**
 * 插件错误追踪器
 * 记录每个插件每个 hook 的连续错误数
 * 连续错误达到阈值后触发自动禁用回调
 */
export class PluginErrorTracker {
  private readonly history = new WeakMap<PluginInstance, Map<string, PluginErrorRecord[]>>();

  constructor(
    private readonly onAutoDisable: (pluginName: string, reason: string, info: PluginAutoDisableInfo) => void,
    private readonly onError?: (instance: PluginInstance, entry: PluginErrorRecord, count: number) => void,
  ) {}

  recordError(instance: PluginInstance, hookName: string, error: unknown): void {
    if (instance.autoDisabled) return;
    const key = hookName;
    const current = instance.errorCounts.get(key) ?? 0;
    const next = current + 1;
    instance.errorCounts.set(key, next);

    const entry = createPluginErrorRecord(hookName, error);
    const errMsg = entry.message;
    instance.lastError = `[${hookName}] ${errMsg}`;
    const history = this.history.get(instance) ?? new Map<string, PluginErrorRecord[]>();
    const errors = [...(history.get(hookName) ?? []), entry].slice(-MAX_CONSECUTIVE_ERRORS);
    history.set(hookName, errors);
    this.history.set(instance, history);
    this.onError?.(instance, entry, next);

    logger.warn(`Plugin error: plugin=${instance.plugin.definition.name}, hook=${hookName}, count=${next}`, { error: errMsg });

    if (next >= MAX_CONSECUTIVE_ERRORS) {
      logger.error(`Plugin auto-disabled: plugin=${instance.plugin.definition.name} exceeded max errors (${MAX_CONSECUTIVE_ERRORS}) in hook ${hookName}`);
      const info = recordPluginAutoDisable(instance, 'consecutive-errors', entry, errors);
      this.onAutoDisable(instance.plugin.definition.name, instance.lastError!, info);
    }
  }

  resetErrors(instance: PluginInstance, hookName?: string): void {
    // A successful callback already in flight must not revive a disabled instance.
    if (instance.autoDisabled) return;
    if (hookName) {
      instance.errorCounts.delete(hookName);
      this.history.get(instance)?.delete(hookName);
    } else {
      instance.errorCounts.clear();
      this.history.delete(instance);
    }
    instance.lastError = undefined;
  }

  isDisabled(instance: PluginInstance): boolean {
    return instance.autoDisabled;
  }
}
