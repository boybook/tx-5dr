import { describe, expect, it, vi } from 'vitest';
import { PluginManager } from '../PluginManager.js';
import { DecisionOrchestrator } from '../DecisionOrchestrator.js';
import { OperatorIntentCoordinator } from '../../transmission/OperatorIntentCoordinator.js';
import { LogManager } from '../../log/LogManager.js';

function managerHarness(invokeAction: () => unknown | Promise<unknown>) {
  const operator = { stop: vi.fn() };
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
    getOperatorById: vi.fn(() => operator),
    triggerReEncode: vi.fn(),
    notifyOperatorStatusChanged: vi.fn(),
    prepareOperatorStrategyStart: vi.fn(() => true),
    cancelPreparedOperatorStrategyStart: vi.fn(),
    requestOperatorStrategyStop: vi.fn(),
  };
  manager.strategySessionEffectDegradedOperators = new Map();
  manager.suspendedQueueExecutions = new Set();
  manager.strategyRuntimeSessionsByOperator = new Map();
  const sessionTransaction = {
    pluginName: 'contest',
    commit: vi.fn(async (): Promise<void> => undefined),
    compensate: vi.fn(async (): Promise<void> => undefined),
    finalize: vi.fn(),
  };
  manager.prepareStrategyLogbookSessionEffects = vi.fn(async () => sessionTransaction);
  return { manager, operator, runtime, sessionTransaction };
}

