import { AsyncLocalStorage } from 'node:async_hooks';
import type { RuntimePluginContext } from '@tx5dr/plugin-api';
import type { PluginInstance } from './types.js';

export class PluginInvocationExpiredError extends Error {
  readonly code = 'PLUGIN_INVOCATION_EXPIRED';

  constructor(message = 'Plugin invocation is no longer allowed to perform host operations') {
    super(message);
    this.name = 'PluginInvocationExpiredError';
  }
}

interface InvocationState {
  invocationId: number;
  instanceGeneration: number;
  pluginName: string;
  operation: string;
  controller: AbortController;
  active: boolean;
  allowedContextRoots?: ReadonlySet<keyof RuntimePluginContext>;
}

interface InvocationOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  abortGraceMs?: number;
  drainOnExternalAbortMs?: number;
  allowedContextRoots?: ReadonlySet<keyof RuntimePluginContext>;
}

export interface HungPluginInvocation {
  instance: PluginInstance;
  invocationId: number;
  operation: string;
  elapsedAfterAbortMs: number;
}

export interface CurrentPluginInvocation {
  invocationId: number;
  instanceGeneration: number;
  signal: AbortSignal;
}

const PROTECTED_CONTEXT_KEYS = new Set<keyof RuntimePluginContext>([
  'updateConfig',
  'store',
  'timers',
  'operator',
  'operatorCommands',
  'radio',
  'radioCapabilities',
  'radioCommands',
  'radioTunerCommands',
  'radioPower',
  'radioPowerCommands',
  'logbook',
  'ui',
  'files',
  'settings',
  'network',
  'eventBus',
  'logbookSync',
  'fetch',
  'hostDependencies',
]);

/** Revokes host capabilities when a hook/runtime continuation outlives its invocation. */
export class PluginInvocationGuard {
  private readonly storage = new AsyncLocalStorage<InvocationState>();
  private nextInvocationId = 0;
  private readonly activeByInstance = new Map<number, Set<InvocationState>>();
  private readonly proxyCacheByInstance = new WeakMap<
    PluginInstance,
    WeakMap<object, Map<string, object>>
  >();

  constructor(
    private readonly onHungInvocation?: (details: HungPluginInvocation) => void,
  ) {}

