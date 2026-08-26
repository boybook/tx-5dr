import type { SimulationScenarioDescriptor } from '@tx5dr/plugin-api';
import type { ConfigManager } from '../config/config-manager.js';
import type { VirtualRadioProfile } from '../config/virtualRadioProfile.js';

export interface VirtualRadioPluginView {
  getSimulationScenarios(pluginName: string): SimulationScenarioDescriptor[];
}

export function validateVirtualRadioSafety(
  profile: VirtualRadioProfile,
  configManager: ConfigManager,
  plugins: VirtualRadioPluginView,
  modeName: string,
): SimulationScenarioDescriptor[] {
  if (configManager.getPSKReporterConfig().enabled) {
    throw new Error('virtual radio requires config.pskreporter.enabled=false');
  }
  if (configManager.getRigctldConfig().enabled) {
    throw new Error('virtual radio requires rigctld to be disabled');
  }

  const scenarios = plugins.getSimulationScenarios(profile.radio.virtual.scenarioProvider);
  if (scenarios.length === 0) {
    throw new Error(`virtual radio scenario provider "${profile.radio.virtual.scenarioProvider}" is unavailable`);
  }
  const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  for (let index = 0; index < profile.radio.virtual.peers.length; index += 1) {
    const peer = profile.radio.virtual.peers[index]!;
    const scenario = byId.get(peer.scenarioId);
    if (!scenario) {
      throw new Error(`config.profiles[active].radio.virtual.peers[${index}].scenarioId references missing scenario "${peer.scenarioId}"`);
    }
    if (!scenario.modes.includes(modeName as 'FT8' | 'FT4')) {
      throw new Error(`virtual radio scenario "${peer.scenarioId}" does not support ${modeName}`);
    }
  }
  const minimumSpacingHz = modeName === 'FT4' ? 100 : 60;
  const frequencies = profile.radio.virtual.peers
    .map((peer, index) => ({ index, frequency: peer.audioFrequencyHz + peer.frequencyOffsetHz }))
    .sort((left, right) => left.frequency - right.frequency);
  const outsidePassband = frequencies.find(({ frequency }) => frequency < 200 || frequency > 4_000);
  if (outsidePassband) {
    throw new Error(`virtual radio peer ${outsidePassband.index} effective audio frequency must be between 200 and 4000 Hz`);
  }
  for (let index = 1; index < frequencies.length; index += 1) {
    if (frequencies[index]!.frequency - frequencies[index - 1]!.frequency < minimumSpacingHz) {
      throw new Error(`virtual radio peer audio frequencies must be at least ${minimumSpacingHz} Hz apart`);
    }
  }
  return scenarios;
}
