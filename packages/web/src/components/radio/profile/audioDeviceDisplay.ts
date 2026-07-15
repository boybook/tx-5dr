import type { AudioDevice, AudioDeviceResolution } from '@tx5dr/contracts';
import type { TFunction } from 'i18next';

export function formatDeviceDefaultSuffix(t: TFunction, isDefault: boolean): string {
  return isDefault ? ` (${t('audio.default')})` : '';
}

export function formatDeviceText(t: TFunction, device: AudioDevice): string {
  return `${device.name}${formatDeviceDefaultSuffix(t, device.isDefault)}`;
}

export function formatDeviceDetail(device: AudioDevice | null | undefined): string | null {
  if (!device) return null;
  if (device.detail?.trim()) return device.detail.trim();

  const parts: string[] = [];
  if (device.serialNumber) parts.push(`SN ${device.serialNumber}`);
  if (device.vendorId && device.productId) {
    parts.push(`VID:PID ${device.vendorId}:${device.productId}`);
  }
  if (device.usbPath) parts.push(`USB ${device.usbPath}`);
  return parts.length > 0 ? parts.join(' · ') : null;
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
    return t('audio.deviceMissingPreserved');
  }

  if (resolution.status === 'virtual-selected') {
    return t('audio.deviceVirtualSelected');
  }

  return null;
}
