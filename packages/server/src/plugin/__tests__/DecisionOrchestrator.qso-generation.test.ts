import EventEmitter from 'eventemitter3';
import { describe, expect, it, vi } from 'vitest';
import type { DigitalRadioEngineEvents, QSORecord } from '@tx5dr/contracts';
import { DecisionOrchestrator } from '../DecisionOrchestrator.js';

function qsoRecord(id = 'qso-1', callsign = 'JA1AAA'): QSORecord {
  return {
    id,
    callsign,
    frequency: 14_074_000,
    mode: 'FT8',
    startTime: Date.parse('2026-08-19T12:00:00.000Z'),
    messageHistory: [],
    myCallsign: 'BG5DRB',
  };
}

describe('DecisionOrchestrator QSO runtime identity', () => {
  it('allows a changed queue observation to commit passive effects while TX is off', async () => {
    const token = { operatorId: 'op1', epoch: 3, source: 'late-decode', priority: 10 };
    const signal = new AbortController().signal;
    const orchestrator = new DecisionOrchestrator({
      getOperatorById: () => ({ isTransmitting: false }),
      getCurrentMode: () => ({ name: 'FT8', slotMs: 15_000 }),
      hasTargetQueue: () => true,
      observeStrategyMessages: () => true,
      intentCoordinator: { isCurrent: () => true },
    } as any);
    vi.spyOn(orchestrator as any, 'parseSlotPackMessages').mockResolvedValue([]);
    const decide = vi.spyOn(orchestrator as any, 'invokeStrategyDecision').mockResolvedValue(null);

    await (orchestrator as any).reDecideOperatorInLane(
      'op1',
      { slotId: 'slot-1', startMs: 1_000, endMs: 16_000, frames: [], stats: {}, decodeHistory: [] },
      token,
      signal,
    );

    expect(decide).toHaveBeenCalledWith('op1', [], { isReDecision: true }, token, signal);
  });

  it('enforces the strategy stream cap in addition to the operator cap', () => {
    const runtime = {
      getTransmissions: () => [
        { streamId: 'stream-1', text: 'JA1AAA BG5DRB OL32', audioFrequencyHz: 1_200 },
        { streamId: 'stream-2', text: 'JA2BBB BG5DRB OL32', audioFrequencyHz: 1_500 },
      ],
    };
    const orchestrator = new DecisionOrchestrator({
      getOperatorById: () => ({ config: { frequency: 1_500, maxConcurrentStreams: 5 } }),
      getStrategyMaxConcurrentStreams: () => 1,
      invokeStrategyRuntimeSync: (
        _operatorId: string,
        _operation: string,
        callback: (value: typeof runtime) => unknown,
      ) => callback(runtime),
    } as any);

    expect(orchestrator.readCurrentTransmissions('op1')).toEqual([]);
  });

  it('does not settle a completion into a replacement runtime with the same lifecycle epoch', async () => {
    const eventEmitter = new EventEmitter<DigitalRadioEngineEvents>();
    const invokeStrategyRuntimeSync = vi.fn();
    let runtimeGeneration = 10;
    let request: Parameters<DigitalRadioEngineEvents['recordQSO']>[0] | undefined;
    eventEmitter.on('recordQSO', (data) => {
      request = data;
    });
    const orchestrator = new DecisionOrchestrator({
      eventEmitter,
      getStrategyRuntimeGeneration: () => runtimeGeneration,
      invokeStrategyRuntimeSync,
    } as any);
    const record = qsoRecord();

    (orchestrator as any).commitQSOCompletionEffect('op1', 10, {
      lifecycleEpoch: 1,
      destination: { kind: 'plugin-session', sessionId: 'session-1' },
      record,
    }, 'test-strategy');

    expect(request).toMatchObject({
      qsoLifecycleId: 'op1:runtime:10:qso:1:qso-1',
      qsoLifecycleEpoch: 1,
      qsoRuntimeGeneration: 10,
      destination: { kind: 'plugin-session', sessionId: 'session-1' },
      sourcePluginName: 'test-strategy',
    });
    runtimeGeneration = 11;
    request?.resolve?.(record);
    await Promise.resolve();
    await Promise.resolve();

    expect(invokeStrategyRuntimeSync).not.toHaveBeenCalled();
  });

  it('forwards persistence policy and settles every queued completion by stream after an earlier failure', async () => {
    const eventEmitter = new EventEmitter<DigitalRadioEngineEvents>();
    const requests: Array<Parameters<DigitalRadioEngineEvents['recordQSO']>[0]> = [];
    eventEmitter.on('recordQSO', (data) => requests.push(data));
    const settleQSOCompletion = vi.fn();
    const runtime = {
      getSnapshot: () => ({ currentState: 'active' }),
      settleQSOCompletion,
    };
    const invokeStrategyRuntimeSync = vi.fn((
      _operatorId: string,
      _operation: string,
      callback: (value: typeof runtime) => unknown,
    ) => callback(runtime));
    const orchestrator = new DecisionOrchestrator({
      eventEmitter,
      getStrategyRuntimeGeneration: () => 10,
      invokeStrategyRuntimeSync,
    } as any);

    (orchestrator as any).commitQSOCompletionEffects('op1', 10, [
      {
        lifecycleEpoch: 1,
        streamId: 'lane-1',
        persistencePolicy: 'preserve-distinct',
        record: qsoRecord('qso-1', 'JA1AAA'),
      },
      {
        lifecycleEpoch: 1,
        streamId: 'lane-2',
        persistencePolicy: 'preserve-distinct',
        record: qsoRecord('qso-2', 'K1BBB'),
      },
    ]);

    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({
      streamId: 'lane-1',
      persistencePolicy: 'preserve-distinct',
      qsoLifecycleId: 'op1:runtime:10:stream:lane-1:qso:1:qso-1',
    });
    requests[0]!.reject?.(new Error('disk full'));

    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]).toMatchObject({
      streamId: 'lane-2',
      persistencePolicy: 'preserve-distinct',
      qsoLifecycleId: 'op1:runtime:10:stream:lane-2:qso:1:qso-2',
    });
    requests[1]!.resolve?.({ ...qsoRecord('persisted-2', 'K1BBB') });

    await vi.waitFor(() => expect(settleQSOCompletion).toHaveBeenCalledTimes(2));
    expect(settleQSOCompletion).toHaveBeenNthCalledWith(1, {
      lifecycleEpoch: 1,
      recordId: 'qso-1',
      status: 'failed',
      streamId: 'lane-1',
    });
    expect(settleQSOCompletion).toHaveBeenNthCalledWith(2, {
      lifecycleEpoch: 1,
      recordId: 'qso-2',
      persistedRecordId: 'persisted-2',
      status: 'committed',
      streamId: 'lane-2',
    });
  });

  it('publishes active QSO lifecycle identity for every strategy stream', async () => {
    const eventEmitter = new EventEmitter<DigitalRadioEngineEvents>();
    const lifecycleEvents: Array<Parameters<DigitalRadioEngineEvents['qsoLifecycleChanged']>[0]> = [];
    eventEmitter.on('qsoLifecycleChanged', (data) => lifecycleEvents.push(data));
    const runtime = {
      checkpoint: () => ({}),
      restore: vi.fn(),
      decide: vi.fn(() => ({
        transmission: null,
        transmissions: [],
        snapshot: {
          currentState: 'active',
          streams: [
            { streamId: 'lane-1', currentState: 'TX2', audioFrequencyHz: 1_200, qsoLifecycleEpoch: 4 },
            { streamId: 'lane-2', currentState: 'TX3', audioFrequencyHz: 1_260, qsoLifecycleEpoch: 7 },
          ],
        },
      })),
    };
    const invokeStrategyRuntimeSync = vi.fn((
      _operatorId: string,
      _operation: string,
      callback: (value: typeof runtime) => unknown,
    ) => callback(runtime));
    const orchestrator = new DecisionOrchestrator({
      eventEmitter,
      getStrategyRuntime: () => runtime,
      getStrategyRuntimeGeneration: () => 12,
      getOperatorById: () => undefined,
      invokeStrategyRuntimeSync,
      invokeStrategyRuntime: async (
        _operatorId: string,
        _operation: string,
        callback: (value: typeof runtime) => unknown,
      ) => callback(runtime),
      intentCoordinator: { isCurrent: () => true },
    } as any);
    const signal = new AbortController().signal;

    await (orchestrator as any).invokeStrategyDecision(
      'op1',
      [],
      { isReDecision: false },
      { operatorId: 'op1', epoch: 9, source: 'slot-auto', priority: 10 },
      signal,
    );

    expect(lifecycleEvents).toEqual([
      { operatorId: 'op1', streamId: 'lane-1', lifecycleEpoch: 4, runtimeGeneration: 12 },
      { operatorId: 'op1', streamId: 'lane-2', lifecycleEpoch: 7, runtimeGeneration: 12 },
    ]);
  });
});
