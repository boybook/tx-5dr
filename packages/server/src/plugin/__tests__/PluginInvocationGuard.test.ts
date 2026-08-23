import { describe, expect, it, vi } from 'vitest';
import type { RuntimePluginContext } from '@tx5dr/plugin-api';
import { PluginInvocationGuard } from '../PluginInvocationGuard.js';
import { PluginDataBoundaryError } from '../plugin-data-boundary.js';
import type { PluginInstance } from '../types.js';

function createInstance(context: RuntimePluginContext): PluginInstance {
  return {
    plugin: {
      definition: {
        apiVersion: 2,
        name: 'guard-test',
        version: '1.0.0',
        type: 'utility',
        permissions: ['operator:transmit-control'],
        isAutoCallEnabled: () => true,
      },
      isBuiltIn: false,
    },
    scope: { kind: 'operator', operatorId: 'operator-1' },
    ctx: context,
    rawCtx: context,
    generation: 1,
    lifecycle: 'active',
    lifecycleTail: Promise.resolve(),
    desiredLifecycle: 'active',
    lifecycleRevision: 1,
    enabled: true,
    errorCounts: new Map(),
    autoDisabled: false,
  };
}

describe('PluginInvocationGuard', () => {
  it('rejects context roots without an explicit ownership policy', () => {
    const raw = { futureCapability: {} } as unknown as RuntimePluginContext;
    const instance = createInstance(raw);
    const guard = new PluginInvocationGuard();

    expect(() => guard.wrapContext(raw, instance)).toThrow(
      "PLUGIN_CAPABILITY_POLICY_MISSING: unclassified context root 'futureCapability'",
    );
  });

  it('revokes methods retained through property descriptors', async () => {
    const submit = vi.fn(async () => ({ epoch: 1, outcome: 'completed' as const }));
    const raw = {
      operatorCommands: { submit },
    } as unknown as RuntimePluginContext;
    const instance = createInstance(raw);
    const guard = new PluginInvocationGuard();
    const ctx = guard.wrapContext(raw, instance);
    let retainedSubmit: (() => Promise<unknown>) | undefined;

    await guard.invoke(instance, 'test:descriptor', async () => {
      const commands = Object.getOwnPropertyDescriptor(ctx, 'operatorCommands')?.value;
      retainedSubmit = Object.getOwnPropertyDescriptor(commands, 'submit')?.value;
      await retainedSubmit?.();
    });

    expect(submit).toHaveBeenCalledTimes(1);
    expect(() => retainedSubmit?.()).toThrow('Plugin invocation is no longer allowed');
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('checks invocation state when nested scalar properties are read', async () => {
    const raw = {
      radioPower: { state: 'awake' },
    } as unknown as RuntimePluginContext;
    const instance = createInstance(raw);
    const guard = new PluginInvocationGuard();
    const ctx = guard.wrapContext(raw, instance);
    let retainedPower: Record<string, unknown> | undefined;

    await guard.invoke(instance, 'test:nested-read', () => {
      retainedPower = ctx.radioPower as unknown as Record<string, unknown>;
      expect(retainedPower.state).toBe('awake');
    });

    expect(() => retainedPower?.state).toThrow('Plugin invocation is no longer allowed');
    expect(() => Object.getOwnPropertyDescriptor(retainedPower!, 'state')).toThrow(
      'Plugin invocation is no longer allowed',
    );
  });

  it('guards retained getters obtained through property descriptors', async () => {
    const raw = {
      radio: {
        get frequency() { return 14_074_000; },
      },
    } as unknown as RuntimePluginContext;
    const instance = createInstance(raw);
    const guard = new PluginInvocationGuard();
    const ctx = guard.wrapContext(raw, instance);
    let retainedGetter: (() => unknown) | undefined;

    await guard.invoke(instance, 'test:getter-descriptor', () => {
      retainedGetter = Object.getOwnPropertyDescriptor(ctx.radio, 'frequency')?.get;
      expect(retainedGetter?.()).toBe(14_074_000);
    });

    expect(() => retainedGetter?.()).toThrow('Plugin invocation is no longer allowed');
  });

  it('prevents capability mutation both during and after an invocation', async () => {
    const rawGet = () => 'original';
    const rawStore = { get: rawGet };
    const raw = {
      store: { global: rawStore, operator: { get: () => undefined } },
    } as unknown as RuntimePluginContext;
    const instance = createInstance(raw);
    const guard = new PluginInvocationGuard();
    const ctx = guard.wrapContext(raw, instance);
    let retained: Record<string, unknown> | undefined;

    await guard.invoke(instance, 'test:capability-mutation', () => {
      retained = ctx.store.global as unknown as Record<string, unknown>;
      expect(() => {
        retained!.get = () => 'mutated';
      }).toThrow('Plugin host capabilities are read-only');
      expect(() => Object.defineProperty(retained!, 'get', { value: () => 'mutated' }))
        .toThrow('Plugin host capabilities are read-only');
    });

    expect(rawStore.get).toBe(rawGet);
    expect(() => {
      retained!.get = () => 'late mutation';
    }).toThrow('Plugin invocation is no longer allowed');
    expect(rawStore.get).toBe(rawGet);
  });

  it('detaches ordinary data returned by a guarded host capability', async () => {
    const stored = { nested: { value: 1 } };
    const raw = {
      store: {
        global: { get: (key: string, defaultValue?: unknown) => (
          key === 'config' ? stored : defaultValue
        ) },
        operator: { get: () => undefined },
      },
    } as unknown as RuntimePluginContext;
    const instance = createInstance(raw);
    const guard = new PluginInvocationGuard();
    const ctx = guard.wrapContext(raw, instance);
    let retained: { nested: { value: number } } | undefined;
    const defaultValue = { nested: { value: 3 } };
    const defaultFunction = () => 'default';

    await guard.invoke(instance, 'test:data-result', () => {
      retained = ctx.store.global.get('config') as typeof retained;
      retained!.nested.value = 2;
      expect(ctx.store.global.get('missing', defaultValue)).toBe(defaultValue);
      expect(ctx.store.global.get('missing-function', defaultFunction)).toBe(defaultFunction);
    });

    expect(retained?.nested.value).toBe(2);
    expect(stored.nested.value).toBe(1);
  });

  it('detaches page-handler data before the invocation expires', async () => {
    const stored = { url: 'https://example.test', enabled: true };
    const raw = {
      store: {
        global: { get: () => stored },
        operator: { get: () => undefined },
      },
    } as unknown as RuntimePluginContext;
    const instance = createInstance(raw);
    const guard = new PluginInvocationGuard();
    const ctx = guard.wrapContext(raw, instance);

    const result = await guard.invokeData(
      instance,
      'ui:onMessage',
      'json',
      () => ctx.store.global.get('config'),
    );

    expect(result).toEqual(stored);
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it('does not start a data callback when the external signal is already aborted', async () => {
    const raw = {} as RuntimePluginContext;
    const instance = createInstance(raw);
    const guard = new PluginInvocationGuard();
    const controller = new AbortController();
    const callback = vi.fn(() => ({ ok: true }));
    controller.abort('superseded');

    await expect(guard.invokeData(
      instance,
      'test:pre-aborted',
      'structured',
      callback,
      { signal: controller.signal },
    )).rejects.toThrow('Plugin invocation is no longer allowed');
    expect(callback).not.toHaveBeenCalled();
  });

  it('rejects when a callback synchronously triggers external abort before hanging', async () => {
    const raw = {} as RuntimePluginContext;
    const instance = createInstance(raw);
    const guard = new PluginInvocationGuard();
    const controller = new AbortController();

    const invocation = guard.invokeData(
      instance,
      'test:sync-abort',
      'structured',
      () => {
        controller.abort('superseded');
        return new Promise<never>(() => {});
      },
      { signal: controller.signal, drainOnExternalAbortMs: 5 },
    );

    await expect(invocation).rejects.toThrow('superseded');
  });

  it('rejects capabilities embedded in data results', async () => {
    const raw = {
      network: {
        udp: { closeAll: async () => undefined },
      },
    } as unknown as RuntimePluginContext;
    const instance = createInstance(raw);
    const guard = new PluginInvocationGuard();
    const ctx = guard.wrapContext(raw, instance);

    await expect(guard.invokeData(
      instance,
      'test:capability-result',
      'structured',
      () => ({ udp: ctx.network!.udp }),
    )).rejects.toBeInstanceOf(PluginDataBoundaryError);
  });

  it('returns config as a detached snapshot and guards band access', async () => {
    const settings = { nested: { enabled: true } };
    let configReads = 0;
    const raw = {
      get config() {
        configReads += 1;
        return settings;
      },
      band: { findIdleTransmitFrequency: () => 1_500 },
    } as unknown as RuntimePluginContext;
    const instance = createInstance(raw);
    const guard = new PluginInvocationGuard();
    const ctx = guard.wrapContext(raw, instance);
    let config: typeof settings | undefined;
    let band: RuntimePluginContext['band'] | undefined;

    await guard.invoke(instance, 'test:config-band', () => {
      config = ctx.config as typeof settings;
      band = ctx.band;
      config.nested.enabled = false;
      expect(band.findIdleTransmitFrequency()).toBe(1_500);
    });

    expect(config?.nested.enabled).toBe(false);
    expect(settings.nested.enabled).toBe(true);
    expect(configReads).toBe(1);
    expect(() => ctx.config).toThrow('Plugin invocation is no longer allowed');
    expect(configReads).toBe(1);
    expect(() => band?.findIdleTransmitFrequency()).toThrow(
      'Plugin invocation is no longer allowed',
    );
  });

  it('keeps native response objects guarded while detaching their data results', async () => {
    const raw = {
      fetch: async () => new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    } as unknown as RuntimePluginContext;
    const instance = createInstance(raw);
    const guard = new PluginInvocationGuard();
    const ctx = guard.wrapContext(raw, instance);
    let retainedResponse: Response | undefined;
    let retainedHeaders: Headers | undefined;
    let retainedReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let body: { ok: boolean } | undefined;
    let bytes: ArrayBuffer | undefined;

    await guard.invoke(instance, 'test:fetch', async () => {
      retainedResponse = await ctx.fetch!('https://example.test');
      expect(retainedResponse.status).toBe(200);
      retainedHeaders = retainedResponse.headers;
      expect(retainedHeaders.get('content-type')).toBe('application/json');
      bytes = await retainedResponse.clone().arrayBuffer();
      body = await retainedResponse.json() as { ok: boolean };
      const streamResponse = await ctx.fetch!('https://example.test/stream');
      retainedReader = streamResponse.body!.getReader();
      expect((await retainedReader.read()).done).toBe(false);
    });

    expect(body).toEqual({ ok: true });
    expect(bytes).toBeInstanceOf(ArrayBuffer);
    expect(() => body!.ok).not.toThrow();
    expect(() => retainedResponse?.status).toThrow(
      'Plugin invocation is no longer allowed',
    );
    expect(() => retainedHeaders?.get('content-type')).toThrow(
      'Plugin invocation is no longer allowed',
    );
    expect(() => retainedReader?.closed).toThrow('Plugin invocation is no longer allowed');
  });

  it('keeps data-only constants nested under capabilities transferable', async () => {
    const raw = {
      hostDependencies: {
        hamlib: {
          Rotator: class MockRotator {},
          PASSBAND: { NORMAL: 0, NOCHANGE: -1 },
        },
      },
    } as unknown as RuntimePluginContext;
    const instance = createInstance(raw);
    const guard = new PluginInvocationGuard();
    const ctx = guard.wrapContext(raw, instance);

    const result = await guard.invokeData(
      instance,
      'test:host-constant',
      'structured',
      () => ({ passband: ctx.hostDependencies!.hamlib!.PASSBAND }),
    );

    expect(result).toEqual({ passband: { NORMAL: 0, NOCHANGE: -1 } });
  });

  it('preserves constructors and static methods exposed as host capabilities', async () => {
    class MockRotator {
      static debugLevel = 0;

      static setDebugLevel(level: number): void {
        this.debugLevel = level;
      }

      static getHamlibVersion(): string {
        return '4.6-test';
      }

      constructor(readonly model: number, readonly port: string) {}

      getConnectionInfo(): { model: number; port: string } {
        return { model: this.model, port: this.port };
      }
    }
    const raw = {
      hostDependencies: { hamlib: { Rotator: MockRotator } },
    } as unknown as RuntimePluginContext;
    const instance = createInstance(raw);
    const guard = new PluginInvocationGuard();
    const ctx = guard.wrapContext(raw, instance);
    let retainedRotator: MockRotator | undefined;
    let retainedConstructor: typeof MockRotator | undefined;

    await guard.invoke(instance, 'test:host-constructor', () => {
      retainedConstructor = ctx.hostDependencies!.hamlib!.Rotator as unknown as typeof MockRotator;
      retainedConstructor.setDebugLevel(2);
      expect(retainedConstructor.getHamlibVersion()).toBe('4.6-test');
      retainedRotator = new retainedConstructor(1, '/dev/mock');
      expect(retainedRotator.getConnectionInfo()).toEqual({ model: 1, port: '/dev/mock' });
    });

    expect(MockRotator.debugLevel).toBe(2);
    expect(() => retainedConstructor?.getHamlibVersion()).toThrow(
      'Plugin invocation is no longer allowed',
    );
    expect(() => retainedRotator?.getConnectionInfo()).toThrow(
      'Plugin invocation is no longer allowed',
    );
  });
});
