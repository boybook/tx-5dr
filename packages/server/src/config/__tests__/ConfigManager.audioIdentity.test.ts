import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigManager } from '../config-manager.js';
import { RuntimeStateManager } from '../RuntimeStateManager.js';
import { PersistenceCoordinator } from '../../utils/persistence/index.js';

function resetSingletons(): void {
  (ConfigManager as unknown as { instance?: ConfigManager | null }).instance = null;
  RuntimeStateManager.getInstance().disposeForTests();
  (RuntimeStateManager as unknown as { instance?: RuntimeStateManager | null }).instance = null;
  PersistenceCoordinator.getInstance().allowNewMutationsForTests();
}

describe('ConfigManager audio identity persistence', () => {
  const previousConfigDir = process.env.TX5DR_CONFIG_DIR;
  let configDir: string;
  let configManager: ConfigManager;

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'tx5dr-audio-identity-'));
    process.env.TX5DR_CONFIG_DIR = configDir;
    resetSingletons();
    configManager = ConfigManager.getInstance();
    await configManager.initialize();
    await configManager.addProfile({
      id: 'profile-1',
      name: 'IC-705',
      radio: { type: 'serial' } as any,
      audio: {
        inputDeviceName: 'USB Audio CODEC',
        outputDeviceName: 'USB Audio CODEC',
        inputDeviceId: 'input-3',
        outputDeviceId: 'output-3',
        inputHardwareId: 'usb:1-1',
        outputHardwareId: 'usb:1-1',
        inputRouteKey: 'legacy-route',
        outputRouteKey: 'legacy-route',
        inputSampleRate: 48000,
        outputSampleRate: 48000,
        inputBufferSize: 1024,
        outputBufferSize: 1024,
      },
      audioLockedToRadio: false,
      createdAt: 1,
      updatedAt: 1,
    });
    await configManager.setActiveProfileId('profile-1');
  });

  afterEach(async () => {
    await RuntimeStateManager.getInstance().flush();
    resetSingletons();
    if (previousConfigDir === undefined) {
      delete process.env.TX5DR_CONFIG_DIR;
    } else {
      process.env.TX5DR_CONFIG_DIR = previousConfigDir;
    }
    await rm(configDir, { recursive: true, force: true });
  });

  it('clears stale device/hardware ids when updateAudioConfig renames without new identity', async () => {
    await configManager.updateAudioConfig({
      inputDeviceName: 'Built-in Mic',
      outputDeviceName: 'Built-in Speaker',
    });

    const audio = configManager.getActiveProfile()?.audio;
    expect(audio).toMatchObject({
      inputDeviceName: 'Built-in Mic',
      outputDeviceName: 'Built-in Speaker',
    });
    expect(audio?.inputDeviceId).toBeUndefined();
    expect(audio?.outputDeviceId).toBeUndefined();
    expect(audio?.inputHardwareId).toBeUndefined();
    expect(audio?.outputHardwareId).toBeUndefined();
    expect(audio?.inputRouteKey).toBeUndefined();
    expect(audio?.outputRouteKey).toBeUndefined();
  });

  it('clears stale device/hardware ids when updateProfile renames audio without new identity', async () => {
    await configManager.updateProfile('profile-1', {
      audio: {
        inputDeviceName: 'HDMI',
        outputDeviceName: 'HDMI',
      },
    });

    const audio = configManager.getProfile('profile-1')?.audio;
    expect(audio).toMatchObject({
      inputDeviceName: 'HDMI',
      outputDeviceName: 'HDMI',
    });
    expect(audio?.inputDeviceId).toBeUndefined();
    expect(audio?.outputDeviceId).toBeUndefined();
    expect(audio?.inputHardwareId).toBeUndefined();
    expect(audio?.outputHardwareId).toBeUndefined();
  });

  it('keeps identity fields when rename includes the new ids', async () => {
    await configManager.updateAudioConfig({
      inputDeviceName: 'USB Audio CODEC B',
      inputDeviceId: 'input-7',
      inputHardwareId: 'usb:1-2',
    });

    const audio = configManager.getActiveProfile()?.audio;
    expect(audio).toMatchObject({
      inputDeviceName: 'USB Audio CODEC B',
      inputDeviceId: 'input-7',
      inputHardwareId: 'usb:1-2',
    });
  });
});
