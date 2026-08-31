import type { PluginPermission } from '@tx5dr/contracts';
import type { PluginCleanupContext, PluginContextFor, StrategyPluginContext } from '../../context.js';
import type { PluginDefinition } from '../../definition.js';
import { assertPluginApiCompatible, comparePluginApiVersions } from '../../compatibility.js';
import type { PluginHooks } from '../../hooks.js';
import {
  isQueuedStrategyRuntime,
  type QueuedStrategyRuntime,
  type StrategyRuntime,
} from '../../runtime.js';
import type { FT8ContestDefinition } from './FT8ContestDefinition.js';
import type { FT8ContestQso } from './FT8ContestModules.js';

export const FT8_CONTEST_MIN_PLUGIN_API_VERSION = '2.1.0';

export interface FT8RuntimeModule<TContest> {
  readonly id: string;
  create(contest: TContest, context: StrategyPluginContext): StrategyRuntime;
}

export type FT8ParallelRuntime = QueuedStrategyRuntime & Required<Pick<
  StrategyRuntime,
  'getTransmissions' | 'onTransmissionsCompleted'
>>;

export type FT8RuntimeFactory<TContest> = (
  contest: TContest,
  context: StrategyPluginContext,
) => StrategyRuntime;

export function defineFT8RuntimeModule<TContest>(
  module: FT8RuntimeModule<TContest>,
): FT8RuntimeModule<TContest> {
  return module;
}

export type ContestModuleCleanup = (
  context: PluginCleanupContext,
) => void | Promise<void>;

export interface ContestLifecycleModule<
  TContest,
  Permissions extends readonly PluginPermission[] = readonly [],
> {
  readonly id: string;
  setup(input: {
    contest: TContest;
    context: PluginContextFor<Permissions>;
    /** Stable owner used by modules that publish process-global events. */
    pluginName: string;
  }): void | ContestModuleCleanup | Promise<void | ContestModuleCleanup>;
}

/** Lifecycle module for versioned contest state. Storage mechanics stay module-owned. */
export interface ContestSessionModule<
  TContest,
  Permissions extends readonly PluginPermission[] = readonly [],
> extends ContestLifecycleModule<TContest, Permissions> {}

/** Lifecycle module for an optional contest page/workbench protocol. */
export interface ContestWorkbenchModule<
  TContest,
  Permissions extends readonly PluginPermission[] = readonly [],
> extends ContestLifecycleModule<TContest, Permissions> {}

export function defineContestSessionModule<
  TContest,
  Permissions extends readonly PluginPermission[] = readonly [],
>(
  module: ContestSessionModule<TContest, Permissions>,
): ContestSessionModule<TContest, Permissions> {
  return module;
}

export function defineContestWorkbenchModule<
  TContest,
  Permissions extends readonly PluginPermission[] = readonly [],
>(
  module: ContestWorkbenchModule<TContest, Permissions>,
): ContestWorkbenchModule<TContest, Permissions> {
  return module;
}

export interface ComposeFT8ContestPluginInput<
  TExchange,
  TQso extends FT8ContestQso<TExchange>,
  TSubmissionOptions,
  Permissions extends readonly PluginPermission[],
  SessionPermissions extends readonly PluginPermission[] = Permissions,
  WorkbenchPermissions extends readonly PluginPermission[] = Permissions,
> extends Omit<
    PluginDefinition<Permissions>,
    'apiVersion' | 'type' | 'createStrategyRuntime' | 'onLoad' | 'onUnload' | 'hooks'
  > {
  contest: FT8ContestDefinition<TExchange, TQso, TSubmissionOptions>;
  runtime:
    | FT8RuntimeModule<FT8ContestDefinition<TExchange, TQso, TSubmissionOptions>>
    | FT8RuntimeFactory<FT8ContestDefinition<TExchange, TQso, TSubmissionOptions>>;
  session?: ContestSessionModule<
    FT8ContestDefinition<TExchange, TQso, TSubmissionOptions>,
    SessionPermissions
  > & RequiredPermissionsAvailable<Permissions, SessionPermissions>;
  workbench?: ContestWorkbenchModule<
    FT8ContestDefinition<TExchange, TQso, TSubmissionOptions>,
    WorkbenchPermissions
  > & RequiredPermissionsAvailable<Permissions, WorkbenchPermissions>;
  hooks?: PluginHooks<Permissions>;
  onLoad?(context: PluginContextFor<Permissions>): void | Promise<void>;
  onUnload?(context: PluginCleanupContext): void | Promise<void>;
}

type RequiredPermissionsAvailable<
  Actual extends readonly PluginPermission[],
  Required extends readonly PluginPermission[],
> = Exclude<Required[number], Actual[number]> extends never
  ? unknown
  : { readonly missingPluginPermissions: Exclude<Required[number], Actual[number]> };

function runtimeFactory<TContest>(
  runtime: FT8RuntimeModule<TContest> | FT8RuntimeFactory<TContest>,
): FT8RuntimeFactory<TContest> {
  return typeof runtime === 'function' ? runtime : (contest, context) => runtime.create(contest, context);
}

