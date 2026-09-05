import { AsyncLocalStorage } from 'node:async_hooks';
import type { RuntimePluginContext } from '@tx5dr/plugin-api';
import type { PluginInstance } from './types.js';
import {
  isPluginCapability,
  isDetachedPluginData,
  markPluginCapability,
  markPluginCapabilityTree,
  snapshotPluginData,
  PluginDataBoundaryError,
  type PluginDataSnapshotMode,
} from './plugin-data-boundary.js';

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
  'config',
  'updateConfig',
  'store',
  'timers',
  'operator',
  'operatorCommands',
  'radio',
  'band',
  'digitalMessagePreflight',
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
  'lifecycle',
]);
const EVERGREEN_CONTEXT_KEYS = new Set<keyof RuntimePluginContext>(['pluginApiVersion', 'log']);

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

    for (const property of Object.getOwnPropertyNames(context)) {
      const key = property as keyof RuntimePluginContext;
      if (!PROTECTED_CONTEXT_KEYS.has(key) && !EVERGREEN_CONTEXT_KEYS.has(key)) {
        throw new Error(`PLUGIN_CAPABILITY_POLICY_MISSING: unclassified context root '${property}'`);
      }
    }

    const proxy = new Proxy(context, {
      get: (target, property, _receiver) => {
        const protectedRoot = PROTECTED_CONTEXT_KEYS.has(property as keyof RuntimePluginContext);
        if (protectedRoot) {
          this.assertCurrent(instance, property as keyof RuntimePluginContext);
        }
        const value = Reflect.get(target, property, target);
        if (!protectedRoot || value == null) {
          return value;
        }
        if (property === 'config') {
          return snapshotPluginData(value, 'structured');
        }
        return this.wrapProtectedValue(value, instance, property as keyof RuntimePluginContext);
      },
      getOwnPropertyDescriptor: (target, property) => {
        const root = property as keyof RuntimePluginContext;
        if (!PROTECTED_CONTEXT_KEYS.has(root)) {
          return Reflect.getOwnPropertyDescriptor(target, property);
        }
        this.assertCurrent(instance, root);
        return this.wrapProtectedDescriptor(
          Reflect.getOwnPropertyDescriptor(target, property),
          instance,
          root,
        );
      },
      set: (_target, property) => this.rejectCapabilityMutation(
        instance,
        property as keyof RuntimePluginContext,
      ),
      defineProperty: (_target, property) => this.rejectCapabilityMutation(
        instance,
        property as keyof RuntimePluginContext,
      ),
      deleteProperty: (_target, property) => this.rejectCapabilityMutation(
        instance,
        property as keyof RuntimePluginContext,
      ),
      setPrototypeOf: () => this.rejectCapabilityMutation(instance),
      preventExtensions: () => this.rejectCapabilityMutation(instance),
    });
    markPluginCapability(context);
    markPluginCapability(proxy);
    this.cacheProxy(instance, context, '__context__', proxy);
    return proxy;
  }

  async invokeData<T>(
    instance: PluginInstance,
    operation: string,
    mode: PluginDataSnapshotMode,
    callback: (signal: AbortSignal) => T | Promise<T>,
    options: InvocationOptions = {},
  ): Promise<T> {
    return this.invoke(instance, operation, async (signal) => {
      this.assertCurrent(instance);
      const value = await callback(signal);
      this.assertCurrent(instance);
      const snapshot = snapshotPluginData(value, mode);
      this.assertCurrent(instance);
      return snapshot;
    }, options);
  }

  invokeSyncData<T>(
    instance: PluginInstance,
    operation: string,
    mode: PluginDataSnapshotMode,
    callback: () => T,
  ): T {
    return this.invokeSync(instance, operation, () => {
      const value = callback();
      this.assertCurrent(instance);
      return snapshotPluginData(value, mode);
    });
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
      const execution = this.storage.run(state, async () => {
        this.assertCurrent(instance);
        return callback(state.controller.signal);
      });
      void execution.finally(() => {
        executionSettled = true;
        if (abortWatchdog) clearTimeout(abortWatchdog);
      }).catch(() => undefined);
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
    markPluginCapabilityTree(value);
    if (typeof value === 'function') {
      return this.wrapProtectedFunction(value, instance, root);
    }

    const object = value as object;
    const cached = this.getCachedProxy(instance, object, String(root));
    if (cached) return cached as T;
    const proxy = new Proxy(object, {
      get: (target, property, _receiver) => {
        this.assertCurrent(instance, root);
        const child = Reflect.get(target, property, target);
        if (typeof child === 'function') {
          return this.wrapProtectedFunction(child, instance, root, target);
        }
        if (child && typeof child === 'object') {
          return this.wrapProtectedResult(child, instance, root);
        }
        return child;
      },
      getOwnPropertyDescriptor: (target, property) => {
        this.assertCurrent(instance, root);
        return this.wrapProtectedDescriptor(
          Reflect.getOwnPropertyDescriptor(target, property),
          instance,
          root,
        );
      },
      set: () => this.rejectCapabilityMutation(instance, root),
      defineProperty: () => this.rejectCapabilityMutation(instance, root),
      deleteProperty: () => this.rejectCapabilityMutation(instance, root),
      setPrototypeOf: () => this.rejectCapabilityMutation(instance, root),
      preventExtensions: () => this.rejectCapabilityMutation(instance, root),
    });
    markPluginCapability(proxy);
    this.cacheProxy(instance, object, String(root), proxy);
    return proxy as T;
  }

  private wrapProtectedFunction<T>(
    value: T & Function,
    instance: PluginInstance,
    root: keyof RuntimePluginContext,
    boundThis?: unknown,
  ): T {
    const proxy = new Proxy(value, {
      apply: (target, _thisArg, args) => {
        this.assertCurrent(instance, root);
        return this.wrapProtectedResult(
          Reflect.apply(target, boundThis, args),
          instance,
          root,
          args,
        );
      },
      construct: (target, args) => {
        this.assertCurrent(instance, root);
        return this.wrapProtectedResult(
          Reflect.construct(target, args, target),
          instance,
          root,
          args,
        ) as object;
      },
      get: (target, property) => {
        this.assertCurrent(instance, root);
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
        if (descriptor?.configurable === false
            && 'value' in descriptor
            && descriptor.writable === false
            && descriptor.value
            && (typeof descriptor.value === 'object' || typeof descriptor.value === 'function')) {
          throw new TypeError('Non-configurable host capability descriptors cannot be retained');
        }
        const child = Reflect.get(target, property, target);
        if (typeof child === 'function') {
          return this.wrapProtectedFunction(child, instance, root, target);
        }
        return this.detachOrWrapResult(child, instance, root, []);
      },
      getOwnPropertyDescriptor: (target, property) => {
        this.assertCurrent(instance, root);
        return this.wrapProtectedDescriptor(
          Reflect.getOwnPropertyDescriptor(target, property),
          instance,
          root,
        );
      },
      set: () => this.rejectCapabilityMutation(instance, root),
      defineProperty: () => this.rejectCapabilityMutation(instance, root),
      deleteProperty: () => this.rejectCapabilityMutation(instance, root),
      setPrototypeOf: () => this.rejectCapabilityMutation(instance, root),
      preventExtensions: () => this.rejectCapabilityMutation(instance, root),
    });
    markPluginCapability(value);
    markPluginCapability(proxy);
    return proxy as T;
  }

  private wrapProtectedResult<T>(
    result: T,
    instance: PluginInstance,
    root: keyof RuntimePluginContext,
    pluginOwnedInputs: readonly unknown[] = [],
  ): T {
    if (result instanceof Promise) {
      return result.then((value) => this.detachOrWrapResult(
        value,
        instance,
        root,
        pluginOwnedInputs,
      )) as T;
    }
    return this.detachOrWrapResult(result, instance, root, pluginOwnedInputs);
  }

  private detachOrWrapResult<T>(
    result: T,
    instance: PluginInstance,
    root: keyof RuntimePluginContext,
    pluginOwnedInputs: readonly unknown[],
  ): T {
    if (!result || (typeof result !== 'object' && typeof result !== 'function')) {
      return result;
    }
    if (isPluginCapability(result)) {
      return this.wrapProtectedValue(result, instance, root);
    }
    if (pluginOwnedInputs.some((input) => input === result)) {
      return result;
    }
    if (isDetachedPluginData(result)) {
      return result;
    }
    if (typeof result === 'function') {
      return this.wrapProtectedValue(result, instance, root);
    }
    const prototype = Object.getPrototypeOf(result);
    const isStructuredData = Array.isArray(result)
      || Buffer.isBuffer(result)
      || result instanceof Date
      || result instanceof Map
      || result instanceof Set
      || result instanceof RegExp
      || result instanceof ArrayBuffer
      || ArrayBuffer.isView(result)
      || prototype === Object.prototype
      || prototype === null;
    if (!isStructuredData) {
      markPluginCapability(result);
      return this.wrapProtectedValue(result, instance, root);
    }
    try {
      return snapshotPluginData(result, 'structured');
    } catch (error) {
      if (error instanceof PluginDataBoundaryError && error.reason === 'capability') {
        throw error;
      }
      // Native handles are conservatively retained as guarded capabilities.
      markPluginCapability(result);
      return this.wrapProtectedValue(result, instance, root);
    }
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
      const immutableValue = 'value' in descriptor ? descriptor.value : descriptor.get ?? descriptor.set;
      if (immutableValue && (typeof immutableValue === 'object' || typeof immutableValue === 'function')) {
        throw new TypeError('Non-configurable host capability descriptors cannot be retained');
      }
      return descriptor;
    }
    const wrapped = { ...descriptor };
    if ('value' in wrapped) {
      wrapped.value = this.detachOrWrapResult(wrapped.value, instance, root, []);
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

  private rejectCapabilityMutation(
    instance: PluginInstance,
    root?: keyof RuntimePluginContext,
  ): never {
    this.assertCurrent(instance, root);
    throw new TypeError('Plugin host capabilities are read-only');
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
