import type { SystemUpdateStatus } from '@tx5dr/contracts';
import type { DesktopUpdateStatus } from '../../types/electron';

type UpdateTargetStatus = Pick<SystemUpdateStatus, 'target' | 'updateAvailable'> & {
  autoUpdateSupported?: boolean;
  downloaded?: boolean;
  phase?: DesktopUpdateStatus['phase'];
};

export function isElectronUpdateTarget(status?: Pick<SystemUpdateStatus, 'target'> | null): boolean {
  return status?.target === 'electron-app';
}

export function resolveUpdateTargetLabelKey(status?: Pick<SystemUpdateStatus, 'target'> | null):
  | 'system.updateTargetElectron'
  | 'system.updateTargetDocker'
  | 'system.updateTargetAndroidRuntime'
  | 'system.updateTargetLinuxServer' {
  if (status?.target === 'electron-app') return 'system.updateTargetElectron';
  if (status?.target === 'docker') return 'system.updateTargetDocker';
  if (status?.target === 'android-runtime') return 'system.updateTargetAndroidRuntime';
  return 'system.updateTargetLinuxServer';
}

export function canAutoDownloadDesktopUpdate(
  status: UpdateTargetStatus | null,
  hasElectronUpdater: boolean,
): boolean {
  if (!hasElectronUpdater || !isElectronUpdateTarget(status)) return false;
  if (!status?.updateAvailable || !status.autoUpdateSupported) return false;
  return status.phase !== 'downloaded' && status.phase !== 'installing';
}

export function canInstallDownloadedDesktopUpdate(
  status: UpdateTargetStatus | null,
  hasElectronUpdater: boolean,
): boolean {
  if (!hasElectronUpdater || !isElectronUpdateTarget(status)) return false;
  return Boolean(status.downloaded || status.phase === 'downloaded');
}
