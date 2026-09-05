import type { PluginPermission } from '@tx5dr/contracts';
import type { PluginCleanupContext, PluginContextFor, StrategyPluginContext } from '../../context.js';
import type { PluginDefinition } from '../../definition.js';
import { assertPluginApiCompatible, comparePluginApiVersions } from '../../compatibility.js';
import type { PluginHooks } from '../../hooks.js';
import {
  isQueuedStrategyRuntime,
  type QueuedStrategyRuntime,
  type StrategyMessagePresentationProjection,
  type StrategyQSOCompletionEffect,
  type StrategyRuntime,
} from '../../runtime.js';
import type { ContestLogbookModule } from './ContestLogbook.js';
import type { VersionedContestSession } from './ContestSessionRepository.js';
import type { FT8ContestDefinition } from './FT8ContestDefinition.js';
import type { FT8ContestQso } from './FT8ContestModules.js';

export const FT8_CONTEST_MIN_PLUGIN_API_VERSION = '2.5.0';

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
  logbook?: ContestLogbookModule<
    FT8ContestDefinition<TExchange, TQso, TSubmissionOptions>,
    VersionedContestSession,
    Permissions
  >;
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

function contestRuntimeContext(
  context: StrategyPluginContext,
  getMessagePresentation?: (operatorId: string) => StrategyMessagePresentationProjection | undefined,
): StrategyPluginContext {
  if (!getMessagePresentation) return context;
  return {
    ...context,
    operator: {
      ...context.operator,
      async hasWorkedCallsign(callsign, options) {
        const presentation = getMessagePresentation(context.operator.id);
        if (!presentation) return context.operator.hasWorkedCallsign(callsign, options);
        const normalizedCallsign = callsign.trim().toUpperCase();
        const currentBand = context.radio.band.trim().toUpperCase();
        return presentation.assignments.some((assignment) => (
          assignment.subject.trim().toUpperCase() === normalizedCallsign
            && (options?.anyBand === true || assignment.partition?.trim().toUpperCase() === currentBand)
        ));
      },
    },
  };
}

