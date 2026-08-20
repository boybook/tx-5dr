import EventEmitter from 'eventemitter3';
import { describe, expect, it, vi } from 'vitest';
import type { DigitalRadioEngineEvents, QSORecord } from '@tx5dr/contracts';
import { DecisionOrchestrator } from '../DecisionOrchestrator.js';

function qsoRecord(): QSORecord {
  return {
    id: 'qso-1',
    callsign: 'JA1AAA',
    frequency: 14_074_000,
    mode: 'FT8',
    startTime: Date.parse('2026-08-19T12:00:00.000Z'),
    messageHistory: [],
    myCallsign: 'BG5DRB',
  };
}

describe('DecisionOrchestrator QSO runtime identity', () => {
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
      record,
    });

    expect(request).toMatchObject({
      qsoLifecycleId: 'op1:runtime:10:qso:1:qso-1',
      qsoLifecycleEpoch: 1,
      qsoRuntimeGeneration: 10,
    });
    runtimeGeneration = 11;
    request?.resolve?.(record);
    await Promise.resolve();
    await Promise.resolve();

    expect(invokeStrategyRuntimeSync).not.toHaveBeenCalled();
  });
});
