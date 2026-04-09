import type { ParsedFT8Message } from '@tx5dr/contracts';
import type {
  AutoCallExecutionPlan,
  AutoCallExecutionRequest,
  AutoCallProposal,
  PluginContext,
  ScoredCandidate,
} from '@tx5dr/plugin-api';
import type { PluginInstance } from './types.js';
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

export interface AutoCallProposalResult {
  pluginName: string;
  proposal: AutoCallProposal;
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

  async dispatchAutoCallCandidates(
    operatorId: string,
    slotInfo: import('@tx5dr/contracts').SlotInfo,
    messages: ParsedFT8Message[],
    getCtx: (instance: PluginInstance) => PluginContext,
  ): Promise<AutoCallProposalResult[]> {
    const proposals: AutoCallProposalResult[] = [];

    for (const instance of this.getActiveInstances(operatorId)) {
      if (instance.plugin.definition.type !== 'utility') {
        continue;
      }

      const hook = instance.plugin.definition.hooks?.onAutoCallCandidate;
      if (!hook || this.errorTracker.isDisabled(instance)) {
        continue;
      }

      try {
        const ctx = getCtx(instance);
        const proposal = await withTimeout(
          Promise.resolve(hook(slotInfo, messages, ctx)),
          HOOK_TIMEOUT_MS,
        );

        if (proposal == null) {
          this.errorTracker.resetErrors(instance, 'onAutoCallCandidate');
          continue;
        }

        if (typeof proposal.callsign !== 'string' || proposal.callsign.trim().length === 0) {
          logger.warn(`Plugin ${instance.plugin.definition.name} onAutoCallCandidate returned an invalid callsign, skipping proposal`);
          this.errorTracker.resetErrors(instance, 'onAutoCallCandidate');
          continue;
        }

        proposals.push({
          pluginName: instance.plugin.definition.name,
          proposal: {
            ...proposal,
            callsign: proposal.callsign.trim().toUpperCase(),
          },
        });
        this.errorTracker.resetErrors(instance, 'onAutoCallCandidate');
      } catch (err) {
        this.errorTracker.recordError(instance, 'onAutoCallCandidate', err);
      }
    }

    return proposals;
  }

  async dispatchAutoCallExecutionPlan(
    operatorId: string,
    request: AutoCallExecutionRequest,
    initialPlan: AutoCallExecutionPlan,
    getCtx: (instance: PluginInstance) => PluginContext,
  ): Promise<AutoCallExecutionPlan> {
    let plan = initialPlan;

    for (const instance of this.getActiveInstances(operatorId)) {
      if (instance.plugin.definition.type !== 'utility') {
        continue;
      }

      const hook = instance.plugin.definition.hooks?.onConfigureAutoCallExecution;
      if (!hook || this.errorTracker.isDisabled(instance)) {
        continue;
      }

      try {
        const ctx = getCtx(instance);
        const output = await withTimeout(
          Promise.resolve(hook(request, plan, ctx)),
          HOOK_TIMEOUT_MS,
        );

        if (output == null) {
          this.errorTracker.resetErrors(instance, 'onConfigureAutoCallExecution');
          continue;
        }

        if (typeof output !== 'object' || Array.isArray(output)) {
          logger.warn(`Plugin ${instance.plugin.definition.name} onConfigureAutoCallExecution returned an invalid plan, keeping previous execution plan`);
          this.errorTracker.resetErrors(instance, 'onConfigureAutoCallExecution');
          continue;
        }

        plan = output;
        this.errorTracker.resetErrors(instance, 'onConfigureAutoCallExecution');
      } catch (err) {
        this.errorTracker.recordError(instance, 'onConfigureAutoCallExecution', err);
      }
    }

    return plan;
  }

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