describe('PluginManager strategy actions', () => {
  it('rejects declared queue and parallel features that the runtime does not implement', () => {
    const manager = Object.create(PluginManager.prototype) as any;
    const runtime = {
      checkpoint: () => ({}), restore: vi.fn(), decide: vi.fn(), getTransmitText: vi.fn(),
      getSnapshot: vi.fn(), requestCall: vi.fn(), patchContext: vi.fn(), setState: vi.fn(),
      setSlotContent: vi.fn(), reset: vi.fn(),
    };
    expect(() => manager.assertStrategyRuntimeV2('queue-plugin', runtime, { targetQueue: 1 }))
      .toThrow('does not implement QueuedStrategyRuntime');

    const queueRuntime = {
      ...runtime,
      observeDecodedMessages: vi.fn(), enqueueTarget: vi.fn(), reorderTarget: vi.fn(),
      removeTarget: vi.fn(), getQueueSnapshot: vi.fn(),
    };
    expect(() => manager.assertStrategyRuntimeV2('parallel-plugin', queueRuntime, {
      targetQueue: 1, parallelTargetQueue: 1,
    })).toThrow('missing: getTransmissions, onTransmissionsCompleted');
  });

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

  it('combines action and re-decision sessions after re-decision succeeds', async () => {
    const order: string[] = [];
    const { manager, sessionTransaction } = managerHarness(() => ({
      requestDecision: true,
      logbookSessionEffects: [{
        operation: 'open', sessionKey: 'practice', title: 'Practice', retention: 'runtime',
      }],
    }));
    const decisionSessionEffect = {
      operation: 'destroy' as const,
      sessionKey: 'stale-practice',
    };
    manager.prepareStrategyLogbookSessionEffects.mockImplementation(async (
      _operatorId: string,
      effects: NonNullable<import('@tx5dr/plugin-api').StrategyActionResult['logbookSessionEffects']>,
    ) => {
      order.push('prepare');
      expect(effects).toEqual([
        { operation: 'open', sessionKey: 'practice', title: 'Practice', retention: 'runtime' },
        decisionSessionEffect,
      ]);
      return sessionTransaction;
    });
    manager.orchestrator.revalidateStrategyExecutionInLane.mockImplementation(async () => {
      order.push('redecision');
      return {
        transmission: null,
        snapshot: { currentState: 'active' },
        logbookSessionEffects: [decisionSessionEffect],
      };
    });
    sessionTransaction.commit.mockImplementation(async () => { order.push('commit'); });

    await manager.invokeOperatorStrategyAction(
      'op-1', { target: { kind: 'runtime' }, actionId: 'do-work' },
    );

    expect(order).toEqual(['redecision', 'prepare', 'commit']);
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

  it('restores runtime and prepared start when the session commit fails', async () => {
    const { manager, runtime, sessionTransaction } = managerHarness(() => ({
      requestOperatorStart: true,
      requestDecision: true,
      logbookSessionEffects: [{
        operation: 'open', sessionKey: 'practice', title: 'Practice', retention: 'runtime',
      }],
    }));
    sessionTransaction.commit.mockRejectedValue(new Error('session commit failed'));

    await expect(manager.invokeOperatorStrategyAction(
      'op-1', { target: { kind: 'runtime' }, actionId: 'do-work' },
    )).rejects.toThrow('session commit failed');

    expect(runtime.restore).toHaveBeenCalledWith({ state: 'before' });
    expect(manager.deps.cancelPreparedOperatorStrategyStart).toHaveBeenCalledWith(
      'op-1',
      'strategy action do-work failed before commit',
    );
    expect(manager.orchestrator.commitQSOCompletionEffectsFromAction).not.toHaveBeenCalled();
  });

  it('compensates a committed session when a following Host effect fails', async () => {
    const { manager, runtime, sessionTransaction } = managerHarness(() => ({
      requestDecision: true,
      logbookSessionEffects: [{
        operation: 'open', sessionKey: 'practice', title: 'Practice', retention: 'runtime',
      }],
    }));
    manager.orchestrator.applyRevalidatedStrategyEffects.mockRejectedValue(new Error('stop effect failed'));

    await expect(manager.invokeOperatorStrategyAction(
      'op-1', { target: { kind: 'runtime' }, actionId: 'do-work' },
    )).rejects.toThrow('stop effect failed');

    expect(sessionTransaction.compensate).toHaveBeenCalledOnce();
    expect(runtime.restore).toHaveBeenCalledWith({ state: 'before' });
  });

  it('compensates an already-applied runtime session when a later session effect fails', async () => {
    const manager = Object.create(PluginManager.prototype) as any;
    manager.getStrategyInstance = vi.fn(() => ({ plugin: { definition: { name: 'contest' } } }));
    manager.deps = {
      getOperatorById: vi.fn(() => ({ config: { myCallsign: 'bg5drb' } })),
      requestOperatorStrategyStop: vi.fn(),
      notifyOperatorStatusChanged: vi.fn(),
    };
    manager.strategySessionEffectDegradedOperators = new Map();
    manager.strategyRuntimeSessionsByOperator = new Map();
    const applyPluginSessionEffects = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('second open failed'))
      .mockResolvedValueOnce(undefined);
    vi.spyOn(LogManager, 'getInstance').mockReturnValue({
      getPluginSessionLogBookByKey: vi.fn(() => null),
      applyPluginSessionEffects,
    } as any);

    const transaction = await manager.prepareStrategyLogbookSessionEffects('op-1', [
      { operation: 'open', sessionKey: 'one', title: 'One', retention: 'runtime' },
      { operation: 'open', sessionKey: 'two', title: 'Two', retention: 'runtime' },
    ]);
    await expect(transaction.commit()).rejects.toThrow('second open failed');

    expect(applyPluginSessionEffects).toHaveBeenNthCalledWith(
      3,
      'contest',
      'BG5DRB',
      [{ operation: 'destroy', sessionKey: 'one' }],
    );
    expect(manager.deps.requestOperatorStrategyStop).not.toHaveBeenCalled();
  });

  it('compensates a session created by an operation that throws after mutation', async () => {
    const manager = Object.create(PluginManager.prototype) as any;
    manager.getStrategyInstance = vi.fn(() => ({ plugin: { definition: { name: 'contest' } } }));
    manager.deps = {
      getOperatorById: vi.fn(() => ({ config: { myCallsign: 'BG5DRB' } })),
      requestOperatorStrategyStop: vi.fn(),
      notifyOperatorStatusChanged: vi.fn(),
    };
    manager.strategySessionEffectDegradedOperators = new Map();
    manager.strategyRuntimeSessionsByOperator = new Map();
    const getPluginSessionLogBookByKey = vi.fn()
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({ binding: { kind: 'plugin-session', retention: 'runtime' } });
    const applyPluginSessionEffects = vi.fn()
      .mockRejectedValueOnce(new Error('health check failed after create'))
      .mockResolvedValueOnce(undefined);
    vi.spyOn(LogManager, 'getInstance').mockReturnValue({
      getPluginSessionLogBookByKey,
      applyPluginSessionEffects,
    } as any);

    const transaction = await manager.prepareStrategyLogbookSessionEffects('op-1', [{
      operation: 'open', sessionKey: 'practice', title: 'Practice', retention: 'runtime',
    }]);
    await expect(transaction.commit()).rejects.toThrow('health check failed after create');

    expect(applyPluginSessionEffects).toHaveBeenLastCalledWith('contest', 'BG5DRB', [{
      operation: 'destroy', sessionKey: 'practice',
    }]);
    expect(manager.deps.requestOperatorStrategyStop).not.toHaveBeenCalled();
  });

  it('makes a successful prepared session commit idempotent', async () => {
    const manager = Object.create(PluginManager.prototype) as any;
    manager.getStrategyInstance = vi.fn(() => ({ plugin: { definition: { name: 'contest' } } }));
    manager.deps = { getOperatorById: vi.fn(() => ({ config: { myCallsign: 'BG5DRB' } })) };
    manager.strategyRuntimeSessionsByOperator = new Map();
    const applyPluginSessionEffects = vi.fn(async () => undefined);
    vi.spyOn(LogManager, 'getInstance').mockReturnValue({
      getPluginSessionLogBookByKey: vi.fn(() => null),
      applyPluginSessionEffects,
    } as any);

    const transaction = await manager.prepareStrategyLogbookSessionEffects('op-1', [{
      operation: 'open', sessionKey: 'practice', title: 'Practice', retention: 'runtime',
    }]);
    await transaction.commit();
    await transaction.commit();

    expect(applyPluginSessionEffects).toHaveBeenCalledTimes(1);
    expect([...manager.strategyRuntimeSessionsByOperator.get('op-1').values()]).toEqual([{
      pluginName: 'contest', stationCallsign: 'BG5DRB', sessionKey: 'practice',
    }]);
  });

  it('rejects durable session effects because action rollback cannot remove durable data', async () => {
    const manager = Object.create(PluginManager.prototype) as any;
    manager.getStrategyInstance = vi.fn(() => ({ plugin: { definition: { name: 'contest' } } }));
    manager.deps = { getOperatorById: vi.fn(() => ({ config: { myCallsign: 'BG5DRB' } })) };
    vi.spyOn(LogManager, 'getInstance').mockReturnValue({
      getPluginSessionLogBookByKey: vi.fn(() => null),
    } as any);

    await expect(manager.prepareStrategyLogbookSessionEffects('op-1', [{
      operation: 'open', sessionKey: 'durable', title: 'Durable', retention: 'durable',
    }])).rejects.toThrow('strategy_logbook_session_durable_effect_not_transactional');
  });

  it('restores records when compensating a destroyed runtime session', async () => {
    const manager = Object.create(PluginManager.prototype) as any;
    manager.getStrategyInstance = vi.fn(() => ({ plugin: { definition: { name: 'contest' } } }));
    manager.deps = { getOperatorById: vi.fn(() => ({ config: { myCallsign: 'BG5DRB' } })) };
    manager.strategySessionEffectDegradedOperators = new Map();
    manager.strategyRuntimeSessionsByOperator = new Map();
    manager.trackStrategyRuntimeSession('op-1', {
      pluginName: 'contest', stationCallsign: 'BG5DRB', sessionKey: 'practice',
    });
    const record = { id: 'qso-1', callsign: 'JA1AAA', timestamp: 1 };
    const original = {
      name: 'Practice',
      binding: { kind: 'plugin-session', retention: 'runtime' },
      provider: { queryQSOs: vi.fn(async () => [record]) },
    };
    const restoredProvider = { addQSO: vi.fn(async (value) => value) };
    const getPluginSessionLogBookByKey = vi.fn()
      .mockReturnValueOnce(original)
      .mockReturnValueOnce({
        name: 'Practice',
        binding: { kind: 'plugin-session', retention: 'runtime' },
        provider: restoredProvider,
      });
    const applyPluginSessionEffects = vi.fn(async () => undefined);
    vi.spyOn(LogManager, 'getInstance').mockReturnValue({
      getPluginSessionLogBookByKey,
      applyPluginSessionEffects,
    } as any);

    const transaction = await manager.prepareStrategyLogbookSessionEffects('op-1', [{
      operation: 'destroy', sessionKey: 'practice',
    }]);
    await transaction.commit();
    expect(manager.strategyRuntimeSessionsByOperator.has('op-1')).toBe(false);
    await transaction.compensate();
    await transaction.compensate();

    expect(applyPluginSessionEffects).toHaveBeenLastCalledWith('contest', 'BG5DRB', [{
      operation: 'open', sessionKey: 'practice', title: 'Practice', retention: 'runtime',
    }]);
    expect(restoredProvider.addQSO).toHaveBeenCalledWith(record);
    expect([...manager.strategyRuntimeSessionsByOperator.get('op-1').values()]).toEqual([{
      pluginName: 'contest', stationCallsign: 'BG5DRB', sessionKey: 'practice',
    }]);
  });

  it('fails closed when session compensation cannot complete', async () => {
    const manager = Object.create(PluginManager.prototype) as any;
    const operator = { config: { myCallsign: 'BG5DRB' }, stop: vi.fn() };
    manager.getStrategyInstance = vi.fn(() => ({ plugin: { definition: { name: 'contest' } } }));
    manager.getOperatorAutomationSnapshot = vi.fn(() => null);
    manager.deps = {
      getOperatorById: vi.fn(() => operator),
      requestOperatorStrategyStop: vi.fn(),
      notifyOperatorStatusChanged: vi.fn(),
    };
    manager.strategySessionEffectDegradedOperators = new Map();
    manager.suspendedQueueExecutions = new Set();
    manager.strategyRuntimeSessionsByOperator = new Map();
    const applyPluginSessionEffects = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('destroy compensation failed'));
    vi.spyOn(LogManager, 'getInstance').mockReturnValue({
      getPluginSessionLogBookByKey: vi.fn(() => null),
      applyPluginSessionEffects,
    } as any);

    const transaction = await manager.prepareStrategyLogbookSessionEffects('op-1', [{
      operation: 'open', sessionKey: 'practice', title: 'Practice', retention: 'runtime',
    }]);
    await transaction.commit();
    await expect(transaction.compensate()).rejects.toThrow('destroy compensation failed');

    expect(manager.deps.requestOperatorStrategyStop).toHaveBeenCalledOnce();
    expect(operator.stop).toHaveBeenCalledOnce();
    manager.orchestrator = {
      readCurrentTransmission: vi.fn(() => 'CQ BG5DRB PL04'),
      readCurrentTransmissions: vi.fn(() => [{ streamId: 'default', text: 'CQ BG5DRB PL04' }]),
    };
    expect(manager.getCurrentTransmission('op-1')).toBeNull();
    expect(manager.getCurrentTransmissions('op-1')).toEqual([]);
    expect(manager.getOperatorTransmitGate('op-1')).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('destroy compensation failed'),
    });
  });

  it('destroys a shared-callsign runtime session only after its last operator owner unloads', async () => {
    const manager = Object.create(PluginManager.prototype) as any;
    manager.strategyRuntimeSessionsByOperator = new Map();
    const session = {
      pluginName: 'contest', stationCallsign: 'BG5DRB', sessionKey: 'practice',
    };
    manager.trackStrategyRuntimeSession('op-1', session);
    manager.trackStrategyRuntimeSession('op-2', session);
    const destroyRuntimePluginSessionLogBookByKey = vi.fn(async () => undefined);
    vi.spyOn(LogManager, 'getInstance').mockReturnValue({
      destroyRuntimePluginSessionLogBookByKey,
    } as any);

    await manager.cleanupTrackedStrategyRuntimeSessions('op-1', 'contest');
    expect(destroyRuntimePluginSessionLogBookByKey).not.toHaveBeenCalled();
    expect(manager.strategyRuntimeSessionsByOperator.has('op-1')).toBe(false);
    expect(manager.strategyRuntimeSessionsByOperator.has('op-2')).toBe(true);

    await manager.cleanupTrackedStrategyRuntimeSessions('op-2', 'contest');
    expect(destroyRuntimePluginSessionLogBookByKey).toHaveBeenCalledOnce();
    expect(destroyRuntimePluginSessionLogBookByKey).toHaveBeenCalledWith(
      'contest', 'BG5DRB', 'practice',
    );
    expect(manager.strategyRuntimeSessionsByOperator.has('op-2')).toBe(false);
  });

  it('serializes a shared-callsign destroy from prepare through commit before another operator opens', async () => {
    const manager = Object.create(PluginManager.prototype) as any;
    manager.getStrategyInstance = vi.fn(() => ({ plugin: { definition: { name: 'contest' } } }));
    manager.deps = {
      getOperatorById: vi.fn(() => ({ config: { myCallsign: 'BG5DRB' } })),
    };
    manager.strategyRuntimeSessionsByOperator = new Map();
    const session = {
      pluginName: 'contest', stationCallsign: 'BG5DRB', sessionKey: 'practice',
    };
    manager.trackStrategyRuntimeSession('op-1', session);

    let resolveQuery!: () => void;
    let markQueryStarted!: () => void;
    const queryStarted = new Promise<void>((resolve) => { markQueryStarted = resolve; });
    const original = {
      name: 'Practice',
      binding: { kind: 'plugin-session', retention: 'runtime' },
      provider: {
        queryQSOs: vi.fn(() => {
          markQueryStarted();
          return new Promise<unknown[]>((resolve) => {
            resolveQuery = () => resolve([]);
          });
        }),
      },
    };
    let current: {
      name: string;
      binding: { kind: string; retention: string };
      provider: { queryQSOs(): Promise<unknown[]> };
    } | null = original;
    const applyPluginSessionEffects = vi.fn(async (
      _pluginName: string,
      _stationCallsign: string,
      effects: Array<{ operation: 'open' | 'destroy'; sessionKey: string; title?: string }>,
    ) => {
      const effect = effects[0]!;
      current = effect.operation === 'destroy'
        ? null
        : {
            name: effect.title ?? effect.sessionKey,
            binding: { kind: 'plugin-session', retention: 'runtime' },
            provider: { queryQSOs: vi.fn(async (): Promise<unknown[]> => []) },
          };
    });
    vi.spyOn(LogManager, 'getInstance').mockReturnValue({
      getPluginSessionLogBookByKey: vi.fn(() => current),
      applyPluginSessionEffects,
    } as any);

    const destroying = manager.prepareStrategyLogbookSessionEffects('op-1', [{
      operation: 'destroy', sessionKey: 'practice',
    }]);
    await queryStarted;
    let openPrepared = false;
    const opening = manager.prepareStrategyLogbookSessionEffects('op-2', [{
      operation: 'open', sessionKey: 'practice', title: 'Practice', retention: 'runtime',
    }]).then((transaction: unknown) => {
      openPrepared = true;
      return transaction as { commit(): Promise<void>; finalize(): void };
    });
    await Promise.resolve();
    expect(openPrepared).toBe(false);

    resolveQuery();
    const destroyTransaction = await destroying;
    await destroyTransaction.commit();
    await Promise.resolve();
    expect(openPrepared).toBe(false);
    destroyTransaction.finalize();

    const openTransaction = await opening;
    await openTransaction.commit();
    openTransaction.finalize();

    expect(applyPluginSessionEffects.mock.calls.map((call) => call[2][0].operation))
      .toEqual(['destroy', 'open']);
    expect(current).not.toBeNull();
    expect(manager.strategyRuntimeSessionsByOperator.has('op-1')).toBe(false);
    expect([...manager.strategyRuntimeSessionsByOperator.get('op-2').values()]).toEqual([session]);
  });

  it('holds a shared-callsign open lock until compensation finishes', async () => {
    const manager = Object.create(PluginManager.prototype) as any;
    manager.getStrategyInstance = vi.fn(() => ({ plugin: { definition: { name: 'contest' } } }));
    manager.deps = {
      getOperatorById: vi.fn(() => ({ config: { myCallsign: 'BG5DRB' } })),
      requestOperatorStrategyStop: vi.fn(),
      notifyOperatorStatusChanged: vi.fn(),
    };
    manager.strategySessionEffectDegradedOperators = new Map();
    manager.strategyRuntimeSessionsByOperator = new Map();
    let current: Record<string, unknown> | null = null;
    const operations: string[] = [];
    const applyPluginSessionEffects = vi.fn(async (
      _pluginName: string,
      _stationCallsign: string,
      effects: Array<{ operation: 'open' | 'destroy'; sessionKey: string; title?: string }>,
    ) => {
      const effect = effects[0]!;
      operations.push(effect.operation);
      current = effect.operation === 'destroy'
        ? null
        : {
            name: effect.title ?? effect.sessionKey,
            binding: { kind: 'plugin-session', retention: 'runtime' },
            provider: { queryQSOs: vi.fn(async () => []) },
          };
    });
    vi.spyOn(LogManager, 'getInstance').mockReturnValue({
      getPluginSessionLogBookByKey: vi.fn(() => current),
      applyPluginSessionEffects,
    } as any);

    const first = await manager.prepareStrategyLogbookSessionEffects('op-1', [{
      operation: 'open', sessionKey: 'practice', title: 'Practice', retention: 'runtime',
    }]);
    await first.commit();

    let secondPrepared = false;
    const secondPromise = manager.prepareStrategyLogbookSessionEffects('op-2', [{
      operation: 'open', sessionKey: 'practice', title: 'Practice', retention: 'runtime',
    }]).then((transaction: unknown) => {
      secondPrepared = true;
      return transaction as { commit(): Promise<void>; finalize(): void };
    });
    await Promise.resolve();
    expect(secondPrepared).toBe(false);

    await first.compensate();
    const second = await secondPromise;
    await second.commit();
    second.finalize();

    expect(operations).toEqual(['open', 'destroy', 'open']);
    expect(current).not.toBeNull();
    expect(manager.strategyRuntimeSessionsByOperator.has('op-1')).toBe(false);
    expect(manager.strategyRuntimeSessionsByOperator.has('op-2')).toBe(true);
  });

  it('does not let a late failed action cancel a successor after lane takeover', async () => {
    const { manager, sessionTransaction } = managerHarness(() => ({
      requestOperatorStart: true,
      requestDecision: true,
      logbookSessionEffects: [{
        operation: 'open', sessionKey: 'practice', title: 'Practice', retention: 'runtime',
      }],
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
    expect(sessionTransaction.compensate).not.toHaveBeenCalled();
    expect(manager.deps.requestOperatorStrategyStop).not.toHaveBeenCalled();
  });

  it('fails closed when intent ownership is lost after a session commit', async () => {
    let invocation = 0;
    const { manager, operator, sessionTransaction } = managerHarness(() => {
      invocation += 1;
      return invocation === 1 ? {
        logbookSessionEffects: [{
          operation: 'open', sessionKey: 'practice', title: 'Practice', retention: 'runtime',
        }],
      } : undefined;
    });
    manager.intentCoordinator = new OperatorIntentCoordinator({ abortGraceMs: 0 });
    let resolveCommit!: () => void;
    let markCommitEntered!: () => void;
    const commitEntered = new Promise<void>((resolve) => { markCommitEntered = resolve; });
    sessionTransaction.commit.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveCommit = resolve;
      markCommitEntered();
    }));

    const first = manager.invokeOperatorStrategyAction(
      'op-1', { target: { kind: 'runtime' }, actionId: 'do-work' },
    );
    await commitEntered;
    await manager.invokeOperatorStrategyAction(
      'op-1', { target: { kind: 'runtime' }, actionId: 'do-work' },
    );
    resolveCommit();

    await expect(first).rejects.toThrow('strategy_action_superseded');
    expect(sessionTransaction.compensate).not.toHaveBeenCalled();
    expect(manager.deps.requestOperatorStrategyStop).toHaveBeenCalledOnce();
    expect(operator.stop).toHaveBeenCalledOnce();
    expect(manager.getOperatorTransmitGate('op-1')).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('intent ownership was lost after strategy session commit'),
    });
  });
});
