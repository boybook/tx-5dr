import type { AudioDevice, AudioDeviceResolution } from '@tx5dr/contracts';
import type { TFunction } from 'i18next';

export function formatDeviceDefaultSuffix(t: TFunction, isDefault: boolean): string {
  return isDefault ? ` (${t('audio.default')})` : '';
}

export function formatDeviceText(t: TFunction, device: AudioDevice): string {
  return `${device.name}${formatDeviceDefaultSuffix(t, device.isDefault)}`;
}

export function formatChannelText(t: TFunction, channels: number): string {
  return t('audio.channels', { count: channels });
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
    return t('audio.deviceUnavailable');
  }

  if (resolution.status === 'virtual-selected') {
    return t('audio.deviceVirtualSelected');
  }

  return null;
}
