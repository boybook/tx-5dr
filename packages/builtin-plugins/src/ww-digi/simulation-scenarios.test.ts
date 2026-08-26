import { describe, expect, it } from 'vitest';
import { wwDigiSimulationScenarios } from './simulation-scenarios.js';

describe('WW Digi simulation scenarios', () => {
  it('declares the expected deterministic and exceptional workflows', () => {
    expect(wwDigiSimulationScenarios.map((scenario) => scenario.id)).toEqual(expect.arrayContaining([
      'standard',
      'final-rrr',
      'final-rr73',
      'final-73',
      'repeat-exchange',
      'repeat-final-wait-73',
      'delayed-reply',
      'timeout',
      'permanent-silence',
      'repeat-old-message',
      'out-of-order',
      'wrong-target',
      'unrelated-callsign',
      'missing-grid',
      'invalid-grid',
      'alternate-text',
      'ambient-band',
      'seeded-random',
    ]));
  });

  it('publishes stable unique scenario ids for both digital modes', () => {
    const ids = wwDigiSimulationScenarios.map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining([
      'standard', 'final-rrr', 'final-73', 'repeat-exchange',
      'repeat-final-wait-73', 'delayed-reply', 'permanent-silence', 'seeded-random',
    ]));
    expect(wwDigiSimulationScenarios.every((scenario) => (
      scenario.modes.includes('FT8') && scenario.modes.includes('FT4')
    ))).toBe(true);
  });

  it('keeps ambient discovery separate from the standard directed QSO flow', () => {
    const standard = wwDigiSimulationScenarios.find((scenario) => scenario.id === 'standard')!;
    const ambient = wwDigiSimulationScenarios.find((scenario) => scenario.id === 'ambient-band')!;
    expect(standard.states['await-grid']?.rules?.some((rule) => rule.pattern.startsWith('CQ WW'))).toBe(false);
    expect(ambient.states.idle?.rules?.some((rule) => rule.pattern.startsWith('CQ WW'))).toBe(true);
  });
});