  wrapContext(context: RuntimePluginContext, instance: PluginInstance): RuntimePluginContext {
    const cached = this.getCachedProxy(instance, context, '__context__');
    if (cached) return cached as RuntimePluginContext;

    const proxy = new Proxy(context, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver);
        if (!PROTECTED_CONTEXT_KEYS.has(property as keyof RuntimePluginContext) || value == null) {
          return value;
        }
        return this.wrapProtectedValue(value, instance, property as keyof RuntimePluginContext);
      },
      getOwnPropertyDescriptor: (target, property) => this.wrapProtectedDescriptor(
        Reflect.getOwnPropertyDescriptor(target, property),
        instance,
        property as keyof RuntimePluginContext,
      ),
    });
    this.cacheProxy(instance, context, '__context__', proxy);
    return proxy;
  }

  async invoke<T>(
    instance: PluginInstance,
    operation: string,
    callback: (signal: AbortSignal) => T | Promise<T>,
    options: InvocationOptions = {},
  ): Promise<T> {
    const state: InvocationState = {
      invocationId: ++this.nextInvocationId,
      instanceGeneration: instance.generation,
      pluginName: instance.plugin.definition.name,
      operation,
      controller: new AbortController(),
      active: true,
      allowedContextRoots: options.allowedContextRoots,
    };
    const active = this.activeByInstance.get(instance.generation) ?? new Set<InvocationState>();
    active.add(state);
    this.activeByInstance.set(instance.generation, active);

    let timeout: NodeJS.Timeout | undefined;
    let abortWatchdog: NodeJS.Timeout | undefined;
    let removeExternalAbort: (() => void) | undefined;
    let executionSettled = false;
    const revoke = (reason: unknown) => {
      if (!state.active) return;
      state.active = false;
      state.controller.abort(reason);
      const abortGraceMs = options.abortGraceMs ?? 1_000;
      if (!executionSettled && this.onHungInvocation && abortGraceMs >= 0) {
        abortWatchdog = setTimeout(() => {
          if (!executionSettled) {
            this.onHungInvocation?.({
              instance,
              invocationId: state.invocationId,
              operation,
              elapsedAfterAbortMs: abortGraceMs,
            });
          }
        }, abortGraceMs);
      }
    };
    if (options.signal) {
      const onAbort = () => revoke(options.signal?.reason ?? 'external invocation abort');
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true });
        removeExternalAbort = () => options.signal?.removeEventListener('abort', onAbort);
      }
    }

    try {
      const execution = this.storage.run(state, async () => callback(state.controller.signal));
      void execution.finally(() => {
        executionSettled = true;
        if (abortWatchdog) clearTimeout(abortWatchdog);
      }).catch(() => undefined);
      const revoked = new Promise<never>((_, reject) => {
        state.controller.signal.addEventListener('abort', () => {
          const rejectRevoked = () => reject(state.controller.signal.reason instanceof Error
            ? state.controller.signal.reason
            : new PluginInvocationExpiredError(String(state.controller.signal.reason ?? 'Plugin invocation revoked')));
          if (options.signal?.aborted && options.drainOnExternalAbortMs !== undefined) {
            setTimeout(rejectRevoked, options.drainOnExternalAbortMs);
          } else {
            rejectRevoked();
          }
        }, { once: true });
      });
      if (options.timeoutMs === undefined) {
        return await Promise.race([execution, revoked]);
      }

      const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          const error = new PluginInvocationExpiredError(
            `${state.pluginName} ${operation} timed out after ${options.timeoutMs}ms`,
          );
          revoke(error);
          reject(error);
        }, options.timeoutMs);
      });
      return await Promise.race([execution, revoked, timeoutPromise]);
    } finally {
      if (timeout) clearTimeout(timeout);
      removeExternalAbort?.();
      revoke('plugin invocation completed');
      active.delete(state);
      if (active.size === 0) this.activeByInstance.delete(instance.generation);
    }
  }

  invokeSync<T>(instance: PluginInstance, operation: string, callback: () => T): T {
    const state: InvocationState = {
      invocationId: ++this.nextInvocationId,
      instanceGeneration: instance.generation,
      pluginName: instance.plugin.definition.name,
      operation,
      controller: new AbortController(),
      active: true,
    };
    const active = this.activeByInstance.get(instance.generation) ?? new Set<InvocationState>();
    active.add(state);
    this.activeByInstance.set(instance.generation, active);
    try {
      const result = this.storage.run(state, callback);
      if (result instanceof Promise) {
        throw new Error(`Plugin invocation ${operation} unexpectedly returned a Promise from a synchronous host entry point`);
      }
      return result;
    } finally {
      state.active = false;
      state.controller.abort('plugin invocation completed');
      active.delete(state);
      if (active.size === 0) this.activeByInstance.delete(instance.generation);
    }
  }

  revokeInstance(instance: PluginInstance, reason: string): void {
    for (const state of this.activeByInstance.get(instance.generation) ?? []) {
      state.active = false;
      state.controller.abort(reason);
    }
    this.activeByInstance.delete(instance.generation);
  }

  assertCurrent(instance: PluginInstance, root?: keyof RuntimePluginContext): void {
    const state = this.storage.getStore();
    if (!state
        || !state.active
        || state.controller.signal.aborted
        || state.instanceGeneration !== instance.generation) {
      throw new PluginInvocationExpiredError();
    }
    if (root && state.allowedContextRoots && !state.allowedContextRoots.has(root)) {
      throw new PluginInvocationExpiredError(
        `Plugin invocation cannot use '${String(root)}' during ${state.operation}`,
      );
    }
  }

  captureCurrent(instance: PluginInstance): CurrentPluginInvocation {
    this.assertCurrent(instance);
    const state = this.storage.getStore()!;
    return {
      invocationId: state.invocationId,
      instanceGeneration: state.instanceGeneration,
      signal: state.controller.signal,
    };
  }

  assertCaptured(instance: PluginInstance, invocation: CurrentPluginInvocation): void {
    this.assertCurrent(instance);
    const state = this.storage.getStore()!;
    if (state.invocationId !== invocation.invocationId
        || state.instanceGeneration !== invocation.instanceGeneration
        || invocation.signal.aborted) {
      throw new PluginInvocationExpiredError('Plugin invocation-scoped capability has expired');
    }
  }

  private wrapProtectedValue<T>(
    value: T,
    instance: PluginInstance,
    root: keyof RuntimePluginContext,
  ): T {
    if ((typeof value !== 'object' || value === null) && typeof value !== 'function') {
      return value;
    }
    if (typeof value === 'function') {
      return ((...args: unknown[]) => {
        this.assertCurrent(instance, root);
        return this.wrapProtectedResult(
          Reflect.apply(value as (...values: unknown[]) => unknown, undefined, args),
          instance,
          root,
        );
      }) as T;
    }

    const object = value as object;
    const cached = this.getCachedProxy(instance, object, String(root));
    if (cached) return cached as T;
    const proxy = new Proxy(object, {
      get: (target, property, receiver) => {
        this.assertCurrent(instance, root);
        const child = Reflect.get(target, property, receiver);
        if (typeof child === 'function') {
          return (...args: unknown[]) => {
            this.assertCurrent(instance, root);
            const result = Reflect.apply(child, target, args);
            return this.wrapProtectedResult(result, instance, root);
          };
        }
        if (child && typeof child === 'object') {
          return this.wrapProtectedValue(child, instance, root);
        }
        return child;
      },
      getOwnPropertyDescriptor: (target, property) => this.wrapProtectedDescriptor(
        Reflect.getOwnPropertyDescriptor(target, property),
        instance,
        root,
      ),
    });
    this.cacheProxy(instance, object, String(root), proxy);
    return proxy as T;
  }

  private wrapProtectedResult<T>(
    result: T,
    instance: PluginInstance,
    root: keyof RuntimePluginContext,
  ): T {
    if (result instanceof Promise) {
      return result.then((value) => (
        value && (typeof value === 'object' || typeof value === 'function')
          ? this.wrapProtectedValue(value, instance, root)
          : value
      )) as T;
    }
    if (result && (typeof result === 'object' || typeof result === 'function')) {
      return this.wrapProtectedValue(result, instance, root);
    }
    return result;
  }

  private wrapProtectedDescriptor(
    descriptor: PropertyDescriptor | undefined,
    instance: PluginInstance,
    root: keyof RuntimePluginContext,
  ): PropertyDescriptor | undefined {
    if (!descriptor) return descriptor;
    // Proxy invariants require immutable descriptors to be reported verbatim.
    // Sensitive command ports are intentionally left configurable on their
    // host-owned wrapper objects so they still pass through the guarded path.
    if (descriptor.configurable === false
        && ('value' in descriptor ? descriptor.writable === false : true)) {
      return descriptor;
    }
    const wrapped = { ...descriptor };
    if ('value' in wrapped) {
      wrapped.value = this.wrapProtectedValue(wrapped.value, instance, root);
    }
    if (wrapped.get) {
      const getter = wrapped.get;
      wrapped.get = () => {
        this.assertCurrent(instance, root);
        return this.wrapProtectedResult(getter(), instance, root);
      };
    }
    if (wrapped.set) {
      const setter = wrapped.set;
      wrapped.set = (value) => {
        this.assertCurrent(instance, root);
        setter(value);
      };
    }
    return wrapped;
  }

  private getCachedProxy(
    instance: PluginInstance,
    target: object,
    root: string,
  ): object | undefined {
    return this.proxyCacheByInstance.get(instance)?.get(target)?.get(root);
  }

  private cacheProxy(
    instance: PluginInstance,
    target: object,
    root: string,
    proxy: object,
  ): void {
    let targets = this.proxyCacheByInstance.get(instance);
    if (!targets) {
      targets = new WeakMap<object, Map<string, object>>();
      this.proxyCacheByInstance.set(instance, targets);
    }
    const roots = targets.get(target) ?? new Map<string, object>();
    roots.set(root, proxy);
    targets.set(target, roots);
  }
}