function decorateRuntime(
  runtime: StrategyRuntime,
  decorate: NonNullable<ContestLogbookModule<unknown, VersionedContestSession>['decorateCompletion']>,
  context: StrategyPluginContext,
  getMessagePresentation?: (operatorId: string) => StrategyMessagePresentationProjection | undefined,
): StrategyRuntime {
  return new Proxy(runtime, {
    get(target, property, receiver) {
      if (property === 'decide') {
        return async (...args: Parameters<StrategyRuntime['decide']>) => {
          const result = await target.decide(...args);
          const messagePresentation = getMessagePresentation?.(context.operator.id);
          const qsoCompletion = result.qsoCompletion
            ? decorate(result.qsoCompletion, context)
            : undefined;
          const qsoCompletions = result.qsoCompletions?.map((effect) => decorate(effect, context));
          return {
            ...result,
            snapshot: messagePresentation
              ? { ...result.snapshot, messagePresentation }
              : result.snapshot,
            ...(qsoCompletion ? { qsoCompletion } : {}),
            ...(qsoCompletions ? { qsoCompletions } : {}),
          };
        };
      }
      if (property === 'getSnapshot') {
        return () => {
          const snapshot = target.getSnapshot();
          const messagePresentation = getMessagePresentation?.(context.operator.id);
          return messagePresentation ? { ...snapshot, messagePresentation } : snapshot;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function mergeHooks<Permissions extends readonly PluginPermission[]>(
  hooks: Array<PluginHooks<Permissions> | undefined>,
): PluginHooks<Permissions> | undefined {
  const active = hooks.filter((hook): hook is PluginHooks<Permissions> => hook !== undefined);
  if (active.length === 0) return undefined;
  return {
    async onAutoCallCandidate(slotInfo, messages, ctx) {
      let proposal;
      for (const hook of active) {
        proposal = await hook.onAutoCallCandidate?.(slotInfo, messages, ctx) ?? proposal;
      }
      return proposal;
    },
    async onConfigureAutoCallExecution(request, plan, ctx) {
      let nextPlan = plan;
      for (const hook of active) {
        nextPlan = await hook.onConfigureAutoCallExecution?.(request, nextPlan, ctx) ?? nextPlan;
      }
      return nextPlan;
    },
    async onFilterCandidates(candidates, ctx) {
      let next = candidates;
      for (const hook of active) {
        next = await hook.onFilterCandidates?.(next, ctx) ?? next;
      }
      return next;
    },
    async onScoreCandidates(candidates, ctx) {
      let next = candidates;
      for (const hook of active) {
        next = await hook.onScoreCandidates?.(next, ctx) ?? next;
      }
      return next;
    },
    async onSlotStart(slotInfo, messages, ctx) {
      for (const hook of active) await hook.onSlotStart?.(slotInfo, messages, ctx);
    },
    async onSlotActivity(event, ctx) {
      for (const hook of active) await hook.onSlotActivity?.(event, ctx);
    },
    async onDecode(messages, ctx) {
      for (const hook of active) await hook.onDecode?.(messages, ctx);
    },
    async onFrequencyChange(state, ctx) {
      for (const hook of active) await hook.onFrequencyChange?.(state, ctx);
    },
    async onQSOStart(info, ctx) {
      for (const hook of active) await hook.onQSOStart?.(info, ctx);
    },
    async onQSOComplete(record, ctx) {
      for (const hook of active) await hook.onQSOComplete?.(record, ctx);
    },
    async onQSOFail(info, ctx) {
      for (const hook of active) await hook.onQSOFail?.(info, ctx);
    },
    async onTimer(timerId, ctx) {
      for (const hook of active) await hook.onTimer?.(timerId, ctx);
    },
    async onUserAction(actionId, payload, ctx) {
      for (const hook of active) await hook.onUserAction?.(actionId, payload, ctx);
    },
    async onConfigChange(changes, ctx) {
      for (const hook of active) await hook.onConfigChange?.(changes, ctx);
    },
  };
}

function mergeRecordMap<T extends Record<string, unknown> | undefined>(
  first: T,
  second: T,
): T {
  const merged = { ...(first ?? {}), ...(second ?? {}) };
  return (Object.keys(merged).length > 0 ? merged : undefined) as T;
}

function mergeArrayById<T extends { id: string }>(first?: readonly T[], second?: readonly T[]): T[] | undefined {
  const result: T[] = [];
  const index = new Map<string, number>();
  for (const item of [...first ?? [], ...second ?? []]) {
    const existing = index.get(item.id);
    if (existing === undefined) {
      index.set(item.id, result.length);
      result.push(item);
      continue;
    }
    result[existing] = item;
  }
  return result.length > 0 ? result : undefined;
}

function mergeQuickSettings(
  first?: readonly { settingKey: string }[],
  second?: readonly { settingKey: string }[],
): { settingKey: string }[] | undefined {
  const result: { settingKey: string }[] = [];
  const index = new Map<string, number>();
  for (const item of [...first ?? [], ...second ?? []]) {
    const existing = index.get(item.settingKey);
    if (existing === undefined) {
      index.set(item.settingKey, result.length);
      result.push(item);
      continue;
    }
    result[existing] = item;
  }
  return result.length > 0 ? result : undefined;
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
    logbook,
    hooks,
    settings,
    quickSettings,
    panels,
    ui,
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

  if (logbook && !metadata.permissions?.includes('logbook:session')) {
    throw new Error('contest_logbook_missing_permission:logbook:session');
  }
  if (logbook && !metadata.permissions?.includes('plugin:event-bus')) {
    throw new Error('contest_logbook_missing_permission:plugin:event-bus');
  }

  const mergedHooks = mergeHooks([logbook?.hooks, hooks]);
  const mergedSettings = mergeRecordMap(logbook?.settings, settings);
  const mergedQuickSettings = mergeQuickSettings(logbook?.quickSettings, quickSettings);
  const mergedPanels = mergeArrayById(logbook?.panels, panels);
  const mergedUi = logbook?.ui || ui
    ? {
        dir: ui?.dir ?? logbook?.ui?.dir,
        pages: mergeArrayById(logbook?.ui?.pages, ui?.pages),
      }
    : undefined;
  type Contest = FT8ContestDefinition<TExchange, TQso, TSubmissionOptions>;
  const mergedSession = (session ?? logbook?.session) as unknown as ContestSessionModule<Contest, SessionPermissions> | undefined;
  const mergedWorkbench = (workbench ?? logbook?.workbench) as unknown as ContestWorkbenchModule<Contest, WorkbenchPermissions> | undefined;

  return {
    ...metadata,
    apiVersion: 2,
    minPluginApiVersion,
    type: 'strategy',
    strategyFeatures: mergedFeatures,
    ...(mergedSettings ? { settings: mergedSettings } : {}),
    ...(mergedQuickSettings ? { quickSettings: mergedQuickSettings } : {}),
    ...(mergedPanels ? { panels: mergedPanels } : {}),
    ...(mergedUi ? { ui: mergedUi } : {}),
    hooks: mergedHooks,
    createStrategyRuntime(context) {
      assertPluginApiCompatible(minPluginApiVersion, metadata.name, context.pluginApiVersion);
      const runtime = createRuntime(
        contest,
        contestRuntimeContext(context, logbook?.getMessagePresentation),
      );
      assertContestRuntimeFeatures(runtime, mergedFeatures);
      if (!logbook?.decorateCompletion && !logbook?.getMessagePresentation) return runtime;
      const decorateCompletion = logbook.decorateCompletion
        ?? ((effect: StrategyQSOCompletionEffect) => effect);
      return decorateRuntime(runtime, decorateCompletion, context, logbook.getMessagePresentation);
    },
    async onLoad(context) {
      const instanceCleanups: ContestModuleCleanup[] = [];
      cleanups.set(context.operator.id, instanceCleanups);
      try {
        if (mergedSession) {
          const cleanup = await mergedSession.setup({
            contest,
            context: context as unknown as PluginContextFor<SessionPermissions>,
            pluginName: metadata.name,
          });
          if (cleanup) instanceCleanups.push(cleanup);
        }
        if (mergedWorkbench) {
          const cleanup = await mergedWorkbench.setup({
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
