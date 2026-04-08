import type { ParsedFT8Message } from '@tx5dr/contracts';
import type { ScoredCandidate, PluginContext } from '@tx5dr/plugin-api';
import type { LoadedPlugin, PluginInstance } from './types.js';
import { PluginErrorTracker } from './PluginErrorTracker.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('PluginHookDispatcher');

const HOOK_TIMEOUT_MS = 200;

function withTimeout<T>(promise: Promise<T> | T, ms: number): Promise<T> {
  if (!(promise instanceof Promise)) return Promise.resolve(promise);
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Hook timeout after ${ms}ms`)), ms)
    ),
  ]);
}

/**
 * Hook 分发引擎
 *
 * 三种 hook 类型：
 * - Pipeline: 链式传递，输出作为下一个插件的输入
 * - Exclusive: 仅活跃策略插件执行
 * - Broadcast: 所有活跃插件并发执行，fire-and-forget
 */
export class PluginHookDispatcher {
  private errorTracker: PluginErrorTracker;

  constructor(
    private getActiveInstances: (operatorId: string) => PluginInstance[],
    private getStrategyInstance: (operatorId: string) => PluginInstance | undefined,
    onAutoDisable: (pluginName: string, reason: string) => void,
  ) {
    this.errorTracker = new PluginErrorTracker(onAutoDisable);
  }

  // ===== Pipeline hook: onFilterCandidates =====

  async dispatchFilterCandidates(
    operatorId: string,
    candidates: ParsedFT8Message[],
    getCtx: (instance: PluginInstance) => PluginContext,
  ): Promise<ParsedFT8Message[]> {
    let result = candidates;
    for (const instance of this.getActiveInstances(operatorId)) {
      const hook = instance.plugin.definition.hooks?.onFilterCandidates;
      if (!hook || this.errorTracker.isDisabled(instance)) continue;
      try {
        const ctx = getCtx(instance);
        const output = await withTimeout(
          Promise.resolve(hook(result, ctx)),
          HOOK_TIMEOUT_MS,
        );
        if (!Array.isArray(output)) {
          logger.warn(`Plugin ${instance.plugin.definition.name} onFilterCandidates returned a non-array value, keeping previous candidates`);
          this.errorTracker.resetErrors(instance, 'onFilterCandidates');
          continue;
        }
        result = output;
        this.errorTracker.resetErrors(instance, 'onFilterCandidates');
      } catch (err) {
        this.errorTracker.recordError(instance, 'onFilterCandidates', err);
      }
    }
    return result;
  }

  // ===== Pipeline hook: onScoreCandidates =====

  async dispatchScoreCandidates(
    operatorId: string,
    candidates: ScoredCandidate[],
    getCtx: (instance: PluginInstance) => PluginContext,
  ): Promise<ScoredCandidate[]> {
    let result = candidates;
    for (const instance of this.getActiveInstances(operatorId)) {
      const hook = instance.plugin.definition.hooks?.onScoreCandidates;
      if (!hook || this.errorTracker.isDisabled(instance)) continue;
      try {
        const ctx = getCtx(instance);
        const output = await withTimeout(
          Promise.resolve(hook(result, ctx)),
          HOOK_TIMEOUT_MS,
        );
        if (Array.isArray(output)) {
          result = output;
        }
        this.errorTracker.resetErrors(instance, 'onScoreCandidates');
      } catch (err) {
        this.errorTracker.recordError(instance, 'onScoreCandidates', err);
      }
    }
    return result;
  }

  // ===== Exclusive hook: strategy plugin only =====

  async dispatchExclusive<R>(
    operatorId: string,
    hookName: keyof import('@tx5dr/plugin-api').PluginHooks,
    executor: (hook: (...args: unknown[]) => unknown, ctx: PluginContext) => Promise<R>,
    getCtx: (instance: PluginInstance) => PluginContext,
  ): Promise<R | null> {
    const instance = this.getStrategyInstance(operatorId);
    if (!instance || this.errorTracker.isDisabled(instance)) return null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hook = (instance.plugin.definition.hooks as any)?.[hookName];
    if (!hook) return null;

    try {
      const ctx = getCtx(instance);
      const result = await withTimeout(executor(hook, ctx), HOOK_TIMEOUT_MS);
      this.errorTracker.resetErrors(instance, hookName as string);
      return result;
    } catch (err) {
      this.errorTracker.recordError(instance, hookName as string, err);
      return null;
    }
  }

  // ===== Broadcast hook: all plugins =====

  async dispatchBroadcast(
    operatorId: string,
    hookName: keyof import('@tx5dr/plugin-api').PluginHooks,
    executor: (hook: (...args: unknown[]) => unknown, ctx: PluginContext) => void | Promise<void>,
    getCtx: (instance: PluginInstance) => PluginContext,
  ): Promise<void> {
    const instances = this.getActiveInstances(operatorId);
    await Promise.allSettled(
      instances.map(async instance => {
        if (this.errorTracker.isDisabled(instance)) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const hook = (instance.plugin.definition.hooks as any)?.[hookName];
        if (!hook) return;
        try {
          const ctx = getCtx(instance);
          await withTimeout(Promise.resolve(executor(hook, ctx)), HOOK_TIMEOUT_MS);
          this.errorTracker.resetErrors(instance, hookName as string);
        } catch (err) {
          this.errorTracker.recordError(instance, hookName as string, err);
        }
      }),
    );
  }
}
