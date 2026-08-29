import { describe, expect, it } from 'vitest';
import type { AnyPluginDefinition } from '@tx5dr/plugin-api';
import { canonicalizePluginDefinition, validatePluginDefinition } from '../PluginLoader.js';

function definition(): AnyPluginDefinition {
  return {
    apiVersion: 2, name: 'sim-provider', version: '1.0.0', type: 'utility',
    simulationScenarios: [{
      id: 'scenario', modes: ['FT8'], initialState: 'idle',
      globalRules: [{ pattern: 'RESET', choices: [{ silence: true, nextState: 'idle' }] }],
      states: {
        idle: { rules: [{ pattern: 'PING', choices: [{ reply: 'PONG' }] }] },
      },
    }],
  };
}

describe('PluginLoader simulation scenarios', () => {
  it('validates, clones, and freezes simulation declarations', () => {
    const source = definition();
    const canonical = canonicalizePluginDefinition(source);
    expect(canonical.simulationScenarios).toEqual(source.simulationScenarios);
    expect(canonical.simulationScenarios).not.toBe(source.simulationScenarios);
    expect(Object.isFrozen(canonical.simulationScenarios)).toBe(true);
  });

  it('rejects missing states and ambiguous actions', () => {
    const missing = definition();
    missing.simulationScenarios![0]!.initialState = 'missing';
    expect(() => validatePluginDefinition(missing)).toThrow('missing initial state');
    const ambiguous = definition();
    ambiguous.simulationScenarios![0]!.states.idle!.rules![0]!.choices[0] = { reply: 'PONG', silence: true };
    expect(() => validatePluginDefinition(ambiguous)).toThrow('exactly one action');
    const invalidGlobal = definition();
    invalidGlobal.simulationScenarios![0]!.globalRules![0]!.choices[0] = { silence: true, nextState: 'missing' };
    expect(() => validatePluginDefinition(invalidGlobal)).toThrow('missing state');
    const invalidRestart = definition();
    invalidRestart.simulationScenarios![0]!.addressedRestart = { reclaimableStates: ['missing'] };
    expect(() => validatePluginDefinition(invalidRestart)).toThrow('invalid reclaimable states');
    const nonStringState = definition();
    nonStringState.simulationScenarios![0]!.states['1'] = {};
    (nonStringState.simulationScenarios![0] as unknown as {
      addressedRestart: { reclaimableStates: unknown[] };
    }).addressedRestart = { reclaimableStates: [1] };
    expect(() => validatePluginDefinition(nonStringState)).toThrow('invalid reclaimable states');
    const invalidCompleted = definition();
    (invalidCompleted.simulationScenarios![0] as unknown as {
      addressedRestart: { reclaimableStates: string[]; restartCompleted: unknown };
    }).addressedRestart = { reclaimableStates: ['idle'], restartCompleted: 'yes' };
    expect(() => validatePluginDefinition(invalidCompleted)).toThrow('restartCompleted must be a boolean');
  });

  it('validates scenario identity pools', () => {
    const valid = definition();
    valid.simulationScenarios![0]!.identityPool = [
      { callsign: 'JA1AAA', grid: 'PM95' },
      { callsign: 'K1ABC', grid: 'FN31' },
    ];
    valid.simulationScenarios![0]!.states.idle!.rules![0]!.choices[0]!.advanceIdentity = true;
    expect(() => validatePluginDefinition(valid)).not.toThrow();

    const duplicate = definition();
    duplicate.simulationScenarios![0]!.identityPool = [
      { callsign: 'JA1AAA', grid: 'PM95' },
      { callsign: 'ja1aaa', grid: 'FN31' },
    ];
    expect(() => validatePluginDefinition(duplicate)).toThrow('duplicate identity callsign');
  });
});