function assertContestRuntimeFeatures(
  runtime: StrategyRuntime,
  features: NonNullable<PluginDefinition['strategyFeatures']>,
): void {
  if (features.targetQueue === 1 && !isQueuedStrategyRuntime(runtime)) {
    throw new Error('contest_runtime_target_queue_requires_queued_strategy');
  }
  if (features.parallelTargetQueue === 1
    && (typeof runtime.getTransmissions !== 'function'
      || typeof runtime.onTransmissionsCompleted !== 'function')) {
    throw new Error('contest_runtime_parallel_queue_requires_parallel_runtime');
  }
}

/**
 * Convenience assembler for an operator-scoped FT8 strategy plugin.
 * Authors can skip it and wire the same public modules through definePlugin().
 */
export function composeFT8ContestPlugin<
  TExchange,
  TQso extends FT8ContestQso<TExchange>,
  TSubmissionOptions = void,
  const Permissions extends readonly PluginPermission[] = readonly [],
  SessionPermissions extends readonly PluginPermission[] = Permissions,
  WorkbenchPermissions extends readonly PluginPermission[] = Permissions,
>(
  input: ComposeFT8ContestPluginInput<
    TExchange,
    TQso,
    TSubmissionOptions,
    Permissions,
    SessionPermissions,
    WorkbenchPermissions
  >,
): PluginDefinition<Permissions> {
  const {
    contest,
    runtime,
    session,
    workbench,
    hooks,
    onLoad,
    onUnload,
    strategyFeatures,
    minPluginApiVersion: declaredMinPluginApiVersion,
    ...metadata
  } = input;
  if (declaredMinPluginApiVersion
      && (comparePluginApiVersions(
        declaredMinPluginApiVersion,
        FT8_CONTEST_MIN_PLUGIN_API_VERSION,
      ) ?? -1) < 0) {
    throw new Error(
      `contest_plugin_api_floor_too_low:${declaredMinPluginApiVersion}`,
    );
  }
  const minPluginApiVersion = declaredMinPluginApiVersion
    ?? FT8_CONTEST_MIN_PLUGIN_API_VERSION;
  const createRuntime = runtimeFactory(runtime);
  const cleanups = new Map<string, ContestModuleCleanup[]>();
  const requiredOperatingFeatures = {
    ...(contest.operating.humanInitiation === 'required' ? { manualInitiation: 1 as const } : {}),
    maxConcurrentStreams: contest.operating.maxConcurrentQsos,
    maxSimultaneousSignals: contest.operating.maxSimultaneousSignals,
  };
  for (const key of [
    'manualInitiation',
    'maxConcurrentStreams',
    'maxSimultaneousSignals',
  ] as const) {
    if (requiredOperatingFeatures[key] !== undefined
        && strategyFeatures?.[key] !== undefined
        && strategyFeatures[key] !== requiredOperatingFeatures[key]) {
      throw new Error(`contest_operating_strategy_feature_conflict:${key}`);
    }
  }
  const mergedFeatures: NonNullable<PluginDefinition<Permissions>['strategyFeatures']> = {
    ...strategyFeatures,
    ...requiredOperatingFeatures,
  };
  if (contest.operating.maxConcurrentQsos > 1) {
    mergedFeatures.targetQueue = 1;
    mergedFeatures.parallelTargetQueue = 1;
  }
  if (mergedFeatures.parallelTargetQueue === 1 && mergedFeatures.targetQueue !== 1) {
    throw new Error('contest_operating_parallel_queue_requires_target_queue');
  }
  if (mergedFeatures.queueActivation !== undefined && mergedFeatures.targetQueue !== 1) {
    throw new Error('contest_operating_queue_activation_requires_target_queue');
  }

  return {
    ...metadata,
    apiVersion: 2,
    minPluginApiVersion,
    type: 'strategy',
    strategyFeatures: mergedFeatures,
    hooks,
    createStrategyRuntime(context) {
      assertPluginApiCompatible(minPluginApiVersion, metadata.name, context.pluginApiVersion);
      const runtime = createRuntime(contest, context);
      assertContestRuntimeFeatures(runtime, mergedFeatures);
      return runtime;
    },
    async onLoad(context) {
      const instanceCleanups: ContestModuleCleanup[] = [];
      cleanups.set(context.operator.id, instanceCleanups);
      try {
        if (session) {
          const cleanup = await session.setup({
            contest,
            context: context as unknown as PluginContextFor<SessionPermissions>,
            pluginName: metadata.name,
          });
          if (cleanup) instanceCleanups.push(cleanup);
        }
        if (workbench) {
          const cleanup = await workbench.setup({
            contest,
            context: context as unknown as PluginContextFor<WorkbenchPermissions>,
            pluginName: metadata.name,
          });
          if (cleanup) instanceCleanups.push(cleanup);
        }
        await onLoad?.(context);
      } catch (error) {
        cleanups.delete(context.operator.id);
        for (const cleanup of instanceCleanups.reverse()) await cleanup(context);
        throw error;
      }
    },
    async onUnload(context) {
      let firstError: unknown;
      try {
        await onUnload?.(context);
      } catch (error) {
        firstError = error;
      }
      const instanceCleanups = cleanups.get(context.operator.id) ?? [];
      cleanups.delete(context.operator.id);
      for (const cleanup of instanceCleanups.reverse()) {
        try {
          await cleanup(context);
        } catch (error) {
          firstError ??= error;
        }
      }
      if (firstError) throw firstError;
    },
  };
}
