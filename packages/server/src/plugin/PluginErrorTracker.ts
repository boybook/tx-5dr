import { createLogger } from '../utils/logger.js';
import type { PluginInstance } from './types.js';

const logger = createLogger('PluginErrorTracker');

const MAX_CONSECUTIVE_ERRORS = 5;

/**
 * 插件错误追踪器
 * 记录每个插件每个 hook 的连续错误数
 * 连续错误达到阈值后触发自动禁用回调
 */
export class PluginErrorTracker {
  private onAutoDisable: (pluginName: string, reason: string) => void;

  constructor(onAutoDisable: (pluginName: string, reason: string) => void) {
    this.onAutoDisable = onAutoDisable;
  }

  recordError(instance: PluginInstance, hookName: string, error: unknown): void {
    const key = hookName;
    const current = instance.errorCounts.get(key) ?? 0;
    const next = current + 1;
    instance.errorCounts.set(key, next);

    const errMsg = error instanceof Error ? error.message : String(error);
    instance.lastError = `[${hookName}] ${errMsg}`;

    logger.warn(`Plugin error: plugin=${instance.plugin.definition.name}, hook=${hookName}, count=${next}`, { error: errMsg });

    if (next >= MAX_CONSECUTIVE_ERRORS) {
      logger.error(`Plugin auto-disabled: plugin=${instance.plugin.definition.name} exceeded max errors (${MAX_CONSECUTIVE_ERRORS}) in hook ${hookName}`);
      instance.autoDisabled = true;
      this.onAutoDisable(instance.plugin.definition.name, instance.lastError);
    }
  }

  resetErrors(instance: PluginInstance, hookName?: string): void {
    if (hookName) {
      instance.errorCounts.delete(hookName);
    } else {
      instance.errorCounts.clear();
    }
    instance.autoDisabled = false;
    instance.lastError = undefined;
  }

  isDisabled(instance: PluginInstance): boolean {
    return instance.autoDisabled;
  }
}
