import { readFileSync } from 'node:fs';
import type { AudioDevice } from '@tx5dr/contracts';

export type AndroidAudioDirection = 'input' | 'output';

export type AndroidAudioRouteState = 'idle' | 'opening' | 'verified' | 'lost' | 'unavailable' | 'failed';

export interface AndroidAudioCapabilities {
  sampleRates?: number[];
  bufferSizes?: number[];
  channelCounts?: number[];
  sampleFormats?: Array<'float32' | 'int16' | 'f32le' | 's16le'>;
  channelModes?: Array<'mono' | 'left' | 'right' | 'both'>;
  sampleRateConfigurable?: boolean;
  bufferSizeConfigurable?: boolean;
  sampleFormatConfigurable?: boolean;
  channelModeConfigurable?: boolean;
  fixedSampleRate?: number;
  fixedBufferSize?: number;
  fixedChannelCount?: number;
  outputRouteAck?: boolean;
}

export interface AndroidAudioDeviceDescriptor {
  id: string;
  androidDeviceId?: number;
  name: string;
  direction: AndroidAudioDirection;
  kind?: string;
  channels?: number;
  sampleRate?: number;
  sampleRates?: number[];
  format: 's16le';
  formats?: Array<'s16le' | 'f32le'>;
  socketPath: string;
  available?: boolean;
  isDefault?: boolean;
  routeKey?: string;
  transport?: string;
  connector?: string;
  clientConnected?: boolean;
  routeVerified?: boolean;
  routeState?: AndroidAudioRouteState;
  failureReason?: string;
  audioSource?: string | number;
  address?: string;
  capabilities?: AndroidAudioCapabilities;
  type?: number;
  connected?: boolean;
}

interface AndroidAudioManifest {
  schemaVersion?: number;
  inputDevices?: AndroidAudioDeviceDescriptor[];
  outputDevices?: AndroidAudioDeviceDescriptor[];
}

const MAX_SUPPORTED_ANDROID_AUDIO_MANIFEST_SCHEMA_VERSION = 2;

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
    : deviceName === 'TX5DRAndroidOutput' || deviceName === 'TX5DRAndroidUsbOutput';
}

export function isLegacyAndroidUsbDeviceName(direction: AndroidAudioDirection, deviceName: string | undefined | null): boolean {
  if (!deviceName) return false;
  return direction === 'input'
    ? deviceName === 'TX5DRAndroidUsbInput'
    : deviceName === 'TX5DRAndroidOutput' || deviceName === 'TX5DRAndroidUsbOutput';
}

export function readAndroidAudioManifest(): AndroidAudioManifest | null {
  const file = process.env.TX5DR_ANDROID_AUDIO_DEVICES_FILE;
  if (!isAndroidBridgeRuntime() || !file) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const manifest = parsed as AndroidAudioManifest;
    if (manifest.schemaVersion !== undefined
      && (!Number.isInteger(manifest.schemaVersion)
        || manifest.schemaVersion < 1
        || manifest.schemaVersion > MAX_SUPPORTED_ANDROID_AUDIO_MANIFEST_SCHEMA_VERSION)) {
      return null;
    }
    return manifest;
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
  const clientConnected = device.clientConnected ?? device.connected;
  const capabilities = normalizeCapabilities(device);
  return {
    id: device.id,
    name: device.name,
    isDefault: Boolean(device.isDefault),
    channels: Math.max(1, device.channels || 1),
    sampleRate: device.sampleRate || 48000,
    sampleRates: device.sampleRates?.length ? device.sampleRates : [device.sampleRate || 48000],
    type: device.direction,
    availability: device.available === false ? 'cached' : clientConnected ? 'active' : 'available',
    isActiveByTx5dr: Boolean(clientConnected),
    lastSeenAt: Date.now(),
    backend: 'android',
    kind: normalizeKind(device.kind),
    ...(nonEmptyString(device.routeKey) ? { routeKey: device.routeKey.trim() } : {}),
    transport: normalizeTransport(device.transport, device.kind),
    connector: normalizeConnector(device.connector, device.kind),
    ...(typeof clientConnected === 'boolean' ? { clientConnected } : {}),
    ...(typeof device.routeVerified === 'boolean' ? { routeVerified: device.routeVerified } : {}),
    ...(device.routeState ? { routeState: device.routeState } : {}),
    ...(nonEmptyString(device.failureReason) ? { failureReason: device.failureReason.trim() } : {}),
    ...(capabilities ? { capabilities } : {}),
  };
}

