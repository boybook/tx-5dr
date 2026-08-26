import { describe, expect, it } from 'vitest';
import type { AnyPluginDefinition } from '@tx5dr/plugin-api';
import { canonicalizePluginDefinition, validatePluginDefinition } from '../PluginLoader.js';

function definition(): AnyPluginDefinition {
  return {
    apiVersion: 2, name: 'sim-provider', version: '1.0.0', type: 'utility',
    simulationScenarios: [{
      id: 'scenario', modes: ['FT8'], initialState: 'idle', states: {
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
  });
});
