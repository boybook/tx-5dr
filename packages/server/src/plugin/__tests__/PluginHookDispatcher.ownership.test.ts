import { describe, expect, it } from 'vitest';
import type { ParsedFT8Message } from '@tx5dr/contracts';
import type { RuntimePluginContext } from '@tx5dr/plugin-api';
import { PluginHookDispatcher } from '../PluginHookDispatcher.js';
import type { PluginInstance } from '../types.js';

function candidate(callsign: string): ParsedFT8Message {
  return {
    snr: -10,
    dt: 0.1,
    df: 1_200,
    rawMessage: `CQ ${callsign} PM95`,
    message: {
      type: 'cq',
      senderCallsign: callsign,
      grid: 'PM95',
    },
    slotId: 'slot-1',
    timestamp: 1,
    logbookAnalysis: { callsign },
  } as ParsedFT8Message;
}

function pluginInstance(
  name: string,
  onFilterCandidates: NonNullable<NonNullable<PluginInstance['plugin']['definition']['hooks']>['onFilterCandidates']>,
): PluginInstance {
  const context = {} as RuntimePluginContext;
  return {
    plugin: {
      definition: {
        name,
        version: '1.0.0',
        type: 'utility',
        hooks: { onFilterCandidates },
      },
      isBuiltIn: false,
    },
    scope: { kind: 'operator', operatorId: 'operator-1' },
    ctx: context,
    rawCtx: context,
    generation: name === 'first' ? 1 : 2,
    lifecycle: 'active',
    lifecycleTail: Promise.resolve(),
    desiredLifecycle: 'active',
    lifecycleRevision: 1,
    enabled: true,
    errorCounts: new Map(),
    autoDisabled: false,
  };
}

describe('PluginHookDispatcher data ownership', () => {
  it('lets pipeline mutations flow forward without mutating host input', async () => {
    let secondInput: ParsedFT8Message[] | undefined;
    const first = pluginInstance('first', (candidates) => {
      candidates[0]!.logbookAnalysis!.callsign = 'MUTATED';
      return candidates;
    });
    const second = pluginInstance('second', (candidates) => {
      secondInput = candidates;
      return candidates;
    });
    const dispatcher = new PluginHookDispatcher(
      () => [first, second],
      () => undefined,
      () => {},
    );
    const input = [candidate('JA1AAA')];

    const output = await dispatcher.dispatchFilterCandidates(
      'operator-1', input, (instance) => instance.ctx,
    );

    expect(input[0]!.logbookAnalysis!.callsign).toBe('JA1AAA');
    expect(secondInput).not.toBe(output);
    expect(secondInput?.[0]).not.toBe(output[0]);
    expect(output[0]!.logbookAnalysis!.callsign).toBe('MUTATED');
  });

  it('discards mutations when a pipeline plugin returns an invalid value', async () => {
    const invalid = pluginInstance('first', (candidates) => {
      candidates[0]!.logbookAnalysis!.callsign = 'MUTATED';
      return null as unknown as ParsedFT8Message[];
    });
    const dispatcher = new PluginHookDispatcher(
      () => [invalid],
      () => undefined,
      () => {},
    );
    const input = [candidate('JA1AAA')];

    const output = await dispatcher.dispatchFilterCandidates(
      'operator-1', input, (instance) => instance.ctx,
    );

    expect(input[0]!.logbookAnalysis!.callsign).toBe('JA1AAA');
    expect(output[0]!.logbookAnalysis!.callsign).toBe('JA1AAA');
  });
});
