import { describe, expect, it, vi } from 'vitest';
import { VirtualRadioProfileSchema } from '../config/virtualRadioProfile.js';
import { validateVirtualRadioSafety } from './virtualRadioSafety.js';

const profile = VirtualRadioProfileSchema.parse({
  id: 'virtual-dev', name: 'hidden', createdAt: 1, updatedAt: 1,
  radio: { type: 'virtual', virtual: {
    dialFrequencyHz: 14_090_000, scenarioProvider: 'ww-digi', seed: 42,
    peers: [{ id: 'peer-1', callsign: 'JA1AAA', grid: 'PM95', scenarioId: 'standard', audioFrequencyHz: 1_500 }],
  } },
});
const scenario = { id: 'standard', modes: ['FT8' as const], initialState: 'idle', states: { idle: {} } };

function config() {
  return {
    getPSKReporterConfig: vi.fn(() => ({ enabled: false })),
    getRigctldConfig: vi.fn(() => ({ enabled: false })),
  };
}

describe('virtual radio safety', () => {
  it('accepts a configured virtual profile without environment opt-in', () => {
    expect(validateVirtualRadioSafety(profile, config() as never, {
      getSimulationScenarios: () => [scenario],
    }, 'FT8')).toEqual([scenario]);
  });

  it('rejects external reporter and rigctld side effects', () => {
    const pskConfig = config();
    pskConfig.getPSKReporterConfig.mockReturnValue({ enabled: true });
    expect(() => validateVirtualRadioSafety(profile, pskConfig as never, {
      getSimulationScenarios: () => [scenario],
    }, 'FT8')).toThrow('pskreporter.enabled=false');

    const rigctldConfig = config();
    rigctldConfig.getRigctldConfig.mockReturnValue({ enabled: true });
    expect(() => validateVirtualRadioSafety(profile, rigctldConfig as never, {
      getSimulationScenarios: () => [scenario],
    }, 'FT8')).toThrow('rigctld to be disabled');
  });

  it('rejects an effective peer frequency outside the supported passband', () => {
    const outsidePassband = VirtualRadioProfileSchema.parse({
      ...profile,
      radio: {
        type: 'virtual',
        virtual: {
          ...profile.radio.virtual,
          peers: [{ ...profile.radio.virtual.peers[0], audioFrequencyHz: 3_900, frequencyOffsetHz: 200 }],
        },
      },
    });
    expect(() => validateVirtualRadioSafety(outsidePassband, config() as never, {
      getSimulationScenarios: () => [scenario],
    }, 'FT8')).toThrow('effective audio frequency');
  });

  it('requires a declared scenario pool when a peer opts into identity rotation', () => {
    const pooled = VirtualRadioProfileSchema.parse({
      ...profile,
      radio: { type: 'virtual', virtual: {
        ...profile.radio.virtual,
        peers: [{ ...profile.radio.virtual.peers[0], identityPool: 'scenario' }],
      } },
    });
    expect(() => validateVirtualRadioSafety(pooled, config() as never, {
      getSimulationScenarios: () => [scenario],
    }, 'FT8')).toThrow('does not declare an identity pool');
    expect(validateVirtualRadioSafety(pooled, config() as never, {
      getSimulationScenarios: () => [{ ...scenario, identityPool: [{ callsign: 'JA1AAA', grid: 'PM95' }] }],
    }, 'FT8')).toHaveLength(1);
  });
});
