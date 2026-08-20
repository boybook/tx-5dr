import { describe, expect, it, vi } from 'vitest';
import type { RuntimePluginContext } from '@tx5dr/plugin-api';
import { PluginInvocationGuard } from '../PluginInvocationGuard.js';
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
  });
});
