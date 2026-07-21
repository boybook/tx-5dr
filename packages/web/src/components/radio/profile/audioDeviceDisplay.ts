import type { AudioDevice, AudioDeviceResolution } from '@tx5dr/contracts';
import type { TFunction } from 'i18next';

export type AudioDeviceCategory = 'usb' | 'analog' | 'builtin' | 'network' | 'other';
export type AudioDeviceStatusTone = 'default' | 'primary' | 'success' | 'warning' | 'danger';

export interface AudioDeviceStatusBadge {
  key: 'available' | 'active' | 'clientConnected' | 'routeVerified' | 'routeLost';
  tone: AudioDeviceStatusTone;
}

export function formatDeviceDefaultSuffix(t: TFunction, isDefault: boolean): string {
  return isDefault ? ` (${t('audio.default')})` : '';
}

export function formatDeviceText(t: TFunction, device: AudioDevice): string {
  return `${device.name}${formatDeviceDefaultSuffix(t, device.isDefault)}`;
}

export function formatChannelText(t: TFunction, channels: number): string {
  return t('audio.channels', { count: channels });
}

export function getAudioDeviceCategory(device: AudioDevice): AudioDeviceCategory {
  if (device.connector === '3.5mm' || device.transport === 'analog'
    || device.kind === 'wired-headset' || device.kind === 'wired-headphones' || device.kind === 'analog-line') {
    return 'analog';
  }
  if (device.connector === 'usb' || device.transport === 'usb' || device.kind === 'usb'
    || /\busb\b/i.test(`${device.id} ${device.name}`)) {
    return 'usb';
  }
  if (device.connector === 'builtin' || device.transport === 'builtin'
    || device.kind === 'builtin-mic' || device.kind === 'builtin-speaker') {
    return 'builtin';
  }
  if (device.connector === 'network' || device.connector === 'virtual'
    || device.transport === 'network' || device.transport === 'virtual'
    || device.kind === 'network' || device.kind === 'virtual'
    || device.backend === 'icom-wlan' || device.backend === 'openwebrx'
    || device.backend === 'tci' || device.backend === 'network') {
    return 'network';
  }
  return 'other';
}

export function getAudioDeviceStatusBadges(device: AudioDevice): AudioDeviceStatusBadge[] {
  const routeFailed = device.routeState === 'lost'
    || device.routeState === 'unavailable'
    || device.routeState === 'failed'
    || Boolean(device.failureReason);
  const badges: AudioDeviceStatusBadge[] = [];

  if (routeFailed) {
    badges.push({ key: 'routeLost', tone: 'danger' });
  } else if (device.availability === 'active' || device.isActiveByTx5dr) {
    badges.push({ key: 'active', tone: 'primary' });
  } else if (device.availability !== 'cached') {
    badges.push({ key: 'available', tone: 'default' });
  }

  if (device.clientConnected) {
    badges.push({ key: 'clientConnected', tone: 'success' });
  }
  if (!routeFailed && (device.routeVerified || device.routeState === 'verified')) {
    badges.push({ key: 'routeVerified', tone: 'success' });
  }

  return badges;
}

export function getResolutionTone(
  resolution: AudioDeviceResolution | null | undefined,
): 'normal' | 'warning' | 'virtual' {
  if (!resolution) return 'normal';
  if (resolution.status === 'missing') return 'warning';
  if (resolution.status === 'virtual-selected') return 'virtual';
  return 'normal';
}

export function getResolutionDescription(
  t: TFunction,
  resolution: AudioDeviceResolution | null | undefined,
): string | null {
  if (!resolution) return null;

  if (resolution.status === 'missing') {
    return t('audio.deviceMissingPreserved');
  }

  if (resolution.status === 'virtual-selected') {
    return t('audio.deviceVirtualSelected');
  }

  return null;
}