export function resolveAndroidAudioDevice(
  direction: AndroidAudioDirection,
  configuredDeviceName?: string,
  requestedDeviceId?: string,
  configuredRouteKey?: string,
): AndroidAudioDeviceDescriptor | null {
  const devices = getAndroidAudioDevices(direction);
  if (devices.length === 0) return null;
  if (configuredRouteKey) {
    const byRouteKey = pickPreferredDevice(devices.filter((device) => device.routeKey === configuredRouteKey));
    if (byRouteKey) return byRouteKey;
    return null;
  }
  if (requestedDeviceId) {
    const byId = devices.find((device) => device.id === requestedDeviceId);
    if (byId) return byId;
  }
  if (isLegacyAndroidUsbDeviceName(direction, configuredDeviceName)) {
    return pickPreferredDevice(devices.filter(isUsbDevice));
  }
  if (configuredDeviceName) {
    if (isLegacyAndroidAudioDeviceName(direction, configuredDeviceName)) {
      return pickPreferredDevice(devices);
    }
    const byName = devices.find((device) => device.name === configuredDeviceName);
    if (byName) return byName;
    return null;
  }
  return pickPreferredDevice(devices);
}

export function getAndroidAudioStartFailure(device: AndroidAudioDeviceDescriptor): string | null {
  if (device.available === false || device.routeState === 'unavailable') {
    return device.failureReason?.trim() || 'device unavailable';
  }
  // lost/failed describe the previous client session. A fresh connection lets
  // the bridge clear that history and verify the physical route again.
  return null;
}

function isValidAndroidAudioDevice(value: unknown): value is AndroidAudioDeviceDescriptor {
  if (!value || typeof value !== 'object') return false;
  const device = value as Partial<AndroidAudioDeviceDescriptor>;
  return typeof device.id === 'string'
    && device.id.length > 0
    && (device.androidDeviceId === undefined || typeof device.androidDeviceId === 'number' && Number.isFinite(device.androidDeviceId))
    && typeof device.name === 'string'
    && device.name.length > 0
    && (device.direction === 'input' || device.direction === 'output')
    && (device.kind === undefined || typeof device.kind === 'string')
    && (device.channels === undefined || typeof device.channels === 'number' && Number.isFinite(device.channels) && device.channels > 0)
    && (device.sampleRate === undefined || typeof device.sampleRate === 'number' && Number.isFinite(device.sampleRate) && device.sampleRate > 0)
    && (device.sampleRates === undefined || Array.isArray(device.sampleRates) && device.sampleRates.every((rate) => Number.isFinite(rate) && rate > 0))
    && typeof device.socketPath === 'string'
    && device.socketPath.length > 0
    && device.format === 's16le'
    && (device.available === undefined || typeof device.available === 'boolean')
    && (device.isDefault === undefined || typeof device.isDefault === 'boolean')
    && (device.routeKey === undefined || nonEmptyString(device.routeKey))
    && (device.transport === undefined || typeof device.transport === 'string')
    && (device.connector === undefined || typeof device.connector === 'string')
    && (device.clientConnected === undefined || typeof device.clientConnected === 'boolean')
    && (device.routeVerified === undefined || typeof device.routeVerified === 'boolean')
    && (device.routeState === undefined || isRouteState(device.routeState))
    && (device.failureReason === undefined || typeof device.failureReason === 'string')
    && (device.address === undefined || typeof device.address === 'string')
    && (device.audioSource === undefined || typeof device.audioSource === 'string' || typeof device.audioSource === 'number')
    && (device.capabilities === undefined || isCapabilities(device.capabilities));
}

function pickPreferredDevice(devices: AndroidAudioDeviceDescriptor[]): AndroidAudioDeviceDescriptor | null {
  return devices.find((device) => device.isDefault && device.available !== false)
    ?? devices.find((device) => device.available !== false)
    ?? devices[0]
    ?? null;
}

