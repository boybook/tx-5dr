import { readFileSync } from 'node:fs';
import type { AudioDevice } from '@tx5dr/contracts';

export type AndroidAudioDirection = 'input' | 'output';

export interface AndroidAudioDeviceDescriptor {
  id: string;
  androidDeviceId: number;
  name: string;
  direction: AndroidAudioDirection;
  kind: string;
  channels: number;
  sampleRate: number;
  sampleRates: number[];
  format: 's16le';
  formats?: Array<'s16le' | 'f32le'>;
  socketPath: string;
  available: boolean;
  isDefault: boolean;
  connected?: boolean;
}

interface AndroidAudioManifest {
  inputDevices?: AndroidAudioDeviceDescriptor[];
  outputDevices?: AndroidAudioDeviceDescriptor[];
}

export function isAndroidBridgeRuntime(): boolean {
  return process.env.TX5DR_RUNTIME_FLAVOR === 'android-bridge' && Boolean(process.env.TX5DR_ANDROID_AUDIO_DEVICES_FILE);
}

export function isAndroidAudioDeviceId(deviceId: string | undefined | null): boolean {
  return Boolean(deviceId?.startsWith('android-input-') || deviceId?.startsWith('android-output-'));
}

export function isLegacyAndroidAudioDeviceName(direction: AndroidAudioDirection, deviceName: string | undefined | null): boolean {
  if (!deviceName) return false;
  const normalized = deviceName.toLowerCase();
  if (normalized === 'default' || normalized === 'default audio device') return true;
  return direction === 'input'
    ? deviceName === 'TX5DRAndroidUsbInput'
    : deviceName === 'TX5DRAndroidOutput';
}

export function readAndroidAudioManifest(): AndroidAudioManifest | null {
  const file = process.env.TX5DR_ANDROID_AUDIO_DEVICES_FILE;
  if (!isAndroidBridgeRuntime() || !file) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as AndroidAudioManifest;
  } catch {
    return null;
  }
}

export function getAndroidAudioDevices(direction: AndroidAudioDirection): AndroidAudioDeviceDescriptor[] {
  const manifest = readAndroidAudioManifest();
  const devices = direction === 'input' ? manifest?.inputDevices : manifest?.outputDevices;
  return Array.isArray(devices) ? devices.filter(isValidAndroidAudioDevice) : [];
}

export function androidDescriptorToAudioDevice(device: AndroidAudioDeviceDescriptor): AudioDevice {
  return {
    id: device.id,
    name: device.name,
    isDefault: Boolean(device.isDefault),
    channels: Math.max(1, device.channels || 1),
    sampleRate: device.sampleRate || 48000,
    sampleRates: device.sampleRates?.length ? device.sampleRates : [device.sampleRate || 48000],
    type: device.direction,
    availability: device.available === false ? 'cached' : 'available',
    isActiveByTx5dr: false,
    lastSeenAt: Date.now(),
  };
}

export function resolveAndroidAudioDevice(
  direction: AndroidAudioDirection,
  configuredDeviceName?: string,
  requestedDeviceId?: string,
): AndroidAudioDeviceDescriptor | null {
  const devices = getAndroidAudioDevices(direction);
  if (devices.length === 0) return null;
  if (requestedDeviceId) {
    const byId = devices.find((device) => device.id === requestedDeviceId);
    if (byId) return byId;
  }
  if (configuredDeviceName) {
    const byName = devices.find((device) => device.name === configuredDeviceName);
    if (byName) return byName;
    return null;
  }
  return devices.find((device) => device.isDefault && device.available !== false)
    ?? devices.find((device) => device.available !== false)
    ?? devices[0]
    ?? null;
}

function isValidAndroidAudioDevice(value: unknown): value is AndroidAudioDeviceDescriptor {
  if (!value || typeof value !== 'object') return false;
  const device = value as Partial<AndroidAudioDeviceDescriptor>;
  return typeof device.id === 'string'
    && typeof device.name === 'string'
    && (device.direction === 'input' || device.direction === 'output')
    && typeof device.socketPath === 'string'
    && device.format === 's16le';
}
