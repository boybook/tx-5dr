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
  it('accepts an isolated opt-in configuration', () => {
    expect(validateVirtualRadioSafety(profile, config() as never, {
      getSimulationScenarios: () => [scenario],
      getEnabledUtilityPluginNames: () => [],
    }, 'FT8', {
      TX5DR_ENABLE_VIRTUAL_RADIO: '1', TX5DR_CONFIG_DIR: '/tmp/tx5dr-sim-config', TX5DR_DATA_DIR: '/tmp/tx5dr-sim-data',
    })).toEqual([scenario]);
  });

  it('fails closed before a real or shared environment can be used', () => {
    expect(() => validateVirtualRadioSafety(profile, config() as never, {
      getSimulationScenarios: () => [scenario], getEnabledUtilityPluginNames: () => [],
    }, 'FT8', {})).toThrow('TX5DR_ENABLE_VIRTUAL_RADIO=1');
    expect(() => validateVirtualRadioSafety(profile, config() as never, {
      getSimulationScenarios: () => [scenario], getEnabledUtilityPluginNames: () => [],
    }, 'FT8', {
      TX5DR_ENABLE_VIRTUAL_RADIO: '1', TX5DR_CONFIG_DIR: '/tmp/shared', TX5DR_DATA_DIR: '/tmp/shared',
    })).toThrow('separate TX5DR_CONFIG_DIR and TX5DR_DATA_DIR');
  });

  it('rejects enabled external utilities unless explicitly allowlisted', () => {
    expect(() => validateVirtualRadioSafety(profile, config() as never, {
      getSimulationScenarios: () => [scenario], getEnabledUtilityPluginNames: () => ['qso-udp-broadcast'],
    }, 'FT8', {
      TX5DR_ENABLE_VIRTUAL_RADIO: '1', TX5DR_CONFIG_DIR: '/tmp/config', TX5DR_DATA_DIR: '/tmp/data',
    })).toThrow('qso-udp-broadcast');
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
      getSimulationScenarios: () => [scenario], getEnabledUtilityPluginNames: () => [],
    }, 'FT8', {
      TX5DR_ENABLE_VIRTUAL_RADIO: '1', TX5DR_CONFIG_DIR: '/tmp/config', TX5DR_DATA_DIR: '/tmp/data',
    })).toThrow('effective audio frequency');
  });
});
