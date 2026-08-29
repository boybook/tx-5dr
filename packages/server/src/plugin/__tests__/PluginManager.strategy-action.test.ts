import { describe, expect, it, vi } from 'vitest';
import { PluginManager } from '../PluginManager.js';
import { DecisionOrchestrator } from '../DecisionOrchestrator.js';
import { OperatorIntentCoordinator } from '../../transmission/OperatorIntentCoordinator.js';

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
  manager.intentCoordinator = new OperatorIntentCoordinator();
  manager.orchestrator = {
    commitQSOCompletionEffectsFromAction: vi.fn(),
    invalidateDecisionMessageSet: vi.fn(),
    revalidateStrategyExecutionInLane: vi.fn(async () => null),
    applyRevalidatedStrategyEffects: vi.fn(async () => undefined),
    readCurrentTransmissionSignature: vi.fn(() => 'unchanged'),
  };
  manager.deps = {
    triggerReEncode: vi.fn(),
    notifyOperatorStatusChanged: vi.fn(),
    prepareOperatorStrategyStart: vi.fn(() => true),
    cancelPreparedOperatorStrategyStart: vi.fn(),
  };
  return { manager, runtime };
}

describe('PluginManager strategy actions', () => {
  it('does not let a timed-out decision restore after a successor owns the lane', async () => {
    const intentCoordinator = new OperatorIntentCoordinator({ abortGraceMs: 0 });
    const restore = vi.fn();
    const orchestrator = new DecisionOrchestrator({
      intentCoordinator,
      invokeStrategyRuntimeSync: vi.fn((_operatorId, _operation, callback) => callback({ restore })),
    } as any);
    let staleToken: any;
    let markDecisionEntered!: () => void;
    let releaseDecision!: () => void;
    const decisionEntered = new Promise<void>((resolve) => { markDecisionEntered = resolve; });
    const staleDecision = intentCoordinator.submit('op-1', 'slot-auto', async (token) => {
      staleToken = token;
      markDecisionEntered();
      await new Promise<void>((resolve) => { releaseDecision = resolve; });
    });

    await decisionEntered;
    await intentCoordinator.submit('op-1', 'manual', () => undefined);
    expect((orchestrator as any).restoreDecisionCheckpoint(
      'op-1',
      { state: 'stale' },
      staleToken,
      'superseded-decision',
    )).toBe(false);
    expect(restore).not.toHaveBeenCalled();

    releaseDecision();
    await staleDecision;
  });

  it('applies a stream state change only after an aborted decision restores', async () => {
    let state = 'TX1';
    const runtime = {
      checkpoint: vi.fn(() => ({ state })),
      restore: vi.fn((checkpoint: { state: string }) => { state = checkpoint.state; }),
      setStreamState: vi.fn((update: { stateId: string }) => { state = update.stateId; }),
    };
    const manager = Object.create(PluginManager.prototype) as any;
    manager.intentCoordinator = new OperatorIntentCoordinator();
    manager.orchestrator = { invalidateDecisionMessageSet: vi.fn() };
    manager.deps = { eventEmitter: { emit: vi.fn() } };
    manager.getOperatorAutomationSnapshot = vi.fn(() => ({
      currentState: 'active',
      streams: [{ streamId: 'stream-1', currentState: state, qsoLifecycleEpoch: 4 }],
    }));
    manager.invokeStrategyRuntimeSync = vi.fn((_operatorId, _operation, callback) => callback(runtime));
    let markDecisionEntered!: () => void;
    const decisionEntered = new Promise<void>((resolve) => { markDecisionEntered = resolve; });
    const staleDecision = manager.intentCoordinator.submit(
      'op-1',
      'slot-auto',
      async (_token: unknown, signal: AbortSignal) => {
        const checkpoint = runtime.checkpoint();
        state = 'TX3';
        markDecisionEntered();
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
        runtime.restore(checkpoint);
      },
    );

    await decisionEntered;
    await manager.setOperatorStreamState('op-1', {
      streamId: 'stream-1',
      stateId: 'TX4',
      expectedLifecycleEpoch: 4,
    });
    await staleDecision;

    expect(state).toBe('TX4');
    expect(manager.deps.eventEmitter.emit).toHaveBeenCalledWith(
      'operatorStreamStateChanged',
      expect.objectContaining({ commandEpoch: 2, source: 'manual' }),
    );
  });

  it('delivers plugin-session completions only to the owning operator instance', async () => {
    const manager = Object.create(PluginManager.prototype) as any;
    const owner = { plugin: { definition: { hooks: {} } } };
    manager.instances = new Map([['op-1', new Map([['contest-owner', owner]])]]);
    manager.dispatcher = { dispatchInstance: vi.fn().mockResolvedValue(null) };

    const record = { id: 'qso-1', callsign: 'JA1AAA', messageHistory: [] } as any;
    await manager.notifyPluginSessionQSOComplete('op-1', 'contest-owner', record);

    expect(manager.dispatcher.dispatchInstance).toHaveBeenCalledWith(
      owner,
      'onQSOComplete',
      expect.any(Function),
    );
  });

  it('exposes live read-only storage and radio state to strategy runtimes', () => {
    const manager = Object.create(PluginManager.prototype) as any;
    const values: Record<string, unknown> = { session: { revision: 1 } };
    const store = {
      get: (key: string, fallback?: unknown) => values[key] ?? fallback,
      getAll: () => structuredClone(values),
      set: vi.fn(), update: vi.fn(), delete: vi.fn(), flush: vi.fn(),
    };
    const context = manager.createStrategyPluginContext({
      plugin: { definition: { storage: { scopes: ['global'] } } },
      ctx: {
        config: {}, log: {}, operator: {}, radio: { band: '20m' },
        store: { global: store, operator: store }, digitalMessagePreflight: {},
      },
    });

    expect(context.radio.band).toBe('20m');
    expect(context.store.global.get('session')).toEqual({ revision: 1 });
    expect(context.store.operator.keys()).toEqual([]);
    expect((context.store.global as any).set).toBeUndefined();
    values.session = { revision: 2 };
    expect(context.store.global.get('session')).toEqual({ revision: 2 });
  });

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

  it('commits declarative effects and revalidates without rebuilding an unchanged physical intent', async () => {
    const effect = { lifecycleEpoch: 1, record: { id: 'qso-1' } };
    const { manager } = managerHarness(() => ({ requestDecision: true, qsoCompletions: [effect] }));
    await manager.invokeOperatorStrategyAction('op-1', { target: { kind: 'runtime' }, actionId: 'do-work' });
    expect(manager.orchestrator.commitQSOCompletionEffectsFromAction).toHaveBeenCalledWith('op-1', [effect]);
    expect(manager.orchestrator.invalidateDecisionMessageSet).toHaveBeenCalledWith('op-1');
    expect(manager.orchestrator.revalidateStrategyExecutionInLane).toHaveBeenCalledWith(
      'op-1',
      expect.objectContaining({ source: 'manual' }),
      expect.any(AbortSignal),
      { deferEffects: true },
    );
    expect(manager.deps.triggerReEncode).not.toHaveBeenCalled();
  });

  it('commits action and re-decision completions at the same transaction boundary', async () => {
    const actionEffect = { lifecycleEpoch: 1, record: { id: 'action-qso' } };
    const decisionEffect = { lifecycleEpoch: 2, record: { id: 'decision-qso' } };
    const { manager } = managerHarness(() => ({
      requestDecision: true,
      qsoCompletions: [actionEffect],
    }));
    manager.orchestrator.revalidateStrategyExecutionInLane.mockResolvedValue({
      stop: false,
      transmission: null,
      snapshot: { currentState: 'active' },
      qsoCompletion: decisionEffect,
    });

    await manager.invokeOperatorStrategyAction(
      'op-1', { target: { kind: 'runtime' }, actionId: 'do-work' },
    );

    expect(manager.orchestrator.commitQSOCompletionEffectsFromAction)
      .toHaveBeenCalledWith('op-1', [actionEffect, decisionEffect]);
    expect(manager.orchestrator.applyRevalidatedStrategyEffects)
      .toHaveBeenCalledWith('op-1', expect.objectContaining({ qsoCompletion: decisionEffect }));
  });

  it('waits for an aborted decision to restore before invoking a manual action', async () => {
    const order: string[] = [];
    const { manager } = managerHarness(() => { order.push('action'); });
    let markDecisionEntered!: () => void;
    const decisionEntered = new Promise<void>((resolve) => { markDecisionEntered = resolve; });
    const staleDecision = manager.intentCoordinator.submit(
      'op-1',
      'slot-auto',
      async (_token: unknown, signal: AbortSignal) => {
        markDecisionEntered();
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
        order.push('restore');
      },
    );

    await decisionEntered;
    await manager.invokeOperatorStrategyAction(
      'op-1', { target: { kind: 'runtime' }, actionId: 'do-work' },
    );
    await staleDecision;

    expect(order).toEqual(['restore', 'action']);
  });

  it('rebuilds the physical frame only when the strategy transmission set changes', async () => {
    const { manager } = managerHarness(() => ({ requestDecision: true }));
    manager.orchestrator.readCurrentTransmissionSignature
      .mockReturnValueOnce('before')
      .mockReturnValueOnce('after');

    await manager.invokeOperatorStrategyAction(
      'op-1', { target: { kind: 'runtime' }, actionId: 'do-work' },
    );

    expect(manager.deps.triggerReEncode).toHaveBeenCalledWith('op-1', {
      source: 'operator-edit',
      reason: 'strategy action do-work',
      decisionEpoch: 1,
    });
  });

  it('does not rebuild a physical frame after a stop decision', async () => {
    const { manager } = managerHarness(() => ({ requestDecision: true }));
    manager.orchestrator.readCurrentTransmissionSignature
      .mockReturnValueOnce('before')
      .mockReturnValueOnce('after');
    manager.orchestrator.revalidateStrategyExecutionInLane.mockResolvedValue({ stop: true });

    await manager.invokeOperatorStrategyAction(
      'op-1', { target: { kind: 'runtime' }, actionId: 'do-work' },
    );

    expect(manager.deps.triggerReEncode).not.toHaveBeenCalled();
  });

  it('starts the operator only when a direct strategy action requests it', async () => {
    const { manager } = managerHarness(() => ({ requestOperatorStart: true, requestDecision: true }));
    await manager.invokeOperatorStrategyAction('op-1', { target: { kind: 'runtime' }, actionId: 'do-work' });
    expect(manager.deps.prepareOperatorStrategyStart).toHaveBeenCalledWith(
      'op-1',
      'strategy action do-work',
    );
  });

  it('restores the runtime checkpoint when a plugin action fails', async () => {
    const { manager, runtime } = managerHarness(() => { throw new Error('failed'); });
    await expect(manager.invokeOperatorStrategyAction(
      'op-1', { target: { kind: 'runtime' }, actionId: 'do-work' },
    )).rejects.toThrow('failed');
    expect(runtime.restore).toHaveBeenCalledWith({ state: 'before' });
  });

  it('rolls back a prepared start when re-decision fails before commit', async () => {
    const { manager, runtime } = managerHarness(() => ({
      requestOperatorStart: true,
      requestDecision: true,
    }));
    manager.orchestrator.revalidateStrategyExecutionInLane.mockRejectedValue(new Error('decision failed'));

    await expect(manager.invokeOperatorStrategyAction(
      'op-1', { target: { kind: 'runtime' }, actionId: 'do-work' },
    )).rejects.toThrow('decision failed');

    expect(runtime.restore).toHaveBeenCalledWith({ state: 'before' });
    expect(manager.deps.cancelPreparedOperatorStrategyStart).toHaveBeenCalledWith(
      'op-1',
      'strategy action do-work failed before commit',
    );
    expect(manager.deps.triggerReEncode).not.toHaveBeenCalled();
  });

  it('does not let a late failed action cancel a successor after lane takeover', async () => {
    const { manager } = managerHarness(() => ({
      requestOperatorStart: true,
      requestDecision: true,
    }));
    manager.intentCoordinator = new OperatorIntentCoordinator({ abortGraceMs: 0 });
    let rejectFirstDecision!: (error: Error) => void;
    let markFirstDecisionEntered!: () => void;
    const firstDecisionEntered = new Promise<void>((resolve) => { markFirstDecisionEntered = resolve; });
    manager.orchestrator.revalidateStrategyExecutionInLane
      .mockImplementationOnce(() => new Promise((_resolve, reject) => {
        rejectFirstDecision = reject;
        markFirstDecisionEntered();
      }))
      .mockResolvedValueOnce(null);

    const first = manager.invokeOperatorStrategyAction(
      'op-1', { target: { kind: 'runtime' }, actionId: 'do-work' },
    );
    await firstDecisionEntered;
    await manager.invokeOperatorStrategyAction(
      'op-1', { target: { kind: 'runtime' }, actionId: 'do-work' },
    );
    rejectFirstDecision(new Error('late failure'));

    await expect(first).rejects.toThrow('strategy_action_superseded');
    expect(manager.deps.cancelPreparedOperatorStrategyStart).not.toHaveBeenCalled();
  });
});
