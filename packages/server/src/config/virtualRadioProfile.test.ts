import { describe, expect, it } from 'vitest';
import { parseInternalProfiles, isVirtualRadioProfile } from './virtualRadioProfile.js';
import { ConfigManager } from './config-manager.js';
import { RadioProfileSchema } from '@tx5dr/contracts';

function profile() {
  return {
    id: 'virtual-dev', name: 'hidden', audioLockedToRadio: true,
    createdAt: 1, updatedAt: 1,
    radio: { type: 'virtual', virtual: {
      dialFrequencyHz: 14_090_000,
      scenarioProvider: 'ww-digi',
      seed: 'repeatable',
      peers: [{ id: 'peer-1', callsign: 'JA1AAA', grid: 'PM95', scenarioId: 'standard', audioFrequencyHz: 1_500 }],
    } },
  };
}

describe('virtual radio profile', () => {
  it('parses and normalizes a server-only profile', () => {
    const parsed = parseInternalProfiles([profile()]);
    expect(isVirtualRadioProfile(parsed[0])).toBe(true);
    expect(parsed[0]).toMatchObject({ radio: { virtual: { peers: [{ dropProbability: 0, frequencyOffsetHz: 0, timingOffsetMs: 0 }] } } });
  });

  it('reports the exact profile path for invalid peers', () => {
    const invalid = profile();
    invalid.radio.virtual.peers[0]!.grid = 'BAD';
    expect(() => parseInternalProfiles([invalid])).toThrow('config.profiles[0].radio.virtual.peers.0.grid');
  });

  it('keeps virtual profiles hidden and stable while public profiles are reordered', async () => {
    const first = RadioProfileSchema.parse({
      id: 'first', name: 'first', radio: { type: 'none' }, audio: {}, audioLockedToRadio: false, createdAt: 1, updatedAt: 1,
    });
    const second = RadioProfileSchema.parse({
      id: 'second', name: 'second', radio: { type: 'none' }, audio: {}, audioLockedToRadio: false, createdAt: 1, updatedAt: 1,
    });
    const manager = Object.create(ConfigManager.prototype) as ConfigManager;
    const mutable = manager as unknown as {
      config: { profiles: ReturnType<typeof parseInternalProfiles>; activeProfileId: string };
      saveConfig: () => Promise<void>;
    };
    mutable.config = { profiles: [first, parseInternalProfiles([profile()])[0]!, second], activeProfileId: 'virtual-dev' };
    mutable.saveConfig = async () => undefined;

    expect(manager.getProfiles().map((item) => item.id)).toEqual(['first', 'second']);
    expect(manager.getPublicActiveProfileId()).toBeNull();
    expect(manager.getActiveVirtualRadioProfile()?.id).toBe('virtual-dev');
    await manager.reorderProfiles(['second', 'first']);
    expect(manager.getInternalProfiles().map((item) => item.id)).toEqual(['second', 'virtual-dev', 'first']);
  });
});
