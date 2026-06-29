import { describe, expect, it } from 'vitest';
import {
  canAutoDownloadDesktopUpdate,
  canInstallDownloadedDesktopUpdate,
  isElectronUpdateTarget,
  resolveUpdateTargetLabelKey,
} from './updateTargetPresentation';

describe('updateTargetPresentation', () => {
  it('resolves backend targets without treating non-electron deployments as electron', () => {
    expect(isElectronUpdateTarget({ target: 'docker' })).toBe(false);
    expect(resolveUpdateTargetLabelKey({ target: 'docker' })).toBe('system.updateTargetDocker');
    expect(resolveUpdateTargetLabelKey({ target: 'linux-server' })).toBe('system.updateTargetLinuxServer');
    expect(resolveUpdateTargetLabelKey({ target: 'android-runtime' })).toBe('system.updateTargetAndroidRuntime');
  });

  it('only allows auto download for electron targets with updater support', () => {
    expect(canAutoDownloadDesktopUpdate({
      target: 'docker',
      updateAvailable: true,
      autoUpdateSupported: true,
      phase: 'available',
    }, true)).toBe(false);

    expect(canAutoDownloadDesktopUpdate({
      target: 'electron-app',
      updateAvailable: true,
      autoUpdateSupported: true,
      phase: 'available',
    }, true)).toBe(true);
  });

  it('only allows install for downloaded electron targets with updater support', () => {
    expect(canInstallDownloadedDesktopUpdate({
      target: 'linux-server',
      updateAvailable: true,
      downloaded: true,
      phase: 'downloaded',
    }, true)).toBe(false);

    expect(canInstallDownloadedDesktopUpdate({
      target: 'electron-app',
      updateAvailable: true,
      downloaded: true,
      phase: 'downloaded',
    }, true)).toBe(true);
  });
});