function isUsbDevice(device: AndroidAudioDeviceDescriptor): boolean {
  return [device.kind, device.transport, device.connector]
    .some((value) => value?.toLowerCase().includes('usb'));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeKind(kind: string | undefined): NonNullable<AudioDevice['kind']> {
  const normalized = kind?.replace(/[_\s]/g, '-').toLowerCase() ?? '';
  switch (normalized) {
    case 'usb':
      return 'usb';
    case 'wiredheadset':
    case 'wired-headset':
      return 'wired-headset';
    case 'wiredheadphones':
    case 'wired-headphones':
      return 'wired-headphones';
    case 'lineanalog':
    case 'line-analog':
    case 'auxline':
    case 'aux-line':
    case 'analogline':
    case 'analog-line':
      return 'analog-line';
    case 'builtinmic':
    case 'builtin-mic':
      return 'builtin-mic';
    case 'builtinspeaker':
    case 'builtin-speaker':
      return 'builtin-speaker';
    case 'network':
      return 'network';
    case 'virtual':
      return 'virtual';
    default:
      return 'unknown';
  }
}

function normalizeTransport(transport: string | undefined, kind: string | undefined): NonNullable<AudioDevice['transport']> {
  const normalized = transport?.toLowerCase();
  if (normalized === 'usb') return 'usb';
  if (normalized === 'analog' || normalized === 'wired' || normalized === '3.5mm') return 'analog';
  if (normalized === 'builtin' || normalized === 'built-in') return 'builtin';
  if (normalized === 'network') return 'network';
  if (normalized === 'virtual') return 'virtual';
  const normalizedKind = normalizeKind(kind);
  if (normalizedKind === 'usb') return 'usb';
  if (normalizedKind === 'wired-headset' || normalizedKind === 'wired-headphones' || normalizedKind === 'analog-line') return 'analog';
  if (normalizedKind === 'builtin-mic' || normalizedKind === 'builtin-speaker') return 'builtin';
  return 'unknown';
}

function normalizeConnector(connector: string | undefined, kind: string | undefined): NonNullable<AudioDevice['connector']> {
  const normalized = connector?.toLowerCase();
  if (normalized === 'usb') return 'usb';
  if (normalized === '3.5mm' || normalized === 'analog' || normalized === 'wired') return '3.5mm';
  if (normalized === 'builtin' || normalized === 'built-in') return 'builtin';
  if (normalized === 'network') return 'network';
  if (normalized === 'virtual') return 'virtual';
  const normalizedKind = normalizeKind(kind);
  if (normalizedKind === 'usb') return 'usb';
  if (normalizedKind === 'wired-headset' || normalizedKind === 'wired-headphones' || normalizedKind === 'analog-line') return '3.5mm';
  if (normalizedKind === 'builtin-mic' || normalizedKind === 'builtin-speaker') return 'builtin';
  return 'unknown';
}

function isRouteState(value: unknown): value is AndroidAudioRouteState {
  return value === 'idle'
    || value === 'opening'
    || value === 'verified'
    || value === 'lost'
    || value === 'unavailable'
    || value === 'failed';
}

function isCapabilities(value: unknown): value is AndroidAudioCapabilities {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeCapabilities(device: AndroidAudioDeviceDescriptor): AudioDevice['capabilities'] | undefined {
  const source = device.capabilities;
  const sampleRates = normalizePositiveNumbers(source?.sampleRates ?? device.sampleRates);
  const bufferSizes = normalizePositiveNumbers(source?.bufferSizes);
  const channelCounts = normalizePositiveNumbers(source?.channelCounts ?? (device.channels ? [device.channels] : []));
  const rawSampleFormats = Array.isArray(source?.sampleFormats)
    ? source.sampleFormats
    : Array.isArray(device.formats) ? device.formats : [device.format];
  const sampleFormats = Array.from(new Set(rawSampleFormats
    .map((format) => format === 'f32le' ? 'float32' : format === 's16le' ? 'int16' : format)
    .filter((format): format is 'float32' | 'int16' => format === 'float32' || format === 'int16')));
  const channelModes = Array.isArray(source?.channelModes)
    ? source.channelModes.filter((mode) => mode === 'mono' || mode === 'left' || mode === 'right' || mode === 'both')
    : undefined;

  const capabilities: NonNullable<AudioDevice['capabilities']> = {
    ...(sampleRates.length > 0 ? { sampleRates } : {}),
    ...(bufferSizes.length > 0 ? { bufferSizes } : {}),
    ...(channelCounts.length > 0 ? { channelCounts } : {}),
    ...(sampleFormats.length > 0 ? { sampleFormats } : {}),
    ...(channelModes?.length ? { channelModes } : {}),
    ...copyBooleanCapability(source, 'sampleRateConfigurable'),
    ...copyBooleanCapability(source, 'bufferSizeConfigurable'),
    ...copyBooleanCapability(source, 'sampleFormatConfigurable'),
    ...copyBooleanCapability(source, 'channelModeConfigurable'),
    ...copyPositiveCapability(source, 'fixedSampleRate'),
    ...copyPositiveCapability(source, 'fixedBufferSize'),
    ...copyPositiveCapability(source, 'fixedChannelCount'),
    ...copyBooleanCapability(source, 'outputRouteAck'),
  };
  return Object.keys(capabilities).length > 0 ? capabilities : undefined;
}

function normalizePositiveNumbers(values: unknown): number[] {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(values
    .map((value) => Math.round(Number(value)))
    .filter((value) => Number.isFinite(value) && value > 0))).sort((a, b) => a - b);
}

function copyBooleanCapability<K extends keyof AndroidAudioCapabilities>(
  capabilities: AndroidAudioCapabilities | undefined,
  key: K,
): Partial<Pick<AndroidAudioCapabilities, K>> {
  return typeof capabilities?.[key] === 'boolean' ? { [key]: capabilities[key] } as Partial<Pick<AndroidAudioCapabilities, K>> : {};
}

function copyPositiveCapability<K extends 'fixedSampleRate' | 'fixedBufferSize' | 'fixedChannelCount'>(
  capabilities: AndroidAudioCapabilities | undefined,
  key: K,
): Partial<Pick<AndroidAudioCapabilities, K>> {
  const value = capabilities?.[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? { [key]: Math.round(value) } as Partial<Pick<AndroidAudioCapabilities, K>> : {};
}
