import type { ParsedFT8Message } from '@tx5dr/contracts';
import { isUndecodedCallsignPlaceholder } from '@tx5dr/core';
import type {
  AutoCallExecutionPlan,
  AutoCallExecutionRequest,
  AutoCallProposal,
  RuntimePluginContext,
  PluginHooks,
  ScoredCandidate,
} from '@tx5dr/plugin-api';
import type { PluginInstance } from './types.js';
import { PluginErrorTracker } from './PluginErrorTracker.js';
import { createLogger } from '../utils/logger.js';
import { PluginInvocationExpiredError, PluginInvocationGuard } from './PluginInvocationGuard.js';
import { snapshotPluginData } from './plugin-data-boundary.js';

const logger = createLogger('PluginHookDispatcher');

const DECISION_HOOK_TIMEOUT_MS = 200;
// Observation hooks may legitimately flush network telemetry. They remain
// revocable, but their I/O must not inherit the decision-path latency budget.
const BROADCAST_HOOK_TIMEOUT_MS = 5_000;

function isExpectedInvocationCancellation(error: unknown): boolean {
  return error instanceof PluginInvocationExpiredError
    || (error instanceof Error && error.message.startsWith('PLUGIN_INVOCATION_EXPIRED:'));
}

/** Extracts the non-undefined hook function type for a given hook name. */
type HookFn<K extends keyof PluginHooks> = NonNullable<PluginHooks[K]>;

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
    private readonly invocationGuard = new PluginInvocationGuard(),
  ) {
    this.errorTracker = new PluginErrorTracker(onAutoDisable);
  }

  // ===== Pipeline hook: onFilterCandidates =====

  async dispatchAutoCallCandidates(
    operatorId: string,
    slotInfo: import('@tx5dr/contracts').SlotInfo,
    messages: ParsedFT8Message[],
    getCtx: (instance: PluginInstance) => RuntimePluginContext,
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
        const proposal = await this.invocationGuard.invokeData(
          instance,
          'onAutoCallCandidate',
          'structured',
          () => hook(
            snapshotPluginData(slotInfo, 'structured'),
            snapshotPluginData(messages, 'structured'),
            ctx as never,
          ),
          { timeoutMs: DECISION_HOOK_TIMEOUT_MS },
        );

        if (proposal == null) {
          this.errorTracker.resetErrors(instance, 'onAutoCallCandidate');
          continue;
        }

        if (typeof proposal.callsign !== 'string'
            || proposal.callsign.trim().length === 0
            || isUndecodedCallsignPlaceholder(proposal.callsign)) {
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
    getCtx: (instance: PluginInstance) => RuntimePluginContext,
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
        const output = await this.invocationGuard.invokeData(
          instance,
          'onConfigureAutoCallExecution',
          'structured',
          () => hook(
            snapshotPluginData(request, 'structured'),
            snapshotPluginData(plan, 'structured'),
            ctx as never,
          ),
          { timeoutMs: DECISION_HOOK_TIMEOUT_MS },
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
    getCtx: (instance: PluginInstance) => RuntimePluginContext,
  ): Promise<ParsedFT8Message[]> {
    let result = candidates;
    for (const instance of this.getActiveInstances(operatorId)) {
      const hook = instance.plugin.definition.hooks?.onFilterCandidates;
      if (!hook || this.errorTracker.isDisabled(instance)) continue;
      try {
        const ctx = getCtx(instance);
        const output = await this.invocationGuard.invokeData(
          instance,
          'onFilterCandidates',
          'structured',
          () => hook(snapshotPluginData(result, 'structured'), ctx as never),
          { timeoutMs: DECISION_HOOK_TIMEOUT_MS },
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
    getCtx: (instance: PluginInstance) => RuntimePluginContext,
  ): Promise<ScoredCandidate[]> {
    let result = candidates;
    for (const instance of this.getActiveInstances(operatorId)) {
      const hook = instance.plugin.definition.hooks?.onScoreCandidates;
      if (!hook || this.errorTracker.isDisabled(instance)) continue;
      try {
        const ctx = getCtx(instance);
        const output = await this.invocationGuard.invokeData(
          instance,
          'onScoreCandidates',
          'structured',
          () => hook(snapshotPluginData(result, 'structured'), ctx as never),
          { timeoutMs: DECISION_HOOK_TIMEOUT_MS },
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

  async dispatchExclusive<K extends keyof PluginHooks, R>(
    operatorId: string,
    hookName: K,
    executor: (hook: HookFn<K>, ctx: RuntimePluginContext) => Promise<R>,
    getCtx: (instance: PluginInstance) => RuntimePluginContext,
  ): Promise<R | null> {
    const instance = this.getStrategyInstance(operatorId);
    if (!instance || this.errorTracker.isDisabled(instance)) return null;

    const hook = instance.plugin.definition.hooks?.[hookName] as HookFn<K> | undefined;
    if (!hook) return null;

    try {
      const ctx = getCtx(instance);
      const result = await this.invocationGuard.invokeData(
        instance,
        String(hookName),
        'structured',
        () => executor(hook, ctx),
        { timeoutMs: DECISION_HOOK_TIMEOUT_MS },
      );
      this.errorTracker.resetErrors(instance, hookName as string);
      return result;
    } catch (err) {
      this.errorTracker.recordError(instance, hookName as string, err);
      return null;
    }
  }

  // ===== Broadcast hook: all plugins =====

  async dispatchBroadcast<K extends keyof PluginHooks>(
    operatorId: string,
    hookName: K,
    executor: (hook: HookFn<K>, ctx: RuntimePluginContext) => void | Promise<void>,
    getCtx: (instance: PluginInstance) => RuntimePluginContext,
  ): Promise<void> {
    const instances = this.getActiveInstances(operatorId);
    await Promise.allSettled(
      instances.map(async instance => {
        if (this.errorTracker.isDisabled(instance)) return;
        const hook = instance.plugin.definition.hooks?.[hookName] as HookFn<K> | undefined;
        if (!hook) return;
        try {
          const ctx = getCtx(instance);
          await this.invocationGuard.invoke(
            instance,
            String(hookName),
            () => executor(hook, ctx),
            { timeoutMs: BROADCAST_HOOK_TIMEOUT_MS },
          );
          this.errorTracker.resetErrors(instance, hookName as string);
        } catch (err) {
          if (!isExpectedInvocationCancellation(err)) {
            this.errorTracker.recordError(instance, hookName as string, err);
          }
        }
      }),
    );
  }

  async dispatchInstance<K extends keyof PluginHooks, R>(
    instance: PluginInstance,
    hookName: K,
    executor: (hook: HookFn<K>, ctx: RuntimePluginContext) => R | Promise<R>,
  ): Promise<R | null> {
    if (instance.lifecycle !== 'active' || this.errorTracker.isDisabled(instance)) return null;
    const hook = instance.plugin.definition.hooks?.[hookName] as HookFn<K> | undefined;
    if (!hook) return null;
    try {
      const result = await this.invocationGuard.invoke(
        instance,
        String(hookName),
        () => executor(hook, instance.ctx),
        { timeoutMs: BROADCAST_HOOK_TIMEOUT_MS },
      );
      this.errorTracker.resetErrors(instance, String(hookName));
      return result;
    } catch (error) {
      if (!isExpectedInvocationCancellation(error)) {
        this.errorTracker.recordError(instance, String(hookName), error);
      }
      return null;
    }
  }
}
