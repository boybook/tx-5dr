import { describe, expect, it, vi } from 'vitest';
import { PluginManager } from '../PluginManager.js';

function managerHarness(invokeAction: () => unknown | Promise<unknown>) {
  const runtime = {
    checkpoint: vi.fn(() => ({ state: 'before' })),
    restore: vi.fn(),
    invokeAction: vi.fn(invokeAction),
  };
  const manager = Object.create(PluginManager.prototype) as any;
  manager.getOperatorAutomationSnapshot = vi.fn(() => ({
    currentState: 'active',
    actions: [{ id: 'do-work', label: 'Do work' }],
  }));
  manager.invokeStrategyRuntimeSync = vi.fn((_operatorId, _operation, callback) => callback(runtime));
  manager.invokeStrategyRuntime = vi.fn(async (_operatorId, _operation, callback) => callback(runtime));
  manager.orchestrator = {
    commitQSOCompletionEffectsFromAction: vi.fn(),
    invalidateDecisionMessageSet: vi.fn(),
  };
  manager.deps = { triggerReEncode: vi.fn(), notifyOperatorStatusChanged: vi.fn() };
  return { manager, runtime };
}

describe('PluginManager strategy actions', () => {
  it('projects the complete generic runtime snapshot to the operator host', () => {
    const { manager } = managerHarness(() => undefined);
    manager.getResolvedStrategyName = vi.fn(() => 'test-strategy');

    expect(manager.getOperatorRuntimeStatus('op-1')).toMatchObject({
      strategyName: 'test-strategy',
      currentSlot: 'active',
      currentState: 'active',
      actions: [{ id: 'do-work', label: 'Do work' }],
    });
  });

  it('commits declarative effects and requests a new decision', async () => {
    const effect = { lifecycleEpoch: 1, record: { id: 'qso-1' } };
    const { manager } = managerHarness(() => ({ requestDecision: true, qsoCompletions: [effect] }));
    await manager.invokeOperatorStrategyAction('op-1', { target: { kind: 'runtime' }, actionId: 'do-work' });
    expect(manager.orchestrator.commitQSOCompletionEffectsFromAction).toHaveBeenCalledWith('op-1', [effect]);
    expect(manager.orchestrator.invalidateDecisionMessageSet).toHaveBeenCalledWith('op-1');
    expect(manager.deps.triggerReEncode).toHaveBeenCalled();
  });

  it('restores the runtime checkpoint when a plugin action fails', async () => {
    const { manager, runtime } = managerHarness(() => { throw new Error('failed'); });
    await expect(manager.invokeOperatorStrategyAction(
      'op-1', { target: { kind: 'runtime' }, actionId: 'do-work' },
    )).rejects.toThrow('failed');
    expect(runtime.restore).toHaveBeenCalledWith({ state: 'before' });
  });
});
